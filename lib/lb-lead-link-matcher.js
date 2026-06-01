'use strict';

// Match LB historical leads to existing SF customers/jobs.
//
// Called by POST /api/integrations/leadbridge/orchestration/match-candidates.
//
// The matcher takes whatever signals LB has on the historical lead
// (phone, email, name, lead-created-at) and surfaces ALL plausible
// SF customers, each with a `confidence` band:
//
//   exact   — phone AND email both match (or LB lead_id already set on SF row)
//   high    — phone exact OR email exact
//   medium  — name first+last exact AND a date proximity (a SF job's
//             scheduled_date / customer.created_at within ±14 days of
//             lead_created_at)
//   low     — name first+last exact only
//
// Hard rules:
//   - tenant-scoped: every query filters `user_id = req.user.userId`
//   - PII redaction: response returns phone_last4 + email_present flag
//     ONLY, never full values
//   - bounded: max 10 candidates returned (LB's UI surfaces ambiguity
//     instead of guessing)
//   - time window: candidates created more than 180 days from
//     lead_created_at are excluded UNLESS phone matched exactly
//     (long-tail repeat customers can match on phone even if old)

const PHONE_DIGITS = /\D+/g;
const MAX_CANDIDATES = 10;
const TIME_WINDOW_DAYS_MEDIUM = 14;
const TIME_WINDOW_DAYS_MAX    = 180;

const CUSTOMERS_TABLE = 'customers';
const JOBS_TABLE      = 'jobs';

// ──────────────────────────────────────────────────────────────
// Normalizers
// ──────────────────────────────────────────────────────────────
function normPhoneLast10(s) {
  if (typeof s !== 'string') return null;
  const digits = s.replace(PHONE_DIGITS, '');
  return digits.length >= 7 ? digits.slice(-10) : null;
}

function normEmail(s) {
  if (typeof s !== 'string') return null;
  const e = s.trim().toLowerCase();
  return e.length > 0 ? e : null;
}

function splitName(s) {
  if (typeof s !== 'string') return { first: null, last: null };
  const trimmed = s.trim();
  if (trimmed.length === 0) return { first: null, last: null };
  const parts = trimmed.split(/\s+/);
  if (parts.length === 1) return { first: parts[0], last: null };
  return { first: parts[0], last: parts[parts.length - 1] };
}

function phoneLast4(s) {
  const d = normPhoneLast10(s);
  return d ? d.slice(-4) : null;
}

function inDayWindow(a, b, days) {
  if (!a || !b) return false;
  const ta = new Date(a).getTime();
  const tb = new Date(b).getTime();
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return false;
  return Math.abs(ta - tb) <= days * 24 * 3600 * 1000;
}

// ──────────────────────────────────────────────────────────────
// Confidence scoring
// ──────────────────────────────────────────────────────────────
function scoreCandidate({ input, customer, pickedJob }) {
  const signals = [];
  let exactPhone = false;
  let exactEmail = false;
  let nameExact  = false;
  let lbLeadIdMatch = false;

  // Phone
  const inputPhone = normPhoneLast10(input.customer_phone);
  const custPhone  = normPhoneLast10(customer.phone);
  if (inputPhone && custPhone && inputPhone === custPhone) {
    exactPhone = true;
    signals.push('phone_exact:…' + custPhone.slice(-4));
  }

  // Email
  const inputEmail = normEmail(input.customer_email);
  const custEmail  = normEmail(customer.email);
  if (inputEmail && custEmail && inputEmail === custEmail) {
    exactEmail = true;
    signals.push('email_exact');
  }

  // Name
  const inName  = splitName(input.customer_name);
  const cFirst  = (customer.first_name || '').trim().toLowerCase();
  const cLast   = (customer.last_name  || '').trim().toLowerCase();
  if (inName.first && inName.last
      && cFirst === inName.first.toLowerCase()
      && cLast  === inName.last.toLowerCase()) {
    nameExact = true;
    signals.push('name_exact');
  }

  // LB lead_id already present on either row
  if (input.lb_lead_id && (customer.lb_lead_id === input.lb_lead_id
                       || (pickedJob && pickedJob.lb_lead_id === input.lb_lead_id))) {
    lbLeadIdMatch = true;
    signals.push('lb_lead_id_already_linked');
  }

  // Date proximity (uses job.scheduled_date if present, else customer.created_at)
  let dateProximity = false;
  if (input.lead_created_at) {
    const ref = pickedJob?.scheduled_date || customer.created_at;
    if (inDayWindow(input.lead_created_at, ref, TIME_WINDOW_DAYS_MEDIUM)) {
      dateProximity = true;
      signals.push('date_within_14d');
    }
  }

  // Confidence bucketing
  let confidence;
  if (lbLeadIdMatch) confidence = 'exact';            // already linked
  else if (exactPhone && exactEmail)         confidence = 'exact';
  else if (exactPhone || exactEmail)         confidence = 'high';
  else if (nameExact && dateProximity)       confidence = 'medium';
  else if (nameExact)                        confidence = 'low';
  else                                       confidence = null; // not a candidate

  return { confidence, signals, exactPhone, exactEmail, nameExact, lbLeadIdMatch };
}

