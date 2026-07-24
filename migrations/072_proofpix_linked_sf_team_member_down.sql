-- Rollback: 072_proofpix_linked_sf_team_member.sql

DROP INDEX IF EXISTS public.idx_proofpix_connections_linked_team_member_active;

ALTER TABLE public.proofpix_connections
  DROP COLUMN IF EXISTS linked_sf_team_member_id;

ALTER TABLE public.proofpix_connect_codes
  DROP COLUMN IF EXISTS linked_sf_team_member_id;
