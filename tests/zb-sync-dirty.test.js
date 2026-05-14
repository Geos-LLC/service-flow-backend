/**
 * P1.2 (Constitution §0 P2 + §6.2 + §6.6) — ZB sync dirty marker tests.
 *
 * Three layers:
 *   1. Unit tests for the helper (markDirty / resolveDirty / classifiers).
 *   2. A source-text scan asserting that the silent catches identified in
 *      the P1.2 inventory are gone from zenbooker-sync.js.
 *   3. Invariant assertions on the helper contract (idempotency, tenant
 *      scope, retryability classification, structured-log emission).
 */

const fs = require('fs');
const path = require('path');

const {
  VALID_OPERATIONS,
  classifyRetryable,
  classifyErrorClass,
  markDirty,
  resolveDirty,
} = require('../lib/zb-dirty-marker');

const ZB_SYNC_JS = fs.readFileSync(path.join(__dirname, '..', 'zenbooker-sync.js'), 'utf8');

// ─── Mock Supabase chain (first-write-wins mode; supports update + insert + select) ──

function makeSupabase({ rows = [], insertError = null, updateError = null, selectError = null } = {}) {
  let nextId = (rows.reduce((m, r) => Math.max(m, r.id || 0), 0)) + 1;
  const calls = { inserts: [], updates: [], selects: [] };

  function chain(table) {
    let mode = null;        // 'select' | 'update' | 'insert' | 'delete'
    let payload = null;
    const filters = [];
    function setMode(m) { if (!mode) mode = m; }
    function match(r) {
      return filters.every(f => {
        if (f.k === 'eq') return r[f.col] === f.val;
        if (f.k === 'is') return f.val === null ? (r[f.col] == null) : r[f.col] === f.val;
        if (f.k === 'in') return Array.isArray(f.val) && f.val.includes(r[f.col]);
        return true;
      });
    }
    const builder = {
      select() { setMode('select'); return builder; },
      update(p) { setMode('update'); payload = p; return builder; },
      insert(p) { setMode('insert'); payload = p; return builder; },
      delete() { setMode('delete'); return builder; },
      eq(col, val) { filters.push({ k: 'eq', col, val }); return builder; },
      is(col, val) { filters.push({ k: 'is', col, val }); return builder; },
      in(col, val) { filters.push({ k: 'in', col, val }); return builder; },
      not() { return builder; },
      order() { return builder; },
      limit() { return builder; },
      single() { return builder; },
      maybeSingle() { return builder; },
      then(resolve) {
        if (mode === 'select') {
          calls.selects.push({ table, filters: [...filters] });
          if (selectError) return resolve({ data: null, error: selectError });
          const matched = rows.filter(r => r._table === table && match(r));
          return resolve({ data: matched.length ? matched[0] : null, error: null });
        }
        if (mode === 'update') {
          calls.updates.push({ table, filters: [...filters], payload });
          if (updateError) return resolve({ data: null, error: updateError });
          const updated = [];
          for (const r of rows) {
            if (r._table !== table) continue;
            if (match(r)) {
              Object.assign(r, payload);
              updated.push(r);
            }
          }
          return resolve({ data: updated, error: null });
        }
        if (mode === 'insert') {
          calls.inserts.push({ table, payload });
          if (insertError) return resolve({ data: null, error: insertError });
          const row = { _table: table, id: nextId++, ...payload };
          rows.push(row);
          return resolve({ data: row, error: null });
        }
      },
    };
    return builder;
  }
  return { from: jest.fn(chain), _calls: calls, _rows: rows };
}

function makeLogger() {
  const lines = [];
  return {
    lines,
    warn: (msg) => lines.push(['warn', msg]),
    error: (msg) => lines.push(['error', msg]),
    log: (msg) => lines.push(['log', msg]),
  };
}

// ─── Unit tests: classifiers ──────────────────────────────────────────

