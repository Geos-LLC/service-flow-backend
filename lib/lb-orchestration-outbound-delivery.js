'use strict';

// S4 — Outbound webhook signing + retry-schedule primitives.
//
// SF → LB lifecycle events (connection.connected, credential.rotated,
// connection.revoked) are delivered by signing a canonical string that
// binds the timestamp + body together with the per-tenant webhook
// secret using HMAC-SHA256.
//
// Canonical signing string (matches LB's existing /job-status HMAC
// pattern — Option 1 in the LB ↔ SF S4 contract):
//
//   signed_string = `${X-SF-Timestamp}.${raw_body}`
//   X-SF-Signature = hmac_sha256_hex(webhook_secret, signed_string)
//
// Binding the timestamp INTO the signature defeats replay where an
// attacker captures a valid (body, signature) pair and re-uses it
// with a fresh timestamp header. The signature only validates if
// both halves of the canonical string are presented exactly as signed.
//
// IMPORTANT — X-SF-Timestamp format = Unix epoch SECONDS (not ISO 8601).
//   - Header value:   string of integer seconds since epoch (e.g. "1780011918")
//   - Verifier parses with parseInt or Number() to recover the seconds.
//   - Matches LB's existing /job-status HMAC pattern.
//   - Reason: ISO 8601 strings parseInt to the year prefix (e.g. "2026"),
//     which silently breaks the drift window. Epoch seconds removes any
//     ambiguity about how to parse + compare.
//
// Headers (§6.1 of alignment doc + Option 1 contract):
//   X-SF-Signature      hmac_sha256_hex(secret, "${X-SF-Timestamp}.${raw_body}")
//   X-SF-Timestamp      Unix epoch seconds (string, e.g. "1780011918")
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
// LB receiver MUST:
//   1. read X-SF-Timestamp + X-SF-Signature headers
//   2. parse X-SF-Timestamp as integer Unix seconds; reject if
//      |now_sec - ts_sec| > 300 (skew/replay window)
//   3. recompute hmac_sha256_hex(secret, `${X-SF-Timestamp}.${raw_body}`)
//      using the exact string value of the header (NOT the parsed int)
//      and compare to X-SF-Signature (constant-time)
//   4. dedupe by X-SF-Event-Id (idempotent receiver)

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
 * Build the canonical signing string per Option 1:
 *   `${X-SF-Timestamp}.${raw_body}`
 *
 * timestamp is the EXACT string value used in the X-SF-Timestamp header
 * (Unix epoch seconds as a string, e.g. "1780011918"). Verifier MUST
 * use the same string form, not a re-formatted version, or HMAC will
 * not match.
 *
 * Exported for symmetric implementation on LB's verifier.
 */
function buildCanonicalSigningString(timestamp, body) {
  if (typeof timestamp !== 'string' || !timestamp) {
    throw new Error('buildCanonicalSigningString: timestamp (header string value) required');
  }
  if (typeof body !== 'string') {
    throw new Error('buildCanonicalSigningString: body must be a string (raw JSON)');
  }
  return timestamp + '.' + body;
}

/**
 * HMAC-SHA256 hex of `${timestamp}.${body}` using secret. Used for X-SF-Signature.
 *
 * Binds X-SF-Timestamp INTO the signature so an attacker cannot replay
 * a valid (body, signature) pair with a refreshed timestamp.
 */
function signWebhookCanonical(secret, timestamp, body) {
  if (!Buffer.isBuffer(secret) && typeof secret !== 'string') {
    throw new Error('signWebhookCanonical: secret must be Buffer or string');
  }
  const canonical = buildCanonicalSigningString(timestamp, body);
  return crypto.createHmac('sha256', secret).update(canonical, 'utf8').digest('hex');
}

// Backward-compat shim — earlier S4 code path. New callers should use
// signWebhookCanonical. Removed once all in-process callers are
// migrated (see buildOutboundHeaders below — it already uses the new
// canonical path).
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
  // X-SF-Timestamp MUST be regenerated at every dispatch attempt
  // (initial AND retries). Caller is REQUIRED to pass a fresh `now`
  // computed at the dispatch site — we error out otherwise so a stale
  // closure-captured Date can never leak into the signature.
  //
  // Why explicit:
  //   - LB's ±300s timestamp-window check (replay protection) only
  //     accepts a header that's within 5 minutes of receiver's now.
  //   - A retry that reuses a stale timestamp + matching signature is
  //     guaranteed to fail at LB.
  //   - Building this in defensively at the API surface so the drainer
  //     (and any future caller) cannot accidentally regress.
  if (!(args.now instanceof Date) || !Number.isFinite(args.now.getTime())) {
    throw new Error('buildOutboundHeaders: args.now (Date) required — regenerate at dispatch time, every attempt');
  }
  // X-SF-Timestamp format: Unix epoch SECONDS as a string.
  // Matches LB's verifier contract (parseInt-friendly). ISO 8601 strings
  // are NOT used — they parseInt to the year prefix (e.g. 2026) and
  // silently break the drift check.
  const ts = String(Math.floor(args.now.getTime() / 1000));
  // X-SF-Signature = hmac_sha256_hex(secret, `${ts}.${body}`)
  // Timestamp is bound into the signature (Option 1 — matches LB's
  // existing /job-status pattern). The fresh `ts` above ensures the
  // signature is also fresh per attempt.
  const sig = signWebhookCanonical(args.secret, ts, args.body);
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
  buildCanonicalSigningString,
  signWebhookCanonical,
  signWebhookBody,         // legacy export, kept for callers that haven't migrated
  buildOutboundHeaders,
  nextAttemptDelayMs,
  deliverOnce,
};
