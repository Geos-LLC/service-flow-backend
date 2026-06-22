'use strict';

/**
 * ProofPix integration — token primitives.
 *
 * Three token kinds:
 *
 *   1. Connect code — short, human-typeable, single-use, 10 min TTL.
 *      Admin generates one in the SF web UI and pastes it into the
 *      ProofPix mobile app's connect screen.
 *
 *      Format: XXXX-XXXX-XXXX-XXXX  (base32 of 10 random bytes,
 *      grouped in 4s for typing). ~80 bits of entropy. Crockford-style
 *      alphabet (no I/O/0/1) to avoid confusion when typing or reading
 *      off a screenshot.
 *
 *   2. Refresh token — opaque, long-lived (revoke-only), one per
 *      device. Returned exactly once at /connect/code/redeem; the SF
 *      DB stores only sha256(token). Caller (Railway proxy) stores
 *      the raw value keyed by the admin's session.
 *
 *      Format: pprt_<base64url(32 random bytes)>.
 *
 *   3. Access token — short-lived (1h) JWT, scoped to
 *      `aud: 'proofpix'`. Signed with SF's existing JWT_SECRET, so the
 *      same KMS / rotation pattern applies. The verifier rejects tokens
 *      without the right aud, so a proofpix access token can't be used
 *      against /api/jobs and a regular SF JWT can't be used against
 *      /api/integrations/proofpix/connection/status.
 */

const crypto = require('crypto');
const jwt = require('jsonwebtoken');

// ─────────────────────────────────────────────────────────────────────
// Connect codes
// ─────────────────────────────────────────────────────────────────────

// Crockford base32 alphabet without I, L, O, U — avoids ambiguity when
// users type the code off a screen. (Standard Crockford drops I/L/O/U;
// we keep the same.)
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_RANDOM_BYTES = 10;        // ~80 bits of entropy
const CODE_GROUP_SIZE   = 4;
const CODE_TTL_MS       = 10 * 60 * 1000;

function encodeBase32(buf) {
  // Standard base32 of arbitrary bytes using CODE_ALPHABET. 5 bits per
  // output char. 10 bytes → 16 chars exact (no padding needed).
  let bits = 0;
  let value = 0;
  let out = '';
  for (let i = 0; i < buf.length; i++) {
    value = (value << 8) | buf[i];
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += CODE_ALPHABET[(value >> bits) & 0x1f];
    }
  }
  if (bits > 0) out += CODE_ALPHABET[(value << (5 - bits)) & 0x1f];
  return out;
}

function newConnectCode() {
  const raw = encodeBase32(crypto.randomBytes(CODE_RANDOM_BYTES));
  const groups = [];
  for (let i = 0; i < raw.length; i += CODE_GROUP_SIZE) {
    groups.push(raw.slice(i, i + CODE_GROUP_SIZE));
  }
  return groups.join('-');
}

/**
 * Normalize user-supplied codes before lookup: uppercase, strip non-alphabet
 * chars (so " abcd-efgh efghijkl " all hit the same row). Returns the
 * canonical, hyphen-grouped form that matches what newConnectCode() produced.
 *
 * Returns null if the cleaned input is the wrong length or contains chars
 * outside the alphabet.
 */
function normalizeConnectCode(input) {
  if (typeof input !== 'string') return null;
  const cleaned = input.toUpperCase().replace(/[^0-9A-Z]/g, '');
  const expectedLen = Math.ceil((CODE_RANDOM_BYTES * 8) / 5);
  if (cleaned.length !== expectedLen) return null;
  for (const ch of cleaned) {
    if (CODE_ALPHABET.indexOf(ch) === -1) return null;
  }
  const groups = [];
  for (let i = 0; i < cleaned.length; i += CODE_GROUP_SIZE) {
    groups.push(cleaned.slice(i, i + CODE_GROUP_SIZE));
  }
  return groups.join('-');
}

// ─────────────────────────────────────────────────────────────────────
// b64url (shared between refresh and connect tokens)
// ─────────────────────────────────────────────────────────────────────

function b64url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ─────────────────────────────────────────────────────────────────────
// Connect tokens (same-device pairing via deep-link)
//
// Lives in the same proofpix_connect_codes table as the 16-char codes;
// the /connect/redeem handler tells them apart by shape (codes are
// hyphen-grouped Crockford uppercase, tokens are base64url with no
// hyphens) and applies the right TTL.
//
// Tokens are 32 random bytes → base64url (43 chars, no padding).
// 60-second TTL — much shorter than codes because the deep-link flow
// redeems them instantly via window.location → OS handoff → ProofPix.
// ─────────────────────────────────────────────────────────────────────

