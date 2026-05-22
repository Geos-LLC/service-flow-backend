'use strict';

/**
 * Identity Linker — projection + setter layer.
 *
 * Phase 0 of the cross-source identity reconciliation work (2026-05-21).
 * See docs/architecture/cross-source-identity-reconciliation.md for the
 * full design.
 *
 * THIS MODULE IS NOT A MATCHER. The canonical matcher is
 * lib/identity-resolver.js. Per the approved architecture:
 *
 *   - resolveIdentity() decides "are these the same person?" — writes
 *     to communication_participant_identities only.
 *   - This module decides "now that the identity graph says they are
 *     the same person, write the CRM business link" — writes to
 *     leads.converted_customer_id only.
 *
 * Three responsibilities, in order:
 *
 *   1. setIdentityCustomer(supabase, logger, opts) — guarded write of
 *      sf_customer_id on a known identity row. Idempotent. After
 *      writing, reads the fresh row and calls projectIdentityToCRM
 *      automatically when both sides are populated.
 *
 *   2. setIdentityLead(supabase, logger, opts) — symmetric for sf_lead_id.
 *
 *   3. projectIdentityToCRM(supabase, logger, identityRow, policy) —
 *      pure projection. No matching, no scoring. Writes
 *      leads.converted_customer_id when:
 *        - identity has both sf_lead_id and sf_customer_id
 *        - lead.converted_customer_id IS NULL
 *        - same tenant on both sides
 *      Emits [IdentityLink] structured log + identity_link_audit row.
 *
 * Plus one operator-override path:
 *
 *   applyLeadCustomerLink(supabase, logger, opts) — explicit
 *   "link this lead to this customer" from the operator UI. Skips
 *   identity-row reasoning; trusts the caller. Still tenant-scoped.
 *
 * Plus one freeze switch:
 *
 *   IDENTITY_PROJECTION_FREEZE=true halts projection writes. Setters
 *   still update the identity graph; projection returns
 *   { projected: false, reason: 'freeze' } and emits a metric.
 *
 * Invariants (see Investigation D):
 *   I1. Cross-tenant link impossible — every UPDATE filters by user_id.
 *   I2. One lead never auto-converts to multiple customers — projection
 *       requires converted_customer_id IS NULL.
 *   I3/I4. Projection touches ONLY converted_customer_id + converted_at +
 *       updated_at. Never lead.source / lead_cost / created_at / utm_*.
 *   I5. Every auto-link writes an identity_link_audit row (reversible).
 *   I6. (new) One acquisition event must always produce one preserved
 *       acquisition record. Enforced upstream in LB ingestion (see
 *       docs/architecture/lead-cardinality-and-parent-lead-id.md).
 *       This module never deletes a lead.
 */

const { FLAGS, isEnabled } = require('./feature-flags');

// ── Structured log emit (Loki-aggregated counters) ────────────────

/**
 * Canonical projection metric shape. Counters are derived in Loki via
 *   count_over_time({service_name="service-flow-backend"} |= "[IdentityLink]" | event="..." | outcome="..." [5m])
 *
 * Fields:
 *   event             — set_customer | set_lead | project |
 *                       retroactive_apply | retroactive_dryrun |
 *                       operator_override
 *   outcome           — success | idempotent | collision | refused |
 *                       ambiguous | no_op_one_side_missing |
 *                       lead_already_linked_to_other | freeze | invalid_input |
 *                       cross_tenant_blocked | lead_not_found | update_failed
 *   tenant            — userId (required)
 *   identity_id       — identity row id (null when none)
 *   lead_id, customer_id — when known
 *   resolved_by       — automatic | operator_override | retroactive_repair |
 *                       ambiguity_resolution | source_projection
 *   resolution_reason — short tag (e.g., identity_graph_projection)
 *   source            — calling source (zenbooker | leadbridge | openphone | repair | operator)
 *   duration_ms       — optional
 */
