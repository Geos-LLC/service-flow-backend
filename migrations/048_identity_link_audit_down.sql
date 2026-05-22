-- Down migration for 048_identity_link_audit.sql
-- Drops the audit table. Forensic history is lost; restore from backup if needed.

DROP INDEX IF EXISTS public.idx_identity_link_audit_lead;
DROP INDEX IF EXISTS public.idx_identity_link_audit_identity;
DROP INDEX IF EXISTS public.idx_identity_link_audit_user_created;
DROP TABLE IF EXISTS public.identity_link_audit;
