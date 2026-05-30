'use strict';

/**
 * ZB future-job reconciliation cron.
 *
 * Daily safety net for the silent-cancel case ZB doesn't webhook us about.
 * For every ZB-connected tenant, scans future scheduled jobs (next N days)
 * and reconciles status drift against ZB. Settled / completed rows are
 * untouched. See lib/zb-future-reconciler.js for the reconcile semantics.
 *
 * Gating (multi-layered so this is hard to enable accidentally):
 *
 *   ZB_FUTURE_RECONCILE_ENABLED       Must equal 'true' for any tick to run.
 *                                     Default: not set (worker exits early).
 *   ZB_FUTURE_RECONCILE_APPLY         Must equal 'true' for writes.
 *                                     Default: dry-run (no writes). Lets us
 *                                     deploy code + flag observe-only first.
 *   ZB_FUTURE_RECONCILE_INTERVAL_MS   Tick cadence. Default 24h.
 *   ZB_FUTURE_RECONCILE_LOOKAHEAD_DAYS  Window from now to scan. Default 30.
 *   ZB_FUTURE_RECONCILE_PER_JOB_DELAY_MS  ZB pacing. Default 50ms.
 *
 * Concurrency:
 *   - pg_try_advisory_lock via zb_future_reconcile_try_tick_lock() RPC
 *     (migration 063) ensures only one replica reconciles per tick.
 *
 * Operational shape:
 *   - Uses the SAME lib/zb-future-reconciler reconcileFutureJobs function
 *     the operator one-shot script uses. Behavior is identical; only the
 *     surrounding cadence + lock + dryRun decision differ.
 *   - Iterates one tenant at a time; failures on tenant A don't block B.
 *   - One summary log line per tenant per tick, plus per-job action lines
 *     from inside the reconciler.
 */

const { reconcileFutureJobs } = require('../lib/zb-future-reconciler');

const TRUE_VALUES = new Set(['true', '1', 'yes', 'on']);
function envFlag(name) {
  const v = (process.env[name] || '').toLowerCase();
  return TRUE_VALUES.has(v);
}

function envInt(name, defaultValue) {
  const v = parseInt(process.env[name], 10);
  return Number.isFinite(v) && v > 0 ? v : defaultValue;
}

const ENABLED = () => envFlag('ZB_FUTURE_RECONCILE_ENABLED');
const APPLY = () => envFlag('ZB_FUTURE_RECONCILE_APPLY');
const INTERVAL_MS = () => envInt('ZB_FUTURE_RECONCILE_INTERVAL_MS', 24 * 3600 * 1000);
const LOOKAHEAD_DAYS = () => envInt('ZB_FUTURE_RECONCILE_LOOKAHEAD_DAYS', 30);
const PER_JOB_DELAY_MS = () => {
  const v = parseInt(process.env.ZB_FUTURE_RECONCILE_PER_JOB_DELAY_MS, 10);
  return Number.isFinite(v) && v >= 0 ? v : 50;
};

const ZB_BASE = 'https://api.zenbooker.com/v1';

