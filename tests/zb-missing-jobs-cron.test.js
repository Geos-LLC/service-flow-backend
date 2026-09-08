'use strict';

/**
 * Tests for workers/zb-missing-jobs-cron.js.
 *
 * The tick is thin — its job is to iterate connected ZB tenants and invoke
 * the injected syncJobsFn with a date-window filter. These tests exercise
 * the tick contract without touching the real ZB API or Supabase.
 *
 * Matrix:
 *   1. ZB_MISSING_JOBS_ENABLED unset → tick short-circuits, no side effects.
 *   2. syncJobsFn dependency missing → tick short-circuits with 'no_sync_jobs_fn'.
 *   3. APPLY=false → dry-run: tenants iterated but syncJobsFn never called.
 *   4. APPLY=true → syncJobsFn called per connected tenant with the correct
 *      date window (canceled='false', start_date_min=today-lookback,
 *      start_date_max=today+lookahead).
 *   5. Tenant failure isolation: tenant A throwing does not block tenant B.
 *   6. Only tenants with zenbooker_status='connected' AND non-null apiKey run.
 *   7. Summary aggregates {fetched, created, skipped, errors} across tenants.
 *   8. isoDateAt helper produces YYYY-MM-DD offset from a given now.
 */

const path = require('path');
const modulePath = path.resolve(__dirname, '../workers/zb-missing-jobs-cron.js');

function loadFresh(env = {}) {
  // env flags are read fresh per tick via envFlag() but the module singleton
  // caches nothing state-wise. Reset the module registry so console-log spies
  // don't leak between tests.
  delete require.cache[require.resolve(modulePath)];
  const prev = {};
  for (const k of Object.keys(env)) {
    prev[k] = process.env[k];
    process.env[k] = env[k];
  }
  const mod = require(modulePath);
  return { mod, restore: () => {
    for (const k of Object.keys(env)) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }};
}

function makeSupabase({ users = [] } = {}) {
  return {
    from(table) {
      const filters = [];
      const chain = {
        select() { return chain; },
        eq(col, val) { filters.push({ op: 'eq', col, val }); return chain; },
        not(col, op, val) {
          if (op === 'is' && val === null) filters.push({ op: 'not_null', col });
          return chain;
        },
        then(resolve, reject) {
          if (table !== 'users') {
            return Promise.resolve({ data: [], error: null }).then(resolve, reject);
          }
          const rows = users.filter(u =>
            filters.every(f => {
              if (f.op === 'eq') return u[f.col] === f.val;
              if (f.op === 'not_null') return u[f.col] !== null && u[f.col] !== undefined;
              return true;
            })
          );
          return Promise.resolve({ data: rows, error: null }).then(resolve, reject);
        },
      };
      return chain;
    },
  };
}

function silentLogger() {
  return { log() {}, warn() {}, error() {} };
}

