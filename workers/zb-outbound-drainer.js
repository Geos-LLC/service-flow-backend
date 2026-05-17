'use strict';

/**
 * ZB Outbound Drainer — Phase A scaffolding.
 *
 * Behavior:
 *   - If ZB_OUTBOUND_ENABLED !== 'true' → drainer does NOT start.
 *   - If started but ZB_OUTBOUND_GLOBAL_FREEZE === 'true' → tick acquires
 *     the per-tick advisory lock, runs stale-lease sweep (so any future
 *     crashed worker's rows recover), but claim short-circuits with
 *     `frozen` and the network code path is NEVER reached.
 *   - No Phase B HTTP traffic is possible from this scaffolding.
 *
 * The processRow path is intentionally a stub: it logs and transitions
 * the row back to `pending` with a defer reason. Real outbound execution
 * lands in Phase B alongside ZB support answers (Q2-A for the four
 * remaining command types, Q2-B for event-level dedup).
 *
 * Concurrency primitives are identical to LB outbound:
 *   - zb_outbound_try_tick_lock (per-replica leader election per tick)
 *   - zb_outbound_sweep_stale_leases (recovery from crashed workers)
 *   - zb_outbound_claim_due (FOR UPDATE SKIP LOCKED + lease)
 */

const crypto = require('crypto');
const { ENABLED, DRY_RUN, FROZEN } = require('../lib/zb-outbound-delivery');

const TICK_MS = parseInt(process.env.ZB_OUTBOUND_TICK_MS || '5000', 10);
const BATCH_SIZE = parseInt(process.env.ZB_OUTBOUND_BATCH_SIZE || '50', 10);
const LEASE_S = parseInt(process.env.ZB_OUTBOUND_LEASE_S || '120', 10);

function nowIso() { return new Date().toISOString(); }

function workerId() {
  return `zb-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
}

// Dedup'd frozen log line — emitted once per minute, not every tick.
let lastFrozenLogAt = 0;
function maybeLogFrozen(logger) {
  const now = Date.now();
  if (now - lastFrozenLogAt > 60000) {
    lastFrozenLogAt = now;
    if (logger && logger.log) {
      logger.log('[ZB Outbound] drainer tick skipped — ZB_OUTBOUND_GLOBAL_FREEZE=true');
    }
  }
}

/**
 * One drainer tick. Exported for tests + manual admin invocation.
 *
 * Phase A behavior:
 *   - frozen → acquire lock, sweep, skip claim, release lock
 *   - not frozen → would claim and process, but processRow is a stub
 *     that defers rows back to pending (no HTTP, no ZB mutation)
 */
async function runDrainerTick({ supabase, logger = console }) {
  if (!ENABLED()) return { skipped: 'disabled' };

  // 1. Per-tick advisory lock
  let lockRes;
  try {
    lockRes = await supabase.rpc('zb_outbound_try_tick_lock');
  } catch (e) {
    if (logger.error) logger.error(`[ZB Outbound] Tick lock RPC error: ${e.message}`);
    return { error: 'tick_lock_failed' };
  }
  const gotLock = lockRes && lockRes.data === true;
  if (!gotLock) return { skipped: 'not_tick_leader' };

  const released = { done: false };
  const release = async () => {
    if (released.done) return;
    released.done = true;
    try { await supabase.rpc('zb_outbound_release_tick_lock'); }
    catch (e) { if (logger.warn) logger.warn(`[ZB Outbound] Tick lock release error: ${e.message}`); }
  };

  try {
    // 2. Stale-lease sweep — always runs, even when frozen, so any
    //    crashed worker's rows recover without operator intervention.
    let sweptCount = 0;
    try {
      const sweep = await supabase.rpc('zb_outbound_sweep_stale_leases');
      sweptCount = typeof sweep.data === 'number' ? sweep.data : 0;
      if (sweptCount > 0 && logger.log) {
        logger.log(`[ZB Outbound] Swept ${sweptCount} stale leases`);
      }
    } catch (e) {
      if (logger.warn) logger.warn(`[ZB Outbound] Sweep error: ${e.message}`);
    }

    // 3. Freeze short-circuit — design §17.
    if (FROZEN()) {
      maybeLogFrozen(logger);
      return { skipped: 'frozen', swept: sweptCount };
    }

    // 4. Claim due rows
    const worker = workerId();
    const { data: claimed, error: claimErr } = await supabase.rpc('zb_outbound_claim_due', {
      p_worker: worker,
      p_lease_s: LEASE_S,
      p_limit: BATCH_SIZE,
    });
    if (claimErr) {
      if (logger.error) logger.error(`[ZB Outbound] Claim RPC error: ${claimErr.message}`);
      return { error: 'claim_failed', swept: sweptCount };
    }

    const rows = Array.isArray(claimed) ? claimed : [];
    if (rows.length === 0) return { processed: 0, swept: sweptCount };

    // 5. Phase A — processRow is a deferring stub. No HTTP. No mutation.
    let processed = 0;
    for (const row of rows) {
      try {
        await processRow({ supabase, logger, row });
        processed++;
      } catch (e) {
        if (logger.error) {
          logger.error(`[ZB Outbound] Process row ${row.event_id} unexpected error: ${e.message}`);
        }
      }
    }
    return { processed, swept: sweptCount };
  } finally {
    await release();
  }
}

/**
 * Phase A row processor — DEFERS, does not execute.
 *
 * Returns the claimed row to `pending` with `defer_reason='phase_a_scaffolding'`
 * so it appears in the operator's "idle pending" view but never hits ZB.
 * Phase B replaces this with the real network code path.
 */
async function processRow({ supabase, logger, row }) {
  const attempts = (row.attempts || 0) + 1;
  await supabase
    .from('zb_outbound_commands')
    .update({
      state: 'pending',
      attempts,
      next_attempt_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(), // 1h defer
      defer_reason: 'phase_a_scaffolding',
      claimed_by: null,
      claimed_until: null,
      last_attempt_at: nowIso(),
    })
    .eq('id', row.id);

  if (logger.log) {
    logger.log(`[ZB Outbound] phase_a_defer event=${row.event_id} job=${row.sf_job_id} cmd=${row.command_type} attempts=${attempts}`);
  }
}

/**
 * Start the drainer loop. Returns a handle with stop().
 *
 * Does NOT start when ZB_OUTBOUND_ENABLED is not 'true'.
 */
function startDrainer({ supabase, logger = console }) {
  if (!supabase) throw new Error('startDrainer: supabase required');
  if (!ENABLED()) {
    if (logger.log) logger.log('[ZB Outbound] Drainer not started — ZB_OUTBOUND_ENABLED is false.');
    return { stop: () => {} };
  }

  let stopped = false;
  let timer = null;

  const tick = async () => {
    if (stopped) return;
    try {
      await runDrainerTick({ supabase, logger });
    } catch (e) {
      if (logger.error) logger.error(`[ZB Outbound] Drainer tick error: ${e.message}`);
    } finally {
      if (!stopped) timer = setTimeout(tick, TICK_MS);
    }
  };

  const jitter = Math.floor(Math.random() * 2000);
  timer = setTimeout(tick, jitter);
  if (logger.log) {
    logger.log(`[ZB Outbound] Drainer started (tick=${TICK_MS}ms batch=${BATCH_SIZE} dry_run=${DRY_RUN()} frozen=${FROZEN()})`);
  }

  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (logger.log) logger.log('[ZB Outbound] Drainer stopped');
    },
  };
}

module.exports = {
  startDrainer,
  runDrainerTick,
  processRow,
  TICK_MS,
  BATCH_SIZE,
  LEASE_S,
};
