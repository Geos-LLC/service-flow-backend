'use strict';

// SF orchestration auth middleware (PR-C4 / S2).
//
// Two pieces:
//
//   1. authenticateOrchestrationToken(supabase, opts?)
//      Returns an async Express middleware that verifies a
//      `Bearer sfo_v1...` token and sets req.user from the token's
//      tenant_id claim. Rejects 401 with a specific reason code for
//      every failure mode (malformed / expired / revoked / unknown
//      credential / grace_expired / tenant mismatch / etc.).
//
//   2. makeOrchestrationAuthDispatcher({ authenticateToken, supabase, logger? })
//      Returns a middleware that:
//        - if Authorization header starts with `Bearer sfo_v1.` → routes
//          through authenticateOrchestrationToken
//        - otherwise → routes through the caller's existing
//          authenticateToken (JWT) middleware
//      This keeps the existing in-app debug path (user JWT) working
//      alongside the new productized orchestration token path.
//
// Design notes:
//   - Dispatcher does header sniffing before either auth runs, so
//     malformed/missing Bearer headers fall to the JWT path (which has
//     well-tested 401 handling).
//   - No logging of plaintext tokens. token_prefix is logged at debug.
//   - Middleware functions are FACTORIES that close over the supabase
//     instance, so the same module can be unit-tested with stubs.

const {
  verifyCredentialToken,
  tokenPrefix,
} = require('./lb-orchestration-credentials');
const { TOKEN_PREFIX } = require('./lb-orchestration-token-format');

const BEARER_PREFIX = 'Bearer ' + TOKEN_PREFIX + '.';   // "Bearer sfo_v1."

/**
 * Look at the Authorization header and decide if this request is using
 * an orchestration token. Pure header sniffing — no parsing yet.
 */
function isOrchestrationTokenRequest(req) {
  const auth = req && req.headers && req.headers['authorization'];
  if (typeof auth !== 'string') return false;
  return auth.startsWith(BEARER_PREFIX);
}

/**
 * Map a verify-result reason → (HTTP status, error code, http-safe message).
 * Returned shape is what the client sees. Token contents never echoed.
 */
function reasonToHttpResponse(reason) {
  switch (reason) {
    case 'credential_revoked':
      return { status: 401, body: { error: 'credential_revoked',
        message: 'Orchestration credential has been revoked. Reconnect ServiceFlow to issue a new credential.' } };
    case 'grace_expired':
      return { status: 401, body: { error: 'credential_revoked',
        message: 'Orchestration credential has been revoked. Reconnect ServiceFlow to issue a new credential.' } };
    case 'expired':
      return { status: 401, body: { error: 'invalid_orchestration_token',
        message: 'Orchestration token has expired. Rotate before exp.' } };
    case 'not_yet_valid':
      return { status: 401, body: { error: 'invalid_orchestration_token',
        message: 'Orchestration token issued-at is in the future; check clock skew.' } };
    case 'bad_signature':
    case 'malformed':
    case 'malformed_payload':
    case 'unsupported_version':
    case 'scope_mismatch':
      return { status: 401, body: { error: 'invalid_orchestration_token',
        message: 'Orchestration token is invalid.' } };
    case 'unknown_kid':
      return { status: 401, body: { error: 'invalid_orchestration_token',
        message: 'Orchestration token signed with an unknown key id.' } };
    case 'unknown_credential':
      return { status: 401, body: { error: 'invalid_orchestration_token',
        message: 'Orchestration credential not found.' } };
    case 'tenant_mismatch':
      return { status: 401, body: { error: 'invalid_orchestration_token',
        message: 'Orchestration token tenant binding does not match.' } };
    case 'db_lookup_failed':
      return { status: 503, body: { error: 'service_unavailable',
        message: 'Orchestration credential lookup failed; retry shortly.' } };
    default:
      return { status: 401, body: { error: 'invalid_orchestration_token',
        message: 'Orchestration token could not be verified.' } };
  }
}

