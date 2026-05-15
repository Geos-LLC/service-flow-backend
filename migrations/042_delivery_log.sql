-- 042_delivery_log.sql
-- P1.6 (Synchronization Constitution §0 P2 + §9 P1.6) — unified delivery audit.
--
-- Operators currently have to query 6+ different tables/log streams to answer
-- "did this message get through?":
--   - notification_email_logs (email sends)
--   - leadbridge_outbound_events (LB→SF, SF→LB delivery queue)
--   - zb_sync_dirty (ZB sync downstream failures)
--   - communication_webhook_events (LB inbound dedup)
--   - payment_reconcile_runs/catches (ZB reconcile audit)
--   - Loki log streams ([ZB-dirty], [ZB-atomic], [Boundary], [NotificationEmail])
--
-- delivery_log is the unified queryable surface. Every notable cross-system
-- delivery (outbound or inbound) MAY write here. Coexistence strategy:
--   - The existing per-domain tables stay canonical for their own queries.
--   - delivery_log is dual-written via lib/delivery-log.js helper.
--   - Operators querying "all deliveries by tenant/correlation/direction"
--     read THIS table.
--   - Long-term replacement: when a per-domain table's only consumer
--     migrates to read from delivery_log, the per-domain writer can be
--     dropped. notification_email_logs may eventually become a view.
--
-- The schema is intentionally generic. Fields outside the core taxonomy
-- (provider-specific IDs, retry detail, etc.) live in `context jsonb`.

CREATE TABLE IF NOT EXISTS delivery_log (
  id                   BIGSERIAL PRIMARY KEY,

  -- Tenant scope. NULL only for platform-level events (admin tests, system).
  user_id              BIGINT NULL,

  -- Routing identity
  source_system        TEXT NOT NULL,        -- 'service_flow' | 'leadbridge' | 'sigcore' | 'zenbooker' | 'sendgrid' | 'stripe' | 'whatsapp'
  destination_system   TEXT NOT NULL,        -- same vocabulary; pair describes the edge
  channel              TEXT NULL,            -- 'email' | 'webhook' | 'sms' | 'whatsapp' | 'voice' | 'api_rpc'
  event_type           TEXT NOT NULL,        -- 'email.invoice' | 'webhook.sigcore.openphone.inbound' | 'lb_outbound.lead.status_changed' | ...

  -- Correlation
  correlation_id       TEXT NULL,            -- the cross-system tracking id (event_id, sigcore_message_id, provider message id, etc.)
  request_id           TEXT NULL,            -- HTTP request id when available (X-Request-Id, etc.)
  payload_hash         TEXT NULL,            -- SHA-256 hex of the canonical payload, for replay detection

  -- Direction
  delivery_direction   TEXT NOT NULL,        -- 'outbound' | 'inbound'
                                              -- outbound: we sent it (to the other system)
                                              -- inbound:  we received it (from the other system)

  -- Outcome (terminal or interim)
  status               TEXT NOT NULL,        -- 'queued' | 'sent' | 'delivered' | 'failed' | 'rejected' | 'rate_limited' | 'duplicate' | 'timeout'
  response_code        INTEGER NULL,         -- HTTP status, provider-specific code, etc.
  latency_ms           INTEGER NULL,
  retry_count          INTEGER NOT NULL DEFAULT 0,

  -- Provider trace
  provider             TEXT NULL,            -- 'sendgrid' | 'sigcore' | 'leadbridge' | 'zenbooker' | 'twilio'
  provider_message_id  TEXT NULL,

  -- Error detail
  error_message        TEXT NULL,
  error_class          TEXT NULL,

  -- Timing
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at          TIMESTAMPTZ NULL,

  -- Arbitrary debug context (per-source idiosyncratic fields)
  context              JSONB NULL
);

-- Tenant scope index — operator's primary query path is "rows for this tenant".
CREATE INDEX IF NOT EXISTS idx_delivery_log_tenant
  ON delivery_log (user_id, created_at DESC);

-- Correlation lookup — single-event drilldown.
CREATE INDEX IF NOT EXISTS idx_delivery_log_correlation
  ON delivery_log (correlation_id)
  WHERE correlation_id IS NOT NULL;

-- Failure filter — operator dashboard "show me what failed in last hour".
CREATE INDEX IF NOT EXISTS idx_delivery_log_failure
  ON delivery_log (status, created_at DESC)
  WHERE status IN ('failed','rejected','rate_limited','timeout');

-- Edge filter — "all outbound to leadbridge".
CREATE INDEX IF NOT EXISTS idx_delivery_log_edge
  ON delivery_log (source_system, destination_system, created_at DESC);

-- Direction + channel filter — "all inbound email" / "all outbound webhooks".
CREATE INDEX IF NOT EXISTS idx_delivery_log_direction_channel
  ON delivery_log (delivery_direction, channel, created_at DESC);

COMMENT ON TABLE delivery_log IS
  'Synchronization Constitution §0 P2 + §9 P1.6 — unified delivery audit. '
  'Every notable cross-system delivery (outbound or inbound) writes one row '
  'here. Coexists with domain-specific tables (notification_email_logs, '
  'leadbridge_outbound_events, zb_sync_dirty, ledger_drift_detected) which '
  'stay canonical for their own queries. lib/delivery-log.js is the only '
  'writer; emit a [DeliveryLog] structured Loki line on every write.';
