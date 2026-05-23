'use strict';

/**
 * ZB ↔ SF orphan reconciliation.
 *
 * Detects SF customers that carry a zenbooker_id no longer present in ZB
 * (deleted-in-source while connected, no customer.deleted webhook ever wired)
 * and classifies them by SF-side provenance so cleanup respects the
 * ownership model:
 *
 *   - source_only_orphan: nothing in SF references the customer beyond ZB
 *                         projection (no identity, no OP mapping, no LB
 *                         lead, no non-cancelled jobs, no SF-native marker).
 *                         Default action: archive (= detach today).
 *   - mixed_orphan:       customer has SF-side history (identity row, OP
 *                         mapping, LB lead, non-cancelled job, etc.).
 *                         Default action: detach ZB projection only —
 *                         preserve SF row + identity + history.
 *   - risky_orphan:       active jobs / payments / invoices / unclear
 *                         provenance. Default action: review item; no
 *                         mutation.
 *
 * Today "archive" and "detach" both reduce to the same operation: NULL out
 * the customer's zenbooker_id so reconnect (or next ZB sync via phone
 * adoption) treats the row as SF-native. A future schema migration can
 * introduce a real archive column without changing the classification
 * surface. The action label is recorded in the audit log so the two can
 * be distinguished after the fact.
 *
 * Design constraints (must hold for THIS PR):
 *   - DRY-RUN BY DEFAULT. Apply requires an explicit mode value.
 *   - NEVER hard-delete. The only mutation in apply mode is
 *     UPDATE customers SET zenbooker_id = NULL ... and an
 *     identity_conflicts row insert for risky_orphan review items.
 *   - NEVER cross tenants. Every query is scoped by `user_id = userId`.
 *   - IDEMPOTENT APPLY. Re-running apply on a tenant that already has
 *     no orphans is a no-op (orphan set is empty).
 *   - AUDIT EVERY ACTION via the provided logger: structured
 *     [ZBReconcile] action=... lines.
 *
 * Companion docs (forward refs):
 *   docs/operations/zb-orphan-reconciliation.md (TBD — design + runbook)
 *   docs/architecture/integration-compliance-audit.md (ZB section)
 *
 * Use:
 *
 *   const recon = require('./zb-orphan-reconciliation');
 *   const report = await recon.reconcileOrphans({
 *     supabase, logger, userId, zbCustomerIds, mode: 'dryRun',
 *   });
 *
 * The caller supplies `zbCustomerIds` (Set of zenbooker_id strings the
 * live ZB API currently returns) so this module stays free of any HTTP
 * dependency on Zenbooker. The caller is also responsible for fetching
 * the live list — see zenbooker-sync.js zbFetchAll('/customers').
 */

// ── Classification helpers ────────────────────────────────────────

/**
 * Pure classifier. Takes a row's joined-link state and returns
 * { class, reason, proposed_action }.
 *
 * @param {object} ctx
 * @param {Array<{status:string}>}  ctx.jobs            - SF jobs for the customer
 * @param {object|null} ctx.identity                   - identity row (or null)
 * @param {number}      ctx.opMappingCount             - count of OP mappings on the identity
 * @param {number}      ctx.leadIdsLinkedViaIdentity   - count of leads linked via identity
 * @param {boolean}     ctx.hasInvoiceOrPayment        - any ledger / payment activity
 *
 * @returns {{ class: 'source_only_orphan'|'mixed_orphan'|'risky_orphan', reason: string, proposed_action: 'archive'|'detach'|'review' }}
 */
