-- ============================================================================
-- Migration 008: Multi-Location Communication Architecture
--
-- Introduces location-aware communication routing so SF supports providers
-- where 1 account = 1 location (Thumbtack) and 1 account = N locations (Yelp).
--
-- Creates:
--   1. sf_locations — lightweight operational location entity for communications
--   2. communication_account_location_mappings — provider account ↔ SF location bridge
--   3. Extends communication_conversations with raw + resolved location fields
--
-- Design notes:
--   - sf_locations is introduced as a communication-scoped operational entity.
--     It is NOT yet a company-wide canonical locations model.
--     Future expansion into CRM/business logic (customers, jobs, team_members)
--     is possible but NOT part of this migration.
--   - All new FK columns are nullable. Location resolution will not always
--     succeed, especially for Yelp where provider location metadata may be
--     incomplete. Unresolved location is a valid state.
--   - Both raw provider location fields AND resolved sf_location_id are stored
--     on conversations. Raw fields enable future remapping and debugging.
--   - Mapping table supports two patterns:
--     * account_level: 1 provider account → 1 SF location (Thumbtack)
--     * location_level: 1 provider account + external_location_id → 1 SF location (Yelp)
--
-- Idempotent: all IF NOT EXISTS, all new columns nullable.
-- ============================================================================


-- ────────────────────────────────────────────────────────────────
-- 0. Reuse shared trigger function (created in migration 006)
-- ────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;


-- ────────────────────────────────────────────────────────────────
-- 1. SF Locations
--
-- Lightweight operational location entity for the communication layer.
-- Represents a physical business location or service area.
--
-- NOT yet integrated with core business tables (customers, jobs,
-- team_members, services). That expansion is a separate future task.
--
-- Examples:
--   "Spotless Homes Jacksonville"
--   "Spotless Homes Tampa"
--   "Spotless Homes Saint Petersburg"
-- ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.sf_locations (
  id serial PRIMARY KEY,
  user_id integer NOT NULL REFERENCES public.users(id),
  workspace_id integer REFERENCES public.sf_workspaces(id),

  -- Location identity
  name varchar NOT NULL,                  -- "Spotless Homes Jacksonville"
  short_name varchar,                     -- "Jacksonville" (for badges)

  -- Address (optional — not all locations have a physical address)
  address text,
  city varchar,
  state varchar,
  zip_code varchar,
  timezone varchar,                       -- "America/New_York"

  -- Status
  is_active boolean NOT NULL DEFAULT true,

  -- Extensibility
  metadata jsonb DEFAULT '{}'::jsonb,

  created_at timestamptz DEFAULT NOW(),
  updated_at timestamptz DEFAULT NOW()
);

-- User listing (most common query path)
CREATE INDEX IF NOT EXISTS idx_sf_loc_user
  ON sf_locations(user_id, is_active);

-- Workspace listing
CREATE INDEX IF NOT EXISTS idx_sf_loc_workspace
  ON sf_locations(workspace_id)
  WHERE workspace_id IS NOT NULL;

-- Auto-update updated_at
DROP TRIGGER IF EXISTS trg_sf_loc_updated_at ON sf_locations;
CREATE TRIGGER trg_sf_loc_updated_at
  BEFORE UPDATE ON sf_locations
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

COMMENT ON TABLE sf_locations IS
  'Lightweight operational location entity for the communication layer. Represents a physical business location. NOT yet integrated with core business tables (customers, jobs, etc). Future CRM expansion possible.';


-- ────────────────────────────────────────────────────────────────
-- 2. Communication Account Location Mappings
--
-- Bridges provider accounts to SF locations.
-- Supports two mapping patterns:
--
-- ACCOUNT-LEVEL (Thumbtack):
--   1 provider account → 1 SF location
--   external_location_id IS NULL
--   mapping_type = 'account_level'
--
-- LOCATION-LEVEL (Yelp):
--   1 provider account + external_location_id → 1 SF location
--   external_location_id IS NOT NULL
--   mapping_type = 'location_level'
--
-- MANUAL:
--   Admin override, any mapping pattern
--   mapping_type = 'manual'
-- ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.communication_account_location_mappings (
  id serial PRIMARY KEY,
  workspace_id integer REFERENCES public.sf_workspaces(id),

  -- Provider account (which integration container)
  provider_account_id integer NOT NULL
    REFERENCES public.communication_provider_accounts(id) ON DELETE CASCADE,

  -- Resolved SF location
  sf_location_id integer NOT NULL
    REFERENCES public.sf_locations(id) ON DELETE CASCADE,

  -- Provider identity
  provider varchar NOT NULL,              -- 'leadbridge', 'openphone'
  channel varchar NOT NULL,               -- 'thumbtack', 'yelp'

  -- External provider location context (nullable — not all providers have sub-locations)
  external_location_id varchar,           -- Provider's location/business-unit ID within the account
  external_business_id varchar,           -- Provider's business ID if different from account
  external_location_name varchar,         -- "Spotless Homes Jacksonville" as seen by provider

  -- Mapping type
  mapping_type varchar NOT NULL DEFAULT 'account_level',
    -- 'account_level': entire account maps to one location (Thumbtack)
    -- 'location_level': specific external location maps to SF location (Yelp)
    -- 'manual': admin override

  -- Status
  is_active boolean NOT NULL DEFAULT true,

  -- Extensibility
  metadata jsonb DEFAULT '{}'::jsonb,

  created_at timestamptz DEFAULT NOW(),
  updated_at timestamptz DEFAULT NOW()
);

