-- Thin Account Layer — Phase A: schema only, no behavior change.
--
-- Adds a hidden identity layer above SF Leads, SF Customers, and LB Leads.
--
-- Account model (kept deliberately minimal):
--   - One Account per real-world economic actor (person / household /
--     commercial / property manager / intermediary).
--   - Many LB inquiries (`Lead` in LB Prisma) per Account.
--   - Many SF leads (`public.leads`) per Account.
--   - Up to one SF Customer (`public.customers`) per Account.
--   - Jobs are reached via Customer; `public.jobs` does NOT get a
--     direct account_id column. Service addresses stay on Job.
--
-- Why no menu / detail page / property table yet:
--   This migration is plumbing only. UI surfaces, account dashboards,
--   merge tooling, and a first-class property table are out of scope.
--
-- All additions are nullable + idempotent. Existing read/write paths
-- against leads/customers/jobs are unaffected by this migration.
--
-- Companion changes:
--   - LB Prisma `Lead.accountId` (this same PR, separate repo)
--   - PR B (read-only backfill report)
--   - PR C (apply backfill behind explicit approval)
--   - PR D (use account_id for the 59 residual cleanup)
--
-- Rollback: 065_account_layer_down.sql.

-- ════════════════════════════════════════════════════════════════════
-- Table: accounts
--   The parent identity row. One per real-world actor.
-- ════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.accounts (
  id                  UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           INTEGER      NOT NULL,
  display_name        TEXT         NOT NULL,
  type                TEXT         NOT NULL DEFAULT 'individual',
  lifecycle_state     TEXT         NOT NULL DEFAULT 'lead',
  primary_phone       TEXT,
  primary_email       TEXT,
  first_seen_at       TIMESTAMPTZ,
  became_customer_at  TIMESTAMPTZ,
  metadata            JSONB        NOT NULL DEFAULT '{}'::jsonb,
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.accounts IS
  'Thin Account layer — parent identity over SF leads/customers and LB inquiries. Customer concept and Customers menu remain authoritative for billing/lifecycle; this table is hidden plumbing for repeat-inquiry, duplicate, and reconciliation handling.';

COMMENT ON COLUMN public.accounts.type IS
  'individual | household | commercial | property_manager | intermediary. Defaults to individual on backfill; refinable later. No UI surfaces this today.';

COMMENT ON COLUMN public.accounts.lifecycle_state IS
  'lead | prospect | customer | inactive | churned. Set to ''customer'' when the Account has at least one SF Customer.';

COMMENT ON COLUMN public.accounts.metadata IS
  'Freeform per-Account metadata bag. Reserved for ops notes, future Account-type-specific fields. Not read by any code yet.';

CREATE INDEX IF NOT EXISTS idx_accounts_tenant_lifecycle
  ON public.accounts(tenant_id, lifecycle_state);

CREATE INDEX IF NOT EXISTS idx_accounts_tenant_first_seen
  ON public.accounts(tenant_id, first_seen_at);


-- ════════════════════════════════════════════════════════════════════
-- Table: account_identifiers
--   The identity-resolution layer. Many identifiers per Account.
--   Unique active identifier per (tenant_id, type, value) ensures two
--   Accounts can't simultaneously claim the same identifier.
-- ════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.account_identifiers (
  id                  UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id          UUID         NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  tenant_id           INTEGER      NOT NULL,
  identifier_type     TEXT         NOT NULL,
  identifier_value    TEXT         NOT NULL,
  identifier_source   TEXT,
  confidence          TEXT         NOT NULL DEFAULT 'high',
  is_active           BOOLEAN      NOT NULL DEFAULT TRUE,
  first_seen_at       TIMESTAMPTZ,
  last_seen_at        TIMESTAMPTZ,
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.account_identifiers IS
  'Per-Account identifiers used for identity resolution. One Account can have many active identifiers (phone changes, multiple emails, Yelp proxy churn, externalRequestIds from each marketplace inquiry). The unique-active index below prevents two Accounts owning the same identifier at the same time.';

COMMENT ON COLUMN public.account_identifiers.identifier_type IS
  'phone | email | external_request_id | yelp_proxy_email | thumbtack_handle | manual. Open enum — code can introduce new types without schema change.';

COMMENT ON COLUMN public.account_identifiers.identifier_value IS
  'Normalized identifier value: phone10 (last 10 digits), lowercased email, raw externalRequestId. Normalization is the responsibility of the writer; reads/joins assume normalized form.';

COMMENT ON COLUMN public.account_identifiers.identifier_source IS
  'lb_inquiry | sf_lead | sf_customer | manual. Where the identifier was first observed. Informational.';

COMMENT ON COLUMN public.account_identifiers.confidence IS
  'exact | high | medium | low. exact = LB externalRequestId already on SF lead/job. high = phone or email match. medium/low reserved for fuzzy strategies.';

COMMENT ON COLUMN public.account_identifiers.is_active IS
  'FALSE when an identifier has been retired (e.g. customer changed phones, Yelp proxy expired). Soft-delete so historical lookups still work.';

-- Unique active identifier per tenant. Two Accounts can never own the same
-- active (type, value) for the same tenant. Inactive rows don't participate.
CREATE UNIQUE INDEX IF NOT EXISTS uq_account_identifiers_active
  ON public.account_identifiers(tenant_id, identifier_type, identifier_value)
  WHERE is_active = TRUE;

-- Reverse lookup: all identifiers for an Account.
CREATE INDEX IF NOT EXISTS idx_account_identifiers_account
  ON public.account_identifiers(account_id);

-- Resolver hot path: identifier_value lookup (covers all types).
CREATE INDEX IF NOT EXISTS idx_account_identifiers_value
  ON public.account_identifiers(identifier_value, identifier_type)
  WHERE is_active = TRUE;


-- ════════════════════════════════════════════════════════════════════
-- Additive FKs on existing tables.
--   - All nullable; no NOT NULL enforcement until a future hardening PR.
--   - No FK constraints to public.accounts(id) yet so the rollout can
--     stage backfill without DELETE-cascade surprises.
--   - Indexes added for the read paths PR D will use.
-- ════════════════════════════════════════════════════════════════════

ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS account_id UUID;

COMMENT ON COLUMN public.leads.account_id IS
  'FK to public.accounts(id). Populated by backfill (PR C) and ingestion (future PR). NULL until backfill runs. Indexed but not constrained — Phase A is additive only.';

CREATE INDEX IF NOT EXISTS idx_leads_account_id
  ON public.leads(account_id)
  WHERE account_id IS NOT NULL;


ALTER TABLE public.customers
  ADD COLUMN IF NOT EXISTS account_id UUID;

COMMENT ON COLUMN public.customers.account_id IS
  'FK to public.accounts(id). 1:1 — one Customer maps to exactly one Account. Unique constraint enforced via the partial unique index below. NULL until backfill runs. Phase A does not change any customer workflows.';

-- Unique on non-null only — allows existing rows with NULL during backfill.
CREATE UNIQUE INDEX IF NOT EXISTS uq_customers_account_id
  ON public.customers(account_id)
  WHERE account_id IS NOT NULL;
