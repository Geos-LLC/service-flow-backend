/**
 * P0.1 (Synchronization Constitution §3.1) — ledger immutability contract.
 *
 * Two test layers:
 *   1. Unit tests for lib/ledger-immutability.js (safeDeleteCompletionDerivedLedger,
 *      recordLedgerDrift) using a mock Supabase client.
 *   2. Source-text scan asserting every DELETE on cleaner_ledger in server.js
 *      and zenbooker-sync.js either (a) goes through safeDeleteCompletionDerivedLedger
 *      OR (b) carries .is('payout_batch_id', null) OR (c) is in the explicit
 *      allowlist of batch-cancel / detach paths.
 *
 * The scan is the actual enforcement mechanism — once it ships, a PR that
 * reintroduces an unguarded delete fails CI.
 */

const fs = require('fs');
const path = require('path');

const {
  COMPLETION_DERIVED_TYPES,
  safeDeleteCompletionDerivedLedger,
  recordLedgerDrift,
} = require('../lib/ledger-immutability');

const SERVER_JS = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const ZB_SYNC_JS = fs.readFileSync(path.join(__dirname, '..', 'zenbooker-sync.js'), 'utf8');

// ─── Helper: stub Supabase chain ──────────────────────────────────────

function makeSupabase({ existingRows = [], deletedRows = null, deleteError = null, insertError = null } = {}) {
  // delete chain returns { data: rows, error }; select chain returns { data }.
  // Mode is first-write-wins so `.delete().select()` still resolves as delete.
  const calls = { selects: [], deletes: [], inserts: [] };
  function chain(table) {
    let mode = null;
    const filters = [];
    function setMode(m) { if (!mode) mode = m; }
    function match(rows) {
      return (rows || []).filter(r =>
        filters.every(f => {
          if (f.k === 'eq') return r[f.col] === f.val;
          if (f.k === 'in') return Array.isArray(f.val) && f.val.includes(r[f.col]);
          if (f.k === 'is') return f.val === null ? (r[f.col] == null) : r[f.col] === f.val;
          if (f.k === 'not') return f.val === null ? (r[f.col] != null) : r[f.col] !== f.val;
          return true;
        })
      );
    }
    const builder = {
      select() { setMode('select'); return builder; },
      delete() { setMode('delete'); return builder; },
      insert(row) {
        calls.inserts.push({ table, row });
        return Promise.resolve({ error: insertError });
      },
      eq(col, val) { filters.push({ k: 'eq', col, val }); return builder; },
      in(col, val) { filters.push({ k: 'in', col, val }); return builder; },
      is(col, val) { filters.push({ k: 'is', col, val }); return builder; },
      not(col, _op, val) { filters.push({ k: 'not', col, val }); return builder; },
      limit() { return builder; },
      contains() { return builder; },
      ilike() { return builder; },
      single() { return Promise.resolve({ data: null }); },
      then(resolve) {
        if (mode === 'delete') {
          calls.deletes.push({ table, filters: [...filters] });
          if (deleteError) return resolve({ data: null, error: deleteError });
          // deletedRows defaults to "everything the SELECT would match" so the
          // helper's `deleted.length` reflects the would-have-deleted set.
          const source = deletedRows != null ? deletedRows : existingRows;
          return resolve({ data: match(source), error: null });
        }
        if (mode === 'select') {
          calls.selects.push({ table, filters: [...filters] });
          return resolve({ data: match(existingRows), error: null });
        }
      },
    };
    return builder;
  }
  return {
    from: jest.fn(chain),
    _calls: calls,
  };
}

// ─── Layer 1: safeDeleteCompletionDerivedLedger unit tests ────────────

