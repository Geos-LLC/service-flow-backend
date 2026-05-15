-- 041_zb_apply_payment_writes.sql
-- P1.3 (Synchronization Constitution §6.2) — eliminate the partial-commit
-- window in ZB financial sync.
--
-- Before P1.3, three paths in zenbooker-sync.js each performed at least two
-- separate writes (jobs UPDATE + transactions INSERT/UPDATE) outside any
-- atomic boundary. A crash or network blip between the writes left the
-- invariant `jobs.payment_status='paid' ⟺ transactions row exists for the
-- job` violated. The audit (D9, F11) flagged the handlePaymentEvent fallback
-- specifically, but the same partial-commit shape exists in syncTransactions
-- and runPaymentReconcile.
--
-- This migration adds one Postgres function that wraps the (jobs UPDATE +
-- N transactions upsert) pair in a single implicit transaction. plpgsql
-- functions are atomic: RAISE inside aborts the whole function and rolls
-- back every write. Supabase JS callers invoke via `supabase.rpc(...)`.
--
-- The function is intentionally narrow:
--   - Only writes payment-related columns on jobs (whitelist enumerated).
--   - Only writes the existing transactions schema; tenant scope enforced
--     by the WHERE clause on every UPDATE/SELECT.
--   - Idempotent on tx upserts via zenbooker_id (app-layer key — no unique
--     index exists, so we SELECT-then-UPDATE-or-INSERT).

CREATE OR REPLACE FUNCTION zb_apply_payment_writes(
  p_user_id      BIGINT,
  p_sf_job_id    BIGINT,
  p_job_updates  JSONB DEFAULT NULL,
  p_tx_data_array JSONB DEFAULT '[]'::jsonb
) RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  v_job_owner_check INT;
  v_jobs_updated    INT := 0;
  v_tx_actions      JSONB := '[]'::jsonb;
  v_tx_obj          JSONB;
  v_existing_id     BIGINT;
  v_inserted_id     BIGINT;
  v_action          TEXT;
  v_tx_zb_id        TEXT;
  v_tx_job_id       BIGINT;
