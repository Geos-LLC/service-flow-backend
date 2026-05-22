'use strict';

// LeadBridge engine adapter — Stage 2.
//
// See docs/architecture/stage-2-leadbridge-adapter-plan.md for the
// authoritative design. This module is the ONLY new file required for
// Stage 2. leadbridge-service.js imports `makeAdapter` and gets one new
// guarded branch in the LB webhook handler and one in runLbSync.
//
// Boundaries:
//   - Engine does the resolver call + decision (lib/identity-reconciliation-engine.js).
//   - Existing LB writer closures (createLeadFromLB, createChildLeadFromLB,
//     enrichLeadFromLB) and the existing identity-linker setters
//     (setIdentityLead, setIdentityCustomer) do the materialization.
//   - This adapter dispatches engine decisions to those writers, and
//     enforces the prerequisite chain (§2 of the plan).
//
// What this module DOES NOT:
//   - Match identities. Engine + resolver do that.
//   - Write to identity / leads / customers directly. All writes go
//     through the bound executors.
//   - Read tenant settings. tenantPolicyForLB reads feature flags only.
//
// Invariant R13 (No Duplicate Graph Truth — docs §3.2a): the adapter
// never persists the ProjectionPlan. The plan is a value passed to
// dispatchPlan and discarded after dispatch.

const engine = require('./identity-reconciliation-engine');
const { FLAGS, isEnabled, isEnabledForTenant } = require('./feature-flags');

// ── Prerequisite warning rate-limit ──────────────────────────────────────
//
// Per (tenant, missing-set) per process lifetime, the prerequisite-missing
// warn fires at most once. Process restart resets the suppression set —
// that is the intended cadence so operators get re-notified after each
// deploy.

const _prereqWarnSeen = new Map(); // key: `${userId}:${sortedMissing}` → first-seen-ms

function _resetPrereqWarnCache() { _prereqWarnSeen.clear(); }

function _prereqKey(userId, missing) {
  return `${userId}:${[...missing].sort().join(',')}`;
}

/**
 * Emit the rate-limited prerequisite-missing warning.
 *
 * Format (must match stage-2 plan §2 verbatim):
 *   [LB engine] path=legacy reason=missing_prerequisite tenant=<id> missing=<sorted-csv>
 *
 * No-op when `missing` is empty.
 */
function emitPrereqMissingWarning(logger, userId, missing) {
  if (!Array.isArray(missing) || missing.length === 0) return false;
  const key = _prereqKey(userId, missing);
  if (_prereqWarnSeen.has(key)) return false;
  _prereqWarnSeen.set(key, Date.now());
  if (logger && typeof logger.warn === 'function') {
    const sorted = [...missing].sort().join(',');
    logger.warn(`[LB engine] path=legacy reason=missing_prerequisite tenant=${userId} missing=${sorted}`);
  }
  return true;
}

// ── Prerequisite check ───────────────────────────────────────────────────

/**
 * Decide whether the engine path is enabled for a tenant.
 *
 * Three return shapes:
 *   { useEngine: false, missing: [], engineFlagOn: false }
 *     — engine flag is OFF for this tenant. Use legacy. No warn.
 *   { useEngine: false, missing: ['child_leads'|'resolver'|...], engineFlagOn: true }
 *     — engine flag is ON but prerequisites missing. Use legacy + warn.
 *   { useEngine: true, missing: [], engineFlagOn: true }
 *     — all prerequisites satisfied. Use engine.
 *
 * The "short" missing identifiers are stable strings used in logs/tests:
 *   "child_leads" — LEAD_CARDINALITY_CHILD_LEADS_TENANTS missing
 *   "resolver"    — IDENTITY_RESOLVER_LEADBRIDGE_TENANTS missing
 */
function checkPrerequisites(userId) {
  const engineFlagOn = isEnabledForTenant(FLAGS.RECONCILIATION_ENGINE_LEADBRIDGE, userId);
  if (!engineFlagOn) return { useEngine: false, missing: [], engineFlagOn: false };

  const childLeads = isEnabledForTenant(FLAGS.LEAD_CARDINALITY_CHILD_LEADS, userId);
  const resolver   = isEnabledForTenant(FLAGS.IDENTITY_RESOLVER_LEADBRIDGE, userId);

  const missing = [];
  if (!childLeads) missing.push('child_leads');
  if (!resolver)   missing.push('resolver');

  return { useEngine: missing.length === 0, missing, engineFlagOn: true };
}

// ── Tenant policy ────────────────────────────────────────────────────────

/**
 * Construct the engine's TenantPolicy from feature flags for a LB caller.
 * Read at call time — adapter never caches policy across requests.
 */
