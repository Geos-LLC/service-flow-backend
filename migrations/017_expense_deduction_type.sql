-- ═══════════════════════════════════════════════════════════════
-- Migration 017: Expense Deduction Type + Ledger Deduction Support
-- ═══════════════════════════════════════════════════════════════
-- Adds 'deduction' as a paid_by option for charging cleaners
-- (e.g. breakage, damage) which creates negative ledger entries.
--
-- Also adds 'expense_deduction' to cleaner_ledger type CHECK
-- so deductions from expenses are tracked separately from manual adjustments.

-- 1. Extend paid_by CHECK to include 'deduction'
ALTER TABLE job_expenses DROP CONSTRAINT IF EXISTS job_expenses_paid_by_check;
ALTER TABLE job_expenses ADD CONSTRAINT job_expenses_paid_by_check
  CHECK (paid_by IN ('company','team_member','customer','deduction'));

-- 2. Extend cleaner_ledger type CHECK to allow 'expense_deduction'
ALTER TABLE cleaner_ledger DROP CONSTRAINT IF EXISTS cleaner_ledger_type_check;
ALTER TABLE cleaner_ledger ADD CONSTRAINT cleaner_ledger_type_check
  CHECK (type IN ('earning','tip','incentive','cash_collected','adjustment','payout','reimbursement','expense_deduction'));

-- 3. Idempotency index for expense_deduction ledger rows (mirrors the reimbursement one from 013)
CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_expense_deduction_source
  ON cleaner_ledger ((metadata->>'source_id'))
  WHERE type = 'expense_deduction' AND metadata->>'source_type' = 'job_expense';
