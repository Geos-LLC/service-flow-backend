'use strict';

// Identity Reconciliation Engine — Stage 1 skeleton (DARK CODE).
//
// See docs/architecture/identity-reconciliation-engine-design.md for the
// authoritative design. This file is the Stage 1 deliverable: the engine
// is callable and unit-testable but no call site is converted to use it.
// Stage 2/3/4/4.5/5 PRs convert LB / ZB / OP / manual-SF / Sigcore adapters
// per docs/architecture/identity-graph-refactor-plan.md §5.
//
// What this module DOES:
//   - Define the IdentityInput / TenantPolicy / ReconciliationResult /
//     ProjectionPlan value shapes (see §4, §5 of the design doc).
//   - Provide pure decision-table functions: decideForLeadbridge,
//     decideForZenbooker, decideForOpenphone, decideForSigcore,
//     decideForManualSf (§7.1–§7.5 of the design doc).
//   - Provide reconcile() — composes the resolver call, ambiguity check,
//     invariant assertions, decision dispatch.
//
// What this module DOES NOT:
//   - Write to communication_participant_identities (resolver does that).
//   - Write to leads / customers (adapters/executors do that — Stage 2+).
//   - Write to leads.converted_customer_id (lib/identity-linker.js does that).
//   - Read tenant settings / feature flags (caller passes TenantPolicy).
//   - Persist a ProjectionPlan anywhere (invariant R13 — no duplicate graph
//     truth; the plan is a value object, never a row).
//
// INVARIANT R13 (docs/architecture/identity-graph-refactor-plan.md §3.2a):
//   The engine never introduces a reverse pointer from CRM to identity, and
//   never persists a ProjectionPlan. If a field needs persistence it goes
//   through the existing owner (resolver or linker), not through here.

const { resolveIdentity } = require('./identity-resolver');
const { getSource } = require('./source-registry');
const { normalize, normalizePhone } = require('./name-normalize');
const { findCrmMatchByPhone } = require('./openphone-crm-match');
const { assertCreateChildLeadInvariant } = require('./lb-ingestion');
const { shouldOpenPhoneCreateLead } = require('./openphone-ingestion');

// ── Decision enum (string constants — keep stable; surfaced in logs) ─────

const DECISIONS = Object.freeze({
  CANONICAL_CUSTOMER_CREATE:   'canonical_customer_create',
  CANONICAL_LEAD_CREATE:       'canonical_lead_create',
  CHILD_ACQUISITION:           'child_acquisition',
  REACTIVATION_LEAD:           'reactivation_lead',
  ATTACH_EXISTING_CUSTOMER:    'attach_existing_customer',
  ATTACH_EXISTING_LEAD:        'attach_existing_lead',
  ENRICH_ONLY:                 'enrich_only',
  NOOP_COMMUNICATION_ONLY:     'noop_communication_only',
  FROZEN:                      'frozen',
  AMBIGUOUS:                   'ambiguous',
});

const CONFIDENCE = Object.freeze({
  AUTO_STRONG:     'auto_strong',
  AUTO_WEAK:       'auto_weak',
  CRM_ANCHOR:      'crm_anchor',
  CREATED_FLOATING:'created_floating',
  OPERATOR:        'operator',
});

// Map resolver matchStep → engine confidence class. Engine never upgrades
// (R7); strong-named matches are auto_strong, weak-named are auto_weak,
// CRM-anchor is its own class for reporting clarity.
const MATCH_STEP_TO_CONFIDENCE = Object.freeze({
  external_id:     CONFIDENCE.AUTO_STRONG,
  phone_strong:    CONFIDENCE.AUTO_STRONG,
  email:           CONFIDENCE.AUTO_STRONG, // resolver only adopts strong-name on email
  via_linked_crm:  CONFIDENCE.AUTO_STRONG,
  phone_weak:      CONFIDENCE.AUTO_WEAK,
  crm_anchor:      CONFIDENCE.CRM_ANCHOR,
  created_floating:CONFIDENCE.CREATED_FLOATING,
});

// ── Input validation ─────────────────────────────────────────────────────

