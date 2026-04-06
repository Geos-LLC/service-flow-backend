-- ============================================================================
-- Migration 006: LeadBridge Communication Layer
-- Phase A of the LeadBridge → Service Flow integration
--
-- Creates:
--   1. communication_participant_identities — cross-channel identity bridge
--   2. communication_provider_accounts — provider account mapping
--   3. communication_webhook_events — webhook event log
--   4. Extends communication_conversations with LB fields
--   5. Extends communication_messages with provider-scoped dedup
--   6. Extends communication_settings with LB connection fields
--
-- Scoping model:
--   NEW tables (participant_identities, provider_accounts, webhook_events):
--     workspace_id is the primary tenant boundary.
--     user_id kept for backward compat and auditing.
--     Unique constraints use workspace_id with user_id fallback
--     for legacy rows where workspace_id IS NULL.
--
--   EXISTING table (communication_conversations):
--     Originally scoped by user_id only (migration 002).
--     This migration adds workspace_id (nullable) for transition.
--     New unique indexes are workspace-scoped where workspace_id is set.
--     Existing user_id indexes from migration 002 are NOT dropped.
--     Backfill of workspace_id on existing rows is a separate step.
--
-- Idempotent: all IF NOT EXISTS, all new columns nullable.
-- ============================================================================


-- ────────────────────────────────────────────────────────────────
-- 0. Shared trigger function for updated_at maintenance
-- ────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;


-- ────────────────────────────────────────────────────────────────
-- 1. Participant Identities
-- Cross-channel identity bridge. One record per real-world person
-- as seen across any communication channel.
-- Links to SF lead or customer (Phase B/C).
-- ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.communication_participant_identities (
  id serial PRIMARY KEY,
  user_id integer NOT NULL REFERENCES public.users(id),
  workspace_id integer REFERENCES public.sf_workspaces(id),

  -- Contact identifiers (at least one should be set)
  normalized_phone varchar,          -- Canonical E.164 format (+1XXXXXXXXXX)
  email varchar,
  display_name varchar,

  -- External platform identifiers (strong identity keys)
  leadbridge_contact_id varchar,
  thumbtack_profile_id varchar,
  yelp_profile_id varchar,
  openphone_contact_id varchar,

  -- CRM entity linkage (set in Phase B/C, nullable until then)
  sf_lead_id integer REFERENCES public.leads(id) ON DELETE SET NULL,
  sf_customer_id integer REFERENCES public.customers(id) ON DELETE SET NULL,

  -- Provenance
  source_channel varchar,            -- channel that created this identity
  source_confidence varchar DEFAULT 'auto',  -- auto, manual, verified
  merge_parent_id integer REFERENCES public.communication_participant_identities(id),

  created_at timestamptz DEFAULT NOW(),
  updated_at timestamptz DEFAULT NOW()
);

-- Phone lookup — most common matching path
CREATE INDEX IF NOT EXISTS idx_cpi_phone
  ON communication_participant_identities(user_id, normalized_phone)
  WHERE normalized_phone IS NOT NULL;

-- Email lookup
CREATE INDEX IF NOT EXISTS idx_cpi_email
  ON communication_participant_identities(user_id, email)
  WHERE email IS NOT NULL;

-- Strong external identity keys — unique per workspace (prevents duplicate identities)
CREATE UNIQUE INDEX IF NOT EXISTS idx_cpi_lb_contact
  ON communication_participant_identities(workspace_id, leadbridge_contact_id)
  WHERE workspace_id IS NOT NULL AND leadbridge_contact_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_cpi_thumbtack_profile
  ON communication_participant_identities(workspace_id, thumbtack_profile_id)
  WHERE workspace_id IS NOT NULL AND thumbtack_profile_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_cpi_yelp_profile
  ON communication_participant_identities(workspace_id, yelp_profile_id)
  WHERE workspace_id IS NOT NULL AND yelp_profile_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_cpi_openphone_contact
  ON communication_participant_identities(workspace_id, openphone_contact_id)
  WHERE workspace_id IS NOT NULL AND openphone_contact_id IS NOT NULL;

