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
const { emitSent, emitDlq } = require('../lib/zb-outbound-metrics');

const TICK_MS = parseInt(process.env.ZB_OUTBOUND_TICK_MS || '5000', 10);
const BATCH_SIZE = parseInt(process.env.ZB_OUTBOUND_BATCH_SIZE || '50', 10);
const LEASE_S = parseInt(process.env.ZB_OUTBOUND_LEASE_S || '120', 10);
const ZB_BASE = 'https://api.zenbooker.com/v1';
const NETWORK_MAX_ATTEMPTS = 5;
const CONFIRM_DEADLINE_MS = 10 * 60 * 1000; // 10 min per design §2.4

// Retry schedule for network/5xx/429 (seconds). Matches LB outbound + design §3.3.
function networkBackoff(attempt) {
  const schedule = [0, 10, 60, 600, 3600];
  return schedule[Math.min(Math.max(attempt, 1) - 1, schedule.length - 1)];
}

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
 * Phase B row processor — dispatches by command_type.
 *
 * Phase B scope: `job.create` only. All other command types continue
 * to defer (Phase C/D/E will graduate them per design §10).
 *
 * For `job.create`:
 *   - Resolves the tenant ZB API key from users.zenbooker_api_key.
 *   - In DRY_RUN mode: builds + signs the request, logs, marks state='sent'
 *     with zb_response={dry_run:true,payload:<>}, no HTTP. Confirmation
 *     never arrives (no real webhook). This is the days-1-3 soak posture.
 *   - In live mode: POSTs /v1/jobs with Idempotency-Key header. Extracts
 *     the new ZB id from response and stamps zenbooker_id so the inbound
 *     webhook handler's correlation step can match it to this command.
 *
 * Handles 200/201/409/4xx/5xx/network per design §3.3.
 */
async function processRow({ supabase, logger, row }) {
  if (row.command_type === 'job.create') {
    return processJobCreate({ supabase, logger, row });
  }
  return processNotInPhaseBScope({ supabase, logger, row });
}

async function processJobCreate({ supabase, logger, row }) {
  const attempts = (row.attempts || 0) + 1;

  // 1. Resolve tenant ZB API key
  const { data: user } = await supabase
    .from('users')
    .select('zenbooker_api_key, zenbooker_status')
    .eq('id', row.user_id)
    .maybeSingle();
  if (!user || user.zenbooker_status !== 'connected' || !user.zenbooker_api_key) {
    return deferRow(supabase, row.id, attempts, 'zb_disconnected', 60 * 60 * 1000, logger,
      `tenant ${row.user_id} is not connected to ZB or has no API key`);
  }

  // 2. Dry-run short-circuit — Phase B days 1-3 default posture
  if (DRY_RUN()) {
    const dryBody = { dry_run: true, would_post_to: '/v1/jobs', payload: row.payload_json };
    await markSent(supabase, row.id, attempts, dryBody, null);
    emitSent({
      userId: row.user_id, commandType: row.command_type, fieldGroup: row.field_group,
      eventId: row.event_id, note: 'dry_run', logger,
    });
    if (logger.log) {
      logger.log(`[ZB Outbound] dry_run sent event=${row.event_id} job=${row.sf_job_id} attempts=${attempts}`);
    }
    return;
  }

  // 3. Real POST to ZB
  const result = await postToZb({
    apiKey: user.zenbooker_api_key,
    path: '/jobs',
    body: row.payload_json,
    idempotencyKey: row.event_id,
  });

  await handlePostResult({ supabase, logger, row, result, attempts });
}

