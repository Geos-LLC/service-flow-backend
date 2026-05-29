-- R1B — Credential refresh marker.
--
-- Adds `needs_refresh_at` column to lb_orchestration_credentials. Set
-- by the operator path (POST /api/internal/lb-orchestration/credentials/
-- mark_for_rotation) to signal that LB should call /credentials/refresh
-- to obtain a new credential.
--
-- The credential.rotated webhook event accompanies the marker and tells
-- LB "rotation pending — call /refresh to retrieve the new credential."
--
-- The LB-facing POST /api/integrations/leadbridge/orchestration/
-- credentials/refresh endpoint:
--   - authenticates via the current orchestration bearer
--   - checks: bearer's credential is status='active' AND needs_refresh_at
--     IS NOT NULL
--   - if both true: performs the rotation atomically (mints new active,
--     demotes current to rotating with 5-min grace, clears the marker)
--     and returns the new plaintext token ONCE
--   - else: 409 (no_pending_rotation or already_rotated_this_cycle)
--
-- Force-rotate path (POST /api/internal/lb-orchestration/credentials/
-- rotate, existing) does NOT use this marker. It performs immediate
-- rotation + returns plaintext to the operator + emits credential.rotated
-- webhook (LB will hit /refresh and get 409 → triggers full reconnect).
--
-- Additive schema only. Existing credentials default to needs_refresh_at
-- = NULL.

ALTER TABLE public.lb_orchestration_credentials
  ADD COLUMN IF NOT EXISTS needs_refresh_at TIMESTAMPTZ;

COMMENT ON COLUMN public.lb_orchestration_credentials.needs_refresh_at IS
  'R1B: set by mark_for_rotation to signal that LB should call /credentials/refresh to retrieve a new credential. Cleared (NULL) when the rotation actually happens (or when the credential is revoked).';

-- Operator audit query path: who is currently marked for refresh?
CREATE INDEX IF NOT EXISTS idx_lb_orch_cred_needs_refresh
  ON public.lb_orchestration_credentials (user_id, needs_refresh_at)
  WHERE needs_refresh_at IS NOT NULL AND status = 'active';
