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

const CUSTOMERS_TABLE  = 'customers';
const JOBS_TABLE       = 'jobs';
const LEADS_TABLE      = 'leads';
const LEAD_STAGES_TABLE = 'lead_stages';

// ──────────────────────────────────────────────────────────────
// Match type taxonomy — locked by the joint LB↔SF design.
//
// Every LB lead processed by the historical matcher resolves to
// EXACTLY ONE of these match types. Mapping to LB syncStatus:
//
//   lead_only     → LB sets syncStatus='lead_linked' + sfLeadId.
//                   sfCustomerId/sfJobId STAY NULL. LB continues to
//                   own conversation; follow-up keeps running. UI
//                   shows "SF Lead — <stage name>".
//
//   customer_job  → LB sets syncStatus='linked' + sfCustomerId
//                   (and sfJobId when present). SF owns lifecycle.
//
//   needs_review  → LB sets syncStatus='needs_review'. Operator
//                   resolves via manual-link.
//
//   no_match      → LB sets syncStatus='no_match'. Reached only
//                   when EVERY prior step in the decision tree
//                   failed.
//
//   test_noise    → SF orchestrator filters; nothing sent to LB.
//                   (LB platform='test' rows.)
//
// Returned from findHistoricalMatchType(). See that function's docstring
// for the full decision-tree order.
const MATCH_TYPE = Object.freeze({
  LEAD_ONLY:    'lead_only',
  CUSTOMER_JOB: 'customer_job',
  NEEDS_REVIEW: 'needs_review',
  NO_MATCH:     'no_match',
  TEST_NOISE:   'test_noise',
});

// LB-wire match_basis values — pinned to LB's BulkLinkRow contract so
// PR C can pass through unchanged.
const MATCH_BASIS = Object.freeze({
  EXTERNAL_REQUEST_ID: 'externalRequestId',
  LB_LEAD_ID:          'lbLeadId',
  PHONE:               'phone',
  EMAIL:               'email',
  MANUAL:              'manual',
  NONE:                'none',
});

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

