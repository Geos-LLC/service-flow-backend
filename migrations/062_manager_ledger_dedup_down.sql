-- Rollback for 062_manager_ledger_dedup.sql. Drops the unique
-- indexes. Does not restore deleted duplicate rows (irrecoverable
-- and they were spurious anyway).

DROP INDEX IF EXISTS public.idx_cleaner_ledger_unique_mgr_commission_unbatched;
DROP INDEX IF EXISTS public.idx_cleaner_ledger_unique_mgr_salary_unbatched;