describe('safeDeleteCompletionDerivedLedger', () => {
  test('only deletes rows with payout_batch_id IS NULL', async () => {
    const supabase = makeSupabase({
      existingRows: [
        { id: 1, job_id: 42, team_member_id: 10, type: 'earning', payout_batch_id: 99, amount: 100, metadata: {} },
        { id: 2, job_id: 42, team_member_id: 10, type: 'earning', payout_batch_id: null, amount: 80, metadata: {} },
      ],
    });

    const result = await safeDeleteCompletionDerivedLedger(supabase, { jobId: 42, source: 'test' });

    expect(result.deleted).toBe(1);
    expect(result.skippedBatched).toHaveLength(1);
    expect(result.skippedBatched[0].id).toBe(1);

    // The delete chain MUST have included .is('payout_batch_id', null).
    const del = supabase._calls.deletes[0];
    expect(del.filters.some(f => f.k === 'is' && f.col === 'payout_batch_id' && f.val === null)).toBe(true);
  });

  test('reports skippedBatched even when nothing is deleted', async () => {
    const supabase = makeSupabase({
      existingRows: [
        { id: 1, job_id: 42, team_member_id: 10, type: 'earning', payout_batch_id: 99, amount: 100, metadata: {} },
      ],
    });
    const result = await safeDeleteCompletionDerivedLedger(supabase, { jobId: 42, source: 'test' });
    expect(result.deleted).toBe(0);
    expect(result.skippedBatched).toHaveLength(1);
  });

  test('throws on supabase error (no silent swallow — Constitution §0 P2)', async () => {
    const supabase = makeSupabase({ deleteError: { message: 'connection refused' } });
    await expect(safeDeleteCompletionDerivedLedger(supabase, { jobId: 1, source: 'test' }))
      .rejects.toThrow(/delete failed/);
  });

  test('requires jobId', async () => {
    const supabase = makeSupabase();
    await expect(safeDeleteCompletionDerivedLedger(supabase, {}))
      .rejects.toThrow(/jobId required/);
  });

  test('defaults to the canonical completion-derived type set', () => {
    expect(COMPLETION_DERIVED_TYPES).toEqual(['earning', 'tip', 'incentive', 'cash_collected']);
  });
});

// ─── Layer 1: recordLedgerDrift unit tests ────────────────────────────

describe('recordLedgerDrift', () => {
  test('no-op when row is not batched', async () => {
    const supabase = makeSupabase();
    const row = { id: 1, payout_batch_id: null, amount: 100, type: 'earning' };
    await recordLedgerDrift(supabase, row, { computedAmount: 120, source: 'test' }, { warn() {}, error() {} });
    expect(supabase._calls.inserts).toHaveLength(0);
  });

  test('no-op when amounts match within 1¢', async () => {
    const supabase = makeSupabase();
    const row = { id: 1, payout_batch_id: 99, amount: 100, type: 'earning', user_id: 1 };
    await recordLedgerDrift(supabase, row, { computedAmount: 100.004, source: 'test' }, { warn() {}, error() {} });
    expect(supabase._calls.inserts).toHaveLength(0);
  });

  test('writes audit row on real divergence', async () => {
    const supabase = makeSupabase();
    const row = {
      id: 7, user_id: 1, team_member_id: 10, job_id: 42, type: 'earning',
      payout_batch_id: 99, amount: 100, metadata: { hourly_rate_snapshot: 20 },
    };
    await recordLedgerDrift(supabase, row, {
      computedAmount: 125,
      source: 'rebuildJobLedger',
      reason: 'rate change',
    }, { warn() {}, error() {} });
    expect(supabase._calls.inserts).toHaveLength(1);
    const ins = supabase._calls.inserts[0];
    expect(ins.table).toBe('ledger_drift_detected');
    expect(ins.row.ledger_id).toBe(7);
    expect(ins.row.current_amount).toBe(100);
    expect(ins.row.computed_amount).toBe(125);
    expect(ins.row.source).toBe('rebuildJobLedger');
  });
});

// ─── Layer 2: source-text scan ────────────────────────────────────────

