'use strict';

/**
 * Identity Conflicts — operator endpoints.
 *
 * Backs the future "Settings → Data Integrity → Identity Conflicts"
 * UI page. All endpoints tenant-scoped by JWT user_id (per
 * feedback_per_route_auth_api_mount.md — auth applied PER ROUTE, never
 * via router.use(auth) on api-mounted modules).
 *
 * Mounted at /api/identity-conflicts (server.js).
 *
 * Endpoints:
 *   GET    /                — list open conflicts (paginated)
 *   GET    /summary         — metrics (cross_role_phone_count, etc.)
 *   GET    /per-day         — per-day series for the dashboard chart
 *   GET    /:id             — single conflict detail
 *   POST   /:id/resolve     — resolve with action: keep_separate | ignore
 *                             (merge / change_owner deferred to Phase 2)
 */

const express = require('express');
const {
  listConflicts,
  getConflict,
  resolveConflict,
  summary,
  newConflictsPerDay,
  PHASE_1_ACTIONS,
} = require('./lib/phone-identity-registry');

module.exports = (supabase, logger) => {
  const router = express.Router();

  // Per-route auth.
  const authenticateToken = async (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'No token provided' });
    try {
      const jwt = require('jsonwebtoken');
      const decoded = jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key');
      req.user = decoded;
      next();
    } catch (err) {
      return res.status(403).json({ error: 'Invalid or expired token' });
    }
  };

  // GET / — list open conflicts (with paging + optional filters).
  router.get('/', authenticateToken, async (req, res) => {
    const userId = req.user.userId;
    const { status, severity, limit, offset } = req.query;
    const result = await listConflicts(supabase, userId, {
      status: status || 'open',
      severity,
      limit: limit ? Number(limit) : 50,
      offset: offset ? Number(offset) : 0,
    });
    if (result.error) return res.status(400).json({ error: result.error });
    return res.json({ rows: result.rows, total: result.total });
  });

  // GET /summary — tenant-scoped metric counts.
  router.get('/summary', authenticateToken, async (req, res) => {
    const userId = req.user.userId;
    const windowDays = req.query.windowDays ? Number(req.query.windowDays) : 7;
    const result = await summary(supabase, userId, { windowDays });
    if (!result.ok) return res.status(500).json({ error: result.error || 'summary_failed' });
    return res.json(result);
  });

  // GET /per-day — series for ops dashboard chart.
  router.get('/per-day', authenticateToken, async (req, res) => {
    const userId = req.user.userId;
    const days = req.query.days ? Number(req.query.days) : 14;
    const result = await newConflictsPerDay(supabase, userId, days);
    if (!result.ok) return res.status(500).json({ error: result.error || 'per_day_failed' });
    return res.json(result);
  });

  // GET /:id — single conflict detail (for the row-detail panel).
  router.get('/:id', authenticateToken, async (req, res) => {
    const userId = req.user.userId;
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid_id' });
    const result = await getConflict(supabase, userId, id);
    if (result.error) return res.status(500).json({ error: result.error });
    if (!result.row) return res.status(404).json({ error: 'not_found' });
    return res.json({ conflict: result.row });
  });

  // POST /:id/resolve — Phase 1 actions only: keep_separate | ignore.
  router.post('/:id/resolve', authenticateToken, async (req, res) => {
    const userId = req.user.userId;
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid_id' });

    const { action, note } = req.body || {};
    if (!action || !PHASE_1_ACTIONS.includes(action)) {
      return res.status(400).json({
        error: 'unsupported_action',
        supported_actions: PHASE_1_ACTIONS,
        deferred_to_phase_2: ['merge', 'change_owner'],
      });
    }

    const result = await resolveConflict(supabase, logger, userId, id, action, {
      note,
      resolvedByUserId: userId,
    });
    if (!result.ok) {
      const status = result.error === 'not_found' ? 404
        : result.error === 'not_open' ? 409
        : 400;
      return res.status(status).json(result);
    }
    return res.json({ ok: true, conflict: result.conflict });
  });

  return router;
};
