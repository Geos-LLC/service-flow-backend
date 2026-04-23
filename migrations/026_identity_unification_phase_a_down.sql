-- Rollback of 026_identity_unification_phase_a.sql. Reversible; no data loss if Phase A columns are empty.

DROP VIEW IF EXISTS v_identity_floating_true;

DROP INDEX IF EXISTS idx_customers_user_normalized_name;
DROP INDEX IF EXISTS idx_leads_user_normalized_name;

ALTER TABLE customers
  DROP COLUMN IF EXISTS name_token_set,
  DROP COLUMN IF EXISTS normalized_name;

ALTER TABLE leads
  DROP COLUMN IF EXISTS name_token_set,
  DROP COLUMN IF EXISTS normalized_name;

DROP INDEX IF EXISTS idx_cpm_identity_id;
ALTER TABLE communication_participant_mappings
  DROP CONSTRAINT IF EXISTS cpm_identity_fk,
  DROP COLUMN IF EXISTS identity_id;

DROP INDEX IF EXISTS idx_cia_user_source_created;
DROP INDEX IF EXISTS idx_cia_user_status;
DROP TABLE IF EXISTS communication_identity_ambiguities;

DROP INDEX IF EXISTS idx_identity_phone_tokenset;
DROP INDEX IF EXISTS idx_identity_phone_name;
DROP INDEX IF EXISTS idx_identity_yelp;
DROP INDEX IF EXISTS idx_identity_thumbtack;
DROP INDEX IF EXISTS idx_identity_zenbooker;
DROP INDEX IF EXISTS idx_identity_sigcore_key;
DROP INDEX IF EXISTS idx_identity_sigcore_id;
DROP INDEX IF EXISTS idx_identity_openphone;
DROP INDEX IF EXISTS idx_identity_leadbridge;

ALTER TABLE communication_participant_identities
  DROP CONSTRAINT IF EXISTS cpi_priority_source_check,
  DROP CONSTRAINT IF EXISTS cpi_status_check,
  DROP COLUMN IF EXISTS identity_priority_source,
  DROP COLUMN IF EXISTS status,
  DROP COLUMN IF EXISTS name_token_set,
  DROP COLUMN IF EXISTS normalized_name,
  DROP COLUMN IF EXISTS sigcore_participant_key,
  DROP COLUMN IF EXISTS sigcore_participant_id,
  DROP COLUMN IF EXISTS zenbooker_customer_id;
