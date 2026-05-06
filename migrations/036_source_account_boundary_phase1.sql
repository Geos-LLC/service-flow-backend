-- ═══════════════════════════════════════════════════════════════
-- Migration 036: Source-Account Boundary — Phase 1 (additive only)
-- ═══════════════════════════════════════════════════════════════
-- See docs/security/source-account-boundary-plan.md for the full
-- design. This migration is the schema layer of that plan.
--
-- Adds:
--   1. provider_account_id on communication_messages, _calls, and
--      communication_participant_identities (nullable FK to
--      communication_provider_accounts, ON DELETE SET NULL).
--   2. hidden_at + legacy_unknown_source on communication_conversations.
--   3. Indexes for the new columns + a partial "visible" index for
--      the upcoming read-side gate.
--
-- This migration is additive and nullable. No backfill, no read-side
-- enforcement, no data hidden. Existing queries continue to work
-- because every new column defaults to NULL/false.
--
-- Read-side enforcement is gated behind the SOURCE_ACCOUNT_BOUNDARY_ENFORCED
-- env flag (default false) — see lib/feature-flags.js.
-- ═══════════════════════════════════════════════════════════════


-- ────────────────────────────────────────────────────────────────
-- 1. Provider-account FK on messages, calls, identities
--
-- Today only LB conversations are stamped with provider_account_id
-- (col added in migration 006). Phase 1 extends the same FK down
-- to the row-level child tables so disconnect can address them.
--
-- ON DELETE SET NULL matches the convention from migration 006 — we
-- never want a stray FK to break message rendering.
-- ────────────────────────────────────────────────────────────────

ALTER TABLE public.communication_messages
  ADD COLUMN IF NOT EXISTS provider_account_id integer
    REFERENCES public.communication_provider_accounts(id) ON DELETE SET NULL;

ALTER TABLE public.communication_calls
  ADD COLUMN IF NOT EXISTS provider_account_id integer
    REFERENCES public.communication_provider_accounts(id) ON DELETE SET NULL;

ALTER TABLE public.communication_participant_identities
  ADD COLUMN IF NOT EXISTS provider_account_id integer
    REFERENCES public.communication_provider_accounts(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_comm_msg_provider_account
  ON public.communication_messages(provider_account_id)
  WHERE provider_account_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_comm_call_provider_account
  ON public.communication_calls(provider_account_id)
  WHERE provider_account_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_cpi_provider_account
  ON public.communication_participant_identities(provider_account_id)
  WHERE provider_account_id IS NOT NULL;


-- ────────────────────────────────────────────────────────────────
-- 2. Visibility helpers on communication_conversations
--
-- hidden_at: set when the source provider_account is disconnected,
-- cleared on reconnect. Lets the read path skip rows without joining
-- communication_provider_accounts on every query.
--
-- legacy_unknown_source: true for rows that pre-date the boundary
-- model and cannot be confidently attributed to a source account.
-- Excluded from account-scoped views; visible only in the global
-- "All conversations" view (when the read-side flag flips on).
--
-- NOTE: the same `hidden_at` name already exists on
-- communication_participant_identities (used by the OP-orphan logic
-- at server.js:40448) — we are deliberately matching that convention.
-- ────────────────────────────────────────────────────────────────

ALTER TABLE public.communication_conversations
  ADD COLUMN IF NOT EXISTS hidden_at timestamptz;

ALTER TABLE public.communication_conversations
  ADD COLUMN IF NOT EXISTS legacy_unknown_source boolean NOT NULL DEFAULT false;

-- Partial index for the eventual read-side gate. Today nothing reads
-- it, but it costs nothing to put in place ahead of the flag flip.
CREATE INDEX IF NOT EXISTS idx_comm_conv_visible
  ON public.communication_conversations(user_id, channel, last_event_at DESC)
  WHERE hidden_at IS NULL AND is_archived = false AND legacy_unknown_source = false;


-- ────────────────────────────────────────────────────────────────
-- 3. Comments
-- ────────────────────────────────────────────────────────────────

COMMENT ON COLUMN public.communication_messages.provider_account_id IS
  'Source account that imported this message. Stamped from the parent conversation at write time. Nullable for legacy rows.';

COMMENT ON COLUMN public.communication_calls.provider_account_id IS
  'Source account that imported this call. Stamped from the parent conversation at write time. Nullable for legacy rows.';

COMMENT ON COLUMN public.communication_participant_identities.provider_account_id IS
  'Source account that *created* this identity row (audit/attribution only). Identity reads should NOT gate on this column''s account status — identities can carry markers from multiple providers.';

COMMENT ON COLUMN public.communication_conversations.hidden_at IS
  'Set when the source provider_account becomes disconnected; cleared on reconnect. Phase 1 of the source-account boundary. Read-side enforcement gated by SOURCE_ACCOUNT_BOUNDARY_ENFORCED.';

COMMENT ON COLUMN public.communication_conversations.legacy_unknown_source IS
  'True for rows that pre-date the source-account boundary and cannot be confidently attributed. Excluded from account-scoped views once the read-side gate is enabled.';


-- Refresh PostgREST schema cache
NOTIFY pgrst, 'reload schema';
