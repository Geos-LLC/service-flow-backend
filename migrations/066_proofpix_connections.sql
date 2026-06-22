-- ProofPix integration — PR 1: handshake plumbing.
--
-- Two tables:
--   proofpix_connect_codes   — short-lived (10 min), single-use codes the
--                              SF admin generates and pastes into the
--                              ProofPix app to bind a device.
--   proofpix_connections     — one row per active device. Refresh token
--                              stored as sha256 hash (raw value never
--                              persisted). Soft-revoke via revoked_at so
--                              the row is preserved for audit / "Active
--                              ProofPix devices" admin UI.
--
-- All routes that read these tables are gated behind the
-- PROOFPIX_INTEGRATION_ENABLED feature flag (default OFF).
--
-- Rollback: 066_proofpix_connections_down.sql.

CREATE TABLE IF NOT EXISTS public.proofpix_connect_codes (
  code               TEXT         PRIMARY KEY,
  user_id            INTEGER      NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  expires_at         TIMESTAMPTZ  NOT NULL,
  redeemed_at        TIMESTAMPTZ,
  redeemed_by_label  TEXT,
  created_at         TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_proofpix_connect_codes_user
  ON public.proofpix_connect_codes (user_id);

CREATE INDEX IF NOT EXISTS idx_proofpix_connect_codes_expires
  ON public.proofpix_connect_codes (expires_at)
  WHERE redeemed_at IS NULL;

COMMENT ON TABLE public.proofpix_connect_codes IS
  'Single-use codes (10 min TTL) issued by SF admin, redeemed by the ProofPix mobile app to bind a device. Row preserved after redemption for audit.';

COMMENT ON COLUMN public.proofpix_connect_codes.code IS
  'Human-typeable code, e.g. ABCD-EFGH-IJKL-MNOP. ~80 bits entropy (base32 of 10 random bytes). Single-use enforced by redeemed_at.';

CREATE TABLE IF NOT EXISTS public.proofpix_connections (
  id                  BIGSERIAL    PRIMARY KEY,
  user_id             INTEGER      NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  refresh_token_hash  TEXT         NOT NULL,
  device_label        TEXT,
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  last_used_at        TIMESTAMPTZ,
  revoked_at          TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_proofpix_connections_token_hash
  ON public.proofpix_connections (refresh_token_hash);

CREATE INDEX IF NOT EXISTS idx_proofpix_connections_user_active
  ON public.proofpix_connections (user_id)
  WHERE revoked_at IS NULL;

COMMENT ON TABLE public.proofpix_connections IS
  'One row per ProofPix device connection. Multiple devices per SF user allowed (admin phone + tablet, team admins, etc). Each row has its own refresh token; revoke independently via revoked_at.';

COMMENT ON COLUMN public.proofpix_connections.refresh_token_hash IS
  'sha256 hex of the refresh token. Raw token returned once at /connect/code/redeem, never persisted. DB leak does not leak active tokens.';

COMMENT ON COLUMN public.proofpix_connections.device_label IS
  'Free-form, supplied by the ProofPix mobile client at /redeem (e.g. "iPhone 15 - Sarah"). Displayed in the future "Active ProofPix devices" admin UI.';
