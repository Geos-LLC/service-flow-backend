'use strict';

/**
 * Phone Identity Registry — JS-side helpers + [IdentityConflict] log emitter.
 *
 * The registry table (`phone_identity_registry`) and detector functions
 * are maintained by DB triggers (see migrations/046_phone_identity_registry.sql).
 * This module exposes:
 *
 *   - listConflicts(supabase, userId, opts)
 *   - getConflict(supabase, userId, id)
 *   - resolveConflict(supabase, logger, userId, id, action, opts)
 *   - summary(supabase, userId)         — metrics for ops dashboards
 *   - newConflictsPerDay(supabase, userId, days)
 *   - emitIdentityConflictLog(logger, fields)
 *
 * Per P0.1 (2026-05-20). See:
 *   docs/operations/recipient_source_map.md
 *   lib/sms-recipient-integrity.js  (downstream STRICT-mode SMS guard)
 */

const VALID_RESOLUTIONS = Object.freeze(['merge', 'keep_separate', 'ignore', 'change_owner']);

// Phase 1 supports only the non-destructive actions. Merge + change_owner
// require careful FK propagation across many tables and land in Phase 2.
const PHASE_1_ACTIONS = Object.freeze(['keep_separate', 'ignore']);

const VALID_SEVERITIES = Object.freeze([
  'same_role_duplicate',
  'cross_role_duplicate',
  'cross_tenant_duplicate',
]);

const VALID_STATUSES = Object.freeze(['open', 'resolved', 'ignored']);

/**
 * Classify an owner's external system based on identifying columns.
 * Rules:
 *   - customer with zenbooker_id            → 'zenbooker'
 *   - customer or lead source contains "leadbridge" / "thumbtack" / "yelp"
 *                                           → 'leadbridge'
 *   - source contains "openphone"           → 'openphone'
 *   - team_member with zenbooker_id         → 'zenbooker'
 *   - otherwise                             → 'sf'
 */
function classifyExternalSource(entityType, row) {
  if (!row) return 'unknown';
  if ((entityType === 'customer' || entityType === 'team_member') && row.zenbooker_id) {
    return 'zenbooker';
  }
  const src = String(row.source || '').toLowerCase();
  if (src.includes('openphone')) return 'openphone';
  if (src.includes('leadbridge') || src.includes('thumbtack') || src.includes('yelp')) {
    return 'leadbridge';
  }
  return 'sf';
}

/**
 * Batch-enrich an array of conflict rows with per-owner name + email +
 * external_source + raw phone. Runs at most one query per entity type
 * regardless of conflict count — O(types), not O(owners).
 *
 * @returns enriched rows where each owners[] entry gains:
 *   name           — concatenated first + last (or display label)
 *   email          — when available
 *   phone          — the raw phone stored on the source row
 *   external_source — 'zenbooker' | 'leadbridge' | 'openphone' | 'sf' | 'unknown'
 *   missing        — true if the source entity was not found (deleted?)
 */
async function enrichOwners(supabase, userId, rows) {
  if (!Array.isArray(rows) || rows.length === 0) return rows;

  // Collect the unique (entity_type, entity_id) pairs across all conflicts.
  const byType = { customer: new Set(), team_member: new Set(), lead: new Set(), user: new Set() };
  for (const r of rows) {
    const owners = Array.isArray(r.owners) ? r.owners : [];
    for (const o of owners) {
      if (byType[o.entity_type]) byType[o.entity_type].add(String(o.entity_id));
    }
  }

  // Batch lookups.
  const fetchTable = async (table, ids, columns) => {
    if (ids.length === 0) return [];
    const { data, error } = await supabase
      .from(table)
      .select(columns)
      .eq('user_id', userId)
      .in('id', ids);
    if (error) return [];
    return data || [];
  };
  const fetchUsers = async (ids) => {
    if (ids.length === 0) return [];
    const { data, error } = await supabase
      .from('users')
      .select('id, first_name, last_name, email, phone, business_name')
      .in('id', ids);
    if (error) return [];
    return data || [];
  };

  const [custRows, tmRows, leadRows, userRows] = await Promise.all([
    fetchTable('customers',    Array.from(byType.customer).map((v) => Number(v)).filter(Number.isFinite),
               'id, first_name, last_name, email, phone, zenbooker_id, source'),
    fetchTable('team_members', Array.from(byType.team_member).map((v) => Number(v)).filter(Number.isFinite),
               'id, first_name, last_name, email, phone, zenbooker_id'),
    fetchTable('leads',        Array.from(byType.lead).map((v) => Number(v)).filter(Number.isFinite),
               'id, first_name, last_name, email, phone, source'),
    fetchUsers(Array.from(byType.user).map((v) => Number(v)).filter(Number.isFinite)),
  ]);

  const indexBy = (arr) => Object.fromEntries(arr.map((r) => [String(r.id), r]));
  const idx = {
    customer: indexBy(custRows),
    team_member: indexBy(tmRows),
    lead: indexBy(leadRows),
    user: indexBy(userRows),
  };

  return rows.map((r) => {
    if (!Array.isArray(r.owners)) return r;
    const owners = r.owners;
    const enriched = owners.map((o) => {
      const src = idx[o.entity_type] ? idx[o.entity_type][String(o.entity_id)] : null;
      if (!src) {
        return { ...o, missing: true };
      }
      const name = o.entity_type === 'user'
        ? (src.business_name || [src.first_name, src.last_name].filter(Boolean).join(' ').trim() || `User #${o.entity_id}`)
        : ([src.first_name, src.last_name].filter(Boolean).join(' ').trim() || `${o.entity_type} #${o.entity_id}`);
      return {
        ...o,
        name,
        email: src.email || null,
        phone: src.phone || null,
        external_source: classifyExternalSource(o.entity_type, src),
      };
    });
    return { ...r, owners: enriched };
  });
}

