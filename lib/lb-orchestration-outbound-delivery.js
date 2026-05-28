'use strict';

// S4 — Outbound webhook signing + retry-schedule primitives.
//
// SF → LB lifecycle events (connection.connected, credential.rotated,
// connection.revoked) are delivered by signing the raw JSON body with
// the per-tenant webhook secret using HMAC-SHA256.
//
// Headers (refinement 4 / §6.1 of alignment doc):
//   X-SF-Signature      hmac_sha256_hex(secret, raw_body)
//   X-SF-Timestamp      ISO 8601 UTC
//   X-SF-Event-Id       deterministic per (event_type, primary_id)
//   X-SF-Event-Type     connection.connected | credential.rotated | connection.revoked
//   X-SF-Tenant-Id      SF user_id (string)
//   X-SF-Kid            current signing kid
//   X-LB-Subscription-Id optional, echoed if set at handshake
//   X-LB-State-Ref       optional, echoed if set at handshake
//
// Retry schedule (refinement 5):
//   base = [1m, 5m, 30m, 2h, 12h, 24h]
//   actual = base * (1 ± 0.15)   (uniform random per attempt)
//
// LB receiver MUST verify:
//   1. signature
//   2. timestamp within ±300s
//   3. X-SF-Event-Id not previously processed (idempotent)

const crypto = require('crypto');
const axios  = require('axios');

const DEFAULT_USER_AGENT       = 'ServiceFlow-Orchestration/1.0';
const DEFAULT_TIMEOUT_MS       = 30_000;
const DEFAULT_MAX_ATTEMPTS     = 7;
const JITTER_FRACTION          = 0.15;

// Minutes per attempt index (0-based: first retry uses BASE_DELAYS_MIN[0]).
// Attempt 0 means "initial attempt", scheduled at next_attempt_at on insert.
// Each failed attempt advances the next_attempt_at by BASE_DELAYS_MIN[attempts-1].
const BASE_DELAYS_MIN = [1, 5, 30, 120, 720, 1440];

/**
 * HMAC-SHA256 hex of body using secret. Used for X-SF-Signature.
 */
function signWebhookBody(secret, body) {
  if (!Buffer.isBuffer(secret) && typeof secret !== 'string') {
    throw new Error('signWebhookBody: secret must be Buffer or string');
  }
  if (typeof body !== 'string') {
    throw new Error('signWebhookBody: body must be a string (raw JSON)');
  }
  return crypto.createHmac('sha256', secret).update(body, 'utf8').digest('hex');
}

/**
 * Build the full header set for one outbound delivery attempt.
 *
 * @param {object} args
 * @param {Buffer|string} args.secret
 * @param {string} args.body            — raw JSON body to sign
 * @param {string} args.eventId
 * @param {string} args.eventType
 * @param {number|string} args.tenantId
 * @param {string} args.kid
 * @param {string} [args.subscriptionId]
 * @param {string} [args.stateRef]
 * @param {Date}   [args.now=new Date()]
 */
function buildOutboundHeaders(args) {
  if (!args || !args.body || !args.eventId || !args.eventType || args.tenantId == null) {
    throw new Error('buildOutboundHeaders: required fields missing');
  }
  const ts = (args.now instanceof Date ? args.now : new Date()).toISOString();
  const sig = signWebhookBody(args.secret, args.body);
  const headers = {
    'Content-Type':    'application/json; charset=utf-8',
    'User-Agent':      DEFAULT_USER_AGENT,
    'X-SF-Signature':  sig,
    'X-SF-Timestamp':  ts,
    'X-SF-Event-Id':   args.eventId,
    'X-SF-Event-Type': args.eventType,
    'X-SF-Tenant-Id':  String(args.tenantId),
    'X-SF-Kid':        args.kid || 'sf_orch_2026_05',
  };
  if (args.subscriptionId) headers['X-LB-Subscription-Id'] = String(args.subscriptionId);
  if (args.stateRef)        headers['X-LB-State-Ref']       = String(args.stateRef);
  return headers;
}

/**
 * Compute delay until next attempt, applying ±JITTER_FRACTION uniform
 * random jitter (refinement 5). `attemptCount` is post-increment of the
 * just-failed attempt (i.e., 1 means "we just had our first failure").
 *
 * Returns ms.
 */
function nextAttemptDelayMs(attemptCount, rng) {
  const random = typeof rng === 'function' ? rng : Math.random;
  const idx = Math.min(Math.max(1, attemptCount) - 1, BASE_DELAYS_MIN.length - 1);
  const baseMs = BASE_DELAYS_MIN[idx] * 60 * 1000;
  const jitter = (random() * 2 - 1) * JITTER_FRACTION;     // uniform in [-JITTER_FRACTION, +JITTER_FRACTION]
  const out = Math.max(1_000, Math.round(baseMs * (1 + jitter)));
  return out;
}

/**
 * Perform a single delivery attempt via axios. Returns:
 *   { ok: true,  status, response_body }
 *   { ok: false, status, response_body, transient }   // transient=true if 5xx/network/timeout
 *
 * Caller decides on retry vs DLQ based on `ok` + attempts.
 */
async function deliverOnce(args) {
  if (!args || !args.url || !args.headers || args.body == null) {
    throw new Error('deliverOnce: url, headers, body required');
  }
  const timeoutMs = Number.isFinite(args.timeoutMs) ? args.timeoutMs : DEFAULT_TIMEOUT_MS;
  try {
    const resp = await axios({
      method:  'POST',
      url:     args.url,
      headers: args.headers,
      data:    args.body,
      timeout: timeoutMs,
      transformRequest: [(d) => d],                       // do NOT re-stringify; we already signed the bytes
      validateStatus: () => true,                         // never throw on non-2xx
      responseType: 'text',
      maxRedirects: 0,
    });
    const ok = resp.status >= 200 && resp.status < 300;
    return {
      ok,
      status:         resp.status,
      response_body:  typeof resp.data === 'string' ? resp.data.slice(0, 2000) : null,
      transient:      !ok && (resp.status >= 500 || resp.status === 408 || resp.status === 429),
    };
  } catch (err) {
    // Network / timeout / DNS — transient.
    return {
      ok:             false,
      status:         null,
      response_body:  null,
      transient:      true,
      error:          err && err.code ? err.code : (err && err.message ? err.message.slice(0, 200) : 'unknown'),
    };
  }
}

module.exports = {
  DEFAULT_USER_AGENT,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_ATTEMPTS,
  JITTER_FRACTION,
  BASE_DELAYS_MIN,
  signWebhookBody,
  buildOutboundHeaders,
  nextAttemptDelayMs,
  deliverOnce,
};
