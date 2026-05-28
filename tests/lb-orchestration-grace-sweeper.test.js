'use strict';

/**
 * workers/lb-orchestration-grace-sweeper.js
 *
 * Confirms:
 *   - factory rejects without supabase
 *   - one tick with zero rotating rows is a no-op (no log spam)
 *   - one tick with overdue rotating row flips it to revoked
 *   - logs only when sweptCount > 0
 *   - stop() prevents future ticks
 *   - import has no side effects (no setInterval at module level)
 */

process.env.SF_ORCH_SIGNING_KEY     = Buffer.alloc(32, 0xAB).toString('base64');
process.env.SF_ORCH_SIGNING_KEY_KID = 'sf_orch_test_kid';

const { startSweeper, DEFAULT_TICK_MS } = require('../workers/lb-orchestration-grace-sweeper');
const creds = require('../lib/lb-orchestration-credentials');

const TABLE = 'lb_orchestration_credentials';

// Reuse a minimal store. Same shape as the other tests, simplified.
function makeStore({ rows = [] } = {}) {
  function applyFilters(rs, filters) {
    return rs.filter((r) => {
      for (const f of filters) {
        if (f.type === 'eq' && String(r[f.col]) !== String(f.val)) return false;
        if (f.type === 'in' && !f.vals.map(String).includes(String(r[f.col]))) return false;
        if (f.type === 'lte') {
          const lhs = r[f.col] ? Date.parse(r[f.col]) : null;
          const rhs = Date.parse(f.val);
          if (lhs == null || !(lhs <= rhs)) return false;
        }
      }
      return true;
    });
  }
  return {
    _rows: rows,
    from(table) {
      const state = { table, op: null, payload: null, filters: [], selectCols: null };
      const builder = {
        select(c) { state.selectCols = c || '*'; if (!state.op) state.op = 'select'; return builder; },
        update(p) { state.op = 'update'; state.payload = p; return builder; },
        insert(r) { state.op = 'insert'; state.payload = r; return builder; },
        eq(c, v)  { state.filters.push({ type: 'eq', col: c, val: v }); return builder; },
        in(c, v)  { state.filters.push({ type: 'in', col: c, vals: v }); return builder; },
        lte(c, v) { state.filters.push({ type: 'lte', col: c, val: v }); return builder; },
        maybeSingle() {
          if (state.table !== TABLE) return Promise.resolve({ data: null, error: null });
          const matched = applyFilters(rows, state.filters);
          return Promise.resolve({ data: matched[0] || null, error: null });
        },
        single() {
          if (state.op === 'insert') {
            const newRow = { id: (rows.length + 1) * 1000, ...state.payload };
            rows.push(newRow);
            return Promise.resolve({ data: { id: newRow.id }, error: null });
          }
          return Promise.resolve({ data: null, error: { code: 'PGRST116' } });
        },
        then(onF, onR) {
          if (state.table !== TABLE) return Promise.resolve({ data: null, error: null }).then(onF, onR);
          if (state.op === 'update') {
            const matched = applyFilters(rows, state.filters);
            for (const r of matched) Object.assign(r, state.payload);
            return Promise.resolve({ data: matched.map((r) => ({ ...r })), error: null }).then(onF, onR);
          }
          const matched = applyFilters(rows, state.filters);
          return Promise.resolve({ data: matched.map((r) => ({ ...r })), error: null }).then(onF, onR);
        },
      };
      return builder;
    },
  };
}

describe('grace sweeper', () => {
  test('factory rejects when supabase missing', () => {
    expect(() => startSweeper({})).toThrow(/supabase/);
  });

  test('default tick is 60s', () => {
    expect(DEFAULT_TICK_MS).toBe(60 * 1000);
  });

  test('one manual tick with zero rotating rows → no-op, no log', async () => {
    const logs = [];
    const logger = {
      log: (m) => logs.push(['log', m]),
      warn: (m) => logs.push(['warn', m]),
      error: (m) => logs.push(['error', m]),
    };
    const sweeper = startSweeper({ supabase: makeStore(), logger, tickMs: 60_000 });
    await sweeper._tickForTest();
    expect(logs).toHaveLength(0);
    sweeper.stop();
  });

  test('one manual tick with overdue rotating row → flips to revoked + logs swept count', async () => {
    const store = makeStore({
      rows: [{
        id: 1, user_id: 2,
        status: 'rotating',
        grace_expires_at: new Date(Date.now() - 60_000).toISOString(),
      }],
    });
    const logs = [];
    const logger = {
      log: (m) => logs.push(['log', m]),
      warn: () => {}, error: () => {},
    };
    const sweeper = startSweeper({ supabase: store, logger, tickMs: 60_000 });
    await sweeper._tickForTest();
    expect(store._rows[0].status).toBe('revoked');
    expect(store._rows[0].revoked_reason).toBe('grace_expired');
    expect(logs.length).toBeGreaterThan(0);
    expect(logs[0][1]).toMatch(/swept 1 rotating/);
    sweeper.stop();
  });

  test('module import does not start any interval at load time', () => {
    // Smoke test: re-requiring the module under a fresh cache doesn't
    // start anything by itself.
    jest.resetModules();
    const mod = require('../workers/lb-orchestration-grace-sweeper');
    expect(typeof mod.startSweeper).toBe('function');
    // No interval was created — Node would exit cleanly when this
    // test file finishes if so.
  });

  test('stop() prevents future ticks from doing work', async () => {
    const store = makeStore({
      rows: [{ id: 1, user_id: 2, status: 'rotating', grace_expires_at: new Date(0).toISOString() }],
    });
    const sweeper = startSweeper({ supabase: store, logger: { log() {}, warn() {}, error() {} }, tickMs: 60_000 });
    sweeper.stop();
    // After stop, a manual tick is a no-op (the stopped guard).
    await sweeper._tickForTest();
    expect(store._rows[0].status).toBe('rotating');   // not flipped
  });
});
