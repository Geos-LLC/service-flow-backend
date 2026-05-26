-- Add lb_business_id to jobs so the LB linkage triple
-- (lb_external_request_id, lb_channel, lb_business_id) is complete on the
-- jobs row. Mirror of leads.lb_business_id from migration 051.
--
-- Why:
--   Historical attribution recovery (Stage-1 backfill) and per-account
--   audits both want to filter jobs by LB business directly, without
--   joining through `leads` on `converted_customer_id`. Adding the
--   column on jobs keeps the linkage triple symmetric across leads/jobs
--   and matches the Stage-1 repair contract:
--     UPDATE jobs SET lb_external_request_id, lb_channel, lb_business_id
--
-- Additive + nullable. Existing rows: NULL until repaired by the
-- backfill script OR until /api/jobs (or the ZB sync) populates it on
-- new INSERTs after this migration ships.
--
-- Rollback: 053_jobs_lb_business_id_down.sql.

ALTER TABLE public.jobs
  ADD COLUMN IF NOT EXISTS lb_business_id TEXT;

COMMENT ON COLUMN public.jobs.lb_business_id IS
  'LB-side businessId (TT business id / Yelp business id). Stable per-business identifier; mirror of leads.lb_business_id. Populated by the LB linkage resolver at job create time and by the historical attribution backfill script. NULL for non-LB-sourced jobs.';

-- Partial index — backs per-business job audits (e.g. "show me all jobs
-- for the St Pete TT business").
CREATE INDEX IF NOT EXISTS idx_jobs_user_lb_business
  ON public.jobs(user_id, lb_business_id, lb_channel)
  WHERE lb_business_id IS NOT NULL;
