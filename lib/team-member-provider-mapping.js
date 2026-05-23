'use strict';

/**
 * Team member ↔ Zenbooker provider mapping registry maintenance.
 *
 * The mapping table (team_member_provider_mappings) is a projection layer
 * used by the zb-outbound command router. The canonical link remains
 * team_members.zenbooker_id; this table mirrors that with mapping_source /
 * status / sync_health metadata so the outbound side can resolve
 * sf_team_member_id → zenbooker_provider_id without joining team_members
 * on every command.
 *
 * Migration 045 backfilled the table once from existing team_members.zenbooker_id.
 * After that, this helper must be called from every ZB-sync touch point that
 * sets or refreshes team_members.zenbooker_id, so newly-discovered providers
 * also land in the registry (otherwise outbound commands for those providers
 * will fail to resolve — see the 2026-05-22 Lesia Tampa repair).
 */

/**
 * Pure: derive the mapping row fields from sync inputs. No I/O.
 *
 * Status policy:
 *   - isActive = true (or omitted)  → status='active',   sync_health='healthy'
 *   - isActive = false              → status='inactive', sync_health='stale'
 *
 * 'unmapped' and 'conflict' statuses are reserved for manual UI flows and
 * the outbound-side conflict detector; this helper never produces them
 * because every call site has a known sf_team_member_id and a known
 * zenbooker_provider_id.
 *
 * Returns null when any required field is missing so the DB call is skipped
 * cleanly with a logged warning rather than producing a malformed row.
 */
function deriveMappingFields({ userId, sfTeamMemberId, zenbookerProviderId, isActive }) {
  if (!userId || !sfTeamMemberId || !zenbookerProviderId) {
    return null;
  }
  const active = isActive !== false; // default true
  return {
    user_id: userId,
    sf_team_member_id: String(sfTeamMemberId),
    zenbooker_provider_id: String(zenbookerProviderId),
    mapping_source: 'zb_sync',
    status: active ? 'active' : 'inactive',
    sync_health: active ? 'healthy' : 'stale',
  };
}

/**
 * Upsert mapping for a single team_member discovered/refreshed via ZB sync.
 * Idempotent on (user_id, sf_team_member_id) — repeated calls refresh
 * last_seen_at and overwrite zenbooker_provider_id when the ZB id has
 * changed for this SF team_member.
 *
 * @param {object} supabase  — Supabase client instance
 * @param {object} logger    — logger with .log/.warn/.error (any may be missing)
 * @param {object} input     — { userId, sfTeamMemberId, zenbookerProviderId, isActive? }
 * @returns {Promise<{ mode: 'upserted'|'skipped'|'error', id?: string, row?: object, reason?: string, error?: string }>}
 */
async function upsertTeamMemberProviderMappingFromZbSync(supabase, logger, input) {
  const fields = deriveMappingFields(input);
  if (!fields) {
    if (logger && logger.warn) {
      logger.warn(`[ZB-mapping] upsert skipped — missing required: userId=${input && input.userId} sfId=${input && input.sfTeamMemberId} zbId=${input && input.zenbookerProviderId ? 'set' : 'missing'}`);
    }
    return { mode: 'skipped', reason: 'missing_required_field' };
  }
  const now = new Date().toISOString();
  const row = { ...fields, last_seen_at: now, updated_at: now };
  try {
    const { data, error } = await supabase
      .from('team_member_provider_mappings')
      .upsert(row, { onConflict: 'user_id,sf_team_member_id' })
      .select('id, user_id, sf_team_member_id, zenbooker_provider_id, mapping_source, status, sync_health, last_seen_at')
      .maybeSingle();
    if (error) {
      if (logger && logger.error) {
        logger.error(`[ZB-mapping] upsert error for sfId=${fields.sf_team_member_id} zbId=${fields.zenbooker_provider_id}: ${error.message || JSON.stringify(error)}`);
      }
      return { mode: 'error', error: error.message || String(error) };
    }
    return { mode: 'upserted', id: data && data.id, row: data };
  } catch (e) {
    if (logger && logger.error) {
      logger.error(`[ZB-mapping] upsert threw for sfId=${fields.sf_team_member_id} zbId=${fields.zenbooker_provider_id}: ${e.message}`);
    }
    return { mode: 'error', error: e.message };
  }
}

module.exports = {
  deriveMappingFields,
  upsertTeamMemberProviderMappingFromZbSync,
};
