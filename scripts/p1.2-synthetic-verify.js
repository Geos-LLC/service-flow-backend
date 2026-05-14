#!/usr/bin/env node
/**
 * P1.2 staging verification — drives the dirty-marker lifecycle end-to-end
 * against the deployed staging build:
 *
 *   1. POST a synthetic dirty row via markDirty (direct lib call, talking
 *      to the same Supabase the prod-deployed code uses).
 *   2. GET it back through the new /api/zenbooker/sync-dirty endpoint (this
 *      proves the deployed code is serving from the new table).
 *   3. Repeat the markDirty call → assert idempotent (attempts++ on same key).
 *   4. resolveDirty → mark resolved.
 *   5. GET again → should NOT show in default (unresolved) view.
 *   6. Clean up the row.
 *
 * Does NOT trigger a real ZB webhook failure (controlling ZB's responses
 * isn't available); instead it exercises the helper + table + endpoint with
 * the staging-deployed code as the read surface.
 */

'use strict';

const SUPABASE_PROJECT_REF = process.env.SUPABASE_PROJECT_REF || 'ezyhbvskbwmwgwyduqpt';
const SUPABASE_MGMT_TOKEN = process.env.SUPABASE_MGMT_TOKEN;
const JWT_SECRET = process.env.JWT_SECRET;
const STAGING_BASE = process.env.STAGING_BASE || 'https://service-flow-backend-staging-303f.up.railway.app';
const TEST_USER_ID = parseInt(process.env.TEST_USER_ID || '2', 10);

if (!SUPABASE_MGMT_TOKEN) { console.error('SUPABASE_MGMT_TOKEN required'); process.exit(2); }
if (!JWT_SECRET) { console.error('JWT_SECRET required'); process.exit(2); }

const { createClient } = require('@supabase/supabase-js');
const jwt = require('jsonwebtoken');
const { markDirty, resolveDirty } = require('../lib/zb-dirty-marker');

const SUPABASE_URL = `https://${SUPABASE_PROJECT_REF}.supabase.co`;

async function runSql(query) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${SUPABASE_PROJECT_REF}/database/query`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${SUPABASE_MGMT_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  return res.json();
}

async function getSupabaseServiceKey() {
  // We can't access service-role key directly; use Management API for inserts/deletes.
  // Implement a minimal `from` shim that talks to the Mgmt API for the verification.
  return {
    from: (table) => {
      const filters = [];
      let mode = null;
      let payload = null;
      const builder = {
        select() { if (!mode) mode = 'select'; return builder; },
        insert(p) { if (!mode) { mode = 'insert'; payload = p; } return builder; },
        update(p) { if (!mode) { mode = 'update'; payload = p; } return builder; },
        delete() { if (!mode) mode = 'delete'; return builder; },
        eq(col, val) { filters.push({ k: 'eq', col, val }); return builder; },
        is(col, val) { filters.push({ k: 'is', col, val }); return builder; },
        in() { return builder; },
        not() { return builder; },
        order() { return builder; },
        limit(n) { filters.push({ k: 'limit', val: n }); return builder; },
        single() { filters.push({ k: 'single' }); return builder; },
        maybeSingle() { filters.push({ k: 'maybeSingle' }); return builder; },
        async then(resolve) {
          // Build SQL from the chain
          const whereParts = filters
            .filter(f => f.k === 'eq' || f.k === 'is')
            .map(f => {
              const v = typeof f.val === 'string' ? `'${f.val.replace(/'/g, "''")}'` : f.val == null ? 'NULL' : f.val;
              return f.k === 'is'
                ? `${f.col} IS ${v}`
                : `${f.col} = ${v}`;
            });
          const where = whereParts.length ? `WHERE ${whereParts.join(' AND ')}` : '';
          try {
            if (mode === 'select') {
              const sql = `SELECT * FROM ${table} ${where} LIMIT 10`;
              const rows = await runSql(sql);
              const wantSingle = filters.some(f => f.k === 'single' || f.k === 'maybeSingle');
              return resolve({ data: wantSingle ? (rows[0] || null) : rows, error: null });
            }
            if (mode === 'insert') {
              const cols = Object.keys(payload);
              const vals = cols.map(c => {
                const v = payload[c];
                if (v == null) return 'NULL';
                if (typeof v === 'string') return `'${v.replace(/'/g, "''")}'`;
                if (typeof v === 'object') return `'${JSON.stringify(v).replace(/'/g, "''")}'::jsonb`;
                return v;
              });
              const sql = `INSERT INTO ${table} (${cols.join(',')}) VALUES (${vals.join(',')}) RETURNING id`;
              try {
                const rows = await runSql(sql);
                return resolve({ data: rows[0], error: null });
              } catch (e) {
                if (/duplicate key|unique/i.test(e.message)) {
                  return resolve({ data: null, error: { code: '23505', message: e.message } });
                }
                return resolve({ data: null, error: { message: e.message } });
              }
            }
            if (mode === 'update') {
              const sets = Object.keys(payload).map(c => {
                const v = payload[c];
                if (v == null) return `${c} = NULL`;
                if (typeof v === 'string') return `${c} = '${v.replace(/'/g, "''")}'`;
                if (typeof v === 'object') return `${c} = '${JSON.stringify(v).replace(/'/g, "''")}'::jsonb`;
                return `${c} = ${v}`;
              });
              const sql = `UPDATE ${table} SET ${sets.join(', ')} ${where} RETURNING id`;
              const rows = await runSql(sql);
              return resolve({ data: rows, error: null });
            }
            if (mode === 'delete') {
              const sql = `DELETE FROM ${table} ${where} RETURNING id`;
              const rows = await runSql(sql);
              return resolve({ data: rows, error: null });
            }
          } catch (e) {
            return resolve({ data: null, error: { message: e.message } });
          }
        },
      };
      return builder;
    },
  };
}

