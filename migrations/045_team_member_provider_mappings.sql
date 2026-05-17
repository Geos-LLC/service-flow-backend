-- ═══════════════════════════════════════════════════════════════
-- Migration 045: Team member ↔ ZB provider mapping registry
-- ═══════════════════════════════════════════════════════════════
-- Phase A — projection table for mapping health.
-- See docs/architecture/zb-outbound-command-confirmation.md §5.
-- Existing `team_members.zenbooker_id` remains the canonical link;
-- this table records mapping source, status, sync health.

CREATE TABLE IF NOT EXISTS team_member_provider_mappings (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               BIGINT NOT NULL,
  sf_team_member_id     TEXT NOT NULL,
  zenbooker_provider_id TEXT,
  mapping_source        TEXT NOT NULL,    -- 'zb_sync' | 'manual_link' | 'sf_originated'
  status                TEXT NOT NULL,    -- 'active' | 'inactive' | 'unmapped' | 'conflict' | 'archived'
  sync_health           TEXT NOT NULL,    -- 'healthy' | 'stale' | 'missing_upstream' | 'duplicate_candidate'
  last_seen_at          TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  conflict_metadata     JSONB,

  CONSTRAINT tmpm_user_team_unique UNIQUE (user_id, sf_team_member_id),
  CONSTRAINT tmpm_user_provider_unique UNIQUE (user_id, zenbooker_provider_id)
);

CREATE INDEX IF NOT EXISTS idx_tmpm_user_status
  ON team_member_provider_mappings (user_id, status);

CREATE INDEX IF NOT EXISTS idx_tmpm_unmapped
  ON team_member_provider_mappings (user_id)
  WHERE status = 'unmapped' OR sync_health = 'duplicate_candidate';

-- Backfill from existing team_members.zenbooker_id
-- Idempotent — ON CONFLICT DO NOTHING preserves any manually-curated rows.
INSERT INTO team_member_provider_mappings
  (user_id, sf_team_member_id, zenbooker_provider_id, mapping_source, status, sync_health, last_seen_at)
SELECT
  tm.user_id,
  tm.id::TEXT,
  tm.zenbooker_id,
  'zb_sync',
  'active',
  'healthy',
  now()
FROM team_members tm
WHERE tm.zenbooker_id IS NOT NULL
  AND tm.user_id IS NOT NULL
ON CONFLICT (user_id, sf_team_member_id) DO NOTHING;

NOTIFY pgrst, 'reload schema';
