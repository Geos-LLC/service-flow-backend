-- Migration 047 — Combine (merge) RPC functions for the Identity Conflicts UI.
--
-- Per operator request (2026-05-21):
--   "what we need to have - delete button on every card - when we click delete
--    the record is deleted. And 2 options keep separate and combine"
--
-- Delete is handled at the application layer (DELETE on the source table;
-- triggers archive the registry row and auto-resolve the conflict).
--
-- Combine is atomic: every FK reference to the secondary entity must be
-- updated to the primary, then the secondary is deleted. Running this as
-- a single PostgreSQL function keeps it transactional.
--
-- Scope:
--   - pir_combine_customers(workspace, primary, secondary)
--       Migrates every customer FK to the primary, then deletes secondary.
--   - pir_combine_leads(workspace, primary, secondary)
--       Migrates lead FKs (communication_participant_identities.sf_lead_id,
--       lead_tasks.lead_id), then deletes secondary.
--
-- NOT in scope here (must use Delete or Keep separate):
--   - team_member combine — touches cleaner_ledger which is P0 immutable.
--   - user combine — workspace root; cannot merge tenants.

BEGIN;

-- ════════════════════════════════════════════════════════════════════
-- pir_combine_customers
-- ════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION pir_combine_customers(
  p_workspace_id BIGINT,
  p_primary_id   BIGINT,
  p_secondary_id BIGINT
) RETURNS JSONB
LANGUAGE plpgsql AS $$
DECLARE
  v_primary_user_id   BIGINT;
  v_secondary_user_id BIGINT;
  v_jobs_count        INT := 0;
  v_invoices_count    INT := 0;
  v_estimates_count   INT := 0;
  v_transactions_count INT := 0;
  v_properties_count  INT := 0;
  v_other_count       INT := 0;
