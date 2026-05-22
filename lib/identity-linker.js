'use strict';

/**
 * Identity Linker — projection layer + scoring fallback (migration bridge).
 *
 * Phase 0 of the cross-source identity reconciliation work (2026-05-22).
 * See docs/architecture/cross-source-identity-reconciliation.md for the
 * full design.
 *
 * ARCHITECTURE (hybrid during migration)
 *
 *   The long-term authority is the identity graph (resolver-owned). The
 *   projection layer takes the graph's "same person?" verdict and writes
 *   leads.converted_customer_id. While the graph is still historically
 *   incomplete (legacy LB/ZB events that pre-date resolver wiring), a
 *   scoring fallback runs second to bridge the gap.
 *
 *   Precedence (per ZB sync / future adapter call sites):
 *
 *     1. Identity graph projection (authoritative)
 *           setIdentityCustomer / setIdentityLead → projectIdentityToCRM
 *
 *     2. Resolver ambiguity → STOP. Never run fallback when resolver
 *        already said "ambiguous" — the safer non-merge wins.
 *
 *     3. Scoring fallback (TEMPORARY migration bridge)
 *           attemptScoringFallback runs ONLY when the graph could not
 *           project. On HIGH + unambiguous + safety gates, it:
 *             a. links lead ↔ customer (guarded UPDATE),
 *             b. HYDRATES the identity graph (sets sf_lead_id +
 *                sf_customer_id on the identity row, if one exists),
 *             c. writes identity_link_audit with resolved_by='fallback_
 *                projection_bridge',
 *             d. emits [IdentityLink] mode=fallback_projection_bridge.
 *           The fallback is gated by IDENTITY_SCORING_FALLBACK_ENABLED
 *           (default ON globally; per-tenant opt-out via
 *           IDENTITY_SCORING_FALLBACK_TENANTS list when a tenant's
 *           graph has reached completeness).
 *
 *     4. No match → emit [IdentityLink] mode=no_match and stop.
 *
 *   The scoring helpers (scoreMatch / nameSimilarity / classifyChannel /
 *   findCandidateLeads) and the HIGH/MEDIUM thresholds are marked
 *   @transitional. They will be removed once the graph + backfill make
 *   the fallback unnecessary for every tenant.
 *
 * RESPONSIBILITIES (export surface)
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
 *   4. attemptScoringFallback(supabase, logger, opts) — @transitional
 *      migration-bridge auto-link. Only fires when graph cannot project.
 *      Hydrates identity graph on success.
 *
 *   5. applyLeadCustomerLink(supabase, logger, opts) — operator override.
 *      Explicit "link this lead to this customer" from the UI. Skips
 *      identity-row reasoning; trusts the caller. Still tenant-scoped.
 *
 * SWITCHES
 *
 *   IDENTITY_PROJECTION_FREEZE=true halts ALL projection writes (graph +
 *   fallback). Setters still update the identity graph; projection
 *   returns { projected:false, reason:'freeze' } and emits a metric.
 *
 *   IDENTITY_SCORING_FALLBACK_ENABLED=false globally disables the
 *   scoring fallback. Default ON. Per-tenant opt-out via
 *   IDENTITY_SCORING_FALLBACK_TENANTS=<csv> (tenants in the list have
 *   the fallback DISABLED — used when their graph reaches completeness).
 *
 * INVARIANTS (codified + tested)
 *
 *   I1. Cross-tenant link impossible — every UPDATE filters by user_id.
 *   I2. One lead never auto-converts to multiple customers — projection
 *       requires converted_customer_id IS NULL.
 *   I3/I4. Projection touches ONLY converted_customer_id + converted_at +
 *       updated_at. Never lead.source / lead_cost / created_at / utm_*.
 *       Fallback respects the same column whitelist.
 *   I5. Every auto-link writes an identity_link_audit row (reversible).
 *   I6. (new) One acquisition event must always produce one preserved
 *       acquisition record. Enforced upstream in LB ingestion (see
 *       docs/architecture/lead-cardinality-and-parent-lead-id.md).
 *       This module never deletes a lead.
 *   I7. Fallback respects ambiguity. Never runs when resolver flagged
 *       the participant as ambiguous, or when there's an open ambiguity
 *       row for the phone.
 *   I8. Fallback respects the active-window guard (default 24h). Never
 *       auto-links a HIGH candidate where both lead and customer were
 *       updated in the recent window.
 */

