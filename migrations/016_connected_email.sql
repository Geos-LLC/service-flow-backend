-- ═══════════════════════════════════════════════════════════════
-- Migration 016: Connected Email (Gmail/Outlook OAuth)
-- ═══════════════════════════════════════════════════════════════
-- Real mailbox integration for the Communications Hub.
-- This is System 2 (Connected Email) — separate from System 1 (Notification Email / SendGrid).
-- NOT routed through Sigcore. Provider-native (Gmail API, Microsoft Graph).
--
-- Loose coupling: reuses communication_conversations / communication_messages.
-- Dropping this migration + the services/connected-email/ directory removes the
-- feature without breaking anything else.

-- ── 1. Connected email accounts ────────────────────────────────
-- One row per connected mailbox. Multi-mailbox supported by default.
CREATE TABLE IF NOT EXISTS connected_email_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider varchar NOT NULL CHECK (provider IN ('gmail', 'outlook')),
  email_address varchar NOT NULL,
  display_name varchar,
  status varchar NOT NULL DEFAULT 'connected'
    CHECK (status IN ('connected', 'expired', 'error', 'syncing', 'disconnected')),

  -- Token storage (AES-256-GCM, app-layer encryption)
  access_token_ciphertext bytea,
  access_token_iv bytea,
  access_token_auth_tag bytea,
  refresh_token_ciphertext bytea,
  refresh_token_iv bytea,
  refresh_token_auth_tag bytea,
  token_key_version smallint DEFAULT 1,
  token_expires_at timestamptz,

  -- Sync cursor
  history_cursor text,
  initial_sync_completed_at timestamptz,
  last_sync_at timestamptz,
  scopes text[],

  -- Metadata
  disconnect_reason text,
  created_at timestamptz DEFAULT NOW(),
  updated_at timestamptz DEFAULT NOW(),

  UNIQUE (user_id, provider, email_address)
);

CREATE INDEX IF NOT EXISTS idx_cea_user_status ON connected_email_accounts(user_id, status);
CREATE INDEX IF NOT EXISTS idx_cea_email ON connected_email_accounts(LOWER(email_address));

-- ── 2. Sync state (durable, survives restarts) ─────────────────
CREATE TABLE IF NOT EXISTS connected_email_sync_state (
  account_id uuid PRIMARY KEY REFERENCES connected_email_accounts(id) ON DELETE CASCADE,
  last_run_at timestamptz,
  last_success_at timestamptz,
  consecutive_failures integer DEFAULT 0,
  last_error text,
  last_error_at timestamptz,
  next_run_at timestamptz DEFAULT NOW(),
  is_running boolean DEFAULT false,
  run_started_at timestamptz,
  messages_synced_total integer DEFAULT 0,
  updated_at timestamptz DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cess_next_run ON connected_email_sync_state(next_run_at)
  WHERE is_running = false;

-- ── 3. OAuth state (single-use nonce, prevents replay) ─────────
CREATE TABLE IF NOT EXISTS connected_email_oauth_states (
  state_token text PRIMARY KEY,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider varchar NOT NULL,
  nonce text NOT NULL,
  redirect_after text,
  consumed_at timestamptz,
  expires_at timestamptz NOT NULL,
  created_at timestamptz DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ceos_expires ON connected_email_oauth_states(expires_at);

-- ── 4. Activate email columns on communication_conversations ──
-- Most already exist from migration 014 (dormant).
ALTER TABLE communication_conversations
  ADD COLUMN IF NOT EXISTS participant_email varchar,
  ADD COLUMN IF NOT EXISTS endpoint_email varchar,
  ADD COLUMN IF NOT EXISTS email_thread_id varchar,
  ADD COLUMN IF NOT EXISTS conversation_type varchar;

-- Soft identity index (NOT unique) — lookup performance only.
-- Per spec correction: do not overcommit to thread_id as sole uniqueness anchor.
CREATE INDEX IF NOT EXISTS idx_cc_connected_email_lookup
  ON communication_conversations(user_id, provider, endpoint_email, email_thread_id)
  WHERE channel = 'email' AND email_thread_id IS NOT NULL;

-- Conditional partial unique: only enforced when thread_id is present.
-- Prevents dupes from the same thread, allows separate conversations when provider
-- threading is broken.
CREATE UNIQUE INDEX IF NOT EXISTS idx_cc_connected_email_identity
  ON communication_conversations(user_id, provider, endpoint_email, participant_email, email_thread_id)
  WHERE channel = 'email'
    AND email_thread_id IS NOT NULL
    AND endpoint_email IS NOT NULL
    AND participant_email IS NOT NULL;

-- ── 5. Activate email columns on communication_messages ───────
-- Note: communication_messages links to tenant via conversation_id, not user_id.
ALTER TABLE communication_messages
  ADD COLUMN IF NOT EXISTS from_email varchar,
  ADD COLUMN IF NOT EXISTS to_email varchar,
  ADD COLUMN IF NOT EXISTS email_subject varchar,
  ADD COLUMN IF NOT EXISTS body_html text,
  ADD COLUMN IF NOT EXISTS body_text text,
  ADD COLUMN IF NOT EXISTS email_message_id varchar,
  ADD COLUMN IF NOT EXISTS email_in_reply_to varchar,
  ADD COLUMN IF NOT EXISTS email_references text,
  ADD COLUMN IF NOT EXISTS provider varchar;

-- Hard dedupe: one row per RFC-5322 Message-ID (globally unique by spec).
CREATE UNIQUE INDEX IF NOT EXISTS idx_cm_connected_email_msgid
  ON communication_messages(email_message_id)
  WHERE channel = 'email' AND email_message_id IS NOT NULL;

-- ── 6. Schema cache reload ────────────────────────────────────
NOTIFY pgrst, 'reload schema';
