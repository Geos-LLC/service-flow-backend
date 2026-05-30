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
function scoreCandidate({ input, customer, mostRecentJob }) {
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
                       || (mostRecentJob && mostRecentJob.lb_lead_id === input.lb_lead_id))) {
    lbLeadIdMatch = true;
    signals.push('lb_lead_id_already_linked');
  }

  // Date proximity (uses job.scheduled_date if present, else customer.created_at)
  let dateProximity = false;
  if (input.lead_created_at) {
    const ref = mostRecentJob?.scheduled_date || customer.created_at;
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

  const { data: jobsRows } = await supabase
    .from(JOBS_TABLE)
    .select(jobSelect)
    .eq('user_id', userId)
    .in('customer_id', customerIds)
    .order('scheduled_date', { ascending: false })
    .limit(customerIds.length * 5);   // up to 5 jobs per candidate is plenty

  // Group jobs by customer_id, pick most-recent-by-scheduled-or-created
  const jobsByCustomer = new Map();
  for (const j of (jobsRows || [])) {
    const existing = jobsByCustomer.get(j.customer_id);
    if (!existing) {
      jobsByCustomer.set(j.customer_id, j);
      continue;
    }
    const eRef = existing.scheduled_date || existing.created_at;
    const jRef = j.scheduled_date         || j.created_at;
    if (jRef && (!eRef || new Date(jRef) > new Date(eRef))) {
      jobsByCustomer.set(j.customer_id, j);
    }
  }

  // 3. Score every candidate; drop those without any confidence; sort.
  const CONF_ORDER = { exact: 4, high: 3, medium: 2, low: 1 };
  const scored = [];
  for (const cust of byId.values()) {
    const mostRecentJob = jobsByCustomer.get(cust.id) || null;
    const score = scoreCandidate({ input: inp, customer: cust, mostRecentJob });

    if (!score.confidence) continue;

    // Time-window cap: drop candidates outside the 180-day max window
    // UNLESS exact phone match (long-tail returning customer).
    if (inp.lead_created_at && !score.exactPhone) {
      const ref = mostRecentJob?.scheduled_date || mostRecentJob?.created_at || cust.created_at;
      if (ref && !inDayWindow(inp.lead_created_at, ref, TIME_WINDOW_DAYS_MAX)) continue;
    }

    scored.push({
      sf_customer_id: cust.id,
      sf_job_id:      mostRecentJob ? mostRecentJob.id : null,
      confidence:     score.confidence,
      match_signals:  score.signals,
      sf_customer: {
        first_name:           cust.first_name || null,
        last_name:            cust.last_name  || null,
        phone_last4:          phoneLast4(cust.phone),
        email_present:        !!normEmail(cust.email),
        lb_lead_id:           cust.lb_lead_id || null,
      },
      sf_job: mostRecentJob ? {
        status:                  mostRecentJob.status,
        payment_status:          mostRecentJob.payment_status,
        scheduled_date:          mostRecentJob.scheduled_date,
        amount:                  pickAmount(mostRecentJob),
        last_status_changed_at:  mostRecentJob.last_status_changed_at,
        lb_external_request_id:  mostRecentJob.lb_external_request_id || null,
        lb_channel:              mostRecentJob.lb_channel || null,
        lb_business_id:          mostRecentJob.lb_business_id || null,
        lb_lead_id:              mostRecentJob.lb_lead_id || null,
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

module.exports = {
  findMatchCandidates,
  // exposed for tests
  normPhoneLast10,
  normEmail,
  splitName,
  phoneLast4,
  scoreCandidate,
  MAX_CANDIDATES,
};
