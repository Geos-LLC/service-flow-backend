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

const SYSTEM_PROMPT = `You are triaging inbound SMS/calls for a residential cleaning services business (maid service, house cleaning, move-in/move-out cleans, deep cleans). The operator only wants to spend time on real prospects and existing customers.

Classify the conversation into ONE category. Be decisive — "unclear" should be rare, reserved for truly ambiguous cases (2–3 words of context only).

Categories:
- "prospect": a real person inquiring about cleaning services / price / availability / booking / quote. Includes "do you clean condos?", "how much for 3BR?", "can you come Friday?", "I need a move-out clean", "saw you on Yelp/Google/Thumbtack".
- "existing_customer": confirming or managing an existing booking — reschedule, cancel, update, thank-you after service, question about a past job, tip/payment, key/access instructions.
- "ad": unsolicited marketing or B2B pitch — SEO services, business loans, crypto, Google Ads management, "grow your business", lead-gen services, staffing, debt consolidation, insurance offers, real-estate wholesalers, political/fundraising blasts, domain/expiration scams, "make $X a week", free trial offers, anything trying to sell TO the business.
- "wrong_number": clearly misdirected — "who is this?", "wrong number", unrelated auto-reply, conversation about a topic completely outside cleaning (ride shares, food delivery, medical, school).
- "unclear": genuinely cannot tell (single word like "hi" with no reply, only a link with no context). Use sparingly.

Key heuristics:
- A short greeting + asking about services = prospect (confidence 85+).
- Any mention of "cleaning", "clean", "move-out", "deep clean", "maid", "appointment", "quote", "price" with a real-person voice = prospect (confidence 90+).
- Marketing boilerplate ("claim your spot", "limited time", "Reply STOP", "www.<spammy>", promo codes, ALL CAPS slogans) = ad (confidence 95+).
- A conversation where OUR side sent pricing/appt confirmation and the customer replied with thanks or a scheduling change = existing_customer (confidence 90+).
- If the attempted name or OpenPhone Company tag already looks like a platform alias ("Thumbtack Jacksonville", "Yelp Leads") treat the inbound-from-that-platform first message as ad unless the NEXT message is a human inquiry.

Output ONLY JSON (no markdown, no prose, no code fence):
{"category":"prospect|existing_customer|ad|wrong_number|unclear","confidence":0-100,"reason":"one short sentence why","summary":"one-line summary of what they asked/said, max 90 chars"}`;

/**
 * Fetch the last N messages across this identity's conversations.
 * Returns an array of { direction, text, at } ordered oldest → newest.
 */
async function fetchRecentEvents(supabase, userId, identityId, maxEvents = 8) {
  // Get conversations for the identity.
  const { data: convs } = await supabase.from('communication_conversations')
    .select('id, participant_name, company, channel, last_event_at')
    .eq('user_id', userId).eq('participant_identity_id', identityId)
    .order('last_event_at', { ascending: false }).limit(5);
  if (!convs || convs.length === 0) return { events: [], meta: {} };

  const convIds = convs.map(c => c.id);
  // Messages live in communication_messages. Scoped by conversation_id
  // (which is already tenant-scoped via conversations).
  const { data: messages } = await supabase.from('communication_messages')
    .select('conversation_id, direction, body, body_text, created_at')
    .in('conversation_id', convIds)
    .order('created_at', { ascending: false }).limit(maxEvents);

  const ordered = (messages || [])
    .map(m => {
      const text = (m.body_text || m.body || '').trim().slice(0, 500);
      // Normalize direction: 'in' | 'inbound' → inbound; 'out' | 'outbound' → outbound.
      const dir = (m.direction === 'in' || m.direction === 'inbound') ? 'inbound'
        : (m.direction === 'out' || m.direction === 'outbound') ? 'outbound'
        : 'unknown';
      return { direction: dir, text, at: m.created_at };
    })
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
