-- ============================================================================
-- Migration 009: Use territories as locations, drop sf_locations
--
-- sf_locations was created in migration 008 as a lightweight location entity.
-- But SF already has territories (id 340 "St. Petersburg", 341 "Jacksonville")
-- which ARE the business locations. No need for a separate table.
--
-- This migration:
--   1. Repoints communication_account_location_mappings.sf_location_id → territories
--   2. Repoints communication_conversations.sf_location_id → territories
--   3. Drops sf_locations (empty, never populated)
--
-- Idempotent and non-destructive.
-- ============================================================================

-- ────────────────────────────────────────────────────────────────
-- 1. Drop FK constraints pointing to sf_locations
-- ────────────────────────────────────────────────────────────────

-- Drop FK on mappings
ALTER TABLE public.communication_account_location_mappings
  DROP CONSTRAINT IF EXISTS communication_account_location_mappings_sf_location_id_fkey;

-- Drop FK on conversations
ALTER TABLE public.communication_conversations
  DROP CONSTRAINT IF EXISTS communication_conversations_sf_location_id_fkey;

-- ────────────────────────────────────────────────────────────────
-- 2. Add new FK constraints pointing to territories
-- ────────────────────────────────────────────────────────────────

-- Mappings → territories
ALTER TABLE public.communication_account_location_mappings
  ADD CONSTRAINT communication_account_location_mappings_territory_fkey
  FOREIGN KEY (sf_location_id) REFERENCES public.territories(id) ON DELETE CASCADE;

-- Conversations → territories
ALTER TABLE public.communication_conversations
  ADD CONSTRAINT communication_conversations_territory_fkey
  FOREIGN KEY (sf_location_id) REFERENCES public.territories(id) ON DELETE SET NULL;

-- ────────────────────────────────────────────────────────────────
-- 3. Drop sf_locations (empty, never used)
-- ────────────────────────────────────────────────────────────────

DROP TRIGGER IF EXISTS trg_sf_loc_updated_at ON sf_locations;
DROP TABLE IF EXISTS public.sf_locations;

-- ────────────────────────────────────────────────────────────────
-- 4. Update comments to reflect territories usage
-- ────────────────────────────────────────────────────────────────

COMMENT ON COLUMN communication_account_location_mappings.sf_location_id IS
  'FK to territories.id. Maps this provider account (+ optional external location) to an SF business location/territory.';

COMMENT ON COLUMN communication_conversations.sf_location_id IS
  'FK to territories.id. Resolved SF business location. NULL = unresolved (valid state).';

-- ────────────────────────────────────────────────────────────────
-- Reload PostgREST schema cache
-- ────────────────────────────────────────────────────────────────

NOTIFY pgrst, 'reload schema';
