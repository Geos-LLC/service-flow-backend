'use strict';

// SF-driven historical sync orchestrator — Phase 1 (DRY-RUN ONLY).
//
// Flow (per LB's production contract):
//   1. Look up the tenant's LB user UUID from communication_settings
//      (`leadbridge_user_id`). Required for LB's /candidates request.
//   2. Call LB /candidates with { user_id, sync_statuses: ['pending'],
//      limit: 500 }. Single batch — no cursor pagination. Pagination
//      is state-transition based on LB's side (linked rows move out of
//      pending). In Phase 1 we don't apply, so we just fetch one batch
//      and surface `more_may_exist` if count === limit.
//   3. Map LB's camelCase candidate fields → matcher input shape.
//   4. For each candidate, run lib/lb-lead-link-matcher against SF data.
//   5. Bucket each candidate into one of:
//        would_link    — exactly 1 candidate, confidence ≥ 'high', no
//                        ambiguity, target SF job unlinked OR same link
//        would_review  — multiple candidates, OR target SF job linked to
//                        a DIFFERENT lb_lead, OR customer match but no
//                        SF job
//        would_skip    — zero candidates (no_match) OR single low/medium
//                        confidence candidate OR per-lead error
//   6. Return per-lead preview + summary.
//
// Phase 1 HARD CONSTRAINTS (enforced by this module):
//   - dryRun is FORCED to true; explicit `dryRun:false` is ignored
//   - NEVER calls lib/lb-lead-link-attacher (no SF DB writes)
//   - NEVER calls linkLeadsBulk (no LB-side mutation)
//   - NEVER enqueues any outbox event
//
// Reuses lib/lb-lead-link-matcher unchanged.

const { fetchCandidates, linkLeadsBulk } = require('./lb-historical-sync-client');
const { findMatchCandidates } = require('./lb-lead-link-matcher');
const { attachLbLink } = require('./lb-lead-link-attacher');
const applyLock = require('./sf-historical-apply-lock');

const CONF_RANK = { exact: 4, high: 3, medium: 2, low: 1 };
const MAX_LEADS_DEFAULT = 500;
const MAX_LEADS_HARD_CAP = 500;        // LB caps batch at 500 per call
const MAX_APPLY_BATCH    = 100;        // operator-approved rows per apply call
const COMM_SETTINGS_TABLE = 'communication_settings';
const JOBS_TABLE          = 'jobs';
const APPLY_ACTOR         = 'sf_historical_apply';
const APPLY_REASON        = 'historical_sync_apply';

function shouldAutoLink(candidates) {
  if (!Array.isArray(candidates) || candidates.length !== 1) return false;
  const c = candidates[0];
  if ((CONF_RANK[c.confidence] || 0) < CONF_RANK.high) return false;
  if (Array.isArray(c.ambiguity_warnings) && c.ambiguity_warnings.length > 0) return false;
  return true;
}

/**
 * Map an LB candidate (LB's camelCase production shape) → matcher input.
 *
 * LB candidate fields (per the contract):
 *   leadId, externalRequestId, platform, businessId,
 *   customerName, customerPhone, customerEmail,
 *   status, createdAt, statusUpdatedAt, ageDays
 */
function lbLeadToMatcherInput(lbCandidate) {
  if (!lbCandidate || typeof lbCandidate !== 'object') {
    return { lb_lead_id: null, lb_external_request_id: null, lb_channel: null,
             lb_business_id: null, customer_phone: null, customer_email: null,
             customer_name: null, lead_created_at: null };
  }
  return {
    lb_lead_id:             lbCandidate.leadId             || null,
    lb_external_request_id: lbCandidate.externalRequestId  || null,
    lb_channel:             lbCandidate.platform           || null,
    lb_business_id:         lbCandidate.businessId         || null,
    customer_phone:         lbCandidate.customerPhone      || null,
    customer_email:         lbCandidate.customerEmail      || null,
    customer_name:          lbCandidate.customerName       || null,
    lead_created_at:        lbCandidate.createdAt          || null,
  };
}

