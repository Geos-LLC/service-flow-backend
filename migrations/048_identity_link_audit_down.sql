-- Down migration for 048_identity_link_audit.sql
--
-- Rollback artefacts:
--   1. Drops identity_link_audit table — forensic history is lost; restore from backup if needed.
--   2. Drops communication_participant_identities.last_hydrated_by column.
--      Observational only, so no business-logic regression.

-- 2. last_hydrated_by column + index
DROP INDEX IF EXISTS public.idx_identities_last_hydrated_by;
ALTER TABLE public.communication_participant_identities
  DROP COLUMN IF EXISTS last_hydrated_by;

-- 1. identity_link_audit table + indices
DROP INDEX IF EXISTS public.idx_identity_link_audit_lead;
DROP INDEX IF EXISTS public.idx_identity_link_audit_identity;
DROP INDEX IF EXISTS public.idx_identity_link_audit_user_created;
DROP TABLE IF EXISTS public.identity_link_audit;
