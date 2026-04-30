-- Extend job_expenses.expense_type CHECK to cover the categories the
-- generic Data Import flow auto-classifies columns into.
--
-- Before: parking, toll, supplies, other, cancellation
-- After:  + tolls, travel, fuel, gas, equipment, tools, meals, food,
--         reimbursement
--
-- Without this, imports of CSV columns labeled "Travel", "Fuel",
-- "Supplies" etc. were being silently rejected by the CHECK constraint
-- and no job_expenses rows ever landed.

ALTER TABLE job_expenses DROP CONSTRAINT IF EXISTS job_expenses_expense_type_check;

ALTER TABLE job_expenses ADD CONSTRAINT job_expenses_expense_type_check
  CHECK (expense_type IN (
    'parking', 'toll', 'tolls',
    'supplies',
    'travel',
    'fuel', 'gas',
    'equipment', 'tools',
    'meals', 'food',
    'other', 'cancellation', 'reimbursement'
  ));