// ═══════════════════════════════════════════════════════════════════
// findHistoricalMatchType — LB↔SF historical matcher, leads-aware
// ═══════════════════════════════════════════════════════════════════
//
// Replaces direct calls to findMatchCandidates for historical-sync
// classification. Implements the LOCKED matcher decision tree from the
// joint LB↔SF design audit (2026-06-04):
//
//   Step 0 — test noise
//     LB.lb_channel === 'test' → MATCH_TYPE.TEST_NOISE
//     SF orchestrator filters these; they never reach LB.
//
//   Step 1 — SF lead by lb_external_request_id (deterministic, indexed)
//     SELECT * FROM leads WHERE user_id=? AND lb_external_request_id=?
//     ├ 1 row, converted_customer_id IS NULL → MATCH_TYPE.LEAD_ONLY
//     │                                         confidence='exact'
//     │                                         match_basis='externalRequestId'
//     │                                         + sf_lead_id + sf_lead_stage_name
//     ├ 1 row, converted_customer_id IS NOT NULL → MATCH_TYPE.CUSTOMER_JOB
//     │                                         confidence='exact'
//     │                                         + sf_lead_id + sf_customer_id
//     │                                         + representative sf_job_id (if any)
//     └ ≥2 rows                                 → MATCH_TYPE.NEEDS_REVIEW
//                                                 reason='multiple_sf_leads_for_externalRequestId'
//
//   Step 1.5 — legacy customer-side LB stamp
//     SELECT * FROM customers WHERE user_id=? AND lb_lead_id=LB.leadId
//     ├ found → MATCH_TYPE.CUSTOMER_JOB
//     │         confidence='exact'  match_basis='lbLeadId'
//     │         + sf_customer_id + representative sf_job_id (if any)
//     └ no hit → continue
//
//     Required because the May 2026 historical sync (PR #34–#41)
//     stamped customers.lb_lead_id + jobs.lb_lead_id directly without
//     back-populating leads.lb_external_request_id. For tenant 2 this
//     covers ~226 rows that Step 1 cannot see.
//
//   Step 2 — existing customer phone/email/name matcher
//     findMatchCandidates (unchanged behaviour)
//     ├ 1 high/exact candidate    → MATCH_TYPE.CUSTOMER_JOB
//     ├ 1 medium/low candidate    → MATCH_TYPE.NEEDS_REVIEW
//     ├ ≥2 candidates             → MATCH_TYPE.NEEDS_REVIEW
//     │                              reason='multiple_customer_candidates'
//     └ 0 candidates              → continue
//
//   Step 3 — legacy job-side LB stamp
//     SELECT * FROM jobs WHERE user_id=? AND lb_external_request_id=?
//     ├ 1 row   → MATCH_TYPE.CUSTOMER_JOB  confidence='exact'
//     │           match_basis='externalRequestId'
//     ├ ≥2 rows → MATCH_TYPE.NEEDS_REVIEW
//     │           reason='multiple_jobs_for_externalRequestId'
//     └ 0 rows  → continue
//
//   Step 4 — SF leads by phone/email (FALLBACK, never auto-link)
//     Reaches SF leads that were created from non-LB sources
//     (OpenPhone / Cold Call / manual entry / Google / Referral / etc.)
//     OR cross-inquiry rows where the SAME person made an earlier LB
//     inquiry stamped with a DIFFERENT externalRequestId.
//
//     Both cases are ambiguous: a positive match here CANNOT distinguish
//     "same person, same inquiry" from "same person, different inquiry"
//     from "different person, shared phone (household)." Therefore:
//
//     ├ any phone/email match → MATCH_TYPE.NEEDS_REVIEW
//     │                          reason='cross_inquiry_or_non_lb_sf_lead'
//     │                          + matched_sf_lead_ids[] for operator
//     └ no hit → continue
//
//   Step 5 — true no_match (terminal)
//     No SF lead with externalRequestId. No SF customer with lb_lead_id.
//     No customer/job match via phone/email/name. No job with
//     externalRequestId. No SF lead reachable via phone/email.
//     → MATCH_TYPE.NO_MATCH  confidence='none'  match_basis='none'
//
// Return shape (every call):
//
//   {
//     match_type: 'lead_only' | 'customer_job' | 'needs_review' | 'no_match' | 'test_noise',
//     confidence: 'exact' | 'high' | 'medium' | 'low' | 'none',
//     match_basis: 'externalRequestId' | 'lbLeadId' | 'phone' | 'email' | 'manual' | 'none',
//     reason: string | null,                         // populated for needs_review / no_match / test_noise
//     sf_lead_id: number | null,                     // populated for lead_only + customer_job-via-lead
//     sf_lead_stage_name: string | null,             // populated for lead_only
//     sf_customer_id: number | null,                 // populated for customer_job
//     sf_job_id: number | null,                      // populated when picker has a representative job
//     ambiguity_warnings: string[],                  // surfaced from existing matcher when applicable
//     candidates: Array<existing matcher candidate>, // only populated when Step 2 produced candidates
//     step: 0 | 1 | 1.5 | 2 | 3 | 4 | 5,             // which step terminated — for tests/logs
//   }
//
// Hard rules (defensive — enforced by tests):
//
//   - sfCustomerId and sfJobId are NEVER populated for lead_only.
//   - When match_type='lead_only', confidence is ALWAYS 'exact'. Lead-stage
//     ambiguity is impossible because lb_external_request_id is a partial
//     unique index per tenant.
//   - Step 4 never returns customer_job — it can only escalate to
//     needs_review or fall through to Step 5.
//   - The function is READ-ONLY against Supabase. No write paths.
async function findHistoricalMatchType(supabase, { userId, input }) {
  if (!supabase || typeof supabase.from !== 'function') {
    throw new Error('findHistoricalMatchType: supabase required');
  }
  if (userId == null) throw new Error('findHistoricalMatchType: userId required');
  const inp = input || {};

  // ── Step 0: test noise ─────────────────────────────────────────
  if (inp.lb_channel === 'test') {
    return baseResult({
      match_type: MATCH_TYPE.TEST_NOISE,
      reason: 'lb_test_channel',
      step: 0,
    });
  }

  // ── Step 1: leads.lb_external_request_id ───────────────────────
  if (inp.lb_external_request_id) {
    const { data: leadHits, error: leadErr } = await supabase
      .from(LEADS_TABLE)
      .select('id, user_id, first_name, last_name, email, phone, lb_external_request_id, lb_channel, lb_business_id, converted_customer_id, pipeline_id, stage_id, source, created_at')
      .eq('user_id', userId)
      .eq('lb_external_request_id', inp.lb_external_request_id)
      .limit(5);
    if (leadErr) {
      // DB errors are reported back as needs_review so the orchestrator
      // surfaces them instead of silently dropping. Step counter records
      // where it failed.
      return baseResult({
        match_type: MATCH_TYPE.NEEDS_REVIEW,
        reason: 'sf_leads_lookup_error',
        step: 1,
      });
    }
    if (leadHits && leadHits.length > 1) {
      return baseResult({
        match_type: MATCH_TYPE.NEEDS_REVIEW,
        reason: 'multiple_sf_leads_for_externalRequestId',
        match_basis: MATCH_BASIS.EXTERNAL_REQUEST_ID,
        step: 1,
      });
    }
    if (leadHits && leadHits.length === 1) {
      const lead = leadHits[0];
      if (lead.converted_customer_id == null) {
        const stageName = await fetchLeadStageName(supabase, lead.stage_id);
        return baseResult({
          match_type:         MATCH_TYPE.LEAD_ONLY,
          confidence:         'exact',
          match_basis:        MATCH_BASIS.EXTERNAL_REQUEST_ID,
          sf_lead_id:         lead.id,
          sf_lead_stage_name: stageName,
          step:               1,
        });
      }
      // Converted — fetch representative job for the customer
      const repJob = await fetchRepresentativeJobForCustomer(supabase, userId, lead.converted_customer_id);
      return baseResult({
        match_type:     MATCH_TYPE.CUSTOMER_JOB,
        confidence:     'exact',
        match_basis:    MATCH_BASIS.EXTERNAL_REQUEST_ID,
        sf_lead_id:     lead.id,
        sf_customer_id: lead.converted_customer_id,
        sf_job_id:      repJob ? repJob.id : null,
        step:           1,
      });
    }
    // 0 hits → continue
  }

  // ── Step 1.5: customers.lb_lead_id (legacy stamp) ──────────────
  if (inp.lb_lead_id) {
    const { data: custHits, error: custErr } = await supabase
      .from(CUSTOMERS_TABLE)
      .select('id, user_id, first_name, last_name, phone, email, lb_lead_id')
      .eq('user_id', userId)
      .eq('lb_lead_id', inp.lb_lead_id)
      .limit(5);
    if (custErr) {
      return baseResult({
        match_type: MATCH_TYPE.NEEDS_REVIEW,
        reason: 'sf_customers_lookup_error',
        step: 1.5,
      });
    }
    if (custHits && custHits.length > 1) {
      return baseResult({
        match_type: MATCH_TYPE.NEEDS_REVIEW,
        reason: 'multiple_customers_for_lb_lead_id',
        match_basis: MATCH_BASIS.LB_LEAD_ID,
        step: 1.5,
      });
    }
    if (custHits && custHits.length === 1) {
      const cust = custHits[0];
      const repJob = await fetchRepresentativeJobForCustomer(supabase, userId, cust.id);
      return baseResult({
        match_type:     MATCH_TYPE.CUSTOMER_JOB,
        confidence:     'exact',
        match_basis:    MATCH_BASIS.LB_LEAD_ID,
        sf_customer_id: cust.id,
        sf_job_id:      repJob ? repJob.id : null,
        step:           1.5,
      });
    }
  }

  // ── Step 2: existing customer phone/email/name matcher ─────────
  const existingCandidates = await findMatchCandidates(supabase, { userId, input: inp });
  const cands = (existingCandidates && existingCandidates.candidates) || [];
  if (cands.length === 1) {
    const c = cands[0];
    const conf = c.confidence;
    if (conf === 'exact' || conf === 'high') {
      return baseResult({
        match_type:         MATCH_TYPE.CUSTOMER_JOB,
        confidence:         conf,
        match_basis:        inferMatchBasis(c),
        sf_customer_id:     c.sf_customer_id,
        sf_job_id:          c.sf_job_id || null,
        ambiguity_warnings: c.ambiguity_warnings || [],
        candidates:         cands,
        step:               2,
      });
    }
    // medium / low → needs_review with the candidate surfaced
    return baseResult({
      match_type:         MATCH_TYPE.NEEDS_REVIEW,
      confidence:         conf,
      match_basis:        inferMatchBasis(c),
      reason:             'low_confidence_customer_match',
      sf_customer_id:     c.sf_customer_id,
      sf_job_id:          c.sf_job_id || null,
      ambiguity_warnings: c.ambiguity_warnings || [],
      candidates:         cands,
      step:               2,
    });
  }
  if (cands.length > 1) {
    return baseResult({
      match_type:         MATCH_TYPE.NEEDS_REVIEW,
      reason:             'multiple_customer_candidates',
      ambiguity_warnings: ['multiple_customer_candidates'],
      candidates:         cands,
      step:               2,
    });
  }

  // ── Step 3: jobs.lb_external_request_id (legacy stamp) ─────────
  if (inp.lb_external_request_id) {
    const { data: jobHits, error: jobErr } = await supabase
      .from(JOBS_TABLE)
      .select('id, customer_id, status, payment_status, lb_external_request_id, lb_lead_id, created_at')
      .eq('user_id', userId)
      .eq('lb_external_request_id', inp.lb_external_request_id)
      .limit(5);
    if (jobErr) {
      return baseResult({
        match_type: MATCH_TYPE.NEEDS_REVIEW,
        reason: 'sf_jobs_lookup_error',
        step: 3,
      });
    }
    if (jobHits && jobHits.length > 1) {
      return baseResult({
        match_type:  MATCH_TYPE.NEEDS_REVIEW,
        reason:      'multiple_jobs_for_externalRequestId',
        match_basis: MATCH_BASIS.EXTERNAL_REQUEST_ID,
        step:        3,
      });
    }
    if (jobHits && jobHits.length === 1) {
      const j = jobHits[0];
      return baseResult({
        match_type:     MATCH_TYPE.CUSTOMER_JOB,
        confidence:     'exact',
        match_basis:    MATCH_BASIS.EXTERNAL_REQUEST_ID,
        sf_customer_id: j.customer_id,
        sf_job_id:      j.id,
        step:           3,
      });
    }
  }

  // ── Step 4: SF leads by phone/email (NEVER auto-link) ──────────
  //
  // Surfaces (a) leads created in SF from non-LB sources (OpenPhone /
  // Cold Call / manual) whose contact info coincidentally matches an
  // LB inquiry, and (b) cross-inquiry rows where the same person made
  // an earlier LB inquiry under a DIFFERENT externalRequestId. Both
  // cases need operator triage — never link automatically.
  const phone10 = normPhoneLast10(inp.customer_phone);
  const email   = normEmail(inp.customer_email);
  // Yelp-proxy emails are never join-able to SF customer/lead records
  // (they're per-inquiry routing addresses). Skip them in the email arm.
  const skipEmail = !!email && /@messaging\.yelp\.com$/i.test(email);
  if (phone10 || (email && !skipEmail)) {
    const queries = [];
    if (phone10) {
      queries.push(supabase.from(LEADS_TABLE)
        .select('id, first_name, last_name, phone, email, lb_external_request_id, source, converted_customer_id')
        .eq('user_id', userId).ilike('phone', `%${phone10}%`).limit(5));
    }
    if (email && !skipEmail) {
      queries.push(supabase.from(LEADS_TABLE)
        .select('id, first_name, last_name, phone, email, lb_external_request_id, source, converted_customer_id')
        .eq('user_id', userId).ilike('email', email).limit(5));
    }
    const results = await Promise.all(queries.map(q => q.then(r => r, err => ({ data: null, error: err }))));
    const byId = new Map();
    for (const r of results) {
      if (r.error) continue;
      for (const row of (r.data || [])) {
        if (!byId.has(row.id)) byId.set(row.id, row);
      }
    }
    if (byId.size > 0) {
      const matchedLeadIds = Array.from(byId.keys());
      return baseResult({
        match_type:        MATCH_TYPE.NEEDS_REVIEW,
        reason:            'cross_inquiry_or_non_lb_sf_lead',
        match_basis:       phone10 ? MATCH_BASIS.PHONE : MATCH_BASIS.EMAIL,
        matched_sf_lead_ids: matchedLeadIds,
        step:              4,
      });
    }
  }

  // ── Step 5: terminal — true no_match ───────────────────────────
  return baseResult({
    match_type:  MATCH_TYPE.NO_MATCH,
    confidence:  'none',
    match_basis: MATCH_BASIS.NONE,
    reason:      'no_sf_record_anywhere',
    step:        5,
  });
}

