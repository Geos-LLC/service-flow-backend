'use strict';

/**
 * Identity Conflicts — operator endpoints.
 *
 * Backs the "Settings → Data Integrity → Identity Conflicts" UI page.
 * All endpoints tenant-scoped by JWT user_id (per
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
 *   POST   /:id/delete-owner   — destructive single-row delete
 *   POST   /:id/combine        — merge secondaries into primary
 *   POST   /:id/link-lead      — operator lead↔customer override
 *   POST   /repair-lead-links  — retroactive sweep (dry-run by default)
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
const { applyLeadCustomerLink, setIdentityCustomer, setIdentityLead, writeAuditRow, emitProjectionMetric } = require('./lib/identity-linker');
const { classifyNameMatch } = require('./lib/identity-resolver');
const { normalize, normalizePhone } = require('./lib/name-normalize');
const { isEnabled, FLAGS } = require('./lib/feature-flags');
const { shouldDowngradeForActiveWindow, filterByExclusion } = require('./lib/retroactive-repair-guards');

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

  // POST /:id/link-lead — operator explicit lead↔customer link
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
        : result.error === 'cross_tenant_blocked' ? 403
        : result.error === 'freeze' ? 503
        : 400;
      return res.status(status).json(result);
    }
    return res.json(result);
  });

  // POST /repair-lead-links — retroactive bulk sweep (dry-run by default).
  //
  // Conservative HIGH-confidence gate. Uses the canonical resolver name
  // classifier (classifyNameMatch) — NOT a second scoring engine. Walks
  // open identity_conflicts that have at least one customer + one lead
  // owner and reports per-candidate verdict.
  //
  // Body: {
  //   dryRun?: boolean (default true)
  //   limit?:  number  (default 100, max 500)
  //   activeWindowHours?: number  (default 24)
  //     Retroactive-repair operational safeguard (Phase 1, operator
  //     correction 2026-05-21): if BOTH leads.updated_at AND
  //     customers.updated_at are within this many hours of now, downgrade
  //     HIGH → review_required. Prevents reconciling records that are
  //     actively being manipulated by operators during the cleanup
  //     window. Temporary protection for retroactive repair only;
  //     not applied to the live resolver / setter paths.
  //     Pass 0 to disable the safeguard.
  //   excludeConflictIds?: number[]
  //     Operator-supplied list of conflict IDs to skip during this run.
  //     Used after visual UI review to defer specific candidates that
  //     looked risky. Both dryRun and apply modes respect this list.
  //     Non-finite values silently dropped; both ["12","13"] and [12,13]
  //     accepted. Excluded IDs reported back in the response.
  // }
  router.post('/repair-lead-links', authenticateToken, async (req, res) => {
    const userId = req.user.userId;
    const body = req.body || {};
    // Default dryRun=true per operator requirement (correction #4).
    const dryRun = body.dryRun === false ? false : true;
    const limit = Math.min(Number(body.limit || 100), 500);
    const activeWindowHours = body.activeWindowHours == null ? 24 : Math.max(0, Number(body.activeWindowHours));
    const excludeConflictIds = Array.isArray(body.excludeConflictIds) ? body.excludeConflictIds : [];

    // Pull open customer+lead conflicts.
    const { data: conflicts, error } = await supabase
      .from('identity_conflicts')
      .select('id, normalized_phone, owners, severity, status')
      .eq('workspace_id', userId)
      .eq('status', 'open')
      .limit(limit);
    if (error) return res.status(500).json({ error: error.message });

    // Step 1: apply operator-supplied exclude list before candidate filtering.
    const { kept: nonExcluded, excludedIds } = filterByExclusion(conflicts || [], excludeConflictIds);

    // Step 2: filter to lead+customer pairs.
    const candidates = nonExcluded.filter((c) => {
      const o = Array.isArray(c.owners) ? c.owners : [];
      const hasCust = o.some((x) => x.entity_type === 'customer');
      const hasLead = o.some((x) => x.entity_type === 'lead');
      return hasCust && hasLead;
    });

    const results = [];
    let highCount = 0;
    let reviewRequiredCount = 0;
    let mediumCount = 0;
    let lowCount = 0;
    let appliedCount = 0;
    let skippedCount = 0;
    let refusedCount = 0;

    for (const c of candidates) {
      const leadOwners = c.owners.filter((x) => x.entity_type === 'lead');
      const custOwners = c.owners.filter((x) => x.entity_type === 'customer');

      // Conservative: refuse multi-lead OR multi-customer conflicts —
      // operator must resolve through UI per correction #4 ("no ambiguity
      // candidates", "no conflicting identity rows").
      if (leadOwners.length !== 1 || custOwners.length !== 1) {
        skippedCount++;
        results.push({
          conflict_id: c.id,
          verdict: 'skipped',
          reason: 'multi_owner_requires_manual_review',
          lead_count: leadOwners.length,
          customer_count: custOwners.length,
        });
        continue;
      }

      const leadId = Number(leadOwners[0].entity_id);
      const customerId = Number(custOwners[0].entity_id);

      // Pull lead + customer (tenant-scoped).
      // updated_at included for the activeWindowHours safeguard.
      const [{ data: lead }, { data: customer }] = await Promise.all([
        supabase.from('leads')
          .select('id, user_id, first_name, last_name, phone, source, converted_customer_id, normalized_name, name_token_set, updated_at')
          .eq('id', leadId).eq('user_id', userId).maybeSingle(),
        supabase.from('customers')
          .select('id, user_id, first_name, last_name, phone, source, normalized_name, name_token_set, updated_at')
          .eq('id', customerId).eq('user_id', userId).maybeSingle(),
      ]);

      if (!lead || !customer) {
        skippedCount++;
        results.push({ conflict_id: c.id, lead_id: leadId, customer_id: customerId, verdict: 'skipped', reason: 'lead_or_customer_missing' });
        continue;
      }

      // Already linked? Idempotent.
      if (lead.converted_customer_id != null) {
        skippedCount++;
        results.push({
          conflict_id: c.id, lead_id: leadId, customer_id: customerId,
          verdict: 'skipped',
          reason: lead.converted_customer_id === customerId ? 'already_linked_same' : 'already_linked_other',
          current_customer_id: lead.converted_customer_id,
        });
        continue;
      }

      // Compute name classification via the CANONICAL resolver helper.
      const leadName = lead.normalized_name || normalize(`${lead.first_name || ''} ${lead.last_name || ''}`).normalized_name;
      const leadTokens = lead.name_token_set || normalize(`${lead.first_name || ''} ${lead.last_name || ''}`).name_token_set;
      const custName = customer.normalized_name || normalize(`${customer.first_name || ''} ${customer.last_name || ''}`).normalized_name;
      const custTokens = customer.name_token_set || normalize(`${customer.first_name || ''} ${customer.last_name || ''}`).name_token_set;
      const nameClass = classifyNameMatch(leadName, leadTokens, custName, custTokens);

      const leadPhone10 = normalizePhone(lead.phone);
      const custPhone10 = normalizePhone(customer.phone);
      const phoneMatch = leadPhone10 != null && leadPhone10 === custPhone10;

      // Source compatibility — best-effort, treats null as compatible.
      const sourceCompat = !lead.source || !customer.source
        || String(lead.source).toLowerCase().split(/\W+/).some(t => t && String(customer.source).toLowerCase().includes(t));

      // Conservative HIGH gate per correction #4:
      //   1. lead.converted_customer_id IS NULL          ✓ (checked above)
      //   2. tenant matches                              ✓ (queries filter)
      //   3. exactly one lead + one customer in conflict ✓ (filtered)
      //   4. strong name class                           required
      //   5. phone matches                               required
      //   6. no open ambiguity row for this phone        ↓ checked below
      //   7. no second identity row on same phone        ↓ checked below
      //   8. source compatible OR one side null          ↓
      const isStrongName = nameClass === 'strong_exact' || nameClass === 'strong_tokenset' || nameClass === 'strong_leven';
      let confidence;
      let reason;
      if (!phoneMatch) {
        confidence = 'low'; reason = 'phone_mismatch';
      } else if (isStrongName && sourceCompat) {
        confidence = 'high'; reason = `phone_match+${nameClass}+source_compat`;
      } else if (isStrongName) {
        confidence = 'medium'; reason = `phone_match+${nameClass}+source_incompat`;
      } else if (nameClass === 'one_missing' || nameClass === 'neither_named') {
        confidence = 'medium'; reason = `phone_match+${nameClass}`;
      } else {
        // weak_*, conflict
        confidence = 'low'; reason = `phone_match+${nameClass}`;
      }

      // Even at HIGH, double-check for blockers.
      if (confidence === 'high') {
        // No open ambiguity row for this phone (resolver flagged it as risky)
        const { count: ambigCount } = await supabase
          .from('communication_identity_ambiguities')
          .select('id', { head: true, count: 'exact' })
          .eq('user_id', userId)
          .eq('attempted_phone', leadPhone10)
          .eq('status', 'open');
        if ((ambigCount || 0) > 0) {
          confidence = 'medium';
          reason += '+open_ambiguity_blocks';
        }
      }
      if (confidence === 'high') {
        // No second identity row on this phone with conflicting CRM links
        const { data: phoneIdentities } = await supabase
          .from('communication_participant_identities')
          .select('id, sf_lead_id, sf_customer_id')
          .eq('user_id', userId)
          .eq('normalized_phone', leadPhone10);
        const conflictingIdentities = (phoneIdentities || []).filter(p =>
          (p.sf_lead_id && p.sf_lead_id !== leadId) ||
          (p.sf_customer_id && p.sf_customer_id !== customerId)
        );
        if (conflictingIdentities.length > 0) {
          confidence = 'medium';
          reason += '+conflicting_identity_row';
        }
      }

      // Active-window safeguard (Phase 1 retroactive repair only).
      // See lib/retroactive-repair-guards.js for the rule.
      let activeWindowDowngrade = false;
      if (confidence === 'high') {
        const guard = shouldDowngradeForActiveWindow({
          leadUpdatedAt: lead.updated_at,
          customerUpdatedAt: customer.updated_at,
          activeWindowHours,
        });
        if (guard.downgrade) {
          confidence = 'review_required';
          reason += `+${guard.reason}`;
          activeWindowDowngrade = true;
        }
      }

      if (confidence === 'high') highCount++;
      else if (confidence === 'review_required') reviewRequiredCount++;
      else if (confidence === 'medium') mediumCount++;
      else lowCount++;

      const result = {
        conflict_id: c.id,
        lead_id: leadId,
        customer_id: customerId,
        normalized_phone: c.normalized_phone,
        confidence,
        reason,
        name_class: nameClass,
        phone_match: phoneMatch,
        source_compat: sourceCompat,
        lead_source: lead.source,
        customer_source: customer.source,
        lead_updated_at: lead.updated_at || null,
        customer_updated_at: customer.updated_at || null,
        active_window_downgrade: activeWindowDowngrade,
      };

      // Apply only when:
      //   - apply mode (dryRun=false)
      //   - HIGH confidence
      //   - freeze switch OFF
      if (!dryRun && confidence === 'high') {
        if (isEnabled(FLAGS.IDENTITY_PROJECTION_FREEZE)) {
          refusedCount++;
          result.applied = false;
          result.applied_reason = 'freeze';
        } else {
          const applyResult = await applyLeadCustomerLink(supabase, logger, {
            userId,
            leadId,
            customerId,
            reasonsHint: ['retroactive_repair', reason],
          });
          if (applyResult.ok) {
            appliedCount++;
            result.applied = true;
            // Overwrite audit row with richer match context.
            await writeAuditRow(supabase, logger, {
              userId, leadId, customerId,
              resolvedBy: 'retroactive_repair',
              resolutionReason: reason,
              nameClass, phoneMatch, sourceCompat,
              notes: `confidence=${confidence}`,
            });
            emitProjectionMetric(logger, {
              event: 'retroactive_apply', outcome: 'success',
              tenant: userId, leadId, customerId,
              source: 'repair',
              resolvedBy: 'retroactive_repair',
              resolutionReason: reason,
            });
          } else {
            refusedCount++;
            result.applied = false;
            result.applied_reason = applyResult.error;
            emitProjectionMetric(logger, {
              event: 'retroactive_apply', outcome: 'refused',
              tenant: userId, leadId, customerId,
              source: 'repair',
              resolvedBy: 'retroactive_repair',
              resolutionReason: reason,
              reason: applyResult.error,
            });
          }
        }
      } else if (dryRun) {
        emitProjectionMetric(logger, {
          event: 'retroactive_dryrun', outcome: confidence === 'high' ? 'success' : (confidence === 'medium' ? 'refused' : 'no_op_one_side_missing'),
          tenant: userId, leadId, customerId,
          source: 'repair',
          resolvedBy: 'retroactive_repair',
          resolutionReason: reason,
        });
      }

      results.push(result);
    }

    return res.json({
      ok: true,
      dryRun,
      activeWindowHours,
      total_conflicts_examined: candidates.length,
      excluded_count: excludedIds.length,
      excluded_ids: excludedIds,
      high: highCount,
      review_required: reviewRequiredCount,
      medium: mediumCount,
      low: lowCount,
      applied: appliedCount,
      refused: refusedCount,
      skipped: skippedCount,
      results,
    });
  });

  return router;
};
