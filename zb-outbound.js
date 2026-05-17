'use strict';

/**
 * ZB Outbound — operator endpoints (Phase A read-mostly surface).
 *
 * Mounted at /api/zb-outbound (see server.js). Per design §16 / §17
 * the operator MUST be able to see queue state, DLQ, conflicts,
 * ambiguous-pending, unmapped providers, and freeze status without
 * any ZB outbound traffic occurring.
 *
 * NO producer endpoints in Phase A. Producer hooks land in Phase B.
 *
 * All endpoints are tenant-scoped by JWT user_id.
 */

const express = require('express');
const { ENABLED, FROZEN, DRY_RUN } = require('./lib/zb-outbound-delivery');

module.exports = (supabase, logger) => {
  const router = express.Router();

  // Per-route auth — feedback_per_route_auth_api_mount.md.
  const authenticateToken = async (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'No token provided' });
    try {
      const jwt = require('jsonwebtoken');
      const decoded = jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key');
      req.user = decoded;
      next();
    } catch {
      return res.status(401).json({ error: 'Invalid token' });
    }
  };

  // GET /status — high-level surface (per design §17.2 step 4)
  router.get('/status', authenticateToken, async (req, res) => {
    try {
      const userId = req.user.userId;
      const [
        { count: pendingCount },
        { count: sendingCount },
        { count: sentCount },
        { count: confirmedCount },
        { count: failedCount },
        { count: conflictCount },
        { count: ambiguousCount },
        { count: invalidatedCount },
        { count: supersededCount },
      ] = await Promise.all([
        supabase.from('zb_outbound_commands').select('id', { count: 'exact', head: true }).eq('user_id', userId).eq('state', 'pending'),
        supabase.from('zb_outbound_commands').select('id', { count: 'exact', head: true }).eq('user_id', userId).eq('state', 'sending'),
        supabase.from('zb_outbound_commands').select('id', { count: 'exact', head: true }).eq('user_id', userId).eq('state', 'sent'),
        supabase.from('zb_outbound_commands').select('id', { count: 'exact', head: true }).eq('user_id', userId).eq('state', 'confirmed'),
        supabase.from('zb_outbound_commands').select('id', { count: 'exact', head: true }).eq('user_id', userId).eq('state', 'failed'),
        supabase.from('zb_outbound_commands').select('id', { count: 'exact', head: true }).eq('user_id', userId).eq('state', 'conflict'),
        supabase.from('zb_outbound_commands').select('id', { count: 'exact', head: true }).eq('user_id', userId).eq('state', 'ambiguous_pending_review'),
        supabase.from('zb_outbound_commands').select('id', { count: 'exact', head: true }).eq('user_id', userId).eq('state', 'invalidated_by_upstream_terminal_state'),
        supabase.from('zb_outbound_commands').select('id', { count: 'exact', head: true }).eq('user_id', userId).eq('state', 'cancelled_superseded'),
      ]);
      res.json({
        phase: 'A_scaffolding',
        flags: {
          enabled: ENABLED(),
          frozen: FROZEN(),
          dry_run: DRY_RUN(),
        },
        counts: {
          pending: pendingCount || 0,
          sending: sendingCount || 0,
          sent: sentCount || 0,
          confirmed: confirmedCount || 0,
          failed: failedCount || 0,
          conflict: conflictCount || 0,
          ambiguous_pending_review: ambiguousCount || 0,
          invalidated_by_upstream_terminal_state: invalidatedCount || 0,
          cancelled_superseded: supersededCount || 0,
        },
      });
    } catch (e) {
      logger.error(`[ZB Outbound] /status error: ${e.message}`);
      res.status(500).json({ error: 'status_failed' });
    }
  });

  // GET / — list commands (tenant-scoped, paginated)
  router.get('/', authenticateToken, async (req, res) => {
    try {
      const userId = req.user.userId;
      const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
      const stateFilter = req.query.state || null;
      const fieldGroupFilter = req.query.field_group || null;

      let q = supabase
        .from('zb_outbound_commands')
        .select('id, event_id, command_type, field_group, state, sf_job_id, sf_customer_id, zenbooker_id, attempts, requested_at, sent_at, confirmed_at, terminal_at, last_error, defer_reason, origin')
        .eq('user_id', userId)
        .order('requested_at', { ascending: false })
        .limit(limit);
      if (stateFilter) q = q.eq('state', stateFilter);
      if (fieldGroupFilter) q = q.eq('field_group', fieldGroupFilter);
      const { data, error } = await q;
      if (error) throw error;
      res.json({ commands: data || [] });
    } catch (e) {
      logger.error(`[ZB Outbound] / list error: ${e.message}`);
      res.status(500).json({ error: 'list_failed' });
    }
  });

  // GET /dlq — terminal-failed + invalidated rows
  router.get('/dlq', authenticateToken, async (req, res) => {
    try {
      const userId = req.user.userId;
      const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
      const { data, error } = await supabase
        .from('zb_outbound_commands')
        .select('id, event_id, command_type, field_group, state, sf_job_id, zenbooker_id, attempts, terminal_at, last_error, defer_reason, conflict_metadata, invalidation_reason, zb_response')
        .eq('user_id', userId)
        .in('state', ['failed', 'invalidated_by_upstream_terminal_state'])
        .order('terminal_at', { ascending: false, nullsFirst: false })
        .limit(limit);
      if (error) throw error;
      res.json({ dlq: data || [] });
    } catch (e) {
      logger.error(`[ZB Outbound] /dlq error: ${e.message}`);
      res.status(500).json({ error: 'dlq_failed' });
    }
  });

  // GET /conflicts — open conflicts requiring operator review
  router.get('/conflicts', authenticateToken, async (req, res) => {
    try {
      const userId = req.user.userId;
      const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
      const { data, error } = await supabase
        .from('zb_outbound_commands')
        .select('id, event_id, command_type, field_group, state, sf_job_id, zenbooker_id, source_revision, payload_json, intent_hash, conflict_metadata, requested_at, requested_by_user_id, requested_by_actor')
        .eq('user_id', userId)
        .eq('state', 'conflict')
        .order('requested_at', { ascending: false })
        .limit(limit);
      if (error) throw error;
      res.json({ conflicts: data || [] });
    } catch (e) {
      logger.error(`[ZB Outbound] /conflicts error: ${e.message}`);
      res.status(500).json({ error: 'conflicts_failed' });
    }
  });

  // GET /ambiguous — design §3.5.3
  router.get('/ambiguous', authenticateToken, async (req, res) => {
    try {
      const userId = req.user.userId;
      const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
      const { data, error } = await supabase
        .from('zb_outbound_commands')
        .select('id, event_id, command_type, field_group, state, sf_job_id, zenbooker_id, payload_json, intent_hash, correlation_confidence, conflict_metadata, sent_at')
        .eq('user_id', userId)
        .eq('state', 'ambiguous_pending_review')
        .order('sent_at', { ascending: false, nullsFirst: false })
        .limit(limit);
      if (error) throw error;
      res.json({ ambiguous: data || [] });
    } catch (e) {
      logger.error(`[ZB Outbound] /ambiguous error: ${e.message}`);
      res.status(500).json({ error: 'ambiguous_failed' });
    }
  });

  // GET /unmapped-providers — design §5.4
  router.get('/unmapped-providers', authenticateToken, async (req, res) => {
    try {
      const userId = req.user.userId;
      const { data, error } = await supabase
        .from('team_member_provider_mappings')
        .select('id, sf_team_member_id, zenbooker_provider_id, mapping_source, status, sync_health, last_seen_at, conflict_metadata')
        .eq('user_id', userId)
        .or('status.eq.unmapped,sync_health.eq.duplicate_candidate')
        .order('created_at', { ascending: false });
      if (error) throw error;
      res.json({ unmapped: data || [] });
    } catch (e) {
      logger.error(`[ZB Outbound] /unmapped-providers error: ${e.message}`);
      res.status(500).json({ error: 'unmapped_failed' });
    }
  });

  // GET /by-job/:sfJobId — all commands targeting a specific SF job
  router.get('/by-job/:sfJobId', authenticateToken, async (req, res) => {
    try {
      const userId = req.user.userId;
      const sfJobId = String(req.params.sfJobId);
      const { data, error } = await supabase
        .from('zb_outbound_commands')
        .select('*')
        .eq('user_id', userId)
        .eq('sf_job_id', sfJobId)
        .order('requested_at', { ascending: false });
      if (error) throw error;
      res.json({ commands: data || [] });
    } catch (e) {
      logger.error(`[ZB Outbound] /by-job error: ${e.message}`);
      res.status(500).json({ error: 'by_job_failed' });
    }
  });

  return router;
};