const { FLAGS, isEnabled, isFallbackEnabledForTenant } = require('./feature-flags');
const { shouldDowngradeForActiveWindow } = require('./retroactive-repair-guards');

// ─────────────────────────────────────────────────────────────────────
// SCORING HELPERS (@transitional — bridge during graph hydration)
//
// These match what HEAD (c658bff3) exported. They are restored here as
// part of the temporary fallback path. When the graph reaches
// completeness for every tenant, this section + attemptScoringFallback
// will be removed (and IDENTITY_SCORING_FALLBACK_TENANTS will list the
// tenants whose fallback is already disabled).
// ─────────────────────────────────────────────────────────────────────

const HIGH_CONFIDENCE_THRESHOLD = 75;
const MEDIUM_CONFIDENCE_THRESHOLD = 50;

/** @transitional Phone normalisation (last-10-digits). */
function normalizePhone(p) {
  if (p == null) return null;
  const digits = String(p).replace(/\D/g, '');
  if (digits.length === 0) return null;
  return digits.length >= 10 ? digits.slice(-10) : digits;
}

/** @transitional Classify a source string into a canonical channel. */
function classifyChannel(source) {
  const s = String(source || '').toLowerCase();
  if (s.includes('thumbtack')) return 'thumbtack';
  if (s.includes('yelp')) return 'yelp';
  if (s.includes('openphone')) return 'openphone';
  if (s.includes('leadbridge')) return 'leadbridge';
  if (s.includes('google')) return 'google';
  if (s.includes('facebook')) return 'facebook';
  if (s.includes('instagram')) return 'instagram';
  if (s.includes('referral')) return 'referral';
  if (s.includes('website') || s.includes('site request')) return 'website';
  if (s.includes('cold call')) return 'cold_call';
  return 'other';
}

/** @transitional Token-overlap (Jaccard) name similarity, 0..1. */
function nameSimilarity(a, b) {
  const tokenize = (s) =>
    String(s || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length >= 2);
  const aTokens = new Set(tokenize(a));
  const bTokens = new Set(tokenize(b));
  if (aTokens.size === 0 && bTokens.size === 0) return 0;
  if (aTokens.size === 0 || bTokens.size === 0) return 0;
  let intersect = 0;
  for (const t of aTokens) if (bTokens.has(t)) intersect++;
  const union = aTokens.size + bTokens.size - intersect;
  return union === 0 ? 0 : intersect / union;
}

/** @transitional Score a (customer, lead) candidate. */
function scoreMatch({ customerPhone, customerName, customerSource, lead }) {
  const reasons = [];
  let score = 0;

  const custLast10 = normalizePhone(customerPhone);
  const leadLast10 = normalizePhone(lead && lead.phone);
  if (!custLast10 || !leadLast10 || custLast10 !== leadLast10) {
    return { score: 0, confidence: 'low', reasons: ['phone_mismatch'] };
  }
  score += 50;
  reasons.push('phone_match');

  const custChan = classifyChannel(customerSource);
  const leadChan = classifyChannel(lead.source);
  if (custChan !== 'other' && leadChan !== 'other' && custChan === leadChan) {
    score += 25;
    reasons.push(`channel_match:${custChan}`);
  }

  const leadFullName = [lead.first_name, lead.last_name].filter(Boolean).join(' ').trim();
  const nameSim = nameSimilarity(customerName, leadFullName);
  if (nameSim >= 0.8) {
    score += 25;
    reasons.push(`name_match:${nameSim.toFixed(2)}`);
  } else if (nameSim >= 0.5) {
    score += 10;
    reasons.push(`name_partial:${nameSim.toFixed(2)}`);
  } else if (nameSim > 0) {
    reasons.push(`name_weak:${nameSim.toFixed(2)}`);
  } else {
    reasons.push('name_unknown');
  }

  const confidence = score >= HIGH_CONFIDENCE_THRESHOLD ? 'high'
    : score >= MEDIUM_CONFIDENCE_THRESHOLD ? 'medium'
    : 'low';

  return { score, confidence, reasons };
}

