'use strict';

// Pure helpers for LeadBridge lead ingestion.
// Kept separate from leadbridge-service.js so the hard invariants can be
// unit-tested without standing up the full Express factory.

const LEGACY_FLAT_LB_SOURCES = new Set(['leadbridge_yelp', 'leadbridge_thumbtack']);

// Raw provider attribution. Format: "${accountDisplayName} (${channel})", or
// "leadbridge_yelp" / "leadbridge_thumbtack" when display_name is absent
// (only happens for pre-multi-account historical paths).
function pickLBSourceRaw({ accountDisplayName, channel }) {
  if (accountDisplayName) return `${accountDisplayName} (${channel})`;
  return channel === 'yelp' ? 'leadbridge_yelp' : 'leadbridge_thumbtack';
}

// Two-field source attribution. Looks up the tenant-configured
// lead_source_mappings entry for (provider='leadbridge', raw_value=rawLabel)
// and returns the canonical mapped source if present, else falls back to raw.
//
// `sourceMappingsLookup` is the in-memory map { rawLowercased: canonicalName }
// produced by loadLBSourceMappings() — pass an empty map / null / undefined to
// preserve legacy single-field behavior (source === source_raw).
//
// Returns { source, source_raw } — both always populated. Callers persist both.
function pickLBSources({ accountDisplayName, channel, sourceMappingsLookup }) {
  const raw = pickLBSourceRaw({ accountDisplayName, channel });
  const mapped = sourceMappingsLookup && raw
    ? sourceMappingsLookup[String(raw).toLowerCase()]
    : null;
  return { source: mapped || raw, source_raw: raw };
}

// Back-compat: legacy single-value helper. Returns raw only. New code should
// use pickLBSources({ sourceMappingsLookup }) and persist both fields.
function pickLBSource({ accountDisplayName, channel }) {
  return pickLBSourceRaw({ accountDisplayName, channel });
}

function isLegacyFlatSource(src) {
  return LEGACY_FLAT_LB_SOURCES.has(src);
}

// Fill-nulls-only patch. Upgrades legacy flat source to per-location;
// never downgrades, never overwrites user-edited non-null values.
//
// When sourceMappingsLookup is supplied, also patches source_raw on rows that
// have never had it set (existing.source_raw IS NULL / undefined). This lets
// the enrich path opportunistically fill source_raw during ordinary sync
// activity without needing the standalone backfill script.
function buildEnrichLeadPatch({ existing, input }) {
  if (!existing) return null;
  const patch = { updated_at: new Date().toISOString() };
  const { source: newSource, source_raw: newRaw } = pickLBSources({
    accountDisplayName: input.accountDisplayName,
    channel: input.channel,
    sourceMappingsLookup: input.sourceMappingsLookup,
  });
  if (!existing.source || isLegacyFlatSource(existing.source)) {
    if (newSource !== existing.source) patch.source = newSource;
  }
  // Always fill source_raw when missing — lossless attribution upgrade.
  if (existing.source_raw == null && newRaw) {
    patch.source_raw = newRaw;
  }
  if (input.customerEmail && !existing.email) patch.email = input.customerEmail;
  if (Object.keys(patch).length === 1) return null;
  return patch;
}

// Defensive invariant — LB must NEVER create a new lead when identity already has one.
function assertCreateLeadInvariant(identity) {
  if (!identity) throw new Error('[LB] createLead: identity is required');
  if (identity.sf_lead_id) {
    throw new Error(`[LB] Invariant violated: createLead called for identity ${identity.id} with existing sf_lead_id=${identity.sf_lead_id}`);
  }
}

// Phase 0.5 — child lead invariants. Throws (with a descriptive message)
// when the parent state is unsafe for child creation.
//
// Rules:
//   I-CL-1  parent must exist (caller pre-fetched it)
//   I-CL-2  same tenant (cross-tenant FK leak guard — DB FK can't enforce)
//   I-CL-3  no grandchildren — parent must itself be canonical
//           (parent.parent_lead_id IS NULL). If the resolver ever points
//           identity.sf_lead_id at a child row, that is an identity-graph
//           corruption signal; emit a [LeadCardinalityConflict] log and
//           refuse rather than build a tree.
function assertCreateChildLeadInvariant(parentLead, intendedUserId) {
  if (!parentLead) {
    throw new Error('[LB] createChildLead: parent lead not found (I-CL-1)');
  }
  if (parentLead.user_id == null || Number(parentLead.user_id) !== Number(intendedUserId)) {
    throw new Error(`[LB] createChildLead: cross-tenant parent (I-CL-2): parent.user_id=${parentLead.user_id} intended=${intendedUserId}`);
  }
  if (parentLead.parent_lead_id != null) {
    throw new Error(`[LB] createChildLead: parent is itself a child (I-CL-3): parent.id=${parentLead.id} parent.parent_lead_id=${parentLead.parent_lead_id}`);
  }
}

module.exports = {
  pickLBSource,
  pickLBSourceRaw,
  pickLBSources,
  isLegacyFlatSource,
  buildEnrichLeadPatch,
  assertCreateLeadInvariant,
  assertCreateChildLeadInvariant,
  LEGACY_FLAT_LB_SOURCES,
};
