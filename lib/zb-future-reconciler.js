'use strict';

/**
 * ZB → SF future-job reconciliation (silent-cancel safety net).
 *
 * Background:
 *   Zenbooker fires webhooks for most state changes (job.created, job.rescheduled,
 *   invoice.payment_*, etc.), but it does NOT fire a `job.canceled` event when a
 *   user cancels a single future instance of a recurring booking. Our DB stays
 *   `scheduled` indefinitely. The only built-in catch was the operator-driven
 *   manual reconcile.
 *
 *   This module is the shared reconciliation core used by:
 *     1. The `recurring_booking.canceled` webhook handler (so when the whole
 *        series is killed, we reconcile every job from that booking).
 *     2. A scheduled cron (workers/zb-future-reconcile-cron.js) that scans
 *        each connected tenant's future scheduled jobs and corrects drift.
 *     3. A one-shot operator script (scripts/zb-future-reconcile-one-shot.js)
 *        for targeted dry-run / apply runs.
 *
 * Scope (intentionally narrow):
 *   - Only `status` / cancellation drift is reconciled here. We DO NOT touch
 *     customer rows, ledger arithmetic, payroll math, identity graphs, or any
 *     non-status ZB field. Cancellation triggers the SAME completion-derived
 *     ledger cleanup the webhook cancel path uses (safeDeleteCompletionDerivedLedger),
 *     nothing broader.
 *   - SF jobs in hard-terminal states (completed, paid, cancelled) are NEVER
 *     mutated — even if ZB says otherwise. Drift on terminal rows is an
 *     operator concern (Constitution §3.6 compensating entry), not something
 *     this cron silently rewrites.
 *   - A ZB 404 → `skipped_missing_upstream`. We do NOT delete the SF row.
 *
 * Dependency injection:
 *   `zbFetchFn` and `updateJobStatusFn` are accepted as overridable args so
 *   the unit tests can drive the function without spinning up a real Express
 *   app or hitting ZB. Production callers pass the real implementations.
 */

const { safeDeleteCompletionDerivedLedger } = require('./ledger-immutability');

// SF statuses we'll consider mutating. Values must match the DB `job_status`
// enum exactly — this set is passed to `supabase.in('status', …)`, which
// validates against the enum at query time. Variants ZB may report
// (`en_route`, `enroute`, `complete`) are normalized upstream by the
// existing STATUS_MAP in zenbooker-sync.js / lib/zenbooker-lifecycle.js, so
// by the time a row reaches us here its status is already in canonical
// enum form. (DB enum members verified 2026-05-30: pending, confirmed,
// in-progress, completed, cancelled, scheduled, en-route, started, complete,
// late, rescheduled, paid.)
const ELIGIBLE_FROM_STATUSES = new Set([
  'scheduled',
  'pending',
  'confirmed',
  'rescheduled',
  'en-route',
  'started',
  'in-progress',
  'late',
]);

// SF statuses we will NEVER mutate from this code path.
const HARD_TERMINAL_STATUSES = new Set([
  'completed',
  'paid',
  'cancelled',
  'canceled',
]);

function isZb404Error(err) {
  if (!err) return false;
  const msg = String(err.message || err);
  // The shared zbFetch helper throws `Zenbooker API <code>: <body>`. Match the
  // status prefix so a body containing "404" elsewhere doesn't false-positive.
  return /Zenbooker API 404\b/.test(msg);
}

/**
 * Reconcile a single SF job against its ZB counterpart. Pure function over the
 * provided dependencies — no module-level singletons touched.
 *
 * @returns {Promise<{
 *   action: 'updated_cancelled' | 'would_update_cancelled' | 'already_in_sync' |
 *           'skipped_hard_terminal' | 'skipped_missing_upstream' |
 *           'skipped_no_zb_id' | 'skipped_ineligible' | 'failed',
 *   reason: string,
 *   beforeStatus?: string,
 *   afterStatus?: string,
 * }>}
 */
