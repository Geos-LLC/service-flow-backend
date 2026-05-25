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

// LB linkage extraction — turns an ingestion `input` payload into the
// `{lb_external_request_id, lb_channel, lb_business_id, lb_provider_account_id}`
// shape stored on `leads`. Returns nulls when the caller didn't pass the
// field. Channel falls back to `input.channel` when the caller didn't
// pass an explicit `lbChannel`. Numeric coercion is applied to
// provider_account_id since it lands in a BIGINT column.
//
// IMPORTANT: this builder never invents data — if `lbExternalRequestId`
// is missing we return `lb_external_request_id: null`. Callers that
// intend to write only when linkage is present should test for null and
// omit the patch.
function pickLbLink(input) {
  if (!input || typeof input !== 'object') {
    return {
      lb_external_request_id: null,
      lb_channel: null,
      lb_business_id: null,
      lb_provider_account_id: null,
    };
  }
  const chan = input.lbChannel != null ? input.lbChannel : input.channel;
  let acctId = null;
  if (input.lbProviderAccountId != null) {
    const n = Number(input.lbProviderAccountId);
    acctId = Number.isFinite(n) ? n : null;
  }
  return {
    lb_external_request_id:
      input.lbExternalRequestId != null ? String(input.lbExternalRequestId) : null,
    lb_channel: chan != null ? String(chan) : null,
    lb_business_id:
      input.lbBusinessId != null ? String(input.lbBusinessId) : null,
    lb_provider_account_id: acctId,
  };
}

// True iff the LB linkage carried by `link` is identical to what's on
// `existing`. Used by enrich to decide whether to log/skip vs. overwrite.
// Treats null-vs-undefined as equal. Coerces values to string for the text
// columns and to Number for provider_account_id.
function lbLinkMatches(existing, link) {
  if (!existing || !link) return false;
  const eq = (a, b) => {
    const an = a == null ? null : String(a);
    const bn = b == null ? null : String(b);
    return an === bn;
  };
  const eqNum = (a, b) => {
    const an = a == null ? null : Number(a);
    const bn = b == null ? null : Number(b);
    if (an === null && bn === null) return true;
    if (an === null || bn === null) return false;
    return an === bn;
  };
  return (
    eq(existing.lb_external_request_id, link.lb_external_request_id) &&
    eq(existing.lb_channel, link.lb_channel) &&
    eq(existing.lb_business_id, link.lb_business_id) &&
    eqNum(existing.lb_provider_account_id, link.lb_provider_account_id)
  );
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

  // LB linkage (migration 051) — atomic fill. The four columns are
  // treated as a group keyed on lb_external_request_id: we only fill
  // them when (a) we have an incoming external_request_id, AND (b) the
  // existing row has no external_request_id yet. We never partially
  // attribute (lb_channel without external_request_id is meaningless)
  // and we never overwrite an existing non-null external_request_id
  // with a different value — that case is a data-quality signal that
  // the operator should resolve manually.
  const link = pickLbLink(input);
  const existingExt = 'lb_external_request_id' in existing ? existing.lb_external_request_id : null;
  if (link.lb_external_request_id != null && existingExt == null) {
    patch.lb_external_request_id = link.lb_external_request_id;
    if (link.lb_channel != null) patch.lb_channel = link.lb_channel;
    if (link.lb_business_id != null) patch.lb_business_id = link.lb_business_id;
    if (link.lb_provider_account_id != null) patch.lb_provider_account_id = link.lb_provider_account_id;
  } else if (link.lb_external_request_id != null && existingExt != null && String(link.lb_external_request_id) === String(existingExt)) {
    // Same external id — opportunistically fill the secondary columns if missing.
    const fillIfNull = (col) => {
      const cur = col in existing ? existing[col] : null;
      if (link[col] != null && cur == null) patch[col] = link[col];
    };
    fillIfNull('lb_channel');
    fillIfNull('lb_business_id');
    fillIfNull('lb_provider_account_id');
  }

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
  pickLbLink,
  lbLinkMatches,
  isLegacyFlatSource,
  buildEnrichLeadPatch,
  assertCreateLeadInvariant,
  assertCreateChildLeadInvariant,
  LEGACY_FLAT_LB_SOURCES,
};
