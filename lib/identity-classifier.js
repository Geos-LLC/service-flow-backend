'use strict';

// AI classifier for floating identities + ambiguities.
//
// Given an identity (or an ambiguity's attempted signal), pulls the last few
// conversation messages and asks an LLM to bucket them:
//   - prospect: legitimate inquiry about services
//   - existing_customer: returning customer / booking question
//   - ad: unsolicited marketing / SEO / loan / services spam
//   - wrong_number: clearly misdirected
//   - unclear: not enough info
//
// Returns { category, confidence, reason, summary, model, cost_usd }.
// The caller decides what to do with the verdict — this module never writes
// to the DB itself.

const DEFAULT_MODEL = 'gpt-4o-mini';

const SYSTEM_PROMPT = `You are classifying conversations from a cleaning services business CRM.

Read the messages and classify into ONE category:
- "prospect": a real person asking about cleaning / house services / quote / availability
- "existing_customer": a returning customer (booking confirmation, reschedule, follow-up, question about past service)
- "ad": unsolicited marketing (SEO services, business loans, crypto, "grow your business", lead-gen services, promo codes)
- "wrong_number": clearly misdirected ("who is this", "wrong person", auto-reply from unrelated service)
- "unclear": not enough info to decide

Respond ONLY with JSON (no markdown, no prose):
{
  "category": "prospect|existing_customer|ad|wrong_number|unclear",
  "confidence": 0-100,
  "reason": "one short sentence why",
  "summary": "one-line summary of what the person texted about (max 80 chars)"
}`;

/**
 * Fetch the last N events across this identity's conversations.
 * Returns an array of { direction, text, at } ordered oldest → newest.
 */
async function fetchRecentEvents(supabase, userId, identityId, maxEvents = 6) {
  // Get conversations for the identity
  const { data: convs } = await supabase.from('communication_conversations')
    .select('id, participant_name, company, channel, last_event_at')
    .eq('user_id', userId).eq('participant_identity_id', identityId)
    .order('last_event_at', { ascending: false }).limit(5);
  if (!convs || convs.length === 0) return { events: [], meta: {} };

  const convIds = convs.map(c => c.id);
  const { data: events } = await supabase.from('communication_events')
    .select('conversation_id, direction, body, created_at')
    .eq('user_id', userId).in('conversation_id', convIds)
    .order('created_at', { ascending: false }).limit(maxEvents);

  const ordered = (events || [])
    .map(e => ({
      direction: e.direction, // 'inbound' | 'outbound'
      text: (e.body || '').trim().slice(0, 500),
      at: e.created_at,
    }))
    .filter(e => e.text)
    .reverse(); // oldest first

  return {
    events: ordered,
    meta: {
      participant_name: convs[0].participant_name || null,
      company: convs[0].company || null,
      channel: convs[0].channel || null,
    },
  };
}

/**
 * Build the user message for the LLM from the fetched events + context.
 */
function buildPrompt(context) {
  const { name, phone, meta, events } = context;
  const header = [
    name ? `Contact name: ${name}` : 'Contact name: (unknown)',
    phone ? `Phone: ${phone}` : '',
    meta?.company ? `OpenPhone Company tag: ${meta.company}` : '',
    meta?.channel ? `Channel: ${meta.channel}` : '',
  ].filter(Boolean).join('\n');

  const conv = events.length === 0
    ? '(no messages available — only a phone match, no text content)'
    : events.map(e => `[${e.direction === 'inbound' ? 'THEM' : 'US'}] ${e.text}`).join('\n');

  return `${header}\n\nConversation (oldest → newest):\n${conv}`;
}

/**
 * Classify an identity with OpenAI. Returns the verdict or throws.
 *
 * @param {object} opts
 * @param {object} opts.openai  — OpenAI SDK client
 * @param {object} opts.supabase
 * @param {number} opts.userId
 * @param {number} opts.identityId
 * @param {string} [opts.model] — OpenAI model (default gpt-4o-mini)
 */
async function classifyIdentity({ openai, supabase, userId, identityId, model = DEFAULT_MODEL }) {
  if (!openai) throw new Error('classifyIdentity: openai client required');
  if (!identityId) throw new Error('classifyIdentity: identityId required');

  const { data: identity } = await supabase.from('communication_participant_identities')
    .select('id, display_name, normalized_phone, normalized_name')
    .eq('id', identityId).eq('user_id', userId).maybeSingle();
  if (!identity) throw new Error('identity not found');

  const { events, meta } = await fetchRecentEvents(supabase, userId, identityId, 6);

  const prompt = buildPrompt({
    name: identity.display_name,
    phone: identity.normalized_phone,
    meta,
    events,
  });

  const resp = await openai.chat.completions.create({
    model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: prompt },
    ],
    temperature: 0.1,
    max_tokens: 200,
    response_format: { type: 'json_object' },
  });

  const choice = resp.choices?.[0];
  if (!choice?.message?.content) throw new Error('empty LLM response');

  let parsed;
  try {
    parsed = JSON.parse(choice.message.content);
  } catch (e) {
    throw new Error('LLM returned non-JSON: ' + choice.message.content.slice(0, 200));
  }

  // Basic validation + defaults.
  const VALID = ['prospect', 'existing_customer', 'ad', 'wrong_number', 'unclear'];
  const category = VALID.includes(parsed.category) ? parsed.category : 'unclear';
  const confidence = Math.max(0, Math.min(100, Number(parsed.confidence) || 0));
  const reason = String(parsed.reason || '').slice(0, 300);
  const summary = String(parsed.summary || '').slice(0, 200);

  // Token + cost tracking (gpt-4o-mini: $0.15/1M input, $0.60/1M output as of late 2025).
  const usage = resp.usage || {};
  const costIn = (usage.prompt_tokens || 0) * 0.00000015;
  const costOut = (usage.completion_tokens || 0) * 0.00000060;

  return {
    identityId,
    category,
    confidence,
    reason,
    summary,
    model,
    events_used: events.length,
    tokens: { prompt: usage.prompt_tokens || 0, completion: usage.completion_tokens || 0 },
    cost_usd: +(costIn + costOut).toFixed(5),
  };
}

module.exports = {
  classifyIdentity,
  fetchRecentEvents,
  buildPrompt,
  SYSTEM_PROMPT,
};
