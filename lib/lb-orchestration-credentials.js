'use strict';

// SF orchestration credential primitives (PR-C3 / S1).
//
// DB-bound lifecycle for `lb_orchestration_credentials` rows:
//
//   mintCredential     INSERT status=active
//   verifyCredentialToken   SELECT + state-machine + tenant binding
//   rotateCredential   active -> rotating + grace_expires_at, new active
//   revokeCredential   active|rotating -> revoked atomically
//   sweepExpiredRotating    background grace-expiry cleanup
//
// State machine (matches migration 057):
//   active   — current credential. Exactly one per tenant (partial unique index).
//   rotating — predecessor during 5-minute grace overlap. At most one per tenant.
//   revoked  — terminal. Token will never authenticate again.
//
// HARD RULES:
//   - Plaintext tokens are NEVER stored. Only sha256(token) lives in
//     token_hash. token_prefix (first 13 chars) is safe to log.
//   - Token verification is double-bound: HMAC over payload AND row-level
//     token_hash AND tenant_id match. Any of the three failing → reject.
//   - All public functions accept `supabase` as a parameter. No globals,
//     no module-level DB references. Module import has zero side effects.
//   - Env reads (`SF_ORCH_SIGNING_KEY`) are lazy and only happen when
//     `mintCredential` or `verifyCredentialToken` is called — so importing
//     this module on a server without the env set won't crash startup.
//   - No route in PR-C3 mounts these primitives. They will only be called
//     by code shipped in S2+ (auth middleware, credential endpoints,
//     OAuth handshake).

const crypto = require('crypto');
const {
  encodeToken,
  verifyTokenSignature,
  hashTokenForLookup,
  tokenPrefix,
  DEFAULT_TOKEN_EXPIRY_MS,
  CLOCK_SKEW_MS,
} = require('./lb-orchestration-token-format');

const TABLE                  = 'lb_orchestration_credentials';
const DEFAULT_KID            = 'sf_orch_2026_05';
const GRACE_WINDOW_MS        = 5 * 60 * 1000;   // 5 minutes
const ROTATION_REASON_DEFAULT = 'scheduled';
const REVOKE_REASON_DEFAULT   = 'user_initiated';

// ─────────────────────────────────────────────────────────────────
// Signing key resolution
// ─────────────────────────────────────────────────────────────────

/**
 * Returns the current kid (per `SF_ORCH_SIGNING_KEY_KID`, defaulting to
 * `sf_orch_2026_05`). Used when minting new tokens.
 */
function getCurrentKid() {
  return process.env.SF_ORCH_SIGNING_KEY_KID || DEFAULT_KID;
}

/**
 * Look up the 32-byte HMAC key for a given kid. Reads two env vars:
 *
 *   SF_ORCH_SIGNING_KEY        — current key (base64-encoded 32 bytes)
 *   SF_ORCH_SIGNING_KEY_KID    — current key's kid (optional, defaults
 *                                to DEFAULT_KID)
 *   SF_ORCH_SIGNING_KEY_PREV   — previous key (optional, base64 32 bytes)
 *   SF_ORCH_SIGNING_KEY_PREV_KID — previous key's kid (optional)
 *
 * Returns the Buffer, or null if the kid is not recognized / the env
 * is not configured. Never throws on missing env — callers convert null
 * to `unknown_kid`.
 */
