-- ═══════════════════════════════════════════════════════════════
-- Migration 045: Payment settings v2 — accepted methods, payouts, automation
-- ═══════════════════════════════════════════════════════════════
-- Backs the redesigned /settings/payments page sections:
--  - Accepted payment methods (toggle list)
--  - Payout schedule (frequency / minimum / descriptor)
--  - Automation (auto-charge, retries, tipping, receipt)

ALTER TABLE user_payment_settings
  ADD COLUMN IF NOT EXISTS accepted_methods      JSONB,
  ADD COLUMN IF NOT EXISTS payout_frequency      VARCHAR(40),
  ADD COLUMN IF NOT EXISTS minimum_payout        NUMERIC(12, 2),
  ADD COLUMN IF NOT EXISTS statement_descriptor  VARCHAR(22),
  ADD COLUMN IF NOT EXISTS automation            JSONB;

NOTIFY pgrst, 'reload schema';