function emitProjectionMetric(logger, {
  event,
  outcome,
  tenant,
  identityId = null,
  leadId = null,
  customerId = null,
  resolvedBy = 'automatic',
  resolutionReason = 'source_projection',
  source = 'unknown',
  reason = null,
  durationMs = null,
}) {
  if (!logger || typeof logger.log !== 'function') return;
  const parts = [
    `event=${event}`,
    `outcome=${outcome}`,
    `tenant=${tenant != null ? tenant : 'null'}`,
    `identity_id=${identityId != null ? identityId : 'null'}`,
    `lead_id=${leadId != null ? leadId : 'null'}`,
    `customer_id=${customerId != null ? customerId : 'null'}`,
    `source=${source}`,
    `resolved_by=${resolvedBy}`,
    `resolution_reason=${resolutionReason}`,
    reason != null ? `reason=${reason}` : null,
    durationMs != null ? `duration_ms=${durationMs}` : null,
  ].filter(Boolean);
  try {
    logger.log(`[IdentityLink] ${parts.join(' ')}`);
  } catch (_) { /* never throw out of logging */ }
}

// ── Audit row ─────────────────────────────────────────────────────

async function writeAuditRow(supabase, logger, {
  userId,
  leadId,
  customerId,
  identityId = null,
  resolvedBy,
  resolutionReason,
  nameClass = null,
  phoneMatch = null,
  sourceCompat = null,
  notes = null,
}) {
  try {
    const { error } = await supabase
      .from('identity_link_audit')
      .insert({
        user_id: userId,
        lead_id: leadId,
        customer_id: customerId,
        identity_id: identityId,
        resolved_by: resolvedBy,
        resolution_reason: resolutionReason,
        name_class: nameClass,
        phone_match: phoneMatch,
        source_compat: sourceCompat,
        notes,
      });
    if (error) {
      // Unique violation on (lead_id, customer_id) is acceptable — means
      // a prior pass already audited this pair. Project still treats
      // the write as success because the link itself was written.
      if (error.code === '23505' || /duplicate key|unique/i.test(error.message || '')) {
        return { ok: true, idempotent: true };
      }
      if (logger?.warn) logger.warn(`[IdentityLink] audit insert failed lead=${leadId} cust=${customerId}: ${error.message}`);
      return { ok: false, error: error.message };
    }
    return { ok: true };
  } catch (e) {
    if (logger?.warn) logger.warn(`[IdentityLink] audit insert threw lead=${leadId} cust=${customerId}: ${e?.message}`);
    return { ok: false, error: e?.message };
  }
}

// ── Projection (pure: no settings reads, no scoring, no resolver calls) ──

/**
 * Project an identity row's (sf_lead_id, sf_customer_id) pair onto the
 * CRM business link `leads.converted_customer_id`.
 *
 * Pure consumer of identity graph state. Does NOT match. Does NOT score.
 * Does NOT read tenant settings — policy is passed by the caller.
 *
 * @param {Object} supabase
 * @param {Object} logger
 * @param {Object} identityRow            communication_participant_identities row
 *   - id, user_id, sf_lead_id, sf_customer_id (required for projection)
 * @param {Object} policy
 *   - allowStageMove   (default false) — opt-in, only when caller confirmed
 *                       via tenant setting at the call site
 *   - resolvedBy       — automatic|operator_override|retroactive_repair|
 *                        ambiguity_resolution|source_projection
 *   - resolutionReason — e.g., 'identity_graph_projection'
 *   - source           — calling layer (zenbooker|leadbridge|openphone|repair|operator)
 *
 * @returns { projected, reason, lead_id?, customer_id? }
 */