/**
 * Categorize one (LB candidate, matched SF rows) pair into a bucket.
 *
 * @param {object} args
 * @param {object} args.lbCandidate   - LB candidate (camelCase fields)
 * @param {Array<object>} args.matched - matcher output (sf-side rows)
 * @returns {{ bucket: 'would_link'|'would_review'|'would_skip',
 *             reason: string|null,
 *             matched: Array<object> }}
 */
function categorize({ lbCandidate, matched }) {
  const matches = Array.isArray(matched) ? matched : [];
  if (matches.length === 0) {
    return { bucket: 'would_skip', reason: 'no_match', matched: [] };
  }

  // If a single high-confidence candidate exists but its sf_job is
  // already linked to a different lb_external_request_id, that's a
  // conflict for review.
  const single = matches.length === 1 ? matches[0] : null;
  if (single) {
    const existing = single.sf_job && single.sf_job.lb_external_request_id;
    const incoming = lbCandidate && lbCandidate.externalRequestId;
    if (existing && incoming && existing !== incoming) {
      return { bucket: 'would_review', reason: 'sf_job_linked_to_different_lb_lead', matched: matches };
    }
  }

  if (shouldAutoLink(matches)) {
    if (!matches[0].sf_job_id) {
      // High-confidence customer match but no SF job — needs human review.
      return { bucket: 'would_review', reason: 'customer_match_no_job', matched: matches };
    }
    return { bucket: 'would_link', reason: null, matched: matches };
  }

  if (matches.length > 1) {
    return { bucket: 'would_review', reason: 'multiple_candidates', matched: matches };
  }
  // matches.length === 1, confidence below high → low/medium only
  return { bucket: 'would_skip', reason: 'low_confidence', matched: matches };
}

/**
 * Look up the LB user UUID for a SF tenant from communication_settings.
 *
 * @param {object} supabase
 * @param {number} tenantId   - SF user_id
 * @returns {Promise<{ok:true, lbUserId:string} | {ok:false, status, error, detail?}>}
 */
async function resolveLbUserId(supabase, tenantId) {
  const { data, error } = await supabase
    .from(COMM_SETTINGS_TABLE)
    .select('leadbridge_user_id, leadbridge_connected')
    .eq('user_id', tenantId)
    .maybeSingle();
  if (error) return { ok: false, status: 503, error: 'db_error', detail: error.message };
  if (!data)  return { ok: false, status: 404, error: 'communication_settings_not_found' };
  if (!data.leadbridge_connected) return { ok: false, status: 409, error: 'lb_not_connected' };
  if (!data.leadbridge_user_id)    return { ok: false, status: 409, error: 'lb_user_id_missing', detail: 'leadbridge_user_id is null on communication_settings — tenant must reconnect' };
  return { ok: true, lbUserId: String(data.leadbridge_user_id) };
}

/**
 * Run the historical sync dry-run for a tenant.
 *
 * Per LB's production contract: single batch (no cursor pagination).
 * If LB returns count === requested limit, surface `more_may_exist: true`
 * so the operator knows additional candidates remain (they'll surface on
 * the next call after Phase-2 apply moves linked rows out of `pending`).
 *
 * @param {object} supabase
 * @param {object} args
 * @param {number} args.tenantId
 * @param {number} [args.maxLeads=500]   - LB-capped at 500 per call
 * @param {Array<string>} [args.syncStatuses=['pending']]
 * @param {string} [args.status]         - optional LB lead status filter
 *                                         ("scheduled" | "completed" | ...).
 *                                         Forwarded to LB only when provided.
 * @param {object} [args.httpClient]
 * @param {object} [args.logger]
 * @returns {Promise<object>}
 */
