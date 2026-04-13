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
  function resolveConfig(settings) {
    // If tenant settings row exists, use it (no fallback on missing key = misconfigured)
    if (settings) {
      if (!settings.sendgrid_api_key) {
        throw new Error('Email not configured: SendGrid API key is missing in your Notification Email settings.')
      }
      if (!settings.is_enabled) {
        throw new Error('Notification email is disabled in settings.')
      }
      return {
        apiKey: settings.sendgrid_api_key,
        fromEmail: settings.from_email || process.env.SENDGRID_FROM_EMAIL || 'noreply@serviceflow.app',
        fromName: settings.from_name || undefined,
        replyToEmail: settings.reply_to_email || undefined,
        replyToName: settings.reply_to_name || undefined,
      }
    }

    // No settings row → fall back to env vars
    const envKey = process.env.SENDGRID_API_KEY
    if (!envKey) {
      throw new Error('Email not configured: No SendGrid API key found (no tenant settings and no SENDGRID_API_KEY env var).')
    }
    return {
      apiKey: envKey,
      fromEmail: process.env.SENDGRID_FROM_EMAIL || 'info@spotless.homes',
      fromName: undefined,
      replyToEmail: undefined,
      replyToName: undefined,
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
   * @param {object} opts - { to, toName, subject, html, text, emailType }
   * emailType is REQUIRED (e.g. 'estimate', 'invoice', 'receipt', 'appointment', 'custom')
   */
  async function sendCustomerEmail(userId, { to, toName, subject, html, text, emailType }) {
    if (!emailType) throw new Error('emailType is required for all notification sends')
    if (!to) throw new Error('Recipient email (to) is required')

    const settings = await getSettings(userId)
    const config = resolveConfig(settings)

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
   * @param {object} opts - { to, toName, subject, html, text, emailType }
   * emailType is REQUIRED (e.g. 'team_invite', 'team_welcome', 'paystub', 'admin_new_member')
   */
  async function sendInternalEmail(userId, { to, toName, subject, html, text, emailType }) {
    if (!emailType) throw new Error('emailType is required for all notification sends')
    if (!to) throw new Error('Recipient email (to) is required')

    const settings = await getSettings(userId)
    const config = resolveConfig(settings)

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
    const config = resolveConfig(settings)

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
  router.get('/settings', authenticateToken, async (req, res) => {
    try {
      const userId = req.user.userId
      const settings = await getSettings(userId)

      if (!settings) {
        // Check if env fallback is available
        const envConfigured = !!process.env.SENDGRID_API_KEY
        return res.json({
          configured: envConfigured,
          source: envConfigured ? 'environment' : 'none',
          settings: null,
        })
      }

      return res.json({
        configured: !!settings.sendgrid_api_key,
        source: 'tenant',
        settings: {
          isEnabled: settings.is_enabled,
          fromEmail: settings.from_email,
          fromName: settings.from_name,
          replyToEmail: settings.reply_to_email,
          replyToName: settings.reply_to_name,
          useForCustomerNotifications: settings.use_for_customer_notifications,
          useForInternalNotifications: settings.use_for_internal_notifications,
          lastTestedAt: settings.last_tested_at,
          lastTestStatus: settings.last_test_status,
          lastTestError: settings.last_test_error,
          hasApiKey: !!settings.sendgrid_api_key,
        },
      })
    } catch (error) {
      logger.error('[NotificationEmail] Settings error:', error.message)
      res.status(500).json({ error: 'Failed to get notification email settings' })
    }
  })

  // PUT /settings — save notification email config
  router.put('/settings', authenticateToken, async (req, res) => {
    try {
      const userId = req.user.userId
      const { apiKey, fromEmail, fromName, replyToEmail, replyToName, useForCustomerNotifications, useForInternalNotifications, isEnabled } = req.body

      const existing = await getSettings(userId)
      const updates = {
        is_enabled: isEnabled !== undefined ? isEnabled : true,
        from_email: fromEmail?.trim() || null,
        from_name: fromName?.trim() || null,
        reply_to_email: replyToEmail?.trim() || null,
        reply_to_name: replyToName?.trim() || null,
        use_for_customer_notifications: useForCustomerNotifications !== undefined ? useForCustomerNotifications : true,
        use_for_internal_notifications: useForInternalNotifications !== undefined ? useForInternalNotifications : true,
        updated_at: new Date().toISOString(),
      }

      // Only update API key if provided (don't wipe on save without key)
      if (apiKey?.trim()) {
        updates.sendgrid_api_key = apiKey.trim()
      }

      if (existing) {
        await supabase.from('notification_email_settings').update(updates).eq('user_id', userId)
      } else {
        updates.user_id = userId
        if (!apiKey?.trim()) {
          return res.status(400).json({ error: 'SendGrid API key is required for initial setup' })
        }
        updates.sendgrid_api_key = apiKey.trim()
        await supabase.from('notification_email_settings').insert(updates)
      }

      logger.log(`[NotificationEmail] Settings saved for user ${userId}`)
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
