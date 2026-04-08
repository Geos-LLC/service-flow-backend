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

module.exports = (supabase, logger, sigcoreRequest) => {
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

      // If connected (QR was scanned), update local settings
      if (qrData.connected) {
        const phoneNumber = qrData.phoneNumber || null
        await supabase.from('communication_settings').update({
          whatsapp_connected: true,
          whatsapp_phone_number: phoneNumber,
          whatsapp_connected_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }).eq('user_id', userId)

        // Register endpoint route for deterministic routing (Step A)
        if (phoneNumber) {
          const normalizePhone = (p) => {
            if (!p) return null
            const digits = p.replace(/[^\d+]/g, '')
            if (digits.startsWith('+')) return digits
            if (digits.length === 10) return `+1${digits}`
            if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`
            return digits
          }
          const normalized = normalizePhone(phoneNumber)
          if (normalized) {
            const { data: wsUser } = await supabase.from('sf_workspace_users')
              .select('workspace_id').eq('user_id', userId).eq('status', 'active').maybeSingle()
            if (wsUser?.workspace_id) {
              // Upsert endpoint route for WhatsApp
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

  return router
}
