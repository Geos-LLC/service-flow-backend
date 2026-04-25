-- Prevent race-condition duplicates in cleaner_ledger.
--
-- Background: when a job's status flipped to 'completed' two webhook handlers
-- (e.g. job.completed + job.service_order.edited) could race through the
-- existence/raceCheck guards in createLedgerEntriesForCompletedJob and both
-- insert a full set of (earning, tip, incentive, cash_collected) rows for the
-- same (job_id, team_member_id) pair within ~12ms. Result: cleaner's payroll
-- showed 2x earning for that job. Detected on job 139704 (Tatiana Larionova,
-- Apr 20 2026) where Hourly summed to $400 instead of $325.
--
-- This unique partial index makes the second concurrent insert fail with a
-- 23505 unique_violation, which the calling code logs as a benign error.
-- Manager salary/commission entries (job_id IS NULL) are excluded — those
-- are daily, not per-job, and may legitimately have many rows per member.

CREATE UNIQUE INDEX IF NOT EXISTS idx_cleaner_ledger_job_member_type
  ON cleaner_ledger (job_id, team_member_id, type)
  WHERE job_id IS NOT NULL
    AND type IN ('earning', 'tip', 'incentive', 'cash_collected');