async function projectIdentityToCRM(supabase, logger, identityRow, policy = {}) {
  const start = Date.now();
  const {
    allowStageMove = false,
    resolvedBy = 'automatic',
    resolutionReason = 'source_projection',
    source = 'unknown',
  } = policy;

  if (!identityRow) {
    emitProjectionMetric(logger, { event: 'project', outcome: 'invalid_input', tenant: null, source, resolvedBy, resolutionReason, reason: 'no_identity_row' });
    return { projected: false, reason: 'no_identity_row' };
  }
  const { id: identityId, user_id: userId, sf_lead_id: sfLeadId, sf_customer_id: sfCustomerId } = identityRow;

  if (!sfLeadId || !sfCustomerId) {
    emitProjectionMetric(logger, { event: 'project', outcome: 'no_op_one_side_missing', tenant: userId, identityId, leadId: sfLeadId, customerId: sfCustomerId, source, resolvedBy, resolutionReason });
    return { projected: false, reason: 'one_side_missing' };
  }

  // Freeze switch — operational containment. Resolver and setters keep working.
  if (isEnabled(FLAGS.IDENTITY_PROJECTION_FREEZE)) {
    emitProjectionMetric(logger, { event: 'project', outcome: 'freeze', tenant: userId, identityId, leadId: sfLeadId, customerId: sfCustomerId, source, resolvedBy, resolutionReason });
    return { projected: false, reason: 'freeze' };
  }

  // I1: cross-tenant guard. Verify the customer belongs to the same tenant
  // as the identity (which is also the tenant the lead must live in).
  // Identity row has user_id = lead's user_id by construction; we re-check
  // the customer because identities are user-scoped but FK is global.
  try {
    const { data: customer } = await supabase
      .from('customers')
      .select('id, user_id')
      .eq('id', sfCustomerId)
      .maybeSingle();
    if (!customer) {
      emitProjectionMetric(logger, { event: 'project', outcome: 'refused', tenant: userId, identityId, leadId: sfLeadId, customerId: sfCustomerId, source, resolvedBy, resolutionReason, reason: 'customer_not_found' });
      return { projected: false, reason: 'customer_not_found' };
    }
    if (Number(customer.user_id) !== Number(userId)) {
      emitProjectionMetric(logger, { event: 'project', outcome: 'cross_tenant_blocked', tenant: userId, identityId, leadId: sfLeadId, customerId: sfCustomerId, source, resolvedBy, resolutionReason });
      if (logger?.error) logger.error(`[IdentityLinkInvariantViolation] cross-tenant projection attempt identity_user=${userId} customer_user=${customer.user_id} identity_id=${identityId}`);
      return { projected: false, reason: 'cross_tenant_blocked' };
    }
  } catch (e) {
    if (logger?.warn) logger.warn(`[IdentityLink] tenant verify threw: ${e?.message}`);
    emitProjectionMetric(logger, { event: 'project', outcome: 'refused', tenant: userId, identityId, leadId: sfLeadId, customerId: sfCustomerId, source, resolvedBy, resolutionReason, reason: 'tenant_verify_error' });
    return { projected: false, reason: 'tenant_verify_error' };
  }

  // I2: guarded write — only set when converted_customer_id IS NULL.
  // I3/I4: write list strictly limited to converted_customer_id, converted_at, updated_at.
  const now = new Date().toISOString();
  let writtenLeadId = null;
  try {
    const { data: written, error } = await supabase
      .from('leads')
      .update({
        converted_customer_id: sfCustomerId,
        converted_at: now,
        updated_at: now,
      })
      .eq('id', sfLeadId)
      .eq('user_id', userId)
      .is('converted_customer_id', null)
      .select('id');
    if (error) {
      emitProjectionMetric(logger, { event: 'project', outcome: 'update_failed', tenant: userId, identityId, leadId: sfLeadId, customerId: sfCustomerId, source, resolvedBy, resolutionReason, reason: error.message });
      if (logger?.error) logger.error(`[IdentityLink] lead UPDATE failed lead=${sfLeadId} cust=${sfCustomerId}: ${error.message}`);
      return { projected: false, reason: 'update_failed', error: error.message };
    }
    writtenLeadId = (written && written[0]) ? written[0].id : null;
  } catch (e) {
    if (logger?.error) logger.error(`[IdentityLink] lead UPDATE threw lead=${sfLeadId} cust=${sfCustomerId}: ${e?.message}`);
    emitProjectionMetric(logger, { event: 'project', outcome: 'update_failed', tenant: userId, identityId, leadId: sfLeadId, customerId: sfCustomerId, source, resolvedBy, resolutionReason, reason: e?.message });
    return { projected: false, reason: 'update_failed', error: e?.message };
  }

  // No row written → either lead is missing OR already converted.
  if (!writtenLeadId) {
    let currentLead = null;
    try {
      const { data } = await supabase.from('leads').select('id, converted_customer_id').eq('id', sfLeadId).eq('user_id', userId).maybeSingle();
      currentLead = data;
    } catch (_) { /* best-effort diagnosis */ }
    if (!currentLead) {
      emitProjectionMetric(logger, { event: 'project', outcome: 'lead_not_found', tenant: userId, identityId, leadId: sfLeadId, customerId: sfCustomerId, source, resolvedBy, resolutionReason });
      return { projected: false, reason: 'lead_not_found' };
    }
    if (Number(currentLead.converted_customer_id) === Number(sfCustomerId)) {
      // Already linked to same customer — idempotent.
      // Still ensure an audit row exists for this pair.
      await writeAuditRow(supabase, logger, { userId, leadId: sfLeadId, customerId: sfCustomerId, identityId, resolvedBy, resolutionReason: resolutionReason + '_idempotent' });
      emitProjectionMetric(logger, { event: 'project', outcome: 'idempotent', tenant: userId, identityId, leadId: sfLeadId, customerId: sfCustomerId, source, resolvedBy, resolutionReason, durationMs: Date.now() - start });
      return { projected: false, reason: 'idempotent_already_linked', lead_id: sfLeadId, customer_id: sfCustomerId };
    }
    // Linked to a DIFFERENT customer — I2 invariant prevents overwrite.
    emitProjectionMetric(logger, { event: 'project', outcome: 'lead_already_linked_to_other', tenant: userId, identityId, leadId: sfLeadId, customerId: sfCustomerId, source, resolvedBy, resolutionReason, reason: `existing=${currentLead.converted_customer_id}` });
    if (logger?.warn) logger.warn(`[IdentityLink] refused lead=${sfLeadId} cust=${sfCustomerId}: lead already converted to ${currentLead.converted_customer_id}`);
    return { projected: false, reason: 'lead_already_linked_to_other', current_customer_id: currentLead.converted_customer_id };
  }

  // Successful projection — write audit + emit success metric.
  await writeAuditRow(supabase, logger, { userId, leadId: sfLeadId, customerId: sfCustomerId, identityId, resolvedBy, resolutionReason });

  // OPTIONAL stage move (per-tenant policy passed by caller — projection itself reads no settings).
  if (allowStageMove) {
    try {
      const { data: lead } = await supabase.from('leads').select('pipeline_id').eq('id', sfLeadId).eq('user_id', userId).maybeSingle();
      if (lead?.pipeline_id) {
        const { data: stages } = await supabase.from('lead_stages')
          .select('id, name, position')
          .eq('pipeline_id', lead.pipeline_id)
          .order('position', { ascending: false });
        const wonStage = (stages || []).find(s => /won|converted|closed/i.test(s.name || ''));
        if (wonStage) {
          await supabase.from('leads').update({ stage_id: wonStage.id }).eq('id', sfLeadId).eq('user_id', userId);
        }
      }
    } catch (e) {
      if (logger?.warn) logger.warn(`[IdentityLink] stage move (best-effort) failed lead=${sfLeadId}: ${e?.message}`);
    }
  }

  // Archive the lead's phone-identity-registry entry so any open conflict
  // auto-resolves. Best-effort; failure is non-fatal.
  try {
    await supabase.rpc('pir_archive_entity', {
      p_workspace_id: userId,
      p_entity_type: 'lead',
      p_entity_id: String(sfLeadId),
    });
  } catch (_) { /* best-effort */ }

  emitProjectionMetric(logger, { event: 'project', outcome: 'success', tenant: userId, identityId, leadId: sfLeadId, customerId: sfCustomerId, source, resolvedBy, resolutionReason, durationMs: Date.now() - start });
  return { projected: true, lead_id: sfLeadId, customer_id: sfCustomerId, identity_id: identityId };
}

