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
  deleteOwner,
  combine,
  summary,
  newConflictsPerDay,
  PHASE_1_ACTIONS,
  COMBINE_SUPPORTED_TYPES,
  DELETE_SUPPORTED_TYPES,
} = require('./lib/phone-identity-registry');
const {
  attemptLeadToCustomerLink,
  applyLeadCustomerLink,
} = require('./lib/identity-linker');

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

  // POST /:id/delete-owner — delete one source entity row
  // body: { entity_type, entity_id }
  router.post('/:id/delete-owner', authenticateToken, async (req, res) => {
    const userId = req.user.userId;
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid_id' });

    const { entity_type, entity_id } = req.body || {};
    if (!entity_type || entity_id == null) {
      return res.status(400).json({ error: 'entity_type and entity_id required' });
    }

    const result = await deleteOwner(supabase, logger, userId, id, entity_type, entity_id);
    if (!result.ok) {
      const status = result.error === 'not_found' ? 404
        : result.error === 'owner_not_in_conflict' ? 409
        : result.error === 'source_delete_failed' ? 409
        : 400;
      return res.status(status).json(result);
    }
    return res.json(result);
  });

  // POST /:id/combine — same-type merge of secondaries into a primary
  // body: { primary: {entity_type, entity_id}, secondaries: [{entity_type, entity_id}, ...] }
  router.post('/:id/combine', authenticateToken, async (req, res) => {
    const userId = req.user.userId;
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid_id' });

    const { primary, secondaries } = req.body || {};
    if (!primary || !Array.isArray(secondaries)) {
      return res.status(400).json({ error: 'primary + secondaries required' });
    }

    const result = await combine(supabase, logger, userId, id, primary, secondaries);
    if (!result.ok) {
      const status = result.error === 'not_found' ? 404
        : result.error === 'unsupported_primary_type' ? 400
        : result.error === 'combine_rpc_failed' ? 409
        : 400;
      return res.status(status).json({
        ...result,
        ...(result.error === 'unsupported_primary_type' ? {
          combine_supported_types: COMBINE_SUPPORTED_TYPES,
          hint: 'Use Delete for team_members and users. Combine is only available for customers and leads.',
        } : {}),
      });
    }
    return res.json(result);
  });

  // POST /:id/link-lead — explicitly mark a lead as converted to a customer
  // body: { lead_entity_id, customer_entity_id }
  router.post('/:id/link-lead', authenticateToken, async (req, res) => {
    const userId = req.user.userId;
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid_id' });

    const { lead_entity_id, customer_entity_id } = req.body || {};
    if (lead_entity_id == null || customer_entity_id == null) {
      return res.status(400).json({ error: 'lead_entity_id + customer_entity_id required' });
    }

    // Confirm both are members of this conflict (defensive against stale UI).
    const { row: conflict, error: getErr } = await getConflict(supabase, userId, id, { enrich: false });
    if (getErr) return res.status(500).json({ error: getErr });
    if (!conflict) return res.status(404).json({ error: 'not_found' });
    const owners = Array.isArray(conflict.owners) ? conflict.owners : [];
    const hasLead = owners.some((o) => o.entity_type === 'lead' && String(o.entity_id) === String(lead_entity_id));
    const hasCust = owners.some((o) => o.entity_type === 'customer' && String(o.entity_id) === String(customer_entity_id));
    if (!hasLead || !hasCust) {
      return res.status(409).json({ error: 'lead_or_customer_not_in_conflict' });
    }

    const result = await applyLeadCustomerLink(supabase, logger, {
      userId,
      leadId: Number(lead_entity_id),
      customerId: Number(customer_entity_id),
      reasonsHint: ['operator_apply_from_ui'],
    });
    if (!result.ok) {
      const status = result.error === 'lead_not_found' ? 404
        : result.error === 'lead_already_converted' ? 409
        : 400;
      return res.status(status).json(result);
    }
    return res.json(result);
  });

  // POST /repair-lead-links — retroactive bulk reconciler.
  // body: { dryRun: boolean, limit?: number }
  // Walks open conflicts that have exactly 1 customer + 1 lead owner,
  // runs the linker, returns per-conflict verdicts.
  // In apply mode (dryRun=false), HIGH-confidence matches are linked.
  router.post('/repair-lead-links', authenticateToken, async (req, res) => {
    const userId = req.user.userId;
    const dryRun = !!(req.body && req.body.dryRun);
    const limit = Math.min(Number((req.body && req.body.limit) || 100), 500);

    // Pull open customer+lead conflicts.
    const { data: conflicts, error } = await supabase
      .from('identity_conflicts')
      .select('id, normalized_phone, owners, severity, status')
      .eq('workspace_id', userId)
      .eq('status', 'open')
      .limit(limit);
    if (error) return res.status(500).json({ error: error.message });

    const candidates = (conflicts || []).filter((c) => {
      const o = Array.isArray(c.owners) ? c.owners : [];
      const hasCust = o.some((x) => x.entity_type === 'customer');
      const hasLead = o.some((x) => x.entity_type === 'lead');
      return hasCust && hasLead;
    });

    const results = [];
    let highCount = 0;
    let mediumCount = 0;
    let lowCount = 0;
    let linkedCount = 0;
    let skippedCount = 0;

    for (const c of candidates) {
      const lead = c.owners.find((x) => x.entity_type === 'lead');
      const customer = c.owners.find((x) => x.entity_type === 'customer');

      // Need actual customer details to score. Pull them.
      const { data: cust } = await supabase
        .from('customers')
        .select('id, first_name, last_name, phone, source')
        .eq('id', customer.entity_id)
        .eq('user_id', userId)
        .maybeSingle();
      if (!cust) {
        skippedCount++;
        results.push({ conflict_id: c.id, lead_id: lead.entity_id, customer_id: customer.entity_id, skipped: 'customer_missing' });
        continue;
      }

      const verdict = await attemptLeadToCustomerLink(supabase, logger, {
        userId,
        customerId: cust.id,
        customerPhone: cust.phone,
        customerName: `${cust.first_name || ''} ${cust.last_name || ''}`.trim(),
        customerSource: cust.source,
        dryRun,
        mode: dryRun ? 'repair_dryrun' : 'repair_apply',
      });

      if (verdict.linked) linkedCount++;
      if (verdict.confidence === 'high') highCount++;
      else if (verdict.confidence === 'medium') mediumCount++;
      else lowCount++;

      results.push({
        conflict_id: c.id,
        lead_id: Number(lead.entity_id),
        customer_id: Number(customer.entity_id),
        normalized_phone: c.normalized_phone,
        verdict,
      });
    }

    return res.json({
      ok: true,
      dryRun,
      total_candidates: candidates.length,
      high: highCount,
      medium: mediumCount,
      low: lowCount,
      linked: linkedCount,
      skipped: skippedCount,
      results,
    });
  });

  return router;
};
