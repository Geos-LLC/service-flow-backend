/**
 * ProofPix Integration Module (Loosely Coupled).
 *
 * Mount: app.use('/api/integrations/proofpix', require('./proofpix-service')(supabase, logger))
 * Remove: delete this file + remove the line above = zero breakage.
 *
 * PR 1 — handshake:
 *   - POST /connect/code/issue            (SF user JWT)
 *   - POST /connect/code/redeem           (no auth — code is the credential)
 *   - POST /connect/refresh               (no auth — refresh token is the credential)
 *   - GET  /connections                   (SF user JWT — lists caller's active devices)
 *   - DELETE /connections/:id             (SF user JWT — admin revoke of a specific device)
 *   - GET  /connection/status             (ProofPix access token)
 *   - DELETE /connection                  (ProofPix access token; idempotent)
 *
 * PR 2 — jobs list:
 *   - GET /jobs                           (ProofPix access token)
 *
 * PR 3 — photo upload:
 *   - POST /jobs/:jobId/photos            (ProofPix access token; multipart)
 *     Idempotent on metadata.proofpix_photo_id via the unique partial
 *     index on customer_files (migration 068). Retried mobile uploads
 *     return the existing crm_photo_id with HTTP 409 instead of
 *     creating duplicate rows.
 *
 * PR 4 — same-device pairing:
 *   - POST /connect/token/issue           (SF user JWT)
 *     Mints a base64url single-use token (60s TTL) for deep-link pairing.
 *   - GET  /connect/token/status?token=…  (token-as-capability, no auth)
 *     Pollable status probe for the SF web authorize page. Returns one
 *     of pending | redeemed | expired | unknown. 'unknown' collapses
 *     malformed-shape AND not-in-DB to prevent enumeration.
 *   - POST /connect/redeem                (no auth — credential in body)
 *     Canonical redeem. Accepts both 16-char codes AND base64url tokens
 *     via shape discrimination.
 *   - POST /connect/code/redeem           (kept as alias ≥30 days)
 *     Same handler as /connect/redeem so the live ProofPix-native
 *     adapter (still hitting the old path) keeps working.
 *   No dedupe on /redeem — multi-device pairing intentionally preserved
 *   from PR 1.
 *
 * Every route is gated behind FLAGS.PROOFPIX_INTEGRATION_ENABLED. When the
 * flag is OFF the namespace returns 404 — the integration is invisible
 * until ProofPix-native is wired up against staging.
 *
 * Workspace mapping: workspace_id = SF users.id (1:1). workspace_name
 * resolves to users.business_name, falling back to users.email if the
 * business name is null/empty. SF has no separate company abstraction.
 *
 * Photo storage table = customer_files. The Files tab on /customer/:id
 * already reads it, so ProofPix uploads with a linked customer auto-
 * appear there. ProofPix-source rows carry source='proofpix' +
 * proofpix_photo_id + proofpix_metadata for traceability.
 */

const express = require('express');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const crypto = require('crypto');
const path = require('path');
const jwt = require('jsonwebtoken');

const { BUCKETS } = require('./supabase-storage');
const { FLAGS, isEnabled } = require('./lib/feature-flags');
const {
  newConnectCode,
  normalizeConnectCode,
  CODE_TTL_MS,
  newConnectToken,
  isConnectToken,
  CONNECT_TOKEN_TTL_MS,
  newRefreshToken,
  hashRefreshToken,
  signAccessToken,
  verifyAccessToken,
  ACCESS_TOKEN_TTL_SEC,
} = require('./lib/proofpix-tokens');

// ─────────────────────────────────────────────────────────────────────
// Error envelope (matches the integration spec)
// ─────────────────────────────────────────────────────────────────────

function errBody(code, message, { retryable = false, retryAfterSeconds = null } = {}) {
  return {
    error: {
      code,
      message,
      retryable,
      retry_after_seconds: retryAfterSeconds,
    },
  };
}

