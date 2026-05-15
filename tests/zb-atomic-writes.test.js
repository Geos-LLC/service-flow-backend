/**
 * P1.3 (Synchronization Constitution §6.2) — atomic financial-write tests.
 *
 * Three layers:
 *   1. Unit tests for lib/zb-atomic-writes.js (sanitizers, helper contract,
 *      RPC error handling, never-throws-back).
 *   2. Source-text scan asserting the three multi-write paths in
 *      zenbooker-sync.js now call applyAtomicPaymentWrites instead of
 *      separate supabase.from('jobs').update + .from('transactions').insert.
 *   3. The invariants demanded by the spec (replay idempotency, tenant
 *      scope, rollback-on-failure) are pinned via the source-text scan +
 *      the RPC function shape (migration 041 enforces atomicity at the DB).
 *
 * The actual transactional behavior — RAISE inside the function rolls back
 * every write — is a Postgres language guarantee, not something we can
 * stub with a mock without re-implementing plpgsql semantics. Staging
 * synthetic verification covers that part.
 */

const fs = require('fs');
const path = require('path');

const {
  applyAtomicPaymentWrites,
  sanitizeJobUpdates,
  sanitizeTxArray,
  VALID_JOB_FIELDS,
  VALID_TX_FIELDS,
} = require('../lib/zb-atomic-writes');

const ZB_SYNC_JS = fs.readFileSync(path.join(__dirname, '..', 'zenbooker-sync.js'), 'utf8');
const MIGRATION_SQL = fs.readFileSync(
  path.join(__dirname, '..', 'migrations', '041_zb_apply_payment_writes.sql'),
  'utf8'
);

// ─── Unit: sanitizers ────────────────────────────────────────────────

describe('sanitizeJobUpdates', () => {
  test('keeps only whitelisted keys', () => {
    const out = sanitizeJobUpdates({
      payment_status: 'paid',
      payment_method: 'cash',
      status: 'completed',           // NOT in whitelist
      service_price: 100,
      arbitrary_field: 'evil',
    });
    expect(out).toEqual({ payment_status: 'paid', payment_method: 'cash', service_price: 100 });
  });

  test('returns null when nothing whitelisted', () => {
    expect(sanitizeJobUpdates({ status: 'completed', team_member_id: 7 })).toBe(null);
    expect(sanitizeJobUpdates({})).toBe(null);
    expect(sanitizeJobUpdates(null)).toBe(null);
  });

  test('drops undefined values (caller-side noop semantics)', () => {
    const out = sanitizeJobUpdates({ payment_status: 'paid', payment_method: undefined });
    expect(out).toEqual({ payment_status: 'paid' });
  });
});

describe('sanitizeTxArray', () => {
  test('keeps whitelisted tx fields, drops the rest', () => {
    const out = sanitizeTxArray([
      { amount: 50, payment_method: 'cash', user_id: 99, zenbooker_id: 'zb-x', evil_field: 1 },
    ]);
    expect(out).toEqual([{ amount: 50, payment_method: 'cash', zenbooker_id: 'zb-x' }]);
    // user_id intentionally dropped — caller passes p_user_id separately.
    expect(out[0].user_id).toBeUndefined();
  });

  test('non-array input → empty', () => {
    expect(sanitizeTxArray(null)).toEqual([]);
    expect(sanitizeTxArray({})).toEqual([]);
  });
});

// ─── Unit: applyAtomicPaymentWrites ───────────────────────────────────

function makeRpcSupabase(impl) {
  return {
    rpc: jest.fn(async (name, args) => impl(name, args)),
  };
}

function makeLogger() {
  const lines = [];
  return {
    lines,
    warn: (m) => lines.push(['warn', m]),
    error: (m) => lines.push(['error', m]),
    log: (m) => lines.push(['log', m]),
  };
}

