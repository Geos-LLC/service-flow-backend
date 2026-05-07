-- ═══════════════════════════════════════════════════════════════
-- Migration 037: Jobs Archive — Phase 2 (additive only)
-- ═══════════════════════════════════════════════════════════════
-- Operational-quarantine columns for the ZB historical-cleanup project.
-- See:
--   docs/zb-cleanup/phase-3-endpoint-filter-design.md (read-side gate)
--   tests/zb-cleanup-e2e.test.js                    (classifier proofs)
--   lib/zb-cleanup/                                 (read-only classifier)
--
-- Adds:
--   1. archived_at         timestamptz  — quarantine timestamp (NULL = active)
--   2. archived_reason     text         — batch_id of the archive run
--   3. archived_by_process text         — subsystem that wrote the row
--                                          (initial value: 'zb-cleanup')
--   4. hidden_from_ui      boolean      — visibility flag (default false)
--   5. Two partial indexes (visible-list / soak-window-scan)
--
-- This migration is ADDITIVE and SAFE BY DEFAULT:
--   - all four columns nullable except hidden_from_ui (DEFAULT false)
--   - existing rows immediately have hidden_from_ui = false
--   - no existing query changes behavior (read-side gate ships in
--     Phase 3 endpoint changes — separate deploy)
--   - no triggers, no functions, no backfills, no data movement
--   - no destructive operations
--
-- Read-side enforcement (Phase 3) is gated behind explicit endpoint
-- filter additions, NOT a feature flag — see design doc.
--
-- Rollback: see 037_jobs_archive_down.sql in the same directory.
-- ═══════════════════════════════════════════════════════════════


-- ────────────────────────────────────────────────────────────────
-- 1. Quarantine columns on jobs
--
-- All four are ADD COLUMN IF NOT EXISTS so this migration is safely
-- re-runnable.
--
-- - archived_at: when the row was soft-archived. NULL means the row
--   is active. Operators query soak eligibility via this column.
-- - archived_reason: human-readable bucket key. Conventionally the
--   batch_id of the archive run (e.g. 'zbc_20260507T143022_a1b2c3').
--   Free text — no CHECK constraint — so future archive features can
--   use their own bucket conventions without a migration.
-- - archived_by_process: which subsystem set the flags. Free text;
--   conventional values:
--       'zb-cleanup'         — this project (March 2026 imports)
--       'manual'             — operator-initiated single-row archive
--       'cancellation_auto'  — future: auto-archive on long-cancelled jobs
--   Recovery tooling restricts itself by this value (see design doc §6).
-- - hidden_from_ui: cheap boolean for the partial visibility index.
--   Decoupled from archived_at so a future "spam-flag" feature can hide
--   without taking on archive semantics. NOT NULL so existing rows are
--   immediately visible (DEFAULT false), no backfill required.
-- ────────────────────────────────────────────────────────────────

ALTER TABLE public.jobs
  ADD COLUMN IF NOT EXISTS archived_at         timestamptz;

ALTER TABLE public.jobs
  ADD COLUMN IF NOT EXISTS archived_reason     text;

ALTER TABLE public.jobs
  ADD COLUMN IF NOT EXISTS archived_by_process text;

ALTER TABLE public.jobs
  ADD COLUMN IF NOT EXISTS hidden_from_ui      boolean NOT NULL DEFAULT false;


-- ────────────────────────────────────────────────────────────────
-- 2. Indexes
--
-- Both partial — most rows will never be archived, so a partial index
-- on the small archived subset is dramatically cheaper than a full one.
--
-- idx_jobs_visible: serves the default operator UI list. Phase 3
--   endpoint changes will add `.eq('hidden_from_ui', false)` to the
--   /api/jobs query path; this index makes that filter free.
--
-- idx_jobs_archived: serves the soak-window scan and recovery cron.
--   Phase 4 archive-execution and Phase 5 nightly recovery both walk
--   this set; ordering by archived_at lets them page efficiently.
-- ────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_jobs_visible
  ON public.jobs(user_id, scheduled_date DESC)
  WHERE hidden_from_ui = false;

CREATE INDEX IF NOT EXISTS idx_jobs_archived
  ON public.jobs(archived_at)
  WHERE hidden_from_ui = true;


-- ────────────────────────────────────────────────────────────────
-- 3. Comments — column documentation visible in psql / pgAdmin
-- ────────────────────────────────────────────────────────────────

COMMENT ON COLUMN public.jobs.archived_at IS
  'Set when the row enters operational quarantine. NULL = active. Phase 2 of the ZB historical-cleanup project. Cleared on recovery. Read-side enforcement ships separately in Phase 3.';

COMMENT ON COLUMN public.jobs.archived_reason IS
  'Free-text bucket label for the archive write. Conventionally the batch_id of the archive run (e.g. ''zbc_20260507T143022_a1b2c3''). No CHECK constraint — future archive features may use their own conventions.';

COMMENT ON COLUMN public.jobs.archived_by_process IS
  'Subsystem that wrote the archive flags. Conventional values: ''zb-cleanup'' (this project), ''manual'' (operator), ''cancellation_auto'' (reserved). Recovery tooling restricts to its own process value to avoid cross-feature accidental restores.';

COMMENT ON COLUMN public.jobs.hidden_from_ui IS
  'When true, default UI list endpoints exclude this row. Decoupled from archived_at so future non-archive hiding (e.g. spam) can reuse the visibility primitive. NOT NULL DEFAULT false — existing rows remain visible.';


-- ────────────────────────────────────────────────────────────────
-- 4. PostgREST schema cache
--
-- Supabase caches the schema in PostgREST; without this NOTIFY the
-- new columns won't be selectable through the REST surface until the
-- service restarts.
-- ────────────────────────────────────────────────────────────────

NOTIFY pgrst, 'reload schema';
