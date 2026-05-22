'use strict';

/**
 * Identity Write Gate — runtime enforcement infrastructure (DARK / instrumentation-only).
 *
 * STATUS: Stage 3 foundation. The module is callable today but never
 * blocks, throws, or mutates behavior. Pure passive observer. When the
 * enforcement roadmap advances to Stage 3 (runtime block), this module
 * becomes the insertion point for hard refusal of writes that aren't
 * on the per-tenant allow-list. For now it produces only metadata +
 * a structured [IdentityWriteGate] log line.
 *
 * Design constraints (must hold for THIS PR):
 *
 *   - NEVER throw. Garbage input, missing logger, logger that throws —
 *     all silently swallowed. The gate must not be able to take down
 *     a write path.
 *   - NEVER block. `allowed` is always `true` today. The shape exists
 *     so future code can branch on it without rewriting call sites.
 *   - NEVER mutate global state. Pure function.
 *
 * Use:
 *
 *     const identityWriteGate = require('./identity-write-gate');
 *     identityWriteGate.evaluateIdentityWrite({
 *       tenantId: userId,
 *       source: 'server.js:maybeCreateLeadFromOpenPhone:crm_phone_anchor_customer',
 *       target: 'communication_participant_identities.sf_customer_id',
 *       operation: 'update',
 *       bypassStage: 'stage-4-adapter-only',
 *       owner: 'identity-v5',
 *       violationClass: 'RV-2',
 *       logger,
 *     });
 *
 * Companion docs:
 *   docs/architecture/runtime-violation-taxonomy.md (RV-1 … RV-7 classes)
 *   docs/architecture/runtime-allowlist-design.md (Stage 3 design)
 *   docs/operations/runtime-enforcement-metrics.md (metrics contract)
 *   docs/architecture/identity-enforcement-roadmap.md (stage progression)
 *   docs/architecture/retirement-stage-registry.md (stage vocabulary)
 *   docs/architecture/identity-governance-principles.md (top-level)
 */

// ── Canonical vocabulary ───────────────────────────────────────────

// Closed set of retirement stages (retirement-stage-registry.md §2).
const KNOWN_STAGES = Object.freeze([
  'stage-1-observe',
  'stage-2-ci-static',
  'stage-3-runtime-block',
  'stage-4-adapter-only',
  'stage-5-remove',
]);
const KNOWN_STAGES_SET = new Set(KNOWN_STAGES);

// Runtime violation taxonomy (runtime-violation-taxonomy.md).
const KNOWN_VIOLATION_CLASSES = Object.freeze([
  'RV-1', // Missing metadata
  'RV-2', // Direct graph write
  'RV-3', // Cross-tenant identity write
  'RV-4', // Unauthorized bypass
  'RV-5', // Replay inconsistency
  'RV-6', // Projection divergence
  'RV-7', // Runtime fallback escalation
]);
const KNOWN_VIOLATION_CLASSES_SET = new Set(KNOWN_VIOLATION_CLASSES);

// Stages that WOULD be blocked once Stage 3 runtime enforcement activates.
// `stage-1-observe` is explicitly NOT in this set — sites at stage-1 stay
// allowed even under runtime gating. Sites at stage-2 and beyond ARE
// candidates for refusal. (Today: nothing is refused regardless of stage.)
const BLOCK_CANDIDATE_STAGES = new Set([
  'stage-2-ci-static',
  'stage-3-runtime-block',
  'stage-4-adapter-only',
]);

const KNOWN_OPERATIONS = Object.freeze(['insert', 'update', 'delete', 'upsert']);
const KNOWN_OPERATIONS_SET = new Set(KNOWN_OPERATIONS);

// ── Pure helpers ──────────────────────────────────────────────────

