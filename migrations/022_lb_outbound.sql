-- ═══════════════════════════════════════════════════════════════
-- Migration 022: LeadBridge Outbound (SF → LB job-status delivery)
-- ═══════════════════════════════════════════════════════════════
-- Adds the second direction to the existing LeadBridge integration.
-- Contract spec: geos-leadbridge/plans/2026-04-17-job-sync-sf-lb.md
-- SF plan: service-flow/JOB_STATUS_SYNC_TO_LB.md
--
-- Reuses the existing `communication_settings` row — outbound is a
-- property of the same integration, not a separate entity. Adds an
-- internal outbox table for durable delivery + loop-prevention
-- markers on the `jobs` row.

-- 1a. Extend communication_settings with outbound subscription fields
ALTER TABLE communication_settings
  ADD COLUMN IF NOT EXISTS leadbridge_outbound_subscription_id TEXT,
  ADD COLUMN IF NOT EXISTS leadbridge_outbound_encrypted_secret TEXT,
  ADD COLUMN IF NOT EXISTS leadbridge_outbound_secret_key_version INT,
  ADD COLUMN IF NOT EXISTS leadbridge_outbound_webhook_url TEXT,
  ADD COLUMN IF NOT EXISTS leadbridge_outbound_events TEXT[],
  ADD COLUMN IF NOT EXISTS leadbridge_outbound_registered_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS leadbridge_outbound_last_event_at TIMESTAMPTZ;

-- 1b. Loop-prevention + LB linkage markers on jobs
ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS lb_external_request_id TEXT,
  ADD COLUMN IF NOT EXISTS lb_channel TEXT,
  ADD COLUMN IF NOT EXISTS last_status_source TEXT,
  ADD COLUMN IF NOT EXISTS last_status_changed_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS jobs_lb_external_request_id_idx ON jobs (lb_external_request_id);

-- 1c. Outbox table — durable delivery + DLQ in the same row
CREATE TABLE IF NOT EXISTS leadbridge_outbound_events (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id          TEXT NOT NULL UNIQUE,
  user_id           UUID NOT NULL,
  sf_job_id         TEXT NOT NULL,
  event_type        TEXT NOT NULL DEFAULT 'job.status_changed',

  payload_json      JSONB NOT NULL,

  state             TEXT NOT NULL,
  result            TEXT,
  defer_reason      TEXT,

  attempts          INT NOT NULL DEFAULT 0,
  next_attempt_at   TIMESTAMPTZ,
  last_error        TEXT,
  last_attempt_at   TIMESTAMPTZ,
  claimed_by        TEXT,
  claimed_until     TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  terminal_at       TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS lb_outbound_events_drain_idx
  ON leadbridge_outbound_events (state, next_attempt_at)
  WHERE state IN ('pending', 'sending');
CREATE INDEX IF NOT EXISTS lb_outbound_events_user_job_idx
  ON leadbridge_outbound_events (user_id, sf_job_id, created_at DESC);
CREATE INDEX IF NOT EXISTS lb_outbound_events_state_idx
  ON leadbridge_outbound_events (state);
CREATE INDEX IF NOT EXISTS lb_outbound_events_defer_reason_idx
  ON leadbridge_outbound_events (defer_reason)
  WHERE defer_reason IS NOT NULL;

-- Drop any prior (incorrect) subscriptions table from earlier revisions
DROP TABLE IF EXISTS leadbridge_outbound_subscriptions;

-- ═══════════════════════════════════════════════════════════════
-- RPC helpers for the drainer worker
-- Supabase client cannot issue FOR UPDATE SKIP LOCKED / advisory
-- locks directly, so we expose them as SECURITY DEFINER RPCs.
-- ═══════════════════════════════════════════════════════════════

-- Per-tick advisory lock wrapping one drainer cycle.
-- Fixed key 0x4C42_4F42 ("LBOB") — chosen to avoid collision with
-- other app-level locks. Returns true if we acquired the lock.
CREATE OR REPLACE FUNCTION lb_outbound_try_tick_lock()
RETURNS BOOLEAN
LANGUAGE sql
AS $$
  SELECT pg_try_advisory_lock(1279873602);
$$;

CREATE OR REPLACE FUNCTION lb_outbound_release_tick_lock()
RETURNS BOOLEAN
LANGUAGE sql
AS $$
  SELECT pg_advisory_unlock(1279873602);
$$;

-- Stale-lease sweep: pull rows back to 'pending' if a worker crashed
-- while holding them. Safe to call every tick.
CREATE OR REPLACE FUNCTION lb_outbound_sweep_stale_leases()
RETURNS INT
LANGUAGE plpgsql
AS $$
DECLARE
  swept INT;
BEGIN
  UPDATE leadbridge_outbound_events
     SET state          = 'pending',
         claimed_by     = NULL,
         claimed_until  = NULL
   WHERE state = 'sending'
     AND claimed_until < now();
  GET DIAGNOSTICS swept = ROW_COUNT;
  RETURN swept;
END
$$;

-- Claim up to `p_limit` due 'pending' rows atomically.
-- Uses FOR UPDATE SKIP LOCKED so two workers never see the same row,
-- flips each to 'sending' with a lease, returns the claimed rows.
CREATE OR REPLACE FUNCTION lb_outbound_claim_due(
  p_worker   TEXT,
  p_lease_s  INT DEFAULT 120,
  p_limit    INT DEFAULT 50
)
RETURNS TABLE (
  id             UUID,
  event_id       TEXT,
  user_id        UUID,
  sf_job_id      TEXT,
  event_type     TEXT,
  payload_json   JSONB,
  attempts       INT
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  WITH due AS (
    SELECT e.id
      FROM leadbridge_outbound_events e
     WHERE e.state = 'pending'
       AND (e.next_attempt_at IS NULL OR e.next_attempt_at <= now())
     ORDER BY e.next_attempt_at NULLS FIRST, e.created_at
     LIMIT p_limit
     FOR UPDATE SKIP LOCKED
  )
  UPDATE leadbridge_outbound_events e
     SET state          = 'sending',
         claimed_by     = p_worker,
         claimed_until  = now() + (p_lease_s || ' seconds')::interval,
         last_attempt_at = now()
   FROM due
   WHERE e.id = due.id
     AND e.state = 'pending'
   RETURNING e.id, e.event_id, e.user_id, e.sf_job_id, e.event_type, e.payload_json, e.attempts;
END
$$;

-- 2. Refresh PostgREST schema cache
NOTIFY pgrst, 'reload schema';