async function runHistoricalSync(supabase, args) {
  if (!supabase || typeof supabase.from !== 'function') {
    throw new Error('runHistoricalSync: supabase required');
  }
  if (!args || args.tenantId == null) {
    return { ok: false, status: 400, error: 'invalid_arguments', detail: 'tenantId required' };
  }
  const tenantId = Number(args.tenantId);
  const limit = Math.min(
    Number.isFinite(args.maxLeads) ? args.maxLeads : MAX_LEADS_DEFAULT,
    MAX_LEADS_HARD_CAP,
  );
  const logger = args.logger || { log() {}, warn() {}, error() {} };

  // Always dry-run in Phase 1. We accept (and ignore) the caller's
  // wishes — the endpoint also overrides to true, defense in depth.
  const DRY_RUN_FORCED = true;

  // 1. Resolve the LB user UUID for this tenant.
  const lookup = await resolveLbUserId(supabase, tenantId);
  if (!lookup.ok) {
    try { logger.warn(`[sf-historical-sync] tenant=${tenantId} lb-user lookup failed: ${lookup.error}`); } catch (_) {}
    return { ok: false, status: lookup.status, error: lookup.error, detail: lookup.detail || null };
  }
  const lbUserId = lookup.lbUserId;

  // 2. Fetch one batch from LB.
  const status = (typeof args.status === 'string' && args.status.length > 0) ? args.status : undefined;
  const page = await fetchCandidates({
    lbUserId,
    syncStatuses: Array.isArray(args.syncStatuses) ? args.syncStatuses : ['pending'],
    status,
    limit,
    httpClient: args.httpClient,
    now: args.now,
  });

  if (!page.ok) {
    try { logger.warn(`[sf-historical-sync] tenant=${tenantId} fetchCandidates failed reason=${page.reason} status=${page.status || '-'}`); } catch (_) {}
    return {
      ok:     false,
      status: page.status || 502,
      error:  page.reason || 'lb_fetch_failed',
      detail: page.error_description || null,
    };
  }

  const candidates = Array.isArray(page.candidates) ? page.candidates : [];
  const wouldLink   = [];
  const wouldReview = [];
  const wouldSkip   = [];
  const summary = {
    lb_user_id:      lbUserId,
    fetched_from_lb: candidates.length,
    requested_limit: limit,
    status_filter:   status || null,
    would_link:      0,
    would_review:    0,
    would_skip:      0,
    errors:          0,
    more_may_exist:  !!page.more_may_exist,
  };

  // 3. For each LB candidate, run the matcher against SF data.
  for (const lbCandidate of candidates) {
    const matcherInput = lbLeadToMatcherInput(lbCandidate);
    let matched;
    try {
      const out = await findMatchCandidates(supabase, { userId: tenantId, input: matcherInput });
      matched = out.candidates || [];
    } catch (e) {
      summary.errors++;
      wouldSkip.push(buildBucketEntry(lbCandidate, [], 'matcher_error', { error: String(e && e.message || e) }));
      try { logger.error(`[sf-historical-sync] tenant=${tenantId} lead=${lbCandidate.leadId || '-'} matcher error: ${e && e.message}`); } catch (_) {}
      continue;
    }

    const cat = categorize({ lbCandidate, matched });
    const entry = buildBucketEntry(lbCandidate, cat.matched, cat.reason);

    if (cat.bucket === 'would_link') {
      wouldLink.push(entry);
      summary.would_link++;
    } else if (cat.bucket === 'would_review') {
      wouldReview.push(entry);
      summary.would_review++;
    } else {
      wouldSkip.push(entry);
      summary.would_skip++;
    }
  }

  try {
    logger.log(`[sf-historical-sync] tenant=${tenantId} lb_user=${lbUserId} dry_run=true status=${status || '-'} fetched=${summary.fetched_from_lb} would_link=${summary.would_link} would_review=${summary.would_review} would_skip=${summary.would_skip} more_may_exist=${summary.more_may_exist}`);
  } catch (_) {}

  return {
    ok: true,
    dry_run: DRY_RUN_FORCED,
    phase: 'phase_1_dry_run_only',
    summary,
    would_link: wouldLink,
    would_review: wouldReview,
    would_skip: wouldSkip,
  };
}

