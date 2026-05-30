-- Historical lead link — schema additions for LB-initiated retroactive
-- linking of existing SF jobs/customers to LB leads.
--
-- Context:
--   SF jobs.lb_external_request_id is the platform-side id (Thumbtack
--   request id / Yelp lead id). LB's own primary key is a separate UUID
--   like `65d7a387-aa7b-45fc-b9a2-1f36bf92c7ec`. To let LB drive
--   outbound webhooks back to its own row, SF needs to store that UUID
--   too. Adding the column on both jobs and customers because LB may
--   link at either level (a job has a customer; a customer may have
--   many later follow-up jobs, but the link is captured on whichever
--   row LB attaches to).
--
-- New table:
--   lb_link_audit — every attach/overwrite/detach action LB performs
--   gets one row. Captures actor + match confidence + signals +
--   pre-state snapshot so retroactive overwrites are auditable.
--
-- Additive only. Existing rows default to NULL. No data backfill in
-- this migration — backfill is operator-driven via the new
-- /orchestration/attach-lb-link endpoint or a separate dry-run script.

ALTER TABLE public.jobs
  ADD COLUMN IF NOT EXISTS lb_lead_id TEXT;

ALTER TABLE public.customers
  ADD COLUMN IF NOT EXISTS lb_lead_id TEXT;

-- Indexes scope to non-null only — most rows won't have a value.
CREATE INDEX IF NOT EXISTS idx_jobs_lb_lead_id
  ON public.jobs (user_id, lb_lead_id)
  WHERE lb_lead_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_customers_lb_lead_id
  ON public.customers (user_id, lb_lead_id)
  WHERE lb_lead_id IS NOT NULL;

COMMENT ON COLUMN public.jobs.lb_lead_id IS
  'LB primary-key UUID (e.g. 65d7a387-…). Set when LB attaches a historical lead to an existing SF job via /orchestration/attach-lb-link. NULL means SF was the originator or the job predates LB linkage.';

COMMENT ON COLUMN public.customers.lb_lead_id IS
  'LB primary-key UUID propagated to the customer when its job is attached. Same lead can produce multiple SF jobs over time; this stores the FIRST LB lead that introduced the customer.';

-- Audit trail for every LB → SF attach action. Append-only.
CREATE TABLE IF NOT EXISTS public.lb_link_audit (
  id                      BIGSERIAL    PRIMARY KEY,
  user_id                 INTEGER      NOT NULL,
  actor                   TEXT         NOT NULL,           -- 'lb' | 'sf_user' | 'system'
  action                  TEXT         NOT NULL,           -- 'attach' | 'overwrite' | 'detach'
  sf_job_id               BIGINT,
  sf_customer_id          BIGINT,
  lb_external_request_id  TEXT,
  lb_lead_id              TEXT,
  lb_channel              TEXT,
  lb_business_id          TEXT,
  match_confidence        TEXT,                            -- 'exact' | 'high' | 'medium' | 'low'
  match_signals           JSONB,                           -- ['phone_exact:…2443', 'name_exact', …]
  previous_state          JSONB,                           -- snapshot of LB columns before the action
  applied_at              TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_lb_link_audit_user_applied
  ON public.lb_link_audit (user_id, applied_at DESC);

CREATE INDEX IF NOT EXISTS idx_lb_link_audit_sf_job
  ON public.lb_link_audit (sf_job_id)
  WHERE sf_job_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_lb_link_audit_lb_lead
  ON public.lb_link_audit (lb_lead_id)
  WHERE lb_lead_id IS NOT NULL;

COMMENT ON TABLE public.lb_link_audit IS
  'Append-only audit of LB→SF attach actions. Every call to /orchestration/attach-lb-link writes one row before the jobs/customers UPDATE commits. previous_state captures the LB-column values before the change so overwrites are recoverable.';
