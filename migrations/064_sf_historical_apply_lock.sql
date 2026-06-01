-- Per-tenant lock for SF→LB historical-sync Phase-2 apply.
--
-- Why a row lock, not pg_advisory_lock:
--   Supabase's PostgREST sits behind a pgbouncer transaction-mode pool.
--   pg_try_advisory_lock acquired in one RPC call is released when the
--   underlying connection returns to the pool — so the lock would NOT
--   survive across the apply path's multiple Supabase queries + the LB
--   HTTP call between them. A DB-row lock with TTL is the only safe
--   choice that survives pool churn.
--
-- Pattern:
--   sf_historical_apply_try_acquire(tenant_id, hold_seconds default 300)
--     INSERT, or UPDATE if the existing row is stale (acquired_at older
--     than hold_seconds). Returns TRUE if this caller now owns the lock,
--     FALSE if another live caller already holds it.
--
--   sf_historical_apply_release(tenant_id)
--     DELETE the lock row. Safe to call when nothing held (no-op).
--
-- TTL exists because a Node process that crashed mid-apply (or a
-- Railway redeploy) would leave the row behind. We don't want that to
-- block subsequent applies forever — 5 minutes is generous given the
-- LB call itself caps at 30s.

CREATE TABLE IF NOT EXISTS public.sf_historical_apply_locks (
  tenant_id    INTEGER     PRIMARY KEY,
  acquired_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  holder_note  TEXT
);

COMMENT ON TABLE public.sf_historical_apply_locks IS
  'Per-tenant mutex for SF→LB historical-sync Phase-2 apply. One row per actively-applying tenant. Rows are TTL-aged via the try-acquire RPC and explicitly DELETE-d when apply completes.';

CREATE OR REPLACE FUNCTION public.sf_historical_apply_try_acquire(
  p_tenant_id    INTEGER,
  p_hold_seconds INTEGER DEFAULT 300,
  p_holder_note  TEXT    DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
AS $$
DECLARE
  v_inserted   INTEGER;
  v_existing   TIMESTAMPTZ;
BEGIN
  -- Fast path: no row → INSERT and we own it.
  INSERT INTO public.sf_historical_apply_locks (tenant_id, acquired_at, holder_note)
  VALUES (p_tenant_id, now(), p_holder_note)
  ON CONFLICT (tenant_id) DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  IF v_inserted = 1 THEN
    RETURN TRUE;
  END IF;

  -- Slow path: row already exists. Steal it iff stale.
  SELECT acquired_at INTO v_existing
    FROM public.sf_historical_apply_locks
    WHERE tenant_id = p_tenant_id
    FOR UPDATE;

  IF v_existing IS NULL OR v_existing < now() - make_interval(secs => p_hold_seconds) THEN
    UPDATE public.sf_historical_apply_locks
      SET acquired_at = now(), holder_note = p_holder_note
      WHERE tenant_id = p_tenant_id;
    RETURN TRUE;
  END IF;

  -- Held by another live caller.
  RETURN FALSE;
END;
$$;

CREATE OR REPLACE FUNCTION public.sf_historical_apply_release(p_tenant_id INTEGER)
RETURNS BOOLEAN
LANGUAGE sql
AS $$
  DELETE FROM public.sf_historical_apply_locks WHERE tenant_id = p_tenant_id;
  SELECT TRUE;
$$;

COMMENT ON FUNCTION public.sf_historical_apply_try_acquire IS
  'Try to claim the per-tenant apply lock. Returns TRUE if claimed (new row or stale row stolen), FALSE if another live caller owns it.';

COMMENT ON FUNCTION public.sf_historical_apply_release IS
  'Drop the per-tenant apply lock row. Idempotent — no-op if nothing held.';
