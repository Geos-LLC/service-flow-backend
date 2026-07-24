-- Rollback: 071_proofpix_paired_by_identity.sql

ALTER TABLE public.proofpix_connections
  DROP COLUMN IF EXISTS paired_by_proofpix_user_id,
  DROP COLUMN IF EXISTS paired_by_name,
  DROP COLUMN IF EXISTS paired_by_email;
