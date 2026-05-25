-- LeadBridge linkage on leads — preserves LB identity (externalRequestId,
-- channel, businessId, provider account) from lead-creation forward so the
-- downstream lead → customer → job chain can carry it into jobs.lb_*.
--
-- Why:
--   `jobs` already has lb_external_request_id / lb_channel (migration 022),
--   but `leads` does not. The LB→SF lead.created webhook + sync paths write
--   a row into `leads` and lose the LB external id at that boundary. When a
--   manager later converts the lead → customer → job, there is no source of
--   truth to propagate LB linkage onto the job — so SF→LB outbound silently
--   drops every status change with skipped_not_linked.
--
--   Storing the linkage on `leads` closes that gap. The /api/jobs handler
--   joins customer_id → leads.converted_customer_id and copies the linkage
--   onto the job INSERT before maybeEmitInsertEvent runs.
--
-- All columns are additive + nullable. Existing rows: lb_* NULL until the
-- one-shot backfill (scripts/backfill-leads-lb-linkage.js, future) runs OR
-- until the next LB sync touches them via enrichLeadFromLB (fill-nulls-only).
--
-- Rollback: 051_leads_lb_linkage_down.sql.

ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS lb_external_request_id TEXT,
  ADD COLUMN IF NOT EXISTS lb_channel             TEXT,
  ADD COLUMN IF NOT EXISTS lb_business_id         TEXT,
  ADD COLUMN IF NOT EXISTS lb_provider_account_id BIGINT;

COMMENT ON COLUMN public.leads.lb_external_request_id IS
  'LB-side externalRequestId (TT negotiation id / Yelp lead id). Mirror of jobs.lb_external_request_id; copied onto jobs at lead → customer → job conversion. Globally unique within a (lb_channel) scope on LB; per-tenant unique in SF. NULL for non-LB-sourced leads.';

COMMENT ON COLUMN public.leads.lb_channel IS
  'LB platform channel — "thumbtack" or "yelp". Mirror of jobs.lb_channel. NULL for non-LB-sourced leads.';

COMMENT ON COLUMN public.leads.lb_business_id IS
  'LB-side businessId (TT business id / Yelp business id). Stable per-business identifier; useful for multi-account routing audits. NULL for non-LB-sourced leads.';

COMMENT ON COLUMN public.leads.lb_provider_account_id IS
  'FK-like pointer to communication_provider_accounts.id (numeric PK) for the LB account that ingested this lead. Reused by communications-side audits without re-joining external_account_id. NULL for non-LB-sourced leads.';

-- Lookup index — used by:
--   1. Backfill: find leads with linkage for a given external id during job repair.
--   2. /api/jobs handler: given customer_id, look up lead.lb_* to copy onto job.
--   3. Ambiguity detection: count leads sharing the same (user_id, lb_external_request_id, lb_channel).
CREATE INDEX IF NOT EXISTS idx_leads_user_lb_external_request_id
  ON public.leads(user_id, lb_external_request_id, lb_channel)
  WHERE lb_external_request_id IS NOT NULL;

-- Reverse lookup for converted-customer chain.
CREATE INDEX IF NOT EXISTS idx_leads_converted_customer_lb
  ON public.leads(user_id, converted_customer_id)
  WHERE lb_external_request_id IS NOT NULL;
