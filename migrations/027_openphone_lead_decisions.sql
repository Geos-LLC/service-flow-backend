-- Observability table for OpenPhone conditional-lead-creation decisions.
-- One row per decision (after shouldOpenPhoneCreateLead runs). Append-only;
-- safe to prune if it grows too large.

CREATE TABLE IF NOT EXISTS communication_openphone_lead_decisions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  identity_id INTEGER,
  outcome VARCHAR NOT NULL,
  reason VARCHAR,
  lead_id INTEGER,
  customer_id INTEGER,
  canonical_source VARCHAR,
  company VARCHAR,
  last_event_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE communication_openphone_lead_decisions
  DROP CONSTRAINT IF EXISTS op_lead_decisions_outcome_check;
ALTER TABLE communication_openphone_lead_decisions
  ADD CONSTRAINT op_lead_decisions_outcome_check CHECK (outcome IN (
    'created_lead_openphone_direct',
    'created_lead_openphone_lb_recovery',
    'linked_existing_customer_by_phone',
    'linked_existing_lead_by_phone',
    'skipped_missing_company',
    'skipped_out_of_age_window',
    'skipped_lb_owned_already_ingested',
    'skipped_identity_has_lead',
    'skipped_identity_has_customer',
    'skipped_aggregator_name',
    'skipped_noise_no_name'
  ));

CREATE INDEX IF NOT EXISTS idx_op_lead_decisions_user_created
  ON communication_openphone_lead_decisions(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_op_lead_decisions_user_outcome_created
  ON communication_openphone_lead_decisions(user_id, outcome, created_at DESC);
