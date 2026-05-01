-- ═══════════════════════════════════════════════════════════════
-- Migration 035: LeadBridge inbound lead.status_changed subscription
-- ═══════════════════════════════════════════════════════════════
-- Adds the third leg of the LB integration: LB → SF lead.status_changed
-- delivery via LB's CrmWebhookSubscription (POST /v1/integrations/webhooks).
--
-- Sister migration to 022 (SF → LB job.status_changed). Lives on the
-- same `communication_settings` row — this is the same integration
-- viewed from a different direction, not a separate entity.

ALTER TABLE communication_settings
  ADD COLUMN IF NOT EXISTS leadbridge_lead_status_subscription_id TEXT,
  ADD COLUMN IF NOT EXISTS leadbridge_lead_status_encrypted_secret TEXT,
  ADD COLUMN IF NOT EXISTS leadbridge_lead_status_secret_key_version INT,
  ADD COLUMN IF NOT EXISTS leadbridge_lead_status_webhook_url TEXT,
  ADD COLUMN IF NOT EXISTS leadbridge_lead_status_events TEXT[],
  ADD COLUMN IF NOT EXISTS leadbridge_lead_status_registered_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS leadbridge_lead_status_last_event_at TIMESTAMPTZ;

-- Index for webhook receive path: subscription_id is the natural key
-- LB stamps onto each delivery (we will resolve the SF user from it).
CREATE INDEX IF NOT EXISTS communication_settings_lb_lead_sub_idx
  ON communication_settings (leadbridge_lead_status_subscription_id)
  WHERE leadbridge_lead_status_subscription_id IS NOT NULL;

-- Refresh PostgREST schema cache
NOTIFY pgrst, 'reload schema';
