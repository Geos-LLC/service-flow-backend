-- ═══════════════════════════════════════════════════════════════
-- Migration 016b: Delegated shared mailbox support (Outlook)
-- ═══════════════════════════════════════════════════════════════
-- Extends connected_email_accounts to distinguish:
--   auth user (OAuth login) vs target mailbox (the mailbox SF operates on).
-- For primary mailbox, auth = target. For delegated shared mailbox, they differ.
-- Backward compatible: null target_mailbox_email → /me (existing behavior).

ALTER TABLE connected_email_accounts
  ADD COLUMN IF NOT EXISTS auth_email_address varchar,
  ADD COLUMN IF NOT EXISTS auth_display_name varchar,
  ADD COLUMN IF NOT EXISTS target_mailbox_email varchar,
  ADD COLUMN IF NOT EXISTS target_mailbox_display_name varchar,
  ADD COLUMN IF NOT EXISTS mailbox_type varchar DEFAULT 'primary'
    CHECK (mailbox_type IN ('primary', 'shared'));

-- Backfill existing rows.
UPDATE connected_email_accounts
  SET auth_email_address = email_address,
      target_mailbox_email = email_address,
      mailbox_type = 'primary'
  WHERE auth_email_address IS NULL;

NOTIFY pgrst, 'reload schema';
