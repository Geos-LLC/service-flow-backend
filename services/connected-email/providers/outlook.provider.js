/**
 * Outlook / Microsoft 365 provider adapter — Microsoft Graph over direct HTTPS.
 *
 * Supports both:
 *   - Primary mailbox: /me/... (signed-in user's own mailbox)
 *   - Delegated shared mailbox: /users/{target@email}/... (the user has Full Access)
 *
 * All mailbox-specific functions accept an optional `targetMailbox` param.
 * When null/undefined → /me (backward compatible, primary mailbox).
 * When a string email → /users/{email} (delegated shared mailbox).
 */

const axios = require('axios')

const AUTHORITY = process.env.MS_OAUTH_AUTHORITY || 'https://login.microsoftonline.com/common'
const SCOPES = [
  'https://graph.microsoft.com/Mail.Read',
  'https://graph.microsoft.com/Mail.Send',
  'https://graph.microsoft.com/Mail.ReadShared',
  'https://graph.microsoft.com/Mail.Send.Shared',
  'offline_access',
  'openid',
  'email',
  'profile',
]

/** Build the Graph path prefix. Primary → /me, delegated → /users/{email} */
function mailboxPrefix(targetMailbox) {
  if (!targetMailbox) return '/me'
  return `/users/${encodeURIComponent(targetMailbox)}`
}

function buildAuthUrl({ redirectUri, state }) {
  const params = new URLSearchParams({
    client_id: process.env.MS_OAUTH_CLIENT_ID || '',
    response_type: 'code',
    redirect_uri: redirectUri,
    response_mode: 'query',
    scope: SCOPES.join(' '),
    state,
    prompt: 'select_account',
  })
  return `${AUTHORITY}/oauth2/v2.0/authorize?${params.toString()}`
}

async function exchangeCode({ redirectUri, code }) {
  const resp = await axios.post(
    `${AUTHORITY}/oauth2/v2.0/token`,
    new URLSearchParams({
      client_id: process.env.MS_OAUTH_CLIENT_ID || '',
      client_secret: process.env.MS_OAUTH_CLIENT_SECRET || '',
      code,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
      scope: SCOPES.join(' '),
    }).toString(),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  )
  const t = resp.data
  return {
    accessToken: t.access_token,
    refreshToken: t.refresh_token,
    expiresAt: new Date(Date.now() + (t.expires_in || 3600) * 1000),
    scopes: (t.scope || '').split(/\s+/).filter(Boolean),
  }
}

async function refreshToken({ refreshToken: rt }) {
  const resp = await axios.post(
    `${AUTHORITY}/oauth2/v2.0/token`,
    new URLSearchParams({
      client_id: process.env.MS_OAUTH_CLIENT_ID || '',
      client_secret: process.env.MS_OAUTH_CLIENT_SECRET || '',
      refresh_token: rt,
      grant_type: 'refresh_token',
      scope: SCOPES.join(' '),
    }).toString(),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  )
  const t = resp.data
  return {
    accessToken: t.access_token,
    refreshToken: t.refresh_token || rt,
    expiresAt: new Date(Date.now() + (t.expires_in || 3600) * 1000),
  }
}

function graphGet(tokens, path) {
  return axios.get(`https://graph.microsoft.com/v1.0${path}`, {
    headers: { Authorization: `Bearer ${tokens.accessToken}` },
  }).then(r => r.data)
}

function graphPost(tokens, path, body) {
  return axios.post(`https://graph.microsoft.com/v1.0${path}`, body, {
    headers: {
      Authorization: `Bearer ${tokens.accessToken}`,
      'Content-Type': 'application/json',
    },
  }).then(r => r.data)
}

/** Get the signed-in user's identity (always /me). */
async function getProfile(tokens) {
  const me = await graphGet(tokens, '/me')
  return {
    emailAddress: (me.mail || me.userPrincipalName || '').toLowerCase(),
    displayName: me.displayName || null,
    historyId: null,
  }
}

/**
 * Validate that the auth user can access a target shared mailbox.
 * Attempts a lightweight read (1 message) against the target.
 * Returns { accessible: true, displayName } on success, { accessible: false, error } on failure.
 */