async function reconcileJobAgainstZB({
  supabase,
  sfJob,
  apiKey,
  dryRun = true,
  logger = console,
  source = 'zb_future_reconcile',
  zbFetchFn,
  updateJobStatusFn,
}) {
  if (!sfJob) {
    return { action: 'failed', reason: 'no sfJob provided' };
  }
  if (!sfJob.zenbooker_id) {
    return { action: 'skipped_no_zb_id', reason: 'sfJob.zenbooker_id is null' };
  }

  const beforeStatus = String(sfJob.status || '').toLowerCase();

  if (HARD_TERMINAL_STATUSES.has(beforeStatus)) {
    return {
      action: 'skipped_hard_terminal',
      reason: `SF status=${beforeStatus} is terminal`,
      beforeStatus,
    };
  }

  if (!ELIGIBLE_FROM_STATUSES.has(beforeStatus)) {
    return {
      action: 'skipped_ineligible',
      reason: `SF status=${beforeStatus} is not in eligible-from set`,
      beforeStatus,
    };
  }

  let zbJob;
  try {
    zbJob = await zbFetchFn(apiKey, `/jobs/${sfJob.zenbooker_id}`);
  } catch (err) {
    if (isZb404Error(err)) {
      return {
        action: 'skipped_missing_upstream',
        reason: `ZB returned 404 for ${sfJob.zenbooker_id}`,
        beforeStatus,
      };
    }
    return {
      action: 'failed',
      reason: `ZB fetch error: ${err.message || err}`,
      beforeStatus,
    };
  }

  if (!zbJob || typeof zbJob !== 'object') {
    return {
      action: 'skipped_missing_upstream',
      reason: 'ZB returned empty payload',
      beforeStatus,
    };
  }

  // Today this code only acts on the cancellation drift case — that is the
  // documented silent-update path ZB has. Other status drifts (e.g. ZB says
  // completed but SF says scheduled) are caught by the webhook flow and not
  // this safety net. Extending here would widen the blast radius — leave it
  // to the operator-driven manual reconcile.
  if (zbJob.canceled !== true) {
    return {
      action: 'already_in_sync',
      reason: 'ZB canceled=false; no cancellation drift detected',
      beforeStatus,
    };
  }

  const afterStatus = 'cancelled';

  if (dryRun) {
    logger?.log?.(
      `[ZBFutureReconcile] DRY-RUN userId=${sfJob.user_id} jobId=${sfJob.id} zbJobId=${sfJob.zenbooker_id} ` +
      `action=would_update_cancelled before=${beforeStatus} after=${afterStatus}`
    );
    return {
      action: 'would_update_cancelled',
      reason: 'ZB canceled=true; dry-run',
      beforeStatus,
      afterStatus,
    };
  }

  // Apply the status change through the same service the webhook uses.
  try {
    await updateJobStatusFn(supabase, {
      jobId: sfJob.id,
      userId: sfJob.user_id,
      newStatus: afterStatus,
      source: 'system',
      actor: { type: 'system', id: null, display_name: source },
    });
  } catch (err) {
    return {
      action: 'failed',
      reason: `updateJobStatus failed: ${err.message || err}`,
      beforeStatus,
    };
  }

  // Mirror the webhook cancel path — wipe UNBATCHED completion-derived ledger
  // rows. Settled rows are immutable per Constitution §3.1; the helper
  // surfaces those as `skippedBatched` for the log line.
  try {
    const { deleted, skippedBatched } = await safeDeleteCompletionDerivedLedger(supabase, {
      jobId: sfJob.id,
      source,
    });
    if (deleted > 0 || (skippedBatched && skippedBatched.length > 0)) {
      logger?.log?.(
        `[ZBFutureReconcile] ledger-cleanup jobId=${sfJob.id} deleted=${deleted} skippedBatched=${skippedBatched.length}`
      );
    }
  } catch (err) {
    // Non-blocking — the status update already succeeded. Log so operator
    // can compensate via §3.6 if needed.
    logger?.warn?.(
      `[ZBFutureReconcile] ledger-cleanup failed jobId=${sfJob.id}: ${err.message || err}`
    );
  }

  logger?.log?.(
    `[ZBFutureReconcile] APPLY userId=${sfJob.user_id} jobId=${sfJob.id} zbJobId=${sfJob.zenbooker_id} ` +
    `action=updated_cancelled before=${beforeStatus} after=${afterStatus}`
  );

  return {
    action: 'updated_cancelled',
    reason: 'ZB canceled=true; SF updated',
    beforeStatus,
    afterStatus,
  };
}

const SUMMARY_KEYS = [
  'scanned',
  'fetched',
  'updated_cancelled',
  'would_update_cancelled',
  'already_in_sync',
  'skipped_hard_terminal',
  'skipped_missing_upstream',
  'skipped_no_zb_id',
  'skipped_ineligible',
  'skipped_conflict',
  'failures',
];

function emptySummary() {
  const s = {};
  for (const k of SUMMARY_KEYS) s[k] = 0;
  return s;
}

