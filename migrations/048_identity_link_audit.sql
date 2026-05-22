-- Phase 0 — Identity link audit table
--
-- Forensic trail for every projection write of leads.converted_customer_id.
-- Required for invariant I5 (reversibility) and for the operator rollback
-- recipe in docs/operations/identity-reconciliation-runbook.md.
--
-- Non-destructive; additive only. Down migration in 048_identity_link_audit_down.sql.

CREATE TABLE IF NOT EXISTS public.identity_link_audit (
  id              BIGSERIAL PRIMARY KEY,
  user_id         INTEGER     NOT NULL REFERENCES public.users(id),
  lead_id         INTEGER     NOT NULL,
  customer_id     INTEGER     NOT NULL,
  identity_id     INTEGER     NULL,                   -- nullable for retroactive rows where identity graph wasn't involved

  -- Provenance (per operator request 2026-05-21)
  --   automatic            — projection fired from live ingest (LB/ZB/OP)
  --   operator_override    — applyLeadCustomerLink called from UI
  --   retroactive_repair   — /repair-lead-links apply mode
  --   ambiguity_resolution — operator resolved an ambiguity row
  --   source_projection    — projection layer reacted to identity row change
  resolved_by         VARCHAR  NOT NULL,
  resolution_reason   VARCHAR  NOT NULL,

  -- Optional match context (populated for retroactive sweeps; null for live)
  name_class      VARCHAR     NULL,                   -- strong_exact|strong_tokenset|strong_leven|weak_*|conflict|one_missing|neither_named
  phone_match     BOOLEAN     NULL,
  source_compat   BOOLEAN     NULL,
  notes           TEXT        NULL,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- One (lead, customer) pair can only be audited once per resolver run; second
  -- writes hit ON CONFLICT DO NOTHING.
  CONSTRAINT uq_identity_link_audit_pair UNIQUE (lead_id, customer_id)
);

CREATE INDEX IF NOT EXISTS idx_identity_link_audit_user_created
  ON public.identity_link_audit (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_identity_link_audit_identity
  ON public.identity_link_audit (identity_id)
  WHERE identity_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_identity_link_audit_lead
  ON public.identity_link_audit (lead_id);

-- Allowed values for resolved_by (enforced at write-time, not via CHECK
-- constraint, so future taxonomy additions don't require DDL).
COMMENT ON COLUMN public.identity_link_audit.resolved_by IS
  'one of: automatic | operator_override | retroactive_repair | ambiguity_resolution | source_projection';
