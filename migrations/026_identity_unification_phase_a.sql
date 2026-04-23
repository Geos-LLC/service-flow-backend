-- Phase A — Identity unification foundation
-- Non-destructive; additive only. Reversible via 026_identity_unification_phase_a_down.sql.

-- 1. Enable fuzzystrmatch for Levenshtein distance (used by resolver Step 2/3 similarity).
CREATE EXTENSION IF NOT EXISTS fuzzystrmatch;

-- 2. Extend communication_participant_identities with new external-ID columns + normalized fields + status.
ALTER TABLE communication_participant_identities
  ADD COLUMN IF NOT EXISTS zenbooker_customer_id VARCHAR,
  ADD COLUMN IF NOT EXISTS sigcore_participant_id TEXT,
  ADD COLUMN IF NOT EXISTS sigcore_participant_key TEXT,
  ADD COLUMN IF NOT EXISTS normalized_name VARCHAR,
  ADD COLUMN IF NOT EXISTS name_token_set VARCHAR,
  ADD COLUMN IF NOT EXISTS status VARCHAR,
  ADD COLUMN IF NOT EXISTS identity_priority_source VARCHAR;

-- Status domain:
--   resolved_customer | resolved_lead | resolved_both | unresolved_floating | ambiguous
-- identity_priority_source:
--   leadbridge | openphone | manual | sync
ALTER TABLE communication_participant_identities
  DROP CONSTRAINT IF EXISTS cpi_status_check;
ALTER TABLE communication_participant_identities
  ADD CONSTRAINT cpi_status_check CHECK (
    status IS NULL OR status IN ('resolved_customer', 'resolved_lead', 'resolved_both', 'unresolved_floating', 'ambiguous')
  );

ALTER TABLE communication_participant_identities
  DROP CONSTRAINT IF EXISTS cpi_priority_source_check;
ALTER TABLE communication_participant_identities
  ADD CONSTRAINT cpi_priority_source_check CHECK (
    identity_priority_source IS NULL OR identity_priority_source IN ('leadbridge', 'openphone', 'manual', 'sync')
  );

-- 3. Partial unique indexes per external-ID column (scoped to user_id).
CREATE UNIQUE INDEX IF NOT EXISTS idx_identity_leadbridge
  ON communication_participant_identities(user_id, leadbridge_contact_id)
  WHERE leadbridge_contact_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_identity_openphone
  ON communication_participant_identities(user_id, openphone_contact_id)
  WHERE openphone_contact_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_identity_sigcore_id
  ON communication_participant_identities(user_id, sigcore_participant_id)
  WHERE sigcore_participant_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_identity_sigcore_key
  ON communication_participant_identities(user_id, sigcore_participant_key)
  WHERE sigcore_participant_key IS NOT NULL AND sigcore_participant_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_identity_zenbooker
  ON communication_participant_identities(user_id, zenbooker_customer_id)
  WHERE zenbooker_customer_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_identity_thumbtack
  ON communication_participant_identities(user_id, thumbtack_profile_id)
  WHERE thumbtack_profile_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_identity_yelp
  ON communication_participant_identities(user_id, yelp_profile_id)
  WHERE yelp_profile_id IS NOT NULL;

-- 4. Composite index for Step 2 (phone + normalized name) matching.
CREATE INDEX IF NOT EXISTS idx_identity_phone_name
  ON communication_participant_identities(user_id, normalized_phone, normalized_name)
  WHERE normalized_phone IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_identity_phone_tokenset
  ON communication_participant_identities(user_id, normalized_phone, name_token_set)
  WHERE normalized_phone IS NOT NULL;

-- 5. Ambiguity log table.
CREATE TABLE IF NOT EXISTS communication_identity_ambiguities (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  source VARCHAR NOT NULL,
  attempted_external_id VARCHAR,
  attempted_phone VARCHAR,
  attempted_name VARCHAR,
  attempted_normalized_name VARCHAR,
  candidate_identity_ids INTEGER[] NOT NULL DEFAULT '{}',
  reason VARCHAR NOT NULL,
  status VARCHAR NOT NULL DEFAULT 'open',
  source_payload JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ,
  resolved_by INTEGER,
  resolved_identity_id INTEGER
);

ALTER TABLE communication_identity_ambiguities
  DROP CONSTRAINT IF EXISTS cia_status_check;
ALTER TABLE communication_identity_ambiguities
  ADD CONSTRAINT cia_status_check CHECK (status IN ('open', 'auto_merged_weak', 'resolved', 'abandoned'));

CREATE INDEX IF NOT EXISTS idx_cia_user_status
  ON communication_identity_ambiguities(user_id, status);

CREATE INDEX IF NOT EXISTS idx_cia_user_source_created
  ON communication_identity_ambiguities(user_id, source, created_at DESC);

-- 6. communication_participant_mappings.identity_id FK (Sigcore index → identity).
ALTER TABLE communication_participant_mappings
  ADD COLUMN IF NOT EXISTS identity_id INTEGER;

ALTER TABLE communication_participant_mappings
  DROP CONSTRAINT IF EXISTS cpm_identity_fk;
ALTER TABLE communication_participant_mappings
  ADD CONSTRAINT cpm_identity_fk FOREIGN KEY (identity_id)
    REFERENCES communication_participant_identities(id)
    ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_cpm_identity_id
  ON communication_participant_mappings(identity_id)
  WHERE identity_id IS NOT NULL;

-- 7. Normalized name columns on CRM entities (for resolver lookups via sf_lead_id / sf_customer_id).
ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS normalized_name VARCHAR,
  ADD COLUMN IF NOT EXISTS name_token_set VARCHAR;

ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS normalized_name VARCHAR,
  ADD COLUMN IF NOT EXISTS name_token_set VARCHAR;

CREATE INDEX IF NOT EXISTS idx_leads_user_normalized_name
  ON leads(user_id, normalized_name)
  WHERE normalized_name IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_customers_user_normalized_name
  ON customers(user_id, normalized_name)
  WHERE normalized_name IS NOT NULL;

-- 8. Reporting view — "true" floating identities exclude sync-only (point 5 of v4).
CREATE OR REPLACE VIEW v_identity_floating_true AS
SELECT *
FROM communication_participant_identities
WHERE status = 'unresolved_floating'
  AND (identity_priority_source IS DISTINCT FROM 'sync');
