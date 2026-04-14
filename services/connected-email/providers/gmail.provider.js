/**
 * Gmail provider adapter — wraps googleapis.
 *
 * Uses OAuth2 web flow. Reads: gmail.readonly. Sends: gmail.send.
 * Token storage is handled by the caller (account-store.js); this adapter only
 * accepts/returns plaintext tokens.
 */

const { google } = require('googleapis')

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
]

function makeOAuth2(redirectUri) {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID || process.env.GOOGLE_CLIENT_ID
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET
  return new google.auth.OAuth2(clientId, clientSecret, redirectUri)
}

function buildAuthUrl({ redirectUri, state }) {
  const oauth = makeOAuth2(redirectUri)
  return oauth.generateAuthUrl({
    access_type: 'offline',
    prompt: 'select_account consent', // force account chooser + refresh_token
    scope: SCOPES,
    state,
    include_granted_scopes: false,
  })
}

async function exchangeCode({ redirectUri, code }) {
  const oauth = makeOAuth2(redirectUri)
  const { tokens } = await oauth.getToken(code)
  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
    scopes: (tokens.scope || '').split(/\s+/).filter(Boolean),
  }
}

async function refreshToken({ refreshToken: rt }) {
  const oauth = makeOAuth2()
  oauth.setCredentials({ refresh_token: rt })
  const { credentials } = await oauth.refreshAccessToken()
  return {
    accessToken: credentials.access_token,
    refreshToken: credentials.refresh_token || rt,
    expiresAt: credentials.expiry_date ? new Date(credentials.expiry_date) : null,
  }
}

function client({ accessToken, refreshToken: rt }) {
  const oauth = makeOAuth2()
  oauth.setCredentials({ access_token: accessToken, refresh_token: rt })
  return google.gmail({ version: 'v1', auth: oauth })
}

async function getProfile(tokens) {
  const gmail = client(tokens)
  const { data } = await gmail.users.getProfile({ userId: 'me' })
  return {
    emailAddress: data.emailAddress,
    historyId: data.historyId,
    displayName: null,
  }
}

async function listRecentMessages(tokens, { maxResults = 200, afterEpoch } = {}) {
  const gmail = client(tokens)
  // Only sync the main inbox — ignore spam, trash, drafts, promotions, social.
  const baseFilter = 'in:inbox -in:spam -in:trash -in:drafts -category:promotions -category:social'
  const q = afterEpoch ? `${baseFilter} after:${afterEpoch}` : baseFilter
  const ids = []
  let pageToken
  do {
    const { data } = await gmail.users.messages.list({
      userId: 'me', q, maxResults: Math.min(100, maxResults - ids.length), pageToken,
    })
    if (data.messages) ids.push(...data.messages.map(m => m.id))
    pageToken = data.nextPageToken
    if (ids.length >= maxResults) break
  } while (pageToken)
  return ids
}

async function listHistory(tokens, startHistoryId) {
  const gmail = client(tokens)
  const { data } = await gmail.users.history.list({
    userId: 'me',
    startHistoryId,
    historyTypes: ['messageAdded'],
  })
  const ids = []
  if (data.history) {
    for (const h of data.history) {
      if (h.messagesAdded) for (const ma of h.messagesAdded) ids.push(ma.message.id)
    }
  }
  return { messageIds: ids, historyId: data.historyId }
}

async function getMessage(tokens, id) {
  const gmail = client(tokens)
  const { data } = await gmail.users.messages.get({
    userId: 'me', id, format: 'full',
  })
  return parseMessage(data)
}

function parseMessage(data) {
  const headers = {}
  const hArr = data.payload?.headers || []
  for (const h of hArr) headers[h.name.toLowerCase()] = h.value
  const { bodyHtml, bodyText } = extractBody(data.payload)
  return {
    id: data.id,
    threadId: data.threadId,
    messageId: headers['message-id'] || null,
    inReplyTo: headers['in-reply-to'] || null,
    references: headers['references'] || null,
    subject: headers['subject'] || null,
    from: headers['from'] || null,
    to: headers['to'] || null,
    cc: headers['cc'] || null,
    bcc: headers['bcc'] || null,
    date: headers['date'] ? new Date(headers['date']) : new Date(Number(data.internalDate || 0)),
    snippet: data.snippet,
    bodyHtml,
    bodyText,
    labelIds: data.labelIds || [],
    isSent: (data.labelIds || []).includes('SENT'),
  }
}

function extractBody(part) {
  if (!part) return { bodyHtml: null, bodyText: null }
  let html = null, text = null
  function walk(p) {
    if (!p) return
    if (p.body && p.body.data) {
      const decoded = Buffer.from(p.body.data, 'base64').toString('utf8')
      if (p.mimeType === 'text/html' && !html) html = decoded
      else if (p.mimeType === 'text/plain' && !text) text = decoded
    }
    if (p.parts) for (const sub of p.parts) walk(sub)
  }
  walk(part)
  return { bodyHtml: html, bodyText: text }
}

async function sendMessage(tokens, { from, to, subject, bodyText, bodyHtml, inReplyTo, references, threadId }) {
  const gmail = client(tokens)
  const boundary = '=_sfbnd_' + Math.random().toString(36).slice(2)
  const headers = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject || ''}`,
    'MIME-Version: 1.0',
  ]
  if (inReplyTo) headers.push(`In-Reply-To: ${inReplyTo}`)
  if (references) headers.push(`References: ${references}`)

  let raw
  if (bodyHtml && bodyText) {
    headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`)
    raw = headers.join('\r\n') + '\r\n\r\n' +
      `--${boundary}\r\nContent-Type: text/plain; charset="UTF-8"\r\n\r\n${bodyText}\r\n\r\n` +
      `--${boundary}\r\nContent-Type: text/html; charset="UTF-8"\r\n\r\n${bodyHtml}\r\n\r\n` +
      `--${boundary}--`
  } else if (bodyHtml) {
    headers.push('Content-Type: text/html; charset="UTF-8"')
    raw = headers.join('\r\n') + '\r\n\r\n' + bodyHtml
  } else {
    headers.push('Content-Type: text/plain; charset="UTF-8"')
    raw = headers.join('\r\n') + '\r\n\r\n' + (bodyText || '')
  }

  const encoded = Buffer.from(raw).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  const requestBody = { raw: encoded }
  if (threadId) requestBody.threadId = threadId
  const { data } = await gmail.users.messages.send({ userId: 'me', requestBody })
  const full = await getMessage(tokens, data.id)
  return full
}

async function revoke(tokens) {
  const oauth = makeOAuth2()
  try {
    await oauth.revokeToken(tokens.refreshToken || tokens.accessToken)
  } catch (e) {
    // Non-fatal; caller still marks disconnected.
  }
}

module.exports = {
  name: 'gmail',
  SCOPES,
  buildAuthUrl,
  exchangeCode,
  refreshToken,
  getProfile,
  listRecentMessages,
  listHistory,
  getMessage,
  sendMessage,
  revoke,
  // test exports
  parseMessage,
  extractBody,
}
