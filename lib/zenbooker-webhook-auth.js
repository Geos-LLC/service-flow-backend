'use strict';

/**
 * P0.2 — Zenbooker webhook authentication.
 *
 * Constitution §6.1: every inbound webhook MUST have signature verification.
 * Zenbooker's webhook product (as of 2026-05) does not natively HMAC-sign
 * payloads. Until/unless ZB adds signing, we accept the following equivalents:
 *
 *   1. HMAC-SHA256 over the raw body, sent as `X-ZB-Signature: <hex>` or
 *      `X-ZB-Signature: sha256=<hex>`. Secret comes from
 *      `process.env.ZENBOOKER_WEBHOOK_SECRET`. (If ZB later adds signing,
 *      this branch is forward-compatible — we just stop using the bearer.)
 *
 *   2. Shared-secret bearer: `X-ZB-Secret: <secret>` header (timing-safe
 *      compare against `process.env.ZENBOOKER_WEBHOOK_SECRET`). This is the
 *      interim mode the constitution allows ("shared secret + IP allowlist
 *      as interim if ZB doesn't support HMAC").
 *
 *   3. IP allowlist: `process.env.ZENBOOKER_WEBHOOK_ALLOWED_IPS` is a
 *      comma-separated list of IPs/CIDRs (CIDR matching is naive — we
 *      compare against the literal prefix). Used as defense-in-depth, not as
 *      the sole auth mechanism (it falls back to allowing once an IP matches
 *      AND no other auth was attempted, but in flag-ON mode an IP match
 *      alone is NOT sufficient — auth still requires #1 or #2).
 *
 * Behavior matrix:
 *   - Flag OFF (rollout phase):
 *       Always proceed. If a header was present and verification failed,
 *       log a structured warning so operators can see counts during the
 *       staging soak before flipping the flag.
 *   - Flag ON:
 *       Reject with 401 unless one of #1 or #2 succeeds. IP allowlist
 *       (when set) MUST also match. Missing secret/env = 503 (misconfig).
 */

const crypto = require('crypto');
const { FLAGS, isEnabled } = require('./feature-flags');

function timingSafeEqualStr(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const A = Buffer.from(a);
  const B = Buffer.from(b);
  if (A.length !== B.length) return false;
  try {
    return crypto.timingSafeEqual(A, B);
  } catch {
    return false;
  }
}

function verifyHmacSignature({ secret, signatureHeader, rawBody }) {
  if (!secret) return { valid: false, reason: 'missing_secret_env' };
  if (!signatureHeader) return { valid: false, reason: 'missing_signature' };
  const body = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8')
    : typeof rawBody === 'string' ? rawBody
    : '';
  const expected = crypto.createHmac('sha256', secret).update(body).digest('hex');
  const provided = String(signatureHeader).replace(/^sha256=/i, '');
  if (expected.length !== provided.length) return { valid: false, reason: 'length_mismatch' };
  let match = false;
  try {
    match = crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(provided, 'hex'));
  } catch {
    return { valid: false, reason: 'invalid_hex' };
  }
  return { valid: match, reason: match ? null : 'signature_mismatch' };
}

function verifySharedSecret({ secret, secretHeader }) {
  if (!secret) return { valid: false, reason: 'missing_secret_env' };
  if (!secretHeader) return { valid: false, reason: 'missing_secret_header' };
  return timingSafeEqualStr(String(secretHeader), String(secret))
    ? { valid: true, reason: null }
    : { valid: false, reason: 'secret_mismatch' };
}

function checkIpAllowlist({ allowlist, requestIp }) {
  if (!allowlist || allowlist.length === 0) return { applies: false, allowed: true };
  if (!requestIp) return { applies: true, allowed: false, reason: 'missing_ip' };
  // Naive prefix match — sufficient for fixed Zenbooker egress IPs.
  for (const entry of allowlist) {
    const e = String(entry).trim();
    if (!e) continue;
    if (e === requestIp) return { applies: true, allowed: true };
    if (e.endsWith('.') && requestIp.startsWith(e)) return { applies: true, allowed: true };
    // CIDR-ish: "1.2.3." prefix entry
    if (e.includes('/')) {
      const [prefix] = e.split('/');
      if (prefix && requestIp.startsWith(prefix.replace(/\.0$/, '.'))) return { applies: true, allowed: true };
    }
  }
  return { applies: true, allowed: false, reason: 'ip_not_in_allowlist' };
}

/**
 * One-shot auth: pull secret from env, run all checks, return a verdict.
 *
 * @param {Object} req       Express request (must carry req.rawBody when express.json
 *                            was mounted with the verify callback at server.js:1118)
 * @param {Function} [now]   override clock for tests (unused — kept for symmetry)
 * @returns {{ ok: boolean, status: number, reason: string|null, mode: string|null }}
 */
function authenticateZenbookerWebhook(req) {
  const flagOn = isEnabled(FLAGS.ZB_WEBHOOK_AUTH_REQUIRED);
  const secret = process.env.ZENBOOKER_WEBHOOK_SECRET || '';
  const allowlistEnv = process.env.ZENBOOKER_WEBHOOK_ALLOWED_IPS || '';
  const allowlist = allowlistEnv.split(',').map(s => s.trim()).filter(Boolean);

  const sigHeader = req.headers['x-zb-signature'] || req.headers['x-zenbooker-signature'];
  const secretHeader = req.headers['x-zb-secret'] || req.headers['x-zenbooker-secret'];
  const requestIp = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || req.connection?.remoteAddress || null;

  // Compute auth outcomes (we always compute these for observability, even
  // when the flag is off — that's the staging-soak signal).
  let hmacResult = null;
  if (sigHeader) {
    hmacResult = verifyHmacSignature({ secret, signatureHeader: sigHeader, rawBody: req.rawBody });
  }

  let bearerResult = null;
  if (secretHeader) {
    bearerResult = verifySharedSecret({ secret, secretHeader });
  }

  const ipResult = checkIpAllowlist({ allowlist, requestIp });

  const authPassed = (hmacResult?.valid === true) || (bearerResult?.valid === true);
  const mode = hmacResult?.valid ? 'hmac' : bearerResult?.valid ? 'shared_secret' : null;

  if (!flagOn) {
    // Rollout phase: never block. Surface a warning if any auth was attempted
    // and failed, so operators can watch counts in Loki before flipping.
    if (sigHeader || secretHeader) {
      const reason = !authPassed
        ? (hmacResult?.reason || bearerResult?.reason || 'unknown')
        : null;
      return { ok: true, status: 200, reason, mode, flag: 'off', attempted: true, ipResult };
    }
    return { ok: true, status: 200, reason: 'no_auth_attempted', mode: null, flag: 'off', attempted: false, ipResult };
  }

  // Flag ON: enforce.
  if (!secret) {
    return { ok: false, status: 503, reason: 'zb_webhook_secret_not_configured', mode: null, flag: 'on' };
  }
  if (!authPassed) {
    return {
      ok: false,
      status: 401,
      reason: hmacResult?.reason || bearerResult?.reason || 'missing_signature_or_secret',
      mode: null,
      flag: 'on',
    };
  }
  if (allowlist.length > 0 && !ipResult.allowed) {
    return { ok: false, status: 401, reason: ipResult.reason || 'ip_not_in_allowlist', mode, flag: 'on' };
  }
  return { ok: true, status: 200, reason: null, mode, flag: 'on' };
}

module.exports = {
  verifyHmacSignature,
  verifySharedSecret,
  checkIpAllowlist,
  authenticateZenbookerWebhook,
};