async function zbFetch(apiKey, path, params = {}) {
  const url = new URL(`${ZB_BASE}${path}`);
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null) url.searchParams.set(k, v);
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const res = await fetch(url.toString(), {
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Zenbooker API ${res.status}: ${body}`);
    }
    return res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One reconciliation tick. Exported so tests can invoke it directly without
 * waiting for setInterval.
 */
async function runReconcileTick({ supabase, logger = console, updateJobStatusFn }) {
  if (!ENABLED()) {
    return { skipped: 'disabled' };
  }

  // Per-tick advisory lock — at most one replica processes per tick.
  let lockRes;
  try {
    lockRes = await supabase.rpc('zb_future_reconcile_try_tick_lock');
  } catch (e) {
    logger.error(`[ZBFutureReconcileCron] tick lock RPC error: ${e.message}`);
    return { error: 'tick_lock_failed' };
  }
  const gotLock = lockRes && lockRes.data === true;
  if (!gotLock) {
    return { skipped: 'not_tick_leader' };
  }

  const released = { done: false };
  const release = async () => {
    if (released.done) return;
    released.done = true;
    try {
      await supabase.rpc('zb_future_reconcile_release_tick_lock');
    } catch (e) {
      logger.warn(`[ZBFutureReconcileCron] tick lock release error: ${e.message}`);
    }
  };

  try {
    const apply = APPLY();
    const lookaheadDays = LOOKAHEAD_DAYS();
    const perJobDelayMs = PER_JOB_DELAY_MS();

    const { data: users, error: usersErr } = await supabase
      .from('users')
      .select('id, zenbooker_api_key')
      .eq('zenbooker_status', 'connected')
      .not('zenbooker_api_key', 'is', null);
    if (usersErr) {
      logger.error(`[ZBFutureReconcileCron] users query failed: ${usersErr.message}`);
      return { error: 'users_query_failed' };
    }

    const tenants = (users || []).filter(u => u.zenbooker_api_key);
    logger.log(
      `[ZBFutureReconcileCron] tick starting — tenants=${tenants.length} apply=${apply} ` +
      `lookahead=${lookaheadDays}d perJobDelayMs=${perJobDelayMs}`
    );

    const tickSummary = {
      tenants: tenants.length,
      tenantsProcessed: 0,
      tenantFailures: 0,
      totals: {
        scanned: 0,
        updated_cancelled: 0,
        would_update_cancelled: 0,
        already_in_sync: 0,
        skipped_hard_terminal: 0,
        skipped_missing_upstream: 0,
        skipped_ineligible: 0,
        skipped_no_zb_id: 0,
        failures: 0,
      },
    };

    for (const tenant of tenants) {
      try {
        const { summary } = await reconcileFutureJobs({
          supabase,
          userId: tenant.id,
          apiKey: tenant.zenbooker_api_key,
          dryRun: !apply,
          lookaheadDays,
          perJobDelayMs,
          logger,
          source: apply ? 'zb_future_reconcile_cron_apply' : 'zb_future_reconcile_cron_dryrun',
          zbFetchFn: zbFetch,
          updateJobStatusFn,
        });
        tickSummary.tenantsProcessed += 1;
        for (const k of Object.keys(tickSummary.totals)) {
          if (typeof summary[k] === 'number') tickSummary.totals[k] += summary[k];
        }
      } catch (e) {
        tickSummary.tenantFailures += 1;
        logger.error(
          `[ZBFutureReconcileCron] tenant userId=${tenant.id} failed: ${e.message || e}`
        );
      }
    }

    logger.log(
      `[ZBFutureReconcileCron] tick complete — ${JSON.stringify(tickSummary)}`
    );

    return tickSummary;
  } finally {
    await release();
  }
}

/**
 * Long-running entry point. Boots a setInterval loop that respects ENABLED()
 * at each tick — so flipping the env flag off live drains naturally without
 * a redeploy. Designed to be required-and-started from server.js boot just
 * like the existing LB / ZB outbound drainers.
 */
function startReconcileCron({ supabase, logger = console, updateJobStatusFn }) {
  if (!ENABLED()) {
    logger.log('[ZBFutureReconcileCron] ZB_FUTURE_RECONCILE_ENABLED is not true — cron not started');
    return { started: false, reason: 'disabled' };
  }
  const intervalMs = INTERVAL_MS();
  logger.log(
    `[ZBFutureReconcileCron] starting — interval=${intervalMs}ms apply=${APPLY()} ` +
    `lookahead=${LOOKAHEAD_DAYS()}d`
  );

  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runReconcileTick({ supabase, logger, updateJobStatusFn });
    } catch (e) {
      logger.error(`[ZBFutureReconcileCron] uncaught tick error: ${e.message || e}`);
    } finally {
      running = false;
    }
  };

  // Schedule the first tick after a short startup delay so we don't pile onto
  // boot-time DB load. Daily cadence after that.
  const startupDelayMs = 60_000;
  const startupTimer = setTimeout(tick, startupDelayMs);
  startupTimer.unref?.();

  const interval = setInterval(tick, intervalMs);
  interval.unref?.();

  return { started: true, intervalMs, stop: () => { clearInterval(interval); clearTimeout(startupTimer); } };
}

module.exports = {
  startReconcileCron,
  runReconcileTick,
  // exported for tests:
  zbFetch,
  ENABLED,
  APPLY,
};