-- Legacy fallback: user-scoped dedup for rows without workspace
CREATE UNIQUE INDEX IF NOT EXISTS idx_cpi_lb_contact_legacy
  ON communication_participant_identities(user_id, leadbridge_contact_id)
  WHERE workspace_id IS NULL AND leadbridge_contact_id IS NOT NULL;

-- CRM linkage lookups
CREATE INDEX IF NOT EXISTS idx_cpi_lead ON communication_participant_identities(sf_lead_id) WHERE sf_lead_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_cpi_customer ON communication_participant_identities(sf_customer_id) WHERE sf_customer_id IS NOT NULL;

-- Workspace scoping
CREATE INDEX IF NOT EXISTS idx_cpi_workspace ON communication_participant_identities(workspace_id) WHERE workspace_id IS NOT NULL;

-- Auto-update updated_at
DROP TRIGGER IF EXISTS trg_cpi_updated_at ON communication_participant_identities;
CREATE TRIGGER trg_cpi_updated_at
  BEFORE UPDATE ON communication_participant_identities
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


-- ────────────────────────────────────────────────────────────────
-- 2. Provider Accounts
-- One row per connected external account (Thumbtack business,
-- Yelp business, OpenPhone line, etc.).
-- Source of truth for routing — replaces settings JSON.
-- ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.communication_provider_accounts (
  id serial PRIMARY KEY,
  user_id integer NOT NULL REFERENCES public.users(id),
  workspace_id integer REFERENCES public.sf_workspaces(id),

  -- Provider identity
  provider varchar NOT NULL,              -- 'leadbridge', 'openphone', 'callio'
  channel varchar NOT NULL,               -- 'thumbtack', 'yelp', 'openphone', 'sms', 'voice'
  external_account_id varchar NOT NULL,   -- LB saved_account_id, OpenPhone phoneNumberId
  external_business_id varchar,           -- Platform's business ID

  -- Display
  display_name varchar,
  account_email varchar,

  -- Connection state
  status varchar NOT NULL DEFAULT 'active',     -- active, paused, disconnected, error
  webhook_status varchar DEFAULT 'pending',     -- pending, active, failed
  webhook_id varchar,

  -- Sync state
  sync_cursor varchar,
  last_synced_at timestamptz,
  sync_error text,

  -- Metadata
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT NOW(),
  updated_at timestamptz DEFAULT NOW()
);

-- Unique: one account per provider+channel+external_id per workspace
CREATE UNIQUE INDEX IF NOT EXISTS idx_cpa_unique_account
  ON communication_provider_accounts(workspace_id, provider, channel, external_account_id)
  WHERE workspace_id IS NOT NULL;

-- Legacy fallback: user-scoped for rows without workspace
CREATE UNIQUE INDEX IF NOT EXISTS idx_cpa_unique_account_legacy
  ON communication_provider_accounts(user_id, provider, channel, external_account_id)
  WHERE workspace_id IS NULL;

-- Provider listing
CREATE INDEX IF NOT EXISTS idx_cpa_provider
  ON communication_provider_accounts(user_id, provider, status);

-- Workspace listing
CREATE INDEX IF NOT EXISTS idx_cpa_workspace
  ON communication_provider_accounts(workspace_id, provider)
  WHERE workspace_id IS NOT NULL;

-- Auto-update updated_at
DROP TRIGGER IF EXISTS trg_cpa_updated_at ON communication_provider_accounts;
CREATE TRIGGER trg_cpa_updated_at
  BEFORE UPDATE ON communication_provider_accounts
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


-- ────────────────────────────────────────────────────────────────
-- 3. Webhook Event Log
-- Raw inbound webhook events for debugging, replay,
-- and idempotency checking.
-- ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.communication_webhook_events (
  id serial PRIMARY KEY,
  user_id integer REFERENCES public.users(id),
  workspace_id integer REFERENCES public.sf_workspaces(id),

  -- Event identity
  provider varchar NOT NULL,              -- 'leadbridge', 'sigcore'
  event_id varchar,                       -- Provider's event ID (for idempotency)
  event_type varchar NOT NULL,            -- 'thread.message.received', etc.

  -- Payload
  payload jsonb NOT NULL,
  signature varchar,                      -- HMAC signature if provided

  -- Processing state
  processed boolean DEFAULT false,
  processing_error text,
  received_at timestamptz DEFAULT NOW(),
  processed_at timestamptz,

  -- Account context (FK to provider_accounts, not varchar)
  provider_account_id integer REFERENCES public.communication_provider_accounts(id) ON DELETE SET NULL,
  external_account_id varchar,            -- Provider's own account identifier (for routing before FK resolved)
  channel varchar                         -- thumbtack, yelp, openphone
);

