-- Two-field source attribution model — preserve raw provider attribution
-- alongside the canonical mapped source.
--
-- Why:
--   Today `leads.source` holds the raw provider label (e.g.
--   "Georgiy Sayapin (thumbtack)" for LeadBridge,
--   or the lead_source_mappings canonical for OpenPhone). Tenants configure
--   lead_source_mappings (provider, raw_value → canonical source_name) to
--   group these into clean UI buckets ("Thumbtack Miami"). The LeadBridge
--   ingest path never consulted that table, so LB-source rows live outside
--   the canonical scheme and SQL/exports/dashboards disagree with the UI.
--
--   This column lets us write the canonical mapped value to `source` while
--   preserving the raw provider/account attribution in `source_raw` for:
--     - debugging
--     - LB account/business status sync
--     - knowing exactly which LB business produced the lead
--     - graceful behavior when tenants rename canonical buckets later
--
-- All additive. Existing rows: source unchanged, source_raw NULL until the
-- backfill (scripts/backfill-source-raw.js) runs explicitly. The application
-- code writes both columns going forward.
--
-- Rollback: 050_lead_source_raw_down.sql.

ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS source_raw VARCHAR;

COMMENT ON COLUMN public.leads.source_raw IS
  'Raw provider/account attribution at lead-creation time. For LeadBridge: "${accountDisplayName} (${channel})" — e.g. "Georgiy Sayapin (thumbtack)". For OpenPhone: the company tag / raw conversation source label. For manual entry: copy of leads.source. The canonical mapped value (per lead_source_mappings) lives in leads.source; source_raw is the lossless attribution used for debugging, status-sync to LB, and surviving mapping renames. Backfilled by scripts/backfill-source-raw.js.';

-- Per-tenant raw-source lookup (debug + backfill report).
CREATE INDEX IF NOT EXISTS idx_leads_user_source_raw
  ON public.leads(user_id, source_raw)
  WHERE source_raw IS NOT NULL;
