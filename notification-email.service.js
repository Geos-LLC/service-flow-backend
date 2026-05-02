/**
 * Notification Email Service (Centralized Outbound Email)
 *
 * Handles ALL transactional/notification emails:
 * - Customer: estimates, invoices, receipts, reminders, custom messages
 * - Internal: team invites, welcome/activation, paystubs, admin alerts
 *
 * NOT responsible for: inbox sync, inbound parsing, conversation threading,
 * communication hub, connected mailboxes.
 *
 * Tenant-configurable: per-user SendGrid settings in notification_email_settings.
 * Falls back to env vars (SENDGRID_API_KEY / SENDGRID_FROM_EMAIL) if no settings row exists.
 */

const sgMail = require('@sendgrid/mail')
const express = require('express')

// In-memory rate limit tracking: { userId: { count, windowStart } }
const rateLimits = {}
const RATE_LIMIT_MAX = 200
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000 // 1 hour

module.exports = (supabase, logger) => {
  const router = express.Router()

  // ══════════════════════════════════════
  // Auth middleware
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

  // ══════════════════════════════════════
  // Core helpers
  // ══════════════════════════════════════

  /** Load tenant notification settings, or null if none configured */
  async function getSettings(userId) {
    const { data } = await supabase.from('notification_email_settings')
      .select('*').eq('user_id', userId).maybeSingle()
    return data || null
  }

  /** Resolve SendGrid config: tenant settings → env fallback */
  /** Load platform-level setting from DB (with env fallback) */
  async function getPlatformSetting(key, envFallback) {
    try {
      const { data } = await supabase.from('platform_settings').select('value').eq('key', key).maybeSingle()
      return data?.value || process.env[envFallback] || null
    } catch (e) {
      return process.env[envFallback] || null
    }
  }

  async function resolveConfig(settings) {
    // API key from DB first, env fallback (application-level, not per-tenant)
    const apiKey = await getPlatformSetting('sendgrid_api_key', 'SENDGRID_API_KEY')
    if (!apiKey) {
      throw new Error('Email not configured: SendGrid API key is not set in admin settings.')
    }

    if (settings && !settings.is_enabled) {
      throw new Error('Notification email is disabled in settings.')
    }

    const platformFromEmail = await getPlatformSetting('sendgrid_from_email', 'SENDGRID_FROM_EMAIL')

    // Tenant settings override from/name/reply-to only
    return {
      apiKey,
      fromEmail: settings?.from_email || platformFromEmail || 'info@spotless.homes',
      fromName: settings?.from_name || undefined,
      replyToEmail: settings?.reply_to_email || undefined,
      replyToName: settings?.reply_to_name || undefined,
    }
  }

  /** Check rate limit for tenant. Throws if exceeded. */
  function checkRateLimit(userId) {
    const now = Date.now()
    const entry = rateLimits[userId]

    if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
      rateLimits[userId] = { count: 1, windowStart: now }
      return
    }

    entry.count++
    if (entry.count > RATE_LIMIT_MAX) {
      throw new Error(`Rate limit exceeded: ${RATE_LIMIT_MAX} emails per hour. Try again later.`)
    }
  }

  /** Log email send result to notification_email_logs */
  async function logSend(userId, { emailType, recipientEmail, recipientName, subject, status, providerMessageId, errorMessage, metadata }) {
    try {
      await supabase.from('notification_email_logs').insert({
        user_id: userId,
        email_type: emailType,
        recipient_email: recipientEmail,
        recipient_name: recipientName || null,
        subject: subject || null,
        status,
        provider: 'sendgrid',
        provider_message_id: providerMessageId || null,
        error_message: errorMessage || null,
        metadata: metadata || {},
        sent_at: status === 'sent' ? new Date().toISOString() : null,
      })
    } catch (e) {
      logger.error('[NotificationEmail] Log insert failed:', e.message)
    }
  }

  /** Send with retry (up to 2 retries on 5xx/timeout) */
  async function sendWithRetry(msg, maxRetries = 2) {
    let lastError
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await sgMail.send(msg)
      } catch (error) {
        lastError = error
        const code = error.code || error.response?.statusCode
        // Only retry on 5xx or network errors, not 4xx
        if (code && code >= 400 && code < 500) throw error
        if (attempt < maxRetries) {
          await new Promise(r => setTimeout(r, 1000))
        }
      }
    }
    throw lastError
  }

  // ══════════════════════════════════════
  // Public API
  // ══════════════════════════════════════

  /**
   * Send a customer-facing notification email.
   * @param {number} userId - Tenant owner user ID
   * @param {object} opts - { to, toName, subject, html, text, emailType, attachments }
   * emailType is REQUIRED (e.g. 'estimate', 'invoice', 'receipt', 'appointment', 'custom')
   * attachments (optional) - array of { content (base64 string), filename, type, disposition }
   */
  async function sendCustomerEmail(userId, { to, toName, subject, html, text, emailType, attachments }) {
    if (!emailType) throw new Error('emailType is required for all notification sends')
    if (!to) throw new Error('Recipient email (to) is required')

    const settings = await getSettings(userId)
    const config = await resolveConfig(settings)

    // Check tenant toggle
    if (settings && !settings.use_for_customer_notifications) {
      throw new Error('Customer email notifications are disabled in settings.')
    }

    checkRateLimit(userId)
    sgMail.setApiKey(config.apiKey)

    const msg = {
      to,
      from: config.fromName ? { email: config.fromEmail, name: config.fromName } : config.fromEmail,
      subject,
      html,
      text,
    }
    if (config.replyToEmail) {
      msg.replyTo = config.replyToName
        ? { email: config.replyToEmail, name: config.replyToName }
        : config.replyToEmail
    }
    if (Array.isArray(attachments) && attachments.length > 0) {
      msg.attachments = attachments
    }

    try {
      const result = await sendWithRetry(msg)
      const messageId = result?.[0]?.headers?.['x-message-id'] || null

      await logSend(userId, {
        emailType, recipientEmail: to, recipientName: toName, subject,
        status: 'sent', providerMessageId: messageId,
      })

      logger.log(`[NotificationEmail] Sent ${emailType} to ${to} (msg: ${messageId})`)
      return { messageId, status: 'sent' }
    } catch (error) {
      await logSend(userId, {
        emailType, recipientEmail: to, recipientName: toName, subject,
        status: error.message?.includes('Rate limit') ? 'rate_limited' : 'failed',
        errorMessage: error.message,
      })
      throw error
    }
  }

  /**
   * Send an internal/team notification email.
   * @param {number} userId - Tenant owner user ID
   * @param {object} opts - { to, toName, subject, html, text, emailType, attachments }
   * emailType is REQUIRED (e.g. 'team_invite', 'team_welcome', 'paystub', 'admin_new_member')
   * attachments (optional) - array of { content (base64 string), filename, type, disposition }
   */
  async function sendInternalEmail(userId, { to, toName, subject, html, text, emailType, attachments }) {
    if (!emailType) throw new Error('emailType is required for all notification sends')
    if (!to) throw new Error('Recipient email (to) is required')

    const settings = await getSettings(userId)
    const config = await resolveConfig(settings)

    // Check tenant toggle
    if (settings && !settings.use_for_internal_notifications) {
      throw new Error('Internal email notifications are disabled in settings.')
    }

    checkRateLimit(userId)
    sgMail.setApiKey(config.apiKey)

    const msg = {
      to,
      from: config.fromName ? { email: config.fromEmail, name: config.fromName } : config.fromEmail,
      subject,
      html,
      text,
    }
    if (config.replyToEmail) {
      msg.replyTo = config.replyToName
        ? { email: config.replyToEmail, name: config.replyToName }
        : config.replyToEmail
    }
    if (Array.isArray(attachments) && attachments.length > 0) {
      msg.attachments = attachments
    }

    try {
      const result = await sendWithRetry(msg)
      const messageId = result?.[0]?.headers?.['x-message-id'] || null

      await logSend(userId, {
        emailType, recipientEmail: to, recipientName: toName, subject,
        status: 'sent', providerMessageId: messageId,
      })

      logger.log(`[NotificationEmail] Sent ${emailType} to ${to} (msg: ${messageId})`)
      return { messageId, status: 'sent' }
    } catch (error) {
      await logSend(userId, {
        emailType, recipientEmail: to, recipientName: toName, subject,
        status: error.message?.includes('Rate limit') ? 'rate_limited' : 'failed',
        errorMessage: error.message,
      })
      throw error
    }
  }

  /**
   * Send a test email to verify SendGrid connectivity.
   */
  async function sendTestEmail(userId, testEmail) {
    if (!testEmail) throw new Error('Test email address is required')

    const settings = await getSettings(userId)
    const config = await resolveConfig(settings)

    sgMail.setApiKey(config.apiKey)

    const msg = {
      to: testEmail,
      from: config.fromName ? { email: config.fromEmail, name: config.fromName } : config.fromEmail,
      subject: 'Test Email from Service Flow',
      html: '<h1>Test Email</h1><p>This is a test email to verify your notification email configuration.</p><p>If you received this, your SendGrid setup is working correctly.</p>',
      text: 'Test Email - This is a test email to verify your notification email configuration.',
    }

    try {
      const result = await sgMail.send(msg)
      const messageId = result?.[0]?.headers?.['x-message-id'] || null

      // Update test status
      if (settings) {
        await supabase.from('notification_email_settings').update({
          last_tested_at: new Date().toISOString(),
          last_test_status: 'success',
          last_test_error: null,
          updated_at: new Date().toISOString(),
        }).eq('user_id', userId)
      }

      await logSend(userId, {
        emailType: 'test', recipientEmail: testEmail, subject: msg.subject,
        status: 'sent', providerMessageId: messageId,
      })

      return { messageId, status: 'sent' }
    } catch (error) {
      // Update test status with error
      if (settings) {
        await supabase.from('notification_email_settings').update({
          last_tested_at: new Date().toISOString(),
          last_test_status: 'failed',
          last_test_error: error.message,
          updated_at: new Date().toISOString(),
        }).eq('user_id', userId)
      }

      await logSend(userId, {
        emailType: 'test', recipientEmail: testEmail, subject: msg.subject,
        status: 'failed', errorMessage: error.message,
      })

      throw error
    }
  }

  // ══════════════════════════════════════
  // API Endpoints
  // ══════════════════════════════════════

  // GET /settings — current notification email config (never expose API key)
  // GET /settings — tenant email sender config (API key is app-level, not exposed)
  router.get('/settings', authenticateToken, async (req, res) => {
    try {
      const userId = req.user.userId
      const settings = await getSettings(userId)

      return res.json({
        configured: !!settings,
        settings: settings ? {
          isEnabled: settings.is_enabled,
          fromEmail: settings.from_email,
          fromName: settings.from_name,
          replyToEmail: settings.reply_to_email,
          replyToName: settings.reply_to_name,
          lastTestedAt: settings.last_tested_at,
          lastTestStatus: settings.last_test_status,
          lastTestError: settings.last_test_error,
        } : null,
      })
    } catch (error) {
      logger.error('[NotificationEmail] Settings error:', error.message)
      res.status(500).json({ error: 'Failed to get notification email settings' })
    }
  })

  // PUT /settings — save tenant sender config (no API key — that's app-level)
  router.put('/settings', authenticateToken, async (req, res) => {
    try {
      const userId = req.user.userId
      const { fromEmail, fromName, replyToEmail, replyToName } = req.body

      if (!fromEmail?.trim()) {
        return res.status(400).json({ error: 'From email is required' })
      }

      const existing = await getSettings(userId)
      const updates = {
        from_email: fromEmail.trim(),
        from_name: fromName?.trim() || null,
        reply_to_email: replyToEmail?.trim() || null,
        reply_to_name: replyToName?.trim() || null,
        updated_at: new Date().toISOString(),
      }

      if (existing) {
        await supabase.from('notification_email_settings').update(updates).eq('user_id', userId)
      } else {
        updates.user_id = userId
        await supabase.from('notification_email_settings').insert(updates)
      }

      logger.log(`[NotificationEmail] Settings saved for user ${userId}: from=${fromEmail.trim()}`)
      return res.json({ success: true })
    } catch (error) {
      logger.error('[NotificationEmail] Save settings error:', error.message)
      res.status(500).json({ error: 'Failed to save notification email settings' })
    }
  })

  // POST /test — send test email
  router.post('/test', authenticateToken, async (req, res) => {
    try {
      const userId = req.user.userId
      const { testEmail } = req.body
      const result = await sendTestEmail(userId, testEmail)
      res.json({ success: true, ...result })
    } catch (error) {
      logger.error('[NotificationEmail] Test error:', error.message)
      res.status(500).json({ error: error.message || 'Failed to send test email' })
    }
  })

  // GET /logs — delivery log (paginated)
  router.get('/logs', authenticateToken, async (req, res) => {
    try {
      const userId = req.user.userId
      const page = parseInt(req.query.page) || 1
      const limit = Math.min(parseInt(req.query.limit) || 50, 100)
      const offset = (page - 1) * limit
      const emailType = req.query.emailType

      let query = supabase.from('notification_email_logs')
        .select('*', { count: 'exact' })
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1)

      if (emailType) query = query.eq('email_type', emailType)

      const { data, count, error } = await query
      if (error) return res.status(500).json({ error: 'Failed to fetch logs' })

      res.json({ logs: data || [], total: count || 0, page, limit })
    } catch (error) {
      logger.error('[NotificationEmail] Logs error:', error.message)
      res.status(500).json({ error: 'Failed to fetch notification email logs' })
    }
  })

  // Expose service methods for server.js and other modules
  router.sendCustomerEmail = sendCustomerEmail
  router.sendInternalEmail = sendInternalEmail
  router.sendTestEmail = sendTestEmail
  router.getSettings = getSettings

  return router
}
