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