/**
 * Build a standard result object with all keys present (null where not
 * populated) so callers don't have to guard each field. Defensive on the
 * hard rule that sfCustomerId/sfJobId stay null for lead_only.
 */
function baseResult(partial) {
  const r = {
    match_type:         partial.match_type,
    confidence:         partial.confidence || 'none',
    match_basis:        partial.match_basis || MATCH_BASIS.NONE,
    reason:             partial.reason || null,
    sf_lead_id:         partial.sf_lead_id || null,
    sf_lead_stage_name: partial.sf_lead_stage_name || null,
    sf_customer_id:     partial.sf_customer_id || null,
    sf_job_id:          partial.sf_job_id || null,
    ambiguity_warnings: partial.ambiguity_warnings || [],
    candidates:         partial.candidates || [],
    matched_sf_lead_ids: partial.matched_sf_lead_ids || [],
    step:               partial.step,
  };
  // Hard invariant: lead_only never carries sfCustomerId/sfJobId.
  if (r.match_type === MATCH_TYPE.LEAD_ONLY) {
    r.sf_customer_id = null;
    r.sf_job_id      = null;
  }
  return r;
}

async function fetchLeadStageName(supabase, stageId) {
  if (stageId == null) return null;
  try {
    const { data } = await supabase.from(LEAD_STAGES_TABLE).select('name').eq('id', stageId).maybeSingle();
    return data && typeof data.name === 'string' ? data.name : null;
  } catch (_) { return null; }
}

