'use strict';

// Periodic sweeper for orchestration credentials past their rotation
// grace window. Companion to the lazy cleanup performed by
// verifyCredentialToken — this catches rows that never receive another
// auth call after grace expires.
//
// Runs every minute (configurable). No-ops on every tick while there
// are no `rotating` credentials in the table (the common state during
// dark launch). One single SQL UPDATE per tick when there is work:
//
//   UPDATE lb_orchestration_credentials
//      SET status='revoked', revoked_at=now(), revoked_reason='grace_expired'
//    WHERE status='rotating' AND grace_expires_at <= now()
//
// Safe characteristics:
//   - Idempotent: re-running after a flip is a no-op (WHERE status='rotating' won't re-match).
//   - Tenant-agnostic: sweeps all tenants in one statement.
//   - No HTTP, no external calls.
//   - .unref() on the interval so it never blocks process exit.
//   - Failure isolated: a thrown error is logged and the loop continues
//     on the next tick. The lazy cleanup in the auth path is the
//     authoritative safety net.
//
// Boot integration: started from server.js after the existing outbound
// drainers. Does not require SF_ORCH_SIGNING_KEY (it never reads tokens).

const { sweepExpiredRotating } = require('../lib/lb-orchestration-credentials');

const DEFAULT_TICK_MS = 60 * 1000;   // 1 minute

/**
 * Start the periodic sweeper. Returns an object with `stop()` for
 * graceful shutdown / testing.
 *
 * @param {object} args
 * @param {object} args.supabase
 * @param {object} [args.logger]
 * @param {number} [args.tickMs=60000]
 */
function startSweeper(args) {
  if (!args || !args.supabase || typeof args.supabase.from !== 'function') {
    throw new Error('startSweeper: supabase required');
  }
  const supabase = args.supabase;
  const logger   = args.logger || { log() {}, warn() {}, error() {} };
  const tickMs   = Number.isFinite(args.tickMs) ? args.tickMs : DEFAULT_TICK_MS;

  let stopped = false;

  async function tick() {
    if (stopped) return;
    try {
      const res = await sweepExpiredRotating(supabase);
      if (res && res.ok && res.sweptCount > 0) {
        // INFO log only when there's work done — otherwise stay quiet.
        try { logger.log(`[orch-grace-sweeper] swept ${res.sweptCount} rotating → revoked`); } catch (_) {}
      } else if (res && !res.ok) {
        try { logger.warn(`[orch-grace-sweeper] sweep failed: ${res.reason || ''} ${res.dbError || ''}`); } catch (_) {}
      }
    } catch (err) {
      try { logger.error(`[orch-grace-sweeper] tick threw: ${err && err.message}`); } catch (_) {}
    }
  }

  const interval = setInterval(tick, tickMs);
  if (typeof interval.unref === 'function') interval.unref();

  return {
    stop() {
      stopped = true;
      clearInterval(interval);
    },
    _tickForTest: tick,
  };
}

module.exports = {
  startSweeper,
  DEFAULT_TICK_MS,
};