describe('classifyRetryable', () => {
  test('network/transient errors → true', () => {
    expect(classifyRetryable(new Error('socket hang up'))).toBe(true);
    expect(classifyRetryable(new Error('ETIMEDOUT during request'))).toBe(true);
    expect(classifyRetryable(new Error('503 service unavailable'))).toBe(true);
    expect(classifyRetryable(new Error('fetch failed'))).toBe(true);
  });

  test('schema/constraint errors → false', () => {
    expect(classifyRetryable(new Error('unique constraint violation'))).toBe(false);
    expect(classifyRetryable(new Error('duplicate key value'))).toBe(false);
    expect(classifyRetryable(new Error('null value violates not null'))).toBe(false);
    expect(classifyRetryable(new Error('invalid input syntax'))).toBe(false);
  });

  test('unknown classes → null', () => {
    expect(classifyRetryable(new Error('something weird'))).toBe(null);
    expect(classifyRetryable(null)).toBe(null);
  });
});

describe('classifyErrorClass', () => {
  test('PostgREST error code wins', () => {
    expect(classifyErrorClass({ code: '23505', message: 'unique' })).toBe('23505');
  });
  test('error.name when not Error', () => {
    const e = new TypeError('bad type');
    expect(classifyErrorClass(e)).toBe('TypeError');
  });
  test('plain Error falls through', () => {
    expect(classifyErrorClass(new Error('x'))).toBe('Error');
  });
  test('null → null', () => {
    expect(classifyErrorClass(null)).toBe(null);
  });
});

// ─── Unit tests: markDirty ────────────────────────────────────────────

