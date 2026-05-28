-- Rollback for 057_orchestration_credentials.sql.
--
-- Safe to run on a database that never had S0 applied (every DROP / ALTER
-- uses IF EXISTS). Order: drop dependents (codes -> clients), then
-- credentials, then communication_settings columns.

-- communication_settings: drop the 6 orchestration connection columns.
ALTER TABLE public.communication_settings
  DROP COLUMN IF EXISTS lb_orchestration_state_ref,
  DROP COLUMN IF EXISTS lb_orchestration_subscription_id,
  DROP COLUMN IF EXISTS lb_orchestration_enabled_at,
  DROP COLUMN IF EXISTS lb_orchestration_webhook_set_at,
  DROP COLUMN IF EXISTS lb_orchestration_webhook_secret_enc,
  DROP COLUMN IF EXISTS lb_orchestration_webhook_url;

-- lb_oauth_codes references lb_oauth_clients (FK) and lb_orchestration_credentials (FK).
-- Drop indexes + table first.
DROP INDEX IF EXISTS public.idx_lb_oauth_codes_user;
DROP INDEX IF EXISTS public.idx_lb_oauth_codes_expiry;
DROP TABLE IF EXISTS public.lb_oauth_codes;

-- lb_oauth_clients (no dependents after lb_oauth_codes is gone).
DROP TABLE IF EXISTS public.lb_oauth_clients;

-- lb_orchestration_credentials and its indexes.
DROP INDEX IF EXISTS public.idx_lb_orch_cred_cleanup;
DROP INDEX IF EXISTS public.idx_lb_orch_cred_hash;
DROP INDEX IF EXISTS public.idx_lb_orch_cred_rotating;
DROP INDEX IF EXISTS public.idx_lb_orch_cred_active;
DROP TABLE IF EXISTS public.lb_orchestration_credentials;