// ── Setters (the only paths that write sf_lead_id / sf_customer_id) ──

/**
 * Set identity.sf_customer_id atomically + project if both sides populated.
 *
 * @param opts
 *   - userId           required (tenant scope)
 *   - identityId       required
 *   - customerId       required
 *   - policy           passed through to projection (allowStageMove, resolvedBy, resolutionReason, source)
 *   - identitySnapshot optional — pre-fetched identity row. Avoids one re-read.
 */
async function setIdentityCustomer(supabase, logger, opts) {
  const { userId, identityId, customerId, policy = {}, identitySnapshot = null } = opts || {};
  if (userId == null || identityId == null || customerId == null) {
    emitProjectionMetric(logger, { event: 'set_customer', outcome: 'invalid_input', tenant: userId, identityId, customerId, source: policy.source || 'unknown', resolvedBy: policy.resolvedBy, resolutionReason: policy.resolutionReason });
    return { ok: false, reason: 'invalid_input' };
  }

  // Guarded update — only when the slot is empty OR already set to the same value.
  // This is the race-safe pattern: two webhooks racing on the same identity
  // produce one winner; the loser sees the row already set and bails idempotently.
  const now = new Date().toISOString();
  // Determine target status given current sf_lead_id state. Two-step but
  // safe because we use guarded UPDATE; if a concurrent writer changes
  // sf_lead_id between read and write, the projection re-reads anyway.
  const lookup = identitySnapshot
    || (await supabase.from('communication_participant_identities')
          .select('id, user_id, sf_lead_id, sf_customer_id')
          .eq('id', identityId).eq('user_id', userId).maybeSingle()).data;
  if (!lookup) {
    emitProjectionMetric(logger, { event: 'set_customer', outcome: 'refused', tenant: userId, identityId, customerId, reason: 'identity_not_found', source: policy.source, resolvedBy: policy.resolvedBy, resolutionReason: policy.resolutionReason });
    return { ok: false, reason: 'identity_not_found' };
  }
  const nextStatus = lookup.sf_lead_id ? 'resolved_both' : 'resolved_customer';

  const { data: updated, error } = await supabase
    .from('communication_participant_identities')
    .update({ sf_customer_id: customerId, status: nextStatus, updated_at: now })
    .eq('id', identityId)
    .eq('user_id', userId)
    .or(`sf_customer_id.is.null,sf_customer_id.eq.${customerId}`)
    .select('id, user_id, sf_lead_id, sf_customer_id, status')
    .maybeSingle();
  if (error) {
    if (logger?.error) logger.error(`[IdentityLink] setIdentityCustomer UPDATE failed identity=${identityId}: ${error.message}`);
    emitProjectionMetric(logger, { event: 'set_customer', outcome: 'update_failed', tenant: userId, identityId, customerId, reason: error.message, source: policy.source, resolvedBy: policy.resolvedBy, resolutionReason: policy.resolutionReason });
    return { ok: false, reason: 'update_failed', error: error.message };
  }
  if (!updated) {
    // Collision: identity already has a different customer.
    emitProjectionMetric(logger, { event: 'set_customer', outcome: 'collision', tenant: userId, identityId, customerId, source: policy.source, resolvedBy: policy.resolvedBy, resolutionReason: policy.resolutionReason });
    if (logger?.warn) logger.warn(`[IdentityLink] setIdentityCustomer collision identity=${identityId} incoming_customer=${customerId}`);
    return { ok: false, reason: 'collision' };
  }

  emitProjectionMetric(logger, { event: 'set_customer', outcome: 'success', tenant: userId, identityId, customerId, leadId: updated.sf_lead_id, source: policy.source, resolvedBy: policy.resolvedBy, resolutionReason: policy.resolutionReason });

  // Project to CRM if both sides now populated. setIdentityCustomer is the
  // only authorized projection trigger from the customer-side.
  const projection = await projectIdentityToCRM(supabase, logger, updated, policy);
  return { ok: true, identity: updated, projection };
}

