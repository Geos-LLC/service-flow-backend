'use strict';

/**
 * Lead aggregation helpers — canonical/child grouping per Phase 0.5.
 *
 * The leads table after migration 049 has three relevant columns:
 *
 *   id, parent_lead_id, canonical_lead_id (generated stored)
 *
 * Where canonical_lead_id = COALESCE(parent_lead_id, id).
 *
 * In application code, prefer the helpers in this module over scattering
 * COALESCE everywhere. Postgres queries should use the generated column
 * directly (the column is indexed on (user_id, canonical_lead_id)).
 *
 * Identity-graph layering note (per architecture doc §2):
 *   - leads = acquisition events (one row per LB submission, etc.)
 *   - canonical lead owns pipeline lifecycle, tasks, converted_customer_id
 *   - children are attribution/history rows; never pipeline-active
 *   - communication history belongs to the identity, not to any specific lead
 *
 * This module is PURE — no DB calls. Inputs are arrays of lead rows;
 * outputs are derived collections. Tested independently.
 */

/**
 * Return the canonical lead id for a lead row.
 * Mirrors the DB-side generated column.
 *
 *   canonicalLeadId({ id: 67, parent_lead_id: null })   → 67
 *   canonicalLeadId({ id: 245, parent_lead_id: 67 })    → 67
 */
function canonicalLeadId(lead) {
  if (!lead || lead.id == null) return null;
  if (lead.parent_lead_id != null) return lead.parent_lead_id;
  return lead.id;
}

/**
 * True iff this row is a canonical lead (no parent).
 */
function isCanonical(lead) {
  return !!lead && lead.parent_lead_id == null;
}

/**
 * True iff this row is a child acquisition event.
 */
function isChild(lead) {
  return !!lead && lead.parent_lead_id != null;
}

/**
 * Group leads by canonical_lead_id. Returns a map { canonicalLeadId → group }
 * where each group is:
 *   {
 *     canonical_lead_id,
 *     canonical_lead     — the canonical row when present in input (else null)
 *     children           — array of child rows (parent_lead_id == canonical_lead_id)
 *     all                — canonical + children, ordered by created_at ascending
 *     acquisition_count  — all.length
 *     total_lead_cost    — sum across all
 *     converted_customer_id — canonical's value (children never set), or null
 *     converted          — bool: canonical.converted_customer_id IS NOT NULL
 *     sources            — unique source strings across canonical + children
 *     origin_types       — unique lead_origin_type strings across canonical + children
 *   }
 *
 * Orphan children (parent_lead_id set but parent absent from input) form their
 * own group with canonical_lead_id = own.parent_lead_id and canonical_lead = null.
 * Reports should surface these so operators can investigate broken FKs.
 */
function groupByCanonical(leads) {
  const groups = new Map();
  const arr = Array.isArray(leads) ? leads : [];

  for (const lead of arr) {
    if (!lead || lead.id == null) continue;
    const cid = canonicalLeadId(lead);
    if (!groups.has(cid)) {
      groups.set(cid, {
        canonical_lead_id: cid,
        canonical_lead: null,
        children: [],
        all: [],
        acquisition_count: 0,
        total_lead_cost: 0,
        converted_customer_id: null,
        converted: false,
        sources: new Set(),
        origin_types: new Set(),
      });
    }
    const g = groups.get(cid);
    if (isCanonical(lead) && lead.id === cid) {
      g.canonical_lead = lead;
      if (lead.converted_customer_id != null) {
        g.converted_customer_id = lead.converted_customer_id;
        g.converted = true;
      }
    } else if (isChild(lead) && lead.parent_lead_id === cid) {
      g.children.push(lead);
    } else if (isChild(lead) && lead.parent_lead_id !== cid) {
      // Defensive — should never happen given canonicalLeadId definition.
      g.children.push(lead);
    }
    g.all.push(lead);
    g.acquisition_count = g.all.length;
    const cost = Number(lead.lead_cost);
    if (Number.isFinite(cost)) g.total_lead_cost += cost;
    if (lead.source) g.sources.add(lead.source);
    if (lead.lead_origin_type) g.origin_types.add(lead.lead_origin_type);
  }

  // Convert sets to arrays + sort all[] for stable output.
  const out = {};
  for (const [cid, g] of groups.entries()) {
    g.all.sort((a, b) => {
      const ta = a.created_at ? new Date(a.created_at).getTime() : 0;
      const tb = b.created_at ? new Date(b.created_at).getTime() : 0;
      if (ta !== tb) return ta - tb;
      return Number(a.id) - Number(b.id);
    });
    g.sources = [...g.sources];
    g.origin_types = [...g.origin_types];
    g.total_lead_cost = Math.round(g.total_lead_cost * 100) / 100;
    out[cid] = g;
  }
  return out;
}

/**
 * Person-level analytics counts. Same input as groupByCanonical.
 *
 * Returns:
 *   {
 *     total_leads              — count of all rows (acquisition events)
 *     unique_people            — count of canonical groups
 *     first_touch_count        — canonical leads with origin_type=first_touch
 *                                (or NULL — legacy treated as first_touch)
 *     repeat_acquisition_count — child leads
 *     reactivation_count       — canonical leads with origin_type=reactivation
 *     converted_people         — unique groups where canonical converted
 *     conversion_rate          — converted_people / unique_people
 *     total_acquisition_cost   — sum of all lead_cost
 *   }
 */
function personLevelCounts(leads) {
  const arr = Array.isArray(leads) ? leads : [];
  const groups = groupByCanonical(arr);
  const groupValues = Object.values(groups);

  let first_touch_count = 0;
  let reactivation_count = 0;
  let repeat_acquisition_count = 0;
  let total_acquisition_cost = 0;
  let converted_people = 0;

  for (const lead of arr) {
    const cost = Number(lead.lead_cost);
    if (Number.isFinite(cost)) total_acquisition_cost += cost;
    if (isChild(lead)) {
      repeat_acquisition_count++;
    } else {
      // Canonical row.
      if (lead.lead_origin_type === 'reactivation') {
        reactivation_count++;
      } else {
        // first_touch OR null (treat null as first_touch for legacy compat).
        first_touch_count++;
      }
    }
  }
  for (const g of groupValues) {
    if (g.converted) converted_people++;
  }
  const unique_people = groupValues.length;
  const conversion_rate = unique_people > 0 ? converted_people / unique_people : 0;

  return {
    total_leads: arr.length,
    unique_people,
    first_touch_count,
    repeat_acquisition_count,
    reactivation_count,
    converted_people,
    conversion_rate: Math.round(conversion_rate * 10000) / 10000,
    total_acquisition_cost: Math.round(total_acquisition_cost * 100) / 100,
  };
}

module.exports = {
  canonicalLeadId,
  isCanonical,
  isChild,
  groupByCanonical,
  personLevelCounts,
};
