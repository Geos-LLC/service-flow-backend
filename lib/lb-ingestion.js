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
  isLegacyFlatSource,
  buildEnrichLeadPatch,
  assertCreateLeadInvariant,
  assertCreateChildLeadInvariant,
  LEGACY_FLAT_LB_SOURCES,
};
