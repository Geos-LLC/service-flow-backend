/**
 * Connected Email — Express router + poller.
 *
 * Mount:
 *   const connectedEmail = require('./services/connected-email')(supabase, logger)
 *   app.use('/api/connected-email', connectedEmail.router)
 *   connectedEmail.startPoller()
 *
 * LOOSE COUPLING:
 *   - All code lives under services/connected-email/
 *   - Tables live under connected_email_* namespace
 *   - Reuses communication_conversations / communication_messages only for data
 *   - Does NOT import from server.js, notification-email.service, sigcore, etc.
 *   - Removing the mount line removes the feature with zero side effects
 */

const express = require('express')
const jwt = require('jsonwebtoken')
const crypto = require('crypto')

const { getProvider } = require('./providers')
const store = require('./account-store')
const syncEngine = require('./sync-engine')
const sender = require('./send')
const tokenCrypto = require('./token-crypto')

const OAUTH_STATE_TTL_MS = 5 * 60 * 1000
const POLL_INTERVAL_MS = parseInt(process.env.CONNECTED_EMAIL_POLL_INTERVAL_MS || '120000', 10)

module.exports = function buildConnectedEmail(supabase, logger) {
  const router = express.Router()
  const log = logger || console

  // ── Auth middleware (per-route — NEVER router.use) ──
  async function auth(req, res, next) {
    const hdr = req.headers['authorization']
    const token = hdr && hdr.split(' ')[1]
    if (!token) return res.status(401).json({ error: 'No token provided' })
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key')
      // Normalize: the app's JWTs carry userId; our code reads .id. Support both.
      req.user = { ...decoded, id: decoded.id || decoded.userId }
      next()
    } catch {
      res.status(401).json({ error: 'Invalid token' })
    }
  }

  // Feature-flag-aware fail soft.
  // Reuses existing GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET when the
  // connected-email-specific ones aren't set.
  function hasGoogle() {
    return !!(process.env.GOOGLE_OAUTH_CLIENT_ID || process.env.GOOGLE_CLIENT_ID)
  }
  function hasMicrosoft() {
    return !!process.env.MS_OAUTH_CLIENT_ID
  }
  function featureConfigured() {
    return tokenCrypto.isConfigured() && (hasGoogle() || hasMicrosoft())
  }

  function redirectUriFor(provider, req) {
    const base = process.env.CONNECTED_EMAIL_REDIRECT_BASE
      || `${req.protocol}://${req.get('host')}`
    return `${base}/api/connected-email/oauth/${provider}/callback`
  }

  // ══════════════════════════════════════════════════════════════
  // GET /api/connected-email/accounts
  // ══════════════════════════════════════════════════════════════
  router.get('/accounts', auth, async (req, res) => {
    try {
      const rows = await store.listSafe(supabase, req.user.id)
      res.json({
        accounts: rows,
        configured: featureConfigured(),
        providers: { gmail: hasGoogle(), outlook: hasMicrosoft() },
      })
    } catch (e) {
      log.error?.(`[connected-email] list accounts: ${e.message}`)
      res.status(500).json({ error: e.message })
    }
  })

  // ══════════════════════════════════════════════════════════════
  // POST /api/connected-email/oauth/:provider/start
  // ══════════════════════════════════════════════════════════════
  router.post('/oauth/:provider/start', auth, async (req, res) => {
    try {
      const provider = req.params.provider
      if (!['gmail', 'outlook'].includes(provider)) {
        return res.status(400).json({ error: 'unknown provider' })
      }
      if (!featureConfigured()) {
        return res.status(503).json({ error: 'connected email not configured on this server' })
      }
      const p = getProvider(provider)
      const nonce = crypto.randomBytes(16).toString('hex')
      const stateToken = crypto.randomBytes(24).toString('hex')
      await supabase.from('connected_email_oauth_states').insert({
        state_token: stateToken,
        user_id: req.user.id,
        provider,
        nonce,
        expires_at: new Date(Date.now() + OAUTH_STATE_TTL_MS).toISOString(),
      })
      const url = p.buildAuthUrl({
        redirectUri: redirectUriFor(provider, req),
        state: stateToken,
      })
      res.json({ authorization_url: url })
    } catch (e) {
      log.error?.(`[connected-email] oauth start: ${e.message}`)
      res.status(500).json({ error: e.message })
    }
  })

  // ══════════════════════════════════════════════════════════════
  // GET /api/connected-email/oauth/:provider/callback
  // Browser-redirected, no auth header — state token validates.
  // ══════════════════════════════════════════════════════════════
  router.get('/oauth/:provider/callback', async (req, res) => {
    const provider = req.params.provider
    const { code, state, error: oauthErr, error_description: oauthErrDesc } = req.query
    try {
      if (oauthErr) throw new Error(`OAuth error: ${oauthErr}${oauthErrDesc ? ' - ' + oauthErrDesc : ''}`)
      if (!code || !state) throw new Error('missing code or state')

      // Single-use state — claim in a read-update cycle.
      const { data: stateRow } = await supabase
        .from('connected_email_oauth_states')
        .select('*')
        .eq('state_token', state)
        .maybeSingle()
      if (!stateRow) throw new Error('invalid state')
      if (stateRow.consumed_at) throw new Error('state already used')
      if (new Date(stateRow.expires_at).getTime() < Date.now()) throw new Error('state expired')
      if (stateRow.provider !== provider) throw new Error('state/provider mismatch')

      const { error: consumeErr } = await supabase
        .from('connected_email_oauth_states')
        .update({ consumed_at: new Date().toISOString() })
        .eq('state_token', state)
        .is('consumed_at', null)
      if (consumeErr) throw consumeErr

      const p = getProvider(provider)
      const tokens = await p.exchangeCode({
        redirectUri: redirectUriFor(provider, req),
        code,
      })
      const profile = await p.getProfile({
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
      })

      // Store with auth identity. For Outlook, status='awaiting_selection'
      // until the user explicitly picks a mailbox (prevents /me sync leaking
      // auto-mapped shared mailboxes into the primary inbox). For Gmail,
      // auth = target always, no picker needed.
      await store.upsertAccount(supabase, {
        userId: stateRow.user_id,
        provider,
        emailAddress: profile.emailAddress,
        displayName: profile.displayName,
        tokens,
        scopes: tokens.scopes,
        authEmailAddress: profile.emailAddress,
        authDisplayName: profile.displayName,
        targetMailboxEmail: profile.emailAddress,
        mailboxType: 'primary',
        initialStatus: provider === 'outlook' ? 'awaiting_selection' : 'connected',
      })

      // For Gmail: kick sync asynchronously (no mailbox picker).
      // For Outlook: DEFER sync until user picks mailbox (primary vs shared).
      //   Otherwise auto-mapped shared mailboxes leak into the primary sync.
      const { data: acct } = await supabase
        .from('connected_email_accounts')
        .select('id')
        .eq('user_id', stateRow.user_id)
        .eq('provider', provider)
        .eq('email_address', String(profile.emailAddress).toLowerCase())
        .maybeSingle()
      if (acct?.id && provider === 'gmail') {
        setImmediate(() => syncEngine.syncAccount(supabase, log, acct.id).catch(() => {}))
      }

      // For Outlook, redirect includes accountId so the UI can prompt mailbox selection.
      const frontendBase = process.env.FRONTEND_URL || process.env.CLIENT_URL || 'https://service-flow.pro'
      const qp = provider === 'outlook' && acct?.id
        ? `connected=${provider}&accountId=${acct.id}&selectMailbox=1`
        : `connected=${provider}`
      res.redirect(`${frontendBase}/settings/connected-inboxes?${qp}`)
    } catch (e) {
      log.error?.(`[connected-email] callback ${provider}: ${e.message}`)
      const frontendBase = process.env.FRONTEND_URL || process.env.CLIENT_URL || 'https://service-flow.pro'
      res.redirect(`${frontendBase}/settings/connected-inboxes?error=${encodeURIComponent(e.message)}`)
    }
  })

  // ══════════════════════════════════════════════════════════════
  // POST /api/connected-email/accounts/:id/disconnect
  // ══════════════════════════════════════════════════════════════
  router.post('/accounts/:id/disconnect', auth, async (req, res) => {
    try {
      // Ownership check via safe select — never decrypts tokens.
      const safe = await store.getSafeById(supabase, req.user.id, req.params.id)
      if (!safe) return res.status(404).json({ error: 'not found' })

      // Best-effort provider revoke — if tokens are corrupt or key changed,
      // skip revocation and still disconnect locally.
      try {
        const account = await store.getWithTokens(supabase, req.params.id)
        if (account?.accessToken || account?.refreshToken) {
          const p = getProvider(account.provider)
          await p.revoke({ accessToken: account.accessToken, refreshToken: account.refreshToken })
        }
      } catch (e) {
        log.warn?.(`[connected-email] revoke skipped (${e.message})`)
      }

      await store.markDisconnected(supabase, req.params.id, req.body?.reason || 'user_disconnect')
      res.json({ ok: true })
    } catch (e) {
      log.error?.(`[connected-email] disconnect: ${e.message}`)
      res.status(500).json({ error: e.message })
    }
  })

  // Hard delete — removes the row entirely. Use for broken/orphan records
  // that can't be re-used (e.g. after token encryption scheme changes).
  router.delete('/accounts/:id', auth, async (req, res) => {
    try {
      const safe = await store.getSafeById(supabase, req.user.id, req.params.id)
      if (!safe) return res.status(404).json({ error: 'not found' })
      await supabase.from('connected_email_sync_state').delete().eq('account_id', req.params.id)
      await supabase.from('connected_email_accounts').delete().eq('id', req.params.id).eq('user_id', req.user.id)
      res.json({ ok: true, deleted: true })
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  // ══════════════════════════════════════════════════════════════
  // POST /api/connected-email/accounts/:id/resync
  // ══════════════════════════════════════════════════════════════
  router.post('/accounts/:id/resync', auth, async (req, res) => {
    try {
      const acct = await store.getSafeById(supabase, req.user.id, req.params.id)
      if (!acct) return res.status(404).json({ error: 'not found' })
      setImmediate(() => syncEngine.syncAccount(supabase, log, req.params.id).catch(() => {}))
      res.json({ ok: true, queued: true })
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  // ══════════════════════════════════════════════════════════════
  // GET /api/connected-email/accounts/:id/sync-progress
  //   Returns { phase, scanned, synced, total, startedAt, error }
  //   phase: 'starting' | 'initial_list' | 'incremental_list' | 'fetching' | 'done' | 'error'
  //   null when no sync has run recently.
  // ══════════════════════════════════════════════════════════════
  router.get('/accounts/:id/sync-progress', auth, async (req, res) => {
    try {
      const safe = await store.getSafeById(supabase, req.user.id, req.params.id)
      if (!safe) return res.status(404).json({ error: 'not found' })
      const progress = syncEngine.getProgress(req.params.id)
      res.json({ progress })
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  // ══════════════════════════════════════════════════════════════
  // POST /api/connected-email/accounts/:id/test-sync
  //   Body: { days?: number, maxMessages?: number }
  //   Runs synchronously so the UI can show exact counts.
  // ══════════════════════════════════════════════════════════════
  router.post('/accounts/:id/test-sync', auth, async (req, res) => {
    try {
      const acct = await store.getSafeById(supabase, req.user.id, req.params.id)
      if (!acct) return res.status(404).json({ error: 'not found' })
      const days = Math.max(1, Math.min(90, parseInt(req.body?.days || 7, 10)))
      const maxMessages = Math.max(1, Math.min(200, parseInt(req.body?.maxMessages || 50, 10)))
      const result = await syncEngine.syncBoundedWindow(supabase, log, req.params.id, { days, maxMessages })
      if (result.error) return res.status(500).json({ error: result.error })
      res.json(result)
    } catch (e) {
      log.error?.(`[connected-email] test-sync: ${e.message}`)
      res.status(500).json({ error: e.message })
    }
  })

  // ══════════════════════════════════════════════════════════════
  // POST /api/connected-email/accounts/:id/validate-mailbox
  //   Body: { mailboxEmail: "sales@spotless.homes" }
  //   Tests if auth user can access the specified shared mailbox.
  // ══════════════════════════════════════════════════════════════
  router.post('/accounts/:id/validate-mailbox', auth, async (req, res) => {
    try {
      let acct = await store.getWithTokens(supabase, req.params.id)
      if (!acct || acct.user_id !== req.user.id) return res.status(404).json({ error: 'not found' })
      if (acct.provider !== 'outlook') return res.status(400).json({ error: 'shared mailbox only supported for Outlook' })
      const { mailboxEmail } = req.body || {}
      if (!mailboxEmail?.trim()) return res.status(400).json({ error: 'mailboxEmail required' })

      // Refresh token before validation — expired tokens show as "access denied".
      const outlook = getProvider('outlook')
      try {
        const refreshed = await outlook.refreshToken({ refreshToken: acct.refreshToken })
        await store.updateTokens(supabase, acct.id, refreshed)
        acct = { ...acct, accessToken: refreshed.accessToken }
      } catch (e) {
        log.warn?.(`[connected-email] validate-mailbox token refresh: ${e.message}`)
      }

      const result = await outlook.validateMailboxAccess(
        { accessToken: acct.accessToken, refreshToken: acct.refreshToken },
        mailboxEmail.trim().toLowerCase()
      )
      res.json(result)
    } catch (e) {
      log.error?.(`[connected-email] validate-mailbox: ${e.message}`)
      res.status(500).json({ error: e.message })
    }
  })

  // ══════════════════════════════════════════════════════════════
  // POST /api/connected-email/accounts/:id/select-mailbox
  //   Body: { mailboxEmail: "sales@spotless.homes" } or { mailboxEmail: null } for primary
  //   Validates access if shared, then sets target_mailbox_email + resets sync cursor.
  // ══════════════════════════════════════════════════════════════
  router.post('/accounts/:id/select-mailbox', auth, async (req, res) => {
    try {
      const acct = await store.getWithTokens(supabase, req.params.id)
      if (!acct || acct.user_id !== req.user.id) return res.status(404).json({ error: 'not found' })
      if (acct.provider !== 'outlook') return res.status(400).json({ error: 'mailbox selection only for Outlook' })

      const { mailboxEmail } = req.body || {}
      const target = mailboxEmail?.trim()?.toLowerCase() || null
      const authEmail = (acct.auth_email_address || acct.email_address).toLowerCase()
      const isPrimary = !target || target === authEmail
      const mailboxType = isPrimary ? 'primary' : 'shared'
      const finalTarget = isPrimary ? authEmail : target

      // Validate access for shared mailbox.
      if (!isPrimary) {
        const outlook = getProvider('outlook')
        const check = await outlook.validateMailboxAccess(
          { accessToken: acct.accessToken, refreshToken: acct.refreshToken },
          finalTarget
        )
        if (!check.accessible) return res.status(403).json({ error: check.error })
      }

      // Wipe any conversations/messages that were synced BEFORE mailbox selection
      // (e.g. leaked from auto-mapped shared mailboxes during pre-selection sync).
      // Scope: user + provider=outlook, not yet linked to the chosen target.
      try {
        const { data: staleConvs } = await supabase
          .from('communication_conversations')
          .select('id, endpoint_email')
          .eq('user_id', req.user.id)
          .eq('provider', 'outlook')
          .eq('channel', 'email')
        const staleIds = (staleConvs || [])
          .filter(c => (c.endpoint_email || '').toLowerCase() !== finalTarget)
          .map(c => c.id)
        if (staleIds.length > 0) {
          await supabase.from('communication_messages').delete().in('conversation_id', staleIds)
          await supabase.from('communication_conversations').delete().in('id', staleIds)
          log.info?.(`[connected-email] select-mailbox: cleared ${staleIds.length} stale conversations from other endpoints`)
        }
      } catch (e) {
        log.warn?.(`[connected-email] select-mailbox cleanup: ${e.message}`)
      }

      // Update account — set target + reset sync cursor + flip status to connected.
      await supabase.from('connected_email_accounts').update({
        target_mailbox_email: finalTarget,
        target_mailbox_display_name: null,
        mailbox_type: mailboxType,
        email_address: finalTarget,
        status: 'connected', // was 'awaiting_selection' for fresh Outlook connects
        history_cursor: null,
        initial_sync_completed_at: null,
        last_sync_at: null,
        updated_at: new Date().toISOString(),
      }).eq('id', req.params.id)

      // Also reset sync state so poller picks it up immediately.
      await supabase.from('connected_email_sync_state').upsert({
        account_id: req.params.id,
        is_running: false,
        consecutive_failures: 0,
        next_run_at: new Date().toISOString(),
        last_error: null,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'account_id' })

      // Kick sync immediately.
      setImmediate(() => syncEngine.syncAccount(supabase, log, req.params.id).catch(() => {}))

      res.json({
        ok: true,
        mailboxType,
        targetMailboxEmail: finalTarget,
        authEmail,
      })
    } catch (e) {
      log.error?.(`[connected-email] select-mailbox: ${e.message}`)
      res.status(500).json({ error: e.message })
    }
  })

  // ══════════════════════════════════════════════════════════════
  // POST /api/connected-email/conversations/:id/send
  //   Alternative entry point for sending from a connected email thread.
  //   (communications.jsx primary path uses /api/communications/conversations/:id/send
  //    which delegates into sender.sendFromConversation — see server.js integration.)
  // ══════════════════════════════════════════════════════════════
  router.post('/conversations/:id/send', auth, async (req, res) => {
    try {
      const { text, html, subject } = req.body || {}
      if (!text && !html) return res.status(400).json({ error: 'text or html required' })
      const out = await sender.sendFromConversation(supabase, log, {
        conversationId: req.params.id,
        userId: req.user.id,
        text,
        html,
        subject,
      })
      res.json({ message: out })
    } catch (e) {
      log.error?.(`[connected-email] send: ${e.message}`)
      res.status(500).json({ error: e.message })
    }
  })

  // ══════════════════════════════════════════════════════════════
  // Poller
  // ══════════════════════════════════════════════════════════════
  let pollerHandle = null
  function startPoller() {
    if (pollerHandle) return
    if (!featureConfigured()) {
      log.info?.('[connected-email] poller not started (feature not configured)')
      return
    }
    pollerHandle = setInterval(() => {
      syncEngine.syncAllDue(supabase, log).catch(e =>
        log.error?.(`[connected-email] poller: ${e.message}`)
      )
    }, POLL_INTERVAL_MS)
    log.info?.(`[connected-email] poller started (interval=${POLL_INTERVAL_MS}ms)`)
  }
  function stopPoller() { if (pollerHandle) { clearInterval(pollerHandle); pollerHandle = null } }

  return {
    router,
    startPoller,
    stopPoller,
    // Direct programmatic send — used by /api/communications send endpoint to
    // delegate when channel === 'email'. Keeps the feature loosely coupled.
    sendFromConversation: (args) => sender.sendFromConversation(supabase, log, args),
    syncAccount: (id) => syncEngine.syncAccount(supabase, log, id),
  }
}
