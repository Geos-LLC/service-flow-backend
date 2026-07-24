-- Rollback: 070_proofpix_team_member_attribution.sql

DROP INDEX IF EXISTS public.idx_proofpix_connections_team_member_active;

ALTER TABLE public.proofpix_connections
  DROP COLUMN IF EXISTS team_member_id;

ALTER TABLE public.proofpix_connect_codes
  DROP COLUMN IF EXISTS team_member_id;
