'use strict';

const SOURCES = {
  leadbridge: {
    priority: 1,
    role: 'structured_platform_lead_source',
    creates_lead: 'yes',
    creates_customer: 'no',
    owned_channels: ['thumbtack', 'yelp'],
    external_id_columns: ['leadbridge_contact_id'],
    affects_identity_priority: true,
    is_sync_adapter: false,
  },
  openphone: {
    priority: 2,
    role: 'communication_and_non_lb_lead_intake_and_lb_recovery',
    creates_lead: 'conditional',
    creates_customer: 'no',
    owned_channels: [],
    external_id_columns: ['openphone_contact_id', 'sigcore_participant_id', 'sigcore_participant_key'],
    lead_source_derivation: 'company_field',
    affects_identity_priority: true,
    is_sync_adapter: false,
  },
  zenbooker: {
    priority: 3,
    role: 'sync_source',
    creates_lead: 'no',
    creates_customer: 'yes',
    owned_channels: [],
    external_id_columns: ['zenbooker_customer_id'],
    affects_identity_priority: false,
    is_sync_adapter: true,
  },
  manual_sf: {
    priority: 0,
    role: 'operator_controlled',
    creates_lead: 'yes',
    creates_customer: 'yes',
    owned_channels: [],
    external_id_columns: [],
    affects_identity_priority: true,
    is_sync_adapter: false,
  },
};

function getSource(name) {
  const entry = SOURCES[name];
  if (!entry) throw new Error(`Unknown source: ${name}`);
  return entry;
}

function isChannelOwnedByAnySource(channel, excludeSource = null) {
  const needle = String(channel || '').trim().toLowerCase();
  if (!needle) return null;
  for (const [name, cfg] of Object.entries(SOURCES)) {
    if (name === excludeSource) continue;
    if ((cfg.owned_channels || []).includes(needle)) return name;
  }
  return null;
}

function listSyncAdapters() {
  return Object.entries(SOURCES).filter(([, cfg]) => cfg.is_sync_adapter).map(([name]) => name);
}

function affectsIdentityPriority(sourceName) {
  return !!getSource(sourceName).affects_identity_priority;
}

module.exports = {
  SOURCES,
  getSource,
  isChannelOwnedByAnySource,
  listSyncAdapters,
  affectsIdentityPriority,
};
