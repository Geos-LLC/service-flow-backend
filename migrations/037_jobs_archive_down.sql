-- ═══════════════════════════════════════════════════════════════
-- Migration 037 DOWN: Jobs Archive — rollback
-- ═══════════════════════════════════════════════════════════════
-- Reverses 037_jobs_archive.sql. Drops the four columns and both
-- partial indexes added by the up-migration.
--
-- WHEN TO RUN:
--   - Phase 2 deploy soak surfaces a problem and we need to revert
--     before any rows have been archived.
--   - Schema additions cause an unforeseen interaction.
--
-- WHEN NOT TO RUN:
--   - After any row has been archived (data loss). If archive flags
--     have been set on real rows, recover the rows first via the
--     restore endpoints/queries (see design doc §6) before dropping
--     the columns.
--   - Routine deploys. The up-migration is additive and safe by
--     default — there is no reason to drop these columns under
--     normal operation.
--
-- This down-migration is destructive of the archive metadata only —
-- it does NOT touch row data outside the four added columns. Job
-- rows themselves remain intact.
-- ═══════════════════════════════════════════════════════════════


-- ────────────────────────────────────────────────────────────────
-- 1. Safety check — refuse to run if any row carries archive state
--
-- DO block raises NOTICE (not exception) so the operator sees a
-- warning during dry-run via psql `\set ON_ERROR_STOP off`. Flip
-- to RAISE EXCEPTION before running for real if you want hard-fail
-- semantics.
-- ────────────────────────────────────────────────────────────────

DO $$
DECLARE
  archived_count integer;
BEGIN
  SELECT count(*) INTO archived_count
    FROM public.jobs
   WHERE hidden_from_ui = true OR archived_at IS NOT NULL;
  IF archived_count > 0 THEN
    RAISE NOTICE
      '037_DOWN warning: % jobs currently carry archive state. '
      'Rolling back will lose archived_at / archived_reason / '
      'archived_by_process for these rows. Recover them first via '
      'the restore queries in docs/zb-cleanup/phase-3-endpoint-filter-design.md §6 '
      'before proceeding.',
      archived_count;
  END IF;
END $$;


-- ────────────────────────────────────────────────────────────────
-- 2. Drop indexes first (no-op if already absent)
-- ────────────────────────────────────────────────────────────────

DROP INDEX IF EXISTS public.idx_jobs_visible;
DROP INDEX IF EXISTS public.idx_jobs_archived;


-- ────────────────────────────────────────────────────────────────
-- 3. Drop columns
--
-- Reverse order from the up-migration. ALTER TABLE ... DROP COLUMN
-- IF EXISTS is safely re-runnable.
-- ────────────────────────────────────────────────────────────────

ALTER TABLE public.jobs
  DROP COLUMN IF EXISTS hidden_from_ui;

ALTER TABLE public.jobs
  DROP COLUMN IF EXISTS archived_by_process;

ALTER TABLE public.jobs
  DROP COLUMN IF EXISTS archived_reason;

ALTER TABLE public.jobs
  DROP COLUMN IF EXISTS archived_at;


-- ────────────────────────────────────────────────────────────────
-- 4. PostgREST schema cache
-- ────────────────────────────────────────────────────────────────

NOTIFY pgrst, 'reload schema';
