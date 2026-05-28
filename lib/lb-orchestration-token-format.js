'use strict';

// SF orchestration token codec (PR-C3 / S1).
//
// Token format:
//   sfo_v1.<base64url(payload_json)>.<base64url(hmac_sha256(KEY, "sf-orchestration:" + payload_json_string))>
//
// Payload claims (canonical JSON):
//   {
//     "v":         1,
//     "kid":       "sf_orch_2026_05",   // key id, used to look up the HMAC key
//     "scope":     "lb_orchestration",
//     "tenant_id": 2,
//     "iat":       1748345200,           // seconds since epoch
//     "exp":       1756121200,           // seconds since epoch
//     "iss":       "service_flow",
//     "nonce":     "<8 hex bytes>"       // ensures distinct tokens per tenant
//   }
//
// Verification primitives only — no DB access, no environment lookups
// beyond the explicit signing-key resolver. Module import has zero side
// effects. The DB-bound credential lifecycle lives in
// `lib/lb-orchestration-credentials.js`.
//
// Domain separation: the HMAC includes a constant prefix
// "sf-orchestration:" so that a leak of one signing key cannot produce
// valid tokens for any other purpose (slot tokens, JWTs, etc.).
//
// Token prefix `sfo_v1` is distinct from `slot_v1` so that the two
// kinds of tokens can never be confused at the auth dispatcher.

const crypto = require('crypto');

const TOKEN_PREFIX        = 'sfo_v1';
const DOMAIN_SEPARATOR    = 'sf-orchestration:';
const TOKEN_SCOPE         = 'lb_orchestration';
const TOKEN_ISSUER        = 'service_flow';
const TOKEN_PREFIX_LENGTH = 13;                 // chars to surface as token_prefix
const DEFAULT_TOKEN_EXPIRY_MS = 90 * 24 * 60 * 60 * 1000;   // 90 days
const CLOCK_SKEW_MS       = 60 * 1000;          // ±60s tolerance on exp

function b64url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s) {
  let str = String(s).replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return Buffer.from(str, 'base64');
}

/**
 * Encode + sign a token. Caller-supplied signing key (so callers manage
 * which kid maps to which key via lb-orchestration-credentials.js).
 *
 * @param {object} args
 * @param {number} args.tenantId
 * @param {string} args.kid
 * @param {number} args.expiresInMs
 * @param {Buffer} args.signingKey     — 32-byte HMAC key
 * @returns {{ token: string, tokenPrefix: string, payload: object, issuedAtMs: number, expiresAtMs: number }}
 */
function encodeToken(args) {
  if (!args || typeof args !== 'object') throw new Error('encodeToken: args required');
  if (args.tenantId == null)             throw new Error('encodeToken: tenantId required');
  if (!args.kid)                         throw new Error('encodeToken: kid required');
  if (!Buffer.isBuffer(args.signingKey)) throw new Error('encodeToken: signingKey must be a Buffer');
  if (args.signingKey.length < 32)       throw new Error('encodeToken: signingKey must be at least 32 bytes');

  const expiresInMs = Number(args.expiresInMs || DEFAULT_TOKEN_EXPIRY_MS);
  if (!Number.isFinite(expiresInMs) || expiresInMs <= 0) {
    throw new Error('encodeToken: expiresInMs must be > 0');
  }

  const nowMs  = Date.now();
  const iatSec = Math.floor(nowMs / 1000);
  const expSec = Math.floor((nowMs + expiresInMs) / 1000);

  const payload = {
    v:         1,
    kid:       String(args.kid),
    scope:     TOKEN_SCOPE,
    tenant_id: Number(args.tenantId),
    iat:       iatSec,
    exp:       expSec,
    iss:       TOKEN_ISSUER,
    nonce:     crypto.randomBytes(8).toString('hex'),
  };

  const payloadStr = JSON.stringify(payload);
  const payloadB64 = b64url(payloadStr);
  const mac = crypto.createHmac('sha256', args.signingKey)
    .update(DOMAIN_SEPARATOR + TOKEN_PREFIX + '.' + payloadB64)
    .digest();
  const token = TOKEN_PREFIX + '.' + payloadB64 + '.' + b64url(mac);

  return {
    token,
    tokenPrefix: token.slice(0, TOKEN_PREFIX_LENGTH),
    payload,
    issuedAtMs:  nowMs,
    expiresAtMs: nowMs + expiresInMs,
  };
}

/**
 * Parse a token into its components without verifying the signature.
 * Returns { ok, prefix, payloadB64, sigB64, payload, reason }.
 */