/**
 * Scan a single tenant's eligible SF jobs and reconcile each against ZB.
 *
 * @param {Object} args
 * @param {Object} args.supabase
 * @param {number} args.userId            tenant scope (REQUIRED — enforces per-tenant isolation)
 * @param {string} args.apiKey            tenant's ZB API key
 * @param {boolean} [args.dryRun=true]    default safe
 * @param {number}  [args.lookaheadDays=30]
 * @param {string}  [args.startDate]      ISO date (overrides lookahead start)
 * @param {string}  [args.endDate]        ISO date (overrides lookahead end)
 * @param {number[]} [args.jobIdFilter]   restrict to specific SF job ids
 * @param {string[]} [args.zenbookerIdFilter] restrict to specific ZB job ids
 * @param {number}  [args.perJobDelayMs=50] tiny pacing to avoid hammering ZB
 * @param {Object}  [args.logger]
 * @param {Function} [args.zbFetchFn]
 * @param {Function} [args.updateJobStatusFn]
 * @returns {Promise<{summary: Object, changes: Array}>}
 */
async function reconcileFutureJobs({
  supabase,
  userId,
  apiKey,
  dryRun = true,
  lookaheadDays = 30,
  startDate,
  endDate,
  jobIdFilter,
  zenbookerIdFilter,
  perJobDelayMs = 50,
  logger = console,
  source = 'zb_future_reconcile_scan',
  zbFetchFn,
  updateJobStatusFn,
}) {
  const summary = emptySummary();
  const changes = [];

  if (!userId) {
    logger?.error?.('[ZBFutureReconcile] userId is required');
    return { summary, changes };
  }
  if (!apiKey) {
    logger?.error?.(`[ZBFutureReconcile] userId=${userId} has no ZB apiKey; aborting`);
    return { summary, changes };
  }

  const now = new Date();
  const lookEnd = new Date(now.getTime() + lookaheadDays * 86400000);
  const fromIso = startDate || now.toISOString();
  const toIso = endDate || lookEnd.toISOString();

  let query = supabase.from('jobs')
    .select('id, user_id, zenbooker_id, status, scheduled_date')
    .eq('user_id', userId)
    .not('zenbooker_id', 'is', null)
    .in('status', Array.from(ELIGIBLE_FROM_STATUSES))
    .gte('scheduled_date', fromIso)
    .lte('scheduled_date', toIso);

  if (Array.isArray(jobIdFilter) && jobIdFilter.length > 0) {
    query = query.in('id', jobIdFilter);
  }
  if (Array.isArray(zenbookerIdFilter) && zenbookerIdFilter.length > 0) {
    query = query.in('zenbooker_id', zenbookerIdFilter);
  }

  const { data: jobs, error } = await query;
  if (error) {
    logger?.error?.(`[ZBFutureReconcile] userId=${userId} job query error: ${error.message}`);
    return { summary, changes };
  }

  summary.scanned = (jobs || []).length;
  logger?.log?.(
    `[ZBFutureReconcile] userId=${userId} scanning ${summary.scanned} eligible jobs ` +
    `(${fromIso} → ${toIso}) dryRun=${dryRun}`
  );

  for (const job of (jobs || [])) {
    try {
      summary.fetched += 1;
      const result = await reconcileJobAgainstZB({
        supabase,
        sfJob: job,
        apiKey,
        dryRun,
        logger,
        source,
        zbFetchFn,
        updateJobStatusFn,
      });

      const key = result.action;
      if (key in summary) {
        summary[key] += 1;
      } else if (key === 'failed') {
        summary.failures += 1;
      }

      if (
        result.action === 'updated_cancelled' ||
        result.action === 'would_update_cancelled'
      ) {
        changes.push({
          jobId: job.id,
          userId: job.user_id,
          zbJobId: job.zenbooker_id,
          beforeStatus: result.beforeStatus,
          afterStatus: result.afterStatus,
          dryRun,
        });
      }

      logger?.log?.(
        `[ZBFutureReconcile] userId=${userId} jobId=${job.id} zbJobId=${job.zenbooker_id} ` +
        `action=${result.action} reason="${result.reason}"`
      );
    } catch (err) {
      summary.failures += 1;
      logger?.error?.(
        `[ZBFutureReconcile] userId=${userId} jobId=${job.id} unexpected error: ${err.message || err}`
      );
    }

    if (perJobDelayMs > 0) {
      await new Promise(r => setTimeout(r, perJobDelayMs));
    }
  }

  logger?.log?.(
    `[ZBFutureReconcile] userId=${userId} SUMMARY ${JSON.stringify(summary)}`
  );

  return { summary, changes };
}

