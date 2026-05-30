-- Advisory-lock RPCs for the ZB future-job reconciliation cron.
--
-- The cron runs in-process across multiple Railway replicas. Without a lock,
-- N replicas would do N times the work and N times the ZB API calls on every
-- tick. Per-tick advisory lock guarantees at most one replica reconciles at a
-- time. Identical pattern to lb_outbound_try_tick_lock /
-- zb_outbound_try_tick_lock in migrations 022 and 044.
--
-- Lock key 0x5A465243 = ASCII "ZFRC" (Zb Future ReConcile). Chosen so it
-- doesn't collide with the LB outbound (1279873602) / ZB outbound (1514494530)
-- keys.

CREATE OR REPLACE FUNCTION zb_future_reconcile_try_tick_lock()
RETURNS BOOLEAN
LANGUAGE sql
AS $$
  SELECT pg_try_advisory_lock(1514494147);
$$;

CREATE OR REPLACE FUNCTION zb_future_reconcile_release_tick_lock()
RETURNS BOOLEAN
LANGUAGE sql
AS $$
  SELECT pg_advisory_unlock(1514494147);
$$;

COMMENT ON FUNCTION zb_future_reconcile_try_tick_lock IS
  'Per-tick advisory lock for the ZB future-job reconciliation cron. Returns true if this replica acquired the lock for this tick.';