describe('zb-missing-jobs-cron', () => {
  const NOW = new Date('2026-09-08T12:00:00.000Z');

  test('disabled flag short-circuits the tick', async () => {
    const { mod, restore } = loadFresh({ ZB_MISSING_JOBS_ENABLED: 'false' });
    try {
      const syncJobsFn = jest.fn();
      const supabase = makeSupabase({ users: [{ id: 1, zenbooker_api_key: 'k', zenbooker_status: 'connected' }] });
      const result = await mod.runMissingJobsTick({ supabase, logger: silentLogger(), syncJobsFn, now: NOW });
      expect(result).toEqual({ skipped: 'disabled' });
      expect(syncJobsFn).not.toHaveBeenCalled();
    } finally { restore(); }
  });

  test('missing syncJobsFn short-circuits with no_sync_jobs_fn', async () => {
    const { mod, restore } = loadFresh({ ZB_MISSING_JOBS_ENABLED: 'true', ZB_MISSING_JOBS_APPLY: 'true' });
    try {
      const supabase = makeSupabase();
      const result = await mod.runMissingJobsTick({ supabase, logger: silentLogger(), now: NOW });
      expect(result).toEqual({ skipped: 'no_sync_jobs_fn' });
    } finally { restore(); }
  });

  test('APPLY=false: iterates tenants but never invokes syncJobsFn', async () => {
    const { mod, restore } = loadFresh({ ZB_MISSING_JOBS_ENABLED: 'true', ZB_MISSING_JOBS_APPLY: 'false' });
    try {
      const syncJobsFn = jest.fn();
      const supabase = makeSupabase({ users: [
        { id: 1, zenbooker_api_key: 'k1', zenbooker_status: 'connected' },
        { id: 2, zenbooker_api_key: 'k2', zenbooker_status: 'connected' },
      ]});
      const result = await mod.runMissingJobsTick({ supabase, logger: silentLogger(), syncJobsFn, now: NOW });
      expect(syncJobsFn).not.toHaveBeenCalled();
      expect(result.tenantsProcessed).toBe(2);
      expect(result.tenantFailures).toBe(0);
    } finally { restore(); }
  });

  test('APPLY=true: calls syncJobsFn per tenant with correct date window', async () => {
    const { mod, restore } = loadFresh({
      ZB_MISSING_JOBS_ENABLED: 'true',
      ZB_MISSING_JOBS_APPLY: 'true',
      ZB_MISSING_JOBS_LOOKAHEAD_DAYS: '30',
      ZB_MISSING_JOBS_LOOKBACK_DAYS: '2',
    });
    try {
      const syncJobsFn = jest.fn().mockResolvedValue({ total: 10, created: 2, skipped: 8, errors: 0 });
      const supabase = makeSupabase({ users: [
        { id: 1, zenbooker_api_key: 'k1', zenbooker_status: 'connected' },
        { id: 2, zenbooker_api_key: 'k2', zenbooker_status: 'connected' },
      ]});
      const result = await mod.runMissingJobsTick({ supabase, logger: silentLogger(), syncJobsFn, now: NOW });
      expect(syncJobsFn).toHaveBeenCalledTimes(2);
      expect(syncJobsFn).toHaveBeenCalledWith(1, 'k1', {
        canceled: 'false',
        start_date_min: '2026-09-06',   // now - 2d
        start_date_max: '2026-10-08',   // now + 30d
      }, 0);
      expect(result.totals).toEqual({ fetched: 20, created: 4, skipped: 16, errors: 0 });
      expect(result.tenantsProcessed).toBe(2);
    } finally { restore(); }
  });

  test('tenant failure does not block subsequent tenants', async () => {
    const { mod, restore } = loadFresh({ ZB_MISSING_JOBS_ENABLED: 'true', ZB_MISSING_JOBS_APPLY: 'true' });
    try {
      const syncJobsFn = jest.fn()
        .mockRejectedValueOnce(new Error('ZB API 500'))
        .mockResolvedValueOnce({ total: 5, created: 1, skipped: 4, errors: 0 });
      const supabase = makeSupabase({ users: [
        { id: 1, zenbooker_api_key: 'k1', zenbooker_status: 'connected' },
        { id: 2, zenbooker_api_key: 'k2', zenbooker_status: 'connected' },
      ]});
      const result = await mod.runMissingJobsTick({ supabase, logger: silentLogger(), syncJobsFn, now: NOW });
      expect(syncJobsFn).toHaveBeenCalledTimes(2);
      expect(result.tenantFailures).toBe(1);
      expect(result.tenantsProcessed).toBe(1);
      expect(result.totals.created).toBe(1);
    } finally { restore(); }
  });

  test('only connected tenants with an apiKey are processed', async () => {
    const { mod, restore } = loadFresh({ ZB_MISSING_JOBS_ENABLED: 'true', ZB_MISSING_JOBS_APPLY: 'true' });
    try {
      const syncJobsFn = jest.fn().mockResolvedValue({ total: 0, created: 0, skipped: 0, errors: 0 });
      const supabase = makeSupabase({ users: [
        { id: 1, zenbooker_api_key: 'k1', zenbooker_status: 'connected' },
        { id: 2, zenbooker_api_key: null, zenbooker_status: 'connected' },   // filtered by not-null
        { id: 3, zenbooker_api_key: 'k3', zenbooker_status: 'disconnected' },// filtered by status
      ]});
      const result = await mod.runMissingJobsTick({ supabase, logger: silentLogger(), syncJobsFn, now: NOW });
      expect(syncJobsFn).toHaveBeenCalledTimes(1);
      expect(syncJobsFn).toHaveBeenCalledWith(1, 'k1', expect.any(Object), 0);
      expect(result.tenants).toBe(1);
    } finally { restore(); }
  });

  test('isoDateAt returns YYYY-MM-DD offset from now', () => {
    const { mod, restore } = loadFresh();
    try {
      expect(mod.isoDateAt(new Date('2026-09-08T12:00:00Z'), 0)).toBe('2026-09-08');
      expect(mod.isoDateAt(new Date('2026-09-08T12:00:00Z'), 30)).toBe('2026-10-08');
      expect(mod.isoDateAt(new Date('2026-09-08T12:00:00Z'), -2)).toBe('2026-09-06');
    } finally { restore(); }
  });

  test('users query error returns error result', async () => {
    const { mod, restore } = loadFresh({ ZB_MISSING_JOBS_ENABLED: 'true', ZB_MISSING_JOBS_APPLY: 'true' });
    try {
      const syncJobsFn = jest.fn();
      const brokenSupabase = { from: () => ({
        select() { return this; },
        eq() { return this; },
        not() { return this; },
        then(resolve) { return Promise.resolve({ data: null, error: { message: 'db down' } }).then(resolve); },
      })};
      const result = await mod.runMissingJobsTick({ supabase: brokenSupabase, logger: silentLogger(), syncJobsFn, now: NOW });
      expect(result).toEqual({ error: 'users_query_failed' });
      expect(syncJobsFn).not.toHaveBeenCalled();
    } finally { restore(); }
  });
});
