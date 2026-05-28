'use strict';

// S4 — OAuth authorization-code lifecycle.
//
// Codes are short-lived (5 minutes per refinement 1) and single-use.
// They bind a (client_id, redirect_uri, sf_tenant_id) tuple chosen by
// the user at the /authorize consent screen, to a server-to-server
// /oauth/exchange call that completes the handshake.
//
// Format:
//   sfauth_v1.<base64url(32 random bytes)>
//
// Replay behavior (refinement 2):
//   - First /oauth/exchange marks the code consumed_at=now() and
//     stores the resulting credential_id on the row.
//   - Second /oauth/exchange with the same code returns 409
//     code_already_used. The previously-issued credential is preserved
//     (no automatic revocation), so a retry race does not phantom-disconnect
//     a valid tenant.

const crypto = require('crypto');

const CODES_TABLE        = 'lb_oauth_codes';
const CODE_PREFIX        = 'sfauth_v1';
const CODE_TTL_MS        = 5 * 60 * 1000;   // 5 minutes (refinement 1)
const CODE_RANDOM_BYTES  = 32;

function b64url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function newCode() {
  return CODE_PREFIX + '.' + b64url(crypto.randomBytes(CODE_RANDOM_BYTES));
}

/**
 * Issue a new authorization code. Caller (consent handler) has already
 * authenticated the SF user; user_id comes from the SF JWT.
 *
 * @param {object} supabase
 * @param {object} args
 * @param {string} args.clientId
 * @param {string} args.redirectUri
 * @param {number} args.userId
 * @param {string} [args.scope='lb_orchestration']
 * @param {string} [args.state]
 * @param {number} [args.ttlMs=CODE_TTL_MS]
 * @returns {Promise<{ ok: true, code: string, expires_at: string } | { ok: false, reason: string }>}
 */
async function issueCode(supabase, args) {
  if (!supabase || typeof supabase.from !== 'function') {
    throw new Error('issueCode: supabase required');
  }
  if (!args || !args.clientId || !args.redirectUri || args.userId == null) {
    throw new Error('issueCode: clientId, redirectUri, userId required');
  }
  const code      = newCode();
  const scope     = args.scope || 'lb_orchestration';
  const state     = args.state || null;
  const ttlMs     = Number.isFinite(args.ttlMs) ? Number(args.ttlMs) : CODE_TTL_MS;
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();

  const { error } = await supabase
    .from(CODES_TABLE)
    .insert({
      code,
      client_id:    args.clientId,
      redirect_uri: args.redirectUri,
      user_id:      Number(args.userId),
      scope,
      state,
      expires_at:   expiresAt,
    });

  if (error) {
    return { ok: false, reason: 'db_insert_failed', dbError: error.message };
  }
  return { ok: true, code, expires_at: expiresAt };
}

/**
 * Look up + consume a code in a single operation:
 *   - row must exist
 *   - row.client_id == args.clientId   (else mismatch)
 *   - row.redirect_uri == args.redirectUri  (else mismatch)
 *   - row.expires_at > now()           (else expired)
 *   - row.consumed_at IS NULL          (else already_used — refinement 2 keeps prior cred)
 *
 * On success: marks consumed_at=now(). Returns the row.
 *
 * Returns:
 *   { ok: true, row }
 *   { ok: false, reason: 'unknown_code' | 'invalid_client_for_code' | 'redirect_uri_mismatch'
 *                       | 'code_expired' | 'code_already_used' | 'db_error' }
 *
 * Note: refinement 2 says replay → 409 + DO NOT revoke prior credential.
 * The credential preservation is the responsibility of the exchange
 * handler (which returns 409 on 'code_already_used' and does nothing
 * else). This module just reports the state.
 */
async function consumeCode(supabase, args) {
  if (!supabase || typeof supabase.from !== 'function') {
    throw new Error('consumeCode: supabase required');
  }
  if (!args || !args.code || !args.clientId || !args.redirectUri) {
    throw new Error('consumeCode: code, clientId, redirectUri required');
  }

  const { data: row, error: lookupErr } = await supabase
    .from(CODES_TABLE)
    .select('code,client_id,redirect_uri,user_id,scope,state,issued_at,expires_at,consumed_at,issued_credential_id')
    .eq('code', args.code)
    .maybeSingle();

  if (lookupErr) {
    return { ok: false, reason: 'db_error', dbError: lookupErr.message };
  }
  if (!row) return { ok: false, reason: 'unknown_code' };
  if (row.client_id !== args.clientId) return { ok: false, reason: 'invalid_client_for_code' };
  if (row.redirect_uri !== args.redirectUri) return { ok: false, reason: 'redirect_uri_mismatch' };
  if (row.consumed_at) return { ok: false, reason: 'code_already_used', issuedCredentialId: row.issued_credential_id };

  const now = new Date();
  if (Date.parse(row.expires_at) < now.getTime()) {
    return { ok: false, reason: 'code_expired' };
  }

  // Mark consumed atomically. Filter by consumed_at IS NULL to defeat
  // double-consume races.
  const consumedIso = now.toISOString();
  const { data: updated, error: updateErr } = await supabase
    .from(CODES_TABLE)
    .update({ consumed_at: consumedIso })
    .eq('code', args.code)
    .is('consumed_at', null)
    .select('code')
    .maybeSingle();

  if (updateErr) {
    return { ok: false, reason: 'db_error', dbError: updateErr.message };
  }
  if (!updated) {
    // Another caller consumed it between our SELECT and our UPDATE.
    return { ok: false, reason: 'code_already_used' };
  }

  return { ok: true, row };
}

/**
 * After a credential has been minted from a consumed code, store the
 * credential id on the row so subsequent replays can be reported with
 * the prior cred_id for diagnostic visibility.
 */
async function attachCredentialToCode(supabase, code, credentialId) {
  if (!supabase || typeof supabase.from !== 'function') {
    throw new Error('attachCredentialToCode: supabase required');
  }
  if (!code || credentialId == null) return { ok: false, reason: 'args_required' };
  const { error } = await supabase
    .from(CODES_TABLE)
    .update({ issued_credential_id: Number(credentialId) })
    .eq('code', code);
  return error ? { ok: false, reason: 'db_error', dbError: error.message } : { ok: true };
}

module.exports = {
  CODES_TABLE,
  CODE_PREFIX,
  CODE_TTL_MS,
  issueCode,
  consumeCode,
  attachCredentialToCode,
};