function safeString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * Evaluate an identity write. Pure informational today.
 *
 * @param {object} input
 * @param {number|string|null} input.tenantId       - tenant (user_id) issuing the write
 * @param {string}             input.source         - 'file:function[:branch]' identifier
 * @param {string}             input.target         - 'table.column' or surface descriptor
 * @param {string}             input.operation      - 'insert' | 'update' | 'delete' | 'upsert'
 * @param {string}             input.bypassStage    - one of KNOWN_STAGES
 * @param {string}             input.owner          - typically 'identity-v5'
 * @param {string}            [input.violationClass]- one of KNOWN_VIOLATION_CLASSES
 * @param {object}            [input.logger]        - logger with .log() (optional)
 *
 * @returns {object} evaluation
 *   - allowed:                true (ALWAYS true today)
 *   - warn:                   true when metadata is incomplete
 *   - future_block_candidate: would be blocked when Stage 3 activates
 *   - metadata_complete:      all required fields present and known
 *   - observability_key:      canonical identifier for Loki filtering
 *   - violation_class:        echoed for grouping, null if not provided
 *   - notes:                  diagnostic tags (e.g. 'missing_source')
 *
 * NEVER throws. Garbage in → degraded `evaluation` out (allowed still true).
 */
function evaluateIdentityWrite(input) {
  const i = (input && typeof input === 'object') ? input : {};
  const notes = [];

  const tenantId       = (i.tenantId !== undefined && i.tenantId !== null) ? i.tenantId : null;
  const source         = safeString(i.source);
  const target         = safeString(i.target);
  const operation      = safeString(i.operation);
  const bypassStage    = safeString(i.bypassStage);
  const owner          = safeString(i.owner);
  const violationClass = safeString(i.violationClass);

  if (!source)       notes.push('missing_source');
  if (!target)       notes.push('missing_target');
  if (!operation)    notes.push('missing_operation');
  else if (!KNOWN_OPERATIONS_SET.has(operation)) notes.push('unknown_operation');
  if (!bypassStage)  notes.push('missing_bypass_stage');
  else if (!KNOWN_STAGES_SET.has(bypassStage)) notes.push('unknown_bypass_stage');
  if (!owner)        notes.push('missing_owner');
  if (violationClass && !KNOWN_VIOLATION_CLASSES_SET.has(violationClass)) {
    notes.push('unknown_violation_class');
  }

  const metadata_complete = Boolean(
    source && target && operation && KNOWN_OPERATIONS_SET.has(operation) &&
    bypassStage && KNOWN_STAGES_SET.has(bypassStage) && owner
  );
  const future_block_candidate = bypassStage ? BLOCK_CANDIDATE_STAGES.has(bypassStage) : false;
  const observability_key = source || 'unknown_source';
  const warn = !metadata_complete;

  const evaluation = {
    allowed: true,                  // ALWAYS true today — Stage 3 flips this
    warn,
    future_block_candidate,
    metadata_complete,
    observability_key,
    violation_class: violationClass,
    notes,
  };

  // Emit structured log line. Swallow any logger error so the gate
  // cannot break the calling write path under any condition.
  if (i.logger && typeof i.logger.log === 'function') {
    try {
      const parts = [
        '[IdentityWriteGate]',
        `tenant=${tenantId === null ? 'null' : tenantId}`,
        `source=${source || 'null'}`,
        `target=${target || 'null'}`,
        `operation=${operation || 'null'}`,
        `stage=${bypassStage || 'null'}`,
        `owner=${owner || 'null'}`,
        `future_block_candidate=${future_block_candidate}`,
        `metadata_complete=${metadata_complete}`,
      ];
      if (violationClass) parts.push(`violation_class=${violationClass}`);
      if (notes.length > 0) parts.push(`notes=${notes.join(',')}`);
      i.logger.log(parts.join(' '));
    } catch (_) {
      /* never throw from the gate */
    }
  }

  return evaluation;
}

module.exports = {
  evaluateIdentityWrite,
  KNOWN_STAGES,
  KNOWN_VIOLATION_CLASSES,
  BLOCK_CANDIDATE_STAGES,
  KNOWN_OPERATIONS,
};
