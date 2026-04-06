/**
 * LeadBridge Integration Module (Loosely Coupled)
 *
 * Mount: app.use('/api/integrations/leadbridge', require('./leadbridge-service')(supabase, logger))
 * Remove: delete this file + remove the line above = zero breakage
 *
 * Phase A: Communication layer only.
 *   - Connect/disconnect LB account
 *   - Sync conversations + messages from LB
 *   - Receive webhook events from LB
 *   - Generic send via LB
 *
 * Does NOT depend on CRM leads/customers module.
 * Does NOT call Thumbtack/Yelp APIs directly — LB is the proxy.
 */

const express = require('express')
const axios = require('axios')
const crypto = require('crypto')

const LB_BASE = process.env.LEADBRIDGE_URL || 'https://thumbtack-bridge-production.up.railway.app/api'

// In-memory sync progress per user
const syncProgress = {}

module.exports = (supabase, logger) => {
  const router = express.Router()

  // ══════════════════════════════════════
  // Auth middleware — reuse the app's JWT
  // ══════════════════════════════════════
  const authenticateToken = async (req, res, next) => {
    const authHeader = req.headers['authorization']
    const token = authHeader && authHeader.split(' ')[1]
    if (!token) return res.status(401).json({ error: 'No token provided' })
    try {
      const jwt = require('jsonwebtoken')
      const decoded = jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key')
      req.user = decoded
      next()
    } catch {
      return res.status(401).json({ error: 'Invalid token' })
    }
  }

  // ══════════════════════════════════════
  // Helpers
  // ══════════════════════════════════════

  // Make authenticated request to LeadBridge
  async function lbRequest(method, path, token, data = null) {
    const t = Date.now()
    const config = {
      method,
      url: `${LB_BASE}${path}`,
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      timeout: 30000,
    }
    if (data) config.data = data
    const res = await axios(config)
    logger.log(`[LB] ${method} ${path.substring(0, 80)} → ${res.status} (${Date.now() - t}ms)`)
    return res
  }

  // Get LB settings for a user
  async function getLbSettings(userId) {
    const { data } = await supabase.from('communication_settings')
      .select('leadbridge_connected, leadbridge_integration_token, leadbridge_user_id, leadbridge_connected_at')
      .eq('user_id', userId).maybeSingle()
    return data
  }

  // Normalize phone to E.164
  function normalizePhone(phone) {
    if (!phone) return null
    const digits = phone.replace(/[^\d+]/g, '')
    if (digits.startsWith('+')) return digits
    if (digits.length === 10) return `+1${digits}`
    if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`
    return digits
  }

  // Get or create participant identity
  async function upsertParticipantIdentity(userId, { phone, email, displayName, lbContactId, channel }) {
    const normalized = normalizePhone(phone)

    // Try to find existing by LB contact ID first, then by phone
    let identity = null
    if (lbContactId) {
      const { data } = await supabase.from('communication_participant_identities')
        .select('*').eq('user_id', userId).eq('leadbridge_contact_id', lbContactId).maybeSingle()
      identity = data
    }
    if (!identity && normalized) {
      const { data } = await supabase.from('communication_participant_identities')
        .select('*').eq('user_id', userId).eq('normalized_phone', normalized).maybeSingle()
      identity = data
    }

    if (identity) {
      // Update with new info
      const updates = { updated_at: new Date().toISOString() }
      if (displayName && !identity.display_name) updates.display_name = displayName
      if (normalized && !identity.normalized_phone) updates.normalized_phone = normalized
      if (email && !identity.email) updates.email = email
      if (lbContactId && !identity.leadbridge_contact_id) updates.leadbridge_contact_id = lbContactId
      if (Object.keys(updates).length > 1) {
        await supabase.from('communication_participant_identities').update(updates).eq('id', identity.id)
      }
      return identity
    }

    // Create new
    const { data: created, error } = await supabase.from('communication_participant_identities').insert({
      user_id: userId,
      normalized_phone: normalized,
      email: email || null,
      display_name: displayName || null,
      leadbridge_contact_id: lbContactId || null,
      source_channel: channel || 'leadbridge',
      source_confidence: 'auto',
    }).select().single()

    if (error) { logger.error('[LB] Identity insert error:', error.message); return null }
    return created
  }

  // Upsert conversation from LB data
  async function upsertConversation(userId, { provider, channel, externalConvId, externalLeadId,
    participantPhone, participantName, identityId, providerAccountId, lastMessage, lastActivity }) {
    const endpointPhone = null // LB conversations don't have a "our phone" — they're platform threads

    // Find existing by external_conversation_id
    let conv = null
    if (externalConvId) {
      const { data } = await supabase.from('communication_conversations')
        .select('*').eq('user_id', userId).eq('provider', provider)
        .eq('channel', channel).eq('external_conversation_id', externalConvId).maybeSingle()
      conv = data
    }
    // Fallback: find by external_lead_id
    if (!conv && externalLeadId) {
      const { data } = await supabase.from('communication_conversations')
        .select('*').eq('user_id', userId).eq('provider', provider)
        .eq('channel', channel).eq('external_lead_id', externalLeadId).maybeSingle()
      conv = data
    }

    if (conv) {
      const updates = { updated_at: new Date().toISOString() }
      if (lastMessage) updates.last_preview = lastMessage.substring(0, 200)
      if (lastActivity) updates.last_event_at = lastActivity
      if (participantName && !conv.participant_name) updates.participant_name = participantName
      if (identityId && !conv.participant_identity_id) updates.participant_identity_id = identityId
      if (providerAccountId && !conv.provider_account_id) updates.provider_account_id = providerAccountId
      if (externalConvId && !conv.external_conversation_id) updates.external_conversation_id = externalConvId
      if (externalLeadId && !conv.external_lead_id) updates.external_lead_id = externalLeadId
      await supabase.from('communication_conversations').update(updates).eq('id', conv.id)
      return { ...conv, ...updates }
    }

    // Create new
    const { data: created, error } = await supabase.from('communication_conversations').insert({
      user_id: userId,
      provider,
      channel,
      external_conversation_id: externalConvId || null,
      external_lead_id: externalLeadId || null,
      participant_phone: normalizePhone(participantPhone),
      participant_name: participantName || null,
      participant_identity_id: identityId || null,
      provider_account_id: providerAccountId || null,
      last_preview: lastMessage ? lastMessage.substring(0, 200) : null,
      last_event_at: lastActivity || new Date().toISOString(),
      unread_count: 0,
      sync_state: 'synced',
    }).select().single()

    if (error) { logger.error('[LB] Conv insert error:', error.message); return null }
    return created
  }

  // ══════════════════════════════════════
  // POST /connect — Connect LeadBridge
  // ══════════════════════════════════════
  router.post('/connect', authenticateToken, async (req, res) => {
    try {
      const userId = req.user.userId
      const { email, password } = req.body
      if (!email || !password) return res.status(400).json({ error: 'Email and password required' })

      // 1. Authenticate with LeadBridge
      let lbToken, lbUserId
      try {
        const loginRes = await lbRequest('POST', '/auth/login', null, { email, password })
        // LB returns { user: { id, email, ... }, token: "jwt..." }
        lbToken = loginRes.data?.token
        lbUserId = loginRes.data?.user?.id
        if (!lbToken) return res.status(401).json({ error: 'LeadBridge login failed — no token returned' })
      } catch (e) {
        const msg = e.response?.data?.message || e.message
        return res.status(401).json({ error: `LeadBridge login failed: ${msg}` })
      }

      // 2. Fetch connected accounts
      let accounts = []
      try {
        const acctRes = await lbRequest('GET', '/v1/platforms/saved-accounts', lbToken)
        // LB returns { count, accounts: [...] }
        accounts = acctRes.data?.accounts || []
      } catch (e) {
        logger.warn('[LB] Failed to fetch accounts:', e.message)
      }

      // 3. Store connection in communication_settings
      await supabase.from('communication_settings').upsert({
        user_id: userId,
        leadbridge_connected: true,
        leadbridge_integration_token: lbToken,
        leadbridge_user_id: lbUserId,
        leadbridge_connected_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }, { onConflict: 'user_id' })

      // 4. Create provider accounts for each LB account
      for (const acct of accounts) {
        // LB SavedAccount: { id, platform, businessId, businessName, emailHint, imageUrl, webhookId, tokenDead, ... }
        const platform = (acct.platform || 'thumbtack').toLowerCase()
        const channel = platform
        const externalId = acct.id  // LB saved account UUID
        const businessId = acct.businessId
        const name = acct.businessName || `${platform} Account`

        // Upsert: find existing or create
        const { data: existing } = await supabase.from('communication_provider_accounts')
          .select('id').eq('user_id', userId).eq('provider', 'leadbridge')
          .eq('channel', channel).eq('external_account_id', externalId).maybeSingle()

        if (existing) {
          await supabase.from('communication_provider_accounts').update({
            display_name: name, status: 'active',
            webhook_status: acct.webhookId ? 'active' : 'pending',
            metadata: { platform, businessId, imageUrl: acct.imageUrl, tokenDead: acct.tokenDead },
          }).eq('id', existing.id)
        } else {
          await supabase.from('communication_provider_accounts').insert({
            user_id: userId,
            provider: 'leadbridge',
            channel,
            external_account_id: externalId,
            external_business_id: businessId,
            display_name: name,
            account_email: acct.emailHint || email,
            status: 'active',
            webhook_status: acct.webhookId ? 'active' : 'pending',
            webhook_id: acct.webhookId,
            metadata: { platform, businessId, imageUrl: acct.imageUrl, tokenDead: acct.tokenDead },
          })
        }
      }

      logger.log(`[LB] Connected for user ${userId}, ${accounts.length} accounts`)
      res.json({ success: true, accounts, userId: lbUserId })
    } catch (error) {
      logger.error('[LB] Connect error:', error.message)
      res.status(500).json({ error: 'Failed to connect LeadBridge' })
    }
  })

  // ══════════════════════════════════════
  // GET /status — Connection status
  // ══════════════════════════════════════
  router.get('/status', authenticateToken, async (req, res) => {
    try {
      const settings = await getLbSettings(req.user.userId)
      if (!settings?.leadbridge_connected) {
        return res.json({ connected: false, accounts: [] })
      }

      const { data: accounts } = await supabase.from('communication_provider_accounts')
        .select('*').eq('user_id', req.user.userId).eq('provider', 'leadbridge').eq('status', 'active')

      res.json({
        connected: true,
        connectedAt: settings.leadbridge_connected_at,
        accounts: (accounts || []).map(a => ({
          id: a.id,
          channel: a.channel,
          displayName: a.display_name,
          externalAccountId: a.external_account_id,
          externalBusinessId: a.external_business_id,
          lastSyncedAt: a.last_synced_at,
          webhookStatus: a.webhook_status,
        })),
      })
    } catch (error) {
      res.status(500).json({ error: 'Failed to fetch LeadBridge status' })
    }
  })

  // ══════════════════════════════════════
  // GET /accounts — List connected accounts
  // ══════════════════════════════════════
  router.get('/accounts', authenticateToken, async (req, res) => {
    try {
      const { data } = await supabase.from('communication_provider_accounts')
        .select('*').eq('user_id', req.user.userId).eq('provider', 'leadbridge')
      res.json({ accounts: data || [] })
    } catch (error) {
      res.status(500).json({ error: 'Failed to fetch accounts' })
    }
  })

  // ══════════════════════════════════════
  // DELETE /disconnect — Disconnect LeadBridge
  // ══════════════════════════════════════
  router.delete('/disconnect', authenticateToken, async (req, res) => {
    try {
      const userId = req.user.userId

      // Deactivate provider accounts
      await supabase.from('communication_provider_accounts')
        .update({ status: 'disconnected', updated_at: new Date().toISOString() })
        .eq('user_id', userId).eq('provider', 'leadbridge')

      // Clear settings
      await supabase.from('communication_settings').update({
        leadbridge_connected: false,
        leadbridge_integration_token: null,
        leadbridge_user_id: null,
        updated_at: new Date().toISOString(),
      }).eq('user_id', userId)

      logger.log(`[LB] Disconnected for user ${userId}`)
      res.json({ success: true })
    } catch (error) {
      res.status(500).json({ error: 'Failed to disconnect LeadBridge' })
    }
  })

  // ══════════════════════════════════════
  // POST /sync — Sync conversations from LB
  // ══════════════════════════════════════
  router.post('/sync', authenticateToken, async (req, res) => {
    try {
      const userId = req.user.userId
      const { accountId, limit } = req.body || {}
      const settings = await getLbSettings(userId)
      if (!settings?.leadbridge_connected || !settings.leadbridge_integration_token) {
        return res.status(400).json({ error: 'LeadBridge not connected' })
      }

      if (syncProgress[userId]?.status === 'running') {
        return res.json({ started: false, message: 'Sync already in progress', progress: syncProgress[userId] })
      }

      // Start sync in background
      setImmediate(() => runLbSync(userId, settings.leadbridge_integration_token, accountId, parseInt(limit) || 0))
      res.json({ started: true })
    } catch (error) {
      res.status(500).json({ error: 'Failed to start sync' })
    }
  })

  // ══════════════════════════════════════
  // GET /sync/progress — Poll sync progress
  // ══════════════════════════════════════
  router.get('/sync/progress', authenticateToken, (req, res) => {
    const progress = syncProgress[req.user.userId] || { status: 'idle' }
    res.json(progress)
  })

  // ══════════════════════════════════════
  // POST /webhooks — Receive events from LB
  // No auth middleware — public webhook endpoint
  // ══════════════════════════════════════
  router.post('/webhooks', async (req, res) => {
    res.status(200).json({ received: true })

    try {
      const event = req.body
      if (!event?.event_type) return

      // Log webhook event
      const eventId = event.event_id || null
      if (eventId) {
        // Idempotency check
        const { data: existing } = await supabase.from('communication_webhook_events')
          .select('id').eq('provider', 'leadbridge').eq('event_id', eventId).maybeSingle()
        if (existing) return // Already processed
      }

      // Store event
      await supabase.from('communication_webhook_events').insert({
        provider: 'leadbridge',
        event_id: eventId,
        event_type: event.event_type,
        payload: event,
        signature: req.headers['x-lb-signature'] || null,
        external_account_id: event.account_id,
        channel: event.channel,
        processed: false,
        received_at: new Date().toISOString(),
      })

      // Resolve user from account_id
      let userId = null
      if (event.account_id) {
        const { data: acct } = await supabase.from('communication_provider_accounts')
          .select('user_id').eq('provider', 'leadbridge').eq('external_account_id', event.account_id)
          .eq('status', 'active').maybeSingle()
        userId = acct?.user_id
      }
      if (!userId) {
        logger.warn('[LB Webhook] No user found for account:', event.account_id)
        return
      }

      // Process based on event type
      const thread = event.thread || {}
      const participant = event.participant || {}
      const message = event.message || {}
      const channel = event.channel || 'thumbtack'

      // Upsert participant identity
      const identity = await upsertParticipantIdentity(userId, {
        phone: participant.phone,
        email: participant.email,
        displayName: participant.name,
        lbContactId: participant.external_contact_id,
        channel,
      })

      // Upsert conversation
      const conv = await upsertConversation(userId, {
        provider: 'leadbridge',
        channel,
        externalConvId: thread.external_conversation_id,
        externalLeadId: thread.external_lead_id,
        participantPhone: participant.phone,
        participantName: participant.name,
        identityId: identity?.id,
        lastMessage: message.body,
        lastActivity: event.occurred_at || new Date().toISOString(),
      })

      if (!conv) return

      // Insert message if present
      if (message.external_message_id && message.body) {
        const { data: existingMsg } = await supabase.from('communication_messages')
          .select('id').eq('conversation_id', conv.id)
          .eq('external_message_id', message.external_message_id).maybeSingle()

        if (!existingMsg) {
          const direction = message.direction === 'inbound' || message.direction === 'in' ? 'in' : 'out'
          await supabase.from('communication_messages').insert({
            conversation_id: conv.id,
            external_message_id: message.external_message_id,
            direction,
            channel,
            body: message.body,
            sender_role: direction === 'in' ? 'customer' : 'agent',
            status: 'delivered',
            sent_at: message.sent_at || event.occurred_at,
            created_at: message.sent_at || event.occurred_at || new Date().toISOString(),
          })

          // Update unread count
          if (direction === 'in') {
            await supabase.from('communication_conversations')
              .update({ unread_count: (conv.unread_count || 0) + 1 }).eq('id', conv.id)
          }
        }
      }

      // Mark webhook event as processed
      if (eventId) {
        await supabase.from('communication_webhook_events')
          .update({ processed: true, processed_at: new Date().toISOString() })
          .eq('provider', 'leadbridge').eq('event_id', eventId)
      }

      logger.log(`[LB Webhook] Processed ${event.event_type} for user ${userId}`)
    } catch (error) {
      logger.error('[LB Webhook] Processing error:', error.message)
    }
  })

  // ══════════════════════════════════════
  // Background sync function
  // ══════════════════════════════════════
  async function runLbSync(userId, lbToken, accountId, maxLeads = 0) {
    syncProgress[userId] = { status: 'running', total: 0, synced: 0, messages: 0, errors: 0, phase: 'fetching' }
    const t0 = Date.now()

    try {
      // Get provider accounts
      const { data: accounts } = await supabase.from('communication_provider_accounts')
        .select('*').eq('user_id', userId).eq('provider', 'leadbridge').eq('status', 'active')

      const targetAccounts = accountId
        ? (accounts || []).filter(a => a.id === parseInt(accountId) || a.external_account_id === accountId)
        : (accounts || [])

      if (targetAccounts.length === 0) {
        syncProgress[userId] = { status: 'error', error: 'No active LeadBridge accounts' }
        return
      }

      let totalSynced = 0
      let totalMessages = 0

      for (const acct of targetAccounts) {
        const channel = acct.channel || 'thumbtack'
        const platform = channel === 'yelp' ? 'yelp' : 'thumbtack'

        syncProgress[userId].phase = `syncing_${platform}`

        try {
          // Fetch leads from LB — response: { count, leads: NormalizedLead[] }
          const limit = maxLeads > 0 ? maxLeads : 50
          const leadsPath = `/v1/${platform}/leads?limit=${limit}`
          const leadsRes = await lbRequest('GET', leadsPath, lbToken)
          const allLeads = leadsRes.data?.leads || []
          // Filter to this account's businessId
          const leads = acct.external_business_id
            ? allLeads.filter(l => l.businessId === acct.external_business_id)
            : allLeads

          syncProgress[userId].total += leads.length
          logger.log(`[LB Sync] ${platform}: ${leads.length} leads for account ${acct.display_name}`)

          for (const lead of leads) {
            try {
              // Upsert participant identity
              const identity = await upsertParticipantIdentity(userId, {
                phone: lead.customerPhone,
                email: lead.customerEmail,
                displayName: lead.customerName,
                lbContactId: lead.id,
                channel,
              })

              // Upsert conversation
              // LB NormalizedLead: { id, externalRequestId, threadId, customerName, customerPhone, message, status, ... }
              const conv = await upsertConversation(userId, {
                provider: 'leadbridge',
                channel,
                externalConvId: lead.threadId || lead.externalRequestId || lead.id,
                externalLeadId: lead.id,
                participantPhone: lead.customerPhone,
                participantName: lead.customerName,
                identityId: identity?.id,
                providerAccountId: acct.id,
                lastMessage: lead.message,
                lastActivity: lead.lastMessageAt || lead.updatedAt || lead.createdAt,
              })

              if (!conv) { syncProgress[userId].errors++; continue }

              // Fetch messages — LB response: { platform, leadId, count, messages: Message[] }
              // Message: { id, externalMessageId, sender: "pro"|"customer"|"system", content, sentAt, ... }
              try {
                const msgsPath = `/v1/${platform}/leads/${lead.id}/messages`
                const msgsRes = await lbRequest('GET', msgsPath, lbToken)
                const messages = msgsRes.data?.messages || []

                for (const msg of messages) {
                  const msgId = msg.externalMessageId || msg.id
                  if (!msgId) continue

                  const { data: existing } = await supabase.from('communication_messages')
                    .select('id').eq('conversation_id', conv.id)
                    .eq('external_message_id', msgId).maybeSingle()
                  if (existing) continue

                  const direction = msg.sender === 'customer' ? 'in' : 'out'
                  await supabase.from('communication_messages').insert({
                    conversation_id: conv.id,
                    external_message_id: msgId,
                    direction,
                    channel,
                    body: msg.content || '',
                    sender_role: msg.sender === 'customer' ? 'customer' : msg.sender === 'system' ? 'system' : 'agent',
                    status: msg.deliveredAt ? 'delivered' : 'sent',
                    sent_at: msg.sentAt,
                    delivered_at: msg.deliveredAt || null,
                    created_at: msg.sentAt || new Date().toISOString(),
                  })
                  totalMessages++
                }
              } catch (e) {
                logger.warn(`[LB Sync] Messages for lead ${lead.id}: ${e.message}`)
              }

              totalSynced++
              syncProgress[userId].synced = totalSynced
              syncProgress[userId].messages = totalMessages
            } catch (e) {
              syncProgress[userId].errors++
              logger.warn(`[LB Sync] Lead ${lead.id}: ${e.message}`)
            }
          }

          // Update sync cursor
          await supabase.from('communication_provider_accounts').update({
            last_synced_at: new Date().toISOString(),
            sync_error: null,
          }).eq('id', acct.id)

        } catch (e) {
          logger.error(`[LB Sync] Account ${acct.display_name}: ${e.message}`)
          await supabase.from('communication_provider_accounts').update({
            sync_error: e.message,
          }).eq('id', acct.id)
          syncProgress[userId].errors++
        }
      }

      syncProgress[userId] = {
        status: 'complete', total: syncProgress[userId].total,
        synced: totalSynced, messages: totalMessages,
        errors: syncProgress[userId].errors, phase: 'done',
      }
      logger.log(`[LB Sync] DONE in ${Date.now() - t0}ms: ${totalSynced} conversations, ${totalMessages} messages`)
    } catch (error) {
      logger.error('[LB Sync] Error:', error.message)
      syncProgress[userId] = { status: 'error', error: error.message }
    }
  }

  return router
}
