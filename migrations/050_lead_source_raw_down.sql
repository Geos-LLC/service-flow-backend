-- Rollback for migration 050_lead_source_raw.sql.
-- Drops the source_raw column and its index. Existing leads.source values are
-- not modified. The application's pickLBSources / OP raw-write path will
-- silently no-op on the missing column after this rollback (defensive insert
-- is conditional in code via spread; verify the application is rolled back
-- *before* dropping the column to avoid INSERT errors).

DROP INDEX IF EXISTS public.idx_leads_user_source_raw;

ALTER TABLE public.leads
  DROP COLUMN IF EXISTS source_raw;
