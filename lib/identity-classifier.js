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

CRITICAL — distinguishing inbound (THEM) vs outbound (US):
- Messages prefixed [THEM] are from the contact. These are what you classify.
- Messages prefixed [US] are from OUR BUSINESS. We send promotional offers,
  booking confirmations, quotes, reminders, etc. OUR OUTBOUND CONTENT IS NEVER
  AN "AD" — even if it contains promotional/marketing copy. That's us marketing
  to our leads, not spam to us. Use [US] messages ONLY as context for who THEM
  is (e.g., we quoted them → they're a prospect; we confirmed their booking →
  existing_customer).
- If ALL messages are [US] (we blasted them, no reply) → category = "unclear"
  (we don't know what they are because they haven't said anything).
- Classification is about who THEM is based on what THEM wrote.

Categories:
- "prospect": THEM asked about cleaning services / price / availability / booking / quote. "do you clean condos?", "how much for 3BR?", "can you come Friday?", "I need a move-out clean", "saw you on Yelp/Google/Thumbtack".
- "existing_customer": THEM confirming or managing a booking — reschedule, cancel, thank-you after service, question about a past job, tip/payment, key/access.
- "ad": THEM sent unsolicited marketing or B2B pitch to us — SEO services, business loans, crypto, Google Ads management, "grow your business", lead-gen, staffing, debt consolidation, insurance offers, real-estate wholesalers, political/fundraising, domain scams, "make $X/week".
- "wrong_number": THEM clearly misdirected — "who is this?", "wrong number", unrelated auto-reply, topic completely outside cleaning (rides, food delivery, medical, school).
- "unclear": THEM hasn't said anything substantive (just "hi" with no follow-up, or only [US] messages on record with no reply, or a single URL).

Signals you may also receive:
- CALL events: [THEM CALL duration=Ns] or [US CALL duration=Ns] — a phone call occurred. Short calls (<10s, often "missed") from THEM are neutral. Calls TO us lasting 30s+ suggest real intent.
- VOICEMAIL: presence of a voicemail from THEM suggests a real-person prospect (ad bots rarely leave voicemails).
- Transcription (if provided) is authoritative content.

Output ONLY JSON (no markdown, no prose, no code fence):
{"category":"prospect|existing_customer|ad|wrong_number|unclear","confidence":0-100,"reason":"one short sentence why","summary":"one-line summary of what THEM said/did, max 90 chars. If only US messages exist, summary='only outbound messages, no inbound reply'."}`;

function normDir(d) {
  if (d === 'in' || d === 'inbound') return 'inbound';
  if (d === 'out' || d === 'outbound') return 'outbound';
  return 'unknown';
}

/**
 * Fetch the last N messages + calls across this identity's conversations.
 * Returns an array of events ordered oldest → newest. Each event has:
 *   { kind: 'message'|'call', direction, text, at }
 * For calls, text is synthesized from duration + voicemail + transcription.
 */
async function fetchRecentEvents(supabase, userId, identityId, maxEvents = 12) {
  const { data: convs } = await supabase.from('communication_conversations')
    .select('id, participant_name, company, channel, last_event_at')
    .eq('user_id', userId).eq('participant_identity_id', identityId)
    .order('last_event_at', { ascending: false }).limit(5);
  if (!convs || convs.length === 0) return { events: [], meta: {} };

  const convIds = convs.map(c => c.id);
  // Messages + calls in parallel.
  const [msgsRes, callsRes] = await Promise.all([
    supabase.from('communication_messages')
      .select('conversation_id, direction, body, body_text, created_at')
      .in('conversation_id', convIds)
      .order('created_at', { ascending: false }).limit(maxEvents),
    supabase.from('communication_calls')
      .select('conversation_id, direction, duration_seconds, status, metadata, created_at')
      .in('conversation_id', convIds)
      .order('created_at', { ascending: false }).limit(maxEvents),
  ]);

  const msgs = (msgsRes.data || []).map(m => ({
    kind: 'message',
    direction: normDir(m.direction),
    text: (m.body_text || m.body || '').trim().slice(0, 500),
    at: m.created_at,
  })).filter(e => e.text);

  const calls = (callsRes.data || []).map(c => {
    const dur = c.duration_seconds || 0;
    const status = c.status || 'unknown';
    const tx = (c.metadata?.transcription || '').trim();
    const hasVoicemail = !!c.metadata?.voicemailUrl;
    let text;
    if (tx) text = `TRANSCRIPT: ${tx.slice(0, 500)}`;
    else if (hasVoicemail) text = `CALL duration=${dur}s status=${status} voicemail=yes`;
    else text = `CALL duration=${dur}s status=${status}`;
    return { kind: 'call', direction: normDir(c.direction), text, at: c.created_at };
  });

  // Merge, sort newest→oldest, cap, then reverse to oldest→newest for the prompt.
  const merged = [...msgs, ...calls]
    .sort((a, b) => new Date(b.at) - new Date(a.at))
    .slice(0, maxEvents)
    .reverse();

  return {
    events: merged,
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

  let conv;
  if (events.length === 0) {
    conv = '(no messages or calls available — only a phone match, no content)';
  } else {
    conv = events.map(e => {
      const who = e.direction === 'inbound' ? 'THEM' : e.direction === 'outbound' ? 'US' : 'UNK';
      const tag = e.kind === 'call' ? `${who} CALL` : who;
      return `[${tag}] ${e.text}`;
    }).join('\n');
    // Flag when THEM never responded — helps the LLM pick "unclear" correctly.
    const anyInbound = events.some(e => e.direction === 'inbound');
    if (!anyInbound) conv += '\n\nNOTE: only outbound/our messages exist. THEM has not said anything.';
  }

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