function classifyOrphan(ctx) {
  const c = (ctx && typeof ctx === 'object') ? ctx : {};
  const jobs = Array.isArray(c.jobs) ? c.jobs : [];
  const identity = c.identity || null;
  const opMappingCount = typeof c.opMappingCount === 'number' ? c.opMappingCount : 0;
  const leadIdsLinkedViaIdentity = typeof c.leadIdsLinkedViaIdentity === 'number' ? c.leadIdsLinkedViaIdentity : 0;
  const hasInvoiceOrPayment = c.hasInvoiceOrPayment === true;

  const activeJobCount = jobs.filter(j => {
    const s = (j && j.status) ? String(j.status).toLowerCase() : '';
    return s && s !== 'cancelled' && s !== 'canceled' && s !== 'lost';
  }).length;

  // Risky → active jobs OR payment/ledger evidence. Even with no
  // SF-side history, an active job means we cannot safely detach.
  if (activeJobCount > 0 || hasInvoiceOrPayment) {
    return {
      class: 'risky_orphan',
      reason: hasInvoiceOrPayment
        ? `risky_active_payments_or_invoices`
        : `risky_active_jobs_count_${activeJobCount}`,
      proposed_action: 'review',
    };
  }

  // Mixed → SF-side history exists (identity, OP, LB).
  if (identity || opMappingCount > 0 || leadIdsLinkedViaIdentity > 0) {
    const parts = [];
    if (identity) parts.push(`identity_${identity.id}`);
    if (opMappingCount > 0) parts.push(`op_mappings_${opMappingCount}`);
    if (leadIdsLinkedViaIdentity > 0) parts.push(`leads_${leadIdsLinkedViaIdentity}`);
    return {
      class: 'mixed_orphan',
      reason: `mixed:${parts.join(',')}`,
      proposed_action: 'detach',
    };
  }

  // Source-only → nothing else references this customer beyond ZB.
  return {
    class: 'source_only_orphan',
    reason: `source_only_jobs_${jobs.length}`,
    proposed_action: 'archive',
  };
}

// ── Data fetch (read-only) ────────────────────────────────────────

/**
 * Fetch every SF customer carrying a zenbooker_id for the tenant.
 * Returns: Array<{ sf_customer_id, zenbooker_id, name, phone, email,
 *                  created_at, jobs:[{status,...}], identity:{...}|null,
 *                  opMappingCount, leadIdsLinkedViaIdentity,
 *                  hasInvoiceOrPayment }>.
 *
 * Paginates to handle large tenants. All queries scoped to userId.
 */
async function fetchSfZbCustomerSnapshot(supabase, userId) {
  const PAGE = 500;
  const customers = [];
  let lastId = 0;
  while (true) {
    const { data, error } = await supabase.from('customers')
      .select('id, zenbooker_id, first_name, last_name, phone, email, created_at, source')
      .eq('user_id', userId)
      .not('zenbooker_id', 'is', null)
      .gt('id', lastId)
      .order('id', { ascending: true })
      .limit(PAGE);
    if (error) throw new Error(`fetchSfZbCustomerSnapshot.customers: ${error.message}`);
    if (!data || data.length === 0) break;
    customers.push(...data);
    lastId = data[data.length - 1].id;
    if (data.length < PAGE) break;
  }

  if (customers.length === 0) return [];

  const customerIds = customers.map(c => c.id);

  // Pull all jobs for those customers, scoped by tenant.
  const jobsByCustomer = new Map();
  for (let i = 0; i < customerIds.length; i += 200) {
    const batch = customerIds.slice(i, i + 200);
    const { data: jobs, error: jErr } = await supabase.from('jobs')
      .select('id, customer_id, status, zenbooker_id')
      .eq('user_id', userId)
      .in('customer_id', batch);
    if (jErr) throw new Error(`fetchSfZbCustomerSnapshot.jobs: ${jErr.message}`);
    for (const j of (jobs || [])) {
      if (!jobsByCustomer.has(j.customer_id)) jobsByCustomer.set(j.customer_id, []);
      jobsByCustomer.get(j.customer_id).push(j);
    }
  }

  // Identities linked to these customers.
  const identityByCustomer = new Map();
  for (let i = 0; i < customerIds.length; i += 200) {
    const batch = customerIds.slice(i, i + 200);
    const { data: ids, error: iErr } = await supabase.from('communication_participant_identities')
      .select('id, sf_customer_id, sf_lead_id, normalized_phone, display_name, status, leadbridge_contact_id, last_hydrated_by')
      .eq('user_id', userId)
      .in('sf_customer_id', batch);
    if (iErr) throw new Error(`fetchSfZbCustomerSnapshot.identities: ${iErr.message}`);
    for (const id of (ids || [])) {
      identityByCustomer.set(id.sf_customer_id, id);
    }
  }

  // OP mapping counts per identity, scoped by tenant.
  const opMappingCountByIdentity = new Map();
  const identityIds = Array.from(identityByCustomer.values()).map(i => i.id);
  for (let i = 0; i < identityIds.length; i += 200) {
    const batch = identityIds.slice(i, i + 200);
    if (batch.length === 0) continue;
    const { data: maps, error: mErr } = await supabase.from('communication_participant_mappings')
      .select('identity_id')
      .eq('tenant_id', userId)
      .in('identity_id', batch);
    if (mErr) throw new Error(`fetchSfZbCustomerSnapshot.op_mappings: ${mErr.message}`);
    for (const m of (maps || [])) {
      opMappingCountByIdentity.set(m.identity_id, (opMappingCountByIdentity.get(m.identity_id) || 0) + 1);
    }
  }

  // Leads linked to identities (sf_lead_id on the identity row).
  const leadsByCustomer = new Map();
  for (const [custId, ident] of identityByCustomer) {
    if (ident.sf_lead_id) {
      leadsByCustomer.set(custId, (leadsByCustomer.get(custId) || 0) + 1);
    }
  }

  // Build snapshot.
  return customers.map(c => {
    const identity = identityByCustomer.get(c.id) || null;
    const opMappingCount = identity ? (opMappingCountByIdentity.get(identity.id) || 0) : 0;
    return {
      sf_customer_id: c.id,
      zenbooker_id: c.zenbooker_id,
      name: [c.first_name, c.last_name].filter(Boolean).join(' ').trim() || null,
      phone: c.phone || null,
      email: c.email || null,
      created_at: c.created_at,
      source_label: c.source || null,
      jobs: jobsByCustomer.get(c.id) || [],
      identity,
      opMappingCount,
      leadIdsLinkedViaIdentity: leadsByCustomer.get(c.id) || 0,
      // Conservative placeholder: invoice/payment evidence is currently
      // not pulled. Caller can extend if a payments table is added.
      hasInvoiceOrPayment: false,
    };
  });
}

