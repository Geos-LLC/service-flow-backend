'use strict';

/**
 * P1.6 (Synchronization Constitution §0 P2 + §9 P1.6) — unified delivery log.
 *
 * Single entrypoint for cross-system delivery audit. Every call:
 *   - emits one [DeliveryLog] Loki anchor with structured fields
 *   - inserts one row into the delivery_log table (migration 042)
 *   - never throws back to the caller (observability MUST NOT break a send)
 *
 * Coexistence with existing audit tables: this helper does NOT replace
 * notification_email_logs, leadbridge_outbound_events, zb_sync_dirty,
 * ledger_drift_detected, or payment_reconcile_*. Those remain canonical
 * for their own per-domain queries. The new delivery_log is the unified
 * read surface; per-domain writers dual-write here.
 *
 * Migration path (long-term):
 *   1. delivery_log lands + writers dual-write (this PR — P1.6)
 *   2. Operator UIs migrate to read delivery_log
 *   3. Per-domain readers ported to delivery_log queries
 *   4. Per-domain writer-only tables can drop their reader API (still
 *      written for canonical state; deletes deferred to a future PR)
 *   5. notification_email_logs may eventually become a generated view
 *      over delivery_log WHERE channel = 'email'
 */

const crypto = require('crypto');

// Allowed enum values — strict, additive only. Adding a new system/channel/
// status requires a constitution amendment and a contract-test update.
const VALID_SYSTEMS = Object.freeze([
  'service_flow', 'leadbridge', 'sigcore', 'zenbooker',
  'sendgrid', 'stripe', 'whatsapp', 'twilio', 'openphone',
]);
const VALID_CHANNELS = Object.freeze([
  'email', 'webhook', 'sms', 'whatsapp', 'voice', 'api_rpc',
]);
const VALID_DIRECTIONS = Object.freeze(['outbound', 'inbound']);
const VALID_STATUSES = Object.freeze([
  'queued', 'sent', 'delivered', 'failed', 'rejected',
  'rate_limited', 'duplicate', 'timeout',
]);

const TERMINAL_STATUSES = new Set([
  'sent', 'delivered', 'failed', 'rejected', 'rate_limited', 'duplicate', 'timeout',
]);

const VALID_SYSTEMS_SET = new Set(VALID_SYSTEMS);
const VALID_CHANNELS_SET = new Set(VALID_CHANNELS);
const VALID_DIRECTIONS_SET = new Set(VALID_DIRECTIONS);
const VALID_STATUSES_SET = new Set(VALID_STATUSES);

function classifyErrorClass(err) {
  if (!err) return null;
  if (typeof err === 'string') return 'Error';
  if (err.code) return String(err.code);
  if (err.name && err.name !== 'Error') return err.name;
  return 'Error';
}

function computePayloadHash(payload) {
  if (payload == null) return null;
  try {
    const canonical = typeof payload === 'string' ? payload : JSON.stringify(payload);
    return crypto.createHash('sha256').update(canonical).digest('hex');
  } catch {
    return null;
  }
}

function truncate(s, n = 1000) {
  if (s == null) return null;
  const str = String(s);
  return str.length > n ? str.slice(0, n) : str;
}

/**
 * Write one delivery_log row + emit the structured Loki anchor.
 * NEVER throws. Failure to log is itself logged (one level up).
 *
 * @param {Object} supabase
 * @param {Object} args
 *   userId             nullable — tenant scope
 *   sourceSystem       REQUIRED — one of VALID_SYSTEMS
 *   destinationSystem  REQUIRED — one of VALID_SYSTEMS
 *   channel            one of VALID_CHANNELS (or null when not channel-shaped)
 *   eventType          REQUIRED — short stable string (e.g. 'email.invoice')
 *   correlationId      cross-system tracking id; null when none
 *   requestId          HTTP request id; null when none
 *   payloadHash        precomputed hash; or pass `payload` to have us hash
 *   payload            arbitrary value; hashed if payloadHash is absent
 *   deliveryDirection  REQUIRED — 'outbound' | 'inbound'
 *   status             REQUIRED — one of VALID_STATUSES
 *   responseCode       HTTP/provider numeric code, or null
 *   latencyMs          measured latency for the operation
 *   retryCount         current retry attempt; 0 for first try
 *   provider           short provider name, optional
 *   providerMessageId  provider-side id (sendgrid msg id, etc.)
 *   error              Error object — we extract message + class
 *   errorMessage       overrides error.message when both present
 *   errorClass         overrides error.code/name
 *   context            JSONB-safe object with arbitrary debug
 *   resolvedAt         override resolved_at; defaults to NOW() for terminal statuses
 *   logger             defaults to console
 * @returns {Promise<{ ok: boolean, id?: number, error?: string }>}
 */