-- UNIQUENESS: Prevent duplicate mapping chaos
--
-- For location-level mappings (Yelp): one mapping per account + external location
CREATE UNIQUE INDEX IF NOT EXISTS idx_calm_location_level
  ON communication_account_location_mappings(
    provider_account_id, external_location_id
  )
  WHERE external_location_id IS NOT NULL AND is_active = true;

-- For account-level mappings (Thumbtack): one mapping per account when no external location
CREATE UNIQUE INDEX IF NOT EXISTS idx_calm_account_level
  ON communication_account_location_mappings(
    provider_account_id
  )
  WHERE external_location_id IS NULL AND mapping_type = 'account_level' AND is_active = true;

-- READ PATH: resolve location from provider account + external location
CREATE INDEX IF NOT EXISTS idx_calm_resolve
  ON communication_account_location_mappings(
    provider_account_id, external_location_id
  )
  WHERE is_active = true;

-- READ PATH: workspace + provider account lookup
CREATE INDEX IF NOT EXISTS idx_calm_workspace_account
  ON communication_account_location_mappings(workspace_id, provider_account_id)
  WHERE workspace_id IS NOT NULL AND is_active = true;

-- READ PATH: workspace + sf_location lookup (for "which accounts serve this location?")
CREATE INDEX IF NOT EXISTS idx_calm_workspace_location
  ON communication_account_location_mappings(workspace_id, sf_location_id)
  WHERE workspace_id IS NOT NULL AND is_active = true;

-- Auto-update updated_at
DROP TRIGGER IF EXISTS trg_calm_updated_at ON communication_account_location_mappings;
CREATE TRIGGER trg_calm_updated_at
  BEFORE UPDATE ON communication_account_location_mappings
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

COMMENT ON TABLE communication_account_location_mappings IS
  'Maps provider accounts (and their external sub-locations) to SF locations. Supports account-level (Thumbtack: 1 account = 1 location) and location-level (Yelp: 1 account = N locations) patterns.';

COMMENT ON COLUMN communication_account_location_mappings.mapping_type IS
  'account_level: entire account → one location (Thumbtack). location_level: specific external location → one location (Yelp). manual: admin override.';

COMMENT ON COLUMN communication_account_location_mappings.external_location_id IS
  'Provider''s sub-location identifier within the account. NULL for account-level mappings. Set for location-level mappings (Yelp).';


-- ────────────────────────────────────────────────────────────────
-- 3. Extend communication_conversations
--
-- Add both raw provider location fields AND resolved sf_location_id.
-- Raw fields: stored as-is from the provider for debugging/remapping.
-- Resolved: sf_location_id set by the location resolution service.
--
-- Both are nullable. Unresolved location is a valid state —
-- conversations are still stored and displayed.
--
-- NOTE: external_business_id may already exist from migration 006.
-- Using ADD COLUMN IF NOT EXISTS to be idempotent.
-- ────────────────────────────────────────────────────────────────

-- Resolved internal location
ALTER TABLE public.communication_conversations
  ADD COLUMN IF NOT EXISTS sf_location_id integer
    REFERENCES public.sf_locations(id) ON DELETE SET NULL;

-- Raw provider location context
ALTER TABLE public.communication_conversations
  ADD COLUMN IF NOT EXISTS external_location_id varchar;

ALTER TABLE public.communication_conversations
  ADD COLUMN IF NOT EXISTS external_business_id varchar;

ALTER TABLE public.communication_conversations
  ADD COLUMN IF NOT EXISTS external_location_name varchar;

-- READ PATH: conversations filtered by location + channel + activity
-- This is the primary query for "show me all Thumbtack conversations for Jacksonville"
CREATE INDEX IF NOT EXISTS idx_comm_conv_location_channel
  ON communication_conversations(user_id, sf_location_id, channel, last_event_at DESC)
  WHERE sf_location_id IS NOT NULL;

-- READ PATH: workspace-scoped location filter
CREATE INDEX IF NOT EXISTS idx_comm_conv_ws_location_channel
  ON communication_conversations(workspace_id, sf_location_id, channel, last_event_at DESC)
  WHERE workspace_id IS NOT NULL AND sf_location_id IS NOT NULL;

-- READ PATH: conversations with unresolved location
CREATE INDEX IF NOT EXISTS idx_comm_conv_unresolved_location
  ON communication_conversations(user_id, channel, last_event_at DESC)
  WHERE sf_location_id IS NULL AND provider = 'leadbridge';

-- READ PATH: provider account + external location lookup
CREATE INDEX IF NOT EXISTS idx_comm_conv_account_ext_location
  ON communication_conversations(provider_account_id, external_location_id)
  WHERE provider_account_id IS NOT NULL;

COMMENT ON COLUMN communication_conversations.sf_location_id IS
  'Resolved SF location. Set by location resolution service. NULL = unresolved (valid state, conversation still displayed).';

COMMENT ON COLUMN communication_conversations.external_location_id IS
  'Raw provider location ID from the provider/webhook. Stored for debugging and future remapping.';

COMMENT ON COLUMN communication_conversations.external_location_name IS
  'Raw provider location name (e.g., "Spotless Homes Jacksonville"). Stored for display when sf_location not yet resolved.';


-- ────────────────────────────────────────────────────────────────
-- Reload PostgREST schema cache
-- ────────────────────────────────────────────────────────────────

NOTIFY pgrst, 'reload schema';
