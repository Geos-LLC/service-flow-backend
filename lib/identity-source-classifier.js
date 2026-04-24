'use strict';

// Pure classifier: given an identity row, return which sources it has
// external IDs for. Each source collapses multiple ID columns into one
// logical source so the reporting bucket totals make sense.
//
//   openphone  = openphone_contact_id  OR  sigcore_participant_id  OR  sigcore_participant_key
//   leadbridge = leadbridge_contact_id OR  thumbtack_profile_id    OR  yelp_profile_id
//   zenbooker  = zenbooker_customer_id
//
// Returns { sources: string[] } — sorted and deduped.

const IDENTITY_SOURCE_COLUMNS = [
  'leadbridge_contact_id',
  'thumbtack_profile_id',
  'yelp_profile_id',
  'openphone_contact_id',
  'sigcore_participant_id',
  'sigcore_participant_key',
  'zenbooker_customer_id',
];

const COLUMN_TO_SOURCE = Object.freeze({
  leadbridge_contact_id: 'leadbridge',
  thumbtack_profile_id: 'leadbridge',
  yelp_profile_id: 'leadbridge',
  openphone_contact_id: 'openphone',
  sigcore_participant_id: 'openphone',
  sigcore_participant_key: 'openphone',
  zenbooker_customer_id: 'zenbooker',
});

function classifyIdentitySource(row) {
  if (!row || typeof row !== 'object') return { sources: [] };
  const set = new Set();
  for (const col of IDENTITY_SOURCE_COLUMNS) {
    if (row[col]) set.add(COLUMN_TO_SOURCE[col]);
  }
  return { sources: Array.from(set).sort() };
}

// Aggregate an array of identity rows into the standard reporting shape.
// Returns { total, multi_source, single_source: { leadbridge_only, openphone_only, zenbooker_only, no_source_ids } }.
function aggregateSourceCounts(rows) {
  const single = { leadbridge_only: 0, openphone_only: 0, zenbooker_only: 0, no_source_ids: 0 };
  let multi = 0;
  let total = 0;
  for (const row of (rows || [])) {
    total++;
    const { sources } = classifyIdentitySource(row);
    if (sources.length === 0) single.no_source_ids++;
    else if (sources.length === 1) {
      const key = `${sources[0]}_only`;
      if (single[key] != null) single[key]++;
    } else {
      multi++;
    }
  }
  return { total, multi_source: multi, single_source: single };
}

module.exports = {
  IDENTITY_SOURCE_COLUMNS,
  COLUMN_TO_SOURCE,
  classifyIdentitySource,
  aggregateSourceCounts,
};
