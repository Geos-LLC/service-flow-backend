-- ═══════════════════════════════════════════════════════════════
-- Migration 044: ZB Outbound — command queue (Phase A scaffolding)
-- ═══════════════════════════════════════════════════════════════
-- Phase A — scaffolding only. NO producers wired, drainer in frozen
-- short-circuit. See docs/architecture/zb-outbound-command-confirmation.md
-- for the design (v0.4). Mirrors migration 022 (LB outbound) structure.
--
-- Production constraints active at deploy:
--   - ZB_OUTBOUND_ENABLED=false → drainer worker not started
--   - ZB_OUTBOUND_GLOBAL_FREEZE=true → defensive: claim short-circuits
-- No outbound HTTP traffic is possible until both flags flip.

-- 1. Command queue
CREATE TABLE IF NOT EXISTS zb_outbound_commands (
  -- identity
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id                 TEXT NOT NULL UNIQUE,
  user_id                  BIGINT NOT NULL,

  -- target
  command_type             TEXT NOT NULL,
  sf_job_id                TEXT,
  sf_customer_id           TEXT,
  zenbooker_id             TEXT,

  -- payload + intent fingerprint
  payload_json             JSONB NOT NULL,
  source_revision          JSONB NOT NULL,
  intent_hash              TEXT NOT NULL,

  -- lifecycle state
  state                    TEXT NOT NULL DEFAULT 'pending',
  attempts                 INT  NOT NULL DEFAULT 0,
  next_attempt_at          TIMESTAMPTZ,
  claimed_by               TEXT,
  claimed_until            TIMESTAMPTZ,

  -- timestamps
  requested_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_attempt_at          TIMESTAMPTZ,
  sent_at                  TIMESTAMPTZ,
  confirmed_at             TIMESTAMPTZ,
  terminal_at              TIMESTAMPTZ,
  confirmation_deadline    TIMESTAMPTZ,

  -- audit
  requested_by_user_id     BIGINT,
  requested_by_actor       JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- diagnostics
  last_error               TEXT,
  conflict_metadata        JSONB,
  zb_response              JSONB,
  zb_event_id              TEXT,
  defer_reason             TEXT,

  -- supersession / coordination (design §6.8–§6.10)
  field_group              TEXT NOT NULL,
  superseded_by_command_id UUID,
  supersedes_command_id    UUID,
  invalidation_reason      TEXT,

  -- correlation + provenance (design §3.5, §3.7)
  correlation_confidence   TEXT,
  origin                   TEXT NOT NULL DEFAULT 'user'
);

CREATE INDEX IF NOT EXISTS idx_zb_outbound_due
  ON zb_outbound_commands (state, next_attempt_at)
  WHERE state IN ('pending', 'sending');

CREATE INDEX IF NOT EXISTS idx_zb_outbound_open_by_zb_id
  ON zb_outbound_commands (zenbooker_id, state)
  WHERE state IN ('sent', 'confirm_timeout', 'ambiguous_pending_review');

CREATE INDEX IF NOT EXISTS idx_zb_outbound_user
  ON zb_outbound_commands (user_id, state, requested_at DESC);

CREATE INDEX IF NOT EXISTS idx_zb_outbound_field_group_open
  ON zb_outbound_commands (user_id, sf_job_id, field_group, state)
  WHERE state IN ('pending', 'sending', 'sent');

CREATE INDEX IF NOT EXISTS idx_zb_outbound_dlq
  ON zb_outbound_commands (user_id, terminal_at DESC)
  WHERE state IN ('failed', 'conflict', 'invalidated_by_upstream_terminal_state');

-- ═══════════════════════════════════════════════════════════════
-- RPCs — mirror migration 022 lb_outbound_* shape
-- Advisory-lock key 0x5A42_4F42 ("ZBOB") — distinct from LBOB (0x4C42_4F42).
-- ═══════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION zb_outbound_try_tick_lock()
RETURNS BOOLEAN
LANGUAGE sql
AS $$
  SELECT pg_try_advisory_lock(1514494530);
$$;

CREATE OR REPLACE FUNCTION zb_outbound_release_tick_lock()
RETURNS BOOLEAN
LANGUAGE sql
AS $$
  SELECT pg_advisory_unlock(1514494530);
$$;

CREATE OR REPLACE FUNCTION zb_outbound_sweep_stale_leases()
RETURNS INT
LANGUAGE plpgsql
AS $$
DECLARE
  swept INT;
BEGIN
  UPDATE zb_outbound_commands
     SET state          = 'pending',
         claimed_by     = NULL,
         claimed_until  = NULL
   WHERE state = 'sending'
     AND claimed_until < now();
  GET DIAGNOSTICS swept = ROW_COUNT;
  RETURN swept;
END
$$;

CREATE OR REPLACE FUNCTION zb_outbound_claim_due(
  p_worker   TEXT,
  p_lease_s  INT DEFAULT 120,
  p_limit    INT DEFAULT 50
)
RETURNS TABLE (
  id              UUID,
  event_id        TEXT,
  user_id         BIGINT,
  command_type    TEXT,
  sf_job_id       TEXT,
  sf_customer_id  TEXT,
  zenbooker_id    TEXT,
  payload_json    JSONB,
  source_revision JSONB,
  intent_hash     TEXT,
  attempts        INT,
  field_group     TEXT,
  origin          TEXT
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  WITH due AS (
    SELECT c.id
      FROM zb_outbound_commands c
     WHERE c.state = 'pending'
       AND (c.next_attempt_at IS NULL OR c.next_attempt_at <= now())
     ORDER BY c.next_attempt_at NULLS FIRST, c.requested_at
     LIMIT p_limit
     FOR UPDATE SKIP LOCKED
  )
  UPDATE zb_outbound_commands c
     SET state           = 'sending',
         claimed_by      = p_worker,
         claimed_until   = now() + (p_lease_s || ' seconds')::interval,
         last_attempt_at = now()
   FROM due
   WHERE c.id = due.id
     AND c.state = 'pending'
   RETURNING
     c.id, c.event_id, c.user_id, c.command_type,
     c.sf_job_id, c.sf_customer_id, c.zenbooker_id,
     c.payload_json, c.source_revision, c.intent_hash,
     c.attempts, c.field_group, c.origin;
END
$$;

NOTIFY pgrst, 'reload schema';