function parseToken(token) {
  if (typeof token !== 'string' || token.length === 0) {
    return { ok: false, reason: 'malformed' };
  }
  if (!token.startsWith(TOKEN_PREFIX + '.')) {
    return { ok: false, reason: 'malformed' };
  }
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed' };
  const [prefix, payloadB64, sigB64] = parts;
  if (prefix !== TOKEN_PREFIX || !payloadB64 || !sigB64) {
    return { ok: false, reason: 'malformed' };
  }

  let payload;
  try {
    payload = JSON.parse(b64urlDecode(payloadB64).toString('utf8'));
  } catch (_) {
    return { ok: false, reason: 'malformed_payload' };
  }
  if (!payload || typeof payload !== 'object') {
    return { ok: false, reason: 'malformed_payload' };
  }

  return { ok: true, prefix, payloadB64, sigB64, payload };
}

/**
 * Verify the HMAC signature and structural claims of a token. Does NOT
 * consult the database. Returns one of:
 *
 *   { valid: true,  payload }
 *   { valid: false, reason: 'malformed' | 'malformed_payload' | 'unsupported_version' |
 *                          'scope_mismatch' | 'bad_signature' | 'expired' | 'not_yet_valid' |
 *                          'unknown_kid' }
 *
 * `unknown_kid` is returned when `resolveSigningKey(payload.kid)` returns null.
 * Caller (credential layer) is responsible for the row-level lookup +
 * tenant binding + status-state checks.
 *
 * @param {string} token
 * @param {object} opts
 * @param {function(string): Buffer|null} opts.resolveSigningKey
 * @param {number} [opts.clockSkewMs=CLOCK_SKEW_MS]
 * @param {number} [opts.nowMs=Date.now()]
 */
function verifyTokenSignature(token, opts) {
  if (!opts || typeof opts.resolveSigningKey !== 'function') {
    throw new Error('verifyTokenSignature: opts.resolveSigningKey required');
  }
  const parsed = parseToken(token);
  if (!parsed.ok) return { valid: false, reason: parsed.reason };

  const { prefix, payloadB64, sigB64, payload } = parsed;
  if (payload.v !== 1) return { valid: false, reason: 'unsupported_version' };
  if (payload.scope !== TOKEN_SCOPE) return { valid: false, reason: 'scope_mismatch' };
  if (!payload.kid || typeof payload.kid !== 'string') return { valid: false, reason: 'unknown_kid' };

  const key = opts.resolveSigningKey(payload.kid);
  if (!key || !Buffer.isBuffer(key) || key.length < 32) {
    return { valid: false, reason: 'unknown_kid' };
  }

  const expectedMac = crypto.createHmac('sha256', key)
    .update(DOMAIN_SEPARATOR + prefix + '.' + payloadB64)
    .digest();
  let providedMac;
  try {
    providedMac = b64urlDecode(sigB64);
  } catch (_) {
    return { valid: false, reason: 'bad_signature' };
  }
  if (providedMac.length !== expectedMac.length
      || !crypto.timingSafeEqual(providedMac, expectedMac)) {
    return { valid: false, reason: 'bad_signature' };
  }

  const nowMs       = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();
  const skewMs      = Number.isFinite(opts.clockSkewMs) ? opts.clockSkewMs : CLOCK_SKEW_MS;
  const nowSec      = Math.floor(nowMs / 1000);
  const skewSec     = Math.floor(skewMs / 1000);
  const iat         = Number(payload.iat);
  const exp         = Number(payload.exp);
  if (!Number.isFinite(iat) || !Number.isFinite(exp)) {
    return { valid: false, reason: 'malformed_payload' };
  }
  if (nowSec + skewSec < iat) return { valid: false, reason: 'not_yet_valid' };
  if (nowSec - skewSec > exp) return { valid: false, reason: 'expired' };

  return { valid: true, payload };
}

/**
 * sha256 hex of the full token string. Used as the row-lookup key in
 * lb_orchestration_credentials.token_hash.
 */
function hashTokenForLookup(token) {
  if (typeof token !== 'string' || !token) {
    throw new Error('hashTokenForLookup: token required');
  }
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * First N chars of a token, safe to log. Captures version + a few bytes
 * of payload header so logs can correlate, without revealing enough to
 * forge the token.
 */
function tokenPrefix(token) {
  if (typeof token !== 'string') return '';
  return token.slice(0, TOKEN_PREFIX_LENGTH);
}

module.exports = {
  // Constants
  TOKEN_PREFIX,
  TOKEN_SCOPE,
  TOKEN_ISSUER,
  TOKEN_PREFIX_LENGTH,
  DEFAULT_TOKEN_EXPIRY_MS,
  CLOCK_SKEW_MS,
  DOMAIN_SEPARATOR,

  // Functions
  encodeToken,
  parseToken,
  verifyTokenSignature,
  hashTokenForLookup,
  tokenPrefix,
};
