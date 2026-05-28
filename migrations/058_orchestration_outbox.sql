-- S4 — Orchestration webhook outbox.
--
-- Dedicated outbox for SF → LB orchestration lifecycle events:
--   connection.connected, credential.rotated, connection.revoked
--
-- Distinct from `leadbridge_outbound_events` because:
--   - This outbox stores events signed with the per-tenant orchestration
--     webhook secret (communication_settings.lb_orchestration_webhook_secret_enc),
--     not the LB outbound-subscription secret.
--   - The drainer for this outbox is `lb-orchestration-webhook-drainer.js`,
--     separate from the existing leadbridge-outbound-drainer to avoid
--     mixing signing schemes.
--   - Captures webhook URL + encrypted secret on the row at enqueue
--     time so the drainer can deliver even after the tenant disconnects
--     (specifically: the connection.revoked event must deliver using
--     the snapshot of webhook config taken BEFORE the disconnect clears
--     it).
--
-- Additive schema only. No existing data to migrate.

CREATE TABLE IF NOT EXISTS public.lb_orchestration_outbox (
  id                   BIGSERIAL    PRIMARY KEY,
  user_id              INTEGER      NOT NULL,
  event_id             TEXT         NOT NULL,
  event_type           TEXT         NOT NULL,
  payload_json         JSONB        NOT NULL,
  webhook_url          TEXT         NOT NULL,
  webhook_secret_enc   TEXT         NOT NULL,
  subscription_id      TEXT,
  state_ref            TEXT,
  state                TEXT         NOT NULL DEFAULT 'pending'
                        CHECK (state IN ('pending','sent','failed','dlq','cancelled')),
  attempts             INTEGER      NOT NULL DEFAULT 0,
  next_attempt_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  last_error           TEXT,
  last_status_code     INTEGER,
  created_at           TIMESTAMPTZ  NOT NULL DEFAULT now(),
  sent_at              TIMESTAMPTZ,
  failed_at            TIMESTAMPTZ
);

COMMENT ON TABLE  public.lb_orchestration_outbox IS
  'SF → LB orchestration lifecycle event outbox (connection.connected, credential.rotated, connection.revoked). Signed with per-tenant webhook secret.';
COMMENT ON COLUMN public.lb_orchestration_outbox.event_id IS
  'Deterministic event_id per (event_type, primary_entity_id). UNIQUE — duplicates absorbed by the index.';
COMMENT ON COLUMN public.lb_orchestration_outbox.webhook_url IS
  'Snapshot of the tenant''s webhook URL at enqueue time. Lets the connection.revoked event deliver even after communication_settings clears the URL.';
COMMENT ON COLUMN public.lb_orchestration_outbox.webhook_secret_enc IS
  'AES-256-GCM ciphertext of the tenant''s webhook secret, snapshot at enqueue time.';
COMMENT ON COLUMN public.lb_orchestration_outbox.state IS
  'pending: due for delivery. sent: 2xx received. failed: under retry. dlq: max attempts exceeded. cancelled: tenant disconnected before delivery (only for non-revoked events).';

-- Deterministic event_id: re-emits collide and are absorbed as duplicates.
CREATE UNIQUE INDEX IF NOT EXISTS idx_lb_orch_outbox_event_id
  ON public.lb_orchestration_outbox (event_id);

-- Drainer claim index.
CREATE INDEX IF NOT EXISTS idx_lb_orch_outbox_pending
  ON public.lb_orchestration_outbox (next_attempt_at)
  WHERE state = 'pending';

-- Observability + per-tenant lookup.
CREATE INDEX IF NOT EXISTS idx_lb_orch_outbox_user
  ON public.lb_orchestration_outbox (user_id, created_at DESC);
