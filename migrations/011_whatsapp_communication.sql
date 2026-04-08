-- ═══════════════════════════════════════════════════════════════
-- Migration 011: WhatsApp Business Channel Integration
-- ═══════════════════════════════════════════════════════════════
-- WhatsApp is added as another provider/channel (like OpenPhone, Thumbtack, Yelp).
-- Conversations use the same tables with provider='whatsapp', channel='whatsapp'.
-- All fields for job/customer linking are optional — conversations exist independently.

-- ── 1. WhatsApp columns on communication_settings ──
ALTER TABLE communication_settings
  ADD COLUMN IF NOT EXISTS whatsapp_connected boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS whatsapp_phone_number varchar,
  ADD COLUMN IF NOT EXISTS whatsapp_connected_at timestamptz;

-- ── 2. Optional future-facing fields on communication_conversations ──
-- job_id: optional link to a job (for Operations view, future)
-- conversation_type: classification for view filtering (future)
-- These are NOT required for the base WhatsApp integration.
ALTER TABLE communication_conversations
  ADD COLUMN IF NOT EXISTS job_id integer,
  ADD COLUMN IF NOT EXISTS conversation_type varchar DEFAULT 'external_client';

-- ── 3. Optional job link on communication_messages ──
ALTER TABLE communication_messages
  ADD COLUMN IF NOT EXISTS job_id integer;

-- ── 4. Index for provider-based conversation queries ──
CREATE INDEX IF NOT EXISTS idx_conv_provider_time
  ON communication_conversations(user_id, provider, last_event_at DESC);
