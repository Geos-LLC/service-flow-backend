-- Per-job cleaner salary override.
--
-- Default salary is computed as hours_worked × team_members.hourly_rate
-- in createLedgerEntriesForCompletedJob. When a CSV import (or manual
-- edit) carries a custom dollar amount that doesn't follow that
-- formula, write it here. If non-null, the ledger writer uses this
-- amount split equally across assigned team members instead of the
-- hours × rate calc. NULL = use the default formula.

ALTER TABLE jobs ADD COLUMN IF NOT EXISTS cleaner_salary_override numeric;

NOTIFY pgrst, 'reload schema';