describe('markDirty', () => {
  test('rejects when userId missing', async () => {
    const supabase = makeSupabase();
    const logger = makeLogger();
    const r = await markDirty(supabase, { sfJobId: 1, operation: 'customer_link', error: new Error('x'), logger });
    expect(r.action).toBe('invalid');
    expect(r.error).toMatch(/userId/);
  });

  test('rejects invalid operation', async () => {
    const supabase = makeSupabase();
    const logger = makeLogger();
    const r = await markDirty(supabase, { userId: 2, sfJobId: 1, operation: 'made_up', error: new Error('x'), logger });
    expect(r.action).toBe('invalid');
    expect(r.error).toMatch(/operation/);
  });

  test('rejects when neither sfJobId nor zenbookerId provided', async () => {
    const supabase = makeSupabase();
    const logger = makeLogger();
    const r = await markDirty(supabase, { userId: 2, operation: 'customer_link', error: new Error('x'), logger });
    expect(r.action).toBe('invalid');
  });

  test('inserts new row when none exists', async () => {
    const supabase = makeSupabase();
    const logger = makeLogger();
    const r = await markDirty(supabase, {
      userId: 2, sfJobId: 99, zenbookerId: 'zb-x',
      operation: 'ledger_rebuild', error: new Error('boom'), logger,
    });
    expect(r.action).toBe('inserted');
    expect(supabase._calls.inserts).toHaveLength(1);
    const inserted = supabase._calls.inserts[0].payload;
    expect(inserted.user_id).toBe(2);
    expect(inserted.sf_job_id).toBe(99);
    expect(inserted.zenbooker_id).toBe('zb-x');
    expect(inserted.operation).toBe('ledger_rebuild');
    expect(inserted.error_message).toBe('boom');
  });

  test('idempotent: existing open row → update + attempts++', async () => {
    const existing = {
      _table: 'zb_sync_dirty',
      id: 7, user_id: 2, sf_job_id: 99, zenbooker_id: 'zb-x',
      operation: 'ledger_rebuild', attempts: 3, resolved_at: null,
    };
    const supabase = makeSupabase({ rows: [existing] });
    const logger = makeLogger();
    const r = await markDirty(supabase, {
      userId: 2, sfJobId: 99, zenbookerId: 'zb-x',
      operation: 'ledger_rebuild', error: new Error('again'), logger,
    });
    expect(r.action).toBe('updated');
    expect(r.id).toBe(7);
    expect(supabase._calls.inserts).toHaveLength(0);
    expect(existing.attempts).toBe(4);
    expect(existing.error_message).toBe('again');
  });

  test('a resolved row does not block a new mark — inserts again', async () => {
    const resolved = {
      _table: 'zb_sync_dirty',
      id: 7, user_id: 2, sf_job_id: 99,
      operation: 'ledger_rebuild', attempts: 1,
      resolved_at: '2026-01-01T00:00:00Z',
    };
    const supabase = makeSupabase({ rows: [resolved] });
    const logger = makeLogger();
    const r = await markDirty(supabase, {
      userId: 2, sfJobId: 99, operation: 'ledger_rebuild', error: new Error('x'), logger,
    });
    expect(r.action).toBe('inserted');
    expect(supabase._calls.inserts).toHaveLength(1);
  });

  test('race-vs-unique fallback: insert hits 23505 → recover via update', async () => {
    // Hand-rolled minimal supabase: SELECT call 1 returns null (we're the
    // first attempt, no row yet), INSERT fails with 23505 (concurrent
    // insert won), SELECT call 2 returns the race-winner row, UPDATE
    // applies attempts++.
    const race = { id: 42, user_id: 2, sf_job_id: 1, operation: 'customer_link', attempts: 1, resolved_at: null };
    let selectCount = 0;
    let updatedRow = null;
    const supabase = {
      from: () => {
        let mode = null;
        let payload = null;
        const builder = {
          select() { if (!mode) mode = 'select'; return builder; },
          insert(p) { if (!mode) { mode = 'insert'; payload = p; } return builder; },
          update(p) { if (!mode) { mode = 'update'; payload = p; } return builder; },
          eq() { return builder; }, is() { return builder; }, in() { return builder; },
          not() { return builder; }, order() { return builder; }, limit() { return builder; },
          single() { return builder; }, maybeSingle() { return builder; },
          then(resolve) {
            if (mode === 'select') {
              selectCount++;
              if (selectCount === 1) return resolve({ data: null, error: null });
              return resolve({ data: { ...race }, error: null });
            }
            if (mode === 'insert') {
              return resolve({ data: null, error: { code: '23505', message: 'duplicate key value violates unique' } });
            }
            if (mode === 'update') {
              updatedRow = { ...race, ...payload };
              return resolve({ data: [updatedRow], error: null });
            }
          },
        };
        return builder;
      },
    };
    const logger = makeLogger();
    const r = await markDirty(supabase, {
      userId: 2, sfJobId: 1, operation: 'customer_link',
      error: new Error('boom'), logger,
    });
    expect(r.action).toBe('updated_after_race');
    expect(r.id).toBe(42);
    expect(updatedRow.attempts).toBe(2);
  });

  test('emits structured warn log line on every call', async () => {
    const supabase = makeSupabase();
    const logger = makeLogger();
    await markDirty(supabase, {
      userId: 7, sfJobId: 33, zenbookerId: 'zb-y',
      operation: 'zb_job_fetch', error: new Error('timeout'), logger,
    });
    const line = logger.lines.find(([lvl, msg]) => lvl === 'warn' && msg.startsWith('[ZB-dirty]'));
    expect(line).toBeDefined();
    expect(line[1]).toMatch(/user_id=7/);
    expect(line[1]).toMatch(/sf_job_id=33/);
    expect(line[1]).toMatch(/zenbooker_id=zb-y/);
    expect(line[1]).toMatch(/operation=zb_job_fetch/);
    expect(line[1]).toMatch(/retryable=true/);  // timeout → retryable=true
    expect(line[1]).toMatch(/message=timeout/);
  });

  test('never crashes the caller even on DB explosion', async () => {
    const supabase = {
      from: () => { throw new Error('DB unreachable'); },
    };
    const logger = makeLogger();
    const r = await markDirty(supabase, {
      userId: 2, sfJobId: 1, operation: 'customer_link', error: new Error('x'), logger,
    });
    expect(r.action).toBe('crashed');
    expect(r.error).toMatch(/DB unreachable/);
    // The warn log still fired BEFORE the crash — that's the floor of observability.
    const warnLine = logger.lines.find(([lvl]) => lvl === 'warn');
    expect(warnLine).toBeDefined();
  });

  test('tenant scope: rows for other users not returned by SELECT', async () => {
    const otherUserRow = {
      _table: 'zb_sync_dirty',
      id: 10, user_id: 99, sf_job_id: 1,
      operation: 'customer_link', attempts: 1, resolved_at: null,
    };
    const supabase = makeSupabase({ rows: [otherUserRow] });
    const logger = makeLogger();
    const r = await markDirty(supabase, {
      userId: 2, sfJobId: 1, operation: 'customer_link',
      error: new Error('x'), logger,
    });
    // Should INSERT a new row for user 2, NOT update user 99's row.
    expect(r.action).toBe('inserted');
    expect(otherUserRow.attempts).toBe(1); // unchanged
  });
});

