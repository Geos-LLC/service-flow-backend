'use strict';

// Per-tenant lock for SF→LB historical-sync Phase-2 apply.
//
// Backed by a DB row (table `sf_historical_apply_locks`, migration 064).
// pg_try_advisory_lock would not survive Supabase's pgbouncer pooling
// across the apply path's multi-query + LB-HTTP flow — see the migration
// header for the long form.
//
// API:
//   tryAcquire(supabase, tenantId, { holdSeconds = 300, note })
//     → { ok: true }                              acquired
//     → { ok: false, reason: 'apply_in_progress' } another caller holds it
//     → { ok: false, reason: 'lock_rpc_failed', detail } RPC error
//
//   release(supabase, tenantId)
//     Best-effort; safe to call without ok.

const TRY_FN  = 'sf_historical_apply_try_acquire';
const FREE_FN = 'sf_historical_apply_release';

async function tryAcquire(supabase, tenantId, { holdSeconds, note } = {}) {
  if (!supabase || typeof supabase.rpc !== 'function') {
    return { ok: false, reason: 'lock_rpc_failed', detail: 'supabase.rpc unavailable' };
  }
  const params = { p_tenant_id: Number(tenantId) };
  if (Number.isFinite(holdSeconds)) params.p_hold_seconds = holdSeconds;
  if (typeof note === 'string')     params.p_holder_note  = note;
  const { data, error } = await supabase.rpc(TRY_FN, params);
  if (error) return { ok: false, reason: 'lock_rpc_failed', detail: error.message };
  if (data === true) return { ok: true };
  return { ok: false, reason: 'apply_in_progress' };
}

async function release(supabase, tenantId) {
  if (!supabase || typeof supabase.rpc !== 'function') return;
  try {
    await supabase.rpc(FREE_FN, { p_tenant_id: Number(tenantId) });
  } catch (_) { /* best-effort */ }
}

module.exports = { tryAcquire, release, TRY_FN, FREE_FN };
