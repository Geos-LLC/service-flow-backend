-- Phase 2B orchestration groundwork.
--
-- Additive schema only. Backward compatible. No data migration required.
--
-- 1. `orchestration_session_id` on jobs + leadbridge_outbound_events
--    Threading column for conversational booking sessions. Set by the
--    LB orchestration endpoints; flows through to outbound events for
--    correlation. NULL on legacy jobs/events — never required.
--
-- 2. `lb_orchestration_attempts` table
--    Idempotency, audit, and observability for the orchestration API
--    surface. Every attempt (success, idempotent replay, conflict,
--    invalid, stale_slot, rejected) lands here so the semantic-summary
--    endpoint can compute orchestration health counters without
--    inferring from outbound queue state.
--
-- Rollback: 056_orchestration_groundwork_down.sql.

ALTER TABLE public.jobs
  ADD COLUMN IF NOT EXISTS orchestration_session_id TEXT;

ALTER TABLE public.leadbridge_outbound_events
  ADD COLUMN IF NOT EXISTS orchestration_session_id TEXT;

CREATE TABLE IF NOT EXISTS public.lb_orchestration_attempts (
  id                       BIGSERIAL PRIMARY KEY,
  user_id                  INTEGER NOT NULL,
  endpoint                 TEXT    NOT NULL,
  idempotency_key          TEXT,
  orchestration_session_id TEXT,
  request_payload          JSONB,
  response_status          INTEGER,
  response_payload         JSONB,
  sf_job_id                INTEGER,
  result                   TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE  public.lb_orchestration_attempts IS
  'Phase 2B audit + idempotency log for LB orchestration API calls. Read-only for everyone except the orchestration handlers.';
COMMENT ON COLUMN public.lb_orchestration_attempts.endpoint IS
  'One of: availability | booking_request | booking_cancel | handoff';
COMMENT ON COLUMN public.lb_orchestration_attempts.result IS
  'success | idempotent_replay | conflict | invalid | stale_slot | rejected | error';
COMMENT ON COLUMN public.lb_orchestration_attempts.sf_job_id IS
  'When result=success on booking_request, the newly-created jobs.id.';

-- Idempotency uniqueness: (tenant, endpoint, idempotency_key). NULL keys
-- are not deduplicated (each non-idempotent call lands as its own row).
CREATE UNIQUE INDEX IF NOT EXISTS idx_lb_orch_idempotency
  ON public.lb_orchestration_attempts (user_id, endpoint, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- Observability index — bound by tenant + endpoint + recent activity.
CREATE INDEX IF NOT EXISTS idx_lb_orch_tenant_endpoint
  ON public.lb_orchestration_attempts (user_id, endpoint, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_lb_orch_session
  ON public.lb_orchestration_attempts (orchestration_session_id)
  WHERE orchestration_session_id IS NOT NULL;
