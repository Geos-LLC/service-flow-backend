-- 039_ledger_drift_audit.sql
-- P0.1 (Synchronization Constitution §3.1, §3.4) — audit table for batched-row
-- divergence detection.
--
-- When a rebuild path computes a value that differs from what was already paid
-- in a settled batch, we MUST NOT mutate the row. Instead we emit one row into
-- this table so the operator can review and decide on a §3.6 compensating entry.
--
-- Settled rows are NEVER mutated regardless of what this table records.

CREATE TABLE IF NOT EXISTS ledger_drift_detected (
  id                BIGSERIAL PRIMARY KEY,
  detected_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- The ledger row that diverged
  ledger_id         BIGINT NOT NULL,           -- cleaner_ledger.id (FK omitted; rows are immutable)
  user_id           BIGINT NOT NULL,
  team_member_id    BIGINT,
  job_id            BIGINT,
  ledger_type       TEXT NOT NULL,             -- earning/tip/incentive/cash_collected
  payout_batch_id   BIGINT,                    -- the batch holding the settled row

  -- What was paid vs what rebuild would have computed
  current_amount    NUMERIC(12, 2) NOT NULL,
  computed_amount   NUMERIC(12, 2) NOT NULL,
  delta             NUMERIC(12, 2) GENERATED ALWAYS AS (computed_amount - current_amount) STORED,

  -- What caused the rebuild
  source            TEXT NOT NULL,             -- e.g. 'rebuildJobLedger', 'zb_reconcile', 'cash_redistribution', 'status_cleanup'
  reason            TEXT,                      -- human-readable detail

  -- Optional snapshot pair for forensics
  stored_snapshot   JSONB,                     -- the row's metadata at detection time
  computed_inputs   JSONB,                     -- inputs the rebuild used (rate/hours/revenue)

  resolved_at       TIMESTAMPTZ,
  resolved_by       BIGINT,
  resolution_note   TEXT
);

CREATE INDEX IF NOT EXISTS idx_ledger_drift_user_unresolved
  ON ledger_drift_detected (user_id, detected_at DESC)
  WHERE resolved_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_ledger_drift_batch
  ON ledger_drift_detected (payout_batch_id)
  WHERE payout_batch_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ledger_drift_job
  ON ledger_drift_detected (job_id);

COMMENT ON TABLE ledger_drift_detected IS
  'Synchronization Constitution §3.1 — batched ledger rows are immutable. '
  'When a rebuild path would have computed a different amount, the divergence '
  'is recorded here instead of mutating the settled row. Resolution requires a '
  'compensating entry per §3.6.';
