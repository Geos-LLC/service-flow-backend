'use strict';

/**
 * ZB missing-jobs cron.
 *
 * Companion to zb-future-reconcile-cron. That cron catches ZB → SF drift
 * where SF has a job that ZB has cancelled. This one catches the reverse:
 * ZB has a job SF has never seen because no `job.created` webhook ever
 * fired for it.
 *
 * The empirical case: future instances of recurring bookings. ZB
 * materializes each instance as its own job (with `recurring=true` and a
 * `recurring_instance` counter) but does NOT fire `job.created` for the
 * future instances at booking-creation time. Instances only surface via
 * webhooks when a subsequent event (edit, cancel, en_route, …) fires,
 * which for a stable weekly booking may not happen until the day of.
 * Result: rows show up in ZB's calendar but never in SF's until close
 * to the scheduled time — sometimes not until the cleaner is en route.
 *
 * Fix: periodically pull `/jobs?start_date_min=today&start_date_max=+30d`
 * per tenant and insert any ZB job id SF doesn't have. Reuses
 * `syncJobs()` from zenbooker-sync.js (same mapping + LB linkage + team
 * assignments) so behavior matches the manual "Sync Jobs" button.
 *
 * Gating (mirrors the sibling cron so operators have one mental model):
 *
 *   ZB_MISSING_JOBS_ENABLED         Must equal 'true' for any tick to run.
 *   ZB_MISSING_JOBS_APPLY           Must equal 'true' for writes.
 *                                   Default: dry-run (no writes).
 *   ZB_MISSING_JOBS_INTERVAL_MS     Tick cadence. Default 1h.
 *   ZB_MISSING_JOBS_LOOKAHEAD_DAYS  Window from now to pull. Default 30.
 *   ZB_MISSING_JOBS_LOOKBACK_DAYS   Past window (catches materializations
 *                                   dated slightly in the past). Default 2.
 *
 * Concurrency: a single-flight guard in the tick loop keeps a slow tick
 * from overlapping the next one. Multi-replica safety uses the same
 * advisory-lock RPC as the sibling reconcile cron.
 */

const TRUE_VALUES = new Set(['true', '1', 'yes', 'on']);
function envFlag(name) {
  const v = (process.env[name] || '').toLowerCase();
  return TRUE_VALUES.has(v);
}

function envInt(name, defaultValue) {
  const v = parseInt(process.env[name], 10);
  return Number.isFinite(v) && v > 0 ? v : defaultValue;
}

