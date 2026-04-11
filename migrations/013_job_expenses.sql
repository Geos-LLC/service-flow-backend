-- ═══════════════════════════════════════════════════════════════
-- Migration 013: Job Expenses / Reimbursements
-- ═══════════════════════════════════════════════════════════════
-- Adds support for cleaner out-of-pocket expenses (parking, tolls, supplies)
-- that flow through payroll as reimbursements — SEPARATE from earnings,
-- tips, adjustments, and discounts.
--
-- Architecture:
--   job_expenses       → source of truth for expense records
--   cleaner_ledger     → gets 'reimbursement' type entries via approval flow
--   Idempotency        → unique index on metadata->>'source_id' when
--                        type='reimbursement' prevents duplicate ledger rows

-- 1. Extend cleaner_ledger type CHECK to allow 'reimbursement'
ALTER TABLE cleaner_ledger DROP CONSTRAINT IF EXISTS cleaner_ledger_type_check;
ALTER TABLE cleaner_ledger ADD CONSTRAINT cleaner_ledger_type_check
  CHECK (type IN ('earning','tip','incentive','cash_collected','adjustment','payout','reimbursement'));

-- 2. job_expenses table
CREATE TABLE IF NOT EXISTS job_expenses (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  team_member_id INTEGER REFERENCES team_members(id),
  expense_type VARCHAR(32) NOT NULL CHECK (expense_type IN ('parking','toll','supplies','other')),
  description TEXT,
  amount NUMERIC(10,2) NOT NULL CHECK (amount >= 0),
  paid_by VARCHAR(16) NOT NULL DEFAULT 'team_member' CHECK (paid_by IN ('company','team_member','customer')),
  customer_billable BOOLEAN NOT NULL DEFAULT false,
  reimbursable_to_team_member BOOLEAN NOT NULL DEFAULT true,
  status VARCHAR(16) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  note TEXT,
  approved_at TIMESTAMPTZ,
  approved_by INTEGER REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  created_by INTEGER REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_job_expenses_job ON job_expenses(job_id);
CREATE INDEX IF NOT EXISTS idx_job_expenses_member ON job_expenses(user_id, team_member_id, status);
CREATE INDEX IF NOT EXISTS idx_job_expenses_status ON job_expenses(user_id, status);

-- 3. Idempotency: one reimbursement ledger row per approved job_expense
-- Uses metadata->>'source_id' pattern (same approach as paystub dedup)
CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_reimbursement_source
  ON cleaner_ledger ((metadata->>'source_id'))
  WHERE type = 'reimbursement' AND metadata->>'source_type' = 'job_expense';
