/**
 * ProofPix Integration Module (Loosely Coupled) — PR 1 (Handshake).
 *
 * Mount: app.use('/api/integrations/proofpix', require('./proofpix-service')(supabase, logger))
 * Remove: delete this file + remove the line above = zero breakage.
 *
 * PR 1 scope: handshake only.
 *   - POST /connect/code/issue            (SF user JWT)
 *   - POST /connect/code/redeem           (no auth — code is the credential)
 *   - POST /connect/refresh               (no auth — refresh token is the credential)
 *   - GET  /connection/status             (ProofPix access token)
 *   - DELETE /connection                  (ProofPix access token; idempotent)
 *
 * Every route is gated behind FLAGS.PROOFPIX_INTEGRATION_ENABLED. When the
 * flag is OFF the namespace returns 404 — the integration is invisible
 * until ProofPix-native is wired up against staging.
 *
 * Workspace mapping: workspace_id = SF users.id (1:1). workspace_name
 * resolves to users.business_name, falling back to users.email if the
 * business name is null/empty. SF has no separate company abstraction.
 *
 * Photo storage table = customer_files (lands in PR 3). Not used here.
 */

const express = require('express');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');

const { FLAGS, isEnabled } = require('./lib/feature-flags');
const {
  newConnectCode,
  normalizeConnectCode,
  CODE_TTL_MS,
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
    const code = newConnectCode();
    const expiresAt = new Date(Date.now() + CODE_TTL_MS).toISOString();

    const { error } = await supabase
      .from('proofpix_connect_codes')
      .insert({ code, user_id: userId, expires_at: expiresAt });

    if (error) {
      // Collision on the PK is astronomically unlikely with 80-bit
      // codes, but if it happens we'd rather surface than silently retry.
      log.error('[ProofPix] code insert failed:', error.message);
      return res.status(500).json(errBody('INTERNAL', 'Failed to issue code.'));
    }

    log.log(`[ProofPix] issued connect code for user ${userId}`);
    return res.status(200).json({
      code,
      expires_in: Math.floor(CODE_TTL_MS / 1000),
    });
  });

  // ═════════════════════════════════════════════════════════════════
  // POST /connect/code/redeem
  //   ProofPix mobile app exchanges the pasted code for a refresh
  //   token + access token. Single-use; subsequent calls with the same
  //   code return INVALID_CODE.
  // ═════════════════════════════════════════════════════════════════
  router.post('/connect/code/redeem', exchangeLimiter, async (req, res) => {
    const codeInput = req.body && req.body.code;
    const deviceLabel = req.body && req.body.device_label;
    const normalized = normalizeConnectCode(codeInput);
    if (!normalized) {
      return res.status(400).json(errBody('INVALID_PAYLOAD', 'Missing or malformed code.'));
    }

    const { data: row, error } = await supabase
      .from('proofpix_connect_codes')
      .select('code, user_id, expires_at, redeemed_at')
      .eq('code', normalized)
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
    // .eq('redeemed_at', null) guard turns this into a CAS — concurrent
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
      .eq('code', normalized)
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
    // stored.
    const refreshToken = newRefreshToken();
    const refreshHash = hashRefreshToken(refreshToken);
    const { data: connRow, error: connErr } = await supabase
      .from('proofpix_connections')
      .insert({
        user_id: row.user_id,
        refresh_token_hash: refreshHash,
        device_label: labelToStore,
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

    log.log(`[ProofPix] redeemed code → conn ${connRow.id} for user ${row.user_id}`);
    return res.status(200).json({
      refresh_token: refreshToken,
      access_token: accessToken,
      expires_in: ACCESS_TOKEN_TTL_SEC,
      workspace_id: workspace.workspace_id,
      workspace_name: workspace.workspace_name,
      admin_user_id: workspace.admin_user_id,
    });
  });

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

    // Best-effort timestamp bump — failure to bump shouldn't fail the
    // refresh, since the token itself is still valid.
    supabase
      .from('proofpix_connections')
      .update({ last_used_at: new Date().toISOString() })
      .eq('id', conn.id)
      .then(({ error: e }) => { if (e) log.warn('[ProofPix] last_used_at bump failed:', e.message); });

    return res.status(200).json({
      access_token: accessToken,
      expires_in: ACCESS_TOKEN_TTL_SEC,
    });
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

  return router;
};
