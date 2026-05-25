-- Reverse of 051_leads_lb_linkage.sql. Drops indexes first, then columns.

DROP INDEX IF EXISTS public.idx_leads_converted_customer_lb;
DROP INDEX IF EXISTS public.idx_leads_user_lb_external_request_id;

ALTER TABLE public.leads
  DROP COLUMN IF EXISTS lb_provider_account_id,
  DROP COLUMN IF EXISTS lb_business_id,
  DROP COLUMN IF EXISTS lb_channel,
  DROP COLUMN IF EXISTS lb_external_request_id;
