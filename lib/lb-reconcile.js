'use strict';

// LB Reconcile — Phase 3 of the "Sync LeadBridge" workflow.
//
// Semantic model (post-refactor):
//   LB and SF/ZB are two independent lifecycles connected by an OPTIONAL
//   attribution bridge. This phase exists so SF can keep LB's view of an
//   acquired lead in sync when SF moves forward — e.g. cancellation
//   propagates back to the Thumbtack/Yelp lead. It does NOT enforce
//   status equality between the domains.
//
// Differences between an LB-linked SF job's status and its LB lead's
// status are reported as `cross_domain_difference` (the additive
// re-naming of `lifecycle_drift` + `pipeline_regression`), not as
// synchronization failures. A genuine failure is only when an enqueue
// itself errors — those land under `summary.failures`.
//
// After Phase 1 (LB → SF pull) finishes, this module:
//   - finds LB-linked SF jobs for the tenant
//   - compares each job's status (mapped to LB canonical) against the
//     LB lead's current canonical status (carried in from the Phase 1
//     pull — no extra LB API calls)
//   - enqueues outbound status events for SAFE transitions only,
//     through the existing `recordOutboundIfApplicable` pipeline
//
// Safety rules (per the task spec):
//   - no phone-only matching (we only operate on already-linked jobs;
//     the resolver did the linkage at job-create time)
//   - skip ambiguous, duplicate-customer, weak-match candidates
//   - skip if LB hard-terminal (archived)
//   - skip if push would be a pipeline regression
//   - idempotent: deterministic event_id per (job, canonical) so
//     repeated reconcile collapses to a no-op via the outbox UNIQUE
//     constraint on event_id
//
// Modes:
//   dryRun=true  — enumerate the plan, no enqueues
//   dryRun=false — enumerate AND enqueue via recordOutboundIfApplicable
//
// Returns:
//   { plan: [{ job_id, action, reason, sf_status, lb_status, ... }],
//     summary: { jobs_evaluated, statuses_pushed, ... } }

const { recordOutboundIfApplicable } = require('../services/lb-outbound-delivery');
const {
  mapSfToLbCanonical,
  isPipelineRegression,
  isHardTerminal,
} = require('./lb-sf-canonical-map');

// Stable event_id format for reconcile-sourced events. Two reconciles
// for the same (job, canonical) collide on UNIQUE and are treated as
// duplicate by `insertOutboxRow`. This is the idempotency mechanism.
function reconcileEventId(sfJobId, canonical) {
  return `evt_reconcile_${sfJobId}_${canonical}`;
}

// Coerce LB lead payload to a stable mini-shape we look up by externalRequestId.
function indexLbLeadsByExternalRequestId(allLbLeads) {
  const m = new Map();
  for (const lead of allLbLeads || []) {
    if (!lead || !lead.externalRequestId) continue;
    // Last writer wins — LB's /v1/leads?scope=all should not return
    // duplicates per externalRequestId, but a defensive overwrite is
    // cheap.
    m.set(String(lead.externalRequestId), {
      lb_id: lead.id,
      status: lead.status || null,
      platform: lead.platform || null,
      business_id: lead.businessId || null,
    });
  }
  return m;
}

async function fetchLinkedJobs(supabase, userId) {
  // Paginate. The Supabase default is 1000 rows; LB-linked job counts
  // are small today but the cron-ish reconcile path should be pagination-safe.
  const out = [];
  const pageSize = 1000;
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from('jobs')
      .select('id, user_id, status, lb_external_request_id, lb_channel, scheduled_date, total_amount, invoice_amount, customer_id, last_status_source, last_status_changed_at, created_at')
      .eq('user_id', userId)
      .not('lb_external_request_id', 'is', null)
      .range(from, from + pageSize - 1);
    if (error) throw new Error(`fetchLinkedJobs: ${error.message}`);
    if (!data || data.length === 0) break;
    out.push(...data);
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return out;
}

// Batch-load every job for a set of customer ids, returning a map
// customer_id → array of jobs. Used by the shadow-recurring-cancellation
// detector so we don't issue one DB call per cancelled candidate.
async function fetchPeerJobsByCustomer(supabase, userId, customerIds) {
  const byCust = new Map();
  if (!Array.isArray(customerIds) || customerIds.length === 0) return byCust;
  const pageSize = 1000;
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from('jobs')
      .select('id, customer_id, status, payment_status, scheduled_date, last_status_changed_at, created_at')
      .eq('user_id', userId)
      .in('customer_id', customerIds)
      .range(from, from + pageSize - 1);
    if (error) throw new Error(`fetchPeerJobsByCustomer: ${error.message}`);
    if (!data || data.length === 0) break;
    for (const r of data) {
      if (!byCust.has(r.customer_id)) byCust.set(r.customer_id, []);
      byCust.get(r.customer_id).push(r);
    }
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return byCust;
}

