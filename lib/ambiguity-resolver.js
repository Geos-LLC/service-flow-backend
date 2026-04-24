'use strict';

// Pure helpers for resolving entries in communication_identity_ambiguities.
// The runtime endpoint wraps these with DB reads/writes; tests exercise them
// directly against plain objects.

const VALID_ACTIONS = Object.freeze(['merge_into', 'create_new', 'abandon']);

// Map a source name to the identity column that holds its external ID.
// Mirrors lib/source-registry.js ownership.
const SOURCE_TO_EXTERNAL_COL = Object.freeze({
  leadbridge: 'leadbridge_contact_id',
  openphone: 'openphone_contact_id',
  zenbooker: 'zenbooker_customer_id',
});

/**
 * Validate a resolve request before touching the DB.
 * Throws a descriptive Error on any rule violation.
 *
 * @param {object} ambiguity  — row from communication_identity_ambiguities
 * @param {object} body       — { action, target_identity_id }
 */
function validateResolveRequest(ambiguity, body) {
  if (!ambiguity) throw new Error('ambiguity not found');
  if (ambiguity.status !== 'open' && ambiguity.status !== 'auto_merged_weak') {
    throw new Error(`ambiguity already ${ambiguity.status}`);
  }
  const action = body?.action;
  if (!VALID_ACTIONS.includes(action)) {
    throw new Error(`invalid action; must be one of ${JSON.stringify(VALID_ACTIONS)}`);
  }
  if (action === 'merge_into') {
    const target = body.target_identity_id;
    if (!Number.isInteger(target)) throw new Error('merge_into requires integer target_identity_id');
    const candidates = Array.isArray(ambiguity.candidate_identity_ids) ? ambiguity.candidate_identity_ids : [];
    if (!candidates.includes(target)) {
      throw new Error(`target_identity_id ${target} is not in candidate list [${candidates.join(', ')}]`);
    }
  }
}

/**
 * Build the UPDATE patch for merging the ambiguity's attempted data into an
 * existing target identity. Fill-nulls-only: never overwrite any non-null
 * field on the target. Adds the source-specific external ID if absent.
 *
 * @param {object} target    — the target identity row
 * @param {object} ambiguity — the ambiguity row (has attempted_* fields + source)
 * @returns {object|null}    — patch to UPDATE, or null if nothing to change
 */
function buildMergePatch(target, ambiguity) {
  if (!target) return null;
  const patch = { updated_at: new Date().toISOString() };
  let dirty = false;

  // Source-specific external ID from the attempted payload.
  const externalCol = SOURCE_TO_EXTERNAL_COL[ambiguity?.source];
  if (externalCol && ambiguity.attempted_external_id && !target[externalCol]) {
    patch[externalCol] = ambiguity.attempted_external_id;
    dirty = true;
  }

  // Phone / name / email — fill nulls only. Normalized phone is already the
  // canonical last-10 form after Phase 0 migration.
  if (ambiguity?.attempted_phone && !target.normalized_phone) {
    patch.normalized_phone = ambiguity.attempted_phone;
    dirty = true;
  }
  if (ambiguity?.attempted_name && !target.display_name) {
    patch.display_name = ambiguity.attempted_name;
    dirty = true;
  }
  if (ambiguity?.attempted_normalized_name && !target.normalized_name) {
    patch.normalized_name = ambiguity.attempted_normalized_name;
    dirty = true;
  }

  // Sticky manual tag — operator has decided, future automated runs must not
  // reclassify this identity. identity_priority_source='manual' is the sticky
  // flag honored by the resolver. status belongs to a constrained enum
  // (resolved_customer|resolved_lead|resolved_both|unresolved_floating|ambiguous)
  // and isn't where the manual flag goes.
  if (target.identity_priority_source !== 'manual') {
    patch.identity_priority_source = 'manual';
    dirty = true;
  }

  return dirty ? patch : null;
}

/**
 * Build the INSERT row for a new identity created from the attempted payload
 * of an ambiguity — used when the operator clicks "Create new identity"
 * because none of the candidates are correct.
 *
 * @param {object} ambiguity — the ambiguity row
 * @returns {object|null}    — insert row, or null if not enough data
 */
function buildCreateFromAmbiguity(ambiguity) {
  if (!ambiguity) return null;
  const externalCol = SOURCE_TO_EXTERNAL_COL[ambiguity.source];
  if (!ambiguity.attempted_external_id && !ambiguity.attempted_phone && !ambiguity.attempted_name) {
    return null;
  }
  const row = {
    user_id: ambiguity.user_id,
    normalized_phone: ambiguity.attempted_phone || null,
    display_name: ambiguity.attempted_name || null,
    normalized_name: ambiguity.attempted_normalized_name || null,
    source_channel: ambiguity.source,
    source_confidence: 'manual',
    // New identity with no CRM link — still "floating" from the status enum's
    // perspective. Sticky operator decision lives in identity_priority_source.
    status: 'unresolved_floating',
    identity_priority_source: 'manual',
  };
  if (externalCol && ambiguity.attempted_external_id) {
    row[externalCol] = ambiguity.attempted_external_id;
  }
  return row;
}

/**
 * Build the audit patch written back to the ambiguity row itself.
 * Called for all three actions.
 */
function buildAmbiguityAuditPatch({ action, resolvedBy, resolvedIdentityId = null }) {
  const next = action === 'abandon' ? 'abandoned' : 'resolved';
  return {
    status: next,
    resolved_at: new Date().toISOString(),
    resolved_by: resolvedBy,
    resolved_identity_id: resolvedIdentityId,
  };
}

module.exports = {
  VALID_ACTIONS,
  SOURCE_TO_EXTERNAL_COL,
  validateResolveRequest,
  buildMergePatch,
  buildCreateFromAmbiguity,
  buildAmbiguityAuditPatch,
};
