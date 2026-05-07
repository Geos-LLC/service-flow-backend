'use strict';

/**
 * PR-2 — webhook authentication helpers.
 *
 * Pure HMAC verification logic shared by:
 *   - /api/communications/webhooks/sigcore     (Sigcore)
 *   - /api/integrations/leadbridge/webhooks    (LeadBridge inbound)
 *
 * The third inbound webhook, /api/integrations/leadbridge/lead-status, has
 * its own inline implementation (May 2026, migration 035). This module
 * extracts that pattern so the two older handlers can adopt it without
 * copy-pasting.
 *
 * Verification model:
 *   - HMAC-SHA256 of `${timestamp}.${rawBody}` with the per-subscription secret
 *   - `crypto.timingSafeEqual` compare
 *   - Replay protection: timestamp must be within ±toleranceSeconds of now
 *   - Signature header may have an optional `sha256=` prefix (we strip it)
 *
 * The caller passes a `candidates` array of `{ user_id, secret }` rows.
 * We try each — first match wins, returns its user_id. This is the
 * shape /lead-status uses, and it works without trusting any unsigned
 * payload field for tenant attribution.
 */

const crypto = require('crypto');

// Default replay tolerance: 5 minutes. Matches /lead-status.
const DEFAULT_TOLERANCE_S = 5 * 60;

/**
 * Verify HMAC against a single (secret, payload, timestamp, signature) tuple.
 *
 * @param {Object} args
 * @param {string} args.secret          — plaintext secret bytes (caller decrypts)
 * @param {string} args.signatureHeader — value of X-*-Signature header
 * @param {string} args.timestamp       — value of X-*-Timestamp header (epoch seconds, string)
 * @param {string|Buffer} args.rawBody  — raw request body
 * @returns {{ valid: boolean, reason: string|null }}
 */
function verifySingleHmac({ secret, signatureHeader, timestamp, rawBody }) {
  if (!secret) return { valid: false, reason: 'missing_secret' };
  if (!signatureHeader) return { valid: false, reason: 'missing_signature' };
  if (!timestamp) return { valid: false, reason: 'missing_timestamp' };

  const body = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8')
    : typeof rawBody === 'string' ? rawBody
    : '';

  const expected = crypto.createHmac('sha256', secret)
    .update(`${timestamp}.${body}`)
    .digest('hex');

  // Tolerate optional `sha256=` prefix
  const provided = String(signatureHeader).replace(/^sha256=/i, '');

  if (expected.length !== provided.length) {
    return { valid: false, reason: 'length_mismatch' };
  }
  let match = false;
  try {
    match = crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(provided, 'hex'));
  } catch {
    return { valid: false, reason: 'invalid_hex' };
  }
  return { valid: match, reason: match ? null : 'signature_mismatch' };
}

/**
 * Check timestamp freshness — rejects replay attacks. Caller passes the
 * ts header as either a string or number (epoch seconds).
 *
 * @returns {{ valid: boolean, reason: string|null }}
 */
function verifyTimestampWindow(timestampHeader, toleranceS = DEFAULT_TOLERANCE_S, nowSec = null) {
  const tsNum = parseInt(timestampHeader, 10);
  if (!Number.isFinite(tsNum)) return { valid: false, reason: 'invalid_timestamp' };
  const now = nowSec ?? Math.floor(Date.now() / 1000);
  const drift = Math.abs(now - tsNum);
  if (drift > toleranceS) return { valid: false, reason: 'stale_timestamp' };
  return { valid: true, reason: null };
}

/**
 * Scan a list of candidate {user_id, secret} entries and return the first
 * whose secret produces a matching HMAC. Returns null if none match.
 *
 * Use this when the webhook body doesn't tell us up front which tenant it
 * belongs to — the signing key DOES tell us.
 */
function findMatchingCandidate(candidates, { signatureHeader, timestamp, rawBody }) {
  for (const cand of (candidates || [])) {
    const r = verifySingleHmac({
      secret: cand.secret,
      signatureHeader,
      timestamp,
      rawBody,
    });
    if (r.valid) return cand;
  }
  return null;
}

/**
 * One-shot: verify the timestamp window, then scan candidates.
 *
 * Returns:
 *   { ok: true, candidate } on success
 *   { ok: false, status: 401, reason } on auth failure
 *   { ok: false, status: 400, reason } on malformed input
 */
function authenticateWebhook({ signatureHeader, timestampHeader, rawBody, candidates, toleranceS, nowSec }) {
  if (!signatureHeader || !timestampHeader) {
    return { ok: false, status: 401, reason: 'missing_signature_or_timestamp' };
  }
  const ts = verifyTimestampWindow(timestampHeader, toleranceS, nowSec);
  if (!ts.valid) {
    return { ok: false, status: 401, reason: ts.reason };
  }
  if (!candidates || candidates.length === 0) {
    return { ok: false, status: 401, reason: 'no_candidates' };
  }
  const match = findMatchingCandidate(candidates, {
    signatureHeader, timestamp: timestampHeader, rawBody,
  });
  if (!match) {
    return { ok: false, status: 401, reason: 'signature_mismatch' };
  }
  return { ok: true, candidate: match };
}

module.exports = {
  DEFAULT_TOLERANCE_S,
  verifySingleHmac,
  verifyTimestampWindow,
  findMatchingCandidate,
  authenticateWebhook,
};
