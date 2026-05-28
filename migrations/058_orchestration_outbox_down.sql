-- Rollback for 058_orchestration_outbox.sql.
DROP INDEX IF EXISTS public.idx_lb_orch_outbox_user;
DROP INDEX IF EXISTS public.idx_lb_orch_outbox_pending;
DROP INDEX IF EXISTS public.idx_lb_orch_outbox_event_id;
DROP TABLE IF EXISTS public.lb_orchestration_outbox;
