-- Phase 0 — Identity link audit table + hydration provenance column
--
-- Two additive observability artefacts:
--   1. identity_link_audit table — forensic trail for every projection
--      write of leads.converted_customer_id. Required for invariant I5
--      (reversibility) and for the operator rollback recipe in
--      docs/operations/identity-reconciliation-runbook.md.
--   2. communication_participant_identities.last_hydrated_by column —
--      observational provenance on the identity row itself, recording
--      the most recent cause of its CRM linkage state. Fill-null safe;
--      observational only (NOT authoritative — the authoritative
--      provenance is the audit table, which keeps history; this column
--      retains only the latest cause). For debugging, rollback analysis,
--      and future ML-assisted reconciliation.
--
-- Non-destructive; additive only. Down migration in 048_identity_link_audit_down.sql.

-- ── 1. identity_link_audit ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.identity_link_audit (
  id              BIGSERIAL PRIMARY KEY,
  user_id         INTEGER     NOT NULL REFERENCES public.users(id),
  lead_id         INTEGER     NOT NULL,
  customer_id     INTEGER     NOT NULL,
  identity_id     INTEGER     NULL,                   -- nullable for retroactive rows where identity graph wasn't involved

  -- Provenance (closed set; see lib/identity-linker.js)
  --   graph_projection           — graph projection cascade (setter triggered projection)
  --   fallback_projection_bridge — @transitional scoring fallback bridged the gap
  --   operator_override          — applyLeadCustomerLink called from UI
  --   retroactive_repair         — /repair-lead-links apply mode
  --   ambiguity_resolution       — operator resolved an ambiguity row
  --   source_projection          — projection layer reacted to identity row change
  --   automatic                  — legacy (pre-hybrid); equivalent to graph_projection
  resolved_by         VARCHAR  NOT NULL,
  resolution_reason   VARCHAR  NOT NULL,

  -- Optional match context (populated for retroactive sweeps + fallback; null for live graph)
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

COMMENT ON COLUMN public.identity_link_audit.resolved_by IS
  'closed set: graph_projection | fallback_projection_bridge | operator_override | retroactive_repair | ambiguity_resolution | source_projection | automatic (legacy alias for graph_projection). Enforced at write-time, not via CHECK constraint, so future taxonomy additions don''t require DDL.';

-- ── 2. communication_participant_identities.last_hydrated_by ──────────────

-- Observational-only provenance metadata. NULL on existing rows; populated
-- by the linker when:
--   - setIdentityCustomer / setIdentityLead write the identity row
--   - projectIdentityToCRM completes successfully (graph_projection cascade)
--   - attemptScoringFallback hydrates the identity row (fallback_projection_bridge)
--   - applyLeadCustomerLink applies an operator-initiated link (operator_override)
--
-- IMPORTANT (invariant): this column is observational. The authoritative
-- provenance log is identity_link_audit (which keeps history). Code MUST
-- NOT branch on the value of last_hydrated_by — it's for humans + future
-- analytics only.

ALTER TABLE public.communication_participant_identities
  ADD COLUMN IF NOT EXISTS last_hydrated_by VARCHAR NULL;

COMMENT ON COLUMN public.communication_participant_identities.last_hydrated_by IS
  'Observational provenance of the most recent CRM-linkage state change. Closed set: graph_projection | fallback_projection_bridge | operator_override | retroactive_repair | ambiguity_resolution | source_projection. Fill-null safe; NULL on rows that haven''t been hydrated since the column was added. Code MUST NOT branch on this value (authoritative log is identity_link_audit).';

-- Partial index for "find rows hydrated by fallback" queries (operator's
-- graph-completeness investigations).
CREATE INDEX IF NOT EXISTS idx_identities_last_hydrated_by
  ON public.communication_participant_identities (user_id, last_hydrated_by)
  WHERE last_hydrated_by IS NOT NULL;
