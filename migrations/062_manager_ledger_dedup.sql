-- Prevent duplicate manager salary / commission ledger rows.
--
-- `ensureManagerEntriesForPeriod` runs at payroll query time. Two
-- near-simultaneous payroll loads (e.g. the same browser opened in
-- two tabs) can both observe "no row for this date" and both insert
-- a daily salary / commission row, producing duplicates that inflate
-- the manager's commission base and pay total.
--
-- This migration:
--   1. Cleans up any existing duplicates by keeping the lowest id row.
--   2. Adds partial-unique indexes that scope the constraint to
--      unbatched (`payout_batch_id IS NULL`) auto-generated manager rows.
--      Settled rows are exempt — they're immutable history (Constitution
--      §3.1) and we never want to reject inserts of a NEW unbatched row
--      just because an old settled row exists on the same date.

-- 1. Dedup commission rows: keep MIN(id) per (team_member_id, effective_date)
DELETE FROM public.cleaner_ledger c
USING (
  SELECT MIN(id) AS keep_id, team_member_id, effective_date
  FROM public.cleaner_ledger
  WHERE job_id IS NULL
    AND type = 'earning'
    AND (metadata->>'is_manager_commission')::boolean = true
    AND payout_batch_id IS NULL
  GROUP BY team_member_id, effective_date
  HAVING COUNT(*) > 1
) keep
WHERE c.team_member_id = keep.team_member_id
  AND c.effective_date = keep.effective_date
  AND c.job_id IS NULL
  AND c.type = 'earning'
  AND (c.metadata->>'is_manager_commission')::boolean = true
  AND c.payout_batch_id IS NULL
  AND c.id <> keep.keep_id;

-- Dedup salary rows the same way.
DELETE FROM public.cleaner_ledger c
USING (
  SELECT MIN(id) AS keep_id, team_member_id, effective_date
  FROM public.cleaner_ledger
  WHERE job_id IS NULL
    AND type = 'earning'
    AND (metadata->>'is_manager_salary')::boolean = true
    AND payout_batch_id IS NULL
  GROUP BY team_member_id, effective_date
  HAVING COUNT(*) > 1
) keep
WHERE c.team_member_id = keep.team_member_id
  AND c.effective_date = keep.effective_date
  AND c.job_id IS NULL
  AND c.type = 'earning'
  AND (c.metadata->>'is_manager_salary')::boolean = true
  AND c.payout_batch_id IS NULL
  AND c.id <> keep.keep_id;

-- 2. Partial-unique indexes. Scoped to unbatched auto-generated manager rows.
CREATE UNIQUE INDEX IF NOT EXISTS idx_cleaner_ledger_unique_mgr_commission_unbatched
  ON public.cleaner_ledger (team_member_id, effective_date)
  WHERE job_id IS NULL
    AND type = 'earning'
    AND (metadata->>'is_manager_commission')::boolean = true
    AND payout_batch_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_cleaner_ledger_unique_mgr_salary_unbatched
  ON public.cleaner_ledger (team_member_id, effective_date)
  WHERE job_id IS NULL
    AND type = 'earning'
    AND (metadata->>'is_manager_salary')::boolean = true
    AND payout_batch_id IS NULL;

COMMENT ON INDEX public.idx_cleaner_ledger_unique_mgr_commission_unbatched IS
  'Prevents ensureManagerEntriesForPeriod from inserting duplicate daily commission rows when two payroll requests race.';

COMMENT ON INDEX public.idx_cleaner_ledger_unique_mgr_salary_unbatched IS
  'Prevents ensureManagerEntriesForPeriod from inserting duplicate daily scheduled-salary rows when two payroll requests race.';
