-- Rollback for 059_orchestration_credential_refresh_marker.sql.
DROP INDEX IF EXISTS public.idx_lb_orch_cred_needs_refresh;
ALTER TABLE public.lb_orchestration_credentials DROP COLUMN IF EXISTS needs_refresh_at;
