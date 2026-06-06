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
const { findMatchCandidates, findHistoricalMatchType, MATCH_TYPE } = require('./lb-lead-link-matcher');
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

// sync_scope — operator-selectable filter set for the LB /candidates pull.
//
//   pending_only   (default, back-compat)
//     LB returns only syncStatus IN (pending, NULL). Matches current
//     behavior — fast, safe for routine reconciliation. Misses leads
//     that LB marked terminal (syncStatus='skipped' for status IN
//     {lost, cancelled, no_show, archived}).
//
//   full_reconcile (post-reconnect or operator full re-sync)
//     LB returns syncStatus IN (pending, skipped, needs_review, failed,
//     no_match) PLUS NULL. Surfaces the LB rows that lifecycle-terminal
//     statuses (notably 'lost' set by lb_automation) hid from earlier
//     pending-only polls. The new categorize() rule
//     `sf_truth_overrides_lb_automation_lost` only fires under this scope
//     because the rule's input rows are exactly the ones full_reconcile
//     newly exposes.
const SCOPE_PENDING_ONLY   = 'pending_only';
const SCOPE_FULL_RECONCILE = 'full_reconcile';
const VALID_SYNC_SCOPES    = Object.freeze([SCOPE_PENDING_ONLY, SCOPE_FULL_RECONCILE]);
const DEFAULT_SYNC_STATUSES_BY_SCOPE = Object.freeze({
  [SCOPE_PENDING_ONLY]:   Object.freeze(['pending']),
  [SCOPE_FULL_RECONCILE]: Object.freeze(['pending', 'skipped', 'needs_review', 'failed', 'no_match']),
});

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
 * Buckets:
 *   would_link     — apply-eligible: single high-conf match, no conflict
 *   would_review   — needs operator: multiple matches, conflicts, or
 *                    missing SF job
 *   already_linked — LB's sfJobId already matches the matcher's pick,
 *                    no action needed (NEW — protects existing links
 *                    from being "re-applied" under full_reconcile reruns)
 *   would_skip     — no match, low confidence, or remap-suppressed
 *
 * @param {object} args
 * @param {object} args.lbCandidate   - LB candidate (camelCase fields)
 * @param {Array<object>} args.matched - matcher output (sf-side rows)
 * @returns {{ bucket: 'would_link'|'would_review'|'already_linked'|'would_skip',
 *             reason: string|null,
 *             matched: Array<object> }}
 */
function categorize({ lbCandidate, matched }) {
  const matches = Array.isArray(matched) ? matched : [];
  const single = matches.length === 1 ? matches[0] : null;

  // ── already_linked (NEW) ──
  //
  // LB's row already pins to the same sf_job the matcher would pick.
  // Emit FIRST so reruns of full_reconcile never re-apply an existing
  // link and so the operator UI can render an explicit "already
  // reconciled" tab instead of mixing these in with skip.
  //
  // Strict equality on sf_job_id only — the matcher picks one
  // representative job per customer, so a match here means LB and SF
  // agree on the same job. Different jobs on the same customer are
  // handled below by lb_already_pinned_to_different_job.
  if (single && lbCandidate && lbCandidate.sfJobId != null && single.sf_job_id != null
      && Number(lbCandidate.sfJobId) === Number(single.sf_job_id)) {
    return { bucket: 'already_linked', reason: 'already_linked', matched: matches };
  }

  if (matches.length === 0) {
    return { bucket: 'would_skip', reason: 'no_match', matched: [] };
  }

  // ── lb_already_pinned_to_different_job (EXISTING) ──
  //
  // LB has a different sfJobId pinned than what the matcher picks. LB's
  // bulk-link refuses to overwrite (no_overwrite_different_sfJobId), so
  // this row would always reject server-side. Surface for operator
  // review and never auto-apply.
  if (single && lbCandidate && lbCandidate.sfJobId != null && single.sf_job_id != null
      && Number(lbCandidate.sfJobId) !== Number(single.sf_job_id)) {
    return { bucket: 'would_review', reason: 'lb_already_pinned_to_different_job', matched: matches };
  }

  // ── sf_truth_overrides_lost (SF-connected lifecycle rule) ──
  //
  // In SF-connected mode, SF is the lifecycle source of truth. When LB
  // marked a lead `lost` (any statusSource — lb_automation, platform_sync,
  // user_admin, etc.) but SF has a high-confidence customer with a job
  // in the service lifecycle (completed | in_progress | scheduled |
  // booked), SF truth wins. Payment status is informational only — does
  // NOT gate lifecycle entry.
  //
  // Strict safety gate (all must hold):
  //   1. lbCandidate.status === 'lost'
  //   2. exactly 1 matched SF customer
  //   3. confidence >= 'high'                          (phone OR email exact)
  //   4. no ambiguity_warnings
  //   5. sf_job present                                 (matcher's tier filter
  //      already restricts to lifecycle statuses; presence implies eligibility)
  //   6. matched customer NOT already reconciled       (no remap)
  //   7. matched job has no DIFFERENT lb_lead_id pinned
  //
  // Position: AFTER lb_already_pinned_to_different_job (LB-side veto wins)
  // and BEFORE already_reconciled_customer (gate #6 ensures we don't remap).
  //
  // This rule's existence is for telemetry/labeling — without it, the
  // standard shouldAutoLink path below would still admit these rows to
  // would_link with reason=null. The named reason
  // `sf_truth_overrides_lost` surfaces the lifecycle-override semantic
  // explicitly in operator output and lets us track the count separately
  // in summary.lost_truth_override_candidates.
  if (single
      && lbCandidate
      && lbCandidate.status === 'lost'
      && (CONF_RANK[single.confidence] || 0) >= CONF_RANK.high
      && (!Array.isArray(single.ambiguity_warnings) || single.ambiguity_warnings.length === 0)
      && single.sf_job
      && !(single.sf_customer && (single.sf_customer.lb_lead_id || single.sf_customer.any_job_linked))
      && !(single.sf_job.lb_lead_id && single.sf_job.lb_lead_id !== lbCandidate.leadId)) {
    return { bucket: 'would_link', reason: 'sf_truth_overrides_lost', matched: matches };
  }

  // ── already_reconciled_customer (EXISTING) ──
  //
  // After PR #39's tiered picker, the matcher chooses the EARLIEST
  // completed+paid job for a customer. For customers reconciled in
  // earlier batches under the prior "most recent" picker, that earlier
  // job is unlinked while a DIFFERENT job on the same customer holds
  // the lb_lead_id. Surfacing the earlier job as would_link would
  // produce a 2nd link on the same customer for the same LB lead —
  // a remap, not historical cleanup. Skip cleanly.
  if (single && single.sf_customer
      && (single.sf_customer.lb_lead_id || single.sf_customer.any_job_linked)) {
    return { bucket: 'would_skip', reason: 'already_reconciled_customer', matched: matches };
  }

  // ── sf_job_linked_to_different_lb_lead (EXISTING) ──
  if (single) {
    const existing = single.sf_job && single.sf_job.lb_external_request_id;
    const incoming = lbCandidate && lbCandidate.externalRequestId;
    if (existing && incoming && existing !== incoming) {
      return { bucket: 'would_review', reason: 'sf_job_linked_to_different_lb_lead', matched: matches };
    }
  }

  // ── shouldAutoLink standard high-confidence single match ──
  if (shouldAutoLink(matches)) {
    if (!matches[0].sf_job_id) {
      return { bucket: 'would_review', reason: 'customer_match_no_job', matched: matches };
    }
    return { bucket: 'would_link', reason: null, matched: matches };
  }

  if (matches.length > 1) {
    return { bucket: 'would_review', reason: 'multiple_candidates', matched: matches };
  }
  return { bucket: 'would_skip', reason: 'low_confidence', matched: matches };
}

