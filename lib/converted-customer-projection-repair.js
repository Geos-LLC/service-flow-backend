'use strict';

// Lead → Customer projection repair helper.
//
// Background: lib/identity-backfill.js historically wrote
// communication_participant_identities.sf_customer_id via a raw UPDATE
// that bypassed setIdentityCustomer (the @transitional path). When the
// identity already had sf_lead_id, the bypass also bypassed the projection
// cascade that would normally write leads.converted_customer_id. Result:
// 15 identities (as of 2026-05-24) had both sf_lead_id and sf_customer_id
// populated but their lead's converted_customer_id remained NULL.
//
// This module:
//   - Identifies affected identities (both sides set, lead missing/mismatched projection)
//   - Calls projectIdentityToCRM for each (the same code path setIdentityCustomer uses)
//   - Reports per-row outcome (success | noop_idempotent | conflict | skipped)
//
// Hard invariants (all enforced by projectIdentityToCRM):
//   - Tenant-scoped (cross-tenant block I1)
//   - Never overwrites a lead already converted to a DIFFERENT customer (I2)
//   - Only writes converted_customer_id, converted_at, updated_at (I3/I4)
//   - Idempotent: re-running converges to same state, no duplicate audit rows
//     (writeAuditRow upserts by (lead_id, customer_id) tuple inside identity-linker)
//
// Does NOT:
//   - Modify identity rows
//   - Merge ambiguities
//   - Touch source / source_raw / phone / email / name fields
//   - Move stage (allowStageMove: false)

const { projectIdentityToCRM } = require('./identity-linker');

const PAGE_SIZE = 500;

/**
 * Find all identities for a tenant where projection is missing.
 * READ-ONLY.
 *
 * @returns Array<{
 *   identity_id, sf_lead_id, sf_customer_id,
 *   current_converted_customer_id,   // null | number
 *   classification: 'missing' | 'mismatch'
 * }>
 */
async function findProjectionGaps(supabase, userId) {
  // Page through identities to avoid Supabase's default 1000-row cap.
  const gaps = [];
  let lastId = 0;
  while (true) {
    const { data, error } = await supabase
      .from('communication_participant_identities')
      .select('id, sf_lead_id, sf_customer_id')
      .eq('user_id', userId)
      .not('sf_lead_id', 'is', null)
      .not('sf_customer_id', 'is', null)
      .gt('id', lastId)
      .order('id', { ascending: true })
      .limit(PAGE_SIZE);
    if (error) throw new Error(`findProjectionGaps identity scan: ${error.message}`);
    if (!data || data.length === 0) break;

    // For each candidate identity, check the lead row's current converted_customer_id.
    const leadIds = data.map(d => d.sf_lead_id);
    const { data: leads, error: leadErr } = await supabase
      .from('leads')
      .select('id, converted_customer_id')
      .eq('user_id', userId)
      .in('id', leadIds);
    if (leadErr) throw new Error(`findProjectionGaps lead lookup: ${leadErr.message}`);
    const leadMap = new Map((leads || []).map(l => [l.id, l.converted_customer_id]));

    for (const ident of data) {
      const cur = leadMap.has(ident.sf_lead_id) ? leadMap.get(ident.sf_lead_id) : undefined;
      if (cur === undefined) continue; // lead missing — projectIdentityToCRM will report lead_not_found if applied
      if (cur === null) {
        gaps.push({
          identity_id: ident.id,
          sf_lead_id: ident.sf_lead_id,
          sf_customer_id: ident.sf_customer_id,
          current_converted_customer_id: null,
          classification: 'missing',
        });
      } else if (Number(cur) !== Number(ident.sf_customer_id)) {
        gaps.push({
          identity_id: ident.id,
          sf_lead_id: ident.sf_lead_id,
          sf_customer_id: ident.sf_customer_id,
          current_converted_customer_id: cur,
          classification: 'mismatch',
        });
      }
      // cur === sf_customer_id → already correct, no gap
    }

    lastId = data[data.length - 1].id;
    if (data.length < PAGE_SIZE) break;
  }
  return gaps;
}

