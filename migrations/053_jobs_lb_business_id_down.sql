-- Rollback for 053. Drop the index first, then the column.

DROP INDEX IF EXISTS public.idx_jobs_user_lb_business;

ALTER TABLE public.jobs
  DROP COLUMN IF EXISTS lb_business_id;
