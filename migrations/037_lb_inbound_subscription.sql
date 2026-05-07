-- ═══════════════════════════════════════════════════════════════
-- Migration 037: LeadBridge inbound /webhooks subscription columns
-- ═══════════════════════════════════════════════════════════════
-- The original LeadBridge inbound integration (POST /api/integrations/
-- leadbridge/webhooks) was a v1-era webhook that LB delivers events to
-- without a stored per-user secret. Migration 035 added the parallel
-- /lead-status endpoint with HMAC verification. This migration adds the
-- same shape for the older /webhooks route so PR-2 can verify HMAC on
-- both LB inbound channels.
--
-- Symmetric to LEAD_STATUS_COLUMNS in leadbridge-service.js. Mirrors the
-- LB CrmWebhookSubscription model:
--   POST /v1/integrations/webhooks
--     body  : { name, webhookUrl, events, secret? }
--     return: { success, subscription: { id, name, webhookUrl, events,
--                                        isActive, secret } }
--
-- Code to register this subscription ships in the same PR via
-- registerInboundSubscription() in leadbridge-service.js. Existing
-- integrations need an operator-driven backfill (re-run /reconnect for
-- each connected user) before LB_INBOUND_HMAC_REQUIRED can be flipped on.

ALTER TABLE communication_settings
  ADD COLUMN IF NOT EXISTS leadbridge_inbound_subscription_id TEXT,
  ADD COLUMN IF NOT EXISTS leadbridge_inbound_encrypted_secret TEXT,
  ADD COLUMN IF NOT EXISTS leadbridge_inbound_secret_key_version INT,
  ADD COLUMN IF NOT EXISTS leadbridge_inbound_webhook_url TEXT,
  ADD COLUMN IF NOT EXISTS leadbridge_inbound_events TEXT[],
  ADD COLUMN IF NOT EXISTS leadbridge_inbound_registered_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS leadbridge_inbound_last_event_at TIMESTAMPTZ;

-- Index for verification path: subscription_id is the natural key LB
-- stamps onto each delivery (or could be — for now we scan by user_id).
CREATE INDEX IF NOT EXISTS communication_settings_lb_inbound_sub_idx
  ON communication_settings (leadbridge_inbound_subscription_id)
  WHERE leadbridge_inbound_subscription_id IS NOT NULL;

NOTIFY pgrst, 'reload schema';