// ─── Unit tests: resolveDirty ─────────────────────────────────────────

describe('resolveDirty', () => {
  test('no-op when userId missing', async () => {
    const supabase = makeSupabase();
    const r = await resolveDirty(supabase, { sfJobId: 1, operation: 'customer_link' });
    expect(r.action).toBe('noop');
  });

  test('no-op when neither sfJobId nor zenbookerId provided', async () => {
    const supabase = makeSupabase();
    const r = await resolveDirty(supabase, { userId: 2, operation: 'customer_link' });
    expect(r.action).toBe('noop');
  });

  test('updates resolved_at on matching open row', async () => {
    const open = {
      _table: 'zb_sync_dirty',
      id: 7, user_id: 2, sf_job_id: 1,
      operation: 'customer_link', resolved_at: null,
    };
    const supabase = makeSupabase({ rows: [open] });
    const r = await resolveDirty(supabase, {
      userId: 2, sfJobId: 1, operation: 'customer_link', note: 'fixed',
    });
    expect(r.action).toBe('resolved');
    expect(open.resolved_at).not.toBeNull();
    expect(open.resolved_by).toBe('auto:retry_success');
    expect(open.resolution_note).toBe('fixed');
  });

  test('tenant-scoped: does not resolve another tenant\'s open row', async () => {
    const open = {
      _table: 'zb_sync_dirty',
      id: 7, user_id: 99, sf_job_id: 1,
      operation: 'customer_link', resolved_at: null,
    };
    const supabase = makeSupabase({ rows: [open] });
    const r = await resolveDirty(supabase, { userId: 2, sfJobId: 1, operation: 'customer_link' });
    expect(r.action).toBe('resolved');
    expect(r.count).toBe(0);
    expect(open.resolved_at).toBeNull(); // unchanged
  });
});

// ─── Source-text scan: silent catches in zenbooker-sync.js are gone ───

