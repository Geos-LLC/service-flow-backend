-- Rollback for 063_zb_future_reconcile_lock.sql.

DROP FUNCTION IF EXISTS zb_future_reconcile_try_tick_lock();
DROP FUNCTION IF EXISTS zb_future_reconcile_release_tick_lock();
