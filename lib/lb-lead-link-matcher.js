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

  // Pull ALL jobs per matched customer so the tiered picker can scan
  // status outcomes (a customer with 48 SF jobs is normal for recurring
  // service).
  const { data: jobsRows } = await supabase
    .from(JOBS_TABLE)
    .select(jobSelect)
    .eq('user_id', userId)
    .in('customer_id', customerIds)
    .order('created_at', { ascending: true })
    .limit(customerIds.length * 20);   // safety cap

  // HISTORICAL-SYNC representative-job pick order (per the
  // post-Batch-5 spec — fixes the recurring-customer conflict pattern):
  //   tier 1: earliest completed+paid job
  //   tier 2: earliest completed job (any payment status)
  //   tier 3: earliest scheduled/booked job (only when no completed exists)
  //   else: null (customer has only cancelled/no-show history → drop)
  //
  // The live/new-conversion flow does NOT call findMatchCandidates — it
  // attaches the LB lead to a freshly created SF job inline via
  // /orchestration/attach-lb-link, so this picker only governs
  // historical reconstruction.
  const jobsByCustomer = pickHistoricalRepresentativeJobPerCustomer(jobsRows);

  // Surface "this customer already has at least one job linked to some
  // LB lead" so the orchestrator can suppress would_link suggestions on
  // already-reconciled customers (the matcher picks an earlier
  // unlinked job after PR #39's tiered picker; without this signal the
  // orchestrator would re-attempt linking the same LB lead to a 2nd
  // SF job for the same customer — a remap, not historical cleanup).
  const anyJobLinkedByCustomer = new Map();
  for (const j of (jobsRows || [])) {
    if (j && j.lb_lead_id) anyJobLinkedByCustomer.set(j.customer_id, true);
  }

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
        any_job_linked:       !!anyJobLinkedByCustomer.get(cust.id),
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
 * Earliest job by (created_at ASC, id ASC). Used as the within-tier
 * tiebreaker for the historical representative picker.
 */
function earliestByCreatedThenId(jobs) {
  return jobs.slice().sort((a, b) => {
    const ca = a.created_at ? Date.parse(a.created_at) : Number.MAX_SAFE_INTEGER;
    const cb = b.created_at ? Date.parse(b.created_at) : Number.MAX_SAFE_INTEGER;
    if (ca !== cb) return ca - cb;
    return Number(a.id) - Number(b.id);
  })[0];
}

const COMPLETED_STATUSES   = new Set(['completed']);
const IN_PROGRESS_STATUSES = new Set(['in_progress']);
const SCHEDULED_STATUSES   = new Set(['scheduled', 'booked']);
// Cancelled / no_show / pending-only customers are intentionally NOT
// picked: a cancelled-only history means the lead never converted, so
// there's no representative job to point LB at.
//
// SF service lifecycle = {completed, in_progress, scheduled, booked}. Any
// job in these states means the customer entered the service lifecycle
// (per the SF-connected business rule). Payment status is informational
// only and does NOT gate lifecycle entry.