module.exports = (supabase, logger) => {
  const router = express.Router();
  const log = logger || console;

  const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key';

  // ─────────────────────────────────────────────────────────────────
  // Flag gate — first middleware. If the flag is off the entire
  // namespace 404s, so the surface is invisible to clients and
  // scanners until we flip it on.
  // ─────────────────────────────────────────────────────────────────
  router.use((req, res, next) => {
    if (!isEnabled(FLAGS.PROOFPIX_INTEGRATION_ENABLED)) {
      return res.status(404).end();
    }
    next();
  });

  // ─────────────────────────────────────────────────────────────────
  // Tighter rate limit on credential-exchange routes. Slows down
  // code-guessing + refresh-token-guessing. Mounted per route below.
  // ─────────────────────────────────────────────────────────────────
  const exchangeLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 5,
    message: errBody(
      'RATE_LIMITED',
      'Too many credential exchange requests.',
      { retryable: true, retryAfterSeconds: 60 }
    ),
    standardHeaders: true,
    legacyHeaders: false,
  });

  // ─────────────────────────────────────────────────────────────────
  // Auth: SF user JWT (for code issuance)
  // ─────────────────────────────────────────────────────────────────
  function requireSfUserJwt(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) {
      return res.status(401).json(errBody('INVALID_TOKEN', 'Missing Authorization bearer token.'));
    }
    let decoded;
    try {
      decoded = jwt.verify(token, JWT_SECRET);
    } catch {
      return res.status(401).json(errBody('INVALID_TOKEN', 'Invalid or expired SF token.'));
    }
    // A ProofPix access token must NOT be usable here — it has aud='proofpix'
    // which a plain jwt.verify() (no audience option) still accepts, so we
    // additionally reject any token that carries the proofpix audience.
    if (decoded && decoded.aud === 'proofpix') {
      return res.status(401).json(errBody('INVALID_TOKEN', 'ProofPix access token not valid for this endpoint.'));
    }
    const userId = decoded && (decoded.userId ?? decoded.id);
    if (userId == null) {
      return res.status(401).json(errBody('INVALID_TOKEN', 'Token missing user id.'));
    }
    req.sfUserId = Number(userId);
    // teamMemberId is present on JWTs issued to team members (the
    // JWT's userId is still the workspace owner's id; teamMemberId
    // is the row in team_members that identifies WHICH member is
    // signed in). Absent on account-owner JWTs. Downstream code uses
    // this to attribute pair rows and to gate cross-member ops.
    const rawMemberId = decoded && (decoded.teamMemberId ?? decoded.team_member_id);
    req.sfTeamMemberId = rawMemberId != null && Number.isFinite(Number(rawMemberId))
      ? Number(rawMemberId)
      : null;
    next();
  }

  // ─────────────────────────────────────────────────────────────────
  // Auth: ProofPix access token (for connection/status + DELETE)
  // ─────────────────────────────────────────────────────────────────
  async function requireProofpixAccessToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) {
      return res.status(401).json(errBody('INVALID_TOKEN', 'Missing Authorization bearer token.'));
    }
    const result = verifyAccessToken(JWT_SECRET, token);
    if (!result.ok) {
      const msg = result.reason === 'expired'
        ? 'Access token expired — refresh required.'
        : 'Invalid access token.';
      return res.status(401).json(errBody('INVALID_TOKEN', msg));
    }
    // Connection must still be active (not revoked, not deleted).
    const { data: conn, error } = await supabase
      .from('proofpix_connections')
      .select('id, user_id, revoked_at')
      .eq('id', result.connectionId)
      .eq('user_id', result.userId)
      .maybeSingle();
    if (error) {
      log.error('[ProofPix] connection lookup failed:', error.message);
      return res.status(500).json(errBody('INTERNAL', 'Connection lookup failed.'));
    }
    if (!conn || conn.revoked_at) {
      return res.status(401).json(errBody('INVALID_TOKEN', 'Connection revoked.'));
    }
    req.proofpix = { userId: result.userId, connectionId: result.connectionId };
    next();
  }

  // ─────────────────────────────────────────────────────────────────
  // Workspace name resolver — business_name → email.
  // ─────────────────────────────────────────────────────────────────
  async function resolveWorkspace(userId) {
    const { data: user, error } = await supabase
      .from('users')
      .select('id, business_name, email')
      .eq('id', userId)
      .maybeSingle();
    if (error || !user) return null;
    const name = (user.business_name && String(user.business_name).trim()) || user.email || `Workspace ${user.id}`;
    return { workspace_id: String(user.id), workspace_name: name, admin_user_id: String(user.id) };
  }

  // ═════════════════════════════════════════════════════════════════
  // POST /connect/code/issue
  //   SF web UI calls this on behalf of an authenticated admin to mint
  //   a fresh code. The admin then pastes the code into the ProofPix
  //   mobile app's connect screen.
  // ═════════════════════════════════════════════════════════════════
  router.post('/connect/code/issue', requireSfUserJwt, async (req, res) => {
    const userId = req.sfUserId;
    const teamMemberId = req.sfTeamMemberId;
    const code = newConnectCode();
    const expiresAt = new Date(Date.now() + CODE_TTL_MS).toISOString();

    const { error } = await supabase
      .from('proofpix_connect_codes')
      .insert({
        code,
        user_id: userId,
        team_member_id: teamMemberId,
        expires_at: expiresAt,
      });

    if (error) {
      // Collision on the PK is astronomically unlikely with 80-bit
      // codes, but if it happens we'd rather surface than silently retry.
      log.error('[ProofPix] code insert failed:', error.message);
      return res.status(500).json(errBody('INTERNAL', 'Failed to issue code.'));
    }

    log.log(`[ProofPix] issued connect code for user ${userId} tm=${teamMemberId ?? '-'}`);
    return res.status(200).json({
      code,
      expires_in: Math.floor(CODE_TTL_MS / 1000),
    });
  });

  // ═════════════════════════════════════════════════════════════════
  // POST /connect/token/issue
  //   Mints a base64url single-use token for the same-device deep-link
  //   flow. SF web/PWA's authorize page calls this on behalf of the
  //   authenticated SF user, then redirects to proofpix://connect?token=...
  //   The ProofPix deep-link handler immediately POSTs to /connect/redeem.
  //
  //   60-second TTL — much shorter than the 16-char code (which is
  //   typed by hand) because the deep-link flow consumes it instantly.
  // ═════════════════════════════════════════════════════════════════
  router.post('/connect/token/issue', requireSfUserJwt, async (req, res) => {
    const userId = req.sfUserId;
    const teamMemberId = req.sfTeamMemberId;
    const token = newConnectToken();
    const expiresAt = new Date(Date.now() + CONNECT_TOKEN_TTL_MS).toISOString();

    const { error } = await supabase
      .from('proofpix_connect_codes')
      .insert({
        code: token,
        user_id: userId,
        team_member_id: teamMemberId,
        expires_at: expiresAt,
      });

    if (error) {
      log.error('[ProofPix] token insert failed:', error.message);
      return res.status(500).json(errBody('INTERNAL', 'Failed to issue token.'));
    }

    log.log(`[ProofPix] issued connect token for user ${userId} tm=${teamMemberId ?? '-'}`);
    return res.status(200).json({
      token,
      expires_in: Math.floor(CONNECT_TOKEN_TTL_MS / 1000),
    });
  });

  // ═════════════════════════════════════════════════════════════════
  // GET /connect/token/status?token=<token>
  //   Token-scoped polling endpoint for the SF web authorize page.
  //   The token itself is the capability — knowing it already unlocks
  //   redemption via /connect/redeem, so exposing status is strictly
  //   less powerful than what the caller already has.
  //
  //   Response: { status: 'pending' | 'redeemed' | 'expired' | 'unknown' }
  //
  //   'unknown' collapses both "malformed shape" and "not in DB" so a
  //   token-enumerator can't distinguish "never existed" from "expired
  //   long ago" (matches the OAuth device-flow convention).
  //
  //   Rate limit is looser than the credential-exchange limiter (30/min
  //   vs 5/min) because the desktop polls this every ~4s. Still tight
  //   enough that a wide sweep is expensive.
  // ═════════════════════════════════════════════════════════════════
  const statusPollLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    message: errBody(
      'RATE_LIMITED',
      'Too many status polls.',
      { retryable: true, retryAfterSeconds: 60 }
    ),
    standardHeaders: true,
    legacyHeaders: false,
  });

  router.get('/connect/token/status', statusPollLimiter, async (req, res) => {
    const token = req.query.token;
    if (!isConnectToken(token)) {
      return res.status(200).json({ status: 'unknown' });
    }
    const { data: row, error } = await supabase
      .from('proofpix_connect_codes')
      .select('code, redeemed_at, expires_at')
      .eq('code', token)
      .maybeSingle();
    if (error) {
      log.error('[ProofPix] token status lookup failed:', error.message);
      return res.status(500).json(errBody('INTERNAL', 'Status lookup failed.'));
    }
    if (!row) {
      return res.status(200).json({ status: 'unknown' });
    }
    if (row.redeemed_at) {
      return res.status(200).json({ status: 'redeemed' });
    }
    if (new Date(row.expires_at).getTime() <= Date.now()) {
      return res.status(200).json({ status: 'expired' });
    }
    return res.status(200).json({ status: 'pending' });
  });

  // ═════════════════════════════════════════════════════════════════
  // Shared redeem handler — accepts either a 16-char typed code or a
  // base64url deep-link token. Discriminates by shape:
  //   - normalizeConnectCode() returns non-null  → typed code path
  //   - isConnectToken()                          → deep-link token path
  //   - neither                                    → 400 INVALID_PAYLOAD
  //
  // Mounted on both POST /connect/redeem (canonical) and
  // POST /connect/code/redeem (kept ≥30 days for the existing
  // ProofPix-native adapter; same handler, no behavior diff).
  // ═════════════════════════════════════════════════════════════════
  // Trim + hard-cap a display-only string. Length cap matches the
  // existing device_label sanitizer so all display fields land in the
  // DB with the same guarantees.
  function sanitizeDisplayField(value, maxLen = 200) {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    return trimmed.slice(0, maxLen);
  }

  async function handleRedeem(req, res) {
    const input = req.body && req.body.code;
    const deviceLabel = req.body && req.body.device_label;
    // Optional device metadata — ProofPix mobile client may include
    // these to populate the SF /settings/proofpix devices card. All
    // NULL-safe: if the mobile client hasn't been updated yet, the row
    // is still valid, just less descriptive.
    const deviceModel = sanitizeDisplayField(req.body && req.body.device_model);
    const osName     = sanitizeDisplayField(req.body && req.body.os_name, 40);
    const osVersion  = sanitizeDisplayField(req.body && req.body.os_version, 40);
    const role       = sanitizeDisplayField(req.body && req.body.role, 40);
    // req.ip is trust-proxy-safe (server.js:691 sets 'trust proxy', 1).
    // Truncate to 64 chars to match the pattern in lib/admin-auth.js.
    const clientIp = ((req.ip || req.headers['x-forwarded-for'] || '') + '').slice(0, 64) || null;

    if (typeof input !== 'string' || !input.trim()) {
      return res.status(400).json(errBody('INVALID_PAYLOAD', 'Missing or malformed code.'));
    }

    // Shape discrimination. Try the typed-code normalizer first because
    // it's stricter (alphabet, length, group structure all enforced).
    // Falling through to the token check means we never confuse a
    // malformed code with a too-short token.
    const normalized = normalizeConnectCode(input);
    let lookupKey;
    if (normalized) {
      lookupKey = normalized;
    } else if (isConnectToken(input)) {
      lookupKey = input;
    } else {
      return res.status(400).json(errBody('INVALID_PAYLOAD', 'Missing or malformed code.'));
    }

    const { data: row, error } = await supabase
      .from('proofpix_connect_codes')
      .select('code, user_id, team_member_id, expires_at, redeemed_at')
      .eq('code', lookupKey)
      .maybeSingle();

    if (error) {
      log.error('[ProofPix] code lookup failed:', error.message);
      return res.status(500).json(errBody('INTERNAL', 'Code lookup failed.'));
    }
    if (!row) {
      return res.status(400).json(errBody('INVALID_CODE', 'Code is not recognized.'));
    }
    if (row.redeemed_at) {
      return res.status(400).json(errBody('INVALID_CODE', 'Code has already been redeemed.'));
    }
    if (new Date(row.expires_at).getTime() <= Date.now()) {
      return res.status(400).json(errBody('CODE_EXPIRED', 'Code has expired — issue a new one.'));
    }

    // Mark the code redeemed BEFORE issuing the refresh token. The
    // .is('redeemed_at', null) guard turns this into a CAS — concurrent
    // /redeem calls with the same code race here, and the loser gets 0
    // rows back.
    const labelToStore = typeof deviceLabel === 'string' && deviceLabel.trim()
      ? deviceLabel.trim().slice(0, 200)
      : null;
    const { data: claimed, error: claimErr } = await supabase
      .from('proofpix_connect_codes')
      .update({
        redeemed_at: new Date().toISOString(),
        redeemed_by_label: labelToStore,
      })
      .eq('code', lookupKey)
      .is('redeemed_at', null)
      .select('code');
    if (claimErr) {
      log.error('[ProofPix] code claim failed:', claimErr.message);
      return res.status(500).json(errBody('INTERNAL', 'Code claim failed.'));
    }
    if (!claimed || claimed.length === 0) {
      // Lost the race — somebody else just claimed this code.
      return res.status(400).json(errBody('INVALID_CODE', 'Code has already been redeemed.'));
    }

    // Mint refresh token + insert connection row. Refresh token raw
    // value is returned ONCE and discarded — only the sha256 hash is
    // stored. No dedupe on prior connections (multi-device pairing
    // remains supported, per PR 1 design — see project memory).
    const refreshToken = newRefreshToken();
    const refreshHash = hashRefreshToken(refreshToken);
    const { data: connRow, error: connErr } = await supabase
      .from('proofpix_connections')
      .insert({
        user_id: row.user_id,
        // Attribution — pulled from the code row (which captured it
        // from the SF JWT at issue time). NULL for pairings issued
        // directly by the workspace owner.
        team_member_id: row.team_member_id,
        refresh_token_hash: refreshHash,
        device_label: labelToStore,
        device_model: deviceModel,
        os_name: osName,
        os_version: osVersion,
        role: role,
        paired_from_ip: clientIp,
        last_seen_ip: clientIp,
      })
      .select('id')
      .single();
    if (connErr || !connRow) {
      log.error('[ProofPix] connection insert failed:', connErr && connErr.message);
      return res.status(500).json(errBody('INTERNAL', 'Failed to create connection.'));
    }

    const workspace = await resolveWorkspace(row.user_id);
    if (!workspace) {
      log.error(`[ProofPix] workspace lookup failed for user ${row.user_id}`);
      return res.status(500).json(errBody('INTERNAL', 'Workspace lookup failed.'));
    }

    const accessToken = signAccessToken(JWT_SECRET, {
      userId: row.user_id,
      connectionId: connRow.id,
    });

    log.log(`[ProofPix] redeemed → conn ${connRow.id} for user ${row.user_id}`);
    return res.status(200).json({
      refresh_token: refreshToken,
      access_token: accessToken,
      expires_in: ACCESS_TOKEN_TTL_SEC,
      workspace_id: workspace.workspace_id,
      workspace_name: workspace.workspace_name,
      admin_user_id: workspace.admin_user_id,
    });
  }

  // ═════════════════════════════════════════════════════════════════
  // POST /connect/redeem            (canonical, since PR 4)
  // POST /connect/code/redeem       (kept ≥30 days for the in-the-wild
  //                                  ProofPix-native adapter; same
  //                                  handler, same accepted formats)
  // ═════════════════════════════════════════════════════════════════
  router.post('/connect/redeem',      exchangeLimiter, handleRedeem);
  router.post('/connect/code/redeem', exchangeLimiter, handleRedeem);

  // ═════════════════════════════════════════════════════════════════
  // POST /connect/refresh
  //   Exchange a refresh token for a fresh access token. Refresh
  //   tokens are NOT rotated — same token can be used until revoke.
  // ═════════════════════════════════════════════════════════════════
  router.post('/connect/refresh', exchangeLimiter, async (req, res) => {
    const refreshToken = req.body && req.body.refresh_token;
    if (typeof refreshToken !== 'string' || !refreshToken) {
      return res.status(400).json(errBody('INVALID_PAYLOAD', 'Missing refresh_token.'));
    }
    const hash = hashRefreshToken(refreshToken);
    const { data: conn, error } = await supabase
      .from('proofpix_connections')
      .select('id, user_id, revoked_at')
      .eq('refresh_token_hash', hash)
      .maybeSingle();
    if (error) {
      log.error('[ProofPix] refresh lookup failed:', error.message);
      return res.status(500).json(errBody('INTERNAL', 'Refresh lookup failed.'));
    }
    if (!conn || conn.revoked_at) {
      return res.status(401).json(errBody('INVALID_TOKEN', 'Refresh token is not valid.'));
    }

    const accessToken = signAccessToken(JWT_SECRET, {
      userId: conn.user_id,
      connectionId: conn.id,
    });

    // Best-effort timestamp + IP bump — failure to bump shouldn't fail
    // the refresh, since the token itself is still valid. IP is
    // captured server-side (trust-proxy honored via server.js:691), so
    // even devices whose mobile client never sent metadata at
    // /connect/redeem will accumulate a last_seen_ip after their first
    // refresh call.
    const refreshIp = ((req.ip || req.headers['x-forwarded-for'] || '') + '').slice(0, 64) || null;
    supabase
      .from('proofpix_connections')
      .update({
        last_used_at: new Date().toISOString(),
        last_seen_ip: refreshIp,
      })
      .eq('id', conn.id)
      .then(({ error: e }) => { if (e) log.warn('[ProofPix] last_used_at bump failed:', e.message); });

    return res.status(200).json({
      access_token: accessToken,
      expires_in: ACCESS_TOKEN_TTL_SEC,
    });
  });

  // ═════════════════════════════════════════════════════════════════
  // GET /connections
  //   SF-side list of the calling user's active ProofPix devices.
  //   Used by /settings/proofpix to render "these devices are paired"
  //   so the admin gets a visible confirmation after the QR flow
  //   redirects them back. Distinct from /connection/status (below)
  //   which is scoped to a single device via its access token.
  //
  //   Auth: SF user JWT — mirrors the same envelope as
  //   /connect/token/issue, so the settings page can reuse the
  //   Authorization: Bearer <sfJwt> header it already carries.
  //
  //   Revoked rows are filtered out (the partial index
  //   idx_proofpix_connections_user_active covers this exact query).
  //   Refresh token hash is never returned — only the audit fields.
  // ═════════════════════════════════════════════════════════════════
  router.get('/connections', requireSfUserJwt, async (req, res) => {
    // Scoping rule:
    //   • Workspace owner (no teamMemberId in JWT) sees EVERY active
    //     row for their workspace — their own devices plus every
    //     team member's device.
    //   • Team member sees ONLY rows attributed to their own
    //     team_members.id — cross-member visibility isn't part of
    //     their view.
    let query = supabase
      .from('proofpix_connections')
      .select('id, team_member_id, device_label, device_model, os_name, os_version, role, paired_from_ip, last_seen_ip, created_at, last_used_at')
      .eq('user_id', req.sfUserId)
      .is('revoked_at', null)
      .order('created_at', { ascending: false });
    if (req.sfTeamMemberId != null) {
      query = query.eq('team_member_id', req.sfTeamMemberId);
    }
    const { data, error } = await query;
    if (error) {
      log.error('[ProofPix] connections list failed:', error.message);
      return res.status(500).json(errBody('INTERNAL', 'Connection list failed.'));
    }
    const rows = data || [];

    // Batch-fetch team_member display fields for any attributed rows.
    // Two-step (not a PostgREST embed) so this stays trivially testable
    // against the fake Supabase and portable if we ever swap drivers.
    const memberIds = Array.from(new Set(rows.map((r) => r.team_member_id).filter((v) => v != null)));
    const memberMap = new Map();
    if (memberIds.length > 0) {
      const { data: memberRows, error: memberErr } = await supabase
        .from('team_members')
        .select('id, first_name, last_name, email, role')
        .in('id', memberIds);
      if (memberErr) {
        log.warn('[ProofPix] team_members lookup failed:', memberErr.message);
        // Fall through — attribution just becomes null on those rows.
      } else {
        (memberRows || []).forEach((m) => {
          memberMap.set(m.id, {
            id: m.id,
            first_name: m.first_name,
            last_name: m.last_name,
            email: m.email,
            role: m.role,
          });
        });
      }
    }

    return res.status(200).json({
      // viewer_is_owner tells the frontend which scoping applied.
      // Owner UI shows attribution chips per row; team-member UI
      // hides them (all rows are theirs by construction).
      viewer_is_owner: req.sfTeamMemberId == null,
      connections: rows.map((r) => ({
        id: r.id,
        team_member_id: r.team_member_id,
        team_member: r.team_member_id != null ? (memberMap.get(r.team_member_id) || null) : null,
        device_label: r.device_label,
        device_model: r.device_model,
        os_name: r.os_name,
        os_version: r.os_version,
        role: r.role,
        paired_from_ip: r.paired_from_ip,
        last_seen_ip: r.last_seen_ip,
        created_at: r.created_at,
        last_used_at: r.last_used_at,
      })),
    });
  });

  // ═════════════════════════════════════════════════════════════════
  // DELETE /connections/:id
  //   SF-side admin revoke — lets the SF /settings/proofpix page
  //   disconnect a specific device. Distinct from DELETE /connection
  //   (below) which is scoped to the calling device via its OWN
  //   access token; this one is authed by the SF user JWT and takes
  //   the connection id in the path so the admin can revoke any of
  //   their own devices from the web UI.
  //
  //   Ownership: the WHERE clause pins user_id to the calling JWT so
  //   even if an admin crafts a request with someone else's id, we
  //   won't touch it. Response distinguishes:
  //     - 204: revoked (or already revoked — idempotent)
  //     - 400: :id isn't a valid number
  //     - 404: no such connection under the calling user (either
  //            wrong id, or belongs to someone else — collapsed to
  //            not-found so we don't leak existence of foreign rows)
  // ═════════════════════════════════════════════════════════════════
  router.delete('/connections/:id', requireSfUserJwt, async (req, res) => {
    const rawId = req.params.id;
    const connectionId = Number.parseInt(rawId, 10);
    if (!Number.isFinite(connectionId) || connectionId <= 0 || String(connectionId) !== rawId) {
      return res.status(400).json(errBody('INVALID_PAYLOAD', 'Malformed connection id.'));
    }

    // Existence + ownership check BEFORE the update so we can return
    // 404 for rows that don't belong to the caller. Idempotent
    // revoke-of-already-revoked returns 204 (matches the existing
    // DELETE /connection semantics), so we intentionally don't filter
    // on revoked_at here.
    const { data: existing, error: lookupErr } = await supabase
      .from('proofpix_connections')
      .select('id, team_member_id, revoked_at')
      .eq('id', connectionId)
      .eq('user_id', req.sfUserId)
      .maybeSingle();
    if (lookupErr) {
      log.error('[ProofPix] connections revoke lookup failed:', lookupErr.message);
      return res.status(500).json(errBody('INTERNAL', 'Revoke lookup failed.'));
    }
    if (!existing) {
      return res.status(404).json(errBody('NOT_FOUND', 'Connection not found.'));
    }

    // Team-member gate: a team member can only revoke their OWN
    // pairs (same team_member_id). Cross-member and owner-owned
    // rows return 404 — same shape as "doesn't exist" so we don't
    // leak the existence of foreign rows via a distinct 403.
    // Owners (sfTeamMemberId == null) skip this and can revoke any
    // row in their workspace.
    if (req.sfTeamMemberId != null && existing.team_member_id !== req.sfTeamMemberId) {
      return res.status(404).json(errBody('NOT_FOUND', 'Connection not found.'));
    }

    if (existing.revoked_at) {
      // Already revoked — idempotent success.
      return res.status(204).end();
    }

    const { error: updateErr } = await supabase
      .from('proofpix_connections')
      .update({ revoked_at: new Date().toISOString() })
      .eq('id', connectionId)
      .eq('user_id', req.sfUserId)
      .is('revoked_at', null);
    if (updateErr) {
      log.error('[ProofPix] connections revoke failed:', updateErr.message);
      return res.status(500).json(errBody('INTERNAL', 'Revoke failed.'));
    }
    log.log(`[ProofPix] admin revoked conn ${connectionId} for user ${req.sfUserId} tm=${req.sfTeamMemberId ?? '-'}`);
    return res.status(204).end();
  });

  // ═════════════════════════════════════════════════════════════════
  // GET /connection/status
  //   Cheap probe ProofPix-native uses to test "is this admin still
  //   connected" without making a real upload.
  // ═════════════════════════════════════════════════════════════════
  router.get('/connection/status', requireProofpixAccessToken, async (req, res) => {
    const workspace = await resolveWorkspace(req.proofpix.userId);
    if (!workspace) {
      return res.status(500).json(errBody('INTERNAL', 'Workspace lookup failed.'));
    }
    return res.status(200).json({
      valid: true,
      workspace_id: workspace.workspace_id,
      workspace_name: workspace.workspace_name,
    });
  });

  // ═════════════════════════════════════════════════════════════════
  // DELETE /connection
  //   Revokes the calling connection. Idempotent — re-calling against
  //   a revoked connection still 204s (caller's intent is satisfied).
  //   Other connections for the same user stay alive (admin's iPhone
  //   doesn't revoke admin's iPad).
  // ═════════════════════════════════════════════════════════════════
  router.delete('/connection', requireProofpixAccessToken, async (req, res) => {
    const { error } = await supabase
      .from('proofpix_connections')
      .update({ revoked_at: new Date().toISOString() })
      .eq('id', req.proofpix.connectionId)
      .is('revoked_at', null);
    if (error) {
      log.error('[ProofPix] revoke failed:', error.message);
      return res.status(500).json(errBody('INTERNAL', 'Revoke failed.'));
    }
    log.log(`[ProofPix] revoked conn ${req.proofpix.connectionId} for user ${req.proofpix.userId}`);
    return res.status(204).end();
  });

  // ═════════════════════════════════════════════════════════════════
  // GET /jobs?status=&search=&limit=&cursor=
  //   Returns the job picker list for ProofPix-native. Cursor-based
  //   pagination ordered by (scheduled_date DESC, id DESC).
  // ═════════════════════════════════════════════════════════════════

  // SF's job_status enum has 12 values; the ProofPix picker only cares
  // about 4 buckets. Two maps:
  //   STATUS_BUCKET   — for the response field (per-job).
  //   ACTIVE_FILTER   — the SF statuses that satisfy ?status=active.
  // `paid` is bucketed under `completed` because it's a downstream
  // step of completion (Stripe payment recorded) — visually the job
  // is done from the cleaner's perspective.
  const STATUS_BUCKETS = {
    completed: 'completed',
    complete:  'completed',
    paid:      'completed',
    cancelled: 'cancelled',
    scheduled: 'scheduled',
  };
  function bucketStatus(sfStatus) {
    return STATUS_BUCKETS[sfStatus] || 'active';
  }
  const ACTIVE_SF_STATUSES = [
    'pending', 'confirmed', 'in-progress', 'en-route',
    'started', 'late', 'rescheduled',
  ];

  function joinAddress(j) {
    const parts = [
      j.service_address_street,
      j.service_address_city,
      [j.service_address_state, j.service_address_zip].filter(Boolean).join(' '),
    ].map((s) => (s == null ? '' : String(s).trim())).filter(Boolean);
    return parts.length ? parts.join(', ') : null;
  }

  function scheduledAtMs(j) {
    if (!j.scheduled_date) return null;
    // scheduled_date is `text NOT NULL` in the schema, but the live data
    // is mixed — some rows are 'YYYY-MM-DD' and others 'YYYY-MM-DD HH:MM:SS'
    // (ZB sync historically wrote the latter). Take the date prefix and
    // re-attach scheduled_time so we always get an unambiguous local
    // timestamp string Date.parse can handle.
    const dateOnly = String(j.scheduled_date).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateOnly)) return null;
    const time = j.scheduled_time || '09:00:00';
    const ms = Date.parse(`${dateOnly}T${time}`);
    return Number.isFinite(ms) ? ms : null;
  }

  function customerName(c) {
    if (!c) return null;
    const name = [c.first_name, c.last_name].filter(Boolean).map((s) => String(s).trim()).filter(Boolean).join(' ');
    return name || null;
  }

  function encodeCursor(row) {
    return Buffer.from(JSON.stringify({ d: row.scheduled_date, i: row.id })).toString('base64url');
  }
  function decodeCursor(input) {
    if (!input) return null;
    try {
      const parsed = JSON.parse(Buffer.from(String(input), 'base64url').toString('utf8'));
      if (typeof parsed.d !== 'string' || !Number.isFinite(Number(parsed.i))) return null;
      return { d: parsed.d, i: Number(parsed.i) };
    } catch {
      return null;
    }
  }

  router.get('/jobs', requireProofpixAccessToken, async (req, res) => {
    const userId = req.proofpix.userId;

    // ── Parse + validate query params ───────────────────────────────
    const statusParam = (typeof req.query.status === 'string' && req.query.status)
      ? req.query.status
      : 'active';
    if (!['active', 'all', 'completed', 'cancelled', 'scheduled'].includes(statusParam)) {
      return res.status(400).json(errBody('INVALID_PAYLOAD', 'Unknown status filter.'));
    }

    const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
    const requestedLimit = parseInt(req.query.limit, 10);
    const limit = Number.isFinite(requestedLimit) && requestedLimit > 0
      ? Math.min(requestedLimit, 100)
      : 50;
    const cursor = decodeCursor(req.query.cursor);
    if (req.query.cursor && !cursor) {
      return res.status(400).json(errBody('INVALID_PAYLOAD', 'Malformed cursor.'));
    }

    // ── Resolve search → customer_ids (same two-step the existing
    //    GET /api/jobs route uses) ─────────────────────────────────
    let searchCustomerIds = null;
    if (search) {
      const escaped = search.replace(/[%_\\]/g, '\\$&');
      const tokens = search.split(/\s+/).filter(Boolean);
      let custQ = supabase.from('customers').select('id').eq('user_id', userId);
      if (tokens.length > 1) {
        const first = tokens[0].replace(/[%_\\]/g, '\\$&');
        const rest  = tokens.slice(1).join(' ').replace(/[%_\\]/g, '\\$&');
        custQ = custQ.or(
          `and(first_name.ilike.%${first}%,last_name.ilike.%${rest}%),` +
          `and(first_name.ilike.%${rest}%,last_name.ilike.%${first}%)`
        );
      } else {
        custQ = custQ.or(`first_name.ilike.%${escaped}%,last_name.ilike.%${escaped}%`);
      }
      const { data: matched, error: custErr } = await custQ;
      if (custErr) {
        log.error('[ProofPix] /jobs customer search failed:', custErr.message);
        return res.status(500).json(errBody('INTERNAL', 'Search failed.'));
      }
      searchCustomerIds = (matched || []).map((c) => c.id);
    }

    // ── Build the jobs query ────────────────────────────────────────
    let query = supabase
      .from('jobs')
      .select(`
        id, status, service_name,
        scheduled_date, scheduled_time, created_at,
        service_address_street, service_address_city,
        service_address_state, service_address_zip,
        customers!left ( first_name, last_name )
      `)
      .eq('user_id', userId)
      .order('scheduled_date', { ascending: false })
      .order('id', { ascending: false })
      .limit(limit + 1);   // +1 = peek for next page

    // Status filter
    if (statusParam === 'active') {
      query = query.in('status', ACTIVE_SF_STATUSES);
    } else if (statusParam === 'completed') {
      query = query.in('status', ['completed', 'complete', 'paid']);
    } else if (statusParam === 'cancelled') {
      query = query.eq('status', 'cancelled');
    } else if (statusParam === 'scheduled') {
      query = query.eq('status', 'scheduled');
    }
    // 'all' → no filter.

    // Search filter
    if (search) {
      const escaped = search.replace(/[%_\\]/g, '\\$&');
      const ors = [`service_name.ilike.%${escaped}%`];
      if (searchCustomerIds && searchCustomerIds.length > 0) {
        ors.push(`customer_id.in.(${searchCustomerIds.join(',')})`);
      }
      // Numeric search → job id
      const numeric = search.replace(/^#/, '');
      if (/^\d+$/.test(numeric)) {
        const n = Number(numeric);
        if (Number.isSafeInteger(n) && n > 0 && n <= 2147483647) ors.push(`id.eq.${n}`);
      }
      query = query.or(ors.join(','));
    }

    // Cursor: tuple-less-than on (scheduled_date, id)
    if (cursor) {
      query = query.or(
        `scheduled_date.lt.${cursor.d},` +
        `and(scheduled_date.eq.${cursor.d},id.lt.${cursor.i})`
      );
    }

    const { data: rows, error } = await query;
    if (error) {
      log.error('[ProofPix] /jobs query failed:', error.message);
      return res.status(500).json(errBody('INTERNAL', 'Job query failed.'));
    }

    // ── Detect "more pages": we fetched limit+1; if we got back all
    //    limit+1, drop the extra and emit a cursor pointing at the LAST
    //    item we're returning. ─────────────────────────────────────
    const pageRows = (rows || []).slice(0, limit);
    const hasMore  = (rows || []).length > limit;
    const nextCursor = hasMore ? encodeCursor(pageRows[pageRows.length - 1]) : null;

    // ── Photo counts via the SQL helper (single round-trip, dodges
    //    1000-row default limit on customer_files.) ────────────────
    const jobIds = pageRows.map((r) => r.id);
    const countsByJobId = {};
    if (jobIds.length > 0) {
      const { data: counts, error: countErr } = await supabase
        .rpc('proofpix_job_photo_counts', { p_user_id: userId, p_job_ids: jobIds });
      if (countErr) {
        // Non-fatal: log + fall back to zero counts so the picker still
        // works. ProofPix renders "0 photos" rather than blowing up the
        // whole list when the helper is unavailable.
        log.warn('[ProofPix] proofpix_job_photo_counts rpc failed:', countErr.message);
      } else {
        for (const row of counts || []) {
          countsByJobId[row.job_id] = Number(row.photo_count) || 0;
        }
      }
    }

    // ── Shape response ──────────────────────────────────────────────
    const jobs = pageRows.map((j) => ({
      id: String(j.id),
      title: j.service_name && String(j.service_name).trim()
        ? String(j.service_name).trim()
        : `Job #${j.id}`,
      customer_name: customerName(j.customers),
      address: joinAddress(j),
      status: bucketStatus(j.status),
      scheduled_at: scheduledAtMs(j),
      photo_count: countsByJobId[j.id] || 0,
    }));

    return res.status(200).json({ jobs, next_cursor: nextCursor });
  });

  // ═════════════════════════════════════════════════════════════════
  // POST /jobs/:jobId/photos
  //   Multipart upload from ProofPix-native (via the Railway proxy).
  //   Body: `file` (binary) + `metadata` (JSON string).
  //
  //   Idempotent on metadata.proofpix_photo_id — retried mobile
  //   uploads find the existing row via the unique partial index and
  //   return 409 with the existing crm_photo_id, NOT a duplicate row.
  // ═════════════════════════════════════════════════════════════════

  const PHOTO_BUCKET = BUCKETS.PROOFPIX_PHOTOS;
  const PHOTO_SIZE_LIMIT = 20 * 1024 * 1024;
  const VALID_MIME_TYPES = new Set(['image/jpeg', 'image/png']);
  const VALID_MODES = new Set(['before', 'after', 'progress', 'combined']);

  const proofpixUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: PHOTO_SIZE_LIMIT, files: 1 },
    fileFilter(req, file, cb) {
      if (!VALID_MIME_TYPES.has(file.mimetype)) {
        const err = new Error('Only image/jpeg and image/png are accepted.');
        err.code = 'INVALID_MIME';
        return cb(err);
      }
      cb(null, true);
    },
  });

  // Wraps multer's middleware so we can map MulterError → spec error
  // envelope inline (default Express error path returns generic 500s).
  function runMulter(req, res, next) {
    proofpixUpload.single('file')(req, res, (err) => {
      if (!err) return next();
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json(errBody(
          'PAYLOAD_TOO_LARGE',
          `File exceeds the ${PHOTO_SIZE_LIMIT / (1024 * 1024)}MB limit.`
        ));
      }
      if (err.code === 'INVALID_MIME') {
        return res.status(400).json(errBody('INVALID_PAYLOAD', err.message));
      }
      log.error('[ProofPix] multer error:', err.message);
      return res.status(400).json(errBody('INVALID_PAYLOAD', err.message || 'Upload error.'));
    });
  }

  // 120 req/min per admin (per spec). Keyed on the authenticated
  // userId, so the limit follows the admin's identity across team
  // members uploading through the same proxy session.
  const photoUploadLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    keyGenerator: (req) => (req.proofpix && String(req.proofpix.userId)) || req.ip,
    standardHeaders: true,
    legacyHeaders: false,
    message: errBody(
      'RATE_LIMITED',
      'Upload rate limit exceeded for this workspace.',
      { retryable: true, retryAfterSeconds: 60 }
    ),
  });

  function parseMetadata(raw) {
    if (typeof raw !== 'string' || !raw.trim()) {
      return { ok: false, reason: 'metadata field is required (JSON string).' };
    }
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch { return { ok: false, reason: 'metadata is not valid JSON.' }; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, reason: 'metadata must be a JSON object.' };
    }

    const requiredStr = ['filename', 'room', 'proofpix_photo_id', 'proofpix_project_id'];
    for (const k of requiredStr) {
      if (typeof parsed[k] !== 'string' || !parsed[k].trim()) {
        return { ok: false, reason: `metadata.${k} is required.` };
      }
    }
    if (!VALID_MODES.has(parsed.mode)) {
      return { ok: false, reason: 'metadata.mode must be one of: before, after, progress, combined.' };
    }
    if (!Number.isFinite(Number(parsed.timestamp))) {
      return { ok: false, reason: 'metadata.timestamp must be a number (ms epoch).' };
    }
    // notes, gps, captured_by are all optional/permissive — kept verbatim
    return { ok: true, metadata: parsed };
  }

  function pickExtension(mimeType, filename) {
    if (mimeType === 'image/png') return '.png';
    if (mimeType === 'image/jpeg') return '.jpg';
    const fromName = path.extname(filename || '').toLowerCase();
    if (fromName === '.png' || fromName === '.jpg' || fromName === '.jpeg') return fromName;
    return '';
  }

  router.post('/jobs/:jobId/photos',
    requireProofpixAccessToken,
    photoUploadLimiter,
    runMulter,
    async (req, res) => {
      const userId = req.proofpix.userId;
      const jobId  = parseInt(req.params.jobId, 10);
      if (!Number.isFinite(jobId)) {
        return res.status(404).json(errBody('JOB_NOT_FOUND', 'Job not found.'));
      }
      if (!req.file) {
        return res.status(400).json(errBody('INVALID_PAYLOAD', 'file field is required.'));
      }

      const meta = parseMetadata(req.body && req.body.metadata);
      if (!meta.ok) {
        return res.status(400).json(errBody('INVALID_PAYLOAD', meta.reason));
      }

      // ── Verify the job belongs to this tenant ──────────────────
      const { data: job, error: jobErr } = await supabase
        .from('jobs')
        .select('id, user_id, customer_id')
        .eq('id', jobId)
        .eq('user_id', userId)
        .maybeSingle();
      if (jobErr) {
        log.error('[ProofPix] /photos job lookup failed:', jobErr.message);
        return res.status(500).json(errBody('INTERNAL', 'Job lookup failed.'));
      }
      if (!job) {
        return res.status(404).json(errBody('JOB_NOT_FOUND', 'Job not found.'));
      }

      // ── Pre-check dedup (cheap fast-path; the unique index is the
      //    actual race guard) ─────────────────────────────────────
      const existing = await supabase
        .from('customer_files')
        .select('id, file_url')
        .eq('user_id', userId)
        .eq('proofpix_photo_id', meta.metadata.proofpix_photo_id)
        .is('deleted_at', null)
        .maybeSingle();
      if (existing.error) {
        log.error('[ProofPix] dedup pre-check failed:', existing.error.message);
        return res.status(500).json(errBody('INTERNAL', 'Dedup check failed.'));
      }
      if (existing.data) {
        return res.status(409).json({
          success: true,
          crm_photo_id: String(existing.data.id),
          photo_url:    existing.data.file_url,
        });
      }

      // ── Upload to Supabase Storage ──────────────────────────────
      const ext = pickExtension(req.file.mimetype, meta.metadata.filename);
      const storagePath = `user-${userId}/job-${jobId}/${meta.metadata.proofpix_photo_id}${ext}`;
      const { error: uploadErr } = await supabase.storage
        .from(PHOTO_BUCKET)
        .upload(storagePath, req.file.buffer, {
          contentType: req.file.mimetype,
          upsert: false,
        });
      if (uploadErr) {
        log.error('[ProofPix] storage upload failed:', uploadErr.message);
        return res.status(500).json(errBody('INTERNAL', 'Storage upload failed.'));
      }
      const { data: urlData } = supabase.storage.from(PHOTO_BUCKET).getPublicUrl(storagePath);
      const fileUrl = urlData.publicUrl;

      // ── Insert customer_files row ───────────────────────────────
      const insertPayload = {
        user_id:           userId,
        customer_id:       job.customer_id || null,   // nullable as of migration 068
        job_id:            jobId,
        filename:          meta.metadata.filename,
        file_url:          fileUrl,
        mime_type:         req.file.mimetype,
        size_bytes:        req.file.size,
        uploaded_by:       userId,
        source:            'proofpix',
        proofpix_photo_id: meta.metadata.proofpix_photo_id,
        proofpix_metadata: meta.metadata,
      };
      const insertRes = await supabase
        .from('customer_files')
        .insert(insertPayload)
        .select('id, file_url')
        .single();

      if (insertRes.error) {
        // Unique-index race: another request just inserted with the same
        // (user_id, proofpix_photo_id). Re-fetch + return 409 (matches
        // the pre-check path). Postgres error code 23505 = unique
        // violation; postgrest surfaces it via error.code.
        const isUniqueViolation = insertRes.error.code === '23505'
          || /duplicate key/i.test(insertRes.error.message || '');
        if (isUniqueViolation) {
          const race = await supabase
            .from('customer_files')
            .select('id, file_url')
            .eq('user_id', userId)
            .eq('proofpix_photo_id', meta.metadata.proofpix_photo_id)
            .is('deleted_at', null)
            .maybeSingle();
          if (race.data) {
            // Clean up the orphan blob we just uploaded but won't reference.
            supabase.storage.from(PHOTO_BUCKET).remove([storagePath])
              .then(() => {}, (e) => log.warn('[ProofPix] orphan blob cleanup failed:', e && e.message));
            return res.status(409).json({
              success: true,
              crm_photo_id: String(race.data.id),
              photo_url:    race.data.file_url,
            });
          }
        }
        log.error('[ProofPix] customer_files insert failed:', insertRes.error.message);
        // Best-effort cleanup of the blob we just uploaded.
        supabase.storage.from(PHOTO_BUCKET).remove([storagePath])
          .then(() => {}, (e) => log.warn('[ProofPix] blob cleanup failed:', e && e.message));
        return res.status(500).json(errBody('INTERNAL', 'Photo record save failed.'));
      }

      log.log(`[ProofPix] photo attached: user=${userId} job=${jobId} photo_id=${insertRes.data.id}`);
      return res.status(200).json({
        success: true,
        crm_photo_id: String(insertRes.data.id),
        photo_url:    insertRes.data.file_url,
      });
    }
  );

  return router;
};
