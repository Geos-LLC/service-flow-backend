/**
 * Sync engine — initial and incremental sync for a connected email account.
 *
 * Bounded and durable:
 *   - initial sync: last 30 days OR 1000 messages, whichever first
 *   - per-cycle cap: CONNECTED_EMAIL_MAX_PER_CYCLE (default 200)
 *   - per-account lock in DB (is_running), stuck-lock recovery after 10 min
 *   - exponential backoff on consecutive failures
 */

const { getProvider } = require('./providers')
const normalizer = require('./message-normalizer')
const { resolveConversation } = require('./conversation-identity')
const { normalizeEmail } = require('./email-utils')
const store = require('./account-store')

const INITIAL_DAYS = 30
const INITIAL_MAX_MESSAGES = 1000
const PER_CYCLE_MAX = parseInt(process.env.CONNECTED_EMAIL_MAX_PER_CYCLE || '200', 10)
const STUCK_LOCK_MS = 10 * 60 * 1000
const MAX_BACKOFF_MS = 60 * 60 * 1000
const BASE_BACKOFF_MS = 120 * 1000

function backoffDelay(consecutiveFailures) {
  const exp = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * Math.pow(2, consecutiveFailures))
  return exp
}

// ───────────────────────────────────────────────────────────────
// In-memory progress tracker (per process) — polled by the UI.
// Survives per-request; clears 60s after completion so UI can show final state.
// ───────────────────────────────────────────────────────────────
const progressMap = new Map()

function setProgress(accountId, patch) {
  const prev = progressMap.get(accountId) || {}
  progressMap.set(accountId, { ...prev, ...patch, updatedAt: Date.now() })
}
function getProgress(accountId) {
  const p = progressMap.get(accountId) || null
  if (p && p.phase === 'done' && Date.now() - p.updatedAt > 60 * 1000) {
    progressMap.delete(accountId)
    return null
  }
  return p
}
function clearProgress(accountId) { progressMap.delete(accountId) }

async function claimLock(supabase, accountId) {
  // Release stuck locks first.
  await supabase.rpc('noop').catch(() => {}) // no-op just to warm

  const { data: state } = await supabase
    .from('connected_email_sync_state')
    .select('*')
    .eq('account_id', accountId)
    .maybeSingle()

  if (state?.is_running && state.run_started_at) {
    const age = Date.now() - new Date(state.run_started_at).getTime()
    if (age < STUCK_LOCK_MS) return false
  }

  await supabase.from('connected_email_sync_state')
    .upsert({
      account_id: accountId,
      is_running: true,
      run_started_at: new Date().toISOString(),
      last_run_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }, { onConflict: 'account_id' })

  return true
}

async function releaseLock(supabase, accountId, { success, errorMessage, messagesSynced }) {
  const { data: cur } = await supabase
    .from('connected_email_sync_state')
    .select('consecutive_failures, messages_synced_total')
    .eq('account_id', accountId)
    .maybeSingle()

  const failures = success ? 0 : (cur?.consecutive_failures || 0) + 1
  const next = new Date(Date.now() + (success ? BASE_BACKOFF_MS : backoffDelay(failures)))

  await supabase.from('connected_email_sync_state')
    .upsert({
      account_id: accountId,
      is_running: false,
      run_started_at: null,
      last_success_at: success ? new Date().toISOString() : cur?.last_success_at || null,
      consecutive_failures: failures,
      last_error: success ? null : (errorMessage || 'unknown'),
      last_error_at: success ? null : new Date().toISOString(),
      next_run_at: next.toISOString(),
      messages_synced_total: (cur?.messages_synced_total || 0) + (messagesSynced || 0),
      updated_at: new Date().toISOString(),
    }, { onConflict: 'account_id' })
}

async function ensureFreshToken(supabase, account, provider) {
  const expires = account.token_expires_at ? new Date(account.token_expires_at) : null
  if (expires && expires.getTime() - Date.now() > 5 * 60 * 1000) return account
  if (!account.refreshToken) return account
  try {
    const refreshed = await provider.refreshToken({ refreshToken: account.refreshToken })
    await store.updateTokens(supabase, account.id, refreshed)
    return {
      ...account,
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken || account.refreshToken,
      token_expires_at: refreshed.expiresAt,
    }
  } catch (e) {
    throw new Error(`token refresh failed: ${e.message}`)
  }
}