BEGIN
  ----------------------------------------------------------------------
  -- 1. Tenant scope guard. Refuse if the job doesn't belong to the
  --    calling tenant. This MUST run before any write so a forged
  --    sf_job_id can't be used to write into another tenant's jobs row.
  --    sf_job_id may be NULL when this function is called purely to
  --    upsert transactions (e.g. multi-tx insert with per-tx job_ids).
  ----------------------------------------------------------------------
  IF p_sf_job_id IS NOT NULL THEN
    SELECT 1 INTO v_job_owner_check
    FROM jobs
    WHERE id = p_sf_job_id AND user_id = p_user_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'zb_apply_payment_writes: job % not found or not owned by user %', p_sf_job_id, p_user_id
        USING ERRCODE = 'P0002';
    END IF;
  END IF;

  ----------------------------------------------------------------------
  -- 2. Apply job updates (whitelist of payment-related columns only).
  --    COALESCE preserves existing value when the key is absent or
  --    explicitly NULL in p_job_updates. To clear a field, callers
  --    must pass an empty string for text columns or omit the key.
  ----------------------------------------------------------------------
  IF p_sf_job_id IS NOT NULL AND p_job_updates IS NOT NULL AND p_job_updates <> '{}'::jsonb THEN
    UPDATE jobs
    SET
      payment_status     = COALESCE(p_job_updates->>'payment_status',                       payment_status),
      invoice_status     = COALESCE(p_job_updates->>'invoice_status',                       invoice_status),
      payment_method     = COALESCE(p_job_updates->>'payment_method',                       payment_method),
      total_paid_amount  = COALESCE((p_job_updates->>'total_paid_amount')::numeric,         total_paid_amount),
      service_price      = COALESCE((p_job_updates->>'service_price')::numeric,             service_price),
      price              = COALESCE((p_job_updates->>'price')::numeric,                     price),
      total              = COALESCE((p_job_updates->>'total')::numeric,                     total),
      total_amount       = COALESCE((p_job_updates->>'total_amount')::numeric,              total_amount),
      invoice_amount     = COALESCE((p_job_updates->>'invoice_amount')::numeric,            invoice_amount),
      tip_amount         = COALESCE((p_job_updates->>'tip_amount')::numeric,                tip_amount),
      additional_fees    = COALESCE((p_job_updates->>'additional_fees')::numeric,           additional_fees),
      discount           = COALESCE((p_job_updates->>'discount')::numeric,                  discount),
      duration           = COALESCE((p_job_updates->>'duration')::integer,                  duration),
      taxes              = COALESCE((p_job_updates->>'taxes')::numeric,                     taxes),
      fees_breakdown     = COALESCE(p_job_updates->'fees_breakdown',                        fees_breakdown)
    WHERE id = p_sf_job_id AND user_id = p_user_id;
    GET DIAGNOSTICS v_jobs_updated = ROW_COUNT;
  END IF;

  ----------------------------------------------------------------------
  -- 3. For each tx in p_tx_data_array, idempotent upsert:
  --      a. If zenbooker_id present AND a matching tx exists for this
  --         tenant → UPDATE that row.
  --      b. Else if job_id present AND a manual tx (zenbooker_id IS NULL)
  --         exists for that job → ADOPT (UPDATE the manual row + stamp
  --         zenbooker_id).
  --      c. Else INSERT a new row.
  --
  -- Idempotency: replaying the same array with the same zenbooker_ids
  -- always produces 'updated_by_zb_id' on the second pass — never duplicates.
  ----------------------------------------------------------------------
  IF p_tx_data_array IS NOT NULL AND jsonb_typeof(p_tx_data_array) = 'array' THEN
    FOR v_tx_obj IN SELECT * FROM jsonb_array_elements(p_tx_data_array)
    LOOP
      v_tx_zb_id := v_tx_obj->>'zenbooker_id';
      v_tx_job_id := COALESCE((v_tx_obj->>'job_id')::bigint, p_sf_job_id);

      -- Cross-check: if this tx targets a different job, that job must
      -- also belong to the caller tenant.
      IF v_tx_job_id IS NOT NULL AND v_tx_job_id <> COALESCE(p_sf_job_id, -1) THEN
        SELECT 1 INTO v_job_owner_check
        FROM jobs
        WHERE id = v_tx_job_id AND user_id = p_user_id;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'zb_apply_payment_writes: tx job % not owned by user %', v_tx_job_id, p_user_id
            USING ERRCODE = 'P0002';
        END IF;
      END IF;

      v_existing_id := NULL;
      v_action := NULL;

      -- 3a: update by zenbooker_id (tenant-scoped)
      IF v_tx_zb_id IS NOT NULL AND v_tx_zb_id <> '' THEN
        UPDATE transactions
        SET
          amount         = COALESCE((v_tx_obj->>'amount')::numeric,      amount),
          payment_method = COALESCE(v_tx_obj->>'payment_method',         payment_method),
          status         = COALESCE(v_tx_obj->>'status',                 status),
          notes          = COALESCE(v_tx_obj->>'notes',                  notes),
          tip_amount     = COALESCE((v_tx_obj->>'tip_amount')::numeric,  tip_amount),
          discount       = COALESCE((v_tx_obj->>'discount')::numeric,    discount)
        WHERE user_id = p_user_id
          AND zenbooker_id = v_tx_zb_id
        RETURNING id INTO v_existing_id;
        IF v_existing_id IS NOT NULL THEN v_action := 'updated_by_zb_id'; END IF;
      END IF;

      -- 3b: adopt manual (no zenbooker_id, same job)
      IF v_existing_id IS NULL AND v_tx_job_id IS NOT NULL THEN
        WITH candidate AS (
          SELECT id
          FROM transactions
          WHERE user_id = p_user_id
            AND job_id = v_tx_job_id
            AND zenbooker_id IS NULL
          ORDER BY id ASC
          LIMIT 1
        )
        UPDATE transactions t
        SET
          zenbooker_id   = v_tx_zb_id,
          amount         = COALESCE((v_tx_obj->>'amount')::numeric,      t.amount),
          payment_method = COALESCE(v_tx_obj->>'payment_method',         t.payment_method),
          status         = COALESCE(v_tx_obj->>'status',                 t.status),
          notes          = COALESCE(v_tx_obj->>'notes',                  t.notes),
          tip_amount     = COALESCE((v_tx_obj->>'tip_amount')::numeric,  t.tip_amount),
          discount       = COALESCE((v_tx_obj->>'discount')::numeric,    t.discount),
          customer_id    = COALESCE((v_tx_obj->>'customer_id')::integer, t.customer_id),
          created_at     = COALESCE((v_tx_obj->>'created_at')::timestamp, t.created_at)
        FROM candidate c
        WHERE t.id = c.id
        RETURNING t.id INTO v_existing_id;
        IF v_existing_id IS NOT NULL THEN v_action := 'adopted'; END IF;
      END IF;

      -- 3c: INSERT
      IF v_existing_id IS NULL THEN
        INSERT INTO transactions(
          user_id, job_id, customer_id, amount, payment_method, payment_intent_id,
          status, notes, tip_amount, discount, zenbooker_id, created_at
        )
        VALUES(
          p_user_id,
          v_tx_job_id,
          (v_tx_obj->>'customer_id')::integer,
          (v_tx_obj->>'amount')::numeric,
          v_tx_obj->>'payment_method',
          v_tx_obj->>'payment_intent_id',
          COALESCE(v_tx_obj->>'status', 'completed'),
          v_tx_obj->>'notes',
          (v_tx_obj->>'tip_amount')::numeric,
          (v_tx_obj->>'discount')::numeric,
          v_tx_zb_id,
          COALESCE((v_tx_obj->>'created_at')::timestamp, NOW())
        )
        RETURNING id INTO v_inserted_id;
        v_existing_id := v_inserted_id;
        v_action := 'inserted';
      END IF;

      v_tx_actions := v_tx_actions || jsonb_build_object(
        'tx_id', v_existing_id,
        'action', v_action,
        'zenbooker_id', v_tx_zb_id
      );
    END LOOP;
  END IF;

  ----------------------------------------------------------------------
  -- 4. Return the summary. Whole function is atomic — if any RAISE
  --    fires above, every write rolls back.
  ----------------------------------------------------------------------
  RETURN jsonb_build_object(
    'committed',     TRUE,
    'jobs_updated',  v_jobs_updated,
    'tx_actions',    v_tx_actions,
    'sf_job_id',     p_sf_job_id,
    'user_id',       p_user_id
  );
END;
$$;

-- Allow the service_role (and Supabase-default callers) to execute.
GRANT EXECUTE ON FUNCTION zb_apply_payment_writes(BIGINT, BIGINT, JSONB, JSONB)
  TO service_role, authenticated, anon;

-- PostgREST schema cache reload so .rpc('zb_apply_payment_writes', ...) resolves immediately.
NOTIFY pgrst, 'reload schema';

COMMENT ON FUNCTION zb_apply_payment_writes IS
  'Synchronization Constitution §6.2 — atomic jobs UPDATE + transactions '
  'UPSERT. Closes the D9 partial-commit window in zenbooker-sync.js. plpgsql '
  'function body is one implicit transaction; RAISE rolls back every write. '
  'Idempotent on tx zenbooker_id (SELECT-then-UPDATE-or-INSERT pattern).';