/**
 * Build the per-lead entry for a bucket. Reads LB's camelCase candidate
 * shape directly. Surfaces operator-relevant context per the Phase-1 spec:
 *   - LB identity     (leadId, externalRequestId, platform, businessId, status)
 *   - LB context      (createdAt, statusUpdatedAt, ageDays, customerName)
 *   - SF identity     (sf_job_id, sf_customer_id, sf_job_status, sf_payment_status)
 *   - match confidence + signals
 *   - reason (when bucket != would_link)
 */
function buildBucketEntry(lbCandidate, matched, reason, extra) {
  const lb = lbCandidate || {};
  const first = matched && matched.length > 0 ? matched[0] : null;
  const sfJob = first && first.sf_job ? first.sf_job : null;
  return {
    lb_lead_id:             lb.leadId             || null,
    lb_external_request_id: lb.externalRequestId  || null,
    lb_channel:             lb.platform           || null,
    lb_business_id:         lb.businessId         || null,
    lb_lead_status:         lb.status             || null,
    lb_lead_created_at:     lb.createdAt          || null,
    lb_status_updated_at:   lb.statusUpdatedAt    || null,
    lb_age_days:            Number.isFinite(lb.ageDays) ? lb.ageDays : null,
    lb_customer_name:       lb.customerName       || null,
    sf_customer_id:         first ? first.sf_customer_id : null,
    sf_job_id:              first ? first.sf_job_id      : null,
    sf_job_status:          sfJob ? sfJob.status         : null,
    sf_payment_status:      sfJob ? sfJob.payment_status : null,
    confidence:             first ? first.confidence     : null,
    match_basis:            first ? (first.match_signals || []) : [],
    reason:                 reason || null,
    candidate_count:        matched ? matched.length : 0,
    ambiguity_warnings:     first ? (first.ambiguity_warnings || []) : [],
    ...(extra || {}),
  };
}

// ──────────────────────────────────────────────────────────────────────
// Phase 2 — apply mode
// ──────────────────────────────────────────────────────────────────────
//
// Order of operations (MANDATORY — LB consents to each row before SF
// persists anything):
//
//   1. Acquire per-tenant lock (row-based, migration 064). Fail-fast 409
//      if another caller holds it.
//   2. Resolve LB user UUID — same as Phase 1.
//   3. Fetch fresh candidates from LB with the same filters the operator
//      saw in preview.
//   4. Run matcher against SF data for each candidate.
//   5. For each operator-supplied { lb_lead_id, sf_job_id }:
//        - check fresh matcher result for that lead
//        - apply isApplicable() gate → if fails, skipped_ineligible
//        - compare against operator's expected sf_job_id → if differs,
//          skipped_drift; halt if require_no_drift && drift seen
//        - check jobs.lb_lead_id directly — if already set, skip
//          (skipped_already_linked, no LB call for that row)
//   6. POST eligible rows to LB /link-leads-bulk. If LB infra fails →
//      502, NO SF writes.
//   7. For each row in LB's applied[]: call attachLbLink with
//      actor='sf_historical_apply'. The attacher handles audit row,
//      conditional jobs/customers update, deterministic outbox event.
//   8. Release lock (always, in finally).
//
// `occurred_at` in the LB payload uses jobs.last_status_changed_at,
// fallback jobs.updated_at. Never now() — historical truth.

/**
 * Phase-2 apply gate. Stricter than Phase-1's shouldAutoLink because
 * apply writes through to LB and SF state.
 *
 * @param {object} args
 * @param {object} args.lbCandidate    - LB's camelCase candidate
 * @param {Array<object>} args.matched - matcher output (sf-side rows)
 * @returns {{ ok: true, candidate: object } | { ok: false, reason: string }}
 */
function isApplicable({ lbCandidate, matched }) {
  if (!lbCandidate || !lbCandidate.leadId) {
    return { ok: false, reason: 'lb_lead_id_missing' };
  }
  if (!Array.isArray(matched) || matched.length === 0) {
    return { ok: false, reason: 'no_match' };
  }
  if (matched.length !== 1) {
    return { ok: false, reason: 'multiple_candidates' };
  }
  const c = matched[0];
  if ((CONF_RANK[c.confidence] || 0) < CONF_RANK.high) {
    return { ok: false, reason: 'confidence_below_threshold' };
  }
  if (Array.isArray(c.ambiguity_warnings) && c.ambiguity_warnings.length > 0) {
    return { ok: false, reason: 'ambiguity_warnings_present' };
  }
  if (c.sf_job_id == null) {
    return { ok: false, reason: 'sf_job_id_missing' };
  }
  return { ok: true, candidate: c };
}