function tenantPolicyForLB(userId) {
  const childLeads = isEnabledForTenant(FLAGS.LEAD_CARDINALITY_CHILD_LEADS, userId);
  return {
    childLeadsEnabled:              childLeads,
    reactivationLeadsEnabled:       childLeads, // today's code uses one flag for both
    conditionalLeadCreationEnabled: false,      // OP-only knob, irrelevant for LB
    freeze:                         isEnabled(FLAGS.IDENTITY_PROJECTION_FREEZE),
    allowStageMove:                 false,
  };
}

// ── IdentityInput builder ────────────────────────────────────────────────

function buildLBIdentityInput(userId, input) {
  return {
    userId,
    source: 'leadbridge',
    externalId: input.lbContactId || null,
    phone: input.customerPhone || null,
    email: input.customerEmail || null,
    displayName: input.customerName || null,
    event: {
      type: 'lead_received',
      channel: input.channel || null,
      accountDisplayName: input.accountDisplayName || null,
      message: input.message || null,
    },
  };
}

// ── Factory ──────────────────────────────────────────────────────────────

/**
 * Bind the adapter to a specific supabase + logger + LB executors.
 *
 * @param deps {
 *   supabase,
 *   logger,                                    // { log, warn, error }
 *   executors: {
 *     createLeadFromLB(userId, identity, input),
 *     createChildLeadFromLB(userId, parentLeadId, identity, input),
 *     enrichLeadFromLB(userId, leadId, input),
 *     setIdentityLead(supabase, logger, opts),
 *     setIdentityCustomer(supabase, logger, opts),
 *   }
 * }
 */
