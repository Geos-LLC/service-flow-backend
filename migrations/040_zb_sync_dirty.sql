-- 040_zb_sync_dirty.sql
-- P1.2 (Synchronization Constitution §0 P2 + §6.2 + §6.6) — replace silent
-- catches in ZB sync paths with a queryable dirty marker.
--
-- A "dirty" row signals: a downstream operation failed after the canonical
-- job upsert/event succeeded. The system continued (the failure was non-
-- fatal to the immediate handler) but is in a known partial-commit state.
-- Operators query this table to surface drift; reconcile or retry paths
-- resolve rows on success.
--
-- The partial unique index on (user_id, sf_job_id, zenbooker_id, operation)
-- WHERE resolved_at IS NULL gives idempotency: the same failure recurring
-- on the same target increments attempts + updates last_seen_at instead of
-- inserting a duplicate row.

CREATE TABLE IF NOT EXISTS zb_sync_dirty (
  id                BIGSERIAL PRIMARY KEY,

  -- Tenant scope (always present).
  user_id           BIGINT NOT NULL,

  -- Target identifier (at least one MUST be present; both may be).
  sf_job_id         BIGINT NULL,
  zenbooker_id      TEXT   NULL,

  -- Operation taxonomy — keep narrow. See lib/zb-dirty-marker.js.
  --   transaction_payment_method | payment_status_update | customer_link
  --   zb_job_fetch | zb_tx_fetch | ledger_rebuild
  operation         TEXT NOT NULL,

  error_class       TEXT NULL,
  error_message     TEXT NOT NULL,
  retryable         BOOLEAN NULL,        -- best-effort; null = unknown

  attempts          INTEGER NOT NULL DEFAULT 1,
  first_seen_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  resolved_at       TIMESTAMPTZ NULL,
  resolved_by       TEXT NULL,           -- 'auto:retry_success' | 'operator:<user>' | etc.
  resolution_note   TEXT NULL,

  context           JSONB NULL
);

-- Idempotency: one unresolved row per (tenant, target, operation). The
-- COALESCE on text NULLs is necessary because (NULL, X) != (NULL, X) in
-- a regular unique index.
CREATE UNIQUE INDEX IF NOT EXISTS uq_zb_sync_dirty_open
  ON zb_sync_dirty (
    user_id,
    COALESCE(sf_job_id::text, ''),
    COALESCE(zenbooker_id, ''),
    operation
  )
  WHERE resolved_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_zb_sync_dirty_unresolved
  ON zb_sync_dirty (user_id, last_seen_at DESC)
  WHERE resolved_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_zb_sync_dirty_operation
  ON zb_sync_dirty (operation, resolved_at);

COMMENT ON TABLE zb_sync_dirty IS
  'Synchronization Constitution §0 P2 — ZB sync paths mark rows here when a '
  'downstream operation fails after the canonical upsert succeeded. Operators '
  'list unresolved rows to surface drift. Retry paths call resolveDirty() on '
  'success. The partial unique index makes recurring failures idempotent.';
