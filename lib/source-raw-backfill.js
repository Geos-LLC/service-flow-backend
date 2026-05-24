'use strict';

// Pure helpers for the two-field source attribution backfill
// (scripts/backfill-source-raw.js). Extracted so the classification logic
// is unit-testable without standing up Supabase.
//
// Hard invariants (do not violate):
//   - source_raw NEVER overwritten when already non-null (apply step also
//     enforces .is('source_raw', null) at write time as a belt-and-braces guard)
//   - mapping lookups MUST be strictly user-scoped — pass a single tenant's
//     mapping bucket, never merge across tenants
//   - identity / external_lead_id / phone fields are NEVER touched

const LB_LEGACY_FLAT = new Set(['leadbridge_thumbtack', 'leadbridge_yelp']);

/**
 * Heuristic: does this source string look like a raw LB per-account label?
 * Matches "X (thumbtack)" / "X (yelp)" / legacy flat forms. Used to pick the
 * provider precedence (LB vs OP mapping lookup) for a row.
 */
function looksLikeLbRaw(s) {
  if (!s) return false;
  if (LB_LEGACY_FLAT.has(String(s).toLowerCase())) return true;
  return /\s\((thumbtack|yelp)\)\s*$/i.test(String(s));
}

/**
 * Classify a single leads row for backfill.
 *
 * @param row              {{ id, user_id, source, source_raw }}
 * @param tenantMappings   {{ leadbridge: {rawLower: canonical}, openphone: {rawLower: canonical} }}
 *                          MUST be the bucket for row.user_id only — never a merged-across-tenants object.
 * @returns                {{ action, new_source, new_source_raw, reason }}
 *                          action ∈ { 'remap_and_set_raw', 'set_raw_only', 'noop' }
 */
function classifyRow(row, tenantMappings) {
  if (!row) return { action: 'noop', new_source: null, new_source_raw: null, reason: 'null_row' };
  // Never overwrite an already-set raw.
  if (row.source_raw != null && String(row.source_raw).trim() !== '') {
    return { action: 'noop', new_source: row.source, new_source_raw: row.source_raw, reason: 'source_raw_already_set' };
  }
  const oldSource = row.source;
  if (oldSource == null || String(oldSource).trim() === '') {
    // Source was null/empty → there's nothing to preserve. Leave both null.
    // Future LB ingestion writes will fill both fields.
    return { action: 'noop', new_source: null, new_source_raw: null, reason: 'source_was_null' };
  }
  const lb = (tenantMappings && tenantMappings.leadbridge) || {};
  const op = (tenantMappings && tenantMappings.openphone) || {};
  const key = String(oldSource).toLowerCase();
  const lbCanonical = lb[key];
  const opCanonical = op[key];
  const isLbShape = looksLikeLbRaw(oldSource);
  const canonical = isLbShape ? (lbCanonical || opCanonical) : (opCanonical || lbCanonical);

  if (canonical && canonical !== oldSource) {
    return {
      action: 'remap_and_set_raw',
      new_source: canonical,
      new_source_raw: oldSource,
      reason: isLbShape ? 'lb_raw_mapped' : 'op_raw_mapped',
    };
  }
  // Either no mapping, or mapping equals current source (no remap needed) —
  // either way, preserve raw attribution by copying source → source_raw.
  return {
    action: 'set_raw_only',
    new_source: oldSource, // unchanged
    new_source_raw: oldSource,
    reason: canonical ? 'mapping_matches_current' : 'unmapped',
  };
}

module.exports = { classifyRow, looksLikeLbRaw, LB_LEGACY_FLAT };