/**
 * Set identity.sf_lead_id atomically + project if both sides populated.
 * Mirror of setIdentityCustomer.
 */
async function setIdentityLead(supabase, logger, opts) {
  const { userId, identityId, leadId, policy = {}, identitySnapshot = null } = opts || {};
  if (userId == null || identityId == null || leadId == null) {
    emitProjectionMetric(logger, { event: 'set_lead', outcome: 'invalid_input', tenant: userId, identityId, leadId, source: policy.source || 'unknown', resolvedBy: policy.resolvedBy, resolutionReason: policy.resolutionReason });
    return { ok: false, reason: 'invalid_input' };
  }

  const now = new Date().toISOString();
  const lookup = identitySnapshot
    || (await supabase.from('communication_participant_identities')
          .select('id, user_id, sf_lead_id, sf_customer_id')
          .eq('id', identityId).eq('user_id', userId).maybeSingle()).data;
  if (!lookup) {
    emitProjectionMetric(logger, { event: 'set_lead', outcome: 'refused', tenant: userId, identityId, leadId, reason: 'identity_not_found', source: policy.source, resolvedBy: policy.resolvedBy, resolutionReason: policy.resolutionReason });
    return { ok: false, reason: 'identity_not_found' };
  }
  const nextStatus = lookup.sf_customer_id ? 'resolved_both' : 'resolved_lead';

  const { data: updated, error } = await supabase
    .from('communication_participant_identities')
    .update({ sf_lead_id: leadId, status: nextStatus, updated_at: now })
    .eq('id', identityId)
    .eq('user_id', userId)
    .or(`sf_lead_id.is.null,sf_lead_id.eq.${leadId}`)
    .select('id, user_id, sf_lead_id, sf_customer_id, status')
    .maybeSingle();
  if (error) {
    if (logger?.error) logger.error(`[IdentityLink] setIdentityLead UPDATE failed identity=${identityId}: ${error.message}`);
    emitProjectionMetric(logger, { event: 'set_lead', outcome: 'update_failed', tenant: userId, identityId, leadId, reason: error.message, source: policy.source, resolvedBy: policy.resolvedBy, resolutionReason: policy.resolutionReason });
    return { ok: false, reason: 'update_failed', error: error.message };
  }
  if (!updated) {
    emitProjectionMetric(logger, { event: 'set_lead', outcome: 'collision', tenant: userId, identityId, leadId, source: policy.source, resolvedBy: policy.resolvedBy, resolutionReason: policy.resolutionReason });
    if (logger?.warn) logger.warn(`[IdentityLink] setIdentityLead collision identity=${identityId} incoming_lead=${leadId}`);
    return { ok: false, reason: 'collision' };
  }

  emitProjectionMetric(logger, { event: 'set_lead', outcome: 'success', tenant: userId, identityId, leadId, customerId: updated.sf_customer_id, source: policy.source, resolvedBy: policy.resolvedBy, resolutionReason: policy.resolutionReason });

  const projection = await projectIdentityToCRM(supabase, logger, updated, policy);
  return { ok: true, identity: updated, projection };
}

