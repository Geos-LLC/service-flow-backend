-- Customer-level acquisition attribution.
--
-- Captures the FIRST acquisition source for each customer. Write-once
-- semantics: once acquisition_external_request_id is set, no later write
-- should overwrite it. This is the analytics-friendly attribution column
-- complementing the existing `customers.source` (which can be mutated by
-- any future sync).
--
-- Designed to support the recurring-customer attribution model: a
-- customer acquired via LB and serviced through 20+ recurring jobs is
-- attributed to LB at the customer level WITHOUT stamping
-- `lb_external_request_id` on every recurring job (avoids outbound storm).
--
-- Rule of thumb:
--   acquisition_*               → immutable, write-once original acquisition
--   customers.source            → mutable, current best-known display source
--   jobs.lb_external_request_id → only on the acquisition job (one per LB lead)
--
-- Additive + nullable. Existing rows: NULL until either:
--   1. resolver writes it at next LB-origin customer event, OR
--   2. backfill-jobs-lb-linkage.js --mode recurring sets it for HIGH cases.
--
-- Rollback: 054_customers_acquisition_down.sql.

ALTER TABLE public.customers
  ADD COLUMN IF NOT EXISTS acquisition_source              TEXT,
  ADD COLUMN IF NOT EXISTS acquisition_channel             TEXT,
  ADD COLUMN IF NOT EXISTS acquisition_business_id         TEXT,
  ADD COLUMN IF NOT EXISTS acquisition_external_request_id TEXT,
  ADD COLUMN IF NOT EXISTS acquisition_at                  TIMESTAMPTZ;

COMMENT ON COLUMN public.customers.acquisition_source IS
  'Acquisition channel family — leadbridge / zenbooker / manual / openphone. Write-once at the FIRST event that creates or links this customer. Never overwritten by later syncs.';
COMMENT ON COLUMN public.customers.acquisition_channel IS
  'For LB acquisitions: thumbtack | yelp. For other sources, the carrier name. NULL otherwise.';
COMMENT ON COLUMN public.customers.acquisition_business_id IS
  'LB-side businessId (TT business id / Yelp business id) at acquisition time. Mirror of leads.lb_business_id.';
COMMENT ON COLUMN public.customers.acquisition_external_request_id IS
  'LB-side externalRequestId (TT negotiation id / Yelp lead id) at acquisition. Drives the customer-acquisition resolver strategy.';
COMMENT ON COLUMN public.customers.acquisition_at IS
  'Timestamp of the LB lead createdAt (the moment the customer was acquired by LB).';

-- Backs the resolver Strategy 4 lookup: given a customer_id, find LB
-- linkage via customer-level acquisition. Partial index because only
-- LB-attributed customers carry this.
CREATE INDEX IF NOT EXISTS idx_customers_acquisition
  ON public.customers (user_id, acquisition_business_id, acquisition_channel)
  WHERE acquisition_external_request_id IS NOT NULL;
