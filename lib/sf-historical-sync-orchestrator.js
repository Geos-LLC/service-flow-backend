'use strict';

// SF-driven historical sync orchestrator — Phase 1 (DRY-RUN ONLY).
//
// Flow:
//   1. Pull LB's unlinked candidate leads for the tenant (paginated).
//   2. For each candidate, run the existing matcher
//      (lib/lb-lead-link-matcher.js) against SF data.
//   3. Bucket each candidate into one of:
//        would_link    — exactly 1 candidate, confidence ≥ 'high', no
//                        ambiguity, target SF job unlinked OR same link
//        would_review  — multiple candidates, OR medium confidence, OR
//                        target SF job linked to a DIFFERENT lb_lead,
//                        OR customer match but no SF job
//        would_skip    — zero candidates (no_match), OR low confidence only,
//                        OR per-lead error
//   4. Return per-lead preview + summary.
//
// Phase 1 HARD CONSTRAINTS (enforced by this module):
//   - dryRun is FORCED to true; explicit `dryRun:false` is ignored
//   - NEVER calls lib/lb-lead-link-attacher (no SF DB writes)
//   - NEVER calls linkLeadsBulk (no LB-side mutation)
//   - NEVER enqueues any outbox event
//
// Reuses lib/lb-lead-link-matcher unchanged. The bucketing logic is
// the same as lib/lb-lead-link-bulk's shouldAutoAttach + conflict
// checks, surfaced in three buckets for operator review.

const { fetchCandidates } = require('./lb-historical-sync-client');
const { findMatchCandidates } = require('./lb-lead-link-matcher');

const CONF_RANK = { exact: 4, high: 3, medium: 2, low: 1 };
const MAX_LEADS_DEFAULT = 500;
const MAX_LEADS_HARD_CAP = 2000;     // operator can pass higher; we cap

function shouldAutoLink(candidates) {
  if (!Array.isArray(candidates) || candidates.length !== 1) return false;
  const c = candidates[0];
  if ((CONF_RANK[c.confidence] || 0) < CONF_RANK.high) return false;
  if (Array.isArray(c.ambiguity_warnings) && c.ambiguity_warnings.length > 0) return false;
  return true;
}

/**
 * Map an LB lead (from /candidates) → matcher input shape.
 */
function lbLeadToMatcherInput(lbLead) {
  return {
    lb_lead_id:             lbLead.lb_lead_id             || null,
    lb_external_request_id: lbLead.lb_external_request_id || null,
    lb_channel:             lbLead.lb_channel             || null,
    lb_business_id:         lbLead.lb_business_id         || null,
    customer_phone:         lbLead.customer_phone         || null,
    customer_email:         lbLead.customer_email         || null,
    customer_name:          lbLead.customer_name          || null,
    lead_created_at:        lbLead.lb_created_at || lbLead.created_at || null,
  };
}

/**
 * Categorize one (lb_lead, candidates) pair into a bucket.
 * Returns { bucket, reason, details } where bucket is:
 *   'would_link' | 'would_review' | 'would_skip'
 *
 * Order matters: most-specific reasons first.
 */
function categorize({ lbLead, candidates }) {
  if (!candidates || candidates.length === 0) {
    return { bucket: 'would_skip', reason: 'no_match', candidates: [] };
  }

  // If a single high-confidence candidate exists but its sf_job is
  // already linked to a different lb_external_request_id, that's a
  // conflict for review.
  const single = candidates.length === 1 ? candidates[0] : null;
  if (single) {
    const existing = single.sf_job && single.sf_job.lb_external_request_id;
    const incoming = lbLead.lb_external_request_id;
    if (existing && incoming && existing !== incoming) {
      return { bucket: 'would_review', reason: 'sf_job_linked_to_different_lb_lead', candidates };
    }
  }

  if (shouldAutoLink(candidates)) {
    if (!candidates[0].sf_job_id) {
      // High-confidence customer match but no SF job — needs human review.
      return { bucket: 'would_review', reason: 'customer_match_no_job', candidates };
    }
    return { bucket: 'would_link', reason: null, candidates };
  }

  if (candidates.length > 1) {
    return { bucket: 'would_review', reason: 'multiple_candidates', candidates };
  }
  // candidates.length === 1, confidence below high → low/medium only
  return { bucket: 'would_skip', reason: 'low_confidence', candidates };
}

/**
 * Run the historical sync dry-run for a tenant.
 *
 * @param {object} supabase
 * @param {object} args
 * @param {number} args.tenantId
 * @param {number} [args.maxLeads=500]   - hard-capped at MAX_LEADS_HARD_CAP
 * @param {number} [args.pageSize=100]
 * @param {string|null} [args.lbBusinessId]  - optional LB account scope
 * @param {object} [args.httpClient]
 * @param {object} [args.logger]
 * @returns {Promise<{ok, dry_run:true, phase:'phase_1_dry_run_only', summary, would_link, would_review, would_skip}>}
 */