// ── Operator override path (UI: "Link lead → customer") ───────────

/**
 * Explicit operator-initiated link. Bypasses identity-graph reasoning;
 * trusts the caller's pairing. Still tenant-scoped + still refuses to
 * overwrite a lead already linked to a different customer (use the
 * customer-merge action for that). Writes audit row with
 * resolved_by='operator_override'.
 */
async function applyLeadCustomerLink(supabase, logger, { userId, leadId, customerId, reasonsHint = [] } = {}) {
  if (userId == null || leadId == null || customerId == null) {
    emitProjectionMetric(logger, { event: 'operator_override', outcome: 'invalid_input', tenant: userId, leadId, customerId, source: 'operator', resolvedBy: 'operator_override', resolutionReason: 'operator_apply' });
    return { ok: false, error: 'invalid_input' };
  }
  if (isEnabled(FLAGS.IDENTITY_PROJECTION_FREEZE)) {
    emitProjectionMetric(logger, { event: 'operator_override', outcome: 'freeze', tenant: userId, leadId, customerId, source: 'operator', resolvedBy: 'operator_override', resolutionReason: 'operator_apply' });
    return { ok: false, error: 'freeze' };
  }

  // I1: tenant-scoped both reads.
  const { data: existing } = await supabase
    .from('leads')
    .select('id, user_id, converted_customer_id')
    .eq('user_id', userId)
    .eq('id', leadId)
    .maybeSingle();
  if (!existing) {
    emitProjectionMetric(logger, { event: 'operator_override', outcome: 'lead_not_found', tenant: userId, leadId, customerId, source: 'operator', resolvedBy: 'operator_override', resolutionReason: 'operator_apply' });
    return { ok: false, error: 'lead_not_found' };
  }
  if (existing.converted_customer_id != null && String(existing.converted_customer_id) !== String(customerId)) {
    emitProjectionMetric(logger, { event: 'operator_override', outcome: 'lead_already_linked_to_other', tenant: userId, leadId, customerId, source: 'operator', resolvedBy: 'operator_override', resolutionReason: 'operator_apply', reason: `existing=${existing.converted_customer_id}` });
    return { ok: false, error: 'lead_already_converted', current: existing.converted_customer_id };
  }
  if (existing.converted_customer_id != null) {
    // Idempotent — same target.
    await writeAuditRow(supabase, logger, { userId, leadId, customerId, resolvedBy: 'operator_override', resolutionReason: 'operator_apply_idempotent' });
    emitProjectionMetric(logger, { event: 'operator_override', outcome: 'idempotent', tenant: userId, leadId, customerId, source: 'operator', resolvedBy: 'operator_override', resolutionReason: 'operator_apply' });
    return { ok: true, idempotent: true, lead_id: leadId, customer_id: customerId };
  }

  // Verify customer in same tenant (I1).
  const { data: customer } = await supabase.from('customers').select('id, user_id').eq('id', customerId).maybeSingle();
  if (!customer) {
    emitProjectionMetric(logger, { event: 'operator_override', outcome: 'refused', tenant: userId, leadId, customerId, source: 'operator', resolvedBy: 'operator_override', resolutionReason: 'operator_apply', reason: 'customer_not_found' });
    return { ok: false, error: 'customer_not_found' };
  }
  if (Number(customer.user_id) !== Number(userId)) {
    emitProjectionMetric(logger, { event: 'operator_override', outcome: 'cross_tenant_blocked', tenant: userId, leadId, customerId, source: 'operator', resolvedBy: 'operator_override', resolutionReason: 'operator_apply' });
    if (logger?.error) logger.error(`[IdentityLinkInvariantViolation] operator cross-tenant attempt user=${userId} customer_user=${customer.user_id}`);
    return { ok: false, error: 'cross_tenant_blocked' };
  }

  const now = new Date().toISOString();
  const { error } = await supabase
    .from('leads')
    .update({
      converted_customer_id: customerId,
      converted_at: now,
      updated_at: now,
    })
    .eq('id', leadId)
    .eq('user_id', userId)
    .is('converted_customer_id', null);
  if (error) {
    if (logger?.error) logger.error(`[IdentityLink] operator override update failed lead=${leadId} cust=${customerId}: ${error.message}`);
    emitProjectionMetric(logger, { event: 'operator_override', outcome: 'update_failed', tenant: userId, leadId, customerId, source: 'operator', resolvedBy: 'operator_override', resolutionReason: 'operator_apply', reason: error.message });
    return { ok: false, error: error.message };
  }
  await writeAuditRow(supabase, logger, { userId, leadId, customerId, resolvedBy: 'operator_override', resolutionReason: (reasonsHint || []).join(',') || 'operator_apply' });
  try {
    await supabase.rpc('pir_archive_entity', {
      p_workspace_id: userId,
      p_entity_type: 'lead',
      p_entity_id: String(leadId),
    });
  } catch (_) { /* best-effort */ }
  emitProjectionMetric(logger, { event: 'operator_override', outcome: 'success', tenant: userId, leadId, customerId, source: 'operator', resolvedBy: 'operator_override', resolutionReason: 'operator_apply' });
  return { ok: true, lead_id: leadId, customer_id: customerId };
}

module.exports = {
  setIdentityCustomer,
  setIdentityLead,
  projectIdentityToCRM,
  applyLeadCustomerLink,
  emitProjectionMetric,
  writeAuditRow,
};
