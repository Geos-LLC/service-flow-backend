-- Reverse of 065_account_layer.sql. Drops columns + indexes + tables.
--
-- Safe to run only if no production code references the new columns yet
-- (Phase A is plumbing only — this should be true unless PR C has been
-- merged and backfilled). Cascade delete on account_identifiers handles
-- the FK cleanly.

DROP INDEX IF EXISTS public.uq_customers_account_id;
ALTER TABLE public.customers
  DROP COLUMN IF EXISTS account_id;

DROP INDEX IF EXISTS public.idx_leads_account_id;
ALTER TABLE public.leads
  DROP COLUMN IF EXISTS account_id;

DROP INDEX IF EXISTS public.idx_account_identifiers_value;
DROP INDEX IF EXISTS public.idx_account_identifiers_account;
DROP INDEX IF EXISTS public.uq_account_identifiers_active;
DROP TABLE  IF EXISTS public.account_identifiers;

DROP INDEX IF EXISTS public.idx_accounts_tenant_first_seen;
DROP INDEX IF EXISTS public.idx_accounts_tenant_lifecycle;
DROP TABLE  IF EXISTS public.accounts;