async function logDelivery(supabase, args, loggerArg) {
  const logger = loggerArg || (args && args.logger) || console;
  const a = args || {};

  // ─── Validate enums (loud, not crashing) ─────────────────────────
  const errors = [];
  if (!a.sourceSystem || !VALID_SYSTEMS_SET.has(a.sourceSystem)) {
    errors.push(`sourceSystem=${JSON.stringify(a.sourceSystem)} not in [${VALID_SYSTEMS.join(',')}]`);
  }
  if (!a.destinationSystem || !VALID_SYSTEMS_SET.has(a.destinationSystem)) {
    errors.push(`destinationSystem=${JSON.stringify(a.destinationSystem)} not in [${VALID_SYSTEMS.join(',')}]`);
  }
  if (a.channel != null && !VALID_CHANNELS_SET.has(a.channel)) {
    errors.push(`channel=${JSON.stringify(a.channel)} not in [${VALID_CHANNELS.join(',')}]`);
  }
  if (!a.eventType) errors.push('eventType is required');
  if (!a.deliveryDirection || !VALID_DIRECTIONS_SET.has(a.deliveryDirection)) {
    errors.push(`deliveryDirection=${JSON.stringify(a.deliveryDirection)} not in [outbound,inbound]`);
  }
  if (!a.status || !VALID_STATUSES_SET.has(a.status)) {
    errors.push(`status=${JSON.stringify(a.status)} not in [${VALID_STATUSES.join(',')}]`);
  }

  if (errors.length > 0) {
    const msg = errors.join('; ');
    if (logger && typeof logger.error === 'function') {
      logger.error(`[DeliveryLog] invalid args — ${msg}`);
    }
    return { ok: false, error: msg };
  }

  // ─── Derive payload hash, error fields, resolved_at ──────────────
  const payloadHash = a.payloadHash !== undefined
    ? a.payloadHash
    : (a.payload !== undefined ? computePayloadHash(a.payload) : null);

  const errorMessage = a.errorMessage != null
    ? truncate(a.errorMessage)
    : (a.error ? truncate(a.error.message || String(a.error)) : null);
  const errorClass = a.errorClass != null
    ? truncate(a.errorClass, 100)
    : (a.error ? classifyErrorClass(a.error) : null);

  let resolvedAt = a.resolvedAt;
  if (resolvedAt === undefined && TERMINAL_STATUSES.has(a.status)) {
    resolvedAt = new Date().toISOString();
  }

  // ─── Structured Loki anchor — emit BEFORE the DB write so we never
  //     lose the signal even if DB is unreachable. ──────────────────
  const obs = [
    `[DeliveryLog]`,
    `user_id=${a.userId == null ? 'null' : a.userId}`,
    `source=${a.sourceSystem}`,
    `dest=${a.destinationSystem}`,
    `dir=${a.deliveryDirection}`,
    a.channel ? `channel=${a.channel}` : null,
    `event=${a.eventType}`,
    `status=${a.status}`,
    a.responseCode != null ? `code=${a.responseCode}` : null,
    a.correlationId ? `corr=${a.correlationId}` : null,
    a.latencyMs != null ? `latency_ms=${a.latencyMs}` : null,
    a.retryCount ? `retry=${a.retryCount}` : null,
    errorClass ? `error_class=${errorClass}` : null,
  ].filter(Boolean).join(' ');

  if (a.status === 'failed' || a.status === 'rejected' || a.status === 'timeout' || a.status === 'rate_limited') {
    if (logger.warn) logger.warn(obs);
    else if (logger.log) logger.log(obs);
  } else {
    if (logger.log) logger.log(obs);
    else if (typeof logger === 'function') logger(obs);
  }

  // ─── Write to delivery_log table ────────────────────────────────
  try {
    const row = {
      user_id: a.userId != null ? a.userId : null,
      source_system: a.sourceSystem,
      destination_system: a.destinationSystem,
      channel: a.channel || null,
      event_type: a.eventType,
      correlation_id: a.correlationId || null,
      request_id: a.requestId || null,
      payload_hash: payloadHash,
      delivery_direction: a.deliveryDirection,
      status: a.status,
      response_code: a.responseCode != null ? a.responseCode : null,
      latency_ms: a.latencyMs != null ? a.latencyMs : null,
      retry_count: a.retryCount != null ? a.retryCount : 0,
      provider: a.provider || null,
      provider_message_id: a.providerMessageId || null,
      error_message: errorMessage,
      error_class: errorClass,
      resolved_at: resolvedAt || null,
      context: a.context || null,
    };

    const { data, error } = await supabase
      .from('delivery_log')
      .insert(row)
      .select('id')
      .single();

    if (error) {
      if (logger.error) logger.error(`[DeliveryLog] insert failed: ${error.message}`);
      return { ok: false, error: error.message };
    }
    return { ok: true, id: data?.id };
  } catch (e) {
    // Last-resort guard — observability MUST NEVER break a send path.
    if (logger.error) logger.error(`[DeliveryLog] crashed: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

module.exports = {
  logDelivery,
  VALID_SYSTEMS,
  VALID_CHANNELS,
  VALID_DIRECTIONS,
  VALID_STATUSES,
  TERMINAL_STATUSES,
  classifyErrorClass,
  computePayloadHash,
};
