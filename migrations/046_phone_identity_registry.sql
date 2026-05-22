-- Migration 046 — Phone Identity Registry + Collision Detector (P0.1)
--
-- Surfaces and prevents cross-role phone collisions BEFORE they manifest
-- as downstream SMS misrouting. Triggered by P0 audit (2026-05-20) which
-- found that `customers.phone` and `team_members.phone` can share values
-- within a tenant — making it ambiguous which human a customer-facing
-- SMS reaches.
--
-- Design:
--   1. `phone_identity_registry` — canonical (workspace, phone, entity) rows.
--   2. `identity_conflicts` — collision rows for operator triage (one open
--      per workspace+phone at a time; resolved/ignored history retained).
--   3. Trigger functions on customers/team_members/leads/users replicate
--      every phone INSERT/UPDATE/DELETE into the registry and re-evaluate
--      collisions atomically.
--   4. Backfill seeds the registry from existing data and detects all
--      pre-existing conflicts on first run.
--
-- See:
--   docs/operations/recipient_source_map.md
--   docs/operations/sms-trace-142215.md
--   lib/sms-recipient-integrity.js (STRICT mode SMS guard — this migration
--     is the proactive layer)

BEGIN;

-- ════════════════════════════════════════════════════════════════════
-- 1. Tables
-- ════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS phone_identity_registry (
  id               BIGSERIAL PRIMARY KEY,
  phone            TEXT NOT NULL,
  normalized_phone TEXT NOT NULL,
  workspace_id     BIGINT NOT NULL,
  entity_type      TEXT NOT NULL
                     CHECK (entity_type IN ('customer','team_member','user','lead','conversation','external')),
  entity_id        TEXT NOT NULL,
  confidence       TEXT NOT NULL DEFAULT 'exact'
                     CHECK (confidence IN ('exact','probable','inferred')),
  source           TEXT NOT NULL DEFAULT 'sync',
  status           TEXT NOT NULL DEFAULT 'active'
                     CHECK (status IN ('active','merged','conflict','archived')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, entity_type, entity_id)
);

CREATE INDEX IF NOT EXISTS pir_workspace_normalized_active_idx
  ON phone_identity_registry(workspace_id, normalized_phone)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS pir_normalized_global_idx
  ON phone_identity_registry(normalized_phone)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS pir_workspace_status_idx
  ON phone_identity_registry(workspace_id, status);