// SF statuses that mean "the customer is alive in the conversion funnel".
// If any peer job is in one of these AND scheduled AFTER this cancellation,
// the cancellation is a recurring follow-up cancellation, not a lead-level
// cancellation. See isShadowRecurringCancellation below.
const ACTIVE_LIFECYCLE_STATUSES = new Set([
  'scheduled', 'booked', 'in_progress', 'in-progress', 'confirmed',
]);

/**
 * Two-tier suppression for cancelled-job pushes that would downgrade
 * LB's lifecycle from converted to cancelled.
 *
 *   Tier 1 — strong (`strong_has_completed_peer`):
 *     The same customer has any other `completed` job. A real conversion
 *     happened; this cancellation is operational noise (cancelled future
 *     recurring appointment, deprecated booking, etc.). Suppress the
 *     push so LB lifecycle is not downgraded.
 *
 *   Tier 2 — medium (`medium_has_newer_active_peer`):
 *     No completed peer, but the customer has an ACTIVE (scheduled /
 *     booked / in_progress / confirmed) peer whose scheduled_date is
 *     LATER than this job's cancellation timestamp. Customer rebooked
 *     after cancelling — they are still in the conversion flow. Suppress.
 *
 *   No suppression:
 *     - Customer has only cancelled jobs (existing cancelled-only path)
 *     - Only stale / older active peers (predates this cancellation)
 *     - Peer has no comparable scheduled_date / no last_status_changed_at
 *       (cannot establish ordering — default to allowing the push)
 *
 * Returns { suppress: boolean, tier: 'strong_has_completed_peer' |
 *           'medium_has_newer_active_peer' | null,
 *           peer_job_ids: number[] } — peer_job_ids is the set of peer
 * jobs that justified the suppression (used for telemetry).
 */
function isShadowRecurringCancellation(job, peerJobs) {
  if ((job.status || '').toLowerCase() !== 'cancelled') {
    return { suppress: false, tier: null, peer_job_ids: [] };
  }
  if (!peerJobs || peerJobs.length === 0) {
    return { suppress: false, tier: null, peer_job_ids: [] };
  }

  // Tier 1 — strong: any completed peer is conclusive
  const completedPeers = peerJobs.filter((p) =>
    p.id !== job.id && (p.status || '').toLowerCase() === 'completed'
  );
  if (completedPeers.length > 0) {
    return {
      suppress: true,
      tier: 'strong_has_completed_peer',
      peer_job_ids: completedPeers.map((p) => p.id),
    };
  }

  // Tier 2 — medium: active peer scheduled AFTER this cancellation.
  // "After" = peer's scheduled_date is later than this job's
  // last_status_changed_at (the moment of cancellation), falling back
  // to created_at if no status-change timestamp is recorded.
  const refTime = job.last_status_changed_at || job.created_at || null;
  const cancelledAt = refTime ? new Date(refTime).getTime() : NaN;
  if (!Number.isFinite(cancelledAt)) {
    return { suppress: false, tier: null, peer_job_ids: [] };
  }

  const newerActivePeers = peerJobs.filter((p) => {
    if (p.id === job.id) return false;
    if (!ACTIVE_LIFECYCLE_STATUSES.has((p.status || '').toLowerCase())) return false;
    const peerSched = p.scheduled_date ? new Date(p.scheduled_date).getTime() : NaN;
    return Number.isFinite(peerSched) && peerSched > cancelledAt;
  });
  if (newerActivePeers.length > 0) {
    return {
      suppress: true,
      tier: 'medium_has_newer_active_peer',
      peer_job_ids: newerActivePeers.map((p) => p.id),
    };
  }

  return { suppress: false, tier: null, peer_job_ids: [] };
}

// Look up any outbox row that already represents this (job, canonical)
// transition. Used as a defense-in-depth idempotency check on top of
// the deterministic event_id collision.
async function existingOutboxRowFor(supabase, sfJobId, canonical) {
  const eventId = reconcileEventId(sfJobId, canonical);
  const { data, error } = await supabase
    .from('leadbridge_outbound_events')
    .select('id, event_id, state, result, terminal_at')
    .eq('event_id', eventId)
    .maybeSingle();
  if (error) return null;
  return data || null;
}

function actorForReconcile() {
  return {
    type: 'system',
    id: 'lb-reconcile',
    display_name: 'LB Reconcile',
  };
}