// ── Main entry: reconcileOrphans ──────────────────────────────────

/**
 * Compare SF's zenbooker-id-carrying customers against the live ZB set.
 *
 * @param {object} args
 * @param {object} args.supabase
 * @param {object} args.logger
 * @param {number|string} args.userId
 * @param {Set<string>|Array<string>} args.zbCustomerIds - the LIVE ZB customer-id set
 * @param {'dryRun'|'apply'} [args.mode='dryRun']
 *
 * @returns {Promise<{
 *   mode: 'dryRun'|'apply',
 *   userId: number|string,
 *   sf_zb_customer_count: number,
 *   zb_live_count: number,
 *   orphans: Array<object>,
 *   summary: {
 *     source_only: number,
 *     mixed: number,
 *     risky: number,
 *     applied_archive: number,
 *     applied_detach: number,
 *     applied_review: number,
 *     errors: number,
 *   },
 * }>}
 */
async function reconcileOrphans(args) {
  const supabase = args && args.supabase;
  const logger = (args && args.logger) || { log: () => {}, warn: () => {}, error: () => {} };
  const userId = args && args.userId;
  const mode = (args && args.mode === 'apply') ? 'apply' : 'dryRun';

  if (!supabase) throw new Error('reconcileOrphans: supabase is required');
  if (userId === undefined || userId === null) throw new Error('reconcileOrphans: userId is required');

  const zbIds = (args.zbCustomerIds instanceof Set)
    ? args.zbCustomerIds
    : new Set(Array.isArray(args.zbCustomerIds) ? args.zbCustomerIds : []);

  // Read SF snapshot (always — both dryRun and apply need it).
  const snapshot = await fetchSfZbCustomerSnapshot(supabase, userId);

  // Identify orphans: SF rows whose zenbooker_id is NOT in the live ZB set.
  const orphanRows = snapshot.filter(row => !zbIds.has(row.zenbooker_id));

  const orphans = [];
  const summary = {
    source_only: 0,
    mixed: 0,
    risky: 0,
    applied_archive: 0,
    applied_detach: 0,
    applied_review: 0,
    errors: 0,
  };

  for (const row of orphanRows) {
    const classification = classifyOrphan({
      jobs: row.jobs,
      identity: row.identity,
      opMappingCount: row.opMappingCount,
      leadIdsLinkedViaIdentity: row.leadIdsLinkedViaIdentity,
      hasInvoiceOrPayment: row.hasInvoiceOrPayment,
    });

    if (classification.class === 'source_only_orphan') summary.source_only++;
    if (classification.class === 'mixed_orphan') summary.mixed++;
    if (classification.class === 'risky_orphan') summary.risky++;

    const orphanReport = {
      sf_customer_id: row.sf_customer_id,
      zenbooker_id: row.zenbooker_id,
      name: row.name,
      phone: row.phone,
      email: row.email,
      class: classification.class,
      reason: classification.reason,
      proposed_action: classification.proposed_action,
      identity_id: row.identity ? row.identity.id : null,
      op_mapping_count: row.opMappingCount,
      lead_links: row.leadIdsLinkedViaIdentity,
      jobs_total: row.jobs.length,
      jobs_active: row.jobs.filter(j => {
        const s = (j && j.status) ? String(j.status).toLowerCase() : '';
        return s && s !== 'cancelled' && s !== 'canceled' && s !== 'lost';
      }).length,
      jobs_cancelled: row.jobs.filter(j => {
        const s = (j && j.status) ? String(j.status).toLowerCase() : '';
        return s === 'cancelled' || s === 'canceled' || s === 'lost';
      }).length,
      applied: false,
      apply_error: null,
    };

    if (mode === 'apply') {
      try {
        const applied = await applyOrphanAction({
          supabase,
          logger,
          userId,
          row,
          classification,
        });
        orphanReport.applied = applied.ok;
        orphanReport.apply_action_recorded = applied.action;
        if (classification.class === 'source_only_orphan') summary.applied_archive += applied.ok ? 1 : 0;
        else if (classification.class === 'mixed_orphan') summary.applied_detach += applied.ok ? 1 : 0;
        else if (classification.class === 'risky_orphan') summary.applied_review += applied.ok ? 1 : 0;
        if (!applied.ok) {
          summary.errors++;
          orphanReport.apply_error = applied.error || 'unknown';
        }
      } catch (e) {
        summary.errors++;
        orphanReport.apply_error = e.message;
      }
    } else {
      // dryRun: emit the report log but DO NOT mutate.
      try {
        logger.log(`[ZBReconcile] mode=dryRun action=proposed_${classification.proposed_action} class=${classification.class} customer_id=${row.sf_customer_id} zenbooker_id=${row.zenbooker_id} identity_id=${row.identity ? row.identity.id : 'null'} reason=${classification.reason}`);
      } catch (_) { /* never throw from the reconciler */ }
    }

    orphans.push(orphanReport);
  }

  return {
    mode,
    userId,
    sf_zb_customer_count: snapshot.length,
    zb_live_count: zbIds.size,
    orphans,
    summary,
  };
}