async function validateMailboxAccess(tokens, targetMailboxEmail) {
  try {
    const prefix = mailboxPrefix(targetMailboxEmail)
    const data = await graphGet(tokens, `${prefix}/mailFolders/Inbox/messages?$top=1&$select=id`)
    return { accessible: true, messageCount: (data.value || []).length }
  } catch (e) {
    const status = e.response?.status
    const code = e.response?.data?.error?.code
    const msg = e.response?.data?.error?.message || e.message
    return {
      accessible: false,
      error: status === 403 || status === 401 || code === 'ErrorAccessDenied'
        ? `Access denied to ${targetMailboxEmail}. The signed-in user needs "Full Access" permission on this shared mailbox in Exchange admin.`
        : `Cannot access ${targetMailboxEmail}: ${msg}`,
    }
  }
}

async function listRecentMessages(tokens, { maxResults = 200, afterDate, targetMailbox } = {}) {
  const filter = afterDate
    ? `&$filter=receivedDateTime ge ${new Date(afterDate).toISOString()}`
    : ''
  const top = Math.min(maxResults, 200)
  const prefix = mailboxPrefix(targetMailbox)
  const data = await graphGet(
    tokens,
    `${prefix}/mailFolders/Inbox/messages?$top=${top}&$select=id${filter}&$orderby=receivedDateTime desc`
  )
  return (data.value || []).map(m => m.id)
}

async function listHistory(tokens, deltaLink, { targetMailbox } = {}) {
  const prefix = mailboxPrefix(targetMailbox)
  const url = deltaLink || `${prefix}/mailFolders/Inbox/messages/delta?$select=id`
  const path = url.startsWith('http') ? null : url
  let data
  if (path) {
    data = await graphGet(tokens, path)
  } else {
    data = await axios.get(url, {
      headers: { Authorization: `Bearer ${tokens.accessToken}` },
    }).then(r => r.data)
  }
  const ids = (data.value || []).filter(v => v.id).map(v => v.id)
  return {
    messageIds: ids,
    historyId: data['@odata.deltaLink'] || data['@odata.nextLink'] || deltaLink,
  }
}

async function getMessage(tokens, id, { targetMailbox } = {}) {
  const prefix = mailboxPrefix(targetMailbox)
  const m = await graphGet(tokens, `${prefix}/messages/${id}`)
  return parseMessage(m)
}

function parseMessage(m) {
  const from = m.from?.emailAddress
    ? `${m.from.emailAddress.name || ''} <${m.from.emailAddress.address}>`.trim()
    : null
  const toList = (m.toRecipients || []).map(r => r.emailAddress?.address).filter(Boolean).join(', ')
  const ccList = (m.ccRecipients || []).map(r => r.emailAddress?.address).filter(Boolean).join(', ')
  const bccList = (m.bccRecipients || []).map(r => r.emailAddress?.address).filter(Boolean).join(', ')
  return {
    id: m.id,
    threadId: m.conversationId,
    messageId: m.internetMessageId || null,
    inReplyTo: null,
    references: null,
    subject: m.subject || null,
    from,
    to: toList || null,
    cc: ccList || null,
    bcc: bccList || null,
    date: m.receivedDateTime ? new Date(m.receivedDateTime) : new Date(),
    snippet: m.bodyPreview || '',
    bodyHtml: m.body?.contentType === 'html' ? m.body.content : null,
    bodyText: m.body?.contentType === 'text' ? m.body.content : null,
    labelIds: [],
    isSent: m.parentFolderId && /sent/i.test(m.parentFolderId),
  }
}

async function sendMessage(tokens, { from, to, subject, bodyText, bodyHtml, inReplyTo, references, threadId, targetMailbox }) {
  const message = {
    subject: subject || '',
    body: {
      contentType: bodyHtml ? 'HTML' : 'Text',
      content: bodyHtml || bodyText || '',
    },
    toRecipients: [{ emailAddress: { address: to } }],
  }
  if (inReplyTo) {
    message.internetMessageHeaders = [
      { name: 'In-Reply-To', value: inReplyTo },
      ...(references ? [{ name: 'References', value: references }] : []),
    ]
  }
  const prefix = mailboxPrefix(targetMailbox)
  await graphPost(tokens, `${prefix}/sendMail`, { message, saveToSentItems: true })
  return {
    id: null,
    threadId: threadId || null,
    messageId: null,
    subject,
    from: targetMailbox || from,
    to,
    date: new Date(),
    bodyHtml,
    bodyText,
    isSent: true,
  }
}

async function revoke(tokens) {
  return
}

module.exports = {
  name: 'outlook',
  SCOPES,
  mailboxPrefix,
  buildAuthUrl,
  exchangeCode,
  refreshToken,
  getProfile,
  validateMailboxAccess,
  listRecentMessages,
  listHistory,
  getMessage,
  sendMessage,
  revoke,
  parseMessage,
}
