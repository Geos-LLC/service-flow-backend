-- PR-C2 (S0): orchestration-credential schema foundation.
--
-- Additive schema only. No behavior change. No tenant enablement.
-- Dark-launch posture preserved (no app code reads or writes any of
-- these objects yet — they are scaffolded for the staged SF rollout
-- defined in the alignment doc).
--
-- 1. `lb_orchestration_credentials`
--    Canonical SF-side record of orchestration credentials issued to
--    LB tenants. Stores hashed token + state machine (active /
--    rotating / revoked) + grace_expires_at for the 5-minute rotation
--    overlap window. Plaintext tokens are never stored — only the
--    sha256 hash + a 12-char prefix for identification in logs.
--
-- 2. `lb_oauth_clients`
--    Registry of pre-registered OAuth clients (LB envs) with exact
--    redirect-URI allowlist + client_secret hash. One row per LB
--    environment (prod, staging, dev).
--
-- 3. `lb_oauth_codes`
--    Short-lived (5-minute) one-time authorization codes issued at
--    consent → exchanged for a credential at the OAuth exchange
--    endpoint. Single use. Replay attempts return 409 without
--    revoking the credential issued from the first exchange.
--
-- 4. `communication_settings` columns
--    Connection-level orchestration state: webhook URL + encrypted
--    secret + LB-supplied correlation refs + enablement timestamp.
--    All nullable. NULL on every existing row.
--
-- Rollback: 057_orchestration_credentials_down.sql.

-- ─────────────────────────────────────────────────────────────────
-- 1. lb_orchestration_credentials
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.lb_orchestration_credentials (
  id                BIGSERIAL    PRIMARY KEY,
  user_id           INTEGER      NOT NULL,
  token_hash        TEXT         NOT NULL,
  token_prefix      TEXT         NOT NULL,
  kid               TEXT         NOT NULL,
  scope             TEXT         NOT NULL DEFAULT 'lb_orchestration',
  status            TEXT         NOT NULL DEFAULT 'active'
                                 CHECK (status IN ('active', 'rotating', 'revoked')),
  issued_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
  expires_at        TIMESTAMPTZ  NOT NULL,
  grace_expires_at  TIMESTAMPTZ,
  revoked_at        TIMESTAMPTZ,
  revoked_reason    TEXT,
  last_used_at      TIMESTAMPTZ,
  rotated_from_id   BIGINT       REFERENCES public.lb_orchestration_credentials(id),
  created_by        TEXT         NOT NULL DEFAULT 'connect_handshake'
);

COMMENT ON TABLE  public.lb_orchestration_credentials IS
  'SF-issued orchestration credentials for LB. Canonical record; LB holds a runtime mirror. Plaintext token never stored.';
COMMENT ON COLUMN public.lb_orchestration_credentials.token_hash IS
  'sha256(plaintext_token). Used by auth middleware to verify presented tokens.';
COMMENT ON COLUMN public.lb_orchestration_credentials.token_prefix IS
  'First 12 chars of plaintext token (e.g. "sfo_v1.eyJ2Ij") — safe to log.';
COMMENT ON COLUMN public.lb_orchestration_credentials.kid IS
  'Key id of SF_ORCH_SIGNING_KEY used to sign this token. Enables non-breaking key rotation.';
COMMENT ON COLUMN public.lb_orchestration_credentials.status IS
  'active: current credential. rotating: predecessor during 5-min grace. revoked: terminal.';
COMMENT ON COLUMN public.lb_orchestration_credentials.grace_expires_at IS
  'Set only when status=rotating. Auth middleware accepts the token until this timestamp.';

-- Exactly one active credential per tenant.
CREATE UNIQUE INDEX IF NOT EXISTS idx_lb_orch_cred_active
  ON public.lb_orchestration_credentials (user_id)
  WHERE status = 'active';

-- At most one rotating credential per tenant (the predecessor of an active).
CREATE UNIQUE INDEX IF NOT EXISTS idx_lb_orch_cred_rotating
  ON public.lb_orchestration_credentials (user_id)
  WHERE status = 'rotating';

-- Hash lookup for auth middleware.
CREATE INDEX IF NOT EXISTS idx_lb_orch_cred_hash
  ON public.lb_orchestration_credentials (token_hash);

-- Cleanup index for the periodic grace-expiry sweep.
CREATE INDEX IF NOT EXISTS idx_lb_orch_cred_cleanup
  ON public.lb_orchestration_credentials (status, grace_expires_at)
  WHERE status = 'rotating';

