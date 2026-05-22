-- Phase 0.5 — Lead cardinality / acquisition-event preservation
--
-- Approved 2026-05-21. Companion to:
--   docs/architecture/lead-cardinality-and-parent-lead-id.md
--   docs/architecture/cross-source-identity-reconciliation.md
--   docs/operations/identity-reconciliation-runbook.md
--
-- Adds:
--   1. leads.parent_lead_id      — same-tenant FK; canonical (parent_lead_id IS NULL)
--                                   owns pipeline lifecycle; children are acquisition
--                                   events with their own source/cost/created_at.
--   2. leads.lead_origin_type    — first_touch | repeat_acquisition | reactivation.
--                                   Reactivation = new canonical for an identity that
--                                   already has sf_customer_id (returning customer
--                                   submits new acquisition). Distinguished in
--                                   analytics so CAC history is accurate.
--   3. leads.canonical_lead_id   — generated stored column = COALESCE(parent_lead_id, id).
--                                   The wrapper for grouping; avoids COALESCE
--                                   sprinkled across every report. Indexed.
--   4. supporting indices for per-tenant canonical grouping + children lookup.
--
-- All additive. No retroactive grouping; historical rows: parent_lead_id IS NULL,
-- lead_origin_type IS NULL (treated as first_touch by analytics).
-- Rollback: 049_lead_parent_lead_id_down.sql.

-- ── 1. parent_lead_id ─────────────────────────────────────────────────────
ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS parent_lead_id INTEGER
    REFERENCES public.leads(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.leads.parent_lead_id IS
  'When set, this lead is a child acquisition event of leads.id=parent_lead_id. Pipeline lifecycle lives on the canonical (parent_lead_id IS NULL). Children preserve their own source / lead_cost / created_at / attribution. Same-tenant constraint enforced in application code (lib/lb-ingestion.assertCreateChildLeadInvariant). ON DELETE SET NULL keeps acquisition records when canonical is deleted.';

-- ── 2. lead_origin_type ───────────────────────────────────────────────────
ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS lead_origin_type VARCHAR;

ALTER TABLE public.leads
  DROP CONSTRAINT IF EXISTS leads_lead_origin_type_check;
ALTER TABLE public.leads
  ADD CONSTRAINT leads_lead_origin_type_check CHECK (
    lead_origin_type IS NULL OR lead_origin_type IN ('first_touch', 'repeat_acquisition', 'reactivation')
  );

COMMENT ON COLUMN public.leads.lead_origin_type IS
  'Acquisition provenance tag, written by LB ingest at creation. first_touch = no prior LB/customer history for this person; repeat_acquisition = child lead (parent_lead_id IS NOT NULL); reactivation = new canonical lead for an existing customer (identity.sf_customer_id was already set). NULL on historical rows pre-Phase-0.5 (treated as first_touch by analytics).';

-- ── 3. canonical_lead_id generated column ─────────────────────────────────
-- Postgres 12+ stored generated column. Equivalent to COALESCE(parent_lead_id, id)
-- but queryable as a real column. Auto-maintained; cannot be UPDATEd directly.
ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS canonical_lead_id INTEGER
    GENERATED ALWAYS AS (COALESCE(parent_lead_id, id)) STORED;

COMMENT ON COLUMN public.leads.canonical_lead_id IS
  'Generated: COALESCE(parent_lead_id, id). The canonical lead for this row (itself if canonical, else its parent). Use this for GROUP BY in person-level aggregation instead of writing COALESCE in every query.';

-- ── 4. Indices ────────────────────────────────────────────────────────────
-- Per-tenant person-level aggregation drive (analytics, lead list grouping).
CREATE INDEX IF NOT EXISTS idx_leads_user_canonical
  ON public.leads(user_id, canonical_lead_id);

-- Direct children lookup for detail panel.
CREATE INDEX IF NOT EXISTS idx_leads_parent
  ON public.leads(parent_lead_id)
  WHERE parent_lead_id IS NOT NULL;

-- Pipeline endpoint efficiency (excludes children).
CREATE INDEX IF NOT EXISTS idx_leads_user_canonical_pipeline
  ON public.leads(user_id, stage_id)
  WHERE parent_lead_id IS NULL;
