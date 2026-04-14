/**
 * Conversation identity resolver for connected email.
 *
 * Identity rule (MANDATORY):
 *   user_id + provider + endpoint_email + participant_email [+ thread_id when available]
 *
 * Same participant across different endpoint mailboxes => separate conversations.
 */

const { normalizeEmail } = require('./email-utils')

function buildConversationQuery(supabase, { userId, provider, endpointEmail, participantEmail, threadId }) {
  let q = supabase
    .from('communication_conversations')
    .select('*')
    .eq('user_id', userId)
    .eq('channel', 'email')
    .eq('provider', provider)
    .eq('endpoint_email', endpointEmail)
    .eq('participant_email', participantEmail)
  if (threadId) q = q.eq('email_thread_id', threadId)
  return q
}

/**
 * Find or create the email conversation. Returns { conversationId, isNew }.
 */
async function resolveConversation(supabase, { userId, provider, endpointEmail, participantEmail, threadId, participantName, subject, lastPreview, lastEventAt }) {
  const endpoint = normalizeEmail(endpointEmail)
  const participant = normalizeEmail(participantEmail)
  if (!endpoint || !participant) {
    throw new Error('resolveConversation: endpointEmail and participantEmail are required')
  }

  // Prefer thread match when available.
  if (threadId) {
    const { data: threadMatch } = await supabase
      .from('communication_conversations')
      .select('id')
      .eq('user_id', userId)
      .eq('channel', 'email')
      .eq('provider', provider)
      .eq('endpoint_email', endpoint)
      .eq('participant_email', participant)
      .eq('email_thread_id', threadId)
      .limit(1)
      .maybeSingle()
    if (threadMatch?.id) return { conversationId: threadMatch.id, isNew: false }
  }

  // Fallback: participant-based match within the same endpoint (no thread id yet).
  const { data: partMatch } = await supabase
    .from('communication_conversations')
    .select('id, email_thread_id')
    .eq('user_id', userId)
    .eq('channel', 'email')
    .eq('provider', provider)
    .eq('endpoint_email', endpoint)
    .eq('participant_email', participant)
    .is('email_thread_id', null)
    .limit(1)
    .maybeSingle()

  if (partMatch?.id) {
    if (threadId) {
      await supabase
        .from('communication_conversations')
        .update({ email_thread_id: threadId, updated_at: new Date().toISOString() })
        .eq('id', partMatch.id)
    }
    return { conversationId: partMatch.id, isNew: false }
  }

  // Create.
  const row = {
    user_id: userId,
    provider,
    channel: 'email',
    endpoint_email: endpoint,
    participant_email: participant,
    email_thread_id: threadId || null,
    participant_name: participantName || null,
    conversation_type: 'email',
    last_preview: lastPreview || (subject ? `Subject: ${subject}` : null),
    last_event_at: lastEventAt || new Date().toISOString(),
    unread_count: 0,
    is_archived: false,
    is_read: true,
  }
  const { data: created, error } = await supabase
    .from('communication_conversations')
    .insert(row)
    .select('id')
    .single()
  if (error) throw error
  return { conversationId: created.id, isNew: true }
}

module.exports = { resolveConversation, buildConversationQuery }