// Classify a single job. Returns one of:
//   { action: 'queue', ...details }      — safe to enqueue
//   { action: 'noop', reason, ...info }  — already in sync (LB matches)
//   { action: 'skipped', reason, ...}    — review_required / unsupported
async function classifyJob(supabase, job, lbStatusByExt, peerJobsByCust, logger) {
  const ext = job.lb_external_request_id;
  const lb = lbStatusByExt.get(String(ext));

  // The LB lead must exist in the pull response. If it's missing, the
  // lead may have been deleted on LB, hidden, or live on a tenant whose
  // account didn't get covered by `/v1/leads?scope=all`. Don't push —
  // the SF→LB lead may be wrong-targeted.
  if (!lb) {
    return { action: 'skipped', reason: 'lb_lead_not_in_pull', sf_status: job.status, lb_status: null };
  }

  const sfCanonical = mapSfToLbCanonical(job.status);
  if (!sfCanonical) {
    return { action: 'skipped', reason: 'sf_status_not_mappable', sf_status: job.status, lb_status: lb.status };
  }

  if (sfCanonical === lb.status) {
    return { action: 'noop', reason: 'already_in_sync', sf_status: job.status, sf_canonical: sfCanonical, lb_status: lb.status };
  }

  // Shadow-recurring-cancellation guard.
  //
  // Before allowing a cancelled push to flow downstream, check whether
  // this customer has any other job that represents a real conversion
  // (Tier 1: completed peer) or continued conversion intent (Tier 2:
  // newer active peer). If so, suppress the push — projecting this
  // cancellation to LB would downgrade lifecycle from converted to
  // cancelled, which is the bug we're fixing.
  //
  // Cancelled-only customers (no completed/active peers) fall through
  // and continue to push as before.
  const peers = peerJobsByCust ? (peerJobsByCust.get(job.customer_id) || []) : [];
  const shadow = isShadowRecurringCancellation(job, peers);
  if (shadow.suppress) {
    return {
      action: 'skipped',
      reason: 'shadow_recurring_cancellation',
      suppression_tier: shadow.tier,
      peer_job_ids: shadow.peer_job_ids,
      customer_id: job.customer_id,
      sf_status: job.status,
      sf_canonical: sfCanonical,
      lb_status: lb.status,
      lb_lead_id: lb.lb_id,
      lb_external_request_id: ext,
    };
  }

  // Hard terminal block — LB is `archived`. Per LB's lead-status.service
  // HARD_TERMINAL set, no source can overwrite this.
  if (isHardTerminal(lb.status)) {
    return { action: 'skipped', reason: 'lb_hard_terminal', sf_status: job.status, sf_canonical: sfCanonical, lb_status: lb.status };
  }

  // Pipeline regression guard — never push SF backwards.
  if (isPipelineRegression(lb.status, sfCanonical)) {
    return {
      action: 'skipped',
      reason: 'pipeline_regression',
      sf_status: job.status,
      sf_canonical: sfCanonical,
      lb_status: lb.status,
    };
  }

  // Defense-in-depth idempotency — even before the deterministic
  // event_id collision, check whether a prior reconcile already produced
  // a terminal-or-pending outbox row for this exact (job, canonical).
  try {
    const existing = await existingOutboxRowFor(supabase, job.id, sfCanonical);
    if (existing) {
      // If the previous attempt is sent/applied/duplicate/noop, treat
      // as idempotent no-op. If it failed terminally (dlq), surface
      // that as a separate reason so ops can address it.
      if (existing.state === 'dlq') {
        return {
          action: 'skipped',
          reason: 'previous_attempt_in_dlq',
          sf_status: job.status,
          sf_canonical: sfCanonical,
          lb_status: lb.status,
          existing_event_id: existing.event_id,
        };
      }
      return {
        action: 'noop',
        reason: 'outbound_already_queued_or_sent',
        sf_status: job.status,
        sf_canonical: sfCanonical,
        lb_status: lb.status,
        existing_event_id: existing.event_id,
        existing_state: existing.state,
      };
    }
  } catch (e) {
    logger.warn(`[LB Reconcile] existing-row lookup failed job=${job.id}: ${e?.message}`);
    // Fall through — recordOutboundIfApplicable will hit the unique
    // constraint instead, same outcome.
  }

  return {
    action: 'queue',
    reason: 'lifecycle_drift',
    sf_status: job.status,
    sf_canonical: sfCanonical,
    lb_status: lb.status,
    event_id: reconcileEventId(job.id, sfCanonical),
  };
}