/**
 * Reconcile every job belonging to a recurring booking.
 *
 * Used by the `recurring_booking.canceled` webhook handler: we fetch the
 * booking from ZB (which returns its full job list), then run each ZB job id
 * through reconcileJobAgainstZB. Completed instances stay completed; future
 * scheduled-but-now-canceled instances get updated.
 *
 * The webhook handler passes the tenant's apiKey + userId. The looked-up SF
 * jobs are scoped to (user_id, zenbooker_id) so we never write to another
 * tenant's data.
 */
async function reconcileRecurringBooking({
  supabase,
  userId,
  apiKey,
  recurringBookingZbId,
  dryRun = false,
  logger = console,
  zbFetchFn,
  updateJobStatusFn,
}) {
  const summary = emptySummary();
  const changes = [];

  if (!userId || !apiKey || !recurringBookingZbId) {
    logger?.error?.(`[ZBFutureReconcile] reconcileRecurringBooking missing args`);
    return { summary, changes, jobsFromZb: 0 };
  }

  let booking;
  try {
    booking = await zbFetchFn(apiKey, `/recurring-bookings/${recurringBookingZbId}`);
  } catch (err) {
    logger?.error?.(
      `[ZBFutureReconcile] recurring-booking fetch failed rb=${recurringBookingZbId}: ${err.message || err}`
    );
    return { summary, changes, jobsFromZb: 0 };
  }

  const zbJobIds = Array.isArray(booking?.jobs) ? booking.jobs.filter(Boolean) : [];
  if (zbJobIds.length === 0) {
    logger?.log?.(
      `[ZBFutureReconcile] recurring-booking rb=${recurringBookingZbId} returned 0 job ids`
    );
    return { summary, changes, jobsFromZb: 0 };
  }

  // Pull matching SF rows for the tenant in one query — scoped by user_id so
  // we cannot accidentally touch another tenant's data even if ZB returned a
  // foreign job id.
  const { data: sfRows, error } = await supabase
    .from('jobs')
    .select('id, user_id, zenbooker_id, status, scheduled_date')
    .eq('user_id', userId)
    .in('zenbooker_id', zbJobIds);
  if (error) {
    logger?.error?.(
      `[ZBFutureReconcile] sf-job lookup failed rb=${recurringBookingZbId}: ${error.message}`
    );
    return { summary, changes, jobsFromZb: zbJobIds.length };
  }

  summary.scanned = (sfRows || []).length;
  logger?.log?.(
    `[ZBFutureReconcile] rb=${recurringBookingZbId} jobs_from_zb=${zbJobIds.length} ` +
    `sf_rows=${summary.scanned} dryRun=${dryRun}`
  );

  for (const job of (sfRows || [])) {
    try {
      summary.fetched += 1;
      const result = await reconcileJobAgainstZB({
        supabase,
        sfJob: job,
        apiKey,
        dryRun,
        logger,
        source: `zb_rb_cancel:${recurringBookingZbId}`,
        zbFetchFn,
        updateJobStatusFn,
      });

      const key = result.action;
      if (key in summary) {
        summary[key] += 1;
      } else if (key === 'failed') {
        summary.failures += 1;
      }

      if (
        result.action === 'updated_cancelled' ||
        result.action === 'would_update_cancelled'
      ) {
        changes.push({
          jobId: job.id,
          userId: job.user_id,
          zbJobId: job.zenbooker_id,
          beforeStatus: result.beforeStatus,
          afterStatus: result.afterStatus,
          dryRun,
        });
      }
    } catch (err) {
      summary.failures += 1;
      logger?.error?.(
        `[ZBFutureReconcile] rb=${recurringBookingZbId} jobId=${job.id} error: ${err.message || err}`
      );
    }
  }

  logger?.log?.(
    `[ZBFutureReconcile] rb=${recurringBookingZbId} SUMMARY ${JSON.stringify(summary)}`
  );

  return { summary, changes, jobsFromZb: zbJobIds.length };
}

module.exports = {
  reconcileJobAgainstZB,
  reconcileFutureJobs,
  reconcileRecurringBooking,
  ELIGIBLE_FROM_STATUSES,
  HARD_TERMINAL_STATUSES,
  SUMMARY_KEYS,
  emptySummary,
  isZb404Error,
};
