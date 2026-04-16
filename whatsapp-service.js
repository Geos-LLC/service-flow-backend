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

// In-memory sync progress per user — shared with server.js for webhook progress tracking
const waSyncProgress = {}

module.exports = (supabase, logger, sigcoreRequest) => {
  const router = express.Router()
  // Expose progress object so webhook handler can track message delivery
  router.waSyncProgress = waSyncProgress

  // Helper: normalize avatar URL — base64 data needs data URI prefix, URLs pass through
  function normalizeAvatarUrl(url) {
    if (!url) return null
    if (url.startsWith('http') || url.startsWith('data:')) return url
    // Raw base64 — detect image type and add data URI prefix
    if (url.startsWith('/9j/') || url.startsWith('/9J/')) return `data:image/jpeg;base64,${url}`
    if (url.startsWith('iVBOR')) return `data:image/png;base64,${url}`
    if (url.startsWith('UklGR')) return `data:image/webp;base64,${url}`
    // Unknown base64 — assume JPEG
    if (url.length > 100 && !url.includes('/')) return `data:image/jpeg;base64,${url}`
    return url
  }

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

      // If connected (QR was scanned), update settings
      if (qrData.connected) {
        const phoneNumber = qrData.phoneNumber || null

        // Note: Sigcore now upserts by providerMessageId on reconnect instead of wiping.
        // SF must not wipe either — doing so loses history Sigcore won't re-send.

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
        // Set progress to 'receiving' — webhook handler will track incoming messages
        waSyncProgress[userId] = { phase: 'receiving', chats: 0, messages: 0, skipped: 0, linked: 0, total: 0 }
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

      // Init progress — preserve webhook-delivered counts if receiving phase was active
      const existing = waSyncProgress[userId]
      const webhookChats = (existing?.phase === 'receiving' && existing?.chats) || 0
      const webhookMessages = (existing?.phase === 'receiving' && existing?.messages) || 0
      waSyncProgress[userId] = { phase: 'fetching', chats: webhookChats, messages: webhookMessages, skipped: 0, linked: 0, total: 0 }
      res.json({ success: true, message: 'Sync started' })

      // Fetch chat list from WhatsApp microservice (via Sigcore proxy)
      // This is the source of truth for contact names + group status
      // Sigcore's conversations DB may be empty due to clearWhatsAppData timing
      let chatsData = []
      try {
        const chatsRes = await sigcoreRequest('GET', `/integrations/whatsapp/chats?includeMessages=false`, tenantKey)
        chatsData = chatsRes.data?.data?.chats || chatsRes.data?.chats || []
      } catch (e) {
        logger.error('[WhatsApp Sync] Failed to fetch chats:', e.response?.data || e.message)
        waSyncProgress[userId] = { ...waSyncProgress[userId], phase: 'error', error: 'Failed to fetch chats from WhatsApp' }
        return
      }

      waSyncProgress[userId].total = chatsData.length
      waSyncProgress[userId].phase = 'syncing'
      logger.log(`[WhatsApp Sync] Processing ${chatsData.length} chats from microservice for user ${userId}`)

      for (const chat of chatsData) {
        try {
          const isGroup = !!chat.isGroup || chat.phone?.includes('@')
          // Normalize group IDs: ensure @g.us suffix so it matches Sigcore's format
          let participantPhone = isGroup ? chat.phone : normalizePhone(chat.phone)
          if (isGroup && participantPhone && !participantPhone.includes('@')) {
            participantPhone = participantPhone + '@g.us'
          }
          if (!participantPhone) { waSyncProgress[userId].skipped++; continue }

          // Validate individual phone numbers (skip invalid, allow groups)
          if (!isGroup) {
            const rawDigits = participantPhone.replace(/[^\d]/g, '')
            if (rawDigits.length < 7) { waSyncProgress[userId].skipped++; continue }
          }

          // Find existing conversation (created by webhook handler) and update metadata
          // Try both with and without @g.us for groups (legacy stubs may lack the suffix)
          let existingConv = null
          const { data: found } = await supabase.from('communication_conversations')
            .select('*')
            .eq('user_id', userId).eq('provider', 'whatsapp')
            .eq('endpoint_phone', endpointPhone).eq('participant_phone', participantPhone)
            .maybeSingle()
          existingConv = found
          if (!existingConv && isGroup) {
            const altPhone = participantPhone.replace('@g.us', '')
            const { data: altFound } = await supabase.from('communication_conversations')
              .select('*')
              .eq('user_id', userId).eq('provider', 'whatsapp')
              .eq('endpoint_phone', endpointPhone).eq('participant_phone', altPhone)
              .maybeSingle()
            if (altFound) {
              // Fix the phone to canonical format
              await supabase.from('communication_conversations').update({ participant_phone: participantPhone }).eq('id', altFound.id)
              existingConv = { ...altFound, participant_phone: participantPhone }
            }
          }

          if (existingConv) {
            // Update name from microservice (contact resolution)
            const updates = {}
            if (chat.name && !existingConv.participant_name) updates.participant_name = chat.name
            if (chat.name && existingConv.participant_name !== chat.name) updates.participant_name = chat.name
            if (normalizeAvatarUrl(chat.avatarUrl)) {
              const meta = existingConv.metadata || {}
              if (meta.avatarUrl !== normalizeAvatarUrl(chat.avatarUrl)) updates.metadata = { ...meta, avatarUrl: normalizeAvatarUrl(chat.avatarUrl) }
            }
            if (isGroup && !(existingConv.metadata || {}).isGroup) {
              updates.metadata = { ...(existingConv.metadata || {}), ...(updates.metadata || {}), isGroup: true }
              updates.conversation_type = 'group'
            }
            if (Object.keys(updates).length > 0) {
              updates.updated_at = new Date().toISOString()
              await supabase.from('communication_conversations').update(updates).eq('id', existingConv.id)
            }
          } else {
            // Create conversation stub (messages will arrive via webhooks or already have)
            const { error: createErr } = await supabase.from('communication_conversations').insert({
              user_id: userId, provider: 'whatsapp', channel: 'whatsapp',
              endpoint_phone: endpointPhone, participant_phone: participantPhone,
              participant_name: chat.name || null,
              last_preview: chat.lastMessageAt ? '' : '',
              last_event_at: chat.lastMessageAt || new Date().toISOString(),
              unread_count: chat.unreadCount || 0,
              conversation_type: isGroup ? 'group' : 'external_client',
              metadata: {
                externalChatId: chat.id,
                ...(normalizeAvatarUrl(chat.avatarUrl) && { avatarUrl: normalizeAvatarUrl(chat.avatarUrl) }),
                ...(isGroup && { isGroup: true }),
              },
            }).select().single()
            if (createErr) { logger.error('[WhatsApp Sync] Create conversation error:', createErr); continue }
          }

          // Auto-link to customer/lead by phone (non-blocking, skip groups)
          if (existingConv && !existingConv.customer_id && !existingConv.lead_id && !isGroup) {
            try {
              const last10 = participantPhone.replace(/[^\d]/g, '').slice(-10)
              if (last10.length >= 7) {
                const { data: customer } = await supabase.from('customers')
                  .select('id').eq('user_id', userId).ilike('phone', `%${last10}%`).limit(1).maybeSingle()
                if (customer) {
                  await supabase.from('communication_conversations').update({ customer_id: customer.id }).eq('id', existingConv.id)
                  waSyncProgress[userId].linked++
                } else {
                  const { data: lead } = await supabase.from('leads')
                    .select('id').eq('user_id', userId).ilike('phone', `%${last10}%`).limit(1).maybeSingle()
                  if (lead) {
                    await supabase.from('communication_conversations').update({ lead_id: lead.id }).eq('id', existingConv.id)
                    waSyncProgress[userId].linked++
                  }
                }
              }
            } catch (e) { /* non-fatal */ }
          }

          waSyncProgress[userId].chats++
        } catch (e) {
          logger.warn(`[WhatsApp Sync] Error processing chat: ${e.message}`)
          waSyncProgress[userId].skipped++
        }
      }

      // ── Step 2: Pull avatars from Sigcore conversations API ──
      // The microservice has names/phones but Sigcore DB has avatars (from contacts_sync)
      try {
        let avatarConvs = []
        let page = 1
        while (true) {
          const convRes = await sigcoreRequest('GET', `/conversations?provider=whatsapp&page=${page}&limit=50`, tenantKey)
          const convData = convRes.data?.data || []
          const meta = convRes.data?.meta || {}
          avatarConvs.push(...convData)
          if (page >= (meta.totalPages || 1)) break
          page++
        }

        let avatarsUpdated = 0
        let msgsFetched = 0
        for (const sigConv of avatarConvs) {
          const phone = sigConv.participantPhoneNumber
          if (!phone) continue

          // Find matching SF conversation — try exact phone, then without @g.us (legacy stubs)
          let sfConv = null
          const { data: found } = await supabase.from('communication_conversations')
            .select('id, metadata, sigcore_conversation_id, participant_phone')
            .eq('user_id', userId).eq('provider', 'whatsapp').eq('participant_phone', phone)
            .maybeSingle()
          sfConv = found
          if (!sfConv && phone.includes('@g.us')) {
            const altPhone = phone.replace('@g.us', '')
            const { data: altFound } = await supabase.from('communication_conversations')
              .select('id, metadata, sigcore_conversation_id, participant_phone')
              .eq('user_id', userId).eq('provider', 'whatsapp').eq('participant_phone', altPhone)
              .maybeSingle()
            if (altFound) {
              // Fix phone to canonical format
              await supabase.from('communication_conversations').update({ participant_phone: phone }).eq('id', altFound.id)
              sfConv = { ...altFound, participant_phone: phone }
            }
          }

          if (sfConv) {
            const meta = sfConv.metadata || {}
            const updates = { updated_at: new Date().toISOString() }
            if (normalizeAvatarUrl(sigConv.avatarUrl) && meta.avatarUrl !== normalizeAvatarUrl(sigConv.avatarUrl)) {
              updates.metadata = { ...meta, avatarUrl: normalizeAvatarUrl(sigConv.avatarUrl) }
              avatarsUpdated++
            }
            if (sigConv.contactName) updates.participant_name = sigConv.contactName
            if (!sfConv.sigcore_conversation_id && sigConv.id) {
              updates.sigcore_conversation_id = sigConv.id
            }

            // Fetch messages from Sigcore for this conversation
            if (sigConv.id) {
              try {
                const msgsRes = await sigcoreRequest('GET', `/conversations/${sigConv.id}/messages?limit=50`, tenantKey)
                const msgs = msgsRes.data?.data || []
                let inserted = 0
                let latestBody = null
                let latestAt = null
                for (const msg of msgs) {
                  const sigMsgId = msg.id
                  if (!sigMsgId) continue
                  const { data: existing } = await supabase.from('communication_messages')
                    .select('id').eq('sigcore_message_id', sigMsgId).maybeSingle()
                  if (existing) continue
                  const dir = (msg.direction === 'incoming' || msg.direction === 'in') ? 'in' : 'out'
                  const mediaMeta = msg.hasMedia ? {
                    hasMedia: true,
                    mediaType: msg.mediaType || null,
                    mediaMimetype: msg.mediaMimetype || null,
                    mediaFilename: msg.mediaFilename || null,
                    mediaStatus: msg.mediaStatus || null,
                    sigcoreMediaUrl: msg.mediaUrl || null,
                  } : null
                  const msgCreatedAt = msg.createdAt || new Date().toISOString()
                  await supabase.from('communication_messages').insert({
                    conversation_id: sfConv.id,
                    sigcore_message_id: sigMsgId,
                    provider_message_id: msg.providerMessageId || null,
                    direction: dir, channel: 'whatsapp', body: msg.body || '',
                    from_number: normalizePhone(msg.fromNumber),
                    to_number: normalizePhone(msg.toNumber),
                    sender_role: dir === 'in' ? 'customer' : 'agent',
                    status: msg.status || 'delivered',
                    metadata: { ...(mediaMeta && { media: mediaMeta }) },
                    created_at: msgCreatedAt,
                  })
                  inserted++
                  // Track latest message for preview
                  if (!latestAt || msgCreatedAt > latestAt) {
                    latestAt = msgCreatedAt
                    latestBody = msg.body || ''
                  }
                }
                if (inserted > 0) {
                  msgsFetched += inserted
                  waSyncProgress[userId].messages += inserted
                }
                // Update last_preview from newest message
                if (latestBody) {
                  updates.last_preview = latestBody.substring(0, 200)
                  updates.last_event_at = latestAt
                } else if (sigConv.lastMessage) {
                  updates.last_preview = sigConv.lastMessage.substring(0, 200)
                }
              } catch (e) {
                logger.warn(`[WhatsApp Sync] Msg fetch failed for conv ${sigConv.id}: ${e.response?.status || ''} ${e.message}`)
              }
            }

            if (Object.keys(updates).length > 1) {
              await supabase.from('communication_conversations').update(updates).eq('id', sfConv.id)
            }
          }
        }
        if (avatarsUpdated > 0) logger.log(`[WhatsApp Sync] Updated ${avatarsUpdated} avatars from Sigcore API`)
        if (msgsFetched > 0) logger.log(`[WhatsApp Sync] Fetched ${msgsFetched} messages across ${avatarConvs.length} Sigcore conversations`)
      } catch (e) {
        // Sigcore conversations API may return 0 — non-fatal, avatars are supplementary
        logger.warn(`[WhatsApp Sync] Avatar fetch from Sigcore API: ${e.response?.status || ''} ${e.message || 'failed'}`)
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