async function reconcileTenantWithLb(supabase, userId, allLbLeads, options = {}) {
  const dryRun = !!options.dryRun;
  const logger = options.logger || console;

  const lbStatusByExt = indexLbLeadsByExternalRequestId(allLbLeads);

  logger.log(`[LB Reconcile] phase=pull_index lb_leads_indexed=${lbStatusByExt.size} user=${userId}`);

  let linkedJobs;
  try {
    linkedJobs = await fetchLinkedJobs(supabase, userId);
  } catch (e) {
    logger.error(`[LB Reconcile] fetchLinkedJobs failed: ${e.message}`);
    return {
      plan: [],
      summary: {
        jobs_evaluated: 0,
        statuses_pushed: 0,
        already_in_sync: 0,
        skipped_not_linked: 0,
        skipped_ambiguous: 0,
        skipped_unsupported: 0,
        skipped_no_lb_lead: 0,
        skipped_hard_terminal: 0,
        skipped_regression: 0,
        skipped_previous_dlq: 0,
        skipped_shadow_recurring_cancellation: 0,
        lifecycle_drift: 0,
        failures: 1,
        error: e.message,
      },
    };
  }

  // Pre-load peer jobs per customer for the shadow-recurring-cancellation
  // guard. Done as a single batched query (chunked internally if needed)
  // so the worst case is O(distinct_customers) round-trips, not
  // O(linkedJobs).
  const customerIds = Array.from(new Set(
    linkedJobs.map((j) => j.customer_id).filter((v) => v != null)
  ));
  let peerJobsByCust;
  try {
    peerJobsByCust = await fetchPeerJobsByCustomer(supabase, userId, customerIds);
  } catch (e) {
    logger.warn(`[LB Reconcile] fetchPeerJobsByCustomer failed: ${e.message} — shadow guard will be inactive for this run`);
    // Fall back to empty map — preserves prior behavior (no suppression).
    peerJobsByCust = new Map();
  }

  const summary = {
    jobs_evaluated: 0,
    statuses_pushed: 0,
    already_in_sync: 0,
    skipped_not_linked: 0,     // unused here (we only query linked jobs); kept for API stability
    skipped_ambiguous: 0,      // unused here; ambiguous jobs never landed linkage
    skipped_unsupported: 0,
    skipped_no_lb_lead: 0,
    skipped_hard_terminal: 0,
    skipped_regression: 0,
    skipped_previous_dlq: 0,
    skipped_shadow_recurring_cancellation: 0,
    lifecycle_drift: 0,
    failures: 0,
  };

  const plan = [];

  for (const job of linkedJobs) {
    summary.jobs_evaluated++;

    let entry;
    try {
      entry = await classifyJob(supabase, job, lbStatusByExt, peerJobsByCust, logger);
    } catch (e) {
      logger.error(`[LB Reconcile] classify failed job=${job.id}: ${e.message}`);
      summary.failures++;
      plan.push({ job_id: job.id, action: 'error', reason: e.message });
      continue;
    }

    const planEntry = { job_id: job.id, sf_job_status: job.status, ...entry };
    plan.push(planEntry);

    // Bucket the summary by entry.reason / action.
    if (entry.action === 'noop') {
      summary.already_in_sync++;
      logger.log(`[LB Reconcile] result=noop reason=${entry.reason} job=${job.id} sf=${entry.sf_canonical || entry.sf_status} lb=${entry.lb_status}`);
      continue;
    }
    if (entry.action === 'skipped') {
      switch (entry.reason) {
        case 'lb_lead_not_in_pull':              summary.skipped_no_lb_lead++; break;
        case 'sf_status_not_mappable':           summary.skipped_unsupported++; break;
        case 'lb_hard_terminal':                 summary.skipped_hard_terminal++; break;
        case 'pipeline_regression':              summary.skipped_regression++; break;
        case 'previous_attempt_in_dlq':          summary.skipped_previous_dlq++; break;
        case 'shadow_recurring_cancellation':    summary.skipped_shadow_recurring_cancellation++; break;
        default:                                 summary.skipped_unsupported++;
      }
      if (entry.reason === 'shadow_recurring_cancellation') {
        // Telemetry: explicit per-suppression log with customer + peer
        // context so operators can audit which cancellations were
        // suppressed and why.
        logger.log(
          `[LB Reconcile] result=skipped reason=shadow_recurring_cancellation ` +
          `tier=${entry.suppression_tier} job=${job.id} customer=${entry.customer_id} ` +
          `lb_lead=${entry.lb_lead_id || '-'} ext_req=${entry.lb_external_request_id || '-'} ` +
          `peer_jobs=[${(entry.peer_job_ids || []).join(',')}] ` +
          `sf=${entry.sf_status}(${entry.sf_canonical}) lb=${entry.lb_status}`
        );
      } else {
        logger.log(`[LB Reconcile] result=skipped reason=${entry.reason} job=${job.id} sf=${entry.sf_status} lb=${entry.lb_status ?? 'null'}`);
      }
      continue;
    }

    // action === 'queue'
    summary.lifecycle_drift++;
    if (dryRun) {
      logger.log(`[LB Reconcile] result=planned reason=lifecycle_drift job=${job.id} sf=${entry.sf_status}(${entry.sf_canonical}) lb=${entry.lb_status} dryRun=true`);
      continue;
    }

    // Apply — enqueue via the existing pipeline. recordOutboundIfApplicable
    // builds + signs the payload, inserts into the outbox, and (via UNIQUE
    // on event_id) collapses duplicates to a no-op.
    try {
      const result = await recordOutboundIfApplicable(supabase, {
        job,
        oldStatus: entry.lb_status,                  // LB's view becomes payload.previous
        newStatus: job.status,                       // SF's raw status — LB's mapSfStatus will canonicalize
        actor: actorForReconcile(),
        source: 'system',
        eventIdOverride: entry.event_id,             // deterministic — see below
      });

      planEntry.outbound_result = result.action;
      planEntry.outbound_event_id = result.row?.event_id || result.event_id || entry.event_id;

      if (result.action === 'enqueued') {
        summary.statuses_pushed++;
        logger.log(`[LB Reconcile] result=queued reason=lifecycle_drift job=${job.id} sf=${entry.sf_status}(${entry.sf_canonical}) lb=${entry.lb_status} event_id=${planEntry.outbound_event_id}`);
      } else {
        // Could be skipped_loop / skipped_not_linked / skipped_unmapped / disabled.
        // We expect 'enqueued' here because we pre-filtered for linkage and
        // mappability, but log the actual outcome for auditability.
        summary.failures++;
        logger.warn(`[LB Reconcile] result=unexpected reason=${result.action} job=${job.id}`);
      }
    } catch (e) {
      summary.failures++;
      planEntry.outbound_result = 'error';
      planEntry.outbound_error = e?.message || String(e);
      logger.error(`[LB Reconcile] enqueue failed job=${job.id}: ${e?.message}`);
    }
  }

  // ── CROSS-DOMAIN VIEW (additive, semantic refactor) ───────────────
  // LB lifecycle and SF/ZB operational lifecycle are independent domains.
  // The original `lifecycle_drift` and `pipeline_regression` counters
  // describe legitimate CROSS-DOMAIN DIFFERENCES, not synchronization
  // failures. Re-present them under a name that reflects the model:
  //   - `cross_domain_difference` rolls up both forward differences
  //     (SF ahead of LB → safe to push) and reverse differences (LB ahead
  //     of SF → skipped, awaiting operator decision).
  //   - `not_applicable_to_lb` is the renamed `skipped_unsupported` —
  //     SF status has no LB equivalent (e.g. SF future-scheduled jobs).
  //     This is normal, not a mapping gap.
  // Legacy keys (`lifecycle_drift`, `pipeline_regression`,
  // `skipped_unsupported`, ...) are preserved for backwards compatibility
  // with any consumer reading the previous shape.
  summary.cross_domain_difference = (summary.lifecycle_drift || 0) + (summary.skipped_regression || 0);
  summary.not_applicable_to_lb = summary.skipped_unsupported || 0;

  logger.log(
    `[LB Reconcile] phase=status_push user=${userId} ` +
    `evaluated=${summary.jobs_evaluated} queued=${summary.statuses_pushed} ` +
    `in_sync=${summary.already_in_sync} cross_domain_difference=${summary.cross_domain_difference} ` +
    `not_applicable_to_lb=${summary.not_applicable_to_lb} ` +
    `no_lb_lead=${summary.skipped_no_lb_lead} hard_terminal=${summary.skipped_hard_terminal} ` +
    `shadow_recurring_cancellation=${summary.skipped_shadow_recurring_cancellation} ` +
    `prev_dlq=${summary.skipped_previous_dlq} failures=${summary.failures} dryRun=${dryRun}`
  );

  return { plan, summary };
}

module.exports = {
  reconcileTenantWithLb,
  classifyJob,                          // exported for tests
  indexLbLeadsByExternalRequestId,
  reconcileEventId,
  actorForReconcile,
  isShadowRecurringCancellation,        // exported for tests
  fetchPeerJobsByCustomer,              // exported for tests
  ACTIVE_LIFECYCLE_STATUSES,            // exported for tests
};