/**
 * Translate findHistoricalMatchType() output → orchestrator bucket.
 *
 * Buckets:
 *   lead_only_match — NEW. SF lead exists with lb_external_request_id,
 *                     converted_customer_id IS NULL. LB → lead_linked.
 *                     Never auto-link. Never write SF state.
 *   would_link      — high/exact customer-job match, no conflict (PR C
 *                     will route these to LB via apply path, unchanged).
 *   would_review    — needs operator. Includes:
 *                     - multiple SF leads for one externalRequestId
 *                     - multi-customer ambiguity from Step 2
 *                     - Step 4 cross_inquiry_or_non_lb_sf_lead matches
 *                     - lb_already_pinned_to_different_job
 *                     - sf_job_linked_to_different_lb_lead
 *                     - customer_match_no_job
 *   already_linked  — LB and SF agree on the same sf_job_id (delegates
 *                     to existing categorize() logic so reruns are safe).
 *   would_skip      — no_match, test_noise, low_confidence,
 *                     already_reconciled_customer.
 *
 * @param {object} args
 * @param {object} args.lbCandidate     - LB candidate row (camelCase)
 * @param {object} args.matchTypeResult - findHistoricalMatchType() return
 * @returns {{bucket: string, reason: string|null, matched: Array, extra: object}}
 */
