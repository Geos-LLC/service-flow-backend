-- ═══════════════════════════════════════════════════════════════
-- Migration 044: Business profile fields
-- ═══════════════════════════════════════════════════════════════
-- The redesigned /settings/business-profile page collects fields that
-- the original users-table schema didn't have. Add them so the page's
-- Save actually persists what the user enters.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS tagline       TEXT,
  ADD COLUMN IF NOT EXISTS industry      VARCHAR(120),
  ADD COLUMN IF NOT EXISTS business_type VARCHAR(120),
  ADD COLUMN IF NOT EXISTS website       TEXT,
  ADD COLUMN IF NOT EXISTS support_email TEXT,
  ADD COLUMN IF NOT EXISTS location      TEXT,
  ADD COLUMN IF NOT EXISTS timezone      VARCHAR(80),
  ADD COLUMN IF NOT EXISTS currency      VARCHAR(40),
  ADD COLUMN IF NOT EXISTS logo_url      TEXT;

NOTIFY pgrst, 'reload schema';