function assertInputShape(input) {
  if (!input || typeof input !== 'object') throw new Error('reconcile: input is required');
  if (input.userId == null) throw new Error('reconcile: userId is required');
  if (!input.source) throw new Error('reconcile: source is required');
  getSource(input.source); // throws on unknown source — central source registry
  if (!input.event || !input.event.type) {
    throw new Error('reconcile: event.type is required');
  }
  // At least one of phone / email / externalId / sigcoreParticipant* is needed.
  const hasPhone = !!normalizePhone(input.phone);
  const hasEmail = !!input.email;
  const hasExt   = !!(input.externalId || input.sigcoreParticipantId || input.sigcoreParticipantKey);
  if (!hasPhone && !hasEmail && !hasExt) {
    throw new Error('reconcile: at least one of phone, email, externalId, sigcoreParticipantId, or sigcoreParticipantKey is required');
  }
}

// ── Identity-state classifier (pure) ─────────────────────────────────────

function identityState(identity) {
  if (!identity) return 'missing';
  const hasL = identity.sf_lead_id != null;
  const hasC = identity.sf_customer_id != null;
  if (hasL && hasC) return 'has_both';
  if (hasL) return 'has_lead';
  if (hasC) return 'has_customer';
  return 'floating';
}

// ── Per-source decision tables (pure) ────────────────────────────────────
//
// Each function returns a partial ProjectionPlan: { decision, reason,
// attachTarget?, parentLeadId? }. The caller (decideProjection) fills in
// identityId / matchStep / confidence.
//
// These mirror the per-adapter inline logic in:
//   leadbridge-service.js resolveOrCreateLead
//   zenbooker-sync.js     upsertCustomerFromZB
//   server.js             maybeCreateLeadFromOpenPhone
//   (manual_sf and sigcore are new in the engine layer)

function decideForLeadbridge(identity, input, policy, crmMatch) {
  const state = identityState(identity);

  if (state === 'has_lead' || state === 'has_both') {
    if (policy.childLeadsEnabled) {
      return {
        decision: DECISIONS.CHILD_ACQUISITION,
        parentLeadId: identity.sf_lead_id,
        reason: 'identity_has_lead_repeat_acquisition',
      };
    }
    return { decision: DECISIONS.ENRICH_ONLY, reason: 'identity_has_lead_enrich' };
  }

  if (state === 'has_customer') {
    if (policy.reactivationLeadsEnabled) {
      return {
        decision: DECISIONS.REACTIVATION_LEAD,
        reason: 'identity_has_customer_reactivation',
      };
    }
    return {
      decision: DECISIONS.NOOP_COMMUNICATION_ONLY,
      reason: 'identity_already_customer',
    };
  }

  // Floating — attach to existing CRM by phone, else create canonical lead.
  if (crmMatch && crmMatch.type === 'customer') {
    return {
      decision: DECISIONS.ATTACH_EXISTING_CUSTOMER,
      attachTarget: { type: 'customer', id: crmMatch.id },
      reason: 'crm_anchor_customer',
    };
  }
  if (crmMatch && crmMatch.type === 'lead') {
    return {
      decision: DECISIONS.ATTACH_EXISTING_LEAD,
      attachTarget: { type: 'lead', id: crmMatch.id },
      reason: 'crm_anchor_lead',
    };
  }
  return { decision: DECISIONS.CANONICAL_LEAD_CREATE, reason: 'no_prior_link' };
}

function decideForZenbooker(identity, input/*, policy, crmMatch*/) {
  const state = identityState(identity);

  // ZB never creates a lead and never produces child/reactivation decisions.
  // It always produces a customer-side decision.
  if (state === 'has_customer' || state === 'has_both') {
    return { decision: DECISIONS.ENRICH_ONLY, reason: 'identity_already_customer' };
  }

  // Identity is 'has_lead' or 'floating'. Either way ZB creates the customer;
  // the projection cascade (setIdentityCustomer → projectIdentityToCRM) will
  // link an existing canonical lead automatically if state === 'has_lead'.
  return { decision: DECISIONS.CANONICAL_CUSTOMER_CREATE, reason: 'zb_canonical_customer' };
}

