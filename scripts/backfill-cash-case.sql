WITH job_cash AS (
  SELECT t.job_id, j.user_id, j.scheduled_date::date AS effective_date, SUM(t.amount) AS total_cash
  FROM transactions t
  JOIN jobs j ON j.id = t.job_id
  WHERE t.job_id IN (139746, 139694, 141891)
    AND t.payment_method = 'cash'
    AND t.status = 'completed'
  GROUP BY t.job_id, j.user_id, j.scheduled_date
),
members AS (
  SELECT jc.job_id, jc.user_id, jc.effective_date, jc.total_cash, jta.team_member_id,
         COUNT(*) OVER (PARTITION BY jc.job_id) AS member_count
  FROM job_cash jc
  JOIN job_team_assignments jta ON jta.job_id = jc.job_id
  UNION ALL
  SELECT jc.job_id, jc.user_id, jc.effective_date, jc.total_cash, j.team_member_id, 1 AS member_count
  FROM job_cash jc
  JOIN jobs j ON j.id = jc.job_id
  WHERE NOT EXISTS (SELECT 1 FROM job_team_assignments jta WHERE jta.job_id = jc.job_id)
    AND j.team_member_id IS NOT NULL
)
INSERT INTO cleaner_ledger (user_id, team_member_id, job_id, type, amount, effective_date, note, metadata, created_by)
SELECT m.user_id, m.team_member_id, m.job_id, 'cash_collected',
       -ROUND(m.total_cash::numeric / m.member_count, 2),
       m.effective_date,
       'Cash collected for job #' || m.job_id,
       jsonb_build_object('backfilled', true, 'fix', 'cash_case_normalize'),
       m.user_id
FROM members m
WHERE NOT EXISTS (
  SELECT 1 FROM cleaner_ledger cl
  WHERE cl.job_id = m.job_id AND cl.team_member_id = m.team_member_id AND cl.type = 'cash_collected'
)
RETURNING id, job_id, team_member_id, amount, effective_date;