-- ─────────────────────────────────────────────────────────────────
-- 2. lb_oauth_clients
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.lb_oauth_clients (
  client_id           TEXT         PRIMARY KEY,
  client_secret_hash  TEXT         NOT NULL,
  display_name        TEXT         NOT NULL,
  redirect_uris       TEXT[]       NOT NULL,
  redirect_host_suffixes TEXT[]    NOT NULL DEFAULT ARRAY[]::TEXT[],
  scopes_allowed      TEXT[]       NOT NULL DEFAULT ARRAY['lb_orchestration']::TEXT[],
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  disabled_at         TIMESTAMPTZ
);

COMMENT ON TABLE  public.lb_oauth_clients IS
  'Pre-registered OAuth clients (LB envs). One row per LB environment. Manually maintained by operators.';
COMMENT ON COLUMN public.lb_oauth_clients.redirect_uris IS
  'Exact-match allowlist. No wildcards. No prefix matching. Trailing slash significant.';
COMMENT ON COLUMN public.lb_oauth_clients.redirect_host_suffixes IS
  'Allowed host suffixes for webhook URLs (e.g. {.leadbridge.com}). Webhook url host must end with one.';
COMMENT ON COLUMN public.lb_oauth_clients.client_secret_hash IS
  'sha256(client_secret). Plaintext secret never stored.';

-- ─────────────────────────────────────────────────────────────────
-- 3. lb_oauth_codes
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.lb_oauth_codes (
  code            TEXT         PRIMARY KEY,
  client_id       TEXT         NOT NULL REFERENCES public.lb_oauth_clients(client_id),
  redirect_uri    TEXT         NOT NULL,
  user_id         INTEGER      NOT NULL,
  scope           TEXT         NOT NULL DEFAULT 'lb_orchestration',
  state           TEXT,
  issued_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ  NOT NULL,
  consumed_at     TIMESTAMPTZ,
  issued_credential_id BIGINT  REFERENCES public.lb_orchestration_credentials(id)
);

COMMENT ON TABLE  public.lb_oauth_codes IS
  'Short-lived one-time authorization codes. 5-minute TTL. Single use.';
COMMENT ON COLUMN public.lb_oauth_codes.consumed_at IS
  'Set when /oauth/exchange consumes the code. Replay attempts return 409 code_already_used; the credential issued from the first exchange is preserved.';
COMMENT ON COLUMN public.lb_oauth_codes.issued_credential_id IS
  'Credential row issued from this code. NULL until exchange completes. Used to satisfy replay-protection lookups without re-running the mint.';

CREATE INDEX IF NOT EXISTS idx_lb_oauth_codes_expiry
  ON public.lb_oauth_codes (expires_at)
  WHERE consumed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_lb_oauth_codes_user
  ON public.lb_oauth_codes (user_id, issued_at DESC);

-- ─────────────────────────────────────────────────────────────────
-- 4. communication_settings: orchestration connection state
-- ─────────────────────────────────────────────────────────────────
ALTER TABLE public.communication_settings
  ADD COLUMN IF NOT EXISTS lb_orchestration_webhook_url        TEXT,
  ADD COLUMN IF NOT EXISTS lb_orchestration_webhook_secret_enc TEXT,
  ADD COLUMN IF NOT EXISTS lb_orchestration_webhook_set_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS lb_orchestration_enabled_at         TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS lb_orchestration_subscription_id    TEXT,
  ADD COLUMN IF NOT EXISTS lb_orchestration_state_ref          TEXT;

COMMENT ON COLUMN public.communication_settings.lb_orchestration_webhook_url IS
  'LB-provided HTTPS URL for SF -> LB service_* + connection.* events. NULL when disconnected.';
COMMENT ON COLUMN public.communication_settings.lb_orchestration_webhook_secret_enc IS
  'AES-256-GCM ciphertext of LB-provided HMAC secret, encrypted with SF_INTEGRATION_ENC_KEY.';
COMMENT ON COLUMN public.communication_settings.lb_orchestration_enabled_at IS
  'Timestamp at which connection-state enablement was set. NULL = orchestration not enabled for this tenant.';
COMMENT ON COLUMN public.communication_settings.lb_orchestration_subscription_id IS
  'Optional LB correlation id, echoed in outbound webhook header X-LB-Subscription-Id.';
COMMENT ON COLUMN public.communication_settings.lb_orchestration_state_ref IS
  'Optional LB correlation ref, echoed in outbound webhook header X-LB-State-Ref.';
