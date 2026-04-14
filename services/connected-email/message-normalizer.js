/**
 * Message normalizer + Phase 6 guard.
 *
 * Converts a provider-native message (from Gmail/Outlook adapter) into a
 * communication_messages row, and enforces mailbox ownership:
 *   - Outbound: mailbox owner email must BE the (normalized) sender
 *   - Inbound:  mailbox owner email must be IN the (normalized) recipient list
 * Resolved values only — no raw string comparison.
 */

const { normalizeEmail, normalizeEmailList } = require('./email-utils')

const GUARD_OK = 'ok'
const GUARD_REJECT_NO_OWNER_MATCH = 'reject_no_owner_match'
const GUARD_REJECT_AMBIGUOUS_DIRECTION = 'reject_ambiguous_direction'

/**
 * @param {object} args
 * @param {object} args.providerMsg  - output of provider.getMessage()
 * @param {string} args.mailboxOwnerEmail - from connected_email_accounts.email_address
 * @returns {{ok: boolean, reason: string, row: object|null, participantEmail: string|null}}
 */
function normalize({ providerMsg, mailboxOwnerEmail }) {
  const ownerNorm = normalizeEmail(mailboxOwnerEmail)
  if (!ownerNorm) {
    return { ok: false, reason: GUARD_REJECT_NO_OWNER_MATCH, row: null, participantEmail: null }
  }

  const from = normalizeEmail(providerMsg.from)
  const toList = normalizeEmailList(providerMsg.to)
  const ccList = normalizeEmailList(providerMsg.cc)
  const bccList = normalizeEmailList(providerMsg.bcc)
  const recipients = [...toList, ...ccList, ...bccList]

  const ownerIsSender = from === ownerNorm
  const ownerIsRecipient = recipients.includes(ownerNorm)

  // Resolve direction from provider hint first, then from headers.
  let direction
  if (providerMsg.isSent === true) direction = 'outbound'
  else if (ownerIsSender && !ownerIsRecipient) direction = 'outbound'
  else if (ownerIsRecipient && !ownerIsSender) direction = 'inbound'
  else if (ownerIsSender && ownerIsRecipient) direction = 'outbound' // self-send → outbound
  else {
    return { ok: false, reason: GUARD_REJECT_NO_OWNER_MATCH, row: null, participantEmail: null }
  }

  // Phase 6 guard on resolved values.
  if (direction === 'outbound' && !ownerIsSender) {
    return { ok: false, reason: GUARD_REJECT_NO_OWNER_MATCH, row: null, participantEmail: null }
  }
  if (direction === 'inbound' && !ownerIsRecipient) {
    return { ok: false, reason: GUARD_REJECT_NO_OWNER_MATCH, row: null, participantEmail: null }
  }

  // Participant = the other side (customer).
  let participantEmail
  if (direction === 'inbound') {
    participantEmail = from
  } else {
    participantEmail = toList[0] || ccList[0] || bccList[0] || null
  }

  // Build communication_messages row (conversation_id + provider_* filled by caller).
  const row = {
    provider: null, // set by caller
    channel: 'email',
    direction,
    from_email: from,
    to_email: toList.join(', ') || null,
    email_subject: providerMsg.subject || null,
    body_html: providerMsg.bodyHtml || null,
    body_text: providerMsg.bodyText || providerMsg.snippet || null,
    body: providerMsg.snippet || providerMsg.bodyText || '',
    email_message_id: providerMsg.messageId || null,
    email_in_reply_to: providerMsg.inReplyTo || null,
    email_references: providerMsg.references || null,
    external_message_id: providerMsg.id || null,
    sent_at: providerMsg.date || null,
    sender_role: direction === 'inbound' ? 'customer' : 'agent',
    status: 'delivered',
    source_system: null, // set by caller
    metadata: {
      thread_id: providerMsg.threadId || null,
      labels: providerMsg.labelIds || [],
    },
  }

  return { ok: true, reason: GUARD_OK, row, participantEmail, direction }
}

module.exports = {
  normalize,
  GUARD_OK,
  GUARD_REJECT_NO_OWNER_MATCH,
  GUARD_REJECT_AMBIGUOUS_DIRECTION,
}