BEGIN
  IF p_workspace_id IS NULL OR p_primary_id IS NULL OR p_secondary_id IS NULL THEN
    RAISE EXCEPTION 'workspace, primary, and secondary ids are required';
  END IF;
  IF p_primary_id = p_secondary_id THEN
    RAISE EXCEPTION 'primary and secondary cannot be the same id';
  END IF;

  -- Tenant scope check
  SELECT user_id INTO v_primary_user_id   FROM customers WHERE id = p_primary_id;
  SELECT user_id INTO v_secondary_user_id FROM customers WHERE id = p_secondary_id;
  IF v_primary_user_id IS NULL OR v_secondary_user_id IS NULL THEN
    RAISE EXCEPTION 'customer not found';
  END IF;
  IF v_primary_user_id <> p_workspace_id OR v_secondary_user_id <> p_workspace_id THEN
    RAISE EXCEPTION 'cross-tenant combine refused';
  END IF;

  -- Migrate every customer FK on every dependent table.
  UPDATE jobs                              SET customer_id = p_primary_id WHERE customer_id = p_secondary_id;
  GET DIAGNOSTICS v_jobs_count = ROW_COUNT;

  UPDATE invoices                          SET customer_id = p_primary_id WHERE customer_id = p_secondary_id;
  GET DIAGNOSTICS v_invoices_count = ROW_COUNT;

  UPDATE estimates                         SET customer_id = p_primary_id WHERE customer_id = p_secondary_id;
  GET DIAGNOSTICS v_estimates_count = ROW_COUNT;

  UPDATE transactions                      SET customer_id = p_primary_id WHERE customer_id = p_secondary_id;
  GET DIAGNOSTICS v_transactions_count = ROW_COUNT;

  UPDATE customer_properties               SET customer_id = p_primary_id WHERE customer_id = p_secondary_id;
  GET DIAGNOSTICS v_properties_count = ROW_COUNT;

  -- The remaining tables (lower-volume) bundle into one count.
  UPDATE customer_files                    SET customer_id = p_primary_id WHERE customer_id = p_secondary_id;
  UPDATE customer_notifications            SET customer_id = p_primary_id WHERE customer_id = p_secondary_id;
  UPDATE customer_notification_preferences SET customer_id = p_primary_id WHERE customer_id = p_secondary_id;
  UPDATE coupon_usage                      SET customer_id = p_primary_id WHERE customer_id = p_secondary_id;
  UPDATE requests                          SET customer_id = p_primary_id WHERE customer_id = p_secondary_id;
  UPDATE reviews                           SET customer_id = p_primary_id WHERE customer_id = p_secondary_id;
  UPDATE communication_participant_identities
                                           SET sf_customer_id = p_primary_id WHERE sf_customer_id = p_secondary_id;
  UPDATE leads                             SET converted_customer_id = p_primary_id
                                           WHERE converted_customer_id = p_secondary_id;
  v_other_count := 0; -- not individually counted to keep response small

  -- Hand off the fact that secondary's phone, email, address can fill in
  -- blanks on primary (defensive — don't overwrite non-null primary fields).
  UPDATE customers
     SET phone = COALESCE(customers.phone, secondary.phone),
         email = COALESCE(customers.email, secondary.email),
         address = COALESCE(customers.address, secondary.address),
         city = COALESCE(customers.city, secondary.city),
         state = COALESCE(customers.state, secondary.state),
         zip_code = COALESCE(customers.zip_code, secondary.zip_code),
         zenbooker_id = COALESCE(customers.zenbooker_id, secondary.zenbooker_id),
         updated_at = now()
    FROM (SELECT * FROM customers WHERE id = p_secondary_id) AS secondary
   WHERE customers.id = p_primary_id;

  -- Delete the secondary. Trigger pir_customers_sync archives its registry row.
  DELETE FROM customers WHERE id = p_secondary_id;

  RETURN jsonb_build_object(
    'ok', true,
    'primary_id', p_primary_id,
    'secondary_id', p_secondary_id,
    'migrated', jsonb_build_object(
      'jobs',         v_jobs_count,
      'invoices',     v_invoices_count,
      'estimates',    v_estimates_count,
      'transactions', v_transactions_count,
      'properties',   v_properties_count
    )
  );
END;
$$;

-- ════════════════════════════════════════════════════════════════════
-- pir_combine_leads
-- ════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION pir_combine_leads(
  p_workspace_id BIGINT,
  p_primary_id   BIGINT,
  p_secondary_id BIGINT
) RETURNS JSONB
LANGUAGE plpgsql AS $$
DECLARE
  v_primary_user_id   BIGINT;
  v_secondary_user_id BIGINT;
  v_tasks_count       INT := 0;
BEGIN
  IF p_workspace_id IS NULL OR p_primary_id IS NULL OR p_secondary_id IS NULL THEN
    RAISE EXCEPTION 'workspace, primary, and secondary ids are required';
  END IF;
  IF p_primary_id = p_secondary_id THEN
    RAISE EXCEPTION 'primary and secondary cannot be the same id';
  END IF;

  SELECT user_id INTO v_primary_user_id   FROM leads WHERE id = p_primary_id;
  SELECT user_id INTO v_secondary_user_id FROM leads WHERE id = p_secondary_id;
  IF v_primary_user_id IS NULL OR v_secondary_user_id IS NULL THEN
    RAISE EXCEPTION 'lead not found';
  END IF;
  IF v_primary_user_id <> p_workspace_id OR v_secondary_user_id <> p_workspace_id THEN
    RAISE EXCEPTION 'cross-tenant combine refused';
  END IF;

  UPDATE lead_tasks SET lead_id = p_primary_id WHERE lead_id = p_secondary_id;
  GET DIAGNOSTICS v_tasks_count = ROW_COUNT;

  UPDATE communication_participant_identities
     SET sf_lead_id = p_primary_id
   WHERE sf_lead_id = p_secondary_id;

  -- Fill missing fields on primary from secondary (defensive).
  UPDATE leads
     SET phone = COALESCE(leads.phone, secondary.phone),
         email = COALESCE(leads.email, secondary.email),
         source = COALESCE(leads.source, secondary.source),
         updated_at = now()
    FROM (SELECT * FROM leads WHERE id = p_secondary_id) AS secondary
   WHERE leads.id = p_primary_id;

  DELETE FROM leads WHERE id = p_secondary_id;

  RETURN jsonb_build_object(
    'ok', true,
    'primary_id', p_primary_id,
    'secondary_id', p_secondary_id,
    'migrated', jsonb_build_object('tasks', v_tasks_count)
  );
END;
$$;

COMMIT;