/**
 * Page through identity_conflicts for a tenant.
 *
 * @param {Object} supabase
 * @param {number} userId
 * @param {Object} [opts]
 *   status   default 'open'
 *   severity optional filter
 *   limit    default 50, capped at 200
 *   offset   default 0
 *   enrich   default true — JOIN owner names, external source, raw phone
 * @returns {Promise<{ rows: Array, total: number }>}
 */
async function listConflicts(supabase, userId, opts = {}) {
  const status = opts.status || 'open';
  const limit = Math.min(opts.limit || 50, 200);
  const offset = Math.max(opts.offset || 0, 0);
  const enrich = opts.enrich !== false;
  if (!VALID_STATUSES.includes(status)) {
    return { rows: [], total: 0, error: 'invalid_status' };
  }

  let query = supabase
    .from('identity_conflicts')
    .select('id, workspace_id, normalized_phone, severity, owners, status, resolution, resolved_by, resolved_at, resolution_note, created_at, updated_at', { count: 'exact' })
    .eq('workspace_id', userId)
    .eq('status', status);

  if (opts.severity) {
    if (!VALID_SEVERITIES.includes(opts.severity)) {
      return { rows: [], total: 0, error: 'invalid_severity' };
    }
    query = query.eq('severity', opts.severity);
  }

  const { data, count, error } = await query
    .order('updated_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) return { rows: [], total: 0, error: error.message };

  let rows = data || [];
  if (enrich && rows.length > 0) {
    rows = await enrichOwners(supabase, userId, rows);
  }
  return { rows, total: count || 0 };
}

async function getConflict(supabase, userId, id, { enrich = true } = {}) {
  const { data, error } = await supabase
    .from('identity_conflicts')
    .select('*')
    .eq('id', id)
    .eq('workspace_id', userId)
    .maybeSingle();
  if (error) return { row: null, error: error.message };
  if (!data) return { row: null };
  let row = data;
  if (enrich) {
    const [enriched] = await enrichOwners(supabase, userId, [row]);
    row = enriched;
  }
  return { row };
}

/**
 * Resolve a conflict. Phase 1: only `keep_separate` and `ignore`.
 *
 * @param {Object} supabase
 * @param {Object} logger
 * @param {number} userId
 * @param {number} id
 * @param {string} action  one of PHASE_1_ACTIONS
 * @param {Object} [opts]
 *   note               operator-supplied note
 *   resolvedByUserId   audit field
 */
async function resolveConflict(supabase, logger, userId, id, action, opts = {}) {
  if (!PHASE_1_ACTIONS.includes(action)) {
    return { ok: false, error: 'unsupported_action', supported: PHASE_1_ACTIONS };
  }

  const { row: existing, error: getErr } = await getConflict(supabase, userId, id);
  if (getErr) return { ok: false, error: getErr };
  if (!existing) return { ok: false, error: 'not_found' };
  if (existing.status !== 'open') {
    return { ok: false, error: 'not_open', current_status: existing.status };
  }

  const newStatus = action === 'ignore' ? 'ignored' : 'resolved';
  const patch = {
    status: newStatus,
    resolution: action,
    resolved_by: opts.resolvedByUserId != null ? opts.resolvedByUserId : null,
    resolved_at: new Date().toISOString(),
    resolution_note: opts.note ? String(opts.note).slice(0, 1000) : null,
    updated_at: new Date().toISOString(),
  };

  const { error } = await supabase
    .from('identity_conflicts')
    .update(patch)
    .eq('id', id)
    .eq('workspace_id', userId);

  if (error) {
    if (logger && logger.error) {
      logger.error(`[IdentityConflict] resolve failed conflict_id=${id} workspace_id=${userId} action=${action} error=${error.message}`);
    }
    return { ok: false, error: error.message };
  }

  emitIdentityConflictLog(logger, {
    action,
    conflict_id: id,
    workspace_id: userId,
    normalized_phone: existing.normalized_phone,
    severity: existing.severity,
    owners_count: Array.isArray(existing.owners) ? existing.owners.length : null,
    resolved_by: opts.resolvedByUserId != null ? opts.resolvedByUserId : null,
    result: 'success',
  });

  return { ok: true, conflict: { ...existing, ...patch } };
}

/**
 * Tenant-scoped summary for the operator dashboard / metrics emitter.
 *
 * Returns counts requested by P0.1 §6:
 *   - identity_conflict_count: total OPEN conflicts in the tenant
 *   - cross_role_phone_count: open conflicts with cross_role_duplicate
 *   - new_conflicts_per_day: window count (last N days, default 7)
 *   - same_role_phone_count: open conflicts with same_role_duplicate
 *
 * NEVER throws.
 */
async function summary(supabase, userId, opts = {}) {
  const windowDays = opts.windowDays != null ? Number(opts.windowDays) : 7;
  const safeWindow = Number.isFinite(windowDays) && windowDays > 0 ? Math.min(windowDays, 90) : 7;

  try {
    const since = new Date(Date.now() - safeWindow * 86400000).toISOString();

    // Run aggregations as parallel queries.
    const [allOpen, crossRole, sameRole, newInWindow] = await Promise.all([
      supabase.from('identity_conflicts').select('id', { count: 'exact', head: true }).eq('workspace_id', userId).eq('status', 'open'),
      supabase.from('identity_conflicts').select('id', { count: 'exact', head: true }).eq('workspace_id', userId).eq('status', 'open').eq('severity', 'cross_role_duplicate'),
      supabase.from('identity_conflicts').select('id', { count: 'exact', head: true }).eq('workspace_id', userId).eq('status', 'open').eq('severity', 'same_role_duplicate'),
      supabase.from('identity_conflicts').select('id', { count: 'exact', head: true }).eq('workspace_id', userId).gte('created_at', since),
    ]);

    return {
      ok: true,
      identity_conflict_count: allOpen.count || 0,
      cross_role_phone_count: crossRole.count || 0,
      same_role_phone_count: sameRole.count || 0,
      new_conflicts_in_window: newInWindow.count || 0,
      window_days: safeWindow,
      generated_at: new Date().toISOString(),
    };
  } catch (err) {
    return { ok: false, error: err && err.message };
  }
}

/**
 * Per-day breakdown for the last N days (default 14). Single query;
 * returns array of `{ day, count }` ordered ascending.
 */
async function newConflictsPerDay(supabase, userId, days = 14) {
  const parsed = Number(days);
  const base = Number.isFinite(parsed) ? parsed : 14;
  const safeDays = Math.min(Math.max(base, 1), 90);
  const since = new Date(Date.now() - safeDays * 86400000).toISOString();
  const { data, error } = await supabase
    .from('identity_conflicts')
    .select('created_at')
    .eq('workspace_id', userId)
    .gte('created_at', since);
  if (error) return { ok: false, error: error.message };

  const buckets = Object.create(null);
  for (const r of data || []) {
    const day = String(r.created_at).slice(0, 10);
    buckets[day] = (buckets[day] || 0) + 1;
  }
  const rows = Object.entries(buckets)
    .map(([day, count]) => ({ day, count }))
    .sort((a, b) => a.day.localeCompare(b.day));
  return { ok: true, rows, window_days: safeDays };
}

/**
 * Emit the structured `[IdentityConflict]` log line.
 *
 * Pattern matches existing `[NotificationRecipient]` /
 * `[JobConfirmation]` / `[ZB Outbound]` etc. so a single Loki filter
 * `|~ "IdentityConflict"` surfaces all identity activity.
 *
 * NEVER throws.
 */
function emitIdentityConflictLog(logger, fields) {
  if (!logger || !logger.log) return;
  const f = fields || {};
  try {
    const parts = [
      `action=${f.action || 'unknown'}`,
      `conflict_id=${f.conflict_id != null ? f.conflict_id : 'null'}`,
      `workspace_id=${f.workspace_id != null ? f.workspace_id : 'null'}`,
      `normalized_phone=${f.normalized_phone ? maskPhone(f.normalized_phone) : 'null'}`,
      `severity=${f.severity || 'null'}`,
      `owners_count=${f.owners_count != null ? f.owners_count : 'null'}`,
      `resolved_by=${f.resolved_by != null ? f.resolved_by : 'null'}`,
      `result=${f.result || 'unknown'}`,
    ];
    if (f.error) parts.push(`error=${String(f.error).slice(0, 200)}`);
    logger.log(`[IdentityConflict] ${parts.join(' ')}`);
  } catch (_) {
    // never throw out of logging
  }
}

function maskPhone(p) {
  const digits = String(p || '').replace(/\D/g, '');
  if (digits.length < 2) return '***';
  return '***' + digits.slice(-2);
}

module.exports = {
  VALID_RESOLUTIONS,
  PHASE_1_ACTIONS,
  VALID_SEVERITIES,
  VALID_STATUSES,
  listConflicts,
  getConflict,
  resolveConflict,
  summary,
  newConflictsPerDay,
  emitIdentityConflictLog,
  maskPhone,
  // exported for tests
  classifyExternalSource,
  enrichOwners,
};