/**
 * Build the per-match payload the SF orchestrator hands to
 * linkLeadsBulk. Field names are LB's production contract — passed
 * through verbatim by lb-historical-sync-client.linkLeadsBulk.
 *
 * occurred_at: jobs.last_status_changed_at, fallback jobs.updated_at.
 * Never now() — preserves historical truth.
 */
function buildLbApplyMatch({ lbCandidate, matchedCandidate, sfJob }) {
  return {
    lb_lead_id:        lbCandidate.leadId,
    sf_job_id:         matchedCandidate.sf_job_id,
    sf_customer_id:    matchedCandidate.sf_customer_id,
    confidence:        matchedCandidate.confidence,
    match_basis:       Array.isArray(matchedCandidate.match_signals) ? matchedCandidate.match_signals : [],
    sf_status:         (sfJob && sfJob.status)         || null,
    sf_payment_status: (sfJob && sfJob.payment_status) || null,
    occurred_at:       (sfJob && (sfJob.last_status_changed_at || sfJob.updated_at)) || null,
    reason:            APPLY_REASON,
  };
}

function applySummaryShell(lbUserId, requested, statusFilter) {
  return {
    lb_user_id:           lbUserId,
    fetched_from_lb:      0,
    requested,
    status_filter:        statusFilter || null,
    applied:              0,
    rejected:             0,
    skipped_drift:        0,
    skipped_ineligible:   0,
    skipped_already_linked: 0,
    errors:               0,
  };
}

/**
 * Phase-2 apply: take operator-approved (lb_lead_id, sf_job_id) pairs,
 * re-validate against fresh LB state + matcher, call LB
 * /link-leads-bulk, then attachLbLink each LB-confirmed row.
 *
 * @param {object} supabase
 * @param {object} args
 * @param {number} args.tenantId
 * @param {Array<{lb_lead_id:string, sf_job_id:number}>} args.expectedMatches
 * @param {boolean} [args.requireNoDrift=true]
 * @param {string}  [args.status]                    - LB status filter (same as preview)
 * @param {Array<string>} [args.syncStatuses=['pending']]
 * @param {number}  [args.maxLeads=500]              - fetch cap
 * @param {object}  [args.httpClient]
 * @param {object}  [args.logger]
 * @param {string}  [args.sourceInstance]
 * @returns {Promise<object>}
 */