-- Idempotency: prevent duplicate processing
CREATE UNIQUE INDEX IF NOT EXISTS idx_cwe_event_id
  ON communication_webhook_events(provider, event_id)
  WHERE event_id IS NOT NULL;

-- Recent events lookup
CREATE INDEX IF NOT EXISTS idx_cwe_recent
  ON communication_webhook_events(provider, received_at DESC);

-- Unprocessed events (for retry)
CREATE INDEX IF NOT EXISTS idx_cwe_unprocessed
  ON communication_webhook_events(processed, received_at)
  WHERE processed = false;

-- Workspace scoping
CREATE INDEX IF NOT EXISTS idx_cwe_workspace
  ON communication_webhook_events(workspace_id, provider)
  WHERE workspace_id IS NOT NULL;


-- ────────────────────────────────────────────────────────────────
-- 4. Extend communication_conversations
-- Add workspace_id, LB-specific fields, and participant identity linkage.
--
-- Tenancy transition:
--   communication_conversations was created in migration 002 with
--   user_id as the sole scope. This migration adds workspace_id
--   as the real tenant boundary, consistent with the rest of the
--   schema. user_id is kept for backward compat — existing code
--   queries by user_id and will continue to work.
--
--   New unique constraints are workspace-scoped where workspace_id
--   is set, with user_id fallback for legacy rows.
--
--   Existing indexes from migration 002 (user_id-based) are NOT
--   dropped — they remain valid for current queries.
--
-- Note: columns provider, channel, last_event_at already exist
-- from migration 002.
-- ────────────────────────────────────────────────────────────────

-- Add workspace_id to conversations (nullable — backfilled separately)
ALTER TABLE public.communication_conversations
  ADD COLUMN IF NOT EXISTS workspace_id integer
    REFERENCES public.sf_workspaces(id) ON DELETE SET NULL;

-- External IDs from LeadBridge
ALTER TABLE public.communication_conversations
  ADD COLUMN IF NOT EXISTS external_conversation_id varchar,
  ADD COLUMN IF NOT EXISTS external_thread_id varchar,
  ADD COLUMN IF NOT EXISTS external_lead_id varchar;

-- Participant identity linkage
ALTER TABLE public.communication_conversations
  ADD COLUMN IF NOT EXISTS participant_identity_id integer
    REFERENCES public.communication_participant_identities(id) ON DELETE SET NULL;

-- Provider account linkage
ALTER TABLE public.communication_conversations
  ADD COLUMN IF NOT EXISTS provider_account_id integer
    REFERENCES public.communication_provider_accounts(id) ON DELETE SET NULL;

-- Sync state
ALTER TABLE public.communication_conversations
  ADD COLUMN IF NOT EXISTS sync_state varchar DEFAULT 'synced';

-- Workspace-scoped dedup: one conversation per provider+channel+external_conversation_id
-- This is the primary dedup key for LB conversations
CREATE UNIQUE INDEX IF NOT EXISTS idx_comm_conv_external_ws
  ON communication_conversations(workspace_id, provider, channel, external_conversation_id)
  WHERE workspace_id IS NOT NULL AND external_conversation_id IS NOT NULL;

-- Legacy fallback: user-scoped dedup for rows without workspace
CREATE UNIQUE INDEX IF NOT EXISTS idx_comm_conv_external_user
  ON communication_conversations(user_id, provider, channel, external_conversation_id)
  WHERE workspace_id IS NULL AND external_conversation_id IS NOT NULL;

-- Non-unique index on external_lead_id for lookup
-- NOT unique — LB may have multiple threads per lead
-- (e.g. Thumbtack negotiation thread + follow-up thread)
CREATE INDEX IF NOT EXISTS idx_comm_conv_external_lead
  ON communication_conversations(user_id, provider, channel, external_lead_id)
  WHERE external_lead_id IS NOT NULL;