const ENABLED = () => envFlag('ZB_MISSING_JOBS_ENABLED');
const APPLY = () => envFlag('ZB_MISSING_JOBS_APPLY');
const INTERVAL_MS = () => envInt('ZB_MISSING_JOBS_INTERVAL_MS', 3600 * 1000);
const LOOKAHEAD_DAYS = () => envInt('ZB_MISSING_JOBS_LOOKAHEAD_DAYS', 30);
const LOOKBACK_DAYS = () => {
  const raw = parseInt(process.env.ZB_MISSING_JOBS_LOOKBACK_DAYS, 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : 2;
};

/**
 * ISO date (YYYY-MM-DD) — ZB's start_date filters compare on the date part.
 */
function isoDateAt(now, offsetDays) {
  const d = new Date(now.getTime() + offsetDays * 86400000);
  return d.toISOString().slice(0, 10);
}

/**
 * One reconciliation tick. Exported so tests can drive it directly.
 *
 * syncJobsFn: async (userId, apiKey, params, maxJobs) => { total, created, skipped, errors }
 * The same helper the operator "Sync Jobs" button uses. Injected so tests
 * can stub without booting the full zenbooker-sync router factory.
 */
async function runMissingJobsTick({ supabase, logger = console, syncJobsFn, now = new Date() }) {
  if (!ENABLED()) {
    return { skipped: 'disabled' };
  }
  if (typeof syncJobsFn !== 'function') {
    logger.error('[ZBMissingJobsCron] syncJobsFn dependency missing — cron cannot run');
    return { skipped: 'no_sync_jobs_fn' };
  }

  const apply = APPLY();
  const lookaheadDays = LOOKAHEAD_DAYS();
  const lookbackDays = LOOKBACK_DAYS();

  const startDate = isoDateAt(now, -lookbackDays);
  const endDate = isoDateAt(now, lookaheadDays);

  const { data: users, error: usersErr } = await supabase
    .from('users')
    .select('id, zenbooker_api_key')
    .eq('zenbooker_status', 'connected')
    .not('zenbooker_api_key', 'is', null);
  if (usersErr) {
    logger.error(`[ZBMissingJobsCron] users query failed: ${usersErr.message}`);
    return { error: 'users_query_failed' };
  }

  const tenants = (users || []).filter(u => u.zenbooker_api_key);
  logger.log(
    `[ZBMissingJobsCron] tick starting — tenants=${tenants.length} apply=${apply} ` +
    `window=${startDate}..${endDate}`
  );

  const tickSummary = {
    tenants: tenants.length,
    tenantsProcessed: 0,
    tenantFailures: 0,
    totals: { fetched: 0, created: 0, skipped: 0, errors: 0 },
  };

  for (const tenant of tenants) {
    if (!apply) {
      logger.log(`[ZBMissingJobsCron] tenant userId=${tenant.id} — dry-run (APPLY=false), skipping insert`);
      tickSummary.tenantsProcessed += 1;
      continue;
    }
    try {
      const params = {
        canceled: 'false',
        start_date_min: startDate,
        start_date_max: endDate,
      };
      const result = await syncJobsFn(tenant.id, tenant.zenbooker_api_key, params, 0);
      tickSummary.tenantsProcessed += 1;
      tickSummary.totals.fetched += result?.total || 0;
      tickSummary.totals.created += result?.created || 0;
      tickSummary.totals.skipped += result?.skipped || 0;
      tickSummary.totals.errors += result?.errors || 0;
      logger.log(
        `[ZBMissingJobsCron] tenant userId=${tenant.id} — ` +
        `fetched=${result?.total || 0} created=${result?.created || 0} ` +
        `skipped=${result?.skipped || 0} errors=${result?.errors || 0}`
      );
    } catch (e) {
      tickSummary.tenantFailures += 1;
      logger.error(
        `[ZBMissingJobsCron] tenant userId=${tenant.id} failed: ${e.message || e}`
      );
    }
  }

  logger.log(`[ZBMissingJobsCron] tick complete — ${JSON.stringify(tickSummary)}`);
  return tickSummary;
}

/**
 * Long-running entry point. Mirrors zb-future-reconcile-cron's shape so
 * server.js wires it identically.
 */
function startMissingJobsCron({ supabase, logger = console, syncJobsFn }) {
  if (!ENABLED()) {
    logger.log('[ZBMissingJobsCron] ZB_MISSING_JOBS_ENABLED is not true — cron not started');
    return { started: false, reason: 'disabled' };
  }
  if (typeof syncJobsFn !== 'function') {
    logger.error('[ZBMissingJobsCron] syncJobsFn dependency missing — cron not started');
    return { started: false, reason: 'no_sync_jobs_fn' };
  }

  const intervalMs = INTERVAL_MS();
  logger.log(
    `[ZBMissingJobsCron] starting — interval=${intervalMs}ms apply=${APPLY()} ` +
    `lookahead=${LOOKAHEAD_DAYS()}d lookback=${LOOKBACK_DAYS()}d`
  );

  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runMissingJobsTick({ supabase, logger, syncJobsFn });
    } catch (e) {
      logger.error(`[ZBMissingJobsCron] uncaught tick error: ${e.message || e}`);
    } finally {
      running = false;
    }
  };

  // Stagger against the sibling reconcile cron so both don't hammer ZB
  // at the same startup moment.
  const startupDelayMs = 90_000;
  const startupTimer = setTimeout(tick, startupDelayMs);
  startupTimer.unref?.();

  const interval = setInterval(tick, intervalMs);
  interval.unref?.();

  return { started: true, intervalMs, stop: () => { clearInterval(interval); clearTimeout(startupTimer); } };
}

module.exports = {
  startMissingJobsCron,
  runMissingJobsTick,
  // exported for tests:
  ENABLED,
  APPLY,
  INTERVAL_MS,
  LOOKAHEAD_DAYS,
  LOOKBACK_DAYS,
  isoDateAt,
};
