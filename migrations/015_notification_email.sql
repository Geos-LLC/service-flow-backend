-- ═══════════════════════════════════════════════════════════════
-- Migration 015: Notification Email Service (Tenant-Configurable)
-- ═══════════════════════════════════════════════════════════════
-- Centralizes all outbound/transactional email into one service.
-- Replaces global SENDGRID_API_KEY env var with per-tenant settings.
-- Adds delivery logging for audit and troubleshooting.

-- ── 1. Tenant notification email settings ──
CREATE TABLE IF NOT EXISTS notification_email_settings (
  id serial PRIMARY KEY,
  user_id integer NOT NULL REFERENCES users(id),
  provider varchar DEFAULT 'sendgrid',
  is_enabled boolean DEFAULT true,
  sendgrid_api_key text,
  from_email varchar,
  from_name varchar,
  reply_to_email varchar,
  reply_to_name varchar,
  use_for_customer_notifications boolean DEFAULT true,
  use_for_internal_notifications boolean DEFAULT true,
  last_tested_at timestamptz,
  last_test_status varchar,
  last_test_error text,
  created_at timestamptz DEFAULT NOW(),
  updated_at timestamptz DEFAULT NOW(),
  UNIQUE(user_id)
);

-- ── 2. Delivery log table ──
CREATE TABLE IF NOT EXISTS notification_email_logs (
  id serial PRIMARY KEY,
  user_id integer NOT NULL REFERENCES users(id),
  email_type varchar NOT NULL,
  recipient_email varchar NOT NULL,
  recipient_name varchar,
  subject varchar,
  status varchar DEFAULT 'queued',
  provider varchar DEFAULT 'sendgrid',
  provider_message_id varchar,
  error_message text,
  metadata jsonb DEFAULT '{}',
  sent_at timestamptz,
  created_at timestamptz DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_nel_user_type ON notification_email_logs(user_id, email_type);
CREATE INDEX IF NOT EXISTS idx_nel_user_time ON notification_email_logs(user_id, created_at DESC);