async function runHistoricalSync(supabase, args) {
  if (!supabase || typeof supabase.from !== 'function') {
    throw new Error('runHistoricalSync: supabase required');
  }
  if (!args || args.tenantId == null) {
    return { ok: false, status: 400, error: 'invalid_arguments', detail: 'tenantId required' };
  }
  const tenantId = Number(args.tenantId);
  const maxLeads = Math.min(
    Number.isFinite(args.maxLeads) ? args.maxLeads : MAX_LEADS_DEFAULT,
    MAX_LEADS_HARD_CAP,
  );
  const pageSize = Number.isFinite(args.pageSize) ? args.pageSize : 100;
  const logger = args.logger || { log() {}, warn() {}, error() {} };

  // Always dry-run in Phase 1. We accept (and ignore) the caller's
  // wishes — the endpoint also overrides to true, defense in depth.
  const DRY_RUN_FORCED = true;

  const wouldLink   = [];
  const wouldReview = [];
  const wouldSkip   = [];
  const summary = {
    fetched_from_lb: 0,
    would_link:      0,
    would_review:    0,
    would_skip:      0,
    errors:          0,
    pages_fetched:   0,
    pagination_truncated: false,
  };

  let cursor = null;
  let fetched = 0;

  while (true) {
    if (fetched >= maxLeads) {
      summary.pagination_truncated = true;
      try { logger.log(`[sf-historical-sync] tenant=${tenantId} stopped pagination at maxLeads=${maxLeads}`); } catch (_) {}
      break;
    }
    const pageRemaining = maxLeads - fetched;
    const requestPageSize = Math.min(pageSize, pageRemaining);

    const page = await fetchCandidates({
      tenantId,
      cursor,
      limit: requestPageSize,
      lbBusinessId: args.lbBusinessId || null,
      onlyUnlinked: true,
      httpClient: args.httpClient,
      now: args.now,
    });
    summary.pages_fetched++;

    if (!page.ok) {
      try { logger.warn(`[sf-historical-sync] tenant=${tenantId} fetchCandidates failed reason=${page.reason} status=${page.status || '-'}`); } catch (_) {}
      return {
        ok:    false,
        status: page.status || 502,
        error: page.reason || 'lb_fetch_failed',
        detail: page.error_description || null,
        partial_summary: summary,
      };
    }

    const leads = Array.isArray(page.leads) ? page.leads : [];
    summary.fetched_from_lb += leads.length;

    for (const lead of leads) {
      const input = lbLeadToMatcherInput(lead);
      let candidates;
      try {
        const out = await findMatchCandidates(supabase, { userId: tenantId, input });
        candidates = out.candidates || [];
      } catch (e) {
        summary.errors++;
        wouldSkip.push(buildBucketEntry(lead, [], 'matcher_error', { error: String(e && e.message || e) }));
        try { logger.error(`[sf-historical-sync] tenant=${tenantId} lead=${lead.lb_lead_id || '-'} matcher error: ${e && e.message}`); } catch (_) {}
        continue;
      }

      const cat = categorize({ lbLead: lead, candidates });
      const entry = buildBucketEntry(lead, cat.candidates, cat.reason);

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

      fetched++;
      if (fetched >= maxLeads) break;
    }

    if (!page.cursor) break;
    cursor = page.cursor;
  }

  try {
    logger.log(`[sf-historical-sync] tenant=${tenantId} dry_run=true fetched=${summary.fetched_from_lb} would_link=${summary.would_link} would_review=${summary.would_review} would_skip=${summary.would_skip} pages=${summary.pages_fetched}`);
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
 * Build the per-lead entry for a bucket. Surfaces the operator-relevant
 * context defined by the Phase-1 spec:
 *   - lb identity (id, external request, channel, lead status)
 *   - sf identity (job_id, customer_id, job status, payment status)
 *   - match confidence + signals
 *   - reason (when bucket != would_link)
 */
function buildBucketEntry(lbLead, candidates, reason, extra) {
  const first = candidates && candidates.length > 0 ? candidates[0] : null;
  const sfJob = first && first.sf_job ? first.sf_job : null;
  return {
    lb_lead_id:             lbLead.lb_lead_id             || null,
    lb_external_request_id: lbLead.lb_external_request_id || null,
    lb_channel:             lbLead.lb_channel             || null,
    lb_business_id:         lbLead.lb_business_id         || null,
    lb_lead_status:         lbLead.lb_status              || null,
    lb_lead_created_at:     lbLead.lb_created_at          || null,
    sf_customer_id:         first ? first.sf_customer_id : null,
    sf_job_id:              first ? first.sf_job_id      : null,
    sf_job_status:          sfJob ? sfJob.status         : null,
    sf_payment_status:      sfJob ? sfJob.payment_status : null,
    confidence:             first ? first.confidence     : null,
    match_basis:            first ? (first.match_signals || []) : [],
    reason:                 reason || null,
    candidate_count:        candidates ? candidates.length : 0,
    ambiguity_warnings:     first ? (first.ambiguity_warnings || []) : [],
    ...(extra || {}),
  };
}

module.exports = {
  runHistoricalSync,
  // exposed for tests
  shouldAutoLink,
  categorize,
  lbLeadToMatcherInput,
  buildBucketEntry,
  MAX_LEADS_DEFAULT,
  MAX_LEADS_HARD_CAP,
};
