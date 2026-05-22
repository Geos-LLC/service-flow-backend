'use strict';

/**
 * Identity Graph Violation Emitter — architectural hardening (warn-only).
 *
 * The identity graph (`communication_participant_identities`) is the
 * authoritative source of identity linkage. CRM projections
 * (`leads.converted_customer_id`, `leads.parent_lead_id`, etc.) are
 * materialised from the graph by authorised writers.
 *
 * This module exists to detect — at runtime — code paths that write
 * directly to graph-owned surfaces without going through the
 * authorised writers. Stage 1 of the enforcement roadmap (see
 * docs/architecture/identity-enforcement-roadmap.md): warn-only.
 * Future stages add CI detection and runtime hard blocks.
 *
 * EMIT FORMAT (Loki-filterable):
 *
 *   [IdentityGraphViolation] kind=<kind> tenant=<id> target=<column-path>
 *                            source=<callsite> reason=<short> path=<call-stack-summary>
 *
 * VIOLATION KINDS (closed set; sync with VIOLATION_KINDS below):
 *
 *   direct_converted_customer_id_write
 *     A write to `leads.converted_customer_id` outside lib/identity-linker.js's
 *     `projectIdentityToCRM` / `applyLeadCustomerLink` / `attemptScoringFallback`.
 *
 *   direct_parent_lead_id_write
 *     A write to `leads.parent_lead_id` outside `createChildLeadFromLB` in
 *     leadbridge-service.js (the only authorised cardinality writer).
 *
 *   direct_lead_origin_type_write
 *     A write to `leads.lead_origin_type` outside the authorised LB ingest
 *     writers (`createLeadFromLB` / `createChildLeadFromLB`).
 *
 *   direct_sf_lead_id_write
 *     A direct `.update({ sf_lead_id: ... })` outside `setIdentityLead`
 *     in lib/identity-linker.js OR the fallback hydration block.
 *
 *   direct_sf_customer_id_write
 *     A direct `.update({ sf_customer_id: ... })` outside `setIdentityCustomer`
 *     in lib/identity-linker.js OR the fallback hydration block.
 *
 *   direct_identity_projection_write
 *     A generic catch-all for direct writes to communication_participant_
 *     identities columns that are graph-projection-related (sf_lead_id /
 *     sf_customer_id / last_hydrated_by / status).
 *
 *   integration_bypass
 *     An inbound integration handler reached the CRM materialisation step
 *     without consulting the reconciliation engine or the resolver. Used
 *     by adapters that detect they were called without prior resolver
 *     output.
 *
 *   operator_override_outside_linker
 *     A direct CRM-projection write performed by an operator endpoint
 *     that did not go through `applyLeadCustomerLink` (the authorised
 *     operator path).
 *
 *   transitional_bypass
 *     Acknowledged transitional bypass (migration code, retroactive
 *     repair, customer-merge operator endpoint). Emit so we have a
 *     count, but it's expected to be non-zero until the path retires.
 *
 * STAGE 1 POSTURE: this module emits warnings. It does NOT block,
 * throw, or alter behaviour. Future stages will tighten:
 *   - Stage 2: CI scanner enforces that direct writes are either
 *     allowlisted or carry an emitViolation call.
 *   - Stage 3: runtime hard block in non-test envs (set throwOnViolation
 *     env flag).
 *   - Stage 4: dead-code removal of bypass paths.
 *
 * NEVER throws. Defensive try/catch in every method so logging mistakes
 * never crash the caller.
 */

/**
 * Closed set of violation kinds. Use these constants in callers — the CI
 * scanner relies on stable string values.
 */
const VIOLATION_KINDS = Object.freeze({
  DIRECT_CONVERTED_CUSTOMER_ID_WRITE: 'direct_converted_customer_id_write',
  DIRECT_PARENT_LEAD_ID_WRITE:        'direct_parent_lead_id_write',
  DIRECT_LEAD_ORIGIN_TYPE_WRITE:      'direct_lead_origin_type_write',
  DIRECT_SF_LEAD_ID_WRITE:            'direct_sf_lead_id_write',
  DIRECT_SF_CUSTOMER_ID_WRITE:        'direct_sf_customer_id_write',
  DIRECT_IDENTITY_PROJECTION_WRITE:   'direct_identity_projection_write',
  INTEGRATION_BYPASS:                 'integration_bypass',
  OPERATOR_OVERRIDE_OUTSIDE_LINKER:   'operator_override_outside_linker',
  TRANSITIONAL_BYPASS:                'transitional_bypass',
});

const ALL_KINDS = Object.freeze(Object.values(VIOLATION_KINDS));