CREATE TABLE IF NOT EXISTS identity_conflicts (
  id               BIGSERIAL PRIMARY KEY,
  workspace_id     BIGINT NOT NULL,
  normalized_phone TEXT NOT NULL,
  severity         TEXT NOT NULL
                     CHECK (severity IN ('same_role_duplicate','cross_role_duplicate','cross_tenant_duplicate')),
  owners           JSONB NOT NULL,
  status           TEXT NOT NULL DEFAULT 'open'
                     CHECK (status IN ('open','resolved','ignored')),
  resolution       TEXT
                     CHECK (resolution IN ('merge','keep_separate','ignore','change_owner')),
  resolved_by      BIGINT,
  resolved_at      TIMESTAMPTZ,
  resolution_note  TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS identity_conflicts_open_unique_idx
  ON identity_conflicts(workspace_id, normalized_phone)
  WHERE status = 'open';

CREATE INDEX IF NOT EXISTS identity_conflicts_status_idx
  ON identity_conflicts(workspace_id, status);

CREATE INDEX IF NOT EXISTS identity_conflicts_normalized_idx
  ON identity_conflicts(normalized_phone);

-- ════════════════════════════════════════════════════════════════════
-- 2. Helper functions
-- ════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION pir_normalize_phone(p TEXT) RETURNS TEXT
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  digits TEXT;
BEGIN
  IF p IS NULL OR p = '' THEN RETURN NULL; END IF;
  digits := regexp_replace(p, '\D', '', 'g');
  IF digits = '' THEN RETURN NULL; END IF;
  IF length(digits) >= 10 THEN
    RETURN right(digits, 10);
  END IF;
  RETURN digits;
END;
$$;

-- Core: upsert a (workspace, entity_type, entity_id, phone) row into the
-- registry, then evaluate collisions and update identity_conflicts.
-- Idempotent. NEVER raises (errors are absorbed by caller / trigger).
CREATE OR REPLACE FUNCTION pir_upsert_and_detect(
  p_workspace_id BIGINT,
  p_entity_type  TEXT,
  p_entity_id    TEXT,
  p_phone        TEXT,
  p_source       TEXT DEFAULT 'sync'
) RETURNS VOID
LANGUAGE plpgsql AS $$
DECLARE
  v_normalized      TEXT;
  v_owners          JSONB;
  v_row_count       INT;
  v_distinct_types  INT;
  v_severity        TEXT;
BEGIN
  IF p_workspace_id IS NULL OR p_entity_type IS NULL OR p_entity_id IS NULL THEN
    RETURN;
  END IF;

  v_normalized := pir_normalize_phone(p_phone);

  -- Phone cleared / unparseable → archive any prior active row for this entity.
  IF v_normalized IS NULL THEN
    UPDATE phone_identity_registry
       SET status='archived', updated_at=now()
     WHERE workspace_id=p_workspace_id
       AND entity_type=p_entity_type
       AND entity_id=p_entity_id
       AND status='active';
    RETURN;
  END IF;

  -- Upsert the registry row.
  INSERT INTO phone_identity_registry (phone, normalized_phone, workspace_id, entity_type, entity_id, source, status)
  VALUES (p_phone, v_normalized, p_workspace_id, p_entity_type, p_entity_id, COALESCE(p_source, 'sync'), 'active')
  ON CONFLICT (workspace_id, entity_type, entity_id)
  DO UPDATE SET
    phone            = EXCLUDED.phone,
    normalized_phone = EXCLUDED.normalized_phone,
    source           = EXCLUDED.source,
    status           = 'active',
    updated_at       = now();

  -- Build owners list for current state of this (workspace, normalized_phone) cohort.
  SELECT
    jsonb_agg(
      jsonb_build_object(
        'entity_type', entity_type,
        'entity_id',   entity_id,
        'source',      source,
        'first_seen',  created_at
      ) ORDER BY created_at
    ),
    count(*),
    count(DISTINCT entity_type)
  INTO v_owners, v_row_count, v_distinct_types
  FROM phone_identity_registry
  WHERE workspace_id = p_workspace_id
    AND normalized_phone = v_normalized
    AND status = 'active';

  IF v_row_count > 1 THEN
    v_severity := CASE
      WHEN v_distinct_types > 1 THEN 'cross_role_duplicate'
      ELSE 'same_role_duplicate'
    END;

    INSERT INTO identity_conflicts (workspace_id, normalized_phone, severity, owners, status)
    VALUES (p_workspace_id, v_normalized, v_severity, v_owners, 'open')
    ON CONFLICT (workspace_id, normalized_phone) WHERE status = 'open'
    DO UPDATE SET
      severity   = EXCLUDED.severity,
      owners     = EXCLUDED.owners,
      updated_at = now();
  ELSE
    -- Down to a single owner → auto-resolve any prior open conflict.
    UPDATE identity_conflicts
       SET status='resolved', resolution='keep_separate', resolved_at=now(), updated_at=now(),
           resolution_note=COALESCE(resolution_note, '') || ' [auto-resolved: collision cleared]'
     WHERE workspace_id=p_workspace_id AND normalized_phone=v_normalized AND status='open';
  END IF;
END;
$$;

-- Archive a (workspace, entity) row when its source entity is deleted.
CREATE OR REPLACE FUNCTION pir_archive_entity(
  p_workspace_id BIGINT,
  p_entity_type  TEXT,
  p_entity_id    TEXT
) RETURNS VOID
LANGUAGE plpgsql AS $$
DECLARE
  v_normalized TEXT;
  v_row_count  INT;
BEGIN
  -- Capture normalized phone before archiving (for collision re-eval).
  SELECT normalized_phone INTO v_normalized
    FROM phone_identity_registry
   WHERE workspace_id=p_workspace_id AND entity_type=p_entity_type AND entity_id=p_entity_id AND status='active';

  UPDATE phone_identity_registry
     SET status='archived', updated_at=now()
   WHERE workspace_id=p_workspace_id AND entity_type=p_entity_type AND entity_id=p_entity_id AND status='active';

  IF v_normalized IS NOT NULL THEN
    SELECT count(*) INTO v_row_count
      FROM phone_identity_registry
     WHERE workspace_id=p_workspace_id AND normalized_phone=v_normalized AND status='active';

    IF v_row_count <= 1 THEN
      UPDATE identity_conflicts
         SET status='resolved', resolution='keep_separate', resolved_at=now(), updated_at=now(),
             resolution_note=COALESCE(resolution_note, '') || ' [auto-resolved: entity archived]'
       WHERE workspace_id=p_workspace_id AND normalized_phone=v_normalized AND status='open';
    END IF;
  END IF;
END;
$$;

-- ════════════════════════════════════════════════════════════════════
-- 3. Triggers on source tables
-- ════════════════════════════════════════════════════════════════════

-- customers: workspace_id = customers.user_id
CREATE OR REPLACE FUNCTION trg_pir_customers() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM pir_archive_entity(OLD.user_id, 'customer', OLD.id::text);
    RETURN OLD;
  END IF;
  PERFORM pir_upsert_and_detect(NEW.user_id, 'customer', NEW.id::text, NEW.phone, 'customer_table');
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS pir_customers_sync ON customers;
CREATE TRIGGER pir_customers_sync
AFTER INSERT OR DELETE OR UPDATE OF phone, user_id ON customers
FOR EACH ROW EXECUTE FUNCTION trg_pir_customers();

-- team_members: workspace_id = team_members.user_id
CREATE OR REPLACE FUNCTION trg_pir_team_members() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM pir_archive_entity(OLD.user_id, 'team_member', OLD.id::text);
    RETURN OLD;
  END IF;
  PERFORM pir_upsert_and_detect(NEW.user_id, 'team_member', NEW.id::text, NEW.phone, 'team_member_table');
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS pir_team_members_sync ON team_members;
CREATE TRIGGER pir_team_members_sync
AFTER INSERT OR DELETE OR UPDATE OF phone, user_id ON team_members
FOR EACH ROW EXECUTE FUNCTION trg_pir_team_members();

-- leads: workspace_id = leads.user_id
CREATE OR REPLACE FUNCTION trg_pir_leads() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM pir_archive_entity(OLD.user_id, 'lead', OLD.id::text);
    RETURN OLD;
  END IF;
  PERFORM pir_upsert_and_detect(NEW.user_id, 'lead', NEW.id::text, NEW.phone, 'lead_table');
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS pir_leads_sync ON leads;
CREATE TRIGGER pir_leads_sync
AFTER INSERT OR DELETE OR UPDATE OF phone, user_id ON leads
FOR EACH ROW EXECUTE FUNCTION trg_pir_leads();

-- users: workspace_id = users.id (the user IS the tenant root)
CREATE OR REPLACE FUNCTION trg_pir_users() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM pir_archive_entity(OLD.id, 'user', OLD.id::text);
    RETURN OLD;
  END IF;
  PERFORM pir_upsert_and_detect(NEW.id, 'user', NEW.id::text, NEW.phone, 'user_table');
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS pir_users_sync ON users;
CREATE TRIGGER pir_users_sync
AFTER INSERT OR DELETE OR UPDATE OF phone ON users
FOR EACH ROW EXECUTE FUNCTION trg_pir_users();

-- ════════════════════════════════════════════════════════════════════
-- 4. Backfill from existing data
-- ════════════════════════════════════════════════════════════════════

-- customers
INSERT INTO phone_identity_registry (phone, normalized_phone, workspace_id, entity_type, entity_id, source, status)
SELECT phone,
       pir_normalize_phone(phone),
       user_id,
       'customer',
       id::text,
       'backfill_customer',
       'active'
  FROM customers
 WHERE phone IS NOT NULL AND phone <> '' AND user_id IS NOT NULL
       AND pir_normalize_phone(phone) IS NOT NULL
ON CONFLICT (workspace_id, entity_type, entity_id) DO NOTHING;

-- team_members
INSERT INTO phone_identity_registry (phone, normalized_phone, workspace_id, entity_type, entity_id, source, status)
SELECT phone,
       pir_normalize_phone(phone),
       user_id,
       'team_member',
       id::text,
       'backfill_team_member',
       'active'
  FROM team_members
 WHERE phone IS NOT NULL AND phone <> '' AND user_id IS NOT NULL
       AND pir_normalize_phone(phone) IS NOT NULL
ON CONFLICT (workspace_id, entity_type, entity_id) DO NOTHING;

-- leads
INSERT INTO phone_identity_registry (phone, normalized_phone, workspace_id, entity_type, entity_id, source, status)
SELECT phone,
       pir_normalize_phone(phone),
       user_id,
       'lead',
       id::text,
       'backfill_lead',
       'active'
  FROM leads
 WHERE phone IS NOT NULL AND phone <> '' AND user_id IS NOT NULL
       AND pir_normalize_phone(phone) IS NOT NULL
ON CONFLICT (workspace_id, entity_type, entity_id) DO NOTHING;

-- users
INSERT INTO phone_identity_registry (phone, normalized_phone, workspace_id, entity_type, entity_id, source, status)
SELECT phone,
       pir_normalize_phone(phone),
       id,
       'user',
       id::text,
       'backfill_user',
       'active'
  FROM users
 WHERE phone IS NOT NULL AND phone <> ''
       AND pir_normalize_phone(phone) IS NOT NULL
ON CONFLICT (workspace_id, entity_type, entity_id) DO NOTHING;

-- ════════════════════════════════════════════════════════════════════
-- 5. Seed identity_conflicts from existing collisions
-- ════════════════════════════════════════════════════════════════════

INSERT INTO identity_conflicts (workspace_id, normalized_phone, severity, owners, status)
SELECT
  workspace_id,
  normalized_phone,
  CASE WHEN count(DISTINCT entity_type) > 1
       THEN 'cross_role_duplicate'
       ELSE 'same_role_duplicate'
  END AS severity,
  jsonb_agg(
    jsonb_build_object(
      'entity_type', entity_type,
      'entity_id',   entity_id,
      'source',      source,
      'first_seen',  created_at
    ) ORDER BY created_at
  ) AS owners,
  'open'
FROM phone_identity_registry
WHERE status = 'active'
GROUP BY workspace_id, normalized_phone
HAVING count(*) > 1
ON CONFLICT (workspace_id, normalized_phone) WHERE status='open'
DO UPDATE SET
  severity   = EXCLUDED.severity,
  owners     = EXCLUDED.owners,
  updated_at = now();

COMMIT;