function makeAdapter(deps) {
  const { supabase, logger, executors } = deps || {};
  if (!supabase) throw new Error('makeAdapter: supabase is required');
  if (!logger)   throw new Error('makeAdapter: logger is required');
  if (!executors) throw new Error('makeAdapter: executors object is required');
  for (const fn of [
    'createLeadFromLB',
    'createChildLeadFromLB',
    'enrichLeadFromLB',
    'setIdentityLead',
    'setIdentityCustomer',
  ]) {
    if (typeof executors[fn] !== 'function') {
      throw new Error(`makeAdapter: executors.${fn} must be a function`);
    }
  }

  /**
   * Dispatch an engine ProjectionPlan to the bound LB executors.
   *
   * Returns the same shape resolveOrCreateLead returns:
   *   { type, id, created, action, parent_lead_id? }   on success
   *   null                                              on noop / freeze
   */
  async function dispatchPlan(userId, identity, plan, input) {
    if (!identity) return null;

    switch (plan.decision) {
      case engine.DECISIONS.CANONICAL_LEAD_CREATE:
        return await executors.createLeadFromLB(userId, identity, input);

      case engine.DECISIONS.CHILD_ACQUISITION: {
        const child = await executors.createChildLeadFromLB(userId, plan.parentLeadId, identity, input);
        if (child) {
          return { type: 'child_lead', id: child.id, parent_lead_id: plan.parentLeadId, created: true, action: 'child_acquisition' };
        }
        // Child create returned null at the executor layer (e.g., parent
        // invariant raised by assertCreateChildLeadInvariant). Mirrors
        // legacy fallback: enrich the canonical so the acquisition isn't
        // silently dropped from the LB webhook ack path.
        if (identity.sf_lead_id) {
          await executors.enrichLeadFromLB(userId, identity.sf_lead_id, input);
          return { type: 'lead', id: identity.sf_lead_id, created: false, action: 'enriched' };
        }
        return null;
      }

      case engine.DECISIONS.REACTIVATION_LEAD:
        // createLeadFromLB inspects identity.sf_customer_id and sets
        // lead_origin_type='reactivation'. Identity already has the
        // customer; the projection cascade (setIdentityLead inside
        // createLeadFromLB) will auto-link the new lead to the customer.
        return await executors.createLeadFromLB(userId, identity, input);

      case engine.DECISIONS.ENRICH_ONLY:
        if (!identity.sf_lead_id) {
          // Defensive — should not happen for LB; the engine emits
          // enrich_only only when identity has sf_lead_id. Surface and
          // noop rather than crash.
          logger.warn(`[LB engine] enrich_only without sf_lead_id identity=${identity.id} tenant=${userId}`);
          return null;
        }
        await executors.enrichLeadFromLB(userId, identity.sf_lead_id, input);
        return { type: 'lead', id: identity.sf_lead_id, created: false, action: 'enriched' };

      case engine.DECISIONS.ATTACH_EXISTING_CUSTOMER:
        await executors.setIdentityCustomer(supabase, logger, {
          userId, identityId: identity.id, customerId: plan.attachTarget.id,
          identitySnapshot: identity,
          policy: {
            resolvedBy: 'automatic',
            resolutionReason: 'identity_graph_projection',
            source: 'leadbridge',
            allowStageMove: false,
          },
        });
        return { type: 'customer', id: plan.attachTarget.id, created: false, action: 'linked_customer' };

      case engine.DECISIONS.ATTACH_EXISTING_LEAD:
        await executors.setIdentityLead(supabase, logger, {
          userId, identityId: identity.id, leadId: plan.attachTarget.id,
          identitySnapshot: identity,
          policy: {
            resolvedBy: 'automatic',
            resolutionReason: 'identity_graph_projection',
            source: 'leadbridge',
            allowStageMove: false,
          },
        });
        await executors.enrichLeadFromLB(userId, plan.attachTarget.id, input);
        return { type: 'lead', id: plan.attachTarget.id, created: false, action: 'linked_enriched' };

      case engine.DECISIONS.NOOP_COMMUNICATION_ONLY: {
        // Grandchild refusal — engine downgraded child_acquisition to noop.
        // Fall through to legacy enrich on the canonical so the acquisition
        // is preserved as a lead update (matches existing fallback in
        // leadbridge-service.js createChildLeadFromLB → return null path).
        if (plan.reason && /^parent_invariant_/.test(plan.reason)) {
          logger.warn(`[LB engine] grandchild_refusal tenant=${userId} parent=${plan.parentLeadId != null ? plan.parentLeadId : 'unknown'}`);
          if (identity.sf_lead_id) {
            await executors.enrichLeadFromLB(userId, identity.sf_lead_id, input);
            return { type: 'lead', id: identity.sf_lead_id, created: false, action: 'enriched' };
          }
          return null;
        }
        // Normal noop — identity already has customer, no lead created (legacy
        // returns 'identity_already_customer').
        if (identity.sf_customer_id) {
          return { type: 'customer', id: identity.sf_customer_id, created: false, action: 'identity_already_customer' };
        }
        return null;
      }

      case engine.DECISIONS.FROZEN:
        // Projection freeze. Adapter returns null; downstream conversation
        // and message upsert still run (identity row was updated by the
        // resolver inside reconcile()). Matches existing freeze semantics.
        return null;

      default:
        logger.warn(`[LB engine] unexpected decision ${plan.decision} tenant=${userId}`);
        return null;
    }
  }

  /**
   * Top-level adapter call.
   *
   * Steps:
   *   1. Build IdentityInput from the LB call shape.
   *   2. Build TenantPolicy from feature flags.
   *   3. Call engine.reconcile(). Identity row is created/updated by the
   *      resolver inside this step; no separate upsertParticipantIdentity
   *      is needed on the engine path.
   *   4. If ambiguous/error: return { identity:null, leadResult:null }.
   *      Caller (webhook/sync) attaches conversation with NULL identity FK
   *      — same shape as legacy ambiguous handling.
   *   5. Dispatch plan via dispatchPlan().
   *   6. Return { identity, leadResult }.
   *
   * The caller awaits this for the identity (needed for conversation
   * attach). The webhook handler treats dispatch errors as warn-and-ack
   * via try/catch around this call — same posture as legacy fire-and-forget.
   */
  async function resolveOrCreateLeadViaEngine(userId, input) {
    const engineInput = buildLBIdentityInput(userId, input);
    const policy = tenantPolicyForLB(userId);

    let result;
    try {
      result = await engine.reconcile(supabase, logger, engineInput, policy);
    } catch (e) {
      logger.warn(`[LB engine] reconcile threw tenant=${userId}: ${e && e.message}`);
      return { identity: null, leadResult: null };
    }

    if (result.kind === 'ambiguous') {
      logger.log(`[LB engine] path=engine tenant=${userId} decision=ambiguous candidates=${(result.identityCandidates || []).join(',')}`);
      return { identity: null, leadResult: null };
    }
    if (result.kind === 'error') {
      logger.warn(`[LB engine] reconcile error tenant=${userId}: ${result.error}`);
      return { identity: null, leadResult: null };
    }

    const identity = result.identity;
    const plan = result.plan;
    logger.log(`[LB engine] path=engine tenant=${userId} decision=${plan.decision} identity_id=${identity ? identity.id : 'null'}`);

    let leadResult = null;
    try {
      leadResult = await dispatchPlan(userId, identity, plan, input);
    } catch (e) {
      logger.warn(`[LB engine] dispatch threw tenant=${userId} decision=${plan.decision}: ${e && e.message}`);
    }

    return { identity, leadResult };
  }

  return {
    resolveOrCreateLeadViaEngine,
    dispatchPlan,
    tenantPolicyForLB,
    checkPrerequisites,
    emitPrereqMissingWarning,
    buildLBIdentityInput,
  };
}

module.exports = {
  makeAdapter,
  // Pure helpers — exported for tests
  tenantPolicyForLB,
  checkPrerequisites,
  emitPrereqMissingWarning,
  buildLBIdentityInput,
  _resetPrereqWarnCache,
};
