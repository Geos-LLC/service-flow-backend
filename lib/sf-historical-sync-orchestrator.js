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

const { fetchCandidates } = require('./lb-historical-sync-client');
const { findMatchCandidates } = require('./lb-lead-link-matcher');

const CONF_RANK = { exact: 4, high: 3, medium: 2, low: 1 };
const MAX_LEADS_DEFAULT = 500;
const MAX_LEADS_HARD_CAP = 500;        // LB caps batch at 500 per call
const COMM_SETTINGS_TABLE = 'communication_settings';

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

module.exports = {
  runHistoricalSync,
  // exposed for tests
  resolveLbUserId,
  shouldAutoLink,
  categorize,
  lbLeadToMatcherInput,
  buildBucketEntry,
  MAX_LEADS_DEFAULT,
  MAX_LEADS_HARD_CAP,
};
