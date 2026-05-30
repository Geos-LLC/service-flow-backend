-- Rollback for 060_lb_historical_lead_link.sql.
-- Drops added columns + audit table. Data loss is intentional: the
-- audit log and lb_lead_id values are operationally significant; the
-- caller of this down-migration MUST snapshot lb_link_audit before
-- running this.

DROP INDEX IF EXISTS public.idx_lb_link_audit_lb_lead;
DROP INDEX IF EXISTS public.idx_lb_link_audit_sf_job;
DROP INDEX IF EXISTS public.idx_lb_link_audit_user_applied;
DROP TABLE IF EXISTS public.lb_link_audit;

DROP INDEX IF EXISTS public.idx_customers_lb_lead_id;
DROP INDEX IF EXISTS public.idx_jobs_lb_lead_id;

ALTER TABLE public.customers DROP COLUMN IF EXISTS lb_lead_id;
ALTER TABLE public.jobs      DROP COLUMN IF EXISTS lb_lead_id;
