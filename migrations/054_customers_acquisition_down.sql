-- Rollback for 054. Drop the index first, then the columns.

DROP INDEX IF EXISTS public.idx_customers_acquisition;

ALTER TABLE public.customers
  DROP COLUMN IF EXISTS acquisition_at,
  DROP COLUMN IF EXISTS acquisition_external_request_id,
  DROP COLUMN IF EXISTS acquisition_business_id,
  DROP COLUMN IF EXISTS acquisition_channel,
  DROP COLUMN IF EXISTS acquisition_source;
