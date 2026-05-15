#!/usr/bin/env node
/**
 * P1.3 staging verification — atomic financial writes.
 *
 * Drives 6 scenarios against the real `zb_apply_payment_writes` function:
 *
 *   1. happy path: jobs UPDATE + tx INSERT commits atomically
 *   2. replay: same call repeated → idempotent (tx update_by_zb_id, no dup)
 *   3. cross-tenant rejection: sf_job_id belonging to user A invoked as user B
 *      → RAISE → both writes rolled back
 *   4. forced rollback via invalid tx data: passes a deliberately-broken
 *      tx_data_array (cross-tenant per-tx job_id) → RAISE → jobs UPDATE
 *      that was attempted earlier in the function is also rolled back
 *   5. concurrent insert race: two RPC calls with same zenbooker_id at
 *      once → no duplicate tx row (idempotency holds under concurrency)
 *   6. cleanup: synthetic data removed
 *
 * Read/write against the SHARED staging+prod Supabase project. Uses
 * clearly-synthetic IDs and cleans up after itself. Only writes to test
 * user_id (env TEST_USER_ID, defaults to 2). DOES mutate jobs and
 * transactions tables — uses a temporary synthetic job row created at
 * step 0 and deleted at step 6.
 */

'use strict';

const SUPABASE_MGMT_TOKEN = process.env.SUPABASE_MGMT_TOKEN;
const PROJECT_REF = 'ezyhbvskbwmwgwyduqpt';
const TEST_USER_ID = parseInt(process.env.TEST_USER_ID || '2', 10);
const OTHER_USER_ID = 999999;

if (!SUPABASE_MGMT_TOKEN) { console.error('SUPABASE_MGMT_TOKEN required'); process.exit(2); }

