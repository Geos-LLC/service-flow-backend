-- Multi-line incentives per job with optional descriptions.
--
-- Until now an "incentive" was a single number on jobs.incentive_amount
-- (job total) with per-member breakdowns stored on
-- job_team_assignments.incentive_amount. There was no place to record
-- WHY a cleaner received an incentive — only the total.
--
-- This migration introduces job_incentives, a true one-to-many child of
-- jobs. Each row is a single per-member incentive line with an optional
-- description (e.g. "Customer praise", "Same-day pickup bonus").
--
-- Source of truth model:
--   - job_incentives is the authoritative breakdown
--   - jobs.incentive_amount and job_team_assignments.incentive_amount
--     remain as denormalized caches updated by the backend whenever
--     job_incentives rows change. The ledger sync code already reads
--     those columns, so this preserves payroll behavior without
--     surgery on the ledger pipeline.
--
-- Backfill:
--   - For every job_team_assignment with incentive_amount > 0, we
--     insert one job_incentives row (no description). Legacy jobs that
--     only had jobs.incentive_amount set without per-member
--     assignments fall back to the existing equal-split behavior;
--     they won't appear in job_incentives until a user edits them
--     through the new UI.

CREATE TABLE IF NOT EXISTS public.job_incentives (
  id              BIGSERIAL    PRIMARY KEY,
  user_id         BIGINT       NOT NULL,
  job_id          BIGINT       NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
  team_member_id  BIGINT       NOT NULL,
  description     TEXT,
  amount          NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (amount >= 0),
  created_by      BIGINT,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_job_incentives_job
  ON public.job_incentives (job_id);

CREATE INDEX IF NOT EXISTS idx_job_incentives_member
  ON public.job_incentives (team_member_id);

CREATE INDEX IF NOT EXISTS idx_job_incentives_user
  ON public.job_incentives (user_id);

COMMENT ON TABLE public.job_incentives IS
  'One row per per-cleaner incentive line on a job. Multiple lines per (job, cleaner) allowed so a cleaner can earn separate bonuses on the same job with their own descriptions. Sum is mirrored into jobs.incentive_amount and job_team_assignments.incentive_amount.';

COMMENT ON COLUMN public.job_incentives.description IS
  'Optional free-text reason for the incentive (shown on payroll). NULL when the user just entered an amount.';

-- Backfill from existing per-member breakdowns. Only assignments with a
-- positive amount become a row; zero/null amounts mean "no incentive"
-- and stay absent.
INSERT INTO public.job_incentives (user_id, job_id, team_member_id, description, amount, created_at, updated_at)
SELECT
  j.user_id,
  jta.job_id,
  jta.team_member_id,
  NULL::text AS description,
  jta.incentive_amount,
  COALESCE(jta.assigned_at, now()),
  now()
FROM public.job_team_assignments jta
JOIN public.jobs j ON j.id = jta.job_id
WHERE COALESCE(jta.incentive_amount, 0) > 0
  AND NOT EXISTS (
    SELECT 1 FROM public.job_incentives ji
    WHERE ji.job_id = jta.job_id AND ji.team_member_id = jta.team_member_id
  );

-- Schema cache reload so PostgREST picks up the new table immediately.
NOTIFY pgrst, 'reload schema';