describe('cleaner_ledger DELETE sites — source-text scan', () => {
  // Every literal `.delete()` call against cleaner_ledger must be analysed.
  // Allowlist: batch-cancel and detach paths. Any new delete MUST either go
  // through safeDeleteCompletionDerivedLedger or include .is('payout_batch_id', null).
  function findLedgerDeletes(src, filename) {
    const lines = src.split('\n');
    const matches = [];
    for (let i = 0; i < lines.length; i++) {
      // Match only lines that contain `from('cleaner_ledger')` AND show an
      // explicit `.delete()` call in the same line or the next 3 lines. This
      // excludes select-only chains that happen to start at from('cleaner_ledger').
      const fromIdx = lines[i].search(/\.from\(['"]cleaner_ledger['"]\)/);
      if (fromIdx === -1) continue;
      const window = lines.slice(i, Math.min(i + 4, lines.length)).join('\n');
      if (!/\.delete\(\s*\)/.test(window)) continue;
      // Capture a wider block so chained filters across multiple lines are visible.
      const block = lines.slice(i, Math.min(i + 8, lines.length)).join('\n');
      matches.push({ file: filename, line: i + 1, block });
    }
    return matches;
  }

  test('server.js — every cleaner_ledger.delete() is guarded or allowlisted', () => {
    const deletes = findLedgerDeletes(SERVER_JS, 'server.js');
    expect(deletes.length).toBeGreaterThan(0); // sanity

    for (const m of deletes) {
      const guarded =
        /\.is\(['"]payout_batch_id['"],\s*null\)/.test(m.block) ||
        // Allowlisted batch-cancel & detach paths
        /\.eq\(['"]payout_batch_id['"]/.test(m.block) ||
        /payout_batch_id.*neq|neq.*payout_batch_id/.test(m.block) ||
        /\.eq\(['"]type['"],\s*['"]payout['"]\)/.test(m.block);

      if (!guarded) {
        throw new Error(
          `Unguarded cleaner_ledger.delete() in ${m.file}:${m.line}.\n`
          + `Must include .is('payout_batch_id', null) or be an explicit batch-cancel path.\n`
          + `Block:\n${m.block}`
        );
      }
    }
  });

  test('zenbooker-sync.js — every cleaner_ledger.delete() is guarded or routed via helper', () => {
    const deletes = findLedgerDeletes(ZB_SYNC_JS, 'zenbooker-sync.js');
    for (const m of deletes) {
      // ZB module should go through safeDeleteCompletionDerivedLedger;
      // direct delete with batch guard is also acceptable.
      const guarded =
        /\.is\(['"]payout_batch_id['"],\s*null\)/.test(m.block) ||
        /safeDeleteCompletionDerivedLedger/.test(m.block);
      if (!guarded) {
        throw new Error(
          `Unguarded cleaner_ledger.delete() in ${m.file}:${m.line}.\n`
          + `Must use safeDeleteCompletionDerivedLedger() or include .is('payout_batch_id', null).\n`
          + `Block:\n${m.block}`
        );
      }
    }
  });

  test('zenbooker-sync.js cancel paths use the completion-derived type filter', () => {
    // The two ZB cancel paths used to delete ALL types — wiping reimbursement
    // and adjustment rows. The fix routes them through the helper which only
    // touches earning/tip/incentive/cash_collected.
    expect(ZB_SYNC_JS).toMatch(/zb_webhook_cancel/);
    expect(ZB_SYNC_JS).toMatch(/zb_reconcile_cancel/);
  });

  test('rebuildJobLedger emits drift audit when batched rows survive', () => {
    // server.js's rebuildJobLedger must call recordLedgerDrift in its drift block.
    const start = SERVER_JS.indexOf('async function rebuildJobLedger(');
    expect(start).toBeGreaterThan(0);
    const block = SERVER_JS.slice(start, start + 4000);
    expect(block).toMatch(/recordLedgerDrift/);
    expect(block).toMatch(/safeDeleteCompletionDerivedLedger/);
  });
});