function decideForOpenphone(identity, input, policy, crmMatch, opGate) {
  const state = identityState(identity);

  if (state === 'has_lead' || state === 'has_both' || state === 'has_customer') {
    return {
      decision: DECISIONS.NOOP_COMMUNICATION_ONLY,
      reason: state === 'has_customer' ? 'identity_has_customer' : 'identity_has_lead',
    };
  }

  // Floating identity. Conditional creation may be off.
  if (!policy.conditionalLeadCreationEnabled) {
    return {
      decision: DECISIONS.NOOP_COMMUNICATION_ONLY,
      reason: 'conditional_lead_creation_off',
    };
  }
  if (!opGate || !opGate.create) {
    return {
      decision: DECISIONS.NOOP_COMMUNICATION_ONLY,
      reason: opGate ? opGate.reason : 'op_gate_unevaluated',
    };
  }

  // Pre-create CRM-anchor lookup wins over creation (prevents OP duplicates
  // when SF customer/lead already exists for the same phone).
  if (crmMatch && crmMatch.type === 'customer') {
    return {
      decision: DECISIONS.ATTACH_EXISTING_CUSTOMER,
      attachTarget: { type: 'customer', id: crmMatch.id },
      reason: 'crm_anchor_customer',
    };
  }
  if (crmMatch && crmMatch.type === 'lead') {
    return {
      decision: DECISIONS.ATTACH_EXISTING_LEAD,
      attachTarget: { type: 'lead', id: crmMatch.id },
      reason: 'crm_anchor_lead',
    };
  }
  return { decision: DECISIONS.CANONICAL_LEAD_CREATE, reason: 'op_canonical_lead' };
}

function decideForSigcore(/* identity, input, policy */) {
  // Sigcore-direct events only enrich the identity row's display_name /
  // participant identifiers. Resolver already did the enrichment as a
  // side-effect of being called; engine reports enrich_only for symmetry.
  return { decision: DECISIONS.ENRICH_ONLY, reason: 'sigcore_participant_enriched' };
}

function decideForManualSf(identity, input, policy, crmMatch) {
  // Operator-initiated manual entry. When identity already has the relevant
  // CRM row, we treat the event as enrich (operator is updating an existing
  // person). When floating, we attach to a phone-anchored CRM row if one
  // exists (operator entered a phone that matches an existing person) and
  // surface that as an attach decision — the API layer can return 409 and
  // ask the operator to confirm.
  const wantsLead = input.event && input.event.type === 'operator_action' && input.event.subject === 'lead';
  const state = identityState(identity);

  if (wantsLead && (state === 'has_lead' || state === 'has_both')) {
    return { decision: DECISIONS.ENRICH_ONLY, reason: 'manual_lead_already_exists' };
  }
  if (!wantsLead && (state === 'has_customer' || state === 'has_both')) {
    return { decision: DECISIONS.ENRICH_ONLY, reason: 'manual_customer_already_exists' };
  }
  if (crmMatch && crmMatch.type === 'customer') {
    return {
      decision: DECISIONS.ATTACH_EXISTING_CUSTOMER,
      attachTarget: { type: 'customer', id: crmMatch.id },
      reason: 'manual_phone_anchor_customer',
    };
  }
  if (crmMatch && crmMatch.type === 'lead') {
    return {
      decision: DECISIONS.ATTACH_EXISTING_LEAD,
      attachTarget: { type: 'lead', id: crmMatch.id },
      reason: 'manual_phone_anchor_lead',
    };
  }
  return {
    decision: wantsLead ? DECISIONS.CANONICAL_LEAD_CREATE : DECISIONS.CANONICAL_CUSTOMER_CREATE,
    reason: 'manual_no_anchor',
  };
}

// Dispatch by source.
function decideBySource(source, identity, input, policy, crmMatch, opGate) {
  switch (source) {
    case 'leadbridge': return decideForLeadbridge(identity, input, policy, crmMatch);
    case 'zenbooker':  return decideForZenbooker(identity, input, policy, crmMatch);
    case 'openphone':  return decideForOpenphone(identity, input, policy, crmMatch, opGate);
    case 'sigcore':    return decideForSigcore(identity, input, policy);
    case 'manual_sf':  return decideForManualSf(identity, input, policy, crmMatch);
    default:
      // Defensive — getSource() in assertInputShape already rejects unknown
      // sources, but this guard keeps the switch exhaustive.
      throw new Error(`decideBySource: unknown source ${source}`);
  }
}

// ── Invariant assertions (R5 / R6 / R10) ─────────────────────────────────