function makeLogger(label) {
  return {
    warn: (m) => console.log(`[${label}] WARN: ${m}`),
    error: (m) => console.log(`[${label}] ERROR: ${m}`),
    log: (m) => console.log(`[${label}] LOG: ${m}`),
  };
}

(async () => {
  console.log('═══ P1.2 staging synthetic verification ═══');
  console.log();

  const supabase = await getSupabaseServiceKey();
  const log = makeLogger('verify');

  // Use a clearly-synthetic zenbooker_id to avoid colliding with real data.
  const syntheticZbId = `_p1_2_synth_${Date.now()}`;
  const operation = 'customer_link';

  // Step 0: clean any prior leftover synthetic rows.
  await runSql(`DELETE FROM zb_sync_dirty WHERE zenbooker_id LIKE '_p1_2_synth_%' AND user_id = ${TEST_USER_ID}`);

  // Step 1: markDirty via helper.
  console.log(`Step 1 — markDirty (zb_id=${syntheticZbId}, operation=${operation})`);
  const r1 = await markDirty(supabase, {
    userId: TEST_USER_ID,
    sfJobId: null,
    zenbookerId: syntheticZbId,
    operation,
    error: new Error('synthetic P1.2 verification — not a real failure'),
    logger: log,
    context: { source: 'p1.2-synthetic-verify', purpose: 'staging-soak-rehearsal' },
  });
  console.log('  →', r1);
  if (r1.action !== 'inserted') throw new Error(`expected inserted; got ${r1.action}`);

  // Step 2: list via deployed endpoint.
  console.log();
  console.log(`Step 2 — GET /api/zenbooker/sync-dirty (deployed staging endpoint)`);
  const token = jwt.sign({ userId: TEST_USER_ID }, JWT_SECRET, { expiresIn: '5m' });
  const listRes = await fetch(`${STAGING_BASE}/api/zenbooker/sync-dirty?operation=${operation}`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  console.log(`  HTTP ${listRes.status}`);
  if (!listRes.ok) throw new Error(`list endpoint failed: ${await listRes.text()}`);
  const listed = await listRes.json();
  console.log('  summary:', listed.summary);
  const found = (listed.rows || []).find(r => r.zenbooker_id === syntheticZbId);
  if (!found) throw new Error('synthetic row not found in list endpoint response');
  console.log(`  found row id=${found.id} attempts=${found.attempts} retryable=${found.retryable}`);

  // Step 3: idempotent re-mark.
  console.log();
  console.log(`Step 3 — re-mark same key (expect attempts++)`);
  const r3 = await markDirty(supabase, {
    userId: TEST_USER_ID, sfJobId: null, zenbookerId: syntheticZbId, operation,
    error: new Error('second synthetic failure on same key'), logger: log,
  });
  console.log('  →', r3);
  if (r3.action !== 'updated' || r3.id !== found.id) throw new Error(`expected updated id=${found.id}; got ${JSON.stringify(r3)}`);

  // Step 4: list again, confirm attempts went up + no duplicate row.
  console.log();
  console.log(`Step 4 — re-list, assert attempts=2 and no duplicate`);
  const listRes2 = await fetch(`${STAGING_BASE}/api/zenbooker/sync-dirty?operation=${operation}`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  const listed2 = await listRes2.json();
  const matches = (listed2.rows || []).filter(r => r.zenbooker_id === syntheticZbId);
  console.log(`  rows with zb_id=${syntheticZbId}: ${matches.length}`);
  if (matches.length !== 1) throw new Error(`expected 1 row, got ${matches.length} (idempotency broken)`);
  if (matches[0].attempts < 2) throw new Error(`expected attempts >= 2, got ${matches[0].attempts}`);
  console.log(`  attempts=${matches[0].attempts} ✓ idempotent`);

  // Step 5: resolveDirty.
  console.log();
  console.log(`Step 5 — resolveDirty (simulate successful retry)`);
  const r5 = await resolveDirty(supabase, {
    userId: TEST_USER_ID, sfJobId: null, zenbookerId: syntheticZbId, operation,
    resolvedBy: 'auto:p1.2-synth-test', note: 'verification rehearsal',
  });
  console.log('  →', r5);
  if (r5.action !== 'resolved' || r5.count !== 1) throw new Error(`expected resolved count=1; got ${JSON.stringify(r5)}`);

  // Step 6: confirm gone from default list.
  console.log();
  console.log(`Step 6 — GET endpoint default (unresolved only) → should NOT see synthetic row`);
  const listRes3 = await fetch(`${STAGING_BASE}/api/zenbooker/sync-dirty?operation=${operation}`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  const listed3 = await listRes3.json();
  const stillThere = (listed3.rows || []).find(r => r.zenbooker_id === syntheticZbId);
  if (stillThere) throw new Error('row still appears in unresolved-only view');
  console.log(`  ✓ resolved row hidden from default view`);

  // Step 6b: confirm visible in includeResolved=true.
  const listRes4 = await fetch(`${STAGING_BASE}/api/zenbooker/sync-dirty?operation=${operation}&includeResolved=true`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  const listed4 = await listRes4.json();
  const resolvedVisible = (listed4.rows || []).find(r => r.zenbooker_id === syntheticZbId);
  if (!resolvedVisible) throw new Error('resolved row missing from includeResolved=true view');
  console.log(`  ✓ visible via includeResolved=true (resolved_by=${resolvedVisible.resolved_by})`);

  // Step 7: tenant scope — verify another userId can't see the row.
  console.log();
  console.log(`Step 7 — tenant scope: JWT for other user should NOT see this synthetic row`);
  const otherToken = jwt.sign({ userId: 999999 }, JWT_SECRET, { expiresIn: '5m' });
  const listRes5 = await fetch(`${STAGING_BASE}/api/zenbooker/sync-dirty?operation=${operation}&includeResolved=true`, {
    headers: { 'Authorization': `Bearer ${otherToken}` },
  });
  const listed5 = await listRes5.json();
  const leaked = (listed5.rows || []).find(r => r.zenbooker_id === syntheticZbId);
  if (leaked) throw new Error('TENANT LEAK: other user saw synthetic row');
  console.log(`  ✓ tenant-scoped (other-user list empty for this synthetic row)`);

  // Step 8: cleanup
  console.log();
  console.log(`Step 8 — cleanup synthetic row`);
  await runSql(`DELETE FROM zb_sync_dirty WHERE zenbooker_id = '${syntheticZbId}' AND user_id = ${TEST_USER_ID}`);
  console.log(`  ✓ cleanup done`);

  console.log();
  console.log('═══ P1.2 staging synthetic verification: ALL CHECKS PASSED ═══');
})().catch(e => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