-- Channel + activity index for tab filtering
CREATE INDEX IF NOT EXISTS idx_comm_conv_channel_activity
  ON communication_conversations(user_id, channel, last_event_at DESC);

-- Workspace + channel + activity for workspace-scoped queries
CREATE INDEX IF NOT EXISTS idx_comm_conv_ws_channel_activity
  ON communication_conversations(workspace_id, channel, last_event_at DESC)
  WHERE workspace_id IS NOT NULL;

-- Participant identity lookup
CREATE INDEX IF NOT EXISTS idx_comm_conv_identity
  ON communication_conversations(participant_identity_id)
  WHERE participant_identity_id IS NOT NULL;

-- Workspace listing
CREATE INDEX IF NOT EXISTS idx_comm_conv_workspace
  ON communication_conversations(workspace_id)
  WHERE workspace_id IS NOT NULL;


-- ────────────────────────────────────────────────────────────────
-- 5. Extend communication_messages
-- Add provider-scoped dedup and timestamps.
-- ────────────────────────────────────────────────────────────────

-- Provider-scoped external message ID for multi-provider dedup
ALTER TABLE public.communication_messages
  ADD COLUMN IF NOT EXISTS external_message_id varchar;

-- Unique dedup: one message per external_message_id per conversation
CREATE UNIQUE INDEX IF NOT EXISTS idx_comm_msg_provider_dedup
  ON communication_messages(conversation_id, external_message_id)
  WHERE external_message_id IS NOT NULL;

-- Delivery tracking timestamps
ALTER TABLE public.communication_messages
  ADD COLUMN IF NOT EXISTS sent_at timestamptz,
  ADD COLUMN IF NOT EXISTS delivered_at timestamptz;

-- Raw payload for debugging (nullable, only stored when useful)
ALTER TABLE public.communication_messages
  ADD COLUMN IF NOT EXISTS raw_payload jsonb;


-- ────────────────────────────────────────────────────────────────
-- 6. Extend communication_settings
-- Add LeadBridge connection fields.
-- Token stored here same pattern as sigcore_tenant_api_key.
-- ────────────────────────────────────────────────────────────────

ALTER TABLE public.communication_settings
  ADD COLUMN IF NOT EXISTS leadbridge_connected boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS leadbridge_integration_token text,
  ADD COLUMN IF NOT EXISTS leadbridge_user_id varchar,
  ADD COLUMN IF NOT EXISTS leadbridge_connected_at timestamptz;


-- ────────────────────────────────────────────────────────────────
-- 7. Comments
-- ────────────────────────────────────────────────────────────────

COMMENT ON TABLE communication_participant_identities IS
  'Cross-channel identity bridge. One record per real-world person across all comms channels. Links to SF lead or customer in Phase B/C.';

COMMENT ON TABLE communication_provider_accounts IS
  'Connected external accounts (Thumbtack business, Yelp business, etc). Source of truth for provider routing. Replaces settings JSON for account metadata.';

COMMENT ON TABLE communication_webhook_events IS
  'Raw inbound webhook events for debugging, replay, and idempotency. provider_account_id is FK to communication_provider_accounts.';

COMMENT ON COLUMN communication_participant_identities.normalized_phone IS
  'Canonical E.164 format (+1XXXXXXXXXX). Used as primary matching key across channels.';

COMMENT ON COLUMN communication_conversations.external_conversation_id IS
  'Provider-specific conversation/thread ID. Primary dedup key for LB conversations.';

COMMENT ON COLUMN communication_conversations.external_lead_id IS
  'LeadBridge lead ID. Non-unique — one lead may have multiple threads. Used for lookup, not dedup.';

COMMENT ON COLUMN communication_conversations.participant_identity_id IS
  'Links conversation to a cross-channel participant identity. Used for CRM mapping in Phase B/C.';

COMMENT ON COLUMN communication_webhook_events.provider_account_id IS
  'FK to communication_provider_accounts.id. Resolved during webhook processing.';

COMMENT ON COLUMN communication_webhook_events.external_account_id IS
  'Provider''s own account identifier from the webhook payload. Used for routing before FK is resolved.';


-- ────────────────────────────────────────────────────────────────
-- Reload PostgREST schema cache
-- ────────────────────────────────────────────────────────────────

NOTIFY pgrst, 'reload schema';
