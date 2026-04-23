'use strict';

// Pure helpers for OpenPhone conditional lead ingestion.
// Decision logic lives here so unit tests can drive it without a DB.

const { isChannelOwnedByAnySource } = require('./source-registry');

const AGGREGATOR_NAME_RE = /(thumbtack|thumtack|thumback|thumbtac|tumbtack|thambtack|thumntack|yelp|leadbridge|google|facebook|bark|groupon|instagram|angi|homeadvisor|voolt|\bsite\b|cold call|refrenc|reference|recommend)/i;

function isAggregatorName(name) {
  if (!name) return false;
  return AGGREGATOR_NAME_RE.test(String(name));
}

// Detect an LB-owned channel from a canonical source_name like "Thumbtack Tampa" / "Yelp Jacksonville".
// Returns 'thumbtack' | 'yelp' | null.
function channelFromSourceName(sourceName) {
  if (!sourceName) return null;
  const s = String(sourceName).toLowerCase().trim();
  if (s.startsWith('thumbtack')) return 'thumbtack';
  if (s.startsWith('yelp')) return 'yelp';
  return null;
}

// Decide whether OpenPhone should create a lead for this identity.
// Amendment 3 — LB-recovery: when the channel is LB-owned but identity lacks
// leadbridge_contact_id, OpenPhone fills the gap.
//
// Inputs (all plain values, no DB):
//   identity          — the identity row (must have sf_lead_id/sf_customer_id/leadbridge_contact_id fields)
//   canonicalSource   — source_name resolved via lead_source_mappings (nullable)
//   participantName   — conversation.participant_name (nullable)
//
// Returns: { create, reason, note?, source?, channel? }
function shouldOpenPhoneCreateLead({ identity, canonicalSource, participantName }) {
  if (!identity) return { create: false, reason: 'no_identity' };
  if (identity.sf_lead_id) return { create: false, reason: 'identity_has_lead' };
  if (identity.sf_customer_id) return { create: false, reason: 'identity_has_customer' };
  if (!canonicalSource) return { create: false, reason: 'no_canonical_source' };
  const trimmedName = (participantName || '').trim();
  if (!trimmedName) return { create: false, reason: 'noise_no_name' };
  if (isAggregatorName(trimmedName)) return { create: false, reason: 'aggregator_name' };

  const channel = channelFromSourceName(canonicalSource);
  const ownedBy = channel ? isChannelOwnedByAnySource(channel, 'openphone') : null;

  if (ownedBy) {
    if (identity.leadbridge_contact_id) {
      return { create: false, reason: 'lb_owned_already_ingested' };
    }
    return {
      create: true,
      reason: 'lb_recovery',
      note: 'openphone_lb_recovery',
      source: canonicalSource,
      channel,
    };
  }

  return {
    create: true,
    reason: 'openphone_direct',
    note: 'openphone_direct',
    source: canonicalSource,
    channel: null,
  };
}

module.exports = {
  isAggregatorName,
  channelFromSourceName,
  shouldOpenPhoneCreateLead,
  AGGREGATOR_NAME_RE,
};