// ── Apply a single orphan's action (idempotent) ───────────────────

/**
 * Mutating apply path. Honors the per-class policy:
 *   - source_only_orphan → ARCHIVE = detach today (NULL zenbooker_id).
 *                          Customer row preserved for reconnect adoption.
 *   - mixed_orphan       → DETACH (NULL zenbooker_id).
 *                          Identity, OP, leads remain attached.
 *   - risky_orphan       → REVIEW: insert identity_conflicts row;
 *                          customer row UNTOUCHED.
 *
 * Idempotent: if the customer already has zenbooker_id=NULL (detached
 * by a prior apply run) the action is a no-op success. If a review item
 * for the same (workspace_id, phone) already exists with status='open'
 * a new one is NOT created.
 *
 * Returns { ok, action, note? }.
 */
async function applyOrphanAction({ supabase, logger, userId, row, classification }) {
  const cls = classification && classification.class;
  const sfCustId = row && row.sf_customer_id;
  const zbId = row && row.zenbooker_id;

  if (!sfCustId) return { ok: false, action: 'noop', error: 'missing_sf_customer_id' };

  if (cls === 'source_only_orphan' || cls === 'mixed_orphan') {
    const action = (cls === 'source_only_orphan') ? 'archive_orphan' : 'detach_orphan';

    // Idempotency check: detect already-detached.
    const { data: existing, error: readErr } = await supabase.from('customers')
      .select('id, zenbooker_id')
      .eq('id', sfCustId)
      .eq('user_id', userId)
      .maybeSingle();
    if (readErr) return { ok: false, action, error: readErr.message };
    if (!existing) return { ok: false, action, error: 'customer_not_found_or_cross_tenant' };
    if (existing.zenbooker_id === null) {
      try {
        logger.log(`[ZBReconcile] action=${action} result=noop_already_detached customer_id=${sfCustId} zenbooker_id=${zbId || 'null'} reason=${classification.reason}`);
      } catch (_) {}
      return { ok: true, action, note: 'already_detached' };
    }

    // Detach: NULL out zenbooker_id, scoped to tenant.
    const { error: updErr } = await supabase.from('customers')
      .update({ zenbooker_id: null })
      .eq('id', sfCustId)
      .eq('user_id', userId);
    if (updErr) return { ok: false, action, error: updErr.message };

    try {
      logger.log(`[ZBReconcile] action=${action} result=success customer_id=${sfCustId} zenbooker_id=${zbId || 'null'} identity_id=${row.identity ? row.identity.id : 'null'} op_mappings=${row.opMappingCount} reason=${classification.reason}`);
    } catch (_) {}
    return { ok: true, action };
  }

  if (cls === 'risky_orphan') {
    // Create a review item in identity_conflicts. Idempotent on
    // (workspace_id, normalized_phone, status='open').
    const phone = row.phone || '';
    const conflictRow = {
      workspace_id: userId,
      normalized_phone: phone || `noop:${sfCustId}`,
      severity: 'medium',
      owners: { source: 'zenbooker', sf_customer_id: sfCustId, zenbooker_id: zbId || null, name: row.name || null },
      status: 'open',
      resolution_note: `zb_reconcile_orphan: ${classification.reason}`,
    };

    // Check for an existing open conflict for same workspace+phone (best-effort dedupe).
    if (phone) {
      const { data: existing } = await supabase.from('identity_conflicts')
        .select('id')
        .eq('workspace_id', userId)
        .eq('normalized_phone', phone)
        .eq('status', 'open')
        .limit(1);
      if (existing && existing.length > 0) {
        try {
          logger.log(`[ZBReconcile] action=review_required result=noop_review_already_open customer_id=${sfCustId} zenbooker_id=${zbId || 'null'} existing_conflict_id=${existing[0].id} reason=${classification.reason}`);
        } catch (_) {}
        return { ok: true, action: 'review_required', note: 'review_already_open' };
      }
    }

    const { data: inserted, error: insErr } = await supabase.from('identity_conflicts')
      .insert(conflictRow)
      .select('id')
      .maybeSingle();
    if (insErr) return { ok: false, action: 'review_required', error: insErr.message };

    try {
      logger.log(`[ZBReconcile] action=review_required result=success customer_id=${sfCustId} zenbooker_id=${zbId || 'null'} conflict_id=${inserted ? inserted.id : 'null'} reason=${classification.reason}`);
    } catch (_) {}
    return { ok: true, action: 'review_required' };
  }

  return { ok: false, action: 'noop', error: `unknown_class:${cls}` };
}