describe('applyAtomicPaymentWrites', () => {
  test('rejects missing userId', async () => {
    const supabase = makeRpcSupabase(() => ({ data: null, error: null }));
    const r = await applyAtomicPaymentWrites(supabase, { sfJobId: 1, jobUpdates: { payment_status: 'paid' } });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('INVALID_INPUT');
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  test('rejects jobUpdates without sfJobId', async () => {
    const supabase = makeRpcSupabase(() => ({ data: null, error: null }));
    const r = await applyAtomicPaymentWrites(supabase, { userId: 2, jobUpdates: { payment_status: 'paid' } });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('INVALID_INPUT');
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  test('noop when no jobUpdates and empty txArray (does not hit DB)', async () => {
    const supabase = makeRpcSupabase(() => ({ data: { committed: true }, error: null }));
    const r = await applyAtomicPaymentWrites(supabase, { userId: 2 });
    expect(r.ok).toBe(true);
    expect(r.result.noop).toBe(true);
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  test('calls RPC with sanitized inputs', async () => {
    const supabase = makeRpcSupabase((name, args) => {
      return { data: { committed: true, jobs_updated: 1, tx_actions: [{ tx_id: 5, action: 'inserted' }] }, error: null };
    });
    const r = await applyAtomicPaymentWrites(supabase, {
      userId: 2, sfJobId: 99,
      jobUpdates: { payment_status: 'paid', evil_field: 'x' },
      txDataArray: [{ amount: 10, payment_method: 'cash', user_id: 999, evil: 1 }],
    });
    expect(r.ok).toBe(true);
    expect(supabase.rpc).toHaveBeenCalledWith('zb_apply_payment_writes', expect.objectContaining({
      p_user_id: 2,
      p_sf_job_id: 99,
      p_job_updates: { payment_status: 'paid' },  // evil_field dropped
      p_tx_data_array: [{ amount: 10, payment_method: 'cash' }], // user_id + evil dropped
    }));
  });

  test('returns ok:false with structured error on RPC error', async () => {
    const supabase = makeRpcSupabase(() => ({
      data: null,
      error: { code: 'P0002', message: 'job 99 not found or not owned by user 2' },
    }));
    const logger = makeLogger();
    const r = await applyAtomicPaymentWrites(supabase, {
      userId: 2, sfJobId: 99, jobUpdates: { payment_status: 'paid' }, logger,
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('P0002');
    expect(r.error.message).toMatch(/not owned by user/);
    expect(logger.lines.find(([lvl, msg]) => lvl === 'warn' && msg.includes('ZB-atomic-rpc-failed'))).toBeDefined();
  });

  test('never throws — uncaught exception returns ok:false', async () => {
    const supabase = { rpc: jest.fn(() => { throw new Error('connection lost'); }) };
    const logger = makeLogger();
    const r = await applyAtomicPaymentWrites(supabase, {
      userId: 2, sfJobId: 1, jobUpdates: { payment_status: 'paid' }, logger,
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('UNCAUGHT');
    expect(r.error.message).toBe('connection lost');
  });

  test('emits structured log on success', async () => {
    const supabase = makeRpcSupabase(() => ({
      data: { committed: true, jobs_updated: 1, tx_actions: [{ action: 'inserted' }] },
      error: null,
    }));
    const logger = makeLogger();
    await applyAtomicPaymentWrites(supabase, {
      userId: 2, sfJobId: 1, jobUpdates: { payment_status: 'paid' }, logger,
    });
    const logLine = logger.lines.find(([lvl, msg]) => lvl === 'log' && msg.includes('[ZB-atomic]') && msg.includes('committed'));
    expect(logLine).toBeDefined();
  });
});

// ─── Source-text scan: ZB sync now uses the helper ────────────────────

describe('zenbooker-sync.js — multi-write paths route via applyAtomicPaymentWrites', () => {
  test('imports the atomic helper', () => {
    expect(ZB_SYNC_JS).toMatch(/require\(['"]\.\/lib\/zb-atomic-writes['"]\)/);
  });

  test('handlePaymentEvent paid path calls applyAtomicPaymentWrites', () => {
    const start = ZB_SYNC_JS.indexOf('async function handlePaymentEvent');
    expect(start).toBeGreaterThan(0);
    const end = ZB_SYNC_JS.indexOf('async function ', start + 50);
    const block = ZB_SYNC_JS.slice(start, end === -1 ? ZB_SYNC_JS.length : end);
    expect(block).toMatch(/applyAtomicPaymentWrites/);
    // The smoking-gun anti-pattern from D9: separate jobs.update + transactions.insert
    // No longer present in the paid path.
    expect(block).not.toMatch(/Update job status FIRST so paid state reflects/);
  });

  test('handleJobEvent fallback tx flow calls applyAtomicPaymentWrites', () => {
    // The fallback loop sits inside handleJobEvent.
    const fallbackBlock = ZB_SYNC_JS.match(/Fallback: ZB doesn't reliably[\s\S]{200,5000}?(?=\n {4,6}\}[^\n]*\n)/);
    expect(fallbackBlock).not.toBeNull();
    expect(fallbackBlock[0]).toMatch(/applyAtomicPaymentWrites/);
  });

  test('syncTransactions iteration loop calls applyAtomicPaymentWrites', () => {
    const start = ZB_SYNC_JS.indexOf('async function syncTransactions');
    expect(start).toBeGreaterThan(0);
    const end = ZB_SYNC_JS.indexOf('async function ', start + 50);
    const block = ZB_SYNC_JS.slice(start, end === -1 ? ZB_SYNC_JS.length : end);
    expect(block).toMatch(/applyAtomicPaymentWrites/);
    // The old two-write pattern should be gone — no more bare jobs.update
    // immediately followed by transactions.update/insert in the loop.
    // (The function still has unrelated DB writes outside the per-tx loop,
    //  so we don't ban supabase.from entirely.)
  });

  test('runPaymentReconcile uses one atomic call covering ALL txs + job update', () => {
    const start = ZB_SYNC_JS.indexOf('async function runPaymentReconcile');
    expect(start).toBeGreaterThan(0);
    const block = ZB_SYNC_JS.slice(start, start + 10000);
    expect(block).toMatch(/applyAtomicPaymentWrites/);
    // The audit row INSERT MUST happen AFTER the atomic block — verify
    // ordering by index. (The earlier .from('payment_reconcile_catches')
    // is the dedup SELECT; we want the insert specifically.)
    const atomicIdx = block.indexOf('applyAtomicPaymentWrites');
    const auditInsertIdx = block.search(/from\(['"]payment_reconcile_catches['"]\)\s*\.insert/);
    expect(atomicIdx).toBeGreaterThan(0);
    expect(auditInsertIdx).toBeGreaterThan(atomicIdx);
  });

  test('failure of an atomic call markDirty\'s instead of swallowing', () => {
    // Every applyAtomicPaymentWrites call site must check atomicResult.ok and
    // call markDirty on the false branch.
    const callSites = [...ZB_SYNC_JS.matchAll(/applyAtomicPaymentWrites\(/g)];
    expect(callSites.length).toBeGreaterThanOrEqual(3);
    for (const m of callSites) {
      // Window of next 800 chars after each call site
      const window = ZB_SYNC_JS.slice(m.index, m.index + 1200);
      const hasOkCheck = /\.ok\b/.test(window) || /atomicResult\.ok|reconcileAtomic\.ok/.test(window);
      const hasMarkDirty = window.includes('markDirty(');
      if (!hasOkCheck || !hasMarkDirty) {
        throw new Error(`atomic call at index ${m.index} missing ok-check or markDirty fallback:\n${window.slice(0, 400)}`);
      }
    }
  });

  test('every atomic call passes userId (tenant scope at SQL layer)', () => {
    const callSites = [...ZB_SYNC_JS.matchAll(/applyAtomicPaymentWrites\(supabase,\s*\{([^}]*?(?:\{[^}]*\}[^}]*?)*)\}/g)];
    expect(callSites.length).toBeGreaterThan(0);
    for (const m of callSites) {
      if (!/userId/.test(m[1])) {
        throw new Error(`applyAtomicPaymentWrites call missing userId: ${m[0].slice(0, 300)}`);
      }
    }
  });
});

// ─── Migration 041 invariants ────────────────────────────────────────

describe('migration 041 — zb_apply_payment_writes function shape', () => {
  test('tenant scope guard fires before any write', () => {
    expect(MIGRATION_SQL).toMatch(/Tenant scope guard/i);
    expect(MIGRATION_SQL).toMatch(/RAISE EXCEPTION[\s\S]{1,200}not found or not owned by user/);
  });

  test('only payment-related job columns are writable (whitelist enumerated)', () => {
    // Function MUST list payment_status (the original D9 column).
    expect(MIGRATION_SQL).toMatch(/payment_status\s*=\s*COALESCE/);
    expect(MIGRATION_SQL).toMatch(/invoice_status\s*=\s*COALESCE/);
    expect(MIGRATION_SQL).toMatch(/payment_method\s*=\s*COALESCE/);
    // Function MUST NOT update the status column (lifecycle owned by separate path)
    expect(MIGRATION_SQL).not.toMatch(/UPDATE jobs[\s\S]{1,100}\sstatus\s*=\s*COALESCE/);
  });

  test('tx upsert ladder: update-by-zb-id → adopt-manual → insert', () => {
    expect(MIGRATION_SQL).toMatch(/3a:.*update by zenbooker_id/i);
    expect(MIGRATION_SQL).toMatch(/3b:.*adopt manual/i);
    expect(MIGRATION_SQL).toMatch(/3c:.*INSERT/);
  });

  test('cross-tx tenant guard on per-tx job_id', () => {
    expect(MIGRATION_SQL).toMatch(/tx job % not owned by user/);
  });

  test('GRANT EXECUTE to service_role', () => {
    expect(MIGRATION_SQL).toMatch(/GRANT EXECUTE ON FUNCTION zb_apply_payment_writes[\s\S]*service_role/);
  });
});