function categorizeByMatchType({ lbCandidate, matchTypeResult: m }) {
  if (!m || !m.match_type) {
    return { bucket: 'would_skip', reason: 'unknown_match_type', matched: [], extra: {} };
  }

  // test_noise → orchestrator filters; do not send to LB.
  if (m.match_type === MATCH_TYPE.TEST_NOISE) {
    return { bucket: 'would_skip', reason: 'test_noise', matched: [], extra: {} };
  }

  // lead_only → distinct bucket. Never auto-linked. Surfaces sf_lead_id
  // + sf_lead_stage_name to the caller via `extra`.
  if (m.match_type === MATCH_TYPE.LEAD_ONLY) {
    return {
      bucket: 'lead_only_match',
      reason: null,
      matched: [],
      extra: {
        sf_lead_id:         m.sf_lead_id,
        sf_lead_stage_name: m.sf_lead_stage_name,
        wire_match_basis:   m.match_basis,
        confidence:         m.confidence,
        matcher_step:       m.step,
      },
    };
  }

  if (m.match_type === MATCH_TYPE.NO_MATCH) {
    return { bucket: 'would_skip', reason: 'no_match', matched: [], extra: { matcher_step: m.step } };
  }

  if (m.match_type === MATCH_TYPE.NEEDS_REVIEW) {
    // Step 2 candidates carry the rich existing-matcher shape — pass
    // them through so the orchestrator's existing categorize() rules
    // (lb_already_pinned_to_different_job, etc.) still trigger.
    if (Array.isArray(m.candidates) && m.candidates.length > 0) {
      const cat = categorize({ lbCandidate, matched: m.candidates });
      return { ...cat, extra: { matcher_step: m.step } };
    }
    // Steps 1, 1.5, 3, 4 produced needs_review without a candidates
    // array (lookup-failure or cross-inquiry leads). Pass the reason
    // through verbatim.
    return {
      bucket: 'would_review',
      reason: m.reason || 'needs_review',
      matched: [],
      extra: {
        sf_lead_id:           m.sf_lead_id,
        sf_customer_id:       m.sf_customer_id,
        sf_job_id:            m.sf_job_id,
        matched_sf_lead_ids:  m.matched_sf_lead_ids || [],
        wire_match_basis:     m.match_basis,
        matcher_step:         m.step,
      },
    };
  }

  // customer_job — synthesize a candidate-shaped object for categorize()
  // when matcher Steps 1/1.5/3 returned without going through Step 2.
  // This preserves existing already_linked / lb_already_pinned / etc.
  // semantics without duplicating the rules here.
  if (m.match_type === MATCH_TYPE.CUSTOMER_JOB) {
    const synthetic = Array.isArray(m.candidates) && m.candidates.length > 0
      ? m.candidates
      : [{
          sf_customer_id:     m.sf_customer_id,
          sf_job_id:          m.sf_job_id,
          confidence:         m.confidence || 'exact',
          match_signals:      [],
          // Synthesise minimal sf_job / sf_customer so categorize()'s
          // conflict checks (lb_external_request_id mismatch + already-
          // reconciled-customer) DON'T misfire. These are conservative
          // defaults — if categorize() needs richer data it would already
          // be carried via m.candidates[].
          sf_job:             m.sf_job_id != null ? { lb_external_request_id: null, lb_lead_id: null } : null,
          sf_customer:        null,
          ambiguity_warnings: m.ambiguity_warnings || [],
        }];
    const cat = categorize({ lbCandidate, matched: synthetic });
    return {
      ...cat,
      extra: {
        sf_lead_id:        m.sf_lead_id,
        wire_match_basis:  m.match_basis,
        matcher_step:      m.step,
      },
    };
  }

  // Fallthrough — should be unreachable but fail closed.
  return { bucket: 'would_skip', reason: 'unhandled_match_type', matched: [], extra: { match_type: m.match_type } };
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
 * Resolve sync_statuses for the LB candidates fetch.
 *
 * Precedence:
 *   1. explicit `syncStatuses` arg → honored verbatim (back-compat for
 *      callers that drive the array directly, e.g. the apply path's
 *      post-timeout reconcile which pulls `linked`).
 *   2. derived from sync_scope.
 *   3. fallback: ['pending'].
 *
 * @param {object} args
 * @param {Array<string>} [args.syncStatuses]
 * @param {string} [args.syncScope]
 * @returns {Array<string>}
 */
function resolveSyncStatuses(args) {
  if (Array.isArray(args && args.syncStatuses) && args.syncStatuses.length > 0) {
    return args.syncStatuses.slice();
  }
  const scope = (args && typeof args.syncScope === 'string') ? args.syncScope : SCOPE_PENDING_ONLY;
  const defaults = DEFAULT_SYNC_STATUSES_BY_SCOPE[scope];
  if (!defaults) return DEFAULT_SYNC_STATUSES_BY_SCOPE[SCOPE_PENDING_ONLY].slice();
  return defaults.slice();
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
 * @param {Array<string>} [args.syncStatuses]
 *        Explicit override of LB's sync_statuses filter. Honored if non-empty
 *        for back-compat with callers (e.g. apply path's post-timeout
 *        reconcile fetching ['linked']). When omitted, derived from
 *        syncScope.
 * @param {string} [args.syncScope='pending_only']
 *        One of: 'pending_only' (LB returns pending|NULL only),
 *                'full_reconcile' (LB returns pending|skipped|needs_review|
 *                failed|no_match|NULL — surfaces lifecycle-terminal rows
 *                like lost/cancelled). Has no effect when syncStatuses is
 *                explicitly set.
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

  // Validate sync_scope. Unknown values fall back to pending_only
  // (fail-closed — never default to full_reconcile on a typo).
  const syncScope = VALID_SYNC_SCOPES.includes(args.syncScope) ? args.syncScope : SCOPE_PENDING_ONLY;

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

  // 2. Fetch one batch from LB. Sync-statuses set derived from scope
  //    unless caller passed an explicit override.
  const status = (typeof args.status === 'string' && args.status.length > 0) ? args.status : undefined;
  const syncStatuses = resolveSyncStatuses({ syncStatuses: args.syncStatuses, syncScope });
  const page = await fetchCandidates({
    lbUserId,
    syncStatuses,
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
  const wouldLink     = [];
  const wouldReview   = [];
  const wouldSkip     = [];
  const alreadyLinked = [];
  const leadOnlyMatch = [];   // PR A — SF lead exists, not converted
  const summary = {
    lb_user_id:                       lbUserId,
    fetched_from_lb:                  candidates.length,
    requested_limit:                  limit,
    sync_scope:                       syncScope,
    sync_statuses:                    syncStatuses.slice(),
    status_filter:                    status || null,
    would_link:                       0,
    would_review:                     0,
    already_linked:                   0,
    would_skip:                       0,
    would_lead_link:                  0,   // PR A — new bucket
    // Renamed from automation_false_lost_candidates to reflect the broader
    // SF-connected lifecycle rule: any LB-lost row that SF truth overrides
    // (any statusSource, any lifecycle SF job — not just lb_automation +
    // completed+paid). Tracks rows bucketed via the sf_truth_overrides_lost
    // categorize() rule.
    lost_truth_override_candidates:   0,
    errors:                           0,
    more_may_exist:                   !!page.more_may_exist,
  };

  // 3. For each LB candidate, run the leads-aware matcher against SF data.
  //
  //    PR A replaces the prior findMatchCandidates-only flow with
  //    findHistoricalMatchType, which implements the locked Step 0/1/1.5/
  //    2/3/4/5 decision tree. The orchestrator then translates the
  //    match_type into a bucket via categorizeByMatchType, which preserves
  //    the existing already_linked / lb_already_pinned_to_different_job /
  //    sf_truth_overrides_lost rules for customer_job results.
  for (const lbCandidate of candidates) {
    const matcherInput = lbLeadToMatcherInput(lbCandidate);
    let m;
    try {
      m = await findHistoricalMatchType(supabase, { userId: tenantId, input: matcherInput });
    } catch (e) {
      summary.errors++;
      wouldSkip.push(buildBucketEntry(lbCandidate, [], 'matcher_error', { error: String(e && e.message || e) }));
      try { logger.error(`[sf-historical-sync] tenant=${tenantId} lead=${lbCandidate.leadId || '-'} matcher error: ${e && e.message}`); } catch (_) {}
      continue;
    }

    const cat = categorizeByMatchType({ lbCandidate, matchTypeResult: m });
    const entry = buildBucketEntry(lbCandidate, cat.matched, cat.reason, cat.extra || {});

    if (cat.bucket === 'lead_only_match') {
      leadOnlyMatch.push(entry);
      summary.would_lead_link++;
    } else if (cat.bucket === 'would_link') {
      wouldLink.push(entry);
      summary.would_link++;
      if (cat.reason === 'sf_truth_overrides_lost') {
        summary.lost_truth_override_candidates++;
      }
    } else if (cat.bucket === 'would_review') {
      wouldReview.push(entry);
      summary.would_review++;
    } else if (cat.bucket === 'already_linked') {
      alreadyLinked.push(entry);
      summary.already_linked++;
    } else {
      wouldSkip.push(entry);
      summary.would_skip++;
    }
  }

  try {
    logger.log(`[sf-historical-sync] tenant=${tenantId} lb_user=${lbUserId} dry_run=true sync_scope=${syncScope} status=${status || '-'} fetched=${summary.fetched_from_lb} would_link=${summary.would_link} would_lead_link=${summary.would_lead_link} (lost_truth_override=${summary.lost_truth_override_candidates}) would_review=${summary.would_review} already_linked=${summary.already_linked} would_skip=${summary.would_skip} more_may_exist=${summary.more_may_exist}`);
  } catch (_) {}

  return {
    ok: true,
    dry_run: DRY_RUN_FORCED,
    phase: 'phase_1_dry_run_only',
    summary,
    would_link:      wouldLink,
    would_review:    wouldReview,
    already_linked:  alreadyLinked,
    would_skip:      wouldSkip,
    lead_only_match: leadOnlyMatch,   // PR A — new top-level array
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
  // Defense-in-depth: refuse to apply when LB already has this lead
  // pinned to a different sf_job_id. LB's bulk-link path enforces the
  // same invariant (no_overwrite_different_sfJobId) and would respond
  // with `result: conflict`; rejecting here saves the round-trip and
  // keeps the SF-side audit/outbox state clean. The LB candidate field
  // `sfJobId` is the deterministic signal — categorize() surfaces this
  // as `lb_already_pinned_to_different_job`.
  if (lbCandidate && lbCandidate.sfJobId != null
      && Number(lbCandidate.sfJobId) !== Number(c.sf_job_id)) {
    return { ok: false, reason: 'lb_already_pinned_to_different_job' };
  }
  // Defense-in-depth: refuse to apply when the matched customer is
  // already linked through any other SF job. Preview's categorize()
  // surfaces this as `already_reconciled_customer`; isApplicable()
  // re-checks here so stale operator approvals (queued before the
  // matcher patch deployed) can't slip a remap through.
  if (c.sf_customer && (c.sf_customer.lb_lead_id || c.sf_customer.any_job_linked)) {
    return { ok: false, reason: 'already_reconciled_customer' };
  }
  // SF-connected lifecycle rule: lost LB rows are treated identically to
  // non-lost rows. SF truth (the matcher's representative job) is the
  // single source for conversion. The matcher's tier filter already
  // restricts sf_job to lifecycle statuses {completed, in_progress,
  // scheduled, booked}; if a sf_job is present here, the customer
  // entered the lifecycle. Payment status is informational only and is
  // NOT checked.
  //
  // No defense-in-depth for lost rows beyond the standard guards above
  // (high conf + single + no ambiguity + sf_job_id present + not
  // reconciled + not pinned to a different lb_lead). Those guards apply
  // uniformly to all rows.
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
 * @param {Array<string>} [args.syncStatuses]        - explicit override; if omitted,
 *                                                     derived from syncScope
 * @param {string}  [args.syncScope='pending_only']  - 'pending_only' | 'full_reconcile'.
 *                                                     Must match the scope the
 *                                                     operator approved the rows
 *                                                     under (full_reconcile when
 *                                                     applying automation_false_lost).
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
  const syncScope     = VALID_SYNC_SCOPES.includes(args.syncScope) ? args.syncScope : SCOPE_PENDING_ONLY;
  const syncStatuses  = resolveSyncStatuses({ syncStatuses: args.syncStatuses, syncScope });
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
    let postTimeoutReconciled = false;
    const uncertain = [];
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

      // Post-timeout reconcile: if SF's HTTP client gave up but LB may
      // have committed server-side (the Batch #1 failure mode), fetch
      // LB's `linked` candidates and reconstruct the applied/rejected
      // outcome from authoritative LB state rather than treating the
      // batch as failed and writing nothing.
      if (!lbResponse.ok && lbResponse.reason === 'request_timeout') {
        try { logger.warn(`[sf-historical-apply] tenant=${tenantId} LB timeout (request_id=${lbResponse.request_id || '-'}); running post-timeout reconcile`); } catch (_) {}
        const submittedLeadIds = new Set(eligibleRows.map(r => r.lbCandidate.leadId));
        const linkedPage = await fetchCandidates({
          lbUserId,
          syncStatuses: ['linked'],
          status,
          limit: MAX_LEADS_HARD_CAP,
          httpClient: args.httpClient, now: args.now,
        });
        if (linkedPage.ok && Array.isArray(linkedPage.candidates)) {
          const lbLinkedNow = new Set(linkedPage.candidates.map(c => c.leadId));
          const synthesizedApplied  = [];
          const synthesizedRejected = [];
          for (const r of eligibleRows) {
            if (lbLinkedNow.has(r.lbCandidate.leadId)) {
              synthesizedApplied.push({
                lb_lead_id:     r.lbCandidate.leadId,
                lb_result:      'linked',
                lb_sync_status: 'linked',
                lb_detail:      'reconciled_from_post_timeout_fetch',
                sf_managed:     true,
              });
            } else {
              uncertain.push({
                lb_lead_id: r.lbCandidate.leadId,
                sf_job_id:  r.matchedCandidate.sf_job_id,
                reason:     'lb_state_uncertain',
                detail:     'LB did not return this row in sync_statuses=[linked] after timeout — server-side state unknown',
              });
            }
          }
          lbResponse = {
            ok:         true,
            status:     0,
            applied:    synthesizedApplied,
            rejected:   synthesizedRejected,
            summary:    null,
            request_id: lbResponse.request_id || null,
            reconciled: true,
          };
          postTimeoutReconciled = true;
          summary.errors += uncertain.length;
          try { logger.warn(`[sf-historical-apply] tenant=${tenantId} post-timeout reconcile: applied=${synthesizedApplied.length} uncertain=${uncertain.length}`); } catch (_) {}
        } else {
          try { logger.error(`[sf-historical-apply] tenant=${tenantId} post-timeout reconcile fetch failed: ${linkedPage.reason}`); } catch (_) {}
          return {
            ok:         false,
            status:     502,
            error:      'lb_state_uncertain',
            detail:     'apply timed out and the post-timeout reconcile fetch also failed; SF state intentionally not written — operator must run /historical-sync/remediate to align',
            request_id: lbResponse.request_id || null,
          };
        }
      } else if (!lbResponse.ok) {
        const reason = lbResponse.reason || 'lb_apply_failed';
        const httpStatus = reason === 'lb_unreachable' ? 502 : 502;
        try { logger.warn(`[sf-historical-apply] tenant=${tenantId} LB apply failed reason=${reason} status=${lbResponse.status || '-'} request_id=${lbResponse.request_id || '-'}`); } catch (_) {}
        return {
          ok:         false,
          status:     httpStatus,
          error:      reason === 'lb_unreachable' ? 'lb_unreachable' : 'lb_apply_failed',
          detail:     lbResponse.error_description || null,
          request_id: lbResponse.request_id || null,
        };
      }
    }

    const lbApplied  = lbResponse && Array.isArray(lbResponse.applied)  ? lbResponse.applied  : [];
    const lbRejected = lbResponse && Array.isArray(lbResponse.rejected) ? lbResponse.rejected : [];
    const appliedSet = new Set(lbApplied.map(r => r.lb_lead_id));
    const uncertainSet = new Set(uncertain.map(u => u.lb_lead_id));

    // 7. For each LB-confirmed row, run attachLbLink.
    for (const row of eligibleRows) {
      // Rows that landed in `uncertain` (post-timeout reconcile couldn't
      // confirm LB state) must NOT be persisted as either applied or
      // rejected — they need operator triage via /historical-sync/remediate.
      if (uncertainSet.has(row.lbCandidate.leadId)) {
        continue;
      }
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
      logger.log(`[sf-historical-apply] tenant=${tenantId} lb_user=${lbUserId} requested=${requested} applied=${summary.applied} rejected=${summary.rejected} skipped_drift=${summary.skipped_drift} skipped_ineligible=${summary.skipped_ineligible} skipped_already_linked=${summary.skipped_already_linked} uncertain=${uncertain.length} reconciled=${postTimeoutReconciled} errors=${summary.errors} request_id=${(lbResponse && lbResponse.request_id) || '-'}`);
    } catch (_) {}

    return {
      ok:    true,
      phase: 'phase_2_apply',
      summary: { ...summary, uncertain: uncertain.length, post_timeout_reconciled: postTimeoutReconciled },
      applied,
      rejected,
      skipped_drift:          skippedDrift,
      skipped_ineligible:     skippedIneligible,
      skipped_already_linked: skippedAlreadyLinked,
      uncertain,
      request_id:             (lbResponse && lbResponse.request_id) || null,
      post_timeout_reconciled: postTimeoutReconciled,
    };
  } finally {
    await applyLock.release(supabase, tenantId);
  }
}

// ──────────────────────────────────────────────────────────────────────
// Phase-3 — historical-sync FEEDBACK apply
// ──────────────────────────────────────────────────────────────────────
//
// Problem this fixes:
//   Phase-1 categorizes every LB pending candidate into one of
//   {would_link, would_review, already_linked, would_skip(no_match|
//   low_confidence|already_reconciled_customer|matcher_error|...)}, but
//   only `would_link` rows are ever posted back to LB (via Phase-2
//   apply). LB therefore leaves hundreds of leads in syncStatus='pending'
//   forever — SF processed them, made a determination, and never told LB.
//
// What feedback apply does:
//   For each LB pending candidate SF processes, post an explicit per-row
//   outcome to LB /link-leads-bulk so LB transitions the row out of
//   `pending` into the matching syncStatus. The mapping is:
//
//     SF categorize bucket / reason          → LB confidence  → LB syncStatus
//     ─────────────────────────────────────  ─────────────── ───────────────
//     would_link (high|exact)               → 'high'         → 'linked'
//     would_review:multiple_candidates      → 'medium'       → 'needs_review'
//     would_review:customer_match_no_job    → 'medium'       → 'needs_review'
//     would_review:lb_already_pinned_diff   → 'medium'       → 'needs_review'
//     would_review:sf_job_linked_other_lead → 'medium'       → 'needs_review'
//     would_skip:low_confidence             → 'low'          → 'needs_review'
//     would_skip:no_match                   → 'none'         → 'no_match'
//     would_skip:already_reconciled_cust    → SKIP by default (operator opt-in)
//     would_skip:matcher_error              → SKIP (retry next batch)
//     already_linked                        → SKIP (no transition needed)
//
//   Why "already_reconciled_customer" is opt-in: the customer is already
//   linked through a different LB lead. Sending no_match is semantically
//   defensible (no available SF job to attribute this LB lead to) but it
//   bakes in the tiered-picker decision permanently. Operator decides.
//
//   Why matcher_error is skipped: transient errors should retry on the
//   next dry-run pass, not get permanently marked as anything on LB. The
//   summary surfaces a `would_failed` count so operators can see them.
//
// Hard rules (defensive, mirror existing apply):
//   - Feature-flag gated:  SF_HISTORICAL_FEEDBACK_APPLY_ENABLED
//   - dryRun is the default; explicit dryRun:false required to write
//   - NEVER calls attachLbLink (no SF state writes)
//   - NEVER touches `jobs.lb_lead_id` / `customers.lb_lead_id` / outbox
//   - Per-tenant lock reused from applyLock (same row contention guard
//     as Phase-2 apply)
//   - Operator-selectable class subset (defaults to all non-link/non-error
//     buckets) so the operator can phase: no_match-only first, then
//     needs_review, etc.
//
// Why dryRun returns full per-class rows: operator must be able to spot
// surprises (e.g. a `no_match` row whose phone digits match a known SF
// customer the matcher missed) BEFORE the wire call.

// Reasons that feedback will send to LB by default.
const FEEDBACK_DEFAULT_CLASSES = Object.freeze([
  'no_match',
  'low_confidence',
  'multiple_candidates',
  'customer_match_no_job',
  'lb_already_pinned_to_different_job',
  'sf_job_linked_to_different_lb_lead',
  'lead_only',                       // PR C — SF lead exists, not converted; LB → lead_linked
]);
const FEEDBACK_OPTIONAL_CLASSES = Object.freeze([
  'already_reconciled_customer',
]);
const FEEDBACK_ALL_CLASSES = Object.freeze([
  ...FEEDBACK_DEFAULT_CLASSES, ...FEEDBACK_OPTIONAL_CLASSES,
]);
// Linked rows are reported in summary but NOT posted by this path —
// linking has its own apply path (runHistoricalSyncApply) that ALSO does
// the SF-side state writes. Mixing the two would double-count.
const FEEDBACK_SKIP_CATEGORIES = Object.freeze(new Set([
  'already_linked', 'would_link',
]));

// LB wire confidence values — defined in LB BulkLinkRow contract.
const LB_CONF = Object.freeze({ EXACT:'exact', HIGH:'high', MEDIUM:'medium', LOW:'low', NONE:'none' });
// LB wire match_basis values — defined in LB BulkLinkRow contract.
const LB_BASIS = Object.freeze({
  EXTERNAL:'externalRequestId', PHONE:'phone', PHONE_NAME:'phone_name',
  EMAIL:'email', NAME_PLATFORM:'name_platform', MANUAL:'manual', NONE:'none',
});

const FEEDBACK_APPLY_REASON = 'historical_sync_feedback';

/**
 * Translate one categorizeByMatchType() output into the LB
 * /link-leads-bulk row shape for a feedback post. Returns null when this
 * category should not be posted (would_link / already_linked / skipped /
 * unknown).
 *
 * For customer_job-style rows (needs_review / no_match buckets) the
 * matcher's representative job is reported back as `sf_job_id` even when
 * LB doesn't persist it — LB echoes it in the response `detail` so the
 * operator can see SF's best guess on the review screen.
 *
 * NEW (PR C): bucket === 'lead_only_match' emits the LB lead-link wire
 * shape with `match_type='lead_only'` + `sf_lead_id` + `sf_lead_stage_name`.
 * `sf_job_id` and `sf_customer_id` are NEVER populated for this category
 * — hard rule per the joint LB↔SF design and LB PR #203 receiver.
 *
 * @param {object} args
 * @param {object} args.lbCandidate   - LB camelCase candidate
 * @param {object} args.categorized   - return value from categorizeByMatchType()
 *                                       (or legacy categorize() for back-compat)
 * @returns {object|null}
 */
function buildFeedbackRow({ lbCandidate, categorized }) {
  if (!lbCandidate || !categorized) return null;
  const bucket = categorized.bucket;
  if (FEEDBACK_SKIP_CATEGORIES.has(bucket)) return null;

  // ── lead_only_match (PR C — NEW) ────────────────────────────────
  //
  // LB PR #203 receiver applies these rows by setting:
  //   syncStatus       = 'lead_linked'
  //   sfLeadId         = row.sf_lead_id
  //   sfLeadStageName  = row.sf_lead_stage_name
  //   sfLeadMatchedAt  = now()
  // and does NOT touch sfJobId / sfCustomerId / sfJobOutcome / writeStatus.
  //
  // Hard rules (mirrors findHistoricalMatchType's baseResult invariants):
  //   - sf_job_id and sf_customer_id are ALWAYS null on the wire.
  //   - match_type is explicit ('lead_only') so LB doesn't fall back to
  //     the customer_job default.
  //   - confidence is 'exact' (lb_external_request_id is a deterministic
  //     unique-per-tenant identifier).
  //   - match_basis is 'externalRequestId'.
  if (bucket === 'lead_only_match') {
    const extra = categorized.extra || {};
    const sfLeadId        = extra.sf_lead_id;
    const sfLeadStageName = extra.sf_lead_stage_name || null;
    if (sfLeadId == null) {
      // Defensive: lead_only_match without sf_lead_id can't be applied.
      // Should never happen (findHistoricalMatchType guarantees it for
      // lead_only) but if it does, drop the row rather than send a
      // broken payload to LB.
      return null;
    }
    return {
      lb_lead_id:         lbCandidate.leadId,
      match_type:         'lead_only',
      sf_lead_id:         sfLeadId,
      sf_lead_stage_name: sfLeadStageName,
      sf_customer_id:     null,                                  // hard rule
      sf_job_id:          null,                                  // hard rule
      confidence:         LB_CONF.EXACT,
      match_basis:        LB_BASIS.EXTERNAL,
      sf_status:          null,                                  // not a customer/job event
      sf_payment_status:  null,
      occurred_at:        null,
      reason:             FEEDBACK_APPLY_REASON + ':sf_lead_only:' + LB_BASIS.EXTERNAL,
    };
  }

  const reason = categorized.reason || (bucket === 'would_skip' ? 'no_match' : 'unknown');
  const matches = Array.isArray(categorized.matched) ? categorized.matched : [];
  const first = matches.length > 0 ? matches[0] : null;
  const sfJob = first && first.sf_job ? first.sf_job : null;

  let confidence;
  let matchBasis;
  switch (reason) {
    case 'no_match':
      confidence = LB_CONF.NONE;
      matchBasis = LB_BASIS.NONE;
      break;
    case 'low_confidence':
    case 'low_confidence_customer_match':
      // matcher returned low/medium confidence single match — surface
      // it as `low` so LB UI ranks it below `medium`-tier reviews
      confidence = (first && first.confidence === 'medium') ? LB_CONF.MEDIUM : LB_CONF.LOW;
      matchBasis = (first && Array.isArray(first.match_signals) && first.match_signals[0]) ? LB_BASIS.NAME_PLATFORM : LB_BASIS.NONE;
      break;
    case 'multiple_candidates':
    case 'multiple_customer_candidates':
    case 'customer_match_no_job':
    case 'lb_already_pinned_to_different_job':
    case 'sf_job_linked_to_different_lb_lead':
    case 'cross_inquiry_or_non_lb_sf_lead':                  // PR A Step 4 — needs_review
      confidence = LB_CONF.MEDIUM;
      matchBasis = (first && Array.isArray(first.match_signals) && first.match_signals.some(s => /phone/.test(s))) ? LB_BASIS.PHONE
                   : (first && Array.isArray(first.match_signals) && first.match_signals.some(s => /email/.test(s))) ? LB_BASIS.EMAIL
                   : LB_BASIS.NAME_PLATFORM;
      break;
    case 'already_reconciled_customer':
      confidence = LB_CONF.NONE;
      matchBasis = LB_BASIS.NONE;
      break;
    default:
      // unknown reason — fail closed (do NOT send)
      return null;
  }

  // LB's wire requires sf_job_id as a String. For no_match we send null;
  // LB's applyBulkLink ignores sf_job_id when confidence==='none'. The
  // wire client (lb-historical-sync-client.linkLeadsBulk) only stringifies
  // when non-null, so null passes through cleanly.
  const sfJobId = (first && first.sf_job_id != null) ? first.sf_job_id : null;
  const sfCustomerId = (first && first.sf_customer_id != null) ? first.sf_customer_id : null;

  return {
    lb_lead_id:        lbCandidate.leadId,
    match_type:        'customer_job',                            // PR C — explicit
    sf_job_id:         (confidence === LB_CONF.NONE) ? null : sfJobId,
    sf_customer_id:    (confidence === LB_CONF.NONE) ? null : sfCustomerId,
    confidence,
    match_basis:       matchBasis,
    sf_status:         (sfJob && sfJob.status)         || null,
    sf_payment_status: (sfJob && sfJob.payment_status) || null,
    occurred_at:       (sfJob && (sfJob.last_status_changed_at || sfJob.updated_at)) || null,
    reason:            FEEDBACK_APPLY_REASON + ':' + reason,
  };
}

/**
 * Phase-3 feedback apply.
 *
 * Pulls a fresh batch of LB pending candidates, runs the matcher,
 * categorizes each, builds per-row feedback for non-link outcomes, and
 * POSTs the batch to LB /link-leads-bulk so LB transitions each row
 * out of `syncStatus='pending'`.
 *
 * Returns per-row outcomes + summary. In dryRun mode (default), the
 * proposed feedback rows are returned but never posted.
 *
 * @param {object} supabase
 * @param {object} args
 * @param {number} args.tenantId
 * @param {boolean} [args.dryRun=true]    — must be explicitly false to write
 * @param {Array<string>} [args.classes=FEEDBACK_DEFAULT_CLASSES]
 *        Which categorize() reasons to include in the feedback batch.
 * @param {number} [args.maxLeads=500]
 * @param {Array<string>} [args.syncStatuses]
 * @param {string} [args.syncScope='pending_only']
 * @param {string} [args.status]
 * @param {object} [args.httpClient]
 * @param {object} [args.logger]
 * @returns {Promise<object>}
 */
/**
 * Map a proposed feedback row to the LB syncStatus it SHOULD land in if
 * the receiver applied it successfully. Used by the post-timeout reconcile
 * to verify whether LB actually committed each row when SF's HTTP client
 * gave up before LB returned a per-row response.
 *
 * Mirrors LB PR #203's `applyBulkLink` decision tree:
 *   - match_type='lead_only'                           → 'lead_linked'
 *   - confidence='exact' or 'high'  (customer_job)     → 'linked'
 *   - confidence='medium' or 'low'  (customer_job)     → 'needs_review'
 *   - confidence='none'             (no_match)         → 'no_match'
 *
 * Returns null when the row shape can't be classified (defensive — caller
 * lands it in uncertain[] with reason='lb_state_mismatch').
 *
 * @param {object} row  - wire row produced by buildFeedbackRow
 * @returns {string|null}
 */
function expectedLbSyncStatusFor(row) {
  if (!row) return null;
  if (row.match_type === 'lead_only') return 'lead_linked';
  // Everything else is customer_job-shaped; differentiate on confidence.
  const c = row.confidence;
  if (c === LB_CONF.EXACT || c === LB_CONF.HIGH)            return 'linked';
  if (c === LB_CONF.MEDIUM || c === LB_CONF.LOW)            return 'needs_review';
  if (c === LB_CONF.NONE)                                    return 'no_match';
  return null;
}

async function runHistoricalFeedbackApply(supabase, args) {
  if (!supabase || typeof supabase.from !== 'function') {
    throw new Error('runHistoricalFeedbackApply: supabase required');
  }
  if (!args || args.tenantId == null) {
    return { ok: false, status: 400, error: 'invalid_arguments', detail: 'tenantId required' };
  }
  const tenantId = Number(args.tenantId);
  const dryRun   = args.dryRun !== false;   // default TRUE
  const limit    = Math.min(
    Number.isFinite(args.maxLeads) ? args.maxLeads : MAX_LEADS_DEFAULT,
    MAX_LEADS_HARD_CAP,
  );
  const logger = args.logger || { log() {}, warn() {}, error() {} };
  const status = (typeof args.status === 'string' && args.status.length > 0) ? args.status : undefined;
  const syncScope    = VALID_SYNC_SCOPES.includes(args.syncScope) ? args.syncScope : SCOPE_PENDING_ONLY;
  const syncStatuses = resolveSyncStatuses({ syncStatuses: args.syncStatuses, syncScope });

  // Class filter — reject unknown classes early.
  const requested = Array.isArray(args.classes) && args.classes.length > 0
    ? args.classes.slice()
    : FEEDBACK_DEFAULT_CLASSES.slice();
  const unknown = requested.filter(c => !FEEDBACK_ALL_CLASSES.includes(c));
  if (unknown.length > 0) {
    return { ok: false, status: 400, error: 'invalid_classes', detail: `unknown feedback class(es): ${unknown.join(',')}` };
  }
  const allowedClasses = new Set(requested);

  // 1. Resolve LB user UUID.
  const lookup = await resolveLbUserId(supabase, tenantId);
  if (!lookup.ok) {
    try { logger.warn(`[sf-historical-feedback] tenant=${tenantId} lb-user lookup failed: ${lookup.error}`); } catch (_) {}
    return { ok: false, status: lookup.status, error: lookup.error, detail: lookup.detail || null };
  }
  const lbUserId = lookup.lbUserId;

  // 2. Acquire per-tenant lock — only for live apply. Dry-run is
  //    read-only and never races with anything.
  let lockHeld = false;
  if (!dryRun) {
    const lockNote = `feedback tenant=${tenantId} dryRun=false classes=${requested.join(',')}`;
    const lock = await applyLock.tryAcquire(supabase, tenantId, { note: lockNote });
    if (!lock.ok) {
      const status409 = lock.reason === 'apply_in_progress' ? 409 : 503;
      try { logger.warn(`[sf-historical-feedback] tenant=${tenantId} lock failed: ${lock.reason}`); } catch (_) {}
      return { ok: false, status: status409, error: lock.reason, detail: lock.detail || null };
    }
    lockHeld = true;
  }

  try {
    // 3. Fetch one batch from LB.
    const page = await fetchCandidates({
      lbUserId, syncStatuses, status, limit,
      httpClient: args.httpClient, now: args.now,
    });
    if (!page.ok) {
      try { logger.warn(`[sf-historical-feedback] tenant=${tenantId} fetchCandidates failed reason=${page.reason} status=${page.status || '-'}`); } catch (_) {}
      return {
        ok:     false,
        status: page.status || 502,
        error:  page.reason || 'lb_fetch_failed',
        detail: page.error_description || null,
      };
    }

    const candidates = Array.isArray(page.candidates) ? page.candidates : [];

    // 4. For each candidate, run the leads-aware matcher (PR A's
    //    findHistoricalMatchType) + categorizeByMatchType, then build
    //    the feedback row (if the class is in allowedClasses).
    //
    //    PR C switched this path from findMatchCandidates + categorize
    //    to the match_type-aware functions so we can correctly emit
    //    match_type='lead_only' rows. customer_job-style rows still flow
    //    through categorize() inside categorizeByMatchType, so existing
    //    behaviour (would_link skip, lb_already_pinned routing, etc.) is
    //    unchanged.
    const proposedRows  = [];                   // wire shape
    const proposedDebug = [];                   // operator-readable per-row debug
    const summary = {
      lb_user_id:                       lbUserId,
      fetched_from_lb:                  candidates.length,
      requested_limit:                  limit,
      sync_scope:                       syncScope,
      sync_statuses:                    syncStatuses.slice(),
      status_filter:                    status || null,
      dry_run:                          dryRun,
      classes:                          requested.slice(),
      processed:                        0,
      // bucket counts BEFORE class filter
      categorized_lead_only:            0,    // PR C — new bucket from leads-aware matcher
      categorized_would_link:           0,
      categorized_would_review:         0,
      categorized_already_linked:       0,
      categorized_would_skip_no_match:  0,
      categorized_would_skip_low_conf:  0,
      categorized_would_skip_other:     0,
      categorized_matcher_error:        0,
      // would-counts AFTER class filter — match the operator's mental model
      would_lead_link:                  0,    // PR C — match_type='lead_only' rows posted
      would_link:                       0,    // not posted by feedback path
      would_review:                     0,
      would_no_match:                   0,
      would_failed:                     0,
      would_skipped_not_processed:      0,    // categorized but not in allowedClasses
      more_may_exist:                   !!page.more_may_exist,
    };

    for (const lbCandidate of candidates) {
      summary.processed++;
      const matcherInput = lbLeadToMatcherInput(lbCandidate);
      let matchTypeResult;
      let matcherError = null;
      try {
        matchTypeResult = await findHistoricalMatchType(supabase, { userId: tenantId, input: matcherInput });
      } catch (e) {
        matcherError = String(e && e.message || e);
        summary.categorized_matcher_error++;
        summary.would_failed++;
        proposedDebug.push({
          lb_lead_id:   lbCandidate.leadId,
          lb_customer_name: lbCandidate.customerName || null,
          bucket:       'matcher_error',
          reason:       'matcher_error',
          action:       'skip_retry_next_batch',
          matcher_error: matcherError,
        });
        try { logger.error(`[sf-historical-feedback] tenant=${tenantId} lead=${lbCandidate.leadId || '-'} matcher error: ${matcherError}`); } catch (_) {}
        continue;
      }

      const cat = categorizeByMatchType({ lbCandidate, matchTypeResult });
      // Maintain bucket counts.
      if (cat.bucket === 'lead_only_match')     summary.categorized_lead_only++;
      else if (cat.bucket === 'would_link')     summary.categorized_would_link++;
      else if (cat.bucket === 'already_linked') summary.categorized_already_linked++;
      else if (cat.bucket === 'would_review')   summary.categorized_would_review++;
      else if (cat.bucket === 'would_skip') {
        if (cat.reason === 'no_match')              summary.categorized_would_skip_no_match++;
        else if (cat.reason === 'low_confidence')   summary.categorized_would_skip_low_conf++;
        else                                         summary.categorized_would_skip_other++;
      }

      // Would_link is intentionally not part of feedback (apply path
      // handles those + SF writes). Track for summary only.
      if (cat.bucket === 'would_link') {
        summary.would_link++;
        proposedDebug.push({
          lb_lead_id:    lbCandidate.leadId,
          lb_customer_name: lbCandidate.customerName || null,
          bucket:        cat.bucket,
          reason:        cat.reason,
          action:        'skip_use_apply_path',
        });
        continue;
      }
      if (cat.bucket === 'already_linked') {
        proposedDebug.push({
          lb_lead_id:    lbCandidate.leadId,
          lb_customer_name: lbCandidate.customerName || null,
          bucket:        cat.bucket,
          reason:        cat.reason,
          action:        'skip_already_in_terminal_state',
        });
        continue;
      }

      // Class filter — operator-selectable subset of categorize reasons
      // that get turned into wire rows. lead_only_match maps to class
      // 'lead_only' (not a categorize() reason — the bucket is the
      // identifier here).
      const classKey = cat.bucket === 'lead_only_match'
        ? 'lead_only'
        : (cat.reason || (cat.bucket === 'would_skip' ? 'no_match' : null));
      if (!allowedClasses.has(classKey)) {
        summary.would_skipped_not_processed++;
        proposedDebug.push({
          lb_lead_id:    lbCandidate.leadId,
          lb_customer_name: lbCandidate.customerName || null,
          bucket:        cat.bucket,
          reason:        classKey,
          action:        'skip_class_not_selected',
        });
        continue;
      }

      const row = buildFeedbackRow({ lbCandidate, categorized: cat });
      if (!row) {
        // buildFeedbackRow returned null — defensive only; the
        // allowedClasses filter above should have caught everything.
        summary.would_skipped_not_processed++;
        continue;
      }
      if (row.match_type === 'lead_only')      summary.would_lead_link++;
      else if (row.confidence === LB_CONF.NONE) summary.would_no_match++;
      else                                      summary.would_review++;

      proposedRows.push(row);
      proposedDebug.push({
        lb_lead_id:    lbCandidate.leadId,
        lb_customer_name: lbCandidate.customerName || null,
        bucket:        cat.bucket,
        reason:        classKey,
        action:        dryRun ? 'would_post' : 'post',
        match_type:    row.match_type,
        confidence:    row.confidence,
        match_basis:   row.match_basis,
        sf_lead_id:    row.sf_lead_id || null,
        sf_lead_stage_name: row.sf_lead_stage_name || null,
        sf_customer_id: row.sf_customer_id,
        sf_job_id:     row.sf_job_id,
      });
    }

    try {
      logger.log(`[sf-historical-feedback] tenant=${tenantId} lb_user=${lbUserId} dry_run=${dryRun} processed=${summary.processed} would_lead_link=${summary.would_lead_link} would_review=${summary.would_review} would_no_match=${summary.would_no_match} would_failed=${summary.would_failed} would_link=${summary.would_link} skipped_not_processed=${summary.would_skipped_not_processed}`);
    } catch (_) {}

    // 5. DRY-RUN — return the plan without posting.
    if (dryRun) {
      return {
        ok:    true,
        phase: 'phase_3_feedback_dry_run',
        summary,
        proposed_rows: proposedRows,
        per_lead:      proposedDebug,
      };
    }

    // 6. LIVE APPLY — POST to LB /link-leads-bulk if there's anything
    //    to send. If everything got filtered out, return cleanly.
    if (proposedRows.length === 0) {
      return {
        ok:    true,
        phase: 'phase_3_feedback_apply',
        summary,
        applied: [], rejected: [], per_lead: proposedDebug,
        request_id: null,
      };
    }

    let lbResponse = await linkLeadsBulk({
      lbUserId, matches: proposedRows,
      httpClient: args.httpClient, now: args.now,
    });

    // ── Post-timeout reconcile (mirror of runHistoricalSyncApply) ──
    //
    // When SF's HTTP client gives up at the 120s mark, LB often continues
    // committing rows server-side (observed in the 2026-06-05 incident and
    // the 2026-06-06 batch-2 incident, where LB landed 275 / 191 rows ~14s
    // AFTER SF closed the connection). Without reconciliation, the
    // orchestrator would return ok:false and the operator would have to
    // hand-query LB to find out what actually committed.
    //
    // On timeout we re-fetch LB candidates across every syncStatus a
    // successful feedback POST could land in (lead_linked, linked,
    // needs_review, no_match) and reconstruct applied[] / uncertain[] from
    // LB's authoritative state.
    //
    // Hard rules:
    //   - attachLbLink is still not called from this path (matches existing
    //     feedback semantics — LB-only update, no SF state writes). The
    //     reconcile only changes what we REPORT back to the caller; it
    //     does not gain new write paths.
    //   - A row's "applied" verdict requires LB's actual syncStatus to
    //     MATCH the expected status for the match_type we sent. A
    //     mismatch (e.g. we sent lead_only but LB now shows pending)
    //     lands in uncertain[].
    //   - The reconcile fetch can fail too. When it does, we return the
    //     same `lb_state_uncertain` 502 the apply path uses so the
    //     operator knows manual inspection is needed.
    let postTimeoutReconciled = false;
    const uncertain = [];
    if (!lbResponse.ok && lbResponse.reason === 'request_timeout') {
      try { logger.warn(`[sf-historical-feedback] tenant=${tenantId} LB timeout (request_id=${lbResponse.request_id || '-'}); running post-timeout reconcile`); } catch (_) {}
      const reconcilePage = await fetchCandidates({
        lbUserId,
        syncStatuses: ['lead_linked', 'linked', 'needs_review', 'no_match'],
        status,
        limit: MAX_LEADS_HARD_CAP,
        httpClient: args.httpClient, now: args.now,
      });
      if (reconcilePage.ok && Array.isArray(reconcilePage.candidates)) {
        const lbStateByLeadId = new Map();
        for (const c of reconcilePage.candidates) {
          lbStateByLeadId.set(c.leadId, {
            syncStatus:     c.syncStatus,
            sfLeadId:       c.sfLeadId,
            sfJobId:        c.sfJobId,
            sfCustomerId:   c.sfCustomerId,
          });
        }
        const synthesizedApplied  = [];
        const synthesizedRejected = [];
        for (const proposed of proposedRows) {
          const lbState = lbStateByLeadId.get(proposed.lb_lead_id);
          const expectedSyncStatus = expectedLbSyncStatusFor(proposed);
          if (lbState && expectedSyncStatus && lbState.syncStatus === expectedSyncStatus) {
            synthesizedApplied.push({
              lb_lead_id:     proposed.lb_lead_id,
              lb_result:      expectedSyncStatus,
              lb_sync_status: expectedSyncStatus,
              lb_detail:      'reconciled_from_post_timeout_fetch',
              sf_managed:     true,
              match_type:     proposed.match_type,
            });
          } else {
            uncertain.push({
              lb_lead_id:           proposed.lb_lead_id,
              match_type:           proposed.match_type,
              expected_sync_status: expectedSyncStatus,
              actual_sync_status:   lbState ? lbState.syncStatus : null,
              reason:               lbState ? 'lb_state_mismatch' : 'lb_state_uncertain',
              detail:               lbState ? 'LB syncStatus does not match the expected landing state for this match_type' : 'LB did not return this row in the reconcile fetch after timeout — server-side state unknown',
            });
          }
        }
        lbResponse = {
          ok:         true,
          status:     0,
          applied:    synthesizedApplied,
          rejected:   synthesizedRejected,
          summary:    null,
          request_id: lbResponse.request_id || null,
          reconciled: true,
        };
        postTimeoutReconciled = true;
        summary.errors += uncertain.length;
        try { logger.warn(`[sf-historical-feedback] tenant=${tenantId} lb_state_reconciled_after_timeout applied=${synthesizedApplied.length} uncertain=${uncertain.length}`); } catch (_) {}
      } else {
        try { logger.error(`[sf-historical-feedback] tenant=${tenantId} post-timeout reconcile fetch failed: ${reconcilePage.reason}`); } catch (_) {}
        return {
          ok:         false,
          status:     502,
          error:      'lb_state_uncertain',
          detail:     'feedback apply timed out and the post-timeout reconcile fetch also failed; LB-side state unknown — operator must inspect LB directly',
          request_id: lbResponse.request_id || null,
          summary,
        };
      }
    }

    if (!lbResponse.ok) {
      try { logger.warn(`[sf-historical-feedback] tenant=${tenantId} LB feedback failed reason=${lbResponse.reason} status=${lbResponse.status || '-'} request_id=${lbResponse.request_id || '-'}`); } catch (_) {}
      return {
        ok:         false,
        status:     lbResponse.status || 502,
        error:      lbResponse.reason || 'lb_feedback_failed',
        detail:     lbResponse.error_description || null,
        request_id: lbResponse.request_id || null,
        summary,
      };
    }

    const applied  = Array.isArray(lbResponse.applied)  ? lbResponse.applied  : [];
    const rejected = Array.isArray(lbResponse.rejected) ? lbResponse.rejected : [];
    summary.applied  = applied.length;
    summary.rejected = rejected.length;

    try {
      logger.log(`[sf-historical-feedback] tenant=${tenantId} lb_user=${lbUserId} APPLIED applied=${applied.length} rejected=${rejected.length}${postTimeoutReconciled ? ' RECONCILED uncertain=' + uncertain.length : ''} request_id=${lbResponse.request_id || '-'}`);
    } catch (_) {}

    return {
      ok:                         true,
      phase:                      'phase_3_feedback_apply',
      summary,
      applied, rejected,
      uncertain,
      per_lead:                   proposedDebug,
      request_id:                 lbResponse.request_id || null,
      reconciled_after_timeout:   postTimeoutReconciled,
    };
  } finally {
    if (lockHeld) {
      try { await applyLock.release(supabase, tenantId); } catch (_) {}
    }
  }
}

module.exports = {
  runHistoricalSync,
  runHistoricalSyncApply,
  runHistoricalFeedbackApply,
  // exposed for tests
  resolveLbUserId,
  shouldAutoLink,
  isApplicable,
  categorize,
  categorizeByMatchType,
  lbLeadToMatcherInput,
  buildBucketEntry,
  buildLbApplyMatch,
  buildFeedbackRow,
  expectedLbSyncStatusFor,
  resolveSyncStatuses,
  MAX_LEADS_DEFAULT,
  MAX_LEADS_HARD_CAP,
  MAX_APPLY_BATCH,
  APPLY_ACTOR,
  APPLY_REASON,
  FEEDBACK_APPLY_REASON,
  FEEDBACK_DEFAULT_CLASSES,
  FEEDBACK_OPTIONAL_CLASSES,
  FEEDBACK_ALL_CLASSES,
  SCOPE_PENDING_ONLY,
  SCOPE_FULL_RECONCILE,
  VALID_SYNC_SCOPES,
  DEFAULT_SYNC_STATUSES_BY_SCOPE,
};