/** @transitional Find UNCONVERTED leads in the same tenant by phone (last-10). */
async function findCandidateLeads(supabase, userId, customerPhone) {
  const last10 = normalizePhone(customerPhone);
  if (!last10 || last10.length < 7) return [];
  if (!supabase) return [];
  try {
    const { data, error } = await supabase
      .from('leads')
      .select('id, first_name, last_name, phone, email, source, converted_customer_id, updated_at')
      .eq('user_id', userId)
      .is('converted_customer_id', null)
      .not('phone', 'is', null);
    if (error) return [];
    return (data || []).filter((l) => normalizePhone(l.phone) === last10);
  } catch (_) {
    return [];
  }
}

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
    emitLinkMode(logger, {
      mode: 'graph_projection',
      metric: !sfLeadId ? METRICS.GRAPH_PROJECTION_SKIPPED_MISSING_LEAD : METRICS.GRAPH_PROJECTION_SKIPPED_MISSING_CUSTOMER,
      tenant: userId, identityId, leadId: sfLeadId, customerId: sfCustomerId, source, reason: 'one_side_missing',
    });
    return { projected: false, reason: 'one_side_missing' };
  }

  // Freeze switch — operational containment. Resolver and setters keep working.
  if (isEnabled(FLAGS.IDENTITY_PROJECTION_FREEZE)) {
    emitProjectionMetric(logger, { event: 'project', outcome: 'freeze', tenant: userId, identityId, leadId: sfLeadId, customerId: sfCustomerId, source, resolvedBy, resolutionReason });
    emitLinkMode(logger, { mode: 'graph_projection', metric: METRICS.GRAPH_PROJECTION_SKIPPED_FROZEN, tenant: userId, identityId, leadId: sfLeadId, customerId: sfCustomerId, source });
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
      emitLinkMode(logger, { mode: 'graph_projection', metric: METRICS.GRAPH_PROJECTION_SKIPPED_REFUSED, tenant: userId, identityId, leadId: sfLeadId, customerId: sfCustomerId, source, reason: 'customer_not_found' });
      return { projected: false, reason: 'customer_not_found' };
    }
    if (Number(customer.user_id) !== Number(userId)) {
      emitProjectionMetric(logger, { event: 'project', outcome: 'cross_tenant_blocked', tenant: userId, identityId, leadId: sfLeadId, customerId: sfCustomerId, source, resolvedBy, resolutionReason });
      emitLinkMode(logger, { mode: 'graph_projection', metric: METRICS.GRAPH_PROJECTION_SKIPPED_REFUSED, tenant: userId, identityId, leadId: sfLeadId, customerId: sfCustomerId, source, reason: 'cross_tenant_blocked' });
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
  // High-level mode log — distinguishes graph-authoritative projection from
  // the scoring fallback bridge. See attemptScoringFallback().
  emitLinkMode(logger, { mode: 'graph_projection', metric: METRICS.IDENTITY_GRAPH_PROJECTION_SUCCESS, tenant: userId, leadId: sfLeadId, customerId: sfCustomerId, identityId, source });
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
  const provenance = provenanceFromPolicy(policy);

  const setPatch = { sf_customer_id: customerId, status: nextStatus, updated_at: now };
  if (provenance) setPatch.last_hydrated_by = provenance;

  const { data: updated, error } = await supabase
    .from('communication_participant_identities')
    .update(setPatch)
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
  const provenance = provenanceFromPolicy(policy);

  const setPatch = { sf_lead_id: leadId, status: nextStatus, updated_at: now };
  if (provenance) setPatch.last_hydrated_by = provenance;

  const { data: updated, error } = await supabase
    .from('communication_participant_identities')
    .update(setPatch)
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

// ─────────────────────────────────────────────────────────────────────
// SCORING FALLBACK — @transitional migration bridge
//
// Only fires when graph projection could not produce a link (identity
// missing, identity.sf_lead_id missing, or no graph linkage). Subject
// to strict safety gates: exactly-one HIGH unambiguous, no open
// ambiguity row, same tenant, active-window guard.
//
// On success, ALSO hydrates the identity graph so future events for
// the same person can use the graph path directly.
//
// Will be removed once the identity graph + backfill reach completeness
// across every tenant. See docs/architecture/cross-source-identity-
// reconciliation.md "Hybrid migration bridge" section.
// ─────────────────────────────────────────────────────────────────────

/**
 * Emit a high-level link-mode log. One per fallback attempt (success,
 * blocked, or no-match). Separate from emitProjectionMetric which tracks
 * per-projection events. Loki:
 *
 *   count_over_time({service_name="service-flow-backend"} |= "[IdentityLink]" |= "mode=graph_projection" [1h])
 *   count_over_time({service_name="service-flow-backend"} |= "[IdentityLink]" |= "mode=fallback_projection_bridge" [1h])
 *   count_over_time({service_name="service-flow-backend"} |= "[IdentityLink]" |= "mode=ambiguity_block" [1h])
 *   count_over_time({service_name="service-flow-backend"} |= "[IdentityLink]" |= "mode=no_match" [1h])
 *
 * Modes (closed set):
 *   graph_projection           — graph linkage produced the projection
 *   fallback_projection_bridge — fallback succeeded; both lead+customer linked, identity hydrated
 *   ambiguity_block            — fallback refused due to ambiguity (resolver or open queue)
 *   no_match                   — no HIGH candidate / customer already linked / phone missing
 */
/**
 * Map policy.resolvedBy → identity.last_hydrated_by column value.
 *
 * Provenance closed set:
 *   graph_projection            — graph cascade (setIdentityCustomer/Lead → projection)
 *   fallback_projection_bridge  — @transitional scoring fallback
 *   operator_override           — applyLeadCustomerLink (manual UI)
 *   retroactive_repair          — /repair-lead-links apply mode
 *   ambiguity_resolution        — operator resolved an ambiguity row
 *   source_projection           — projection reacted to identity row change
 *
 * Legacy alias: 'automatic' → 'graph_projection' (callers pre-dating the
 * hybrid bridge passed resolvedBy='automatic'; treated as graph_projection
 * for provenance purposes since that's what the graph path produces).
 */
function provenanceFromPolicy(policy) {
  const r = policy && policy.resolvedBy;
  if (!r) return null;
  if (r === 'automatic') return 'graph_projection';
  return r;
}

/**
 * Canonical metric names — closed set, Loki-filterable via `|= "metric=<name>"`.
 * Every projection / fallback decision emits exactly one of these per event.
 * Documented in docs/operations/identity-reconciliation-runbook.md.
 */
const METRICS = Object.freeze({
  // Graph path (authoritative)
  IDENTITY_GRAPH_PROJECTION_SUCCESS:         'identity_graph_projection_success',
  GRAPH_PROJECTION_SKIPPED_MISSING_LEAD:     'graph_projection_skipped_missing_lead',
  GRAPH_PROJECTION_SKIPPED_MISSING_CUSTOMER: 'graph_projection_skipped_missing_customer',
  GRAPH_PROJECTION_SKIPPED_AMBIGUOUS:        'graph_projection_skipped_ambiguous',
  GRAPH_PROJECTION_SKIPPED_FROZEN:           'graph_projection_skipped_frozen',
  GRAPH_PROJECTION_SKIPPED_REFUSED:          'graph_projection_skipped_refused',
  // Scoring fallback (@transitional)
  FALLBACK_PROJECTION_BRIDGE_SUCCESS:        'fallback_projection_bridge_success',
  FALLBACK_PROJECTION_BRIDGE_AMBIGUOUS:      'fallback_projection_bridge_ambiguous',
  FALLBACK_PROJECTION_BRIDGE_NO_MATCH:       'fallback_projection_bridge_no_match',
});

function emitLinkMode(logger, {
  mode,
  metric = null,
  tenant,
  leadId = null,
  customerId = null,
  identityId = null,
  source = 'unknown',
  reason = null,
  score = null,
}) {
  if (!logger || typeof logger.log !== 'function') return;
  const parts = [
    `mode=${mode}`,
    metric != null ? `metric=${metric}` : null,
    `tenant=${tenant != null ? tenant : 'null'}`,
    `lead_id=${leadId != null ? leadId : 'null'}`,
    `customer_id=${customerId != null ? customerId : 'null'}`,
    `identity_id=${identityId != null ? identityId : 'null'}`,
    `source=${source}`,
    reason != null ? `reason=${reason}` : null,
    score != null ? `score=${score}` : null,
  ].filter(Boolean);
  try { logger.log(`[IdentityLink] ${parts.join(' ')}`); }
  catch (_) { /* never throw out of logging */ }
}

/**
 * Temporary scoring fallback. Runs ONLY when the identity graph could
 * not produce a projection (identity missing, sf_lead_id missing, etc.).
 *
 * Safety gates (all required to apply):
 *   - IDENTITY_SCORING_FALLBACK_ENABLED ON globally + tenant not opted out
 *   - IDENTITY_PROJECTION_FREEZE OFF
 *   - customerId not already linked to a lead in this tenant
 *   - no open ambiguity row for the customer's phone
 *   - exactly one HIGH-confidence candidate (no second HIGH)
 *   - same tenant (every query filters by user_id)
 *   - active-window guard: both lead.updated_at AND customer.updated_at
 *     within `activeWindowHours` (default 24) → REFUSE
 *
 * On apply:
 *   1. UPDATE leads.converted_customer_id (guarded WHERE NULL)
 *   2. If identityId provided + identity exists: hydrate identity
 *      (set sf_lead_id + sf_customer_id atomically). Future events
 *      for this person use the graph path directly.
 *   3. Write identity_link_audit row with resolved_by='fallback_projection_bridge'
 *   4. Emit [IdentityLink] mode=fallback_projection_bridge
 *   5. Emit per-projection metric via emitProjectionMetric
 *
 * NEVER throws. Returns:
 *   { mode, outcome, lead_id?, customer_id?, identity_id?, reason?, score?, confidence? }
 *
 * @param {Object} opts
 *   userId             REQUIRED
 *   customerId         REQUIRED (the newly created/updated customer)
 *   customerPhone      REQUIRED (last-10-normalised inside)
 *   customerName       OPTIONAL (name-similarity input)
 *   customerSource     OPTIONAL (source-compat input)
 *   identityId         OPTIONAL — when set + non-null, hydrate identity on success
 *   activeWindowHours  OPTIONAL (default 24; pass 0 to disable)
 *   source             OPTIONAL log tag (default 'zenbooker')
 */
async function attemptScoringFallback(supabase, logger, opts) {
  const o = opts || {};
  const userId = o.userId;
  const customerId = o.customerId;
  const customerPhone = o.customerPhone;
  const customerName = o.customerName || null;
  const customerSource = o.customerSource || null;
  const identityId = o.identityId == null ? null : Number(o.identityId);
  const activeWindowHours = o.activeWindowHours == null ? 24 : Math.max(0, Number(o.activeWindowHours));
  const source = o.source || 'zenbooker';

  if (userId == null || customerId == null || !customerPhone) {
    emitLinkMode(logger, { mode: 'no_match', metric: METRICS.FALLBACK_PROJECTION_BRIDGE_NO_MATCH, tenant: userId, customerId, identityId, source, reason: 'invalid_input' });
    return { mode: 'no_match', outcome: 'invalid_input' };
  }

  // Honour the global freeze switch (same as the projection layer).
  if (isEnabled(FLAGS.IDENTITY_PROJECTION_FREEZE)) {
    emitLinkMode(logger, { mode: 'no_match', metric: METRICS.FALLBACK_PROJECTION_BRIDGE_NO_MATCH, tenant: userId, customerId, identityId, source, reason: 'freeze' });
    return { mode: 'no_match', outcome: 'freeze' };
  }

  // Strict opt-in: capability flag must be true AND tenant must be in
  // IDENTITY_SCORING_FALLBACK_TENANTS. See lib/feature-flags.js
  // isFallbackEnabledForTenant().
  if (!isFallbackEnabledForTenant(userId)) {
    emitLinkMode(logger, { mode: 'no_match', metric: METRICS.FALLBACK_PROJECTION_BRIDGE_NO_MATCH, tenant: userId, customerId, identityId, source, reason: 'fallback_disabled' });
    return { mode: 'no_match', outcome: 'fallback_disabled' };
  }

  // 1. Is this customer already linked? (idempotent skip)
  try {
    const { data: existing } = await supabase.from('leads')
      .select('id').eq('user_id', userId).eq('converted_customer_id', customerId).limit(1);
    if (existing && existing[0]) {
      emitLinkMode(logger, { mode: 'no_match', metric: METRICS.FALLBACK_PROJECTION_BRIDGE_NO_MATCH, tenant: userId, customerId, identityId, source, reason: 'customer_already_linked' });
      return { mode: 'no_match', outcome: 'customer_already_linked', lead_id: existing[0].id, customer_id: customerId };
    }
  } catch (_) { /* fall through */ }

  // 2. Open ambiguity row for this phone? Resolver already flagged the
  //    population as risky — never auto-link.
  const last10 = normalizePhone(customerPhone);
  try {
    const { count: ambigCount } = await supabase.from('communication_identity_ambiguities')
      .select('id', { head: true, count: 'exact' })
      .eq('user_id', userId)
      .eq('attempted_phone', last10)
      .eq('status', 'open');
    if ((ambigCount || 0) > 0) {
      emitLinkMode(logger, { mode: 'ambiguity_block', metric: METRICS.FALLBACK_PROJECTION_BRIDGE_AMBIGUOUS, tenant: userId, customerId, identityId, source, reason: 'open_ambiguity_row' });
      return { mode: 'ambiguity_block', outcome: 'open_ambiguity_row', customer_id: customerId };
    }
  } catch (_) { /* best-effort; on lookup error fall through */ }

  // 3. Discover candidates + score
  const candidates = await findCandidateLeads(supabase, userId, customerPhone);
  if (candidates.length === 0) {
    emitLinkMode(logger, { mode: 'no_match', metric: METRICS.FALLBACK_PROJECTION_BRIDGE_NO_MATCH, tenant: userId, customerId, identityId, source, reason: 'no_candidates' });
    return { mode: 'no_match', outcome: 'no_candidates' };
  }

  const scored = candidates
    .map((lead) => ({ lead, ...scoreMatch({ customerPhone, customerName, customerSource, lead }) }))
    .sort((a, b) => b.score - a.score);

  const best = scored[0];
  const second = scored[1];

  // 4. Ambiguity block: more than one HIGH-confidence candidate
  if (best.confidence === 'high' && second && second.confidence === 'high') {
    emitLinkMode(logger, {
      mode: 'ambiguity_block', metric: METRICS.FALLBACK_PROJECTION_BRIDGE_AMBIGUOUS, tenant: userId, customerId, identityId, source,
      reason: 'multiple_high_candidates', score: best.score,
    });
    return {
      mode: 'ambiguity_block', outcome: 'multiple_high_candidates',
      customer_id: customerId, candidates: scored.slice(0, 5).map(({ lead, score, confidence }) => ({ lead_id: lead.id, score, confidence })),
    };
  }

  if (best.confidence !== 'high') {
    emitLinkMode(logger, {
      mode: 'no_match', metric: METRICS.FALLBACK_PROJECTION_BRIDGE_NO_MATCH, tenant: userId, customerId, identityId, source,
      reason: `${best.confidence}_confidence`, score: best.score,
    });
    return { mode: 'no_match', outcome: best.confidence + '_confidence', score: best.score, lead_id: best.lead.id, confidence: best.confidence };
  }

  const leadId = best.lead.id;

  // 5. Active-window guard. Pull customer.updated_at; lead.updated_at is on the candidate.
  if (activeWindowHours > 0) {
    let customerUpdatedAt = null;
    try {
      const { data: cust } = await supabase.from('customers')
        .select('updated_at').eq('id', customerId).eq('user_id', userId).maybeSingle();
      customerUpdatedAt = cust && cust.updated_at;
    } catch (_) { /* fall through */ }
    const guard = shouldDowngradeForActiveWindow({
      leadUpdatedAt: best.lead.updated_at,
      customerUpdatedAt,
      activeWindowHours,
    });
    if (guard.downgrade) {
      emitLinkMode(logger, {
        mode: 'ambiguity_block', metric: METRICS.FALLBACK_PROJECTION_BRIDGE_AMBIGUOUS, tenant: userId, leadId, customerId, identityId, source,
        reason: guard.reason, score: best.score,
      });
      return { mode: 'ambiguity_block', outcome: 'active_window_downgrade', reason: guard.reason, lead_id: leadId, customer_id: customerId, score: best.score };
    }
  }

  // 6. Apply lead → customer link (guarded UPDATE; column whitelist enforced).
  const now = new Date().toISOString();
  let linkedLeadId = null;
  try {
    const { data: written, error } = await supabase
      .from('leads')
      .update({ converted_customer_id: customerId, converted_at: now, updated_at: now })
      .eq('id', leadId)
      .eq('user_id', userId)
      .is('converted_customer_id', null)
      .select('id');
    if (error) {
      emitLinkMode(logger, { mode: 'no_match', metric: METRICS.FALLBACK_PROJECTION_BRIDGE_NO_MATCH, tenant: userId, leadId, customerId, identityId, source, reason: `update_failed:${error.message}`, score: best.score });
      return { mode: 'no_match', outcome: 'update_failed', error: error.message };
    }
    linkedLeadId = (written && written[0]) ? written[0].id : null;
  } catch (e) {
    emitLinkMode(logger, { mode: 'no_match', metric: METRICS.FALLBACK_PROJECTION_BRIDGE_NO_MATCH, tenant: userId, leadId, customerId, identityId, source, reason: `update_threw:${e && e.message}`, score: best.score });
    return { mode: 'no_match', outcome: 'update_threw', error: e && e.message };
  }

  if (!linkedLeadId) {
    // Race: the lead was linked to a different customer between candidate fetch + update.
    emitLinkMode(logger, { mode: 'no_match', metric: METRICS.FALLBACK_PROJECTION_BRIDGE_NO_MATCH, tenant: userId, leadId, customerId, identityId, source, reason: 'race_already_linked', score: best.score });
    return { mode: 'no_match', outcome: 'race_already_linked', lead_id: leadId, customer_id: customerId };
  }

  // 7. Hydrate the identity graph IF an identity row exists.
  //    One atomic UPDATE that sets sf_lead_id + sf_customer_id, but ONLY
  //    if those slots are currently NULL (don't clobber an existing graph
  //    decision). Status updated accordingly.
  let hydratedIdentityId = null;
  if (identityId != null) {
    try {
      const { data: identityRow } = await supabase.from('communication_participant_identities')
        .select('id, user_id, sf_lead_id, sf_customer_id, status')
        .eq('id', identityId).eq('user_id', userId).maybeSingle();
      if (identityRow) {
        const patch = { updated_at: now };
        if (identityRow.sf_lead_id == null) patch.sf_lead_id = leadId;
        if (identityRow.sf_customer_id == null) patch.sf_customer_id = customerId;
        // Provenance: record fallback bridge as the latest hydration cause.
        // Always set (even if sf_* slots were already filled) so the column
        // reflects "fallback ran for this identity recently" — useful for
        // graph-completeness analysis.
        patch.last_hydrated_by = 'fallback_projection_bridge';
        // Write whenever there's at least one sf_* slot to fill OR a
        // provenance change. With last_hydrated_by always present, the
        // patch always has ≥2 keys, so any path through here writes.
        if (Object.keys(patch).length > 1) {
          // Determine target status.
          const newSfLead = patch.sf_lead_id != null ? patch.sf_lead_id : identityRow.sf_lead_id;
          const newSfCust = patch.sf_customer_id != null ? patch.sf_customer_id : identityRow.sf_customer_id;
          patch.status = (newSfLead != null && newSfCust != null) ? 'resolved_both'
            : newSfLead != null ? 'resolved_lead'
            : newSfCust != null ? 'resolved_customer'
            : (identityRow.status || 'unresolved_floating');
          await supabase.from('communication_participant_identities')
            .update(patch).eq('id', identityId).eq('user_id', userId);
        }
        hydratedIdentityId = identityRow.id;
      }
    } catch (e) {
      // Non-fatal — link succeeded; identity hydration is best-effort.
      if (logger?.warn) logger.warn(`[IdentityLink] fallback hydration failed identity=${identityId}: ${e?.message}`);
    }
  }

  // 8. Audit + metrics
  await writeAuditRow(supabase, logger, {
    userId,
    leadId,
    customerId,
    identityId: hydratedIdentityId,
    resolvedBy: 'fallback_projection_bridge',
    resolutionReason: best.reasons.join(','),
    nameClass: null,
    phoneMatch: true,
    sourceCompat: best.reasons.some(r => r.startsWith('channel_match')),
    notes: `score=${best.score} confidence=high`,
  });

  emitProjectionMetric(logger, {
    event: 'fallback_apply',
    outcome: 'success',
    tenant: userId,
    identityId: hydratedIdentityId,
    leadId,
    customerId,
    source,
    resolvedBy: 'fallback_projection_bridge',
    resolutionReason: 'scoring_match',
  });

  emitLinkMode(logger, {
    mode: 'fallback_projection_bridge',
    metric: METRICS.FALLBACK_PROJECTION_BRIDGE_SUCCESS,
    tenant: userId,
    leadId,
    customerId,
    identityId: hydratedIdentityId,
    source,
    score: best.score,
  });

  // 9. Best-effort registry archive (same as projection success path).
  try {
    await supabase.rpc('pir_archive_entity', {
      p_workspace_id: userId,
      p_entity_type: 'lead',
      p_entity_id: String(leadId),
    });
  } catch (_) { /* best-effort */ }

  return {
    mode: 'fallback_projection_bridge',
    outcome: 'success',
    lead_id: leadId,
    customer_id: customerId,
    identity_id: hydratedIdentityId,
    score: best.score,
    confidence: 'high',
    reasons: best.reasons,
  };
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
  // Best-effort provenance write on the owning identity row (if one exists
  // and points at either side of this pair). Observational — code paths
  // never branch on last_hydrated_by.
  try {
    await supabase.from('communication_participant_identities')
      .update({ last_hydrated_by: 'operator_override', updated_at: new Date().toISOString() })
      .eq('user_id', userId)
      .or(`sf_lead_id.eq.${leadId},sf_customer_id.eq.${customerId}`);
  } catch (_) { /* best-effort */ }
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
  // Projection layer (authoritative)
  setIdentityCustomer,
  setIdentityLead,
  projectIdentityToCRM,
  applyLeadCustomerLink,
  emitProjectionMetric,
  emitLinkMode,
  writeAuditRow,
  // Scoring fallback (@transitional migration bridge)
  attemptScoringFallback,
  scoreMatch,
  nameSimilarity,
  classifyChannel,
  findCandidateLeads,
  normalizePhone,
  HIGH_CONFIDENCE_THRESHOLD,
  MEDIUM_CONFIDENCE_THRESHOLD,
};
