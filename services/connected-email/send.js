/**
 * Send / reply outbound email via the connected provider that owns a conversation.
 *
 * Mailbox routing rule: always resolve the mailbox by conversation.endpoint_email,
 * never by "user's primary". Multi-mailbox safe.
 */

const { getProvider } = require('./providers')
const store = require('./account-store')
const { normalizeEmail, buildReplyHeaders, makeReplySubject } = require('./email-utils')
const { resolveConversation } = require('./conversation-identity')

async function sendFromConversation(supabase, logger, { conversationId, userId, text, html, subject }) {
  const { data: conv, error: cErr } = await supabase
    .from('communication_conversations')
    .select('*')
    .eq('id', conversationId)
    .eq('user_id', userId)
    .maybeSingle()
  if (cErr) throw cErr
  if (!conv) throw new Error('conversation not found')
  if (conv.channel !== 'email') throw new Error('not an email conversation')

  const endpointEmail = normalizeEmail(conv.endpoint_email)
  const participantEmail = normalizeEmail(conv.participant_email)
  if (!endpointEmail || !participantEmail) throw new Error('missing endpoint_email or participant_email')

  // Resolve mailbox by endpoint_email (never by user primary).
  const { data: accountRow } = await supabase
    .from('connected_email_accounts')
    .select('id')
    .eq('user_id', userId)
    .eq('provider', conv.provider)
    .eq('email_address', endpointEmail)
    .eq('status', 'connected')
    .maybeSingle()
  if (!accountRow?.id) throw new Error('no connected mailbox for this conversation endpoint')

  const account = await store.getWithTokens(supabase, accountRow.id)
  const provider = getProvider(account.provider)

  // Get last message for reply headers.
  const { data: lastMsg } = await supabase
    .from('communication_messages')
    .select('email_message_id, email_references, email_subject')
    .eq('conversation_id', conversationId)
    .eq('channel', 'email')
    .order('sent_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  const { inReplyTo, references } = buildReplyHeaders({
    parentMessageId: lastMsg?.email_message_id,
    parentReferences: lastMsg?.email_references,
  })
  const finalSubject = subject || makeReplySubject(lastMsg?.email_subject || conv.email_subject)

  // Delegated: target_mailbox_email is the actual mailbox we send from.
  const sendFrom = (account.target_mailbox_email || account.email_address).toLowerCase()
  const targetMailbox = account.mailbox_type === 'shared' ? sendFrom : null

  const sent = await provider.sendMessage(
    { accessToken: account.accessToken, refreshToken: account.refreshToken },
    {
      from: sendFrom,
      to: participantEmail,
      subject: finalSubject,
      bodyText: text || null,
      bodyHtml: html || null,
      inReplyTo,
      references,
      threadId: conv.email_thread_id || null,
      targetMailbox,
    }
  )

  // Persist outbound row immediately (don't wait for sync cycle).
  const row = {
    conversation_id: conversationId,
    provider: account.provider,
    channel: 'email',
    direction: 'outbound',
    from_email: sendFrom,
    to_email: participantEmail,
    email_subject: finalSubject,
    body: text || '',
    body_text: text || null,
    body_html: html || null,
    email_message_id: sent?.messageId || null,
    email_in_reply_to: inReplyTo,
    email_references: references,
    external_message_id: sent?.id || null,
    sender_role: 'agent',
    status: 'sent',
    source_system: account.provider,
    sent_at: new Date().toISOString(),
    metadata: { thread_id: sent?.threadId || conv.email_thread_id || null },
    created_at: new Date().toISOString(),
  }
  const { data: inserted, error: iErr } = await supabase
    .from('communication_messages')
    .insert(row)
    .select('*')
    .single()
  if (iErr && !/duplicate key/i.test(iErr.message)) throw iErr

  // Update conversation if new thread id learned from send.
  const patch = {
    last_event_at: row.sent_at,
    last_preview: (text || finalSubject || '').slice(0, 200),
    updated_at: new Date().toISOString(),
  }
  if (sent?.threadId && !conv.email_thread_id) patch.email_thread_id = sent.threadId
  await supabase.from('communication_conversations').update(patch).eq('id', conversationId)

  return inserted || row
}

module.exports = { sendFromConversation }