// ──────────────────────────────────────────────────────────────
// Main entry
// ──────────────────────────────────────────────────────────────
/**
 * @param {object} supabase
 * @param {object} args
 * @param {number} args.userId
 * @param {object} args.input  - { lb_lead_id, lb_external_request_id, lb_channel, lb_business_id, customer_phone, customer_email, customer_name, lead_created_at }
 * @returns {Promise<{candidates: Array, match_count: number}>}
 */
async function findMatchCandidates(supabase, { userId, input }) {
  if (!supabase || typeof supabase.from !== 'function') {
    throw new Error('findMatchCandidates: supabase required');
  }
  if (userId == null) throw new Error('findMatchCandidates: userId required');
  const inp = input || {};

  const phone10 = normPhoneLast10(inp.customer_phone);
  const email   = normEmail(inp.customer_email);
  const { first: nFirst, last: nLast } = splitName(inp.customer_name);

  // 1. Pull customer candidates via three parallel queries (phone, email, name).
  //    Each restricted to tenant + a generous LIMIT, then merged + deduped.
  const customerSelect = 'id, user_id, first_name, last_name, email, phone, lb_lead_id, created_at';
  const queries = [];

  if (phone10) {
    queries.push(supabase.from(CUSTOMERS_TABLE).select(customerSelect)
      .eq('user_id', userId)
      .ilike('phone', `%${phone10}%`)
      .limit(MAX_CANDIDATES * 2));
  }
  if (email) {
    queries.push(supabase.from(CUSTOMERS_TABLE).select(customerSelect)
      .eq('user_id', userId)
      .ilike('email', email)
      .limit(MAX_CANDIDATES * 2));
  }
  if (nFirst && nLast) {
    queries.push(supabase.from(CUSTOMERS_TABLE).select(customerSelect)
      .eq('user_id', userId)
      .ilike('first_name', nFirst)
      .ilike('last_name',  nLast)
      .limit(MAX_CANDIDATES * 2));
  }
  // If LB lead_id was supplied, also look for an already-linked row.
  if (inp.lb_lead_id) {
    queries.push(supabase.from(CUSTOMERS_TABLE).select(customerSelect)
      .eq('user_id', userId)
      .eq('lb_lead_id', inp.lb_lead_id)
      .limit(1));
  }

  if (queries.length === 0) {
    return { candidates: [], match_count: 0 };
  }

  const customerResults = await Promise.all(queries.map((q) => q.then(
    (r) => r,
    (err) => ({ data: null, error: err }),
  )));

  // Merge + dedupe by customer.id
  const byId = new Map();
  for (const r of customerResults) {
    if (r.error) continue;
    for (const row of (r.data || [])) {
      if (!byId.has(row.id)) byId.set(row.id, row);
    }
  }

  if (byId.size === 0) return { candidates: [], match_count: 0 };

  // 2. For each candidate customer, pull the most recent linked SF job (if any).
  //    Bound: prefer jobs near the lead_created_at, fall back to most recent.
  const customerIds = Array.from(byId.keys());
  const jobSelect = 'id, user_id, customer_id, status, payment_status, scheduled_date, total_amount, invoice_amount, lb_external_request_id, lb_channel, lb_business_id, lb_lead_id, last_status_changed_at, created_at';

  // Pull ALL jobs per matched customer (no per-customer limit beyond the
  // safety cap below) so we can pick the originator/earliest deterministically.
  // Previously we kept "most-recent" — that produced conflicts for recurring
  // customers because LB pins lb_lead.sf_job_id to the originator SF job.
  const { data: jobsRows } = await supabase
    .from(JOBS_TABLE)
    .select(jobSelect)
    .eq('user_id', userId)
    .in('customer_id', customerIds)
    .order('created_at', { ascending: true })
    .limit(customerIds.length * 20);   // safety cap; recurring customers can have many jobs

  // Per-customer pick order (post-Batch-5 spec):
  //   1. Originator: job whose lb_external_request_id matches the LB lead's
  //      externalRequestId (input.lb_external_request_id). That's the job
  //      LB pinned to its lead and the one LB will accept on /link-leads-bulk.
  //   2. Fallback: earliest eligible job for that customer (lowest created_at,
  //      tie-broken by id). "Earliest" lines up with what LB knows: LB sees
  //      a lead as the first customer touch and would have linked the first
  //      SF booking we received for that customer.
  const jobsByCustomer = pickOriginatorOrEarliestPerCustomer(jobsRows, inp.lb_external_request_id);

  // 3. Score every candidate; drop those without any confidence; sort.
  const CONF_ORDER = { exact: 4, high: 3, medium: 2, low: 1 };
  const scored = [];
  for (const cust of byId.values()) {
    const pickedJob = jobsByCustomer.get(cust.id) || null;
    const score = scoreCandidate({ input: inp, customer: cust, pickedJob });

    if (!score.confidence) continue;

    // Time-window cap: drop candidates outside the 180-day max window
    // UNLESS exact phone match (long-tail returning customer).
    if (inp.lead_created_at && !score.exactPhone) {
      const ref = pickedJob?.scheduled_date || pickedJob?.created_at || cust.created_at;
      if (ref && !inDayWindow(inp.lead_created_at, ref, TIME_WINDOW_DAYS_MAX)) continue;
    }

    scored.push({
      sf_customer_id: cust.id,
      sf_job_id:      pickedJob ? pickedJob.id : null,
      confidence:     score.confidence,
      match_signals:  score.signals,
      sf_customer: {
        first_name:           cust.first_name || null,
        last_name:            cust.last_name  || null,
        phone_last4:          phoneLast4(cust.phone),
        email_present:        !!normEmail(cust.email),
        lb_lead_id:           cust.lb_lead_id || null,
      },
      sf_job: pickedJob ? {
        status:                  pickedJob.status,
        payment_status:          pickedJob.payment_status,
        scheduled_date:          pickedJob.scheduled_date,
        amount:                  pickAmount(pickedJob),
        last_status_changed_at:  pickedJob.last_status_changed_at,
        lb_external_request_id:  pickedJob.lb_external_request_id || null,
        lb_channel:              pickedJob.lb_channel || null,
        lb_business_id:          pickedJob.lb_business_id || null,
        lb_lead_id:              pickedJob.lb_lead_id || null,
      } : null,
      ambiguity_warnings: [],
    });
  }

  // 4. Sort by confidence DESC, then date proximity (we'd need a numeric proximity score; skip for now and let LB sort if needed).
  scored.sort((a, b) => (CONF_ORDER[b.confidence] || 0) - (CONF_ORDER[a.confidence] || 0));

  // 5. Surface ambiguity warnings: if >1 high-confidence candidates, flag each.
  const highOrAbove = scored.filter((c) => CONF_ORDER[c.confidence] >= CONF_ORDER.high);
  if (highOrAbove.length > 1) {
    for (const c of highOrAbove) c.ambiguity_warnings.push('multiple_high_confidence_candidates');
  }

  const trimmed = scored.slice(0, MAX_CANDIDATES);
  return { candidates: trimmed, match_count: trimmed.length };
}