async function runHistoricalSyncApply(supabase, args) {
  if (!supabase || typeof supabase.from !== 'function') {
    throw new Error('runHistoricalSyncApply: supabase required');
  }
  if (!args || args.tenantId == null) {
    return { ok: false, status: 400, error: 'invalid_arguments', detail: 'tenantId required' };
  }
  if (!Array.isArray(args.expectedMatches) || args.expectedMatches.length === 0) {
    return { ok: false, status: 400, error: 'apply_matches_required', detail: 'expected_matches array required and non-empty' };
  }
  if (args.expectedMatches.length > MAX_APPLY_BATCH) {
    return { ok: false, status: 400, error: 'apply_batch_too_large', detail: `max ${MAX_APPLY_BATCH} matches per call` };
  }

  const tenantId      = Number(args.tenantId);
  const requireNoDrift = args.requireNoDrift !== false;   // default TRUE
  const limit         = Math.min(Number.isFinite(args.maxLeads) ? args.maxLeads : MAX_LEADS_DEFAULT, MAX_LEADS_HARD_CAP);
  const status        = (typeof args.status === 'string' && args.status.length > 0) ? args.status : undefined;
  const syncStatuses  = Array.isArray(args.syncStatuses) ? args.syncStatuses : ['pending'];
  const logger        = args.logger || { log() {}, warn() {}, error() {} };
  const sourceInstance = args.sourceInstance || process.env.SF_SOURCE_INSTANCE || process.env.SF_INSTANCE || 'sf-prod';

  // Normalize operator input into a lookup map { lb_lead_id → expected_sf_job_id }.
  const expectedByLead = new Map();
  for (const m of args.expectedMatches) {
    if (!m || typeof m.lb_lead_id !== 'string' || m.sf_job_id == null) {
      return { ok: false, status: 400, error: 'apply_matches_required', detail: 'each expected_matches row needs lb_lead_id (string) + sf_job_id' };
    }
    expectedByLead.set(m.lb_lead_id, Number(m.sf_job_id));
  }
  const requested = expectedByLead.size;

  // 1. Acquire per-tenant lock.
  const lockNote = `apply tenant=${tenantId} requested=${requested}`;
  const lock = await applyLock.tryAcquire(supabase, tenantId, { note: lockNote });
  if (!lock.ok) {
    const status409 = lock.reason === 'apply_in_progress' ? 409 : 503;
    try { logger.warn(`[sf-historical-apply] tenant=${tenantId} lock failed: ${lock.reason}`); } catch (_) {}
    return { ok: false, status: status409, error: lock.reason, detail: lock.detail || null };
  }

  try {
    // 2. Resolve LB user UUID.
    const lookup = await resolveLbUserId(supabase, tenantId);
    if (!lookup.ok) {
      try { logger.warn(`[sf-historical-apply] tenant=${tenantId} lb-user lookup failed: ${lookup.error}`); } catch (_) {}
      return { ok: false, status: lookup.status, error: lookup.error, detail: lookup.detail || null };
    }
    const lbUserId = lookup.lbUserId;
    const summary  = applySummaryShell(lbUserId, requested, status);

    const applied         = [];
    const rejected        = [];
    const skippedDrift    = [];
    const skippedIneligible = [];
    const skippedAlreadyLinked = [];

    // 3. Fresh fetch from LB.
    const page = await fetchCandidates({
      lbUserId, syncStatuses, status, limit,
      httpClient: args.httpClient, now: args.now,
    });
    if (!page.ok) {
      try { logger.warn(`[sf-historical-apply] tenant=${tenantId} fetchCandidates failed reason=${page.reason} status=${page.status || '-'}`); } catch (_) {}
      return { ok: false, status: page.status || 502, error: page.reason || 'lb_fetch_failed', detail: page.error_description || null };
    }
    const freshCandidates = Array.isArray(page.candidates) ? page.candidates : [];
    summary.fetched_from_lb = freshCandidates.length;
    const candidateByLead = new Map(freshCandidates.map(c => [c.leadId, c]));

    // 4. Re-run matcher for each fresh candidate (only for leads the
    //    operator approved — no need to score the others). Build the
    //    apply-eligible set.
    const eligibleRows = [];   // { lbCandidate, matched, sfJob }
    for (const [lbLeadId, expectedSfJobId] of expectedByLead.entries()) {
      const lbCandidate = candidateByLead.get(lbLeadId);
      if (!lbCandidate) {
        // Plan drift: lead no longer in LB's response.
        skippedDrift.push({ lb_lead_id: lbLeadId, expected_sf_job_id: expectedSfJobId, current_sf_job_id: null, reason: 'plan_drift_no_longer_pending' });
        summary.skipped_drift++;
        continue;
      }

      let matched;
      try {
        const matcherInput = lbLeadToMatcherInput(lbCandidate);
        const out = await findMatchCandidates(supabase, { userId: tenantId, input: matcherInput });
        matched = out.candidates || [];
      } catch (e) {
        summary.errors++;
        skippedIneligible.push({ lb_lead_id: lbLeadId, reason: 'matcher_error', error: String(e && e.message || e) });
        try { logger.error(`[sf-historical-apply] tenant=${tenantId} lead=${lbLeadId} matcher error: ${e && e.message}`); } catch (_) {}
        continue;
      }

      const elig = isApplicable({ lbCandidate, matched });
      if (!elig.ok) {
        // Lower confidence / ambiguity / multiple candidates → drift
        // (when the operator originally approved it as would_link).
        skippedDrift.push({
          lb_lead_id:         lbLeadId,
          expected_sf_job_id: expectedSfJobId,
          current_sf_job_id:  (matched[0] && matched[0].sf_job_id) || null,
          reason:             'plan_drift_' + elig.reason,
        });
        summary.skipped_drift++;
        continue;
      }

      const candidate = elig.candidate;
      if (Number(candidate.sf_job_id) !== expectedSfJobId) {
        skippedDrift.push({
          lb_lead_id:         lbLeadId,
          expected_sf_job_id: expectedSfJobId,
          current_sf_job_id:  candidate.sf_job_id,
          reason:             'plan_drift_different_sf_job',
        });
        summary.skipped_drift++;
        continue;
      }

      // Pre-LB SF-state check: jobs.lb_lead_id already set → skip.
      const { data: existingJob, error: jobErr } = await supabase.from(JOBS_TABLE)
        .select('id, user_id, status, payment_status, last_status_changed_at, updated_at, lb_lead_id, lb_external_request_id, lb_channel, lb_business_id')
        .eq('id', candidate.sf_job_id).eq('user_id', tenantId).maybeSingle();
      if (jobErr) {
        summary.errors++;
        skippedIneligible.push({ lb_lead_id: lbLeadId, reason: 'sf_job_read_failed', error: jobErr.message });
        continue;
      }
      if (!existingJob) {
        skippedDrift.push({ lb_lead_id: lbLeadId, expected_sf_job_id: expectedSfJobId, current_sf_job_id: null, reason: 'plan_drift_sf_job_missing' });
        summary.skipped_drift++;
        continue;
      }
      if (existingJob.lb_lead_id) {
        skippedAlreadyLinked.push({
          lb_lead_id:         lbLeadId,
          sf_job_id:          existingJob.id,
          existing_lb_lead_id: existingJob.lb_lead_id,
        });
        summary.skipped_already_linked++;
        continue;
      }

      eligibleRows.push({ lbCandidate, matchedCandidate: candidate, sfJob: existingJob });
    }

    // 5. If require_no_drift and any drift seen → halt before LB call.
    if (requireNoDrift && summary.skipped_drift > 0) {
      try { logger.warn(`[sf-historical-apply] tenant=${tenantId} drift halt: ${summary.skipped_drift} rows`); } catch (_) {}
      return {
        ok: false,
        status: 409,
        error: 'plan_drift_detected',
        detail: 'one or more operator-approved rows have drifted; halt because require_no_drift=true',
        summary,
        skipped_drift: skippedDrift,
      };
    }

    // 6. POST eligible rows to LB /link-leads-bulk. If no eligible rows,
    //    skip the LB call entirely (still return per-row outcomes for
    //    drift/ineligible/already_linked).
    let lbResponse = null;
    if (eligibleRows.length > 0) {
      const matches = eligibleRows.map(r => buildLbApplyMatch({
        lbCandidate:      r.lbCandidate,
        matchedCandidate: r.matchedCandidate,
        sfJob:            r.sfJob,
      }));
      lbResponse = await linkLeadsBulk({
        lbUserId, matches,
        httpClient: args.httpClient, now: args.now,
      });
      if (!lbResponse.ok) {
        const reason = lbResponse.reason || 'lb_apply_failed';
        const httpStatus = reason === 'lb_unreachable' ? 502
                         : reason === 'invalid_signature' ? 502
                         : (lbResponse.status >= 500 ? 502 : 502);
        try { logger.warn(`[sf-historical-apply] tenant=${tenantId} LB apply failed reason=${reason} status=${lbResponse.status || '-'}`); } catch (_) {}
        return { ok: false, status: httpStatus, error: reason === 'lb_unreachable' ? 'lb_unreachable' : 'lb_apply_failed', detail: lbResponse.error_description || null };
      }
    }

    const lbApplied  = lbResponse && Array.isArray(lbResponse.applied)  ? lbResponse.applied  : [];
    const lbRejected = lbResponse && Array.isArray(lbResponse.rejected) ? lbResponse.rejected : [];
    const appliedSet = new Set(lbApplied.map(r => r.lb_lead_id));

    // 7. For each LB-confirmed row, run attachLbLink.
    for (const row of eligibleRows) {
      if (!appliedSet.has(row.lbCandidate.leadId)) {
        const r = lbRejected.find(x => x.lb_lead_id === row.lbCandidate.leadId);
        rejected.push({
          lb_lead_id: row.lbCandidate.leadId,
          sf_job_id:  row.matchedCandidate.sf_job_id,
          reason:     (r && r.reason) || 'lb_did_not_confirm',
        });
        summary.rejected++;
        continue;
      }

      const attachInput = {
        sf_job_id:               row.matchedCandidate.sf_job_id,
        lb_external_request_id:  row.lbCandidate.externalRequestId,
        lb_channel:              row.lbCandidate.platform,
        lb_business_id:          row.lbCandidate.businessId || null,
        lb_lead_id:              row.lbCandidate.leadId,
        match_confidence:        row.matchedCandidate.confidence,
        match_signals:           Array.isArray(row.matchedCandidate.match_signals) ? row.matchedCandidate.match_signals : [],
      };

      let attachResult;
      try {
        attachResult = await attachLbLink(supabase, {
          userId: tenantId,
          input:  attachInput,
          sourceInstance,
          actor:  APPLY_ACTOR,
        });
      } catch (e) {
        summary.errors++;
        rejected.push({ lb_lead_id: row.lbCandidate.leadId, sf_job_id: row.matchedCandidate.sf_job_id, reason: 'sf_attach_threw', error: String(e && e.message || e) });
        try { logger.error(`[sf-historical-apply] tenant=${tenantId} lead=${row.lbCandidate.leadId} attach threw: ${e && e.message}`); } catch (_) {}
        continue;
      }
      if (!attachResult || !attachResult.ok) {
        summary.errors++;
        rejected.push({
          lb_lead_id: row.lbCandidate.leadId,
          sf_job_id:  row.matchedCandidate.sf_job_id,
          reason:     'sf_attach_failed_' + ((attachResult && attachResult.error) || 'unknown'),
          detail:     attachResult && attachResult.detail || null,
        });
        continue;
      }

      applied.push({
        lb_lead_id:       row.lbCandidate.leadId,
        sf_job_id:        row.matchedCandidate.sf_job_id,
        sf_customer_id:   row.matchedCandidate.sf_customer_id,
        sf_managed:       true,
        action:           attachResult.action,
        outbox_event_id:  attachResult.synthetic_status_event_id,
        outbox_enqueued:  attachResult.synthetic_status_event_enqueued,
        outbox_duplicate: attachResult.synthetic_status_event_duplicate,
      });
      summary.applied++;
    }

    try {
      logger.log(`[sf-historical-apply] tenant=${tenantId} lb_user=${lbUserId} requested=${requested} applied=${summary.applied} rejected=${summary.rejected} skipped_drift=${summary.skipped_drift} skipped_ineligible=${summary.skipped_ineligible} skipped_already_linked=${summary.skipped_already_linked} errors=${summary.errors}`);
    } catch (_) {}

    return {
      ok:    true,
      phase: 'phase_2_apply',
      summary,
      applied,
      rejected,
      skipped_drift:          skippedDrift,
      skipped_ineligible:     skippedIneligible,
      skipped_already_linked: skippedAlreadyLinked,
    };
  } finally {
    await applyLock.release(supabase, tenantId);
  }
}

module.exports = {
  runHistoricalSync,
  runHistoricalSyncApply,
  // exposed for tests
  resolveLbUserId,
  shouldAutoLink,
  isApplicable,
  categorize,
  lbLeadToMatcherInput,
  buildBucketEntry,
  buildLbApplyMatch,
  MAX_LEADS_DEFAULT,
  MAX_LEADS_HARD_CAP,
  MAX_APPLY_BATCH,
  APPLY_ACTOR,
  APPLY_REASON,
};