/**
 * Pick the SF job that represents a customer's historical conversion
 * for the purpose of the LB ↔ SF linkage.
 *
 * Tiered selection (SF service lifecycle, per the SF-connected rule):
 *   tier 1 — earliest `completed` + `payment_status=paid` job
 *   tier 2 — earliest `completed` job (any payment status)
 *   tier 3 — earliest `in_progress` job
 *   tier 4 — earliest `scheduled` / `booked` job
 *            (fires only when no completed/in_progress exists, so it
 *             genuinely represents a first-conversion-in-progress)
 *   else   — null (drop the candidate: no eligible conversion history)
 *
 * Tier order encodes lifecycle progression: served > mid-service >
 * about-to-be-served. Completed/paid is preferred over completed/unpaid
 * for selection (paid is a stronger conversion signal) — but both tiers
 * imply lifecycle entry. Payment status NEVER gates lifecycle eligibility;
 * it only affects WHICH completed job is selected when multiple exist.
 *
 * "Earliest" = lowest `created_at`, tie-broken by lowest `id`. This
 * sorts on when SF first knew about the booking, not on
 * `scheduled_date` (which can move freely).
 *
 * Why not "originator by `lb_external_request_id` match" (the prior
 * patch)? Because LB's pin on a recurring customer's lb_lead can be
 * on a CANCELLED originator (4 such cases observed in prod —
 * Batches #1B + #4B). Pinning SF state to that cancelled job would
 * carry LB's wrong representative forward; the right business signal
 * is "the lead converted into THIS particular service event", and
 * the earliest lifecycle job is that signal.
 *
 * Cancelled / no_show / null-status jobs are EXCLUDED at the tier
 * filter — they don't represent lifecycle entry. A customer with only
 * cancelled jobs has no representative and the candidate is dropped.
 *
 * Scope: historical-sync only. The live-new-conversion flow attaches
 * an LB lead to a freshly created SF job at booking time via
 * /orchestration/attach-lb-link with explicit ids and never invokes
 * `findMatchCandidates`, so this picker does not affect that path.
 *
 * @param {Array<object>} jobsRows  - flat array of jobs across customers
 * @returns {Map<number, object>}   - customer_id → picked SF job
 *                                    (customers with no eligible
 *                                     conversion job are absent)
 */
function pickHistoricalRepresentativeJobPerCustomer(jobsRows) {
  const byCust = new Map();
  for (const j of (jobsRows || [])) {
    const k = j.customer_id;
    if (!byCust.has(k)) byCust.set(k, []);
    byCust.get(k).push(j);
  }
  const out = new Map();
  for (const [custId, jobs] of byCust.entries()) {
    const picked = pickHistoricalRepresentativeJob(jobs);
    if (picked) out.set(custId, picked);
  }
  return out;
}

/**
 * Single-customer version of the tiered picker. Exposed for tests +
 * direct callers (e.g. ad-hoc reconciliation scripts).
 *
 * @param {Array<object>} jobs   - jobs belonging to ONE customer
 * @returns {object|null}        - picked job or null if none eligible
 */
function pickHistoricalRepresentativeJob(jobs) {
  const all = Array.isArray(jobs) ? jobs : [];
  // tier 1: earliest completed + paid (strongest conversion signal)
  const completedPaid = all.filter(j =>
       COMPLETED_STATUSES.has((j.status || '').toLowerCase())
    && (j.payment_status || '').toLowerCase() === 'paid'
  );
  if (completedPaid.length) return earliestByCreatedThenId(completedPaid);

  // tier 2: earliest completed (any payment status — service delivered)
  const completed = all.filter(j => COMPLETED_STATUSES.has((j.status || '').toLowerCase()));
  if (completed.length) return earliestByCreatedThenId(completed);

  // tier 3: earliest in_progress (mid-service — customer actively being served)
  const inProgress = all.filter(j => IN_PROGRESS_STATUSES.has((j.status || '').toLowerCase()));
  if (inProgress.length) return earliestByCreatedThenId(inProgress);

  // tier 4: earliest scheduled/booked (only when no completed/in_progress exists)
  const scheduled = all.filter(j => SCHEDULED_STATUSES.has((j.status || '').toLowerCase()));
  if (scheduled.length) return earliestByCreatedThenId(scheduled);

  return null;
}

module.exports = {
  findMatchCandidates,
  // exposed for tests + ad-hoc reconciliation tooling
  normPhoneLast10,
  normEmail,
  splitName,
  phoneLast4,
  scoreCandidate,
  pickHistoricalRepresentativeJob,
  pickHistoricalRepresentativeJobPerCustomer,
  earliestByCreatedThenId,
  COMPLETED_STATUSES,
  SCHEDULED_STATUSES,
  MAX_CANDIDATES,
};
