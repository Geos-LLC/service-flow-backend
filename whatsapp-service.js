/**
 * WhatsApp Business Channel Module (Loosely Coupled)
 *
 * Mount: app.use('/api/integrations/whatsapp', require('./whatsapp-service')(supabase, logger, sigcoreRequest))
 * Remove: delete this file + remove the line above = zero breakage
 *
 * WhatsApp is treated as another provider/channel (like OpenPhone).
 * Conversations use the same tables with provider='whatsapp', channel='whatsapp'.
 *
 * CRITICAL: All Sigcore calls use sigcore_tenant_api_key, NEVER SIGCORE_WORKSPACE_KEY.
 */

const express = require('express')

// In-memory sync progress per user
const waSyncProgress = {}

module.exports = (supabase, logger, sigcoreRequest) => {
  const router = express.Router()

  // Helper: normalize phone to E.164
  function normalizePhone(phone) {
    if (!phone) return null
    const digits = phone.replace(/[^\d+]/g, '')
    if (digits.startsWith('+')) return digits
    if (digits.length === 10) return `+1${digits}`
    if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`
    return digits
  }

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
    } catch (e) {
      return res.status(401).json({ error: 'Invalid token' })
    }
  }

  router.use(authenticateToken)

  // Helper: get tenant API key (NEVER workspace key)
  async function getTenantKey(userId) {
    const { data } = await supabase.from('communication_settings')
      .select('sigcore_tenant_api_key').eq('user_id', userId).maybeSingle()
    return data?.sigcore_tenant_api_key || null
  }

  // ══════════════════════════════════════
  // GET /status — WhatsApp connection status
  // ══════════════════════════════════════
  router.get('/status', async (req, res) => {
    try {
      const userId = req.user.userId
      const { data: settings } = await supabase.from('communication_settings')
        .select('whatsapp_connected, whatsapp_phone_number, whatsapp_connected_at, sigcore_tenant_api_key')
        .eq('user_id', userId).maybeSingle()

      if (!settings?.sigcore_tenant_api_key) {
        return res.json({ connected: false, status: 'no_sigcore', phoneNumber: null })
      }

      // Verify with Sigcore
      try {
        const sigRes = await sigcoreRequest('GET', '/integrations/whatsapp/status', settings.sigcore_tenant_api_key)
        const sigData = sigRes.data?.data || sigRes.data || {}
        return res.json({
          connected: sigData.connected || false,
          status: sigData.status || 'disconnected',
          phoneNumber: sigData.phoneNumber || settings.whatsapp_phone_number || null,
          hasQrCode: sigData.hasQrCode || false,
        })
      } catch (e) {
        // Sigcore unreachable — use local state
        return res.json({
          connected: settings.whatsapp_connected || false,
          status: settings.whatsapp_connected ? 'connected' : 'disconnected',
          phoneNumber: settings.whatsapp_phone_number || null,
          hasQrCode: false,
        })
      }
    } catch (error) {
      logger.error('[WhatsApp] Status error:', error.message)
      res.status(500).json({ error: 'Failed to get WhatsApp status' })
    }
  })

  // ══════════════════════════════════════
  // POST /connect — Start WhatsApp connection
  // ══════════════════════════════════════
  router.post('/connect', async (req, res) => {
    try {
      const userId = req.user.userId
      const tenantKey = await getTenantKey(userId)
      if (!tenantKey) return res.status(400).json({ error: 'OpenPhone must be connected first (Sigcore tenant required)' })

      // 1. Initialize WhatsApp client in Sigcore
      const connectRes = await sigcoreRequest('POST', '/integrations/whatsapp/connect', tenantKey)
      const session = connectRes.data?.data || connectRes.data || {}

      // 2. Register webhook subscription for WhatsApp events
      const baseUrl = process.env.RAILWAY_PUBLIC_DOMAIN
        ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
        : 'https://service-flow-backend-production-4568.up.railway.app'

      try {
        await sigcoreRequest('POST', '/v1/webhook-subscriptions', tenantKey, {
          name: 'Service Flow WhatsApp',
          webhookUrl: `${baseUrl}/api/communications/webhooks/sigcore`,
          events: ['whatsapp.message.inbound', 'whatsapp.message.delivered', 'whatsapp.status.change'],
          metadata: { userId, channel: 'whatsapp' }
        })
      } catch (e) {
        // Subscription may already exist — not fatal
        logger.warn('[WhatsApp] Webhook subscription:', e.response?.data?.message || e.message)
      }

      logger.log(`[WhatsApp] Connect initiated for user ${userId}, status: ${session.status}`)
      res.json({
        success: session.status !== 'error',
        status: session.status || 'initializing',
        hasQrCode: session.status === 'qr_ready',
      })
    } catch (error) {
      logger.error('[WhatsApp] Connect error:', error.response?.data || error.message)
      res.status(500).json({ error: error.response?.data?.message || 'Failed to connect WhatsApp' })
    }
  })

  // ══════════════════════════════════════
  // GET /qr — Get QR code for scanning
  // ══════════════════════════════════════
  router.get('/qr', async (req, res) => {
    try {
      const userId = req.user.userId
      const tenantKey = await getTenantKey(userId)
      if (!tenantKey) return res.status(400).json({ error: 'Sigcore not configured' })

      const qrRes = await sigcoreRequest('GET', '/integrations/whatsapp/qr', tenantKey)
      const qrData = qrRes.data?.data || qrRes.data || {}

      // If connected (QR was scanned), clear old data + update settings
      if (qrData.connected) {
        const phoneNumber = qrData.phoneNumber || null

        // ── Clear old WhatsApp data (synchronous, before anything else) ──
        // Conversations + messages will be re-created by webhook delivery
        try {
          const { data: oldConvs } = await supabase.from('communication_conversations')
            .select('id').eq('user_id', userId).eq('provider', 'whatsapp')
          if (oldConvs && oldConvs.length > 0) {
            const oldIds = oldConvs.map(c => c.id)
            await supabase.from('communication_messages').delete().in('conversation_id', oldIds)
            await supabase.from('communication_conversations').delete().in('id', oldIds)
            logger.log(`[WhatsApp] Cleared ${oldConvs.length} old conversations for user ${userId}`)
          }
        } catch (e) {
          logger.warn('[WhatsApp] Failed to clear old data:', e.message)
        }

        // ── Update connection settings ──
        await supabase.from('communication_settings').update({
          whatsapp_connected: true,
          whatsapp_phone_number: phoneNumber,
          whatsapp_connected_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }).eq('user_id', userId)

        // ── Register endpoint route for deterministic routing (Step A) ──
        if (phoneNumber) {
          const normalized = normalizePhone(phoneNumber)
          if (normalized) {
            const { data: wsUser } = await supabase.from('sf_workspace_users')
              .select('workspace_id').eq('user_id', userId).eq('status', 'active').maybeSingle()
            if (wsUser?.workspace_id) {
              const { data: existing } = await supabase.from('communication_endpoint_routes')
                .select('id').eq('provider', 'whatsapp').eq('phone_number', normalized).eq('channel', 'whatsapp').eq('is_active', true).maybeSingle()
              if (existing) {
                await supabase.from('communication_endpoint_routes').update({
                  workspace_id: wsUser.workspace_id, updated_at: new Date().toISOString()
                }).eq('id', existing.id)
              } else {
                await supabase.from('communication_endpoint_routes').insert({
                  workspace_id: wsUser.workspace_id, provider: 'whatsapp',
                  endpoint_id: `wa_${normalized}`, phone_number: normalized, channel: 'whatsapp',
                  role: 'sigcore_registered_number', route_source: 'auto_connect',
                  is_active: true, activated_at: new Date().toISOString(),
                })
              }
              logger.log(`[WhatsApp] Registered endpoint route for ${normalized}`)
            }
          }
        }

        logger.log(`[WhatsApp] Connected for user ${userId}, phone: ${phoneNumber}`)
        // Messages will arrive via whatsapp.message.inbound webhooks as Sigcore auto-sync runs (~2 min)
      }

      res.json({
        connected: qrData.connected || false,
        status: qrData.status || 'unknown',
        qrCode: qrData.qrCode || null,
        phoneNumber: qrData.phoneNumber || null,
      })
    } catch (error) {
      logger.error('[WhatsApp] QR error:', error.response?.data || error.message)
      res.status(500).json({ error: 'Failed to get QR code' })
    }
  })

  // ══════════════════════════════════════
  // POST /disconnect — Disconnect WhatsApp
  // ══════════════════════════════════════
  router.post('/disconnect', async (req, res) => {
    try {
      const userId = req.user.userId
      const tenantKey = await getTenantKey(userId)
      if (!tenantKey) return res.status(400).json({ error: 'Sigcore not configured' })

      // Disconnect in Sigcore
      try {
        await sigcoreRequest('DELETE', '/integrations/whatsapp/disconnect', tenantKey)
      } catch (e) {
        logger.warn('[WhatsApp] Disconnect warning:', e.response?.data?.message || e.message)
      }

      // Deactivate endpoint routes
      const { data: settings } = await supabase.from('communication_settings')
        .select('whatsapp_phone_number').eq('user_id', userId).maybeSingle()
      if (settings?.whatsapp_phone_number) {
        await supabase.from('communication_endpoint_routes')
          .update({ is_active: false, deactivated_at: new Date().toISOString() })
          .eq('provider', 'whatsapp').eq('is_active', true)
      }

      // Clear local settings
      await supabase.from('communication_settings').update({
        whatsapp_connected: false,
        whatsapp_phone_number: null,
        whatsapp_connected_at: null,
        updated_at: new Date().toISOString(),
      }).eq('user_id', userId)

      logger.log(`[WhatsApp] Disconnected for user ${userId}`)
      res.json({ success: true })
    } catch (error) {
      logger.error('[WhatsApp] Disconnect error:', error.message)
      res.status(500).json({ error: 'Failed to disconnect WhatsApp' })
    }
  })

  // ══════════════════════════════════════
  // POST /sync — Backfill WhatsApp chat history
  // ══════════════════════════════════════
  // Pulls conversations + messages from Sigcore's database (populated by auto-sync).
  // The microservice's direct chat API doesn't return messages for LID chats,
  // but Sigcore's auto-sync uses Puppeteer fallback and stores everything in DB.
  router.post('/sync', async (req, res) => {
    try {
      const userId = req.user.userId
      const messageLimit = parseInt(req.body.messageLimit) || 50
      const tenantKey = await getTenantKey(userId)
      if (!tenantKey) return res.status(400).json({ error: 'Sigcore not configured' })

      const { data: settings } = await supabase.from('communication_settings')
        .select('whatsapp_connected, whatsapp_phone_number')
        .eq('user_id', userId).maybeSingle()
      if (!settings?.whatsapp_connected) return res.status(400).json({ error: 'WhatsApp not connected' })

      const endpointPhone = normalizePhone(settings.whatsapp_phone_number)
      if (!endpointPhone) return res.status(400).json({ error: 'WhatsApp phone number not available. Reconnect WhatsApp.' })

      // Init progress
      waSyncProgress[userId] = { phase: 'fetching', chats: 0, messages: 0, skipped: 0, linked: 0, total: 0 }
      res.json({ success: true, message: 'Sync started' })

      // Fetch WhatsApp conversations from Sigcore's database (auto-sync stores them with full data)
      let allConversations = []
      try {
        let page = 1
        const pageSize = 50
        while (true) {
          const convRes = await sigcoreRequest('GET', `/conversations?provider=whatsapp&page=${page}&limit=${pageSize}`, tenantKey)
          const convData = convRes.data?.data || []
          const meta = convRes.data?.meta || {}
          allConversations.push(...convData)
          if (page >= (meta.totalPages || 1)) break
          page++
        }
      } catch (e) {
        logger.error('[WhatsApp Sync] Failed to fetch conversations:', e.response?.data || e.message)
        waSyncProgress[userId] = { ...waSyncProgress[userId], phase: 'error', error: 'Failed to fetch conversations from Sigcore' }
        return
      }

      waSyncProgress[userId].total = allConversations.length
      waSyncProgress[userId].phase = 'syncing'
      // Log sample conversation for debugging
      if (allConversations.length > 0) {
        const sample = allConversations[0]
        logger.log(`[WhatsApp Sync] Processing ${allConversations.length} conversations from Sigcore DB. Sample: id=${sample.id}, name=${sample.contactName}, phone=${sample.participantPhoneNumber}, provider=${sample.provider}, hasAvatar=${!!sample.avatarUrl}`)
      } else {
        logger.log(`[WhatsApp Sync] 0 conversations from Sigcore DB — auto-sync may not have finished yet`)
      }

      for (const sigConv of allConversations) {
        try {
          const participantPhone = normalizePhone(sigConv.participantPhoneNumber)
          if (!participantPhone) { waSyncProgress[userId].skipped++; continue }

          // Skip group chats (group IDs contain @g.us or are 18+ digits)
          const rawDigits = participantPhone.replace(/[^\d]/g, '')
          if (participantPhone.includes('@') || rawDigits.length > 15 || rawDigits.length < 7) {
            waSyncProgress[userId].skipped++; continue
          }

          // Find-or-create conversation: hardened identity (user_id, provider, endpoint_phone, participant_phone)
          let conversation
          const { data: existingConv } = await supabase.from('communication_conversations')
            .select('*')
            .eq('user_id', userId).eq('provider', 'whatsapp')
            .eq('endpoint_phone', endpointPhone).eq('participant_phone', participantPhone)
            .maybeSingle()

          if (existingConv) {
            conversation = existingConv
            // Update name and avatar if Sigcore has better data
            const updates = {}
            if (sigConv.contactName && !conversation.participant_name) updates.participant_name = sigConv.contactName
            if (sigConv.lastMessage && !conversation.last_preview) updates.last_preview = sigConv.lastMessage.substring(0, 200)
            if (sigConv.lastMessageAt) updates.last_event_at = sigConv.lastMessageAt
            // Store avatar in metadata
            if (sigConv.avatarUrl) {
              const existingMeta = conversation.metadata || {}
              if (existingMeta.avatarUrl !== sigConv.avatarUrl) {
                updates.metadata = { ...existingMeta, avatarUrl: sigConv.avatarUrl }
              }
            }
            if (Object.keys(updates).length > 0) {
              updates.updated_at = new Date().toISOString()
              await supabase.from('communication_conversations').update(updates).eq('id', conversation.id)
            }
          } else {
            const { data: newConv, error: createErr } = await supabase.from('communication_conversations').insert({
              user_id: userId, provider: 'whatsapp', channel: 'whatsapp',
              sigcore_conversation_id: sigConv.id,
              endpoint_phone: endpointPhone, participant_phone: participantPhone,
              participant_name: sigConv.contactName || null,
              last_preview: (sigConv.lastMessage || '').substring(0, 200),
              last_event_at: sigConv.lastMessageAt || new Date().toISOString(),
              unread_count: sigConv.unreadCount || 0,
              conversation_type: 'external_client',
              metadata: {
                externalChatId: sigConv.externalId,
                sigcoreConversationId: sigConv.id,
                ...(sigConv.avatarUrl && { avatarUrl: sigConv.avatarUrl }),
              },
            }).select().single()
            if (createErr) { logger.error('[WhatsApp Sync] Create conversation error:', createErr); continue }
            conversation = newConv
          }

          // Fetch messages from Sigcore's database for this conversation
          let sigMessages = []
          try {
            const msgRes = await sigcoreRequest('GET', `/conversations/${sigConv.id}/messages?limit=${messageLimit}`, tenantKey)
            sigMessages = msgRes.data?.data || []
            if (waSyncProgress[userId].chats < 3) {
              // Log first few conversations for debugging
              logger.log(`[WhatsApp Sync] Conv ${sigConv.id} (${sigConv.contactName || sigConv.participantPhoneNumber}): ${sigMessages.length} messages from Sigcore`)
            }
          } catch (e) {
            logger.warn(`[WhatsApp Sync] Failed to fetch messages for conv ${sigConv.id}: ${e.response?.status || ''} ${e.message}`)
          }

          // Insert messages with dedup
          for (const msg of sigMessages) {
            const providerMsgId = msg.providerMessageId || msg.id
            if (!providerMsgId) continue

            // Dedup by provider message ID
            const { data: existingMsg } = await supabase.from('communication_messages')
              .select('id').eq('provider_message_id', providerMsgId).maybeSingle()
            if (existingMsg) continue

            const direction = msg.direction === 'out' ? 'out' : 'in'
            const fromNumber = normalizePhone(msg.fromNumber) || (direction === 'out' ? endpointPhone : participantPhone)
            const toNumber = normalizePhone(msg.toNumber) || (direction === 'out' ? participantPhone : endpointPhone)

            await supabase.from('communication_messages').insert({
              conversation_id: conversation.id,
              provider_message_id: providerMsgId,
              direction, channel: 'whatsapp', body: msg.body || '',
              from_number: fromNumber, to_number: toNumber,
              sender_role: direction === 'in' ? 'customer' : 'agent',
              status: msg.status || 'delivered',
              metadata: msg.metadata || {},
              created_at: msg.createdAt || new Date().toISOString(),
            })
            waSyncProgress[userId].messages++
          }

          // Update conversation with latest message info from fetched messages
          if (sigMessages.length > 0) {
            const latestMsg = sigMessages[0] // Messages come sorted by createdAt DESC
            await supabase.from('communication_conversations').update({
              last_preview: (latestMsg.body || '').substring(0, 200),
              last_event_at: latestMsg.createdAt || sigConv.lastMessageAt || new Date().toISOString(),
              participant_name: sigConv.contactName || conversation.participant_name || null,
              updated_at: new Date().toISOString(),
            }).eq('id', conversation.id)
          }

          // Auto-link to customer/lead by phone (non-blocking)
          if (!conversation.customer_id && !conversation.lead_id) {
            try {
              const last10 = participantPhone.replace(/[^\d]/g, '').slice(-10)
              if (last10.length >= 7) {
                const { data: customer } = await supabase.from('customers')
                  .select('id').eq('user_id', userId).ilike('phone', `%${last10}%`).limit(1).maybeSingle()
                if (customer) {
                  await supabase.from('communication_conversations').update({ customer_id: customer.id }).eq('id', conversation.id)
                  waSyncProgress[userId].linked++
                } else {
                  const { data: lead } = await supabase.from('leads')
                    .select('id').eq('user_id', userId).ilike('phone', `%${last10}%`).limit(1).maybeSingle()
                  if (lead) {
                    await supabase.from('communication_conversations').update({ lead_id: lead.id }).eq('id', conversation.id)
                    waSyncProgress[userId].linked++
                  }
                }
              }
            } catch (e) { /* non-fatal */ }
          }

          waSyncProgress[userId].chats++
        } catch (e) {
          logger.warn(`[WhatsApp Sync] Error processing conversation: ${e.message}`)
          waSyncProgress[userId].skipped++
        }
      }

      waSyncProgress[userId].phase = 'done'
      logger.log(`[WhatsApp Sync] Done for user ${userId}: ${waSyncProgress[userId].chats} chats, ${waSyncProgress[userId].messages} messages, ${waSyncProgress[userId].linked} linked`)
    } catch (error) {
      logger.error('[WhatsApp Sync] Error:', error.message)
      if (!res.headersSent) res.status(500).json({ error: 'Sync failed' })
    }
  })

  // ══════════════════════════════════════
  // GET /sync/progress — Sync progress
  // ══════════════════════════════════════
  router.get('/sync/progress', async (req, res) => {
    const progress = waSyncProgress[req.user.userId]
    res.json(progress || { phase: 'idle' })
  })

  return router
}
