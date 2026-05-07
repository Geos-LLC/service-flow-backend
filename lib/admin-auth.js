'use strict';

/**
 * PR-3 admin auth — shared pure helpers.
 *
 * server.js wires the rate limiter + login handler in place; this module
 * exports the two helpers that are tractable to unit-test without bringing
 * up the full Express app:
 *
 *   adminConstantTimeCompare(a, b)
 *     Constant-time, length-safe equality check via SHA-256 → timingSafeEqual.
 *     Hashing both sides to identical-length buffers means neither the
 *     secret length nor an early return on length-mismatch can be used as
 *     a side channel.
 *
 *   requireAdminFlag(flagName, deps)
 *     Express middleware factory: blocks the request unless the named
 *     ENABLE_* flag is truthy in env. `deps` lets callers swap the
 *     feature-flag reader and the security logger for testing.
 */

const crypto = require('crypto');
const { isEnabled: realIsEnabled } = require('./feature-flags');

function adminConstantTimeCompare(a, b) {
  const aBuf = crypto.createHash('sha256').update(String(a == null ? '' : a)).digest();
  const bBuf = crypto.createHash('sha256').update(String(b == null ? '' : b)).digest();
  return crypto.timingSafeEqual(aBuf, bBuf);
}

function defaultLogSecurityEvent(req, kind, details) {
  const ip = (req.ip || req.headers['x-forwarded-for'] || 'unknown').toString().slice(0, 64);
  const ua = (req.headers['user-agent'] || '').toString().slice(0, 200);
  // eslint-disable-next-line no-console
  console.warn(`[Admin Security] ${kind}`, { ip, ua, path: req.path, method: req.method, ...(details || {}) });
}

function requireAdminFlag(flagName, deps = {}) {
  const isEnabled = deps.isEnabled || realIsEnabled;
  const logSecurityEvent = deps.logSecurityEvent || defaultLogSecurityEvent;
  return function adminFlagGate(req, res, next) {
    if (!isEnabled(flagName)) {
      logSecurityEvent(req, 'gated_endpoint_blocked', { flag: flagName });
      return res.status(403).json({ error: 'admin_endpoint_disabled', flag: flagName });
    }
    next();
  };
}

module.exports = {
  adminConstantTimeCompare,
  requireAdminFlag,
};