async function sql(query, params = []) {
  // Supabase Management API doesn't accept params, so caller pre-formats SQL.
  const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${SUPABASE_MGMT_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text}`);
  try { return JSON.parse(text); } catch { return text; }
}

async function callRpc(args) {
  const argsJson = JSON.stringify(args).replace(/'/g, "''");
  const query = `SELECT zb_apply_payment_writes(
    ${args.p_user_id}::bigint,
    ${args.p_sf_job_id == null ? 'NULL' : args.p_sf_job_id + '::bigint'},
    ${args.p_job_updates == null ? 'NULL' : `'${JSON.stringify(args.p_job_updates).replace(/'/g, "''")}'::jsonb`},
    ${args.p_tx_data_array == null ? `'[]'::jsonb` : `'${JSON.stringify(args.p_tx_data_array).replace(/'/g, "''")}'::jsonb`}
  )`;
  const result = await sql(query);
  return result;
}

(async () => {
  console.log('═══ P1.3 staging atomic-writes verification ═══');
  console.log();

  // ─── Step 0: create a synthetic job row owned by TEST_USER_ID ────────
  console.log('Step 0 — seed a synthetic test job');
  const synthJobInsert = await sql(
    `INSERT INTO jobs(user_id, status, payment_status, service_price, scheduled_date, created_at)
     VALUES (${TEST_USER_ID}, 'completed', 'unpaid', 100, CURRENT_DATE, NOW())
     RETURNING id`
  );
  const SYNTH_JOB_ID = synthJobInsert[0].id;
  console.log(`  → synthetic job_id=${SYNTH_JOB_ID}`);

  let allPassed = true;
  function check(label, cond, detail = '') {
    const tag = cond ? '✓' : '✗';
    console.log(`  ${tag} ${label}${detail ? ' — ' + detail : ''}`);
    if (!cond) allPassed = false;
  }

  // ─── Step 1: happy-path atomic commit ───────────────────────────────
  console.log();
  console.log('Step 1 — happy path: jobs UPDATE + tx INSERT commits atomically');
  const synthZbTxId = `_p1_3_synth_tx_${Date.now()}`;
  const r1 = await callRpc({
    p_user_id: TEST_USER_ID, p_sf_job_id: SYNTH_JOB_ID,
    p_job_updates: { payment_status: 'paid', payment_method: 'cash', total: 100, total_amount: 100 },
    p_tx_data_array: [{
      job_id: SYNTH_JOB_ID, amount: 100, payment_method: 'cash',
      payment_intent_id: synthZbTxId + '_pi', status: 'completed',
      zenbooker_id: synthZbTxId, notes: 'P1.3 synthetic step 1',
    }],
  });
  console.log('  RPC result:', JSON.stringify(r1[0]));
  const jobAfter1 = (await sql(`SELECT payment_status, payment_method, total, total_amount FROM jobs WHERE id = ${SYNTH_JOB_ID}`))[0];
  const txCount1 = (await sql(`SELECT COUNT(*)::int AS n FROM transactions WHERE zenbooker_id = '${synthZbTxId}'`))[0].n;
  check('jobs.payment_status == paid', jobAfter1.payment_status === 'paid');
  check('jobs.payment_method == cash', jobAfter1.payment_method === 'cash');
  check('jobs.total == 100', Number(jobAfter1.total) === 100);
  check('exactly 1 tx with synthetic zenbooker_id', txCount1 === 1);

  // ─── Step 2: replay → idempotent ─────────────────────────────────────
  console.log();
  console.log('Step 2 — replay same call → idempotent (no duplicate tx)');
  const r2 = await callRpc({
    p_user_id: TEST_USER_ID, p_sf_job_id: SYNTH_JOB_ID,
    p_job_updates: { payment_status: 'paid', payment_method: 'cash', total: 100, total_amount: 100 },
    p_tx_data_array: [{
      job_id: SYNTH_JOB_ID, amount: 100, payment_method: 'cash',
      payment_intent_id: synthZbTxId + '_pi', status: 'completed',
      zenbooker_id: synthZbTxId, notes: 'P1.3 synthetic step 2 (replay)',
    }],
  });
  console.log('  RPC result:', JSON.stringify(r2[0]));
  const action2 = r2[0].zb_apply_payment_writes.tx_actions[0].action;
  const txCount2 = (await sql(`SELECT COUNT(*)::int AS n FROM transactions WHERE zenbooker_id = '${synthZbTxId}'`))[0].n;
  check('tx action == updated_by_zb_id (idempotent)', action2 === 'updated_by_zb_id');
  check('still exactly 1 tx (no duplicate)', txCount2 === 1);

  // ─── Step 3: cross-tenant rejection — RAISE rolls everything back ───
  console.log();
  console.log('Step 3 — cross-tenant rejection (sf_job_id of user A as user B)');
  // OTHER_USER_ID is some non-existent user; the function's tenant guard should reject.
  const beforeStatus3 = (await sql(`SELECT payment_status FROM jobs WHERE id = ${SYNTH_JOB_ID}`))[0].payment_status;
  let r3Err = null;
  try {
    await callRpc({
      p_user_id: OTHER_USER_ID,
      p_sf_job_id: SYNTH_JOB_ID,
      p_job_updates: { payment_status: 'EVIL_TAMPERED' },
      p_tx_data_array: [],
    });
  } catch (e) { r3Err = e.message; }
  const afterStatus3 = (await sql(`SELECT payment_status FROM jobs WHERE id = ${SYNTH_JOB_ID}`))[0].payment_status;
  check('RPC raised exception', !!r3Err, r3Err ? r3Err.slice(0, 100) : 'NO ERROR — TENANT GUARD BROKEN');
  check('jobs.payment_status unchanged after rejected call', afterStatus3 === beforeStatus3);

  // ─── Step 4: forced rollback via cross-job-tenant violation ─────────
  console.log();
  console.log('Step 4 — forced mid-transaction rollback (cross-tenant per-tx job_id)');
  // Try to update the synthetic job (succeeds initially) + ALSO insert a tx
  // targeting a different job that DOES NOT belong to TEST_USER_ID.
  // The function's per-tx tenant guard should RAISE on the bad tx, and the
  // jobs UPDATE that happened earlier in the function should roll back.
  const beforeAmount4 = (await sql(`SELECT total FROM jobs WHERE id = ${SYNTH_JOB_ID}`))[0].total;
  let r4Err = null;
  try {
    await callRpc({
      p_user_id: TEST_USER_ID,
      p_sf_job_id: SYNTH_JOB_ID,
      p_job_updates: { total: 999999 },                              // would be visible if commit happened
      p_tx_data_array: [{
        // job_id 1 likely does NOT belong to TEST_USER_ID = 2 — let's pick a job_id
        // that almost certainly belongs to another tenant by going far below the synth id.
        job_id: 1, amount: 50, payment_method: 'cash',
        payment_intent_id: '_p1_3_synth_cross_tenant',
        status: 'completed',
        zenbooker_id: `_p1_3_synth_cross_${Date.now()}`,
      }],
    });
  } catch (e) { r4Err = e.message; }
  const afterAmount4 = (await sql(`SELECT total FROM jobs WHERE id = ${SYNTH_JOB_ID}`))[0].total;
  check('RPC raised on cross-tenant tx job_id', !!r4Err, r4Err ? r4Err.slice(0, 120) : '');
  check('jobs.total rolled back (still ' + beforeAmount4 + ')',
        Number(afterAmount4) === Number(beforeAmount4),
        `before=${beforeAmount4} after=${afterAmount4}`);

  // ─── Step 5: concurrent insert race — no duplicate ──────────────────
  console.log();
  console.log('Step 5 — concurrent RPCs same zenbooker_id → no duplicate tx');
  const raceZbId = `_p1_3_race_${Date.now()}`;
  // Fire 4 simultaneous RPCs with the same zenbooker_id; first wins, others
  // upsert via update_by_zb_id; final count must be exactly 1.
  await Promise.all([1, 2, 3, 4].map(i => callRpc({
    p_user_id: TEST_USER_ID, p_sf_job_id: SYNTH_JOB_ID,
    p_job_updates: null,
    p_tx_data_array: [{
      job_id: SYNTH_JOB_ID, amount: 10 + i, payment_method: 'cash',
      payment_intent_id: raceZbId + '_pi', status: 'completed',
      zenbooker_id: raceZbId, notes: `concurrent ${i}`,
    }],
  })));
  const raceCount = (await sql(`SELECT COUNT(*)::int AS n FROM transactions WHERE zenbooker_id = '${raceZbId}'`))[0].n;
  check('exactly 1 tx after 4 concurrent RPCs (no duplicate)', raceCount === 1);

  // ─── Step 6: cleanup ────────────────────────────────────────────────
  console.log();
  console.log('Step 6 — cleanup synthetic rows');
  await sql(`DELETE FROM transactions WHERE zenbooker_id LIKE '_p1_3_%'`);
  await sql(`DELETE FROM jobs WHERE id = ${SYNTH_JOB_ID}`);
  // sanity
  const stillThere = (await sql(`SELECT COUNT(*)::int AS n FROM jobs WHERE id = ${SYNTH_JOB_ID}`))[0].n;
  check('synthetic job deleted', stillThere === 0);

  console.log();
  if (allPassed) {
    console.log('═══ P1.3 staging atomic-writes verification: ALL CHECKS PASSED ═══');
    process.exit(0);
  } else {
    console.error('═══ P1.3 staging atomic-writes verification: FAILED ═══');
    process.exit(1);
  }
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