function pickAmount(job) {
  if (job.invoice_amount != null) return Number(job.invoice_amount);
  if (job.total_amount   != null) return Number(job.total_amount);
  return null;
}

/**
 * Pick the canonical SF job per customer for historical-sync matching.
 *
 * Spec (post-Batch-5 audit):
 *   1. If LB provides `lb_external_request_id` AND a job for that
 *      customer has `lb_external_request_id` === input value, return
 *      THAT job. It's the originator — the SF job LB pinned its
 *      lb_lead to. Returning a non-originator for a recurring
 *      customer causes LB to reject the apply with `result:conflict`
 *      (4 such conflicts in Batches #1+#4).
 *   2. Otherwise, return the earliest eligible job for that customer
 *      (lowest created_at, tie-broken by lowest id). "Earliest" lines
 *      up with what LB knows: LB sees a lead as the first customer
 *      touch and would have linked the first SF booking it saw.
 *      Previous behaviour was "most recent" which intentionally
 *      points away from the originator and produced false positives
 *      for recurring customers.
 *
 * @param {Array<object>} jobsRows  - flat array of jobs across customers
 * @param {string|null} inputExtReq - lead's externalRequestId from LB
 * @returns {Map<number, object>}   - customer_id → picked SF job
 */
function pickOriginatorOrEarliestPerCustomer(jobsRows, inputExtReq) {
  const byCust = new Map();
  for (const j of (jobsRows || [])) {
    const k = j.customer_id;
    if (!byCust.has(k)) byCust.set(k, []);
    byCust.get(k).push(j);
  }
  const out = new Map();
  for (const [custId, jobs] of byCust.entries()) {
    // Step 1: prefer the originator (ext_req match).
    let picked = null;
    if (inputExtReq) {
      picked = jobs.find(j => j.lb_external_request_id === inputExtReq) || null;
    }
    // Step 2: fall back to earliest by (created_at ASC, id ASC).
    if (!picked) {
      picked = jobs.slice().sort((a, b) => {
        const ca = a.created_at ? Date.parse(a.created_at) : Number.MAX_SAFE_INTEGER;
        const cb = b.created_at ? Date.parse(b.created_at) : Number.MAX_SAFE_INTEGER;
        if (ca !== cb) return ca - cb;
        return Number(a.id) - Number(b.id);
      })[0];
    }
    if (picked) out.set(custId, picked);
  }
  return out;
}

module.exports = {
  findMatchCandidates,
  // exposed for tests
  normPhoneLast10,
  normEmail,
  splitName,
  phoneLast4,
  scoreCandidate,
  pickOriginatorOrEarliestPerCustomer,
  MAX_CANDIDATES,
};
