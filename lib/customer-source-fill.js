'use strict';

// Fill customers.source / leads.source from the canonical lead_source_mappings
// lookup of the latest OpenPhone conversation's company tag for that phone.
//
// Policy:
//   - Fill nulls only. Never overwrite an existing non-null source.
//   - Only fill when the OP conversation's company resolves to a canonical
//     source via lead_source_mappings (provider='openphone'). No guessing.
//   - The source becomes the canonical source_name (e.g. "Thumbtack Tampa"
//     or "Google Tampa"), same shape as what LeadBridge / the OP conditional
//     lead creator write.
//
// Used as part of integrationSyncOrchestrator.fillMissingAttribution() — not
// a standalone operator action.

const { normalizePhone } = require('./name-normalize');

/**
 * Given an existing customer (or lead) row that has no source and a set of
 * candidate conversations for the same phone, return the best source to fill
 * (or null if nothing applies). Pure function — no DB access.
 *
 * @param {object} row                 — the customer / lead row
 * @param {object} sourceMappings      — { rawCompanyLowercased: canonicalSource, ... }
 * @param {Array}  conversations       — [{ company, last_event_at }], pre-filtered to this phone
 * @returns {string|null}
 */
function deriveSourceForRow(row, sourceMappings, conversations) {
  const out = deriveSourceFieldsForRow(row, sourceMappings, conversations);
  return out ? out.source : null;
}

/**
 * Two-field variant for the migration-050 attribution model. Returns
 * { source, source_raw } where source is the canonical mapped value and
 * source_raw is the OP `company` tag that produced the match (lossless
 * attribution preserved for debugging / re-mapping). Returns null when
 * nothing applies. Pure function — no DB access.
 *
 * When row.source is already non-empty: respects fill-nulls-only and returns
 * null (no patch).
 *
 * When row.source is empty but row.source_raw is also empty AND we find a
 * canonical match: returns both. This means the source_raw column gets
 * populated alongside source at fill time, no separate backfill needed.
 */
function deriveSourceFieldsForRow(row, sourceMappings, conversations) {
  if (!row) return null;
  if (row.source && String(row.source).trim() !== '') return null; // fill-nulls-only
  if (!Array.isArray(conversations) || conversations.length === 0) return null;
  // Newest conversation with a company tag wins.
  const sorted = [...conversations].sort((a, b) => {
    const ta = a?.last_event_at ? new Date(a.last_event_at).getTime() : 0;
    const tb = b?.last_event_at ? new Date(b.last_event_at).getTime() : 0;
    return tb - ta;
  });
  for (const c of sorted) {
    const company = (c?.company || '').trim();
    if (!company) continue;
    const canonical = sourceMappings[company.toLowerCase()];
    if (canonical) return { source: canonical, source_raw: company };
  }
  return null;
}

/**
 * Canonical last-10-digit key for phone matching. Returns null for short/invalid.
 */
function phoneKey(phone) {
  return normalizePhone(phone);
}

module.exports = { deriveSourceForRow, deriveSourceFieldsForRow, phoneKey };
