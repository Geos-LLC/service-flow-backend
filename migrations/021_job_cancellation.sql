-- ═══════════════════════════════════════════════════════════════
-- Migration 021: Job Cancellation Financial Handling
-- ═══════════════════════════════════════════════════════════════
-- Supports optional cancellation fee (client-side receivable) and
-- optional cleaner reimbursement when cancelling a job. Fee is
-- tracked on the job row; reimbursement reuses job_expenses with
-- a new 'cancellation' expense_type so it flows through the
-- existing approval + ledger idempotency + batching-lock logic.
--
-- Rules enforced elsewhere:
--   - service_price / additional_fees are NOT mutated on cancel
--   - cancellation fee is NOT added to standard service revenue
--   - reimbursement entries survive status transitions; only
--     earning/tip/incentive/cash_collected are deleted on cancel

-- 1. Cancellation fields on jobs
ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS cancellation_reason VARCHAR(64),
  ADD COLUMN IF NOT EXISTS cancellation_notes TEXT,
  ADD COLUMN IF NOT EXISTS cancellation_fee NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS cancellation_fee_status VARCHAR(16),
  ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cancelled_by INTEGER REFERENCES users(id);

-- Enforce fee_status domain where present (NULL allowed for no-fee cancellations)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'jobs_cancellation_fee_status_check'
  ) THEN
    ALTER TABLE jobs ADD CONSTRAINT jobs_cancellation_fee_status_check
      CHECK (cancellation_fee_status IS NULL OR cancellation_fee_status IN ('pending','paid','void'));
  END IF;
END$$;

-- Enforce fee amount is non-negative when set
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'jobs_cancellation_fee_nonneg_check'
  ) THEN
    ALTER TABLE jobs ADD CONSTRAINT jobs_cancellation_fee_nonneg_check
      CHECK (cancellation_fee IS NULL OR cancellation_fee >= 0);
  END IF;
END$$;

CREATE INDEX IF NOT EXISTS idx_jobs_cancelled_at ON jobs(cancelled_at) WHERE cancelled_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_jobs_cancellation_fee_open
  ON jobs(user_id, cancellation_fee_status)
  WHERE cancellation_fee IS NOT NULL AND cancellation_fee_status = 'pending';

-- 2. Extend job_expenses.expense_type to allow 'cancellation'
ALTER TABLE job_expenses DROP CONSTRAINT IF EXISTS job_expenses_expense_type_check;
ALTER TABLE job_expenses ADD CONSTRAINT job_expenses_expense_type_check
  CHECK (expense_type IN ('parking','toll','supplies','other','cancellation'));

-- 3. Refresh PostgREST schema cache
NOTIFY pgrst, 'reload schema';
