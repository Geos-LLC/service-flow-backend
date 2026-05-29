'use strict';

// S4 — Orchestration webhook outbox drainer.
//
// Reads pending rows from lb_orchestration_outbox and delivers them to
// the per-tenant webhook URL with HMAC-SHA256 signing using the
// snapshotted webhook secret on the row.
//
// Distinct from workers/leadbridge-outbound-drainer.js (which handles
// the existing job.status_changed + service_* events signed with the
// LB outbound subscription secret).
//
// Tick: default 5 seconds. .unref()'d so it never blocks process exit.
// On every tick, claims at most BATCH rows whose next_attempt_at <= now()
// and state='pending'. For each:
//   - decrypt webhook_secret_enc via lb-encryption
//   - sign the payload_json body with HMAC-SHA256
//   - POST to webhook_url with the SF headers
//   - on 2xx: state='sent', sent_at=now()
//   - on non-2xx / network: attempts++, next_attempt_at = now + jittered delay,
//     last_status_code + last_error captured. After max attempts: state='dlq'.
//
// Hard rules:
//   - never logs plaintext body or secret
//   - logs event_id, event_type, attempts, status_code, last_error tail
//   - bounded batch size; each tick caps work so the loop can't starve

const {
  buildOutboundHeaders,
  nextAttemptDelayMs,
  deliverOnce,
  DEFAULT_MAX_ATTEMPTS,
} = require('../lib/lb-orchestration-outbound-delivery');
const { decryptIntegrationSecret } = require('../services/lb-encryption');
const { getCurrentKid } = require('../lib/lb-orchestration-credentials');

const OUTBOX_TABLE       = 'lb_orchestration_outbox';
const DEFAULT_TICK_MS    = 5_000;
const DEFAULT_BATCH_SIZE = 10;

/**
 * Start the drainer. Returns { stop, _tickForTest }.
 *
 * @param {object} args
 * @param {object} args.supabase
 * @param {object} [args.logger]
 * @param {number} [args.tickMs=5000]
 * @param {number} [args.batchSize=10]
 * @param {number} [args.maxAttempts=DEFAULT_MAX_ATTEMPTS]
 * @param {function} [args.rng]
 * @param {function} [args.deliver=deliverOnce]   — injectable for tests
 */
function startDrainer(args) {
  if (!args || !args.supabase || typeof args.supabase.from !== 'function') {
    throw new Error('startDrainer: supabase required');
  }
  const supabase    = args.supabase;
  const logger      = args.logger || { log() {}, warn() {}, error() {} };
  const tickMs      = Number.isFinite(args.tickMs) ? args.tickMs : DEFAULT_TICK_MS;
  const batchSize   = Number.isFinite(args.batchSize) ? args.batchSize : DEFAULT_BATCH_SIZE;
  const maxAttempts = Number.isFinite(args.maxAttempts) ? args.maxAttempts : DEFAULT_MAX_ATTEMPTS;
  const rng         = typeof args.rng === 'function' ? args.rng : Math.random;
  const deliver     = typeof args.deliver === 'function' ? args.deliver : deliverOnce;

  let stopped = false;

  async function tick() {
    if (stopped) return { swept: 0 };
    try {
      return await drainOnce(supabase, { logger, batchSize, maxAttempts, rng, deliver });
    } catch (err) {
      try { logger.error(`[orch-webhook-drainer] tick threw: ${err && err.message}`); } catch (_) {}
      return { swept: 0, error: String(err && err.message || err) };
    }
  }

  const interval = setInterval(tick, tickMs);
  if (typeof interval.unref === 'function') interval.unref();

  return {
    stop() { stopped = true; clearInterval(interval); },
    _tickForTest: tick,
  };
}

/**
 * Single drain pass — claims + delivers up to batchSize rows.
 */
