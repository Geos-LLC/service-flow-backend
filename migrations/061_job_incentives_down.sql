-- Rollback for 061_job_incentives.sql
--
-- Drops the job_incentives table. jobs.incentive_amount and
-- job_team_assignments.incentive_amount stay populated because they
-- were never moved into the new table — they were always the
-- denormalized caches.

DROP TABLE IF EXISTS public.job_incentives;

NOTIFY pgrst, 'reload schema';