async function assertChildLeadParentInvariants(supabase, plan, identity, input) {
  if (plan.decision !== DECISIONS.CHILD_ACQUISITION) return null;
  // Re-check at decision-time (Stage 2 executors re-check at insert-time).
  const { data: parent } = await supabase.from('leads')
    .select('id, user_id, parent_lead_id')
    .eq('id', plan.parentLeadId).eq('user_id', input.userId)
    .maybeSingle();
  try {
    assertCreateChildLeadInvariant(parent, input.userId);
  } catch (e) {
    // Confidence-downgrade: refuse the child decision; surface a noop with
    // structural reason. Adapter falls back to legacy enrich path (Stage 2
    // executor decides; engine just refuses to plan the child).
    return {
      decision: DECISIONS.NOOP_COMMUNICATION_ONLY,
      reason: `parent_invariant_${e.message}`,
    };
  }
  return null;
}

// ── CRM-anchor lookup helper (R4) ────────────────────────────────────────

// The lookup is needed for floating-identity decisions in LB, OP, manual_sf
// (per §7 of the design doc). ZB and Sigcore decisions don't consult it.
function needsCrmLookup(source, identity) {
  if (identityState(identity) !== 'floating') return false;
  return source === 'leadbridge' || source === 'openphone' || source === 'manual_sf';
}

async function maybeFindCrmAnchor(supabase, source, identity, input) {
  if (!needsCrmLookup(source, identity)) return null;
  const phone = input.phone || (identity && identity.normalized_phone) || null;
  if (!phone) return null;
  return await findCrmMatchByPhone(supabase, input.userId, phone);
}

// ── OP-specific gate (shouldOpenPhoneCreateLead) ─────────────────────────

function evaluateOpGate(source, identity, input, policy) {
  if (source !== 'openphone') return null;
  return shouldOpenPhoneCreateLead({
    identity,
    canonicalSource: input.event && input.event.canonicalSource,
    participantName: input.displayName,
    lastEventAt: input.event && input.event.lastEventAt,
    maxAgeDays: policy.openPhoneLeadMaxAgeDays,
  });
}

// ── Decision composition (pure but takes the DB-backed pre-checks) ───────

async function decideProjection(supabase, identity, input, policy) {
  // Freeze short-circuit: still produce a decision so observability can
  // see what *would* have happened; adapter honors `frozen` by skipping
  // executor calls. enrich_only is exempt — identity row updates continue.
  const crmMatch = await maybeFindCrmAnchor(supabase, input.source, identity, input);
  const opGate = evaluateOpGate(input.source, identity, input, policy);

  let core = decideBySource(input.source, identity, input, policy, crmMatch, opGate);

  // Re-check structural invariants for child_acquisition (R5/R6).
  const refused = await assertChildLeadParentInvariants(supabase, { ...core }, identity, input);
  if (refused) core = refused;

  // Apply freeze AFTER computing the would-be decision, so adapters can log
  // both the intended decision and the freeze override.
  if (policy.freeze && isWritingDecision(core.decision)) {
    return {
      ...core,
      intendedDecision: core.decision,
      decision: DECISIONS.FROZEN,
      reason: 'projection_freeze',
    };
  }

  return core;
}

function isWritingDecision(decision) {
  return decision === DECISIONS.CANONICAL_CUSTOMER_CREATE
      || decision === DECISIONS.CANONICAL_LEAD_CREATE
      || decision === DECISIONS.CHILD_ACQUISITION
      || decision === DECISIONS.REACTIVATION_LEAD
      || decision === DECISIONS.ATTACH_EXISTING_CUSTOMER
      || decision === DECISIONS.ATTACH_EXISTING_LEAD;
}

// ── Observability ────────────────────────────────────────────────────────

function emitReconcileLog(logger, ctx) {
  if (!logger || typeof logger.log !== 'function') return;
  const parts = [
    `event=reconcile`,
    `source=${ctx.source}`,
    `tenant=${ctx.tenant != null ? ctx.tenant : 'null'}`,
    `identity_id=${ctx.identityId != null ? ctx.identityId : 'null'}`,
    `decision=${ctx.decision}`,
    `confidence=${ctx.confidence || 'null'}`,
    `match_step=${ctx.matchStep || 'null'}`,
    `reason=${ctx.reason || 'null'}`,
    `ambiguous=${ctx.ambiguous ? 'true' : 'false'}`,
    `frozen=${ctx.frozen ? 'true' : 'false'}`,
    ctx.durationMs != null ? `duration_ms=${ctx.durationMs}` : null,
  ].filter(Boolean);
  try { logger.log(`[Reconciliation] ${parts.join(' ')}`); }
  catch (_) { /* never throw out of logging */ }
}