async function drainOnce(supabase, opts) {
  const { logger, batchSize, maxAttempts, rng, deliver } = opts;
  const nowIso = new Date().toISOString();

  // Claim: select pending rows due now. No advisory lock (orchestration
  // outbox volume is too low to need it during S4 / canary). Each row
  // is independently updated; concurrent drainers would re-attempt the
  // same row, but since each delivery either succeeds (terminal) or
  // schedules another retry, duplicate POSTs are bounded by LB's
  // X-SF-Event-Id idempotency on the receiver.
  const { data: rows, error: claimErr } = await supabase
    .from(OUTBOX_TABLE)
    .select('id,user_id,event_id,event_type,payload_json,webhook_url,webhook_secret_enc,subscription_id,state_ref,attempts')
    .eq('state', 'pending')
    .lte('next_attempt_at', nowIso)
    .order('next_attempt_at', { ascending: true })
    .limit(batchSize);

  if (claimErr) {
    try { logger.warn(`[orch-webhook-drainer] claim failed: ${claimErr.message}`); } catch (_) {}
    return { swept: 0, error: claimErr.message };
  }
  if (!Array.isArray(rows) || rows.length === 0) {
    return { swept: 0 };
  }

  let succeeded = 0;
  let failed    = 0;
  let dlqd      = 0;

  for (const row of rows) {
    let secret;
    try {
      secret = decryptIntegrationSecret(row.webhook_secret_enc);
    } catch (err) {
      // Cannot decrypt → mark failed permanently (operator must investigate).
      await markPermanentFailure(supabase, row, 'decrypt_failed:' + (err && err.message || 'unknown'), 'failed');
      try { logger.error(`[orch-webhook-drainer] decrypt failed id=${row.id} event=${row.event_id}`); } catch (_) {}
      failed++;
      continue;
    }

    const body = JSON.stringify(row.payload_json);
    // CRITICAL: dispatchNow is generated HERE, immediately before signing
    // and delivery. Regenerated on every retry (each tick that picks up
    // this row gets a fresh Date). This is what makes X-SF-Timestamp
    // pass LB's ±300s window check on every attempt.
    const dispatchNow = new Date();
    const headers = buildOutboundHeaders({
      secret,
      body,
      eventId:        row.event_id,
      eventType:      row.event_type,
      tenantId:       row.user_id,
      kid:            getCurrentKid(),
      subscriptionId: row.subscription_id || undefined,
      stateRef:       row.state_ref || undefined,
      now:            dispatchNow,            // ← regenerated per attempt
    });

    // Wire-level diagnostic: log the EXACT value of X-SF-Timestamp + first 16 chars
    // of X-SF-Signature that we're about to put on the wire. Process-time also
    // captured so we can compare against LB's receive time to bound network +
    // proxy delay. Body bytes captured to verify the same body is signed and
    // sent.
    try {
      logger.log(`[orch-webhook-drainer] DISPATCH id=${row.id} event=${row.event_id} attempt=${(row.attempts || 0) + 1} wire_ts=${headers['X-SF-Timestamp']} sig_head=${headers['X-SF-Signature'].slice(0, 16)} body_bytes=${Buffer.byteLength(body, 'utf8')} process_now=${new Date().toISOString()}`);
    } catch (_) {}

    const delivery = await deliver({
      url:      row.webhook_url,
      headers,
      body,
    });

    // Post-delivery: log the response status + time. Together with the DISPATCH
    // line above, this gives us the exact wire-clock-time pair (SF-side ts vs
    // LB-side response time) so we can prove drift came from us vs network.
    try {
      logger.log(`[orch-webhook-drainer] RESPONSE id=${row.id} event=${row.event_id} attempt=${(row.attempts || 0) + 1} resp_status=${delivery.status || 'network_error'} resp_received_at=${new Date().toISOString()}`);
    } catch (_) {}

    if (delivery.ok) {
      const { error: updErr } = await supabase
        .from(OUTBOX_TABLE)
        .update({
          state:            'sent',
          sent_at:          new Date().toISOString(),
          last_status_code: delivery.status,
          last_error:       null,
        })
        .eq('id', row.id);
      if (updErr) {
        try { logger.warn(`[orch-webhook-drainer] sent-update failed id=${row.id}: ${updErr.message}`); } catch (_) {}
      } else {
        try { logger.log(`[orch-webhook-drainer] delivered id=${row.id} event=${row.event_id} ts=${dispatchNow.toISOString()} attempt=${(row.attempts || 0) + 1} status=${delivery.status}`); } catch (_) {}
      }
      succeeded++;
      continue;
    }

    // Failed.
    const newAttempts = (row.attempts || 0) + 1;
    if (newAttempts >= maxAttempts) {
      await markPermanentFailure(supabase, row, summarizeError(delivery), 'dlq');
      try { logger.warn(`[orch-webhook-drainer] dlq id=${row.id} event=${row.event_id} ts=${dispatchNow.toISOString()} attempts=${newAttempts}`); } catch (_) {}
      dlqd++;
      continue;
    }
    const delayMs = nextAttemptDelayMs(newAttempts, rng);
    const nextAt  = new Date(Date.now() + delayMs).toISOString();
    const { error: retryErr } = await supabase
      .from(OUTBOX_TABLE)
      .update({
        attempts:         newAttempts,
        next_attempt_at:  nextAt,
        last_status_code: delivery.status || null,
        last_error:       summarizeError(delivery),
      })
      .eq('id', row.id);
    if (retryErr) {
      try { logger.warn(`[orch-webhook-drainer] retry-update failed id=${row.id}: ${retryErr.message}`); } catch (_) {}
    } else {
      // Surface ts + attempt # so Loki can prove retries get fresh timestamps.
      try { logger.log(`[orch-webhook-drainer] retry-scheduled id=${row.id} event=${row.event_id} ts=${dispatchNow.toISOString()} attempt=${newAttempts} delay_ms=${delayMs} status=${delivery.status || 'network'}`); } catch (_) {}
    }
    failed++;
  }

  return { swept: rows.length, succeeded, failed, dlqd };
}

async function markPermanentFailure(supabase, row, errorSummary, state) {
  await supabase
    .from(OUTBOX_TABLE)
    .update({
      state,
      failed_at:        new Date().toISOString(),
      last_error:       errorSummary,
    })
    .eq('id', row.id);
}

function summarizeError(delivery) {
  if (!delivery) return 'unknown';
  if (delivery.error) return `network:${delivery.error}`;
  if (delivery.status != null) {
    const body = delivery.response_body ? ` body:${String(delivery.response_body).slice(0, 200)}` : '';
    return `http_${delivery.status}${body}`;
  }
  return 'unknown';
}

module.exports = {
  startDrainer,
  drainOnce,
  OUTBOX_TABLE,
  DEFAULT_TICK_MS,
};