/**
 * Apply projection for a single gap row. Returns the projection result shape
 * from projectIdentityToCRM, plus the input row + a normalized status.
 *
 * Status mapping:
 *   projected:true                            → 'success'
 *   reason:'idempotent_already_linked'        → 'noop_idempotent'
 *   reason:'lead_already_linked_to_other'     → 'conflict'   (preserve existing)
 *   reason:'cross_tenant_blocked'             → 'cross_tenant_blocked'  (would never happen if caller scopes by userId, but defended)
 *   reason:'lead_not_found'/'customer_not_found' → 'data_missing'
 *   reason:'freeze'                           → 'frozen'
 *   reason:'no_op_one_side_missing'           → 'noop_one_side_missing'
 *   anything else                             → 'error'
 */
async function applyOne(supabase, logger, userId, gap) {
  const projectionIdentity = {
    id: gap.identity_id,
    user_id: userId,
    sf_lead_id: gap.sf_lead_id,
    sf_customer_id: gap.sf_customer_id,
  };
  const result = await projectIdentityToCRM(supabase, logger, projectionIdentity, {
    resolvedBy: 'retroactive_repair',
    resolutionReason: 'identity_graph_projection',
    source: 'repair_converted_customer_projection',
    allowStageMove: false,
  });

  let status;
  if (result.projected) status = 'success';
  else if (result.reason === 'idempotent_already_linked') status = 'noop_idempotent';
  else if (result.reason === 'lead_already_linked_to_other') status = 'conflict';
  else if (result.reason === 'cross_tenant_blocked') status = 'cross_tenant_blocked';
  else if (result.reason === 'lead_not_found' || result.reason === 'customer_not_found') status = 'data_missing';
  else if (result.reason === 'freeze') status = 'frozen';
  else if (result.reason === 'no_op_one_side_missing') status = 'noop_one_side_missing';
  else status = 'error';

  // Structured log per spec.
  if (logger?.log) {
    logger.log(`[LeadProjection] action=project_converted_customer identity_id=${gap.identity_id} lead_id=${gap.sf_lead_id} customer_id=${gap.sf_customer_id} result=${status === 'success' ? 'success' : (status === 'noop_idempotent' ? 'noop' : (status === 'conflict' ? 'conflict' : status))}${status === 'conflict' ? ` existing=${result.current_customer_id}` : ''}`);
  }
  if (status === 'conflict' && logger?.warn) {
    logger.warn(`[LeadProjection] conflict — lead ${gap.sf_lead_id} already converted to customer ${result.current_customer_id}, refusing to overwrite with ${gap.sf_customer_id} (identity ${gap.identity_id})`);
  }

  return { ...gap, status, result };
}

/**
 * Run the repair across a tenant.
 *
 * @param opts.apply   boolean — false = dry-run (READ ONLY), true = perform writes
 * @returns {
 *   tenant_user_id, mode, found, success, noop_idempotent, conflict,
 *   data_missing, frozen, errors, samples: [up to 25 rows]
 * }
 */
async function repairTenant(supabase, logger, userId, { apply = false } = {}) {
  if (userId == null) throw new Error('repairTenant: userId is required');

  const gaps = await findProjectionGaps(supabase, userId);
  const summary = {
    tenant_user_id: userId,
    mode: apply ? 'apply' : 'dry-run',
    found: gaps.length,
    success: 0,
    noop_idempotent: 0,
    conflict: 0,
    data_missing: 0,
    frozen: 0,
    cross_tenant_blocked: 0,
    noop_one_side_missing: 0,
    errors: 0,
    samples: [],
  };
  if (gaps.length === 0) return summary;

  if (!apply) {
    // Dry-run: classify-only, no projection calls.
    for (const g of gaps) {
      const cls = g.classification === 'mismatch' ? 'conflict' : 'success';
      if (cls === 'conflict') summary.conflict++;
      else summary.success++; // would-succeed counter
      if (summary.samples.length < 25) summary.samples.push({ ...g, would_status: cls });
    }
    return summary;
  }

  for (const g of gaps) {
    const out = await applyOne(supabase, logger, userId, g);
    summary[out.status] = (summary[out.status] || 0) + 1;
    if (summary.samples.length < 25) summary.samples.push({
      identity_id: out.identity_id,
      sf_lead_id: out.sf_lead_id,
      sf_customer_id: out.sf_customer_id,
      status: out.status,
      reason: out.result?.reason || null,
    });
  }
  return summary;
}

module.exports = { findProjectionGaps, applyOne, repairTenant };