function resolveSigningKey(kid) {
  if (!kid) return null;
  const currentKid = getCurrentKid();
  const prevKid    = process.env.SF_ORCH_SIGNING_KEY_PREV_KID || null;

  let raw = null;
  if (kid === currentKid) {
    raw = process.env.SF_ORCH_SIGNING_KEY || null;
  } else if (prevKid && kid === prevKid) {
    raw = process.env.SF_ORCH_SIGNING_KEY_PREV || null;
  }
  if (!raw) return null;

  try {
    const buf = Buffer.from(raw, 'base64');
    if (buf.length < 32) return null;
    return buf;
  } catch (_) {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────
// Mint
// ─────────────────────────────────────────────────────────────────

/**
 * Mint a new active credential for a tenant. Inserts one row and
 * returns the plaintext token + metadata. Plaintext token is returned
 * ONCE; only the sha256 hash is stored.
 *
 * The caller (S4 handshake) is responsible for ensuring a tenant does
 * not already have an active credential (the partial unique index will
 * reject the insert with code 23505 if so).
 *
 * @param {object} supabase
 * @param {object} args
 * @param {number} args.userId
 * @param {number} [args.expiresInMs=90 days]
 * @param {string} [args.createdBy='connect_handshake']
 * @param {string} [args.kid=getCurrentKid()]
 * @returns {Promise<{ ok: true, token, credentialId, tokenPrefix, kid, issuedAt, expiresAt }
 *                | { ok: false, reason }>}
 */
async function mintCredential(supabase, args) {
  if (!supabase || typeof supabase.from !== 'function') {
    throw new Error('mintCredential: supabase required');
  }
  if (!args || args.userId == null) {
    throw new Error('mintCredential: userId required');
  }

  const userId      = Number(args.userId);
  const kid         = args.kid || getCurrentKid();
  const createdBy   = args.createdBy || 'connect_handshake';
  const expiresInMs = Number.isFinite(args.expiresInMs) ? args.expiresInMs : DEFAULT_TOKEN_EXPIRY_MS;

  const signingKey = resolveSigningKey(kid);
  if (!signingKey) {
    return { ok: false, reason: 'signing_key_not_configured', kid };
  }

  const encoded = encodeToken({
    tenantId:    userId,
    kid,
    expiresInMs,
    signingKey,
  });

  const tokenHash = hashTokenForLookup(encoded.token);

  const row = {
    user_id:      userId,
    token_hash:   tokenHash,
    token_prefix: encoded.tokenPrefix,
    kid,
    scope:        'lb_orchestration',
    status:       'active',
    issued_at:    new Date(encoded.issuedAtMs).toISOString(),
    expires_at:   new Date(encoded.expiresAtMs).toISOString(),
    created_by:   createdBy,
  };

  const { data, error } = await supabase
    .from(TABLE)
    .insert(row)
    .select('id')
    .single();

  if (error) {
    // Partial-unique-index collision => caller should rotate, not mint.
    if (error.code === '23505') {
      return { ok: false, reason: 'active_credential_already_exists' };
    }
    return { ok: false, reason: 'db_insert_failed', dbError: error.message };
  }

  return {
    ok:           true,
    token:        encoded.token,           // plaintext, returned ONCE
    credentialId: data.id,
    tokenPrefix:  encoded.tokenPrefix,
    kid,
    issuedAt:     row.issued_at,
    expiresAt:    row.expires_at,
  };
}

// ─────────────────────────────────────────────────────────────────
// Verify
// ─────────────────────────────────────────────────────────────────

/**
 * Verify a presented orchestration token end-to-end:
 *
 *   1. Structural parse + HMAC signature (via lb-orchestration-token-format).
 *   2. Row lookup by sha256(token).
 *   3. Tenant binding: payload.tenant_id === row.user_id.
 *   4. State check: active OR (rotating AND grace_expires_at > now).
 *   5. Lazy cleanup: rotating + grace_expired → flip to revoked + reject.
 *
 * Returns:
 *   { valid: true, payload, credential, ageMs }
 *   { valid: false, reason }
 *
 * Reasons:
 *   malformed | malformed_payload | unsupported_version | scope_mismatch
 *   bad_signature | expired | not_yet_valid | unknown_kid
 *   unknown_credential | credential_revoked | grace_expired
 *   tenant_mismatch
 *
 * Side effect (only): if a `rotating` credential is presented past its
 * grace_expires_at, the row is UPDATEd to status='revoked' before
 * returning. This is the lazy half of the cleanup story; the periodic
 * sweep (`sweepExpiredRotating`) is the other half.
 */
async function verifyCredentialToken(supabase, token, opts = {}) {
  if (!supabase || typeof supabase.from !== 'function') {
    throw new Error('verifyCredentialToken: supabase required');
  }

  // Structural + signature verification (no DB).
  const sigResult = verifyTokenSignature(token, {
    resolveSigningKey,
    clockSkewMs: opts.clockSkewMs,
    nowMs:       opts.nowMs,
  });
  if (!sigResult.valid) {
    return { valid: false, reason: sigResult.reason };
  }
  const payload   = sigResult.payload;
  const tokenHash = hashTokenForLookup(token);
  const nowMs     = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();
  const nowIso    = new Date(nowMs).toISOString();

  // Row lookup.
  const { data: row, error } = await supabase
    .from(TABLE)
    .select('id,user_id,token_hash,status,grace_expires_at,expires_at,kid,scope,revoked_at')
    .eq('token_hash', tokenHash)
    .maybeSingle();

  if (error) {
    return { valid: false, reason: 'db_lookup_failed', dbError: error.message };
  }
  if (!row) {
    return { valid: false, reason: 'unknown_credential' };
  }

  // Cross-bind tenant + hash. HMAC already verified payload, but defense
  // in depth: if payload.tenant_id is forged at the row layer (e.g.
  // someone replaces a token with another tenant's), this catches it.
  if (Number(row.user_id) !== Number(payload.tenant_id)) {
    return { valid: false, reason: 'tenant_mismatch' };
  }

  // State machine.
  if (row.status === 'revoked') {
    return { valid: false, reason: 'credential_revoked' };
  }
  if (row.status === 'rotating') {
    const graceMs = row.grace_expires_at ? Date.parse(row.grace_expires_at) : 0;
    if (!Number.isFinite(graceMs) || graceMs <= nowMs) {
      // Lazy cleanup: flip to revoked, then reject.
      await supabase
        .from(TABLE)
        .update({
          status:         'revoked',
          revoked_at:     nowIso,
          revoked_reason: 'grace_expired',
        })
        .eq('id', row.id)
        .eq('status', 'rotating');             // optimistic guard
      return { valid: false, reason: 'grace_expired' };
    }
  } else if (row.status !== 'active') {
    return { valid: false, reason: 'credential_revoked' };
  }

  // Best-effort last_used_at update (fire-and-forget; do not block auth).
  supabase
    .from(TABLE)
    .update({ last_used_at: nowIso })
    .eq('id', row.id)
    .then(() => {}, () => {});

  return {
    valid:      true,
    payload,
    credential: {
      id:               row.id,
      user_id:          row.user_id,
      status:           row.status,
      grace_expires_at: row.grace_expires_at,
      kid:              row.kid,
      scope:            row.scope,
    },
  };
}

// ─────────────────────────────────────────────────────────────────
// Rotate
// ─────────────────────────────────────────────────────────────────

/**
 * Rotate the active credential for a tenant. Demotes the active row to
 * `rotating` with a 5-minute grace window, then mints a new active.
 *
 * Concurrency note: Supabase JS does not expose transactions, so this
 * function runs two writes:
 *
 *   1. UPDATE active -> rotating + grace_expires_at = now + 5m
 *      (filtered by status='active' so a concurrent revoke wins)
 *   2. INSERT new active row referencing the rotated-from id
 *
 * If step 1 affects zero rows, we treat it as "nothing to rotate" and
 * return early. If step 2 fails (e.g. partial unique index collision
 * because another caller already minted a new active), we re-promote
 * the rotating row by failing loud — the caller should retry.
 *
 * For tighter atomicity, a future migration could move this into an RPC.
 * S1 ships the two-write form; it is sufficient because the rotation
 * endpoint will be the only writer once shipped.
 */
async function rotateCredential(supabase, args) {
  if (!supabase || typeof supabase.from !== 'function') {
    throw new Error('rotateCredential: supabase required');
  }
  if (!args || args.userId == null) {
    throw new Error('rotateCredential: userId required');
  }

  const userId  = Number(args.userId);
  const reason  = args.reason  || ROTATION_REASON_DEFAULT;
  const kid     = args.kid     || getCurrentKid();
  const nowMs   = Number.isFinite(args.nowMs) ? args.nowMs : Date.now();
  const graceMs = nowMs + GRACE_WINDOW_MS;
  const graceIso = new Date(graceMs).toISOString();

  // Step 1: demote active -> rotating.
  const { data: demoted, error: demoteErr } = await supabase
    .from(TABLE)
    .update({ status: 'rotating', grace_expires_at: graceIso })
    .eq('user_id', userId)
    .eq('status', 'active')
    .select('id')
    .maybeSingle();

  if (demoteErr) {
    return { ok: false, reason: 'db_update_failed', dbError: demoteErr.message };
  }
  if (!demoted) {
    return { ok: false, reason: 'no_active_credential' };
  }

  // Step 2: mint new active.
  const minted = await mintCredential(supabase, {
    userId,
    kid,
    createdBy: `rotation:${reason}`,
  });
  if (!minted.ok) {
    return { ok: false, reason: `mint_failed:${minted.reason}` };
  }

  // Link new -> old via rotated_from_id (best-effort).
  await supabase
    .from(TABLE)
    .update({ rotated_from_id: demoted.id })
    .eq('id', minted.credentialId)
    .then(() => {}, () => {});

  return {
    ok:                true,
    token:             minted.token,
    newCredentialId:   minted.credentialId,
    newTokenPrefix:    minted.tokenPrefix,
    previousCredentialId: demoted.id,
    previousGraceExpiresAt: graceIso,
    expiresAt:         minted.expiresAt,
    issuedAt:          minted.issuedAt,
  };
}

// ─────────────────────────────────────────────────────────────────
// Revoke
// ─────────────────────────────────────────────────────────────────

/**
 * Revoke ALL non-terminal credentials for a tenant (active + rotating).
 * Single UPDATE, atomic via the WHERE clause. Returns the revoked ids.
 */
async function revokeCredential(supabase, args) {
  if (!supabase || typeof supabase.from !== 'function') {
    throw new Error('revokeCredential: supabase required');
  }
  if (!args || args.userId == null) {
    throw new Error('revokeCredential: userId required');
  }

  const userId = Number(args.userId);
  const reason = args.reason || REVOKE_REASON_DEFAULT;
  const nowMs  = Number.isFinite(args.nowMs) ? args.nowMs : Date.now();
  const nowIso = new Date(nowMs).toISOString();

  const { data, error } = await supabase
    .from(TABLE)
    .update({
      status:         'revoked',
      revoked_at:     nowIso,
      revoked_reason: reason,
    })
    .eq('user_id', userId)
    .in('status', ['active', 'rotating'])
    .select('id,status');

  if (error) {
    return { ok: false, reason: 'db_update_failed', dbError: error.message };
  }

  const revokedIds = (data || []).map((r) => r.id);
  return {
    ok:         true,
    revokedIds,
    revokedCount: revokedIds.length,
  };
}

// ─────────────────────────────────────────────────────────────────
// Sweep
// ─────────────────────────────────────────────────────────────────

/**
 * Periodic cleanup: flip any `rotating` credential whose grace_expires_at
 * has passed to `revoked`. Intended to run on a scheduler (added in S2).
 * Returns the number of rows flipped.
 *
 * The auth middleware also does this lazily, but the sweep ensures rows
 * that never receive another auth call still get cleaned up.
 */
async function sweepExpiredRotating(supabase, opts = {}) {
  if (!supabase || typeof supabase.from !== 'function') {
    throw new Error('sweepExpiredRotating: supabase required');
  }
  const nowMs  = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();
  const nowIso = new Date(nowMs).toISOString();

  const { data, error } = await supabase
    .from(TABLE)
    .update({
      status:         'revoked',
      revoked_at:     nowIso,
      revoked_reason: 'grace_expired',
    })
    .eq('status', 'rotating')
    .lte('grace_expires_at', nowIso)
    .select('id');

  if (error) {
    return { ok: false, reason: 'db_update_failed', dbError: error.message };
  }
  return { ok: true, sweptCount: (data || []).length };
}

module.exports = {
  // Constants
  TABLE,
  DEFAULT_KID,
  GRACE_WINDOW_MS,

  // Re-exports from codec (caller convenience; lets consumers import
  // one file rather than two).
  hashTokenForLookup,
  tokenPrefix,
  DEFAULT_TOKEN_EXPIRY_MS,
  CLOCK_SKEW_MS,

  // Key resolution
  getCurrentKid,
  resolveSigningKey,

  // Lifecycle
  mintCredential,
  verifyCredentialToken,
  rotateCredential,
  revokeCredential,
  sweepExpiredRotating,
};