async function postToZb({ apiKey, path, body, idempotencyKey }) {
  const url = `${ZB_BASE}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        // Sent as defense-in-depth per design §3.6.1. Q1 not confirmed
        // by ZB as honored, but the header costs ~36 bytes and provides
        // free dedup if/when ZB supports it.
        'Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    let parsed;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { _raw: text.slice(0, 500) }; }
    return {
      ok: res.ok,
      status: res.status,
      body: parsed,
      response_time_ms: res.headers && res.headers.get && parseInt(res.headers.get('x-response-time') || '0', 10) || null,
    };
  } catch (err) {
    return { ok: false, status: 0, network_error: (err && (err.code || err.message)) || String(err) };
  } finally {
    clearTimeout(timer);
  }
}

async function handlePostResult({ supabase, logger, row, result, attempts }) {
  // Extract the new ZB resource id for correlation later. ZB's create response
  // (per 2026-05-16 discovery) varies in shape — try common locations.
  function extractZbId(body) {
    if (!body || typeof body !== 'object') return null;
    if (body.id) return String(body.id);
    if (body.response && body.response.job) return String(body.response.job);
    if (body.job && body.job.id) return String(body.job.id);
    return null;
  }

  // 200 / 201 → success
  if (result.ok && (result.status === 200 || result.status === 201)) {
    const zenbookerId = extractZbId(result.body);
    await markSent(supabase, row.id, attempts, result.body, zenbookerId);
    emitSent({
      userId: row.user_id, commandType: row.command_type, fieldGroup: row.field_group,
      eventId: row.event_id, logger,
    });
    if (logger.log) {
      logger.log(`[ZB Outbound] sent event=${row.event_id} job=${row.sf_job_id} zb_id=${zenbookerId || 'unknown'} attempts=${attempts}`);
    }
    return;
  }

  // 409 → ZB saw this idempotency key before; treat as sent (duplicate)
  if (result.status === 409) {
    const zenbookerId = extractZbId(result.body);
    await markSent(supabase, row.id, attempts, result.body, zenbookerId);
    emitSent({
      userId: row.user_id, commandType: row.command_type, fieldGroup: row.field_group,
      eventId: row.event_id, note: 'duplicate', logger,
    });
    return;
  }

  // Hard 4xx → DLQ
  if (result.status === 400 || result.status === 401 || result.status === 404 || result.status === 422) {
    const errMsg = `http ${result.status}: ${shortBody(result.body)}`;
    await markFailed(supabase, row.id, attempts, result, errMsg);
    emitDlq({
      userId: row.user_id, commandType: row.command_type, fieldGroup: row.field_group,
      eventId: row.event_id, errorClass: `http_${result.status}`, logger,
    });
    if (logger.warn) logger.warn(`[ZB Outbound] dlq event=${row.event_id} job=${row.sf_job_id} ${errMsg}`);
    return;
  }

  // 429 / 5xx / network → retry per backoff schedule
  const errMsg = result.network_error
    ? `network: ${result.network_error}`
    : `http ${result.status}: ${shortBody(result.body)}`;
  await retryOrDlq(supabase, row, attempts, errMsg, result, logger);
}

async function retryOrDlq(supabase, row, attempts, errMsg, result, logger) {
  if (attempts > NETWORK_MAX_ATTEMPTS) {
    await markFailed(supabase, row.id, attempts, result, errMsg);
    emitDlq({
      userId: row.user_id, commandType: row.command_type, fieldGroup: row.field_group,
      eventId: row.event_id, errorClass: 'max_attempts_exceeded', logger,
    });
    if (logger.warn) logger.warn(`[ZB Outbound] dlq event=${row.event_id} job=${row.sf_job_id} ${errMsg}`);
    return;
  }
  const wait = networkBackoff(attempts);
  await supabase.from('zb_outbound_commands').update({
    state: 'pending',
    attempts,
    next_attempt_at: new Date(Date.now() + wait * 1000).toISOString(),
    last_error: errMsg,
    last_attempt_at: nowIso(),
    claimed_by: null,
    claimed_until: null,
  }).eq('id', row.id);
  if (logger.log) {
    logger.log(`[ZB Outbound] retry event=${row.event_id} job=${row.sf_job_id} in=${wait}s attempt=${attempts} ${errMsg}`);
  }
}

async function markSent(supabase, id, attempts, responseBody, zenbookerId) {
  const update = {
    state: 'sent',
    attempts,
    sent_at: nowIso(),
    last_attempt_at: nowIso(),
    confirmation_deadline: new Date(Date.now() + CONFIRM_DEADLINE_MS).toISOString(),
    zb_response: responseBody,
    last_error: null,
    defer_reason: null,
    claimed_by: null,
    claimed_until: null,
  };
  if (zenbookerId) update.zenbooker_id = zenbookerId;
  await supabase.from('zb_outbound_commands').update(update).eq('id', id);
}

async function markFailed(supabase, id, attempts, result, errMsg) {
  await supabase.from('zb_outbound_commands').update({
    state: 'failed',
    attempts,
    last_error: errMsg,
    last_attempt_at: nowIso(),
    terminal_at: nowIso(),
    zb_response: (result && result.body) || null,
    claimed_by: null,
    claimed_until: null,
  }).eq('id', id);
}

async function deferRow(supabase, id, attempts, defer_reason, defer_ms, logger, note) {
  await supabase.from('zb_outbound_commands').update({
    state: 'pending',
    attempts,
    next_attempt_at: new Date(Date.now() + defer_ms).toISOString(),
    defer_reason,
    claimed_by: null,
    claimed_until: null,
    last_attempt_at: nowIso(),
  }).eq('id', id);
  if (logger && logger.log) {
    logger.log(`[ZB Outbound] defer event=<row> reason=${defer_reason} ${note || ''}`);
  }
}

async function processNotInPhaseBScope({ supabase, logger, row }) {
  const attempts = (row.attempts || 0) + 1;
  await supabase.from('zb_outbound_commands').update({
    state: 'pending',
    attempts,
    next_attempt_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    defer_reason: 'not_in_phase_b_scope',
    claimed_by: null,
    claimed_until: null,
    last_attempt_at: nowIso(),
  }).eq('id', row.id);
  if (logger.log) {
    logger.log(`[ZB Outbound] phase_b_skip event=${row.event_id} job=${row.sf_job_id} cmd=${row.command_type} (Phase B is job.create only)`);
  }
}

function shortBody(body) {
  if (body == null) return '';
  if (typeof body === 'string') return body.slice(0, 300);
  try { return JSON.stringify(body).slice(0, 300); } catch { return '<unserializable>'; }
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
  // exported for tests
  processJobCreate,
  postToZb,
  handlePostResult,
  retryOrDlq,
  networkBackoff,
  markSent,
  markFailed,
  shortBody,
  TICK_MS,
  BATCH_SIZE,
  LEASE_S,
  NETWORK_MAX_ATTEMPTS,
  CONFIRM_DEADLINE_MS,
  ZB_BASE,
};