// ── Public API: reconcile() ──────────────────────────────────────────────

/**
 * Reconcile an inbound source event into a projection plan.
 *
 * @param {object} supabase  supabase-js client (or compatible mock)
 * @param {object} logger    { log, warn, error } (loghub-style is fine)
 * @param {IdentityInput} input
 * @param {TenantPolicy}  policy
 * @returns {Promise<ReconciliationResult>}
 *
 * See docs/architecture/identity-reconciliation-engine-design.md §3, §5.
 *
 * Stage 1 NOTE: this function is dark code. No call site is converted to
 * call it yet. Per-source adapters (Stage 2/3/4/4.5/5) will route through
 * this entry point behind the corresponding RECONCILIATION_ENGINE_* flag.
 */
async function reconcile(supabase, logger, input, policy) {
  const start = Date.now();
  assertInputShape(input);
  policy = policy || {};

  // R1: resolver call precedes every decision.
  const resolverResult = await resolveIdentity(supabase, {
    userId: input.userId,
    source: input.source,
    externalId: input.externalId || null,
    sigcoreParticipantId: input.sigcoreParticipantId || null,
    sigcoreParticipantKey: input.sigcoreParticipantKey || null,
    phone: input.phone || null,
    email: input.email || null,
    displayName: input.displayName || null,
    sfLeadId: input.sfLeadId || null,
    sfCustomerId: input.sfCustomerId || null,
    strict: input.strict === true,
    dryRun: input.dryRun === true,
  });

  // R2: ambiguous → no plan.
  if (resolverResult.status === 'ambiguous') {
    emitReconcileLog(logger, {
      source: input.source, tenant: input.userId, identityId: null,
      decision: DECISIONS.AMBIGUOUS, ambiguous: true,
      reason: resolverResult.reason, durationMs: Date.now() - start,
    });
    return {
      kind: 'ambiguous',
      identityCandidates: resolverResult.candidates || [],
      reason: resolverResult.reason || 'ambiguous',
    };
  }
  if (resolverResult.status === 'error') {
    emitReconcileLog(logger, {
      source: input.source, tenant: input.userId, identityId: null,
      decision: 'error', reason: resolverResult.error, durationMs: Date.now() - start,
    });
    return { kind: 'error', error: resolverResult.error };
  }

  const identity = resolverResult.identity;
  const matchStep = resolverResult.matchStep || null;

  // R3: same-tenant guard (resolver already filters, defense-in-depth).
  if (identity && Number(identity.user_id) !== Number(input.userId)) {
    emitReconcileLog(logger, {
      source: input.source, tenant: input.userId, identityId: identity.id,
      decision: 'error', reason: 'tenant_mismatch', durationMs: Date.now() - start,
    });
    return { kind: 'error', error: 'tenant_mismatch' };
  }

  // R6/R7/R10: decideProjection includes the structural pre-checks.
  const core = await decideProjection(supabase, identity, input, policy);

  const confidence = MATCH_STEP_TO_CONFIDENCE[matchStep] || CONFIDENCE.CREATED_FLOATING;

  const plan = {
    decision: core.decision,
    intendedDecision: core.intendedDecision || null,
    identityId: identity ? identity.id : null,
    attachTarget: core.attachTarget || null,
    parentLeadId: core.parentLeadId || null,
    confidence,
    matchStep,
    reason: core.reason || 'unknown',
  };

  emitReconcileLog(logger, {
    source: input.source, tenant: input.userId, identityId: plan.identityId,
    decision: plan.decision, confidence: plan.confidence, matchStep: plan.matchStep,
    reason: plan.reason, ambiguous: false,
    frozen: plan.decision === DECISIONS.FROZEN,
    durationMs: Date.now() - start,
  });

  return { kind: 'matched', identity, plan };
}

module.exports = {
  // Public API
  reconcile,
  // Pure decision functions (exported for unit tests)
  decideForLeadbridge,
  decideForZenbooker,
  decideForOpenphone,
  decideForSigcore,
  decideForManualSf,
  decideBySource,
  identityState,
  isWritingDecision,
  // Constants
  DECISIONS,
  CONFIDENCE,
  MATCH_STEP_TO_CONFIDENCE,
};
