'use strict';

// LB orchestration slot_token + idempotency helpers.
//
// slot_token format:
//   slot_v1.<base64url(payload_json)>.<base64url(hmac)>
//
// Payload:
//   { tenant_id, service_id, start_iso, end_iso, issued_at_ms, nonce }
//
// Signed with HMAC-SHA256 over the encoded payload using a key derived
// from SF_INTEGRATION_ENC_KEY (the same secret used for LB encryption,
// with a "lb-orchestration:" domain separator so tokens from one
// purpose can never be replayed for another).
//
// Verification rules:
//   - signature must match
//   - issued_at within max-age window (default 10 minutes)
//   - tenant_id must match the caller's tenant
//
// Idempotency-key hashing:
//   - SHA-256 over (tenant_id || ':' || endpoint || ':' || raw_key)
//   - Returns 16-char hex (sufficient collision resistance per-tenant)
//   - Used to derive deterministic event_ids and orchestration_attempts
//     row uniqueness.

const crypto = require('crypto');

const SLOT_TOKEN_PREFIX = 'slot_v1';
const DEFAULT_MAX_AGE_MS = 10 * 60 * 1000; // 10 minutes
const DOMAIN_SEPARATOR = 'lb-orchestration:';

function resolveSigningKey() {
  const raw = process.env.SF_INTEGRATION_ENC_KEY
    || process.env.JWT_SECRET
    || 'dev-only-orchestration-fallback-not-for-prod';
  // Stretch + domain-separate. Result is a 32-byte buffer.
  return crypto.createHash('sha256').update(DOMAIN_SEPARATOR + raw).digest();
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(s) {
  s = String(s).replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64');
}

/**
 * Sign and encode a slot_token.
 * @param {object} payload — { tenant_id, service_id, start_iso, end_iso }
 * @returns {string} slot_v1.<payload>.<hmac>
 */
function signSlotToken(payload) {
  if (!payload || typeof payload !== 'object') throw new Error('signSlotToken: payload required');
  if (payload.tenant_id == null) throw new Error('signSlotToken: tenant_id required');
  if (!payload.start_iso || !payload.end_iso) throw new Error('signSlotToken: start_iso + end_iso required');

  const enrichedPayload = {
    ...payload,
    issued_at_ms: Date.now(),
    nonce: crypto.randomBytes(8).toString('hex'),
  };
  const payloadStr = JSON.stringify(enrichedPayload);
  const payloadB64 = b64url(payloadStr);
  const mac = crypto.createHmac('sha256', resolveSigningKey())
    .update(SLOT_TOKEN_PREFIX + '.' + payloadB64)
    .digest();
  return SLOT_TOKEN_PREFIX + '.' + payloadB64 + '.' + b64url(mac);
}

/**
 * Verify a slot_token. Returns { valid, payload?, reason? }.
 *
 * @param {string} token
 * @param {object} opts
 * @param {string|number} opts.expected_tenant_id — must match payload.tenant_id
 * @param {number} [opts.max_age_ms=600000]      — token must be younger than this
 */
function verifySlotToken(token, opts = {}) {
  if (typeof token !== 'string' || !token.startsWith(SLOT_TOKEN_PREFIX + '.')) {
    return { valid: false, reason: 'malformed' };
  }
  const parts = token.split('.');
  if (parts.length !== 3) return { valid: false, reason: 'malformed' };
  const [prefix, payloadB64, sigB64] = parts;
  if (prefix !== SLOT_TOKEN_PREFIX) return { valid: false, reason: 'wrong_version' };

  let expectedMac;
  try {
    expectedMac = crypto.createHmac('sha256', resolveSigningKey())
      .update(SLOT_TOKEN_PREFIX + '.' + payloadB64)
      .digest();
  } catch (_) {
    return { valid: false, reason: 'hmac_error' };
  }

  let providedMac;
  try {
    providedMac = b64urlDecode(sigB64);
  } catch (_) {
    return { valid: false, reason: 'malformed_signature' };
  }
  if (providedMac.length !== expectedMac.length
      || !crypto.timingSafeEqual(providedMac, expectedMac)) {
    return { valid: false, reason: 'bad_signature' };
  }

  let payload;
  try {
    payload = JSON.parse(b64urlDecode(payloadB64).toString('utf8'));
  } catch (_) {
    return { valid: false, reason: 'malformed_payload' };
  }

  // Age check — treat opts.max_age_ms=0 as "immediately expired" rather
  // than falling through to the default.
  const maxAge = opts.max_age_ms == null ? DEFAULT_MAX_AGE_MS : Number(opts.max_age_ms);
  const age = Date.now() - Number(payload.issued_at_ms || 0);
  if (!Number.isFinite(age) || age < 0) return { valid: false, reason: 'invalid_issued_at' };
  if (maxAge <= 0 || age > maxAge) return { valid: false, reason: 'expired', age_ms: age };

  // Tenant binding
  if (opts.expected_tenant_id != null
      && String(payload.tenant_id) !== String(opts.expected_tenant_id)) {
    return { valid: false, reason: 'tenant_mismatch' };
  }

  return { valid: true, payload };
}

/**
 * Hash an LB-supplied idempotency_key into a deterministic 16-char hex
 * identifier scoped to (tenant_id, endpoint). Used for:
 *   - the lb_orchestration_attempts UNIQUE index
 *   - deriving deterministic outbound event_ids on booking_request
 */
function hashIdempotencyKey(tenant_id, endpoint, raw_key) {
  if (!raw_key) return null;
  const h = crypto.createHash('sha256')
    .update(String(tenant_id))
    .update(':')
    .update(String(endpoint))
    .update(':')
    .update(String(raw_key))
    .digest('hex');
  return h.slice(0, 16);
}

module.exports = {
  signSlotToken,
  verifySlotToken,
  hashIdempotencyKey,
  SLOT_TOKEN_PREFIX,
  DEFAULT_MAX_AGE_MS,
};
