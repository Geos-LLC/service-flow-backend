'use strict';

// LB Reconcile — Phase 2/3/4 of the "Sync LeadBridge" workflow.
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
      .select('id, user_id, status, lb_external_request_id, lb_channel, scheduled_date, total_amount, invoice_amount, customer_id, last_status_source, last_status_changed_at')
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
async function classifyJob(supabase, job, lbStatusByExt, logger) {
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
        lifecycle_drift: 0,
        failures: 1,
        error: e.message,
      },
    };
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
    lifecycle_drift: 0,
    failures: 0,
  };

  const plan = [];

  for (const job of linkedJobs) {
    summary.jobs_evaluated++;

    let entry;
    try {
      entry = await classifyJob(supabase, job, lbStatusByExt, logger);
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
        case 'lb_lead_not_in_pull':     summary.skipped_no_lb_lead++; break;
        case 'sf_status_not_mappable':  summary.skipped_unsupported++; break;
        case 'lb_hard_terminal':        summary.skipped_hard_terminal++; break;
        case 'pipeline_regression':     summary.skipped_regression++; break;
        case 'previous_attempt_in_dlq': summary.skipped_previous_dlq++; break;
        default:                        summary.skipped_unsupported++;
      }
      logger.log(`[LB Reconcile] result=skipped reason=${entry.reason} job=${job.id} sf=${entry.sf_status} lb=${entry.lb_status ?? 'null'}`);
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

  logger.log(
    `[LB Reconcile] phase=status_push user=${userId} ` +
    `evaluated=${summary.jobs_evaluated} queued=${summary.statuses_pushed} ` +
    `in_sync=${summary.already_in_sync} drift=${summary.lifecycle_drift} ` +
    `no_lb_lead=${summary.skipped_no_lb_lead} hard_terminal=${summary.skipped_hard_terminal} ` +
    `regression=${summary.skipped_regression} unsupported=${summary.skipped_unsupported} ` +
    `prev_dlq=${summary.skipped_previous_dlq} failures=${summary.failures} dryRun=${dryRun}`
  );

  return { plan, summary };
}

module.exports = {
  reconcileTenantWithLb,
  classifyJob,                // exported for tests
  indexLbLeadsByExternalRequestId,
  reconcileEventId,
  actorForReconcile,
};
