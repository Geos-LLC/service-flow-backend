'use strict';

/**
 * Territory resolver — auto-fill `jobs.territory` when not provided.
 *
 * Trigger: POST /api/jobs with empty/null `territory`.
 * Override-safe: if territory is explicitly set, returns it unchanged.
 *
 * Resolution tiers (highest confidence first):
 *
 *   Tier 1 — Inherit from customer's most-recent prior job
 *     If the customer has prior jobs with non-empty territory, use the
 *     most recent one. Warning emitted ("inherited; please verify").
 *
 *   Tier 2a — Exact city name match
 *     If service_address_city matches an active territory's `name`
 *     case-insensitively, use it. NO warning — high confidence.
 *
 *   Tier 2b — Location-prefix match
 *     If service_address_city is the prefix of a single active
 *     territory's `location` (case-insensitive, comma-delimited),
 *     use it. Warning emitted ("matched by location; please verify").
 *
 *   No tier matches → returns territory=null with explanatory warning.
 *   Ambiguous matches (multiple territories) → null + warning.
 *
 * NEVER throws. Failures swallowed and surfaced as warnings.
 */

const VALID_CONFIDENCES = Object.freeze([
  'explicit',
  'inherited_from_prior_job',
  'exact_name',
  'location_prefix',
  'no_match',
  'ambiguous',
  'error',
]);

/**
 * @param {Object} supabase  Supabase client
 * @param {Object} args
 *   user_id              REQUIRED — tenant scope
 *   customer_id          OPTIONAL — if set, enables Tier 1
 *   service_address_city OPTIONAL — if set, enables Tier 2
 *   currentTerritory     OPTIONAL — operator-provided value; takes precedence
 *   logger               OPTIONAL — defaults to console
 * @returns {Promise<{
 *   territory: string|null,
 *   confidence: string,
 *   warning: string|null,
 *   source: string
 * }>}
 */
async function resolveTerritory(supabase, args) {
  const a = args || {};
  const logger = a.logger || console;

  try {
    if (a.user_id == null) {
      return {
        territory: null,
        confidence: 'error',
        warning: 'Territory resolver: user_id missing.',
        source: 'invalid_input',
      };
    }

    // Tier 0 — explicit value wins
    if (a.currentTerritory != null && String(a.currentTerritory).trim() !== '') {
      return {
        territory: String(a.currentTerritory).trim(),
        confidence: 'explicit',
        warning: null,
        source: 'operator_input',
      };
    }

    // Tier 1 — inherit from customer's most recent prior job
    if (a.customer_id != null) {
      const { data: prev, error: prevErr } = await supabase
        .from('jobs')
        .select('id, territory, created_at')
        .eq('user_id', a.user_id)
        .eq('customer_id', a.customer_id)
        .not('territory', 'is', null)
        .neq('territory', '')
        .order('created_at', { ascending: false })
        .limit(1);
      if (!prevErr && prev && prev[0] && prev[0].territory) {
        return {
          territory: prev[0].territory,
          confidence: 'inherited_from_prior_job',
          warning: `Territory "${prev[0].territory}" auto-inherited from this customer's prior job #${prev[0].id}. Please verify before saving.`,
          source: `prior_job_${prev[0].id}`,
        };
      }
    }

    // Tier 2 — city name → territory name/location match
    const city = a.service_address_city != null ? String(a.service_address_city).trim() : '';
    if (city) {
      const { data: terr, error: terrErr } = await supabase
        .from('territories')
        .select('id, name, location')
        .eq('user_id', a.user_id)
        .eq('status', 'active');
      if (terrErr || !terr || terr.length === 0) {
        return {
          territory: null,
          confidence: 'no_match',
          warning: `No active territories configured for this tenant. Manual selection required.`,
          source: 'no_territories',
        };
      }

      // Tier 2a — exact name match
      const cityLc = city.toLowerCase();
      const byName = terr.filter((t) => t.name && String(t.name).toLowerCase() === cityLc);
      if (byName.length === 1) {
        return {
          territory: byName[0].name,
          confidence: 'exact_name',
          warning: null,
          source: 'city_name_match',
        };
      }
      if (byName.length > 1) {
        return {
          territory: null,
          confidence: 'ambiguous',
          warning: `Multiple territories named "${city}": ${byName.map((t) => `#${t.id}`).join(', ')}. Manual selection required.`,
          source: 'ambiguous_name',
        };
      }

      // Tier 2b — location-prefix match
      const byLocation = terr.filter((t) =>
        t.location && String(t.location).toLowerCase().startsWith(cityLc + ',')
      );
      if (byLocation.length === 1) {
        return {
          territory: byLocation[0].name,
          confidence: 'location_prefix',
          warning: `Territory "${byLocation[0].name}" matched by location prefix (city "${city}" in "${byLocation[0].location}"). Please verify before saving.`,
          source: 'location_prefix_match',
        };
      }
      if (byLocation.length > 1) {
        return {
          territory: null,
          confidence: 'ambiguous',
          warning: `Multiple territories' location starts with "${city}": ${byLocation.map((t) => t.name).join(', ')}. Manual selection required.`,
          source: 'ambiguous_location',
        };
      }

      // No match for this city
      return {
        territory: null,
        confidence: 'no_match',
        warning: `No territory found matching city "${city}". Manual selection required.`,
        source: 'no_match_city',
      };
    }

    // No customer history, no city — nothing to work with
    return {
      territory: null,
      confidence: 'no_match',
      warning: 'Service address city missing; cannot auto-resolve territory. Manual selection required.',
      source: 'no_address',
    };
  } catch (err) {
    if (logger && logger.warn) {
      logger.warn(`[Territory resolver] error (swallowed): ${err && err.message}`);
    }
    return {
      territory: null,
      confidence: 'error',
      warning: 'Territory auto-resolution failed; manual selection required.',
      source: 'exception',
    };
  }
}

module.exports = {
  resolveTerritory,
  VALID_CONFIDENCES,
};
