'use strict';

// HMAC signing for SF → LB provisioning calls.
//
// Used by SF backend when calling LB's:
//   POST /v1/integrations/sf/verify-credentials
//   POST /v1/integrations/sf/provision
//
// Symmetric shared secret. SF signs, LB verifies (or vice-versa for
// any LB → SF provisioning callback, though no such callback is in
// this contract). Distinct from the per-tenant webhook secret used
// for lifecycle event delivery.
//
// Wire contract (matches our existing webhook signing pattern):
//   X-SF-LB-Timestamp: <unix epoch seconds>
//   X-SF-LB-Signature: <hex sha256 HMAC>
//
// Canonical string: `${X-SF-LB-Timestamp}.${raw_body}`
// (binding the timestamp into the signature defeats replay with a
// refreshed timestamp header).
//
// Max acceptable skew (LB's verifier): 300s. SF mints with current time.

const crypto = require('crypto');

const ENV_KEY            = 'SF_LB_PROVISIONING_SHARED_SECRET';
const MAX_CLOCK_SKEW_SEC = 300;

/**
 * Read the shared secret from env. Throws if unset — provisioning
 * MUST be HMAC-protected.
 *
 * @returns {string}
 */
function getSharedSecret() {
  const v = process.env[ENV_KEY];
  if (typeof v !== 'string' || v.length === 0) {
    throw new Error(`${ENV_KEY} is not configured`);
  }
  return v;
}

/**
 * Compute hex sha256 HMAC over `${ts}.${body}`.
 *
 * @param {string} secret
 * @param {string|number} timestampSeconds
 * @param {string} rawBody  — exact JSON string the HTTP client will send
 * @returns {string} hex digest
 */
function signCanonical(secret, timestampSeconds, rawBody) {
  if (typeof secret !== 'string' || !secret) {
    throw new Error('signCanonical: secret required');
  }
  if (typeof rawBody !== 'string') {
    throw new Error('signCanonical: rawBody must be a string');
  }
  const ts = String(timestampSeconds);
  const canonical = `${ts}.${rawBody}`;
  return crypto.createHmac('sha256', secret).update(canonical, 'utf8').digest('hex');
}

/**
 * Build outbound headers for an SF → LB provisioning request.
 *
 * @param {object} args
 * @param {string} args.body              — JSON-serialized request body
 * @param {Date}   args.now               — REQUIRED. Caller-supplied current time. No fallback.
 * @param {string} [args.secret]          — optional explicit secret; defaults to env
 * @returns {{ headers: object, body: string }}
 */
function buildProvisioningHeaders(args) {
  if (!args || typeof args.body !== 'string') {
    throw new Error('buildProvisioningHeaders: body string required');
  }
  if (!(args.now instanceof Date) || Number.isNaN(args.now.getTime())) {
    throw new Error('buildProvisioningHeaders: now (Date) required');
  }
  const secret = args.secret || getSharedSecret();
  const ts = String(Math.floor(args.now.getTime() / 1000));
  const sig = signCanonical(secret, ts, args.body);
  return {
    headers: {
      'Content-Type':         'application/json',
      'X-SF-LB-Timestamp':    ts,
      'X-SF-LB-Signature':    sig,
    },
    body: args.body,
  };
}

/**
 * Verify a presented HMAC + timestamp. Provided for symmetry; SF does not
 * currently receive HMAC-signed requests from LB (the LB → SF surface is
 * the per-tenant webhook with its own per-tenant secret), but exposing
 * this lets us reuse the same primitive if LB later calls SF on the
 * provisioning channel.
 *
 * @param {object} args
 * @param {string} args.body
 * @param {string} args.timestamp        — header value (epoch seconds, ASCII)
 * @param {string} args.signature        — header value (hex)
 * @param {Date}   args.now              — REQUIRED
 * @param {string} [args.secret]
 * @param {number} [args.maxSkewSeconds=300]
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
function verifyProvisioningRequest(args) {
  if (!args || typeof args.body !== 'string') return { ok: false, reason: 'body_missing' };
  if (typeof args.timestamp !== 'string' || args.timestamp.length === 0) {
    return { ok: false, reason: 'timestamp_missing' };
  }
  if (typeof args.signature !== 'string' || args.signature.length === 0) {
    return { ok: false, reason: 'signature_missing' };
  }
  if (!(args.now instanceof Date) || Number.isNaN(args.now.getTime())) {
    return { ok: false, reason: 'now_missing' };
  }

  const tsParsed = Number.parseInt(args.timestamp, 10);
  if (!Number.isFinite(tsParsed) || tsParsed <= 0) {
    return { ok: false, reason: 'timestamp_unparseable' };
  }
  const nowSec   = Math.floor(args.now.getTime() / 1000);
  const maxSkew  = Number.isFinite(args.maxSkewSeconds) ? args.maxSkewSeconds : MAX_CLOCK_SKEW_SEC;
  if (Math.abs(nowSec - tsParsed) > maxSkew) {
    return { ok: false, reason: 'timestamp_skewed' };
  }

  let secret;
  try { secret = args.secret || getSharedSecret(); }
  catch (e) { return { ok: false, reason: 'secret_not_configured' }; }

  const expected = signCanonical(secret, args.timestamp, args.body);
  // Timing-safe compare
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(args.signature, 'hex');
  if (a.length !== b.length) return { ok: false, reason: 'signature_mismatch' };
  if (!crypto.timingSafeEqual(a, b)) return { ok: false, reason: 'signature_mismatch' };
  return { ok: true };
}

module.exports = {
  ENV_KEY,
  MAX_CLOCK_SKEW_SEC,
  getSharedSecret,
  signCanonical,
  buildProvisioningHeaders,
  verifyProvisioningRequest,
};