describe('zenbooker-sync.js — silent catches eliminated (P1.2 inventory)', () => {
  // The 10 originally-silent sites listed in the P1.2 audit:
  //   678, 698, 719  — .catch(() => {}) on jobs.update payment_method
  //   894           — catch { /* customer sync failed */ } customer link
  //   1026, 1029    — .catch(() => {}) on jobs.update payment_status
  //   1097          — .catch(() => null) on zbFetch financial refresh
  //   1163          — try {...} catch (_) {} ledger rebuild (voided tx)
  //   1230          — try {...} catch (_) {} zbFetch tx full
  //   1287          — try {...} catch (_) {} ledger rebuild (auto-reconcile)

  test('no .catch(() => {}) anywhere in zenbooker-sync.js', () => {
    // Catches THE specific anti-pattern. Empty arrow returns.
    const matches = ZB_SYNC_JS.match(/\.catch\(\s*\(\)\s*=>\s*\{\s*\}\s*\)/g);
    if (matches) {
      throw new Error(
        `Found ${matches.length} silent .catch(() => {}) patterns. P1.2 requires every silent swallow to be replaced with markDirty.`
      );
    }
  });

  test('no .catch(() => null) anywhere in zenbooker-sync.js', () => {
    const matches = ZB_SYNC_JS.match(/\.catch\(\s*\(\)\s*=>\s*null\s*\)/g);
    if (matches) {
      throw new Error(
        `Found ${matches.length} .catch(() => null) — replace with explicit try/catch + markDirty + null fallback.`
      );
    }
  });

  test('no catch (_) {} empty bodies', () => {
    const matches = ZB_SYNC_JS.match(/catch\s*\(_\)\s*\{\s*\}/g);
    if (matches) {
      throw new Error(
        `Found ${matches.length} catch (_) {} empty bodies — replace with markDirty.`
      );
    }
  });

  test('no catch { /* ... */ } empty-by-comment bodies', () => {
    // The customer-sync silent catch was: catch { /* customer sync failed, continue without linking */ }
    // Match catch blocks whose body is entirely a comment.
    const matches = ZB_SYNC_JS.match(/catch\s*(?:\([^)]*\)\s*)?\{\s*\/\*[^*]*\*\/\s*\}/g);
    if (matches) {
      throw new Error(
        `Found ${matches.length} comment-only catch bodies — replace with markDirty.`
      );
    }
  });

  test('imports markDirty + resolveDirty helpers', () => {
    expect(ZB_SYNC_JS).toMatch(/require\(['"]\.\/lib\/zb-dirty-marker['"]\)/);
    expect(ZB_SYNC_JS).toMatch(/\bmarkDirty\b/);
    expect(ZB_SYNC_JS).toMatch(/\bresolveDirty\b/);
  });

  test('each P1.2 operation appears at least once as a markDirty call', () => {
    for (const op of VALID_OPERATIONS) {
      const re = new RegExp(`operation:\\s*['"]${op}['"]`);
      if (!re.test(ZB_SYNC_JS)) {
        throw new Error(`No markDirty call for operation '${op}' found in zenbooker-sync.js.`);
      }
    }
  });

  test('every markDirty call carries userId (tenant scope)', () => {
    // Find all markDirty(...) blocks and assert each contains userId.
    const blocks = ZB_SYNC_JS.matchAll(/markDirty\(supabase,\s*\{([^}]*)\}/g);
    let count = 0;
    for (const m of blocks) {
      count++;
      if (!/userId/.test(m[1])) {
        throw new Error(`markDirty call missing userId: ${m[0].slice(0, 200)}`);
      }
    }
    // Sanity: we expect at least 8 markDirty call sites after P1.2.
    expect(count).toBeGreaterThanOrEqual(8);
  });

  test('every ledger-rebuild path has a markDirty fallback (financial mutation, §3.6)', () => {
    // The rebuildLedger calls in zenbooker-sync.js MUST all be inside try/catch
    // with markDirty on failure. Find every `rebuildLedger(` call and check
    // its surrounding 25 lines for markDirty.
    const lines = ZB_SYNC_JS.split('\n');
    const rebuildLines = [];
    lines.forEach((l, i) => { if (l.includes('rebuildLedger(')) rebuildLines.push(i); });
    expect(rebuildLines.length).toBeGreaterThan(0);
    for (const i of rebuildLines) {
      const window = lines.slice(Math.max(0, i - 5), Math.min(lines.length, i + 20)).join('\n');
      // Skip lines that are clearly inside the fallback helper definition itself.
      if (window.includes("rebuildJobLedger ||")) continue;
      if (!window.includes('markDirty')) {
        throw new Error(
          `rebuildLedger call at line ${i + 1} has no markDirty within 20 lines.\n`
          + `Block:\n${window.slice(0, 500)}`
        );
      }
    }
  });
});

// ─── Operator listing endpoint shape ──────────────────────────────────

describe('GET /api/zenbooker/sync-dirty — operator listing', () => {
  test('endpoint declared with authenticateToken (tenant-scoped)', () => {
    expect(ZB_SYNC_JS).toMatch(/router\.get\(['"]\/sync-dirty['"]\s*,\s*authenticateToken/);
  });

  test('endpoint filters by user_id (no cross-tenant leak)', () => {
    const idx = ZB_SYNC_JS.indexOf("router.get('/sync-dirty'");
    expect(idx).toBeGreaterThan(0);
    const block = ZB_SYNC_JS.slice(idx, idx + 1500);
    expect(block).toMatch(/\.eq\(\s*['"]user_id['"]\s*,\s*userId\)/);
  });

  test('defaults to unresolved only (operator focus)', () => {
    const idx = ZB_SYNC_JS.indexOf("router.get('/sync-dirty'");
    const block = ZB_SYNC_JS.slice(idx, idx + 1500);
    expect(block).toMatch(/includeResolved/);
    expect(block).toMatch(/\.is\(\s*['"]resolved_at['"]\s*,\s*null\)/);
  });
});