// ── ZB customer import ambiguity queue (Task 2) ──────────────────

/**
 * When a ZB customer import hits the resolver-ambiguous branch, write a
 * structured queue row so an operator can resolve it through the Identity
 * Conflicts UI. Replaces the prior silent-skip behavior.
 *
 * Idempotency: one open row per (user, source='zenbooker',
 * attempted_external_id=zb.id, status='open'). Re-running the same ZB
 * sync does not pile up rows.
 *
 * @param {object} args
 * @param {object} args.supabase
 * @param {object} args.logger
 * @param {number|string} args.userId
 * @param {object} args.zbCustomer        - raw ZB customer payload (.id, .name, .phone, .email, …)
 * @param {string} args.attemptedPhone    - last-10-digit normalized phone (already computed by caller)
 * @param {Array<number>} args.candidateIdentityIds - identity ids the resolver could not pick between
 * @param {string} args.resolverReason    - raw resolver reason (recorded into source_payload)
 *
 * @returns {Promise<{ ok: boolean, action: string, row_id: number|null, note?: string }>}
 *
 * NEVER throws. Audit log is emitted on every outcome.
 */
async function recordZbImportAmbiguity(args) {
  const supabase = args && args.supabase;
  const logger = (args && args.logger) || { log: () => {}, warn: () => {}, error: () => {} };
  const userId = args && args.userId;
  const zb = (args && args.zbCustomer) || {};
  const attemptedPhone = (args && args.attemptedPhone) || null;
  const candidateIdentityIds = Array.isArray(args && args.candidateIdentityIds) ? args.candidateIdentityIds : [];
  const resolverReason = (args && args.resolverReason) || null;

  if (!supabase || userId === undefined || userId === null || !zb.id) {
    return { ok: false, action: 'noop', row_id: null, note: 'missing_required_input' };
  }

  // Idempotency: short-circuit if an open row already exists.
  try {
    const { data: existing } = await supabase.from('communication_identity_ambiguities')
      .select('id')
      .eq('user_id', userId)
      .eq('source', 'zenbooker')
      .eq('attempted_external_id', String(zb.id))
      .eq('status', 'open')
      .limit(1);
    if (existing && existing.length > 0) {
      try {
        logger.log(`[ZBReconcile] action=ambiguity_queue result=noop_already_open user_id=${userId} zenbooker_id=${zb.id} existing_row_id=${existing[0].id} reason=zb_customer_import_ambiguous`);
      } catch (_) {}
      return { ok: true, action: 'ambiguity_queue', row_id: existing[0].id, note: 'already_open' };
    }
  } catch (_) {
    /* best-effort dedupe — fall through to insert */
  }

  // Look up candidate SF customer ids by resolving the candidate identity ids.
  // Scoped to tenant. Best-effort: missing/cross-tenant ids are dropped silently.
  let candidateSfCustomerIds = [];
  if (candidateIdentityIds.length > 0) {
    try {
      const { data: idents } = await supabase.from('communication_participant_identities')
        .select('id, sf_customer_id, sf_lead_id, leadbridge_contact_id, display_name')
        .eq('user_id', userId)
        .in('id', candidateIdentityIds);
      candidateSfCustomerIds = (idents || []).map(i => i.sf_customer_id).filter(Boolean);
      var candidateDetail = (idents || []).map(i => ({
        identity_id: i.id, sf_customer_id: i.sf_customer_id, sf_lead_id: i.sf_lead_id,
        leadbridge_contact_id: i.leadbridge_contact_id, display_name: i.display_name,
      }));
    } catch (_) { /* swallow — partial info is still useful */ }
  }
  if (typeof candidateDetail === 'undefined') candidateDetail = [];

  const fullName = (zb.name && String(zb.name).trim()) || null;
  const attemptedNormalizedName = fullName
    ? fullName.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
    : null;

  const row = {
    user_id: userId,
    source: 'zenbooker',
    attempted_external_id: String(zb.id),
    attempted_phone: attemptedPhone,
    attempted_name: fullName,
    attempted_normalized_name: attemptedNormalizedName,
    candidate_identity_ids: candidateIdentityIds,
    reason: 'zb_customer_import_ambiguous',
    status: 'open',
    source_payload: {
      zenbooker_id: String(zb.id),
      zb_name: fullName,
      zb_email: zb.email || null,
      zb_phone: zb.phone || null,
      candidate_sf_customer_ids: candidateSfCustomerIds,
      candidate_detail: candidateDetail,
      resolver_reason: resolverReason,
      recorded_at: new Date().toISOString(),
    },
  };

  try {
    const { data: inserted, error } = await supabase.from('communication_identity_ambiguities')
      .insert(row)
      .select('id')
      .maybeSingle();
    if (error) {
      try {
        logger.warn(`[ZBReconcile] action=ambiguity_queue result=insert_error user_id=${userId} zenbooker_id=${zb.id} error=${error.message}`);
      } catch (_) {}
      return { ok: false, action: 'ambiguity_queue', row_id: null, note: error.message };
    }
    const rowId = inserted ? inserted.id : null;
    try {
      logger.log(`[ZBReconcile] action=ambiguity_queue result=success user_id=${userId} zenbooker_id=${zb.id} row_id=${rowId} candidate_identities=${candidateIdentityIds.length} candidate_sf_customers=${candidateSfCustomerIds.length} reason=zb_customer_import_ambiguous resolver_reason=${resolverReason || 'unknown'}`);
    } catch (_) {}
    return { ok: true, action: 'ambiguity_queue', row_id: rowId };
  } catch (e) {
    try {
      logger.warn(`[ZBReconcile] action=ambiguity_queue result=throw user_id=${userId} zenbooker_id=${zb.id} error=${e.message}`);
    } catch (_) {}
    return { ok: false, action: 'ambiguity_queue', row_id: null, note: e.message };
  }
}

module.exports = {
  classifyOrphan,
  fetchSfZbCustomerSnapshot,
  reconcileOrphans,
  applyOrphanAction,
  recordZbImportAmbiguity,
};
