/**
 * Email (SendGrid) Communication Channel Module (Loosely Coupled)
 *
 * Mount: app.use('/api/integrations/email', require('./email-service')(supabase, logger))
 * Remove: delete this file + remove the line above = zero breakage
 *
 * ARCHITECTURE BOUNDARY:
 * - Email is a ServiceFlow-native channel powered by SendGrid (NOT Sigcore)
 * - This module is fully independent of Sigcore
 * - It writes directly into ServiceFlow communication tables
 * - It must NOT call Sigcore APIs, reuse Sigcore providers, or depend on Sigcore message models
 *
 * Conversations use the same unified tables with provider='sendgrid', channel='email'.
 * Multiple sender addresses tracked via communication_provider_accounts.
 */

const express = require('express')
const axios = require('axios')
const multer = require('multer')
const sgMail = require('@sendgrid/mail')
const crypto = require('crypto')

const upload = multer() // memory storage for inbound parse

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
    } catch (e) {
      return res.status(401).json({ error: 'Invalid token' })
    }
  }

  // ══════════════════════════════════════
  // Helpers
  // ══════════════════════════════════════

  /** Extract email address from "Name <email>" format */
  function parseEmailAddress(raw) {
    if (!raw) return null
    const match = raw.match(/<([^>]+)>/)
    return (match ? match[1] : raw).trim().toLowerCase()
  }

  /** Extract display name from "Name <email>" format */
  function parseDisplayName(raw) {
    if (!raw) return null
    const match = raw.match(/^([^<]+)</)
    return match ? match[1].trim().replace(/^["']|["']$/g, '') : null
  }

  /** Parse email headers string into key-value map */
  function parseHeaders(headersStr) {
    if (!headersStr) return {}
    const headers = {}
    const lines = headersStr.replace(/\r\n\s+/g, ' ').split(/\r?\n/)
    for (const line of lines) {
      const idx = line.indexOf(':')
      if (idx > 0) {
        const key = line.substring(0, idx).trim().toLowerCase()
        const val = line.substring(idx + 1).trim()
        headers[key] = val
      }
    }
    return headers
  }

  /** Generate a unique Message-ID for outbound emails */
  function generateMessageId(domain) {
    const id = crypto.randomBytes(16).toString('hex')
    return `<${id}@${domain || 'serviceflow.email'}>`
  }

  /** Extract domain from email address */
  function getDomain(email) {
    if (!email) return 'serviceflow.email'
    const parts = email.split('@')
    return parts[1] || 'serviceflow.email'
  }

  // ══════════════════════════════════════
  // GET /status — Email connection status
  // ══════════════════════════════════════
  router.get('/status', authenticateToken, async (req, res) => {
    try {
      const userId = req.user.userId
      const { data: settings } = await supabase.from('communication_settings')
        .select('email_connected, email_connected_at')
        .eq('user_id', userId).maybeSingle()

      if (!settings?.email_connected) {
        return res.json({ connected: false, senderEmails: [] })
      }

      // Get connected sender accounts
      const { data: accounts } = await supabase.from('communication_provider_accounts')
        .select('id, account_email, display_name, status, created_at')
        .eq('user_id', userId).eq('provider', 'sendgrid').eq('channel', 'email').eq('status', 'active')
        .order('created_at', { ascending: true })

      return res.json({
        connected: true,
        connectedAt: settings.email_connected_at,
        senderEmails: (accounts || []).map(a => ({
          id: a.id,
          email: a.account_email,
          displayName: a.display_name,
        })),
      })
    } catch (error) {
      logger.error('[Email Status] Error:', error.message)
      res.status(500).json({ error: 'Failed to get email status' })
    }
  })

  // ══════════════════════════════════════
  // POST /connect — Store SendGrid API key + first sender
  // ══════════════════════════════════════
  router.post('/connect', authenticateToken, async (req, res) => {
    try {
      const userId = req.user.userId
      const { apiKey, senderEmail, senderName } = req.body
      if (!apiKey?.trim()) return res.status(400).json({ error: 'SendGrid API key is required' })
      if (!senderEmail?.trim()) return res.status(400).json({ error: 'Sender email is required' })

      // Verify the API key by calling SendGrid profile endpoint
      try {
        await axios.get('https://api.sendgrid.com/v3/user/profile', {
          headers: { Authorization: `Bearer ${apiKey.trim()}` },
          timeout: 10000,
        })
      } catch (e) {
        const status = e.response?.status
        if (status === 401 || status === 403) {
          return res.status(400).json({ error: 'Invalid SendGrid API key' })
        }
        logger.error('[Email Connect] SendGrid verify failed:', e.message)
        return res.status(400).json({ error: 'Failed to verify SendGrid API key' })
      }

      const normalizedEmail = senderEmail.trim().toLowerCase()

      // Upsert communication_settings
      const { data: existing } = await supabase.from('communication_settings')
        .select('id').eq('user_id', userId).maybeSingle()

      if (existing) {
        await supabase.from('communication_settings').update({
          email_connected: true,
          sendgrid_api_key: apiKey.trim(),
          email_connected_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }).eq('user_id', userId)
      } else {
        await supabase.from('communication_settings').insert({
          user_id: userId,
          email_connected: true,
          sendgrid_api_key: apiKey.trim(),
          email_connected_at: new Date().toISOString(),
        })
      }

      // Create provider account for the first sender
      const accountResult = await createSenderAccount(userId, normalizedEmail, senderName?.trim() || null)
      if (accountResult.error) {
        return res.status(400).json({ error: accountResult.error })
      }

      logger.log(`[Email Connect] User ${userId} connected SendGrid with sender: ${normalizedEmail}`)
      return res.json({
        connected: true,
        sender: { id: accountResult.id, email: normalizedEmail, displayName: senderName?.trim() || null },
      })
    } catch (error) {
      logger.error('[Email Connect] Error:', error.message)
      res.status(500).json({ error: 'Failed to connect email' })
    }
  })

  // ══════════════════════════════════════
  // POST /add-sender — Add another sender email address
  // ══════════════════════════════════════
  router.post('/add-sender', authenticateToken, async (req, res) => {
    try {
      const userId = req.user.userId
      const { senderEmail, senderName } = req.body
      if (!senderEmail?.trim()) return res.status(400).json({ error: 'Sender email is required' })

      // Verify email is connected
      const { data: settings } = await supabase.from('communication_settings')
        .select('email_connected, sendgrid_api_key').eq('user_id', userId).maybeSingle()
      if (!settings?.email_connected || !settings?.sendgrid_api_key) {
        return res.status(400).json({ error: 'SendGrid not connected. Connect first.' })
      }

      const normalizedEmail = senderEmail.trim().toLowerCase()
      const accountResult = await createSenderAccount(userId, normalizedEmail, senderName?.trim() || null)
      if (accountResult.error) {
        return res.status(400).json({ error: accountResult.error })
      }

      logger.log(`[Email AddSender] User ${userId} added sender: ${normalizedEmail}`)
      return res.json({
        sender: { id: accountResult.id, email: normalizedEmail, displayName: senderName?.trim() || null },
      })
    } catch (error) {
      logger.error('[Email AddSender] Error:', error.message)
      res.status(500).json({ error: 'Failed to add sender' })
    }
  })

  /** Create provider account + endpoint route for a sender email */
  async function createSenderAccount(userId, email, displayName) {
    // Check for existing active account
    const { data: existingAccount } = await supabase.from('communication_provider_accounts')
      .select('id').eq('user_id', userId).eq('provider', 'sendgrid').eq('channel', 'email')
      .eq('external_account_id', email).eq('status', 'active').maybeSingle()

    if (existingAccount) {
      return { error: `Sender ${email} is already connected` }
    }

    // Create provider account
    const { data: account, error: accErr } = await supabase.from('communication_provider_accounts').insert({
      user_id: userId,
      provider: 'sendgrid',
      channel: 'email',
      external_account_id: email,
      display_name: displayName || email,
      account_email: email,
      status: 'active',
      webhook_status: 'active',
    }).select('id').single()

    if (accErr) {
      logger.error('[Email CreateSender] Account insert error:', accErr.message)
      return { error: 'Failed to create sender account' }
    }

    // Create endpoint route for this sender
    await supabase.from('communication_endpoint_routes').insert({
      provider: 'sendgrid',
      endpoint_id: email,
      channel: 'email',
      role: 'sendgrid_verified_sender',
      is_active: true,
      route_source: 'auto_connect',
      activated_at: new Date().toISOString(),
      metadata: { provider_account_id: account.id },
    }).catch(e => logger.error('[Email CreateSender] Route insert error:', e.message))

    return { id: account.id }
  }

  // ══════════════════════════════════════
  // DELETE /remove-sender/:accountId — Remove a sender email
  // ══════════════════════════════════════
  router.delete('/remove-sender/:accountId', authenticateToken, async (req, res) => {
    try {
      const userId = req.user.userId
      const { accountId } = req.params

      const { data: account } = await supabase.from('communication_provider_accounts')
        .select('id, account_email').eq('id', accountId).eq('user_id', userId).eq('provider', 'sendgrid').maybeSingle()
      if (!account) return res.status(404).json({ error: 'Sender not found' })

      // Deactivate account
      await supabase.from('communication_provider_accounts').update({
        status: 'disconnected', updated_at: new Date().toISOString(),
      }).eq('id', accountId)

      // Deactivate endpoint route
      await supabase.from('communication_endpoint_routes').update({
        is_active: false, deactivated_at: new Date().toISOString(),
      }).eq('provider', 'sendgrid').eq('endpoint_id', account.account_email).eq('channel', 'email')

      logger.log(`[Email RemoveSender] User ${userId} removed sender: ${account.account_email}`)
      return res.json({ success: true })
    } catch (error) {
      logger.error('[Email RemoveSender] Error:', error.message)
      res.status(500).json({ error: 'Failed to remove sender' })
    }
  })

  // ══════════════════════════════════════
  // DELETE /disconnect — Disconnect SendGrid entirely
  // ══════════════════════════════════════
  router.delete('/disconnect', authenticateToken, async (req, res) => {
    try {
      const userId = req.user.userId

      // Deactivate all sender accounts
      await supabase.from('communication_provider_accounts').update({
        status: 'disconnected', updated_at: new Date().toISOString(),
      }).eq('user_id', userId).eq('provider', 'sendgrid')

      // Deactivate all email endpoint routes
      const { data: accounts } = await supabase.from('communication_provider_accounts')
        .select('account_email').eq('user_id', userId).eq('provider', 'sendgrid')
      if (accounts?.length) {
        for (const acc of accounts) {
          await supabase.from('communication_endpoint_routes').update({
            is_active: false, deactivated_at: new Date().toISOString(),
          }).eq('provider', 'sendgrid').eq('endpoint_id', acc.account_email).eq('channel', 'email')
        }
      }

      // Clear settings
      await supabase.from('communication_settings').update({
        email_connected: false,
        sendgrid_api_key: null,
        email_connected_at: null,
        updated_at: new Date().toISOString(),
      }).eq('user_id', userId)

      logger.log(`[Email Disconnect] User ${userId} disconnected SendGrid`)
      return res.json({ success: true })
    } catch (error) {
      logger.error('[Email Disconnect] Error:', error.message)
      res.status(500).json({ error: 'Failed to disconnect email' })
    }
  })

  // ══════════════════════════════════════
  // POST /webhook/inbound — SendGrid Inbound Parse
  // ══════════════════════════════════════
  // NO JWT — secured via Basic Auth configured in SendGrid Inbound Parse settings
  // SendGrid sends multipart/form-data with: from, to, subject, text, html, headers, envelope, etc.
  router.post('/webhook/inbound', upload.none(), async (req, res) => {
    try {
      // Immediately respond to prevent SendGrid retries
      res.status(200).send('OK')

      const { from, to, subject, text, html, headers: headersStr, envelope: envelopeStr } = req.body || {}

      // Parse envelope for actual from/to
      let envelope = {}
      try { envelope = typeof envelopeStr === 'string' ? JSON.parse(envelopeStr) : (envelopeStr || {}) } catch (e) { /* ignore */ }

      const fromEmail = parseEmailAddress(envelope.from || from)
      const toEmail = parseEmailAddress(envelope.to?.[0] || to)
      const fromName = parseDisplayName(from) || fromEmail

      if (!fromEmail || !toEmail) {
        logger.error('[Email Inbound] Missing from/to:', { from, to })
        return
      }

      // Parse RFC 2822 headers for threading
      const parsedHeaders = parseHeaders(headersStr)
      const messageId = parsedHeaders['message-id'] || null
      const inReplyTo = parsedHeaders['in-reply-to'] || null
      const references = parsedHeaders['references'] || null

      // MESSAGE GUARD: only process if toEmail matches a connected sender (endpoint)
      const { data: route } = await supabase.from('communication_endpoint_routes')
        .select('metadata')
        .eq('provider', 'sendgrid').eq('endpoint_id', toEmail).eq('channel', 'email').eq('is_active', true)
        .maybeSingle()

      if (!route) {
        logger.log(`[Email Inbound] No active route for ${toEmail}, dropping`)
        return
      }

      // Find the provider account to get user_id
      const { data: providerAccount } = await supabase.from('communication_provider_accounts')
        .select('id, user_id')
        .eq('provider', 'sendgrid').eq('channel', 'email').eq('account_email', toEmail).eq('status', 'active')
        .maybeSingle()

      if (!providerAccount) {
        logger.error(`[Email Inbound] No active provider account for ${toEmail}`)
        return
      }

      const userId = providerAccount.user_id

      // ── Thread resolution (3-step) ──
      let conversation = null

      // Step 1: Match by email_thread_id (In-Reply-To or References)
      const threadIds = []
      if (inReplyTo) threadIds.push(inReplyTo.replace(/[<>]/g, ''))
      if (references) {
        references.split(/\s+/).forEach(ref => {
          const cleaned = ref.replace(/[<>]/g, '')
          if (cleaned && !threadIds.includes(cleaned)) threadIds.push(cleaned)
        })
      }

      for (const tid of threadIds) {
        const { data: conv } = await supabase.from('communication_conversations')
          .select('*').eq('user_id', userId).eq('email_thread_id', tid).maybeSingle()
        if (conv) {
          // MESSAGE GUARD: verify endpoint matches
          if (conv.endpoint_email === toEmail) {
            conversation = conv
            break
          }
        }
      }

      // Step 2: Match by identity composite key
      if (!conversation) {
        const { data: conv } = await supabase.from('communication_conversations')
          .select('*')
          .eq('user_id', userId).eq('provider', 'sendgrid')
          .eq('endpoint_email', toEmail).eq('participant_email', fromEmail)
          .maybeSingle()
        if (conv) conversation = conv
      }

      // Step 3: Create new conversation
      if (!conversation) {
        const threadId = messageId ? messageId.replace(/[<>]/g, '') : crypto.randomBytes(8).toString('hex')

        const { data: newConv, error: convErr } = await supabase.from('communication_conversations').insert({
          user_id: userId,
          provider: 'sendgrid',
          channel: 'email',
          participant_email: fromEmail,
          participant_name: fromName,
          endpoint_email: toEmail,
          email_thread_id: threadId,
          last_preview: (subject || text || '').substring(0, 200),
          last_event_at: new Date().toISOString(),
          unread_count: 1,
          is_archived: false,
          is_read: false,
          provider_account_id: providerAccount.id,
          metadata: {},
        }).select().single()

        if (convErr) {
          logger.error('[Email Inbound] Create conversation error:', convErr.message)
          return
        }
        conversation = newConv
      }

      // Set thread ID if not already set
      if (!conversation.email_thread_id && messageId) {
        const threadId = messageId.replace(/[<>]/g, '')
        await supabase.from('communication_conversations').update({ email_thread_id: threadId })
          .eq('id', conversation.id)
      }

      // ── Insert message ──
      const { error: msgErr } = await supabase.from('communication_messages').insert({
        conversation_id: conversation.id,
        direction: 'in',
        channel: 'email',
        body: text || '',
        body_html: html || null,
        from_email: fromEmail,
        to_email: toEmail,
        email_subject: subject || null,
        email_message_id: messageId ? messageId.replace(/[<>]/g, '') : null,
        email_in_reply_to: inReplyTo ? inReplyTo.replace(/[<>]/g, '') : null,
        email_references: references || null,
        sender_role: 'customer',
        status: 'delivered',
        source_system: 'sendgrid',
        created_at: new Date().toISOString(),
      })

      if (msgErr) {
        // Likely duplicate (email_message_id unique index)
        if (msgErr.code === '23505') {
          logger.log(`[Email Inbound] Duplicate message-id, skipping: ${messageId}`)
          return
        }
        logger.error('[Email Inbound] Message insert error:', msgErr.message)
        return
      }

      // Update conversation
      await supabase.from('communication_conversations').update({
        last_preview: (subject || text || '').substring(0, 200),
        last_event_at: new Date().toISOString(),
        unread_count: (conversation.unread_count || 0) + 1,
        is_read: false,
        updated_at: new Date().toISOString(),
      }).eq('id', conversation.id)

      logger.log(`[Email Inbound] ${fromEmail} → ${toEmail}: "${(subject || '').substring(0, 50)}" (conv ${conversation.id})`)
    } catch (error) {
      logger.error('[Email Inbound] Webhook error:', error.message)
      // Already responded 200 above
    }
  })

  // ══════════════════════════════════════
  // Send Email — exported for server.js send endpoint
  // ══════════════════════════════════════
  async function sendEmail(userId, conv, text, subject) {
    // Get SendGrid API key
    const { data: settings } = await supabase.from('communication_settings')
      .select('sendgrid_api_key').eq('user_id', userId).maybeSingle()

    if (!settings?.sendgrid_api_key) {
      throw new Error('SendGrid not connected')
    }

    sgMail.setApiKey(settings.sendgrid_api_key)

    const fromEmail = conv.endpoint_email
    const toEmail = conv.participant_email
    if (!fromEmail || !toEmail) {
      throw new Error('Missing sender or recipient email')
    }

    // Get sender display name from provider account
    const { data: senderAccount } = await supabase.from('communication_provider_accounts')
      .select('display_name').eq('provider', 'sendgrid').eq('account_email', fromEmail).eq('status', 'active')
      .maybeSingle()

    // Resolve subject for replies
    let emailSubject = subject || ''
    if (!emailSubject) {
      // Try to get subject from last message in thread
      const { data: lastMsg } = await supabase.from('communication_messages')
        .select('email_subject').eq('conversation_id', conv.id)
        .not('email_subject', 'is', null)
        .order('created_at', { ascending: false }).limit(1).maybeSingle()
      if (lastMsg?.email_subject) {
        emailSubject = lastMsg.email_subject.startsWith('Re: ')
          ? lastMsg.email_subject
          : `Re: ${lastMsg.email_subject}`
      }
    }
    if (!emailSubject) emailSubject = '(No subject)'

    // Build threading headers
    const outboundMessageId = generateMessageId(getDomain(fromEmail))
    const headers = {}
    if (conv.email_thread_id) {
      headers['In-Reply-To'] = `<${conv.email_thread_id}>`
      // Get references chain from last outbound/inbound message
      const { data: lastRef } = await supabase.from('communication_messages')
        .select('email_message_id, email_references')
        .eq('conversation_id', conv.id)
        .not('email_message_id', 'is', null)
        .order('created_at', { ascending: false }).limit(1).maybeSingle()
      if (lastRef) {
        const refChain = lastRef.email_references
          ? `${lastRef.email_references} <${lastRef.email_message_id}>`
          : `<${conv.email_thread_id}>`
        headers['References'] = refChain
      }
    }

    // Send via SendGrid
    const msg = {
      to: toEmail,
      from: {
        email: fromEmail,
        name: senderAccount?.display_name || fromEmail,
      },
      subject: emailSubject,
      text: text,
      html: `<p>${text.replace(/\n/g, '<br>')}</p>`,
      headers: {
        ...headers,
        'Message-ID': outboundMessageId,
      },
    }

    await sgMail.send(msg)

    // Set thread ID if this is the first message
    const cleanMessageId = outboundMessageId.replace(/[<>]/g, '')
    if (!conv.email_thread_id) {
      await supabase.from('communication_conversations').update({
        email_thread_id: cleanMessageId,
      }).eq('id', conv.id)
    }

    // Insert local message copy
    const { data: localMsg } = await supabase.from('communication_messages').insert({
      conversation_id: conv.id,
      direction: 'out',
      channel: 'email',
      body: text,
      body_html: `<p>${text.replace(/\n/g, '<br>')}</p>`,
      from_email: fromEmail,
      to_email: toEmail,
      email_subject: emailSubject,
      email_message_id: cleanMessageId,
      email_in_reply_to: conv.email_thread_id || null,
      email_references: headers['References'] || null,
      sender_role: 'agent',
      status: 'sent',
      source_system: 'sendgrid',
      created_at: new Date().toISOString(),
    }).select().single()

    // Update conversation
    await supabase.from('communication_conversations').update({
      last_preview: text.substring(0, 200),
      last_event_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).eq('id', conv.id)

    return {
      id: localMsg?.id,
      conversationId: conv.id,
      channel: 'email',
      text: text,
      subject: emailSubject,
      status: 'sent',
      timestamp: new Date().toISOString(),
    }
  }

  // Expose sendEmail for server.js to call from the unified send endpoint
  router.sendEmail = sendEmail

  return router
}
