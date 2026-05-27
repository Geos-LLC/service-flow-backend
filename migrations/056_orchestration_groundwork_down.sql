-- Rollback for 056_orchestration_groundwork.sql.

DROP INDEX IF EXISTS public.idx_lb_orch_session;
DROP INDEX IF EXISTS public.idx_lb_orch_tenant_endpoint;
DROP INDEX IF EXISTS public.idx_lb_orch_idempotency;
DROP TABLE IF EXISTS public.lb_orchestration_attempts;

ALTER TABLE public.leadbridge_outbound_events
  DROP COLUMN IF EXISTS orchestration_session_id;

ALTER TABLE public.jobs
  DROP COLUMN IF EXISTS orchestration_session_id;