/**
 * Factory that returns an async Express middleware verifying the
 * `Bearer sfo_v1...` token in the Authorization header.
 *
 * On success: sets
 *   req.user = { userId, source: 'lb_orchestration_token', cred_id, kid, token_prefix }
 * and calls next().
 *
 * On failure: returns a 401 (or 503 for transient DB errors) without
 * calling next(). Never logs the plaintext token.
 *
 * @param {object} supabase
 * @param {object} [opts]
 * @param {object} [opts.logger]
 * @param {function} [opts.now] — for tests (ms)
 */
function makeAuthenticateOrchestrationToken(supabase, opts = {}) {
  if (!supabase || typeof supabase.from !== 'function') {
    throw new Error('makeAuthenticateOrchestrationToken: supabase required');
  }
  const logger = opts.logger || { log() {}, warn() {}, error() {}, debug() {} };

  return async function authenticateOrchestrationToken(req, res, next) {
    const auth = req.headers && req.headers['authorization'];
    if (typeof auth !== 'string' || !auth.startsWith(BEARER_PREFIX)) {
      return res.status(401).json({
        error: 'invalid_orchestration_token',
        message: 'Authorization header missing or malformed.',
      });
    }
    const token = auth.slice('Bearer '.length).trim();
    const prefix = tokenPrefix(token);

    let result;
    try {
      result = await verifyCredentialToken(supabase, token, {
        nowMs: typeof opts.now === 'function' ? opts.now() : undefined,
      });
    } catch (err) {
      // Never include the token in the log; only the prefix.
      try { logger.error(`[orch-auth] verify threw for ${prefix}: ${err && err.message}`); } catch (_) {}
      return res.status(503).json({
        error: 'service_unavailable',
        message: 'Orchestration credential lookup failed.',
      });
    }

    if (!result || !result.valid) {
      const reason = result && result.reason;
      try { logger.debug && logger.debug(`[orch-auth] reject ${prefix} reason=${reason}`); } catch (_) {}
      const { status, body } = reasonToHttpResponse(reason);
      return res.status(status).json(body);
    }

    // Bind tenant + cred to req.user. Mirror the shape the existing
    // authenticateToken produces (userId at minimum) so downstream
    // handlers don't need to special-case the auth source.
    req.user = {
      userId:        Number(result.payload.tenant_id),
      source:        'lb_orchestration_token',
      cred_id:       result.credential.id,
      kid:           result.credential.kid,
      token_prefix:  prefix,
    };

    return next();
  };
}

/**
 * Factory that returns an Express middleware that dispatches to either
 * the orchestration-token auth or the caller's existing user-JWT auth,
 * based on the Authorization header prefix.
 *
 * `Bearer sfo_v1.*` → authenticateOrchestrationToken
 * anything else      → authenticateToken (delegated to caller)
 *
 * @param {object} args
 * @param {function} args.authenticateToken — the existing user JWT middleware
 * @param {object} args.supabase
 * @param {object} [args.logger]
 * @param {function} [args.now]
 */
function makeOrchestrationAuthDispatcher(args) {
  if (!args || typeof args.authenticateToken !== 'function') {
    throw new Error('makeOrchestrationAuthDispatcher: authenticateToken required');
  }
  if (!args.supabase || typeof args.supabase.from !== 'function') {
    throw new Error('makeOrchestrationAuthDispatcher: supabase required');
  }
  const orchAuth = makeAuthenticateOrchestrationToken(args.supabase, {
    logger: args.logger,
    now:    args.now,
  });
  const userAuth = args.authenticateToken;

  return function orchestrationAuthDispatcher(req, res, next) {
    if (isOrchestrationTokenRequest(req)) {
      return orchAuth(req, res, next);
    }
    return userAuth(req, res, next);
  };
}

module.exports = {
  BEARER_PREFIX,
  isOrchestrationTokenRequest,
  reasonToHttpResponse,
  makeAuthenticateOrchestrationToken,
  makeOrchestrationAuthDispatcher,
};
