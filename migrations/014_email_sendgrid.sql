-- ═══════════════════════════════════════════════════════════════
-- Migration 014: Email (SendGrid) Communication Channel
-- ═══════════════════════════════════════════════════════════════
-- Email is a ServiceFlow-native channel powered by SendGrid (NOT Sigcore).
-- Conversations use the same unified tables with provider='sendgrid', channel='email'.
-- Multiple sender addresses tracked via communication_provider_accounts.

-- ── 1. Email columns on communication_settings ──
ALTER TABLE communication_settings
  ADD COLUMN IF NOT EXISTS email_connected boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS sendgrid_api_key text,
  ADD COLUMN IF NOT EXISTS email_connected_at timestamptz;

-- ── 2. Email identity fields on communication_conversations ──
ALTER TABLE communication_conversations
  ADD COLUMN IF NOT EXISTS participant_email varchar,
  ADD COLUMN IF NOT EXISTS endpoint_email varchar,
  ADD COLUMN IF NOT EXISTS email_thread_id varchar;

-- ── 3. Email identity unique index ──
-- Mirrors idx_comm_conv_identity for phone-based channels.
-- Same participant_email across different endpoint_email = separate conversations.
CREATE UNIQUE INDEX IF NOT EXISTS idx_comm_conv_email_identity
  ON communication_conversations(user_id, provider, endpoint_email, participant_email)
  WHERE provider = 'sendgrid' AND endpoint_email IS NOT NULL AND participant_email IS NOT NULL;

-- ── 4. Email fields on communication_messages ──
ALTER TABLE communication_messages
  ADD COLUMN IF NOT EXISTS from_email varchar,
  ADD COLUMN IF NOT EXISTS to_email varchar,
  ADD COLUMN IF NOT EXISTS email_subject varchar,
  ADD COLUMN IF NOT EXISTS body_html text,
  ADD COLUMN IF NOT EXISTS email_message_id varchar,
  ADD COLUMN IF NOT EXISTS email_in_reply_to varchar,
  ADD COLUMN IF NOT EXISTS email_references text;

-- ── 5. Source system tracking ──
-- REQUIRED for all email messages (source_system = 'sendgrid').
ALTER TABLE communication_messages
  ADD COLUMN IF NOT EXISTS source_system varchar;

-- ── 6. Indexes ──
-- Thread lookup for email threading (In-Reply-To / References)
CREATE INDEX IF NOT EXISTS idx_comm_conv_email_thread
  ON communication_conversations(user_id, email_thread_id)
  WHERE email_thread_id IS NOT NULL;

-- Message-ID dedup to prevent duplicate inbound emails
CREATE UNIQUE INDEX IF NOT EXISTS idx_comm_msg_email_msgid
  ON communication_messages(email_message_id)
  WHERE email_message_id IS NOT NULL;