async function fetchRepresentativeJobForCustomer(supabase, userId, customerId) {
  if (customerId == null) return null;
  try {
    const { data } = await supabase.from(JOBS_TABLE)
      .select('id, customer_id, status, payment_status, lb_external_request_id, lb_lead_id, lb_channel, lb_business_id, scheduled_date, last_status_changed_at, created_at')
      .eq('user_id', userId).eq('customer_id', customerId)
      .order('created_at', { ascending: true }).limit(20);
    return pickHistoricalRepresentativeJob(data || []);
  } catch (_) { return null; }
}

function inferMatchBasis(candidate) {
  const sigs = Array.isArray(candidate && candidate.match_signals) ? candidate.match_signals : [];
  if (sigs.some(s => /lb_lead_id_already_linked/.test(s))) return MATCH_BASIS.LB_LEAD_ID;
  if (sigs.some(s => /phone/.test(s))) return MATCH_BASIS.PHONE;
  if (sigs.some(s => /email/.test(s))) return MATCH_BASIS.EMAIL;
  // name-only / name+date matches don't have a clean LB-wire match_basis;
  // mark them as 'manual' which is the closest LB enum value.
  return MATCH_BASIS.MANUAL;
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
  findHistoricalMatchType,
  MATCH_TYPE,
  MATCH_BASIS,
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