/**
 * Whether a given kind is a known closed-set member. Used by tests +
 * CI scanner to assert callers don't invent new kinds without updating
 * the catalog.
 */
function isKnownKind(kind) {
  return ALL_KINDS.includes(String(kind));
}

/**
 * Capture a short call-path summary from an Error object's stack. Used
 * by emitViolation to record where the bypass originated. Bounded to
 * `maxFrames` (default 6) to keep log lines compact.
 *
 * Returns a `;`-delimited summary of file:line frames, oldest→newest,
 * with node_modules and the emitter itself filtered out. Empty string
 * when stack is unavailable.
 */
function summariseCallPath(maxFrames = 6) {
  try {
    const stack = (new Error()).stack || '';
    const lines = stack.split('\n').slice(1);  // drop the "Error" header
    const frames = lines
      .map(l => l.trim())
      .filter(l => l.startsWith('at '))
      // Filter out the emitter and helper itself, and node_modules noise.
      .filter(l => !/identity-graph-violation\.js/.test(l))
      .filter(l => !/node_modules/.test(l))
      .filter(l => !/at Object\.<anonymous>/.test(l));
    if (frames.length === 0) return '';
    return frames
      .slice(0, maxFrames)
      .map(f => {
        // Convert "at funcName (path/file.js:42:7)" → "funcName@file.js:42"
        const m = f.match(/at (\S+)\s+\(.*?([^/\\]+\.js):(\d+)/);
        if (m) return `${m[1]}@${m[2]}:${m[3]}`;
        const m2 = f.match(/at .*?([^/\\]+\.js):(\d+)/);
        if (m2) return `${m2[1]}:${m2[2]}`;
        return f.replace(/^at\s+/, '').slice(0, 50);
      })
      .join(';');
  } catch (_) {
    return '';
  }
}

/**
 * Emit an `[IdentityGraphViolation]` warning. Never throws.
 *
 * @param {object} logger  — { log, warn, error } (Loghub-style is fine).
 * @param {object} fields
 *   - kind        REQUIRED — must be in VIOLATION_KINDS
 *   - tenant      OPTIONAL — user_id / workspace_id
 *   - target      OPTIONAL — column path (e.g., 'leads.converted_customer_id')
 *   - source      OPTIONAL — short callsite tag (e.g., 'server.js:10821', 'customer_merge_endpoint')
 *   - reason      OPTIONAL — short tag (e.g., 'operator_initiated', 'retroactive_repair')
 *   - includeCallPath — default true; captures a `path=...` field via summariseCallPath().
 *                       Pass false in hot paths to skip Error-stack overhead.
 */
function emitViolation(logger, fields) {
  if (!logger || typeof logger.warn !== 'function') return;
  const f = fields || {};
  const kind = String(f.kind || '').trim();
  if (!kind) return;
  try {
    const tenant = f.tenant != null ? f.tenant : 'null';
    const target = f.target != null ? f.target : null;
    const source = f.source != null ? f.source : null;
    const reason = f.reason != null ? f.reason : null;
    const includeCallPath = f.includeCallPath !== false;
    const callPath = includeCallPath ? summariseCallPath() : '';

    const parts = [
      `kind=${kind}`,
      `tenant=${tenant}`,
      target ? `target=${target}` : null,
      source ? `source=${source}` : null,
      reason ? `reason=${reason}` : null,
      callPath ? `path=${callPath}` : null,
    ].filter(Boolean);

    logger.warn(`[IdentityGraphViolation] ${parts.join(' ')}`);
  } catch (_) {
    // Never throw out of logging. Even if logger.warn itself throws,
    // we silently drop — observability failure is non-fatal.
  }
}

/**
 * Convenience wrapper for the most common case: "I am about to do a
 * known bypass and I want it to be observable." The caller emits the
 * violation, then proceeds with the bypass.
 *
 *   const { recordTransitionalBypass } = require('./identity-graph-violation');
 *   recordTransitionalBypass(logger, {
 *     target: 'leads.converted_customer_id',
 *     tenant: userId,
 *     source: 'customer_merge_endpoint',
 *     reason: 'operator_initiated_customer_merge',
 *   });
 *   await supabase.from('leads').update({ converted_customer_id: targetId }).eq(...);
 */
function recordTransitionalBypass(logger, fields = {}) {
  emitViolation(logger, {
    ...fields,
    kind: VIOLATION_KINDS.TRANSITIONAL_BYPASS,
  });
}

module.exports = {
  emitViolation,
  recordTransitionalBypass,
  summariseCallPath,
  isKnownKind,
  VIOLATION_KINDS,
  ALL_KINDS,
};
