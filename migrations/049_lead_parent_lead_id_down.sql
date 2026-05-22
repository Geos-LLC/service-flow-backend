-- Down migration for 049_lead_parent_lead_id.sql
-- Removes parent_lead_id, lead_origin_type, canonical_lead_id and supporting indices.
-- Forensic loss of canonical/child relationship for any rows created during Phase 0.5.

DROP INDEX IF EXISTS public.idx_leads_user_canonical_pipeline;
DROP INDEX IF EXISTS public.idx_leads_parent;
DROP INDEX IF EXISTS public.idx_leads_user_canonical;

ALTER TABLE public.leads
  DROP COLUMN IF EXISTS canonical_lead_id,
  DROP CONSTRAINT IF EXISTS leads_lead_origin_type_check;
ALTER TABLE public.leads
  DROP COLUMN IF EXISTS lead_origin_type,
  DROP COLUMN IF EXISTS parent_lead_id;