/**
 * One-shot bounded sync — used for "Test Sync (N days)" from the UI.
 * Does NOT advance the history cursor and does NOT mark initial complete.
 * Idempotent: uses normal dedupe path.
 */
async function syncBoundedWindow(supabase, logger, accountId, { days = 7, maxMessages = 50 } = {}) {
  let account = await store.getWithTokens(supabase, accountId)
  if (!account) return { error: 'account not found' }
  if (account.status === 'disconnected') return { error: 'disconnected' }

  const provider = getProvider(account.provider)
  account = await ensureFreshToken(supabase, account, provider)

  const afterEpoch = Math.floor((Date.now() - days * 86400 * 1000) / 1000)
  const afterDate = new Date(Date.now() - days * 86400 * 1000)
  const cap = Math.min(maxMessages, PER_CYCLE_MAX)

  let messageIds
  try {
    messageIds = account.provider === 'gmail'
      ? await provider.listRecentMessages(
          { accessToken: account.accessToken, refreshToken: account.refreshToken },
          { maxResults: cap, afterEpoch }
        )
      : await provider.listRecentMessages(
          { accessToken: account.accessToken },
          { maxResults: cap, afterDate }
        )
  } catch (e) {
    return { error: `list failed: ${e.message}` }
  }

  messageIds = messageIds.slice(0, cap)
  setProgress(accountId, { phase: 'fetching', total: messageIds.length, scanned: 0, synced: 0, isTest: true, startedAt: Date.now() })
  let synced = 0
  let scanned = 0
  for (const mid of messageIds) {
    try {
      const full = await provider.getMessage(
        { accessToken: account.accessToken, refreshToken: account.refreshToken },
        mid
      )
      const ok = await persistMessage(supabase, {
        account, providerName: account.provider, ownerEmail: account.email_address, providerMsg: full, logger,
      })
      if (ok) synced++
    } catch (e) {
      logger?.warn?.(`[connected-email] test-sync msg ${mid}: ${e.message}`)
    }
    scanned++
    setProgress(accountId, { scanned, synced })
  }
  setProgress(accountId, { phase: 'done', scanned, synced })
  await supabase.from('connected_email_accounts')
    .update({ last_sync_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('id', accountId)
  return { synced, scanned: messageIds.length, days, cap }
}

async function syncAccount(supabase, logger, accountId) {
  const acquired = await claimLock(supabase, accountId)
  if (!acquired) {
    logger?.info?.(`[connected-email] skip ${accountId} (already running)`)
    return { skipped: true }
  }

  let messagesSynced = 0
  try {
    setProgress(accountId, { phase: 'starting', scanned: 0, synced: 0, total: null, startedAt: Date.now() })
    let account = await store.getWithTokens(supabase, accountId)
    if (!account || account.status === 'disconnected') {
      await releaseLock(supabase, accountId, { success: true, messagesSynced: 0 })
      setProgress(accountId, { phase: 'done', error: 'disconnected' })
      return { skipped: true, reason: 'disconnected' }
    }

    const provider = getProvider(account.provider)
    account = await ensureFreshToken(supabase, account, provider)

    const isInitial = !account.initial_sync_completed_at
    setProgress(accountId, { phase: isInitial ? 'initial_list' : 'incremental_list', isInitial })
    const ownerEmail = account.email_address

    let messageIds = []
    let newCursor = null

    if (isInitial) {
      const afterEpoch = Math.floor((Date.now() - INITIAL_DAYS * 86400 * 1000) / 1000)
      const afterDate = new Date(Date.now() - INITIAL_DAYS * 86400 * 1000)
      if (account.provider === 'gmail') {
        messageIds = await provider.listRecentMessages(
          { accessToken: account.accessToken, refreshToken: account.refreshToken },
          { maxResults: Math.min(INITIAL_MAX_MESSAGES, PER_CYCLE_MAX * 5), afterEpoch }
        )
      } else {
        messageIds = await provider.listRecentMessages(
          { accessToken: account.accessToken },
          { maxResults: Math.min(INITIAL_MAX_MESSAGES, PER_CYCLE_MAX * 5), afterDate }
        )
      }
    } else if (account.history_cursor) {
      try {
        const res = await provider.listHistory(
          { accessToken: account.accessToken, refreshToken: account.refreshToken },
          account.history_cursor
        )
        messageIds = res.messageIds
        newCursor = res.historyId
      } catch (e) {
        // Cursor expired — fall back to time-window resync.
        logger?.warn?.(`[connected-email] cursor expired for ${accountId}, fallback window`)
        const afterEpoch = Math.floor((Date.now() - 2 * 86400 * 1000) / 1000)
        const afterDate = new Date(Date.now() - 2 * 86400 * 1000)
        messageIds = account.provider === 'gmail'
          ? await provider.listRecentMessages(
              { accessToken: account.accessToken, refreshToken: account.refreshToken },
              { maxResults: PER_CYCLE_MAX, afterEpoch }
            )
          : await provider.listRecentMessages(
              { accessToken: account.accessToken },
              { maxResults: PER_CYCLE_MAX, afterDate }
            )
      }
    } else {
      // No cursor, no initial completion — shouldn't happen, treat as initial.
      const afterEpoch = Math.floor((Date.now() - INITIAL_DAYS * 86400 * 1000) / 1000)
      const afterDate = new Date(Date.now() - INITIAL_DAYS * 86400 * 1000)
      messageIds = account.provider === 'gmail'
        ? await provider.listRecentMessages(
            { accessToken: account.accessToken, refreshToken: account.refreshToken },
            { maxResults: PER_CYCLE_MAX, afterEpoch }
          )
        : await provider.listRecentMessages(
            { accessToken: account.accessToken },
            { maxResults: PER_CYCLE_MAX, afterDate }
          )
    }

    messageIds = messageIds.slice(0, PER_CYCLE_MAX)
    setProgress(accountId, { phase: 'fetching', total: messageIds.length, scanned: 0, synced: 0 })

    let scannedLocal = 0
    for (const mid of messageIds) {
      try {
        const full = await provider.getMessage(
          { accessToken: account.accessToken, refreshToken: account.refreshToken },
          mid
        )
        const processed = await persistMessage(supabase, {
          account, providerName: account.provider, ownerEmail, providerMsg: full, logger,
        })
        if (processed) messagesSynced++
      } catch (e) {
        logger?.warn?.(`[connected-email] message ${mid} failed: ${e.message}`)
      }
      scannedLocal++
      // Update every message for real-time feel (cheap — in-memory only).
      setProgress(accountId, { scanned: scannedLocal, synced: messagesSynced })
    }

    // Advance cursor (use profile historyId for gmail if we were on initial).
    if (account.provider === 'gmail' && isInitial) {
      try {
        const prof = await provider.getProfile({
          accessToken: account.accessToken, refreshToken: account.refreshToken,
        })
        newCursor = prof.historyId
      } catch {}
    }

    const patch = {
      last_sync_at: new Date().toISOString(),
      status: 'connected',
      updated_at: new Date().toISOString(),
    }
    if (newCursor) patch.history_cursor = String(newCursor)
    if (isInitial) patch.initial_sync_completed_at = new Date().toISOString()
    await supabase.from('connected_email_accounts').update(patch).eq('id', accountId)

    await releaseLock(supabase, accountId, { success: true, messagesSynced })
    setProgress(accountId, { phase: 'done', scanned: messageIds.length, synced: messagesSynced })
    return { synced: messagesSynced, initial: isInitial }
  } catch (e) {
    logger?.error?.(`[connected-email] sync ${accountId} failed: ${e.message}`)
    await store.markError(supabase, accountId, e.message)
    await releaseLock(supabase, accountId, { success: false, errorMessage: e.message, messagesSynced })
    setProgress(accountId, { phase: 'error', error: e.message })
    return { error: e.message, synced: messagesSynced }
  }
}

async function persistMessage(supabase, { account, providerName, ownerEmail, providerMsg, logger }) {
  // Folder / label filter — skip anything that isn't inbox-bound.
  // Gmail: labelIds carry INBOX / SPAM / TRASH / DRAFT / CATEGORY_*.
  if (providerName === 'gmail') {
    const labels = providerMsg.labelIds || []
    const blocked = ['SPAM', 'TRASH', 'DRAFT', 'CATEGORY_PROMOTIONS', 'CATEGORY_SOCIAL']
    if (blocked.some(b => labels.includes(b))) {
      logger?.info?.(`[connected-email] skip ${providerMsg.id} (label ${labels.find(l => blocked.includes(l))})`)
      return false
    }
    // Accept if INBOX label present OR it's a SENT message (outbound replies also need storing).
    const keep = labels.includes('INBOX') || labels.includes('SENT')
    if (!keep) return false
  }

  // Dedupe at app level before DB unique catches it.
  if (providerMsg.messageId) {
    const { data: existing } = await supabase
      .from('communication_messages')
      .select('id')
      .eq('email_message_id', providerMsg.messageId)
      .eq('channel', 'email')
      .maybeSingle()
    if (existing?.id) return false
  }

  const result = normalizer.normalize({ providerMsg, mailboxOwnerEmail: ownerEmail })
  if (!result.ok) {
    logger?.info?.(`[connected-email] guard rejected ${providerMsg.id}: ${result.reason}`)
    return false
  }

  const { conversationId } = await resolveConversation(supabase, {
    userId: account.user_id,
    provider: providerName,
    endpointEmail: ownerEmail,
    participantEmail: result.participantEmail,
    threadId: providerMsg.threadId || null,
    participantName: null,
    subject: providerMsg.subject,
    lastPreview: (providerMsg.snippet || providerMsg.subject || '').slice(0, 200),
    lastEventAt: providerMsg.date ? new Date(providerMsg.date).toISOString() : new Date().toISOString(),
  })

  const row = {
    ...result.row,
    conversation_id: conversationId,
    provider: providerName,
    source_system: providerName,
    sent_at: providerMsg.date ? new Date(providerMsg.date).toISOString() : new Date().toISOString(),
    created_at: new Date().toISOString(),
  }

  const { error } = await supabase
    .from('communication_messages')
    .insert(row)

  if (error) {
    if (/duplicate key/i.test(error.message)) return false
    throw error
  }

  // Update conversation last activity + unread count for inbound.
  const patch = {
    last_event_at: row.sent_at,
    last_preview: (providerMsg.snippet || providerMsg.subject || row.body_text || '').slice(0, 200),
    updated_at: new Date().toISOString(),
  }
  if (row.direction === 'inbound') {
    const { data: conv } = await supabase
      .from('communication_conversations')
      .select('unread_count')
      .eq('id', conversationId)
      .maybeSingle()
    patch.unread_count = (conv?.unread_count || 0) + 1
    patch.is_read = false
  }
  await supabase.from('communication_conversations').update(patch).eq('id', conversationId)

  return true
}

async function syncAllDue(supabase, logger) {
  const { data } = await supabase
    .from('connected_email_sync_state')
    .select('account_id')
    .lte('next_run_at', new Date().toISOString())
    .eq('is_running', false)
    .limit(25)

  const ids = (data || []).map(r => r.account_id)
  // Also pick up accounts without a sync_state row yet (freshly connected).
  const { data: fresh } = await supabase
    .from('connected_email_accounts')
    .select('id')
    .eq('status', 'connected')
    .is('initial_sync_completed_at', null)
    .limit(25)
  for (const r of fresh || []) if (!ids.includes(r.id)) ids.push(r.id)

  for (const id of ids) {
    await syncAccount(supabase, logger, id).catch(e =>
      logger?.error?.(`[connected-email] syncAllDue ${id}: ${e.message}`)
    )
  }
  return { processed: ids.length }
}

module.exports = {
  syncAccount,
  syncAllDue,
  syncBoundedWindow,
  persistMessage,
  getProgress,
  clearProgress,
  // for tests
  backoffDelay,
}
