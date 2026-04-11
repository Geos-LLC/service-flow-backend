-- ═══════════════════════════════════════════════════════════════
-- Migration 012: Paystubs
-- ═══════════════════════════════════════════════════════════════
-- Paystubs are immutable document/communication records generated from
-- payout batches or payroll periods. They do NOT recalculate financials —
-- the snapshot_json field stores the frozen breakdown at generation time.
--
-- Source of truth: cleaner_ledger
-- Paystub role: document + email delivery tracking

CREATE TABLE IF NOT EXISTS paystubs (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  team_member_id INTEGER NOT NULL,
  payout_batch_id INTEGER REFERENCES cleaner_payout_batch(id) ON DELETE SET NULL,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'draft', -- draft | issued | sent | failed
  issued_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  email_to VARCHAR(255),
  email_status VARCHAR(32),   -- 'sent', 'delivered', 'bounced', 'error'
  email_error TEXT,
  email_message_id VARCHAR(128), -- SendGrid x-message-id
  document_url TEXT,           -- future: stored PDF link
  snapshot_json JSONB NOT NULL, -- frozen financial breakdown
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  created_by INTEGER
);

CREATE INDEX IF NOT EXISTS idx_paystubs_user ON paystubs(user_id, period_end DESC);
CREATE INDEX IF NOT EXISTS idx_paystubs_member ON paystubs(team_member_id, period_end DESC);
CREATE INDEX IF NOT EXISTS idx_paystubs_batch ON paystubs(payout_batch_id);
CREATE INDEX IF NOT EXISTS idx_paystubs_status ON paystubs(user_id, status);
-- One paystub per payout batch (admin can delete+regenerate)
CREATE UNIQUE INDEX IF NOT EXISTS idx_paystubs_unique_batch
  ON paystubs(payout_batch_id) WHERE payout_batch_id IS NOT NULL;