const CONNECT_TOKEN_RANDOM_BYTES = 32;
const CONNECT_TOKEN_TTL_MS       = 60 * 1000;
// 32 random bytes encoded as base64url = ceil(32 * 8 / 6) = 43 chars
// with no padding. Strict length match so a malformed input is caught
// at the discriminator before we touch the DB.
const CONNECT_TOKEN_LENGTH       = 43;
const CONNECT_TOKEN_RE           = new RegExp(`^[A-Za-z0-9_-]{${CONNECT_TOKEN_LENGTH}}$`);

function newConnectToken() {
  return b64url(crypto.randomBytes(CONNECT_TOKEN_RANDOM_BYTES));
}

function isConnectToken(input) {
  return typeof input === 'string' && CONNECT_TOKEN_RE.test(input);
}

// ─────────────────────────────────────────────────────────────────────
// Refresh tokens
// ─────────────────────────────────────────────────────────────────────

const REFRESH_PREFIX       = 'pprt_';
const REFRESH_RANDOM_BYTES = 32;

function newRefreshToken() {
  return REFRESH_PREFIX + b64url(crypto.randomBytes(REFRESH_RANDOM_BYTES));
}

function hashRefreshToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

// ─────────────────────────────────────────────────────────────────────
// Access tokens (JWT, aud: 'proofpix')
// ─────────────────────────────────────────────────────────────────────

const ACCESS_TOKEN_AUDIENCE = 'proofpix';
const ACCESS_TOKEN_TTL_SEC  = 60 * 60;   // 1h

function signAccessToken(jwtSecret, { userId, connectionId }) {
  if (!jwtSecret) throw new Error('signAccessToken: jwtSecret required');
  if (userId == null) throw new Error('signAccessToken: userId required');
  if (connectionId == null) throw new Error('signAccessToken: connectionId required');
  return jwt.sign(
    {
      userId: Number(userId),
      cid: Number(connectionId),
      kind: 'access',
    },
    jwtSecret,
    {
      audience: ACCESS_TOKEN_AUDIENCE,
      expiresIn: ACCESS_TOKEN_TTL_SEC,
    }
  );
}

/**
 * Verify a ProofPix access token. Strict audience check — a regular SF
 * user JWT (no aud or different aud) fails here, even though it's signed
 * with the same secret.
 *
 * Returns { ok: true, userId, connectionId } or
 *         { ok: false, reason: 'expired' | 'invalid' | 'wrong_audience' | 'malformed' }.
 */
function verifyAccessToken(jwtSecret, token) {
  if (!jwtSecret) throw new Error('verifyAccessToken: jwtSecret required');
  if (typeof token !== 'string' || token.length === 0) {
    return { ok: false, reason: 'malformed' };
  }
  try {
    const payload = jwt.verify(token, jwtSecret, {
      audience: ACCESS_TOKEN_AUDIENCE,
    });
    if (!payload || typeof payload !== 'object') {
      return { ok: false, reason: 'invalid' };
    }
    const userId = payload.userId;
    const connectionId = payload.cid;
    if (!Number.isFinite(Number(userId)) || !Number.isFinite(Number(connectionId))) {
      return { ok: false, reason: 'invalid' };
    }
    return {
      ok: true,
      userId: Number(userId),
      connectionId: Number(connectionId),
    };
  } catch (err) {
    if (err && err.name === 'TokenExpiredError') return { ok: false, reason: 'expired' };
    if (err && err.name === 'JsonWebTokenError' && /audience/i.test(err.message || '')) {
      return { ok: false, reason: 'wrong_audience' };
    }
    return { ok: false, reason: 'invalid' };
  }
}

module.exports = {
  // codes
  newConnectCode,
  normalizeConnectCode,
  CODE_TTL_MS,
  // tokens (deep-link / same-device pairing)
  newConnectToken,
  isConnectToken,
  CONNECT_TOKEN_TTL_MS,
  // refresh
  newRefreshToken,
  hashRefreshToken,
  REFRESH_PREFIX,
  // access
  signAccessToken,
  verifyAccessToken,
  ACCESS_TOKEN_AUDIENCE,
  ACCESS_TOKEN_TTL_SEC,
};
