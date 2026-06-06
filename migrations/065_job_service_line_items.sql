-- Per-service line items on multi-service jobs.
--
-- Before this column, the create endpoint silently dropped every
-- service after the first: serviceIds was destructured nowhere, and
-- service_name was set from the single primary service's name (see
-- createjob.jsx:1391). A job booked as "Deep Cleaning + Deep
-- Cleaning" persisted as one row with service_name = "Deep Cleaning"
-- and the combined price in service_price — there was no signal at
-- read time that more than one service existed.
--
-- service_line_items captures the per-service breakdown:
--   [{ "serviceId": 123, "name": "Deep Cleaning", "basePrice": 259 },
--    { "serviceId": 123, "name": "Deep Cleaning", "basePrice": 259 }]
--
-- The Financials card on job-details-v2.jsx reads this column to
-- render one block per service with its own name and base price.
-- service_modifiers continues to carry its existing modifier.serviceId
-- tag so add-ons attach to the right line. The summed base prices
-- still equal service_price, so existing totals are unaffected.
--
-- Backfill is intentionally not done here. Existing jobs keep
-- service_line_items = NULL and fall back to the single-service
-- render path, which is what they already displayed. Only new jobs
-- (and jobs explicitly resaved via the edit drawer) populate the
-- column.

ALTER TABLE public.jobs
  ADD COLUMN IF NOT EXISTS service_line_items jsonb;

COMMENT ON COLUMN public.jobs.service_line_items IS
  'Per-service line items for multi-service jobs: [{serviceId, name, basePrice}]. Sums to service_price. Modifiers attach via modifier.serviceId. NULL for legacy single-service jobs.';

-- Tell PostgREST about the new column right away so the create
-- endpoint can write to it on the next request.
NOTIFY pgrst, 'reload schema';
