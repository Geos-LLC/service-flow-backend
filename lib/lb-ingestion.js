'use strict';

// Pure helpers for LeadBridge lead ingestion.
// Kept separate from leadbridge-service.js so the hard invariants can be
// unit-tested without standing up the full Express factory.

const LEGACY_FLAT_LB_SOURCES = new Set(['leadbridge_yelp', 'leadbridge_thumbtack']);

function pickLBSource({ accountDisplayName, channel }) {
  if (accountDisplayName) return `${accountDisplayName} (${channel})`;
  return channel === 'yelp' ? 'leadbridge_yelp' : 'leadbridge_thumbtack';
}

function isLegacyFlatSource(src) {
  return LEGACY_FLAT_LB_SOURCES.has(src);
}

// Fill-nulls-only patch. Upgrades legacy flat source to per-location;
// never downgrades, never overwrites user-edited non-null values.
function buildEnrichLeadPatch({ existing, input }) {
  if (!existing) return null;
  const patch = { updated_at: new Date().toISOString() };
  const newSource = pickLBSource({
    accountDisplayName: input.accountDisplayName,
    channel: input.channel,
  });
  if (!existing.source || isLegacyFlatSource(existing.source)) {
    if (newSource !== existing.source) patch.source = newSource;
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

module.exports = {
  pickLBSource,
  isLegacyFlatSource,
  buildEnrichLeadPatch,
  assertCreateLeadInvariant,
  LEGACY_FLAT_LB_SOURCES,
};
