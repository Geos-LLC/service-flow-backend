/**
 * Tests for safeReconcileJobLedger.
 *
 * Uses an in-memory supabase mock so the contract is verified end-to-end
 * (existing rows in / safe-reconcile out → expected diff + DB state).
 *
 * Job 142065 is the canonical fixture: existing unpaid earning $119.40
 * (computed when SF had service_price 199), correct value after sync fix
 * is $107.40 (179 × 60%) plus a new $20 tip row.
 */

const { safeReconcileJobLedger } = require('../lib/zenbooker-ledger-reconcile');

// ─────────────────────────────────────────────────────────────
// Minimal supabase-js shim. Supports .from().select/insert/update/delete with
// .eq/.in/.is/.ilike/.order/.single/.maybeSingle and chained returns.
// ─────────────────────────────────────────────────────────────

function makeShim(tables) {
  const db = JSON.parse(JSON.stringify(tables));
  let nextLedgerId = (db.cleaner_ledger || []).reduce((m, r) => Math.max(m, r.id || 0), 0) + 1;

  function from(table) {
    const ctx = { table, filters: [], op: 'select', cols: '*', updates: null, insertRows: null, single: false, maybeSingle: false, returning: null };

    function applyFilters(rows) {
      let out = rows.slice();
      for (const [op, col, val] of ctx.filters) {
        if (op === 'eq') out = out.filter((r) => r[col] === val);
        else if (op === 'in') out = out.filter((r) => val.includes(r[col]));
        else if (op === 'is_null') out = out.filter((r) => r[col] == null);
        else if (op === 'is_not_null') out = out.filter((r) => r[col] != null);
        else if (op === 'ilike') {
          const pat = String(val).toLowerCase();
          out = out.filter((r) => String(r[col] || '').toLowerCase() === pat);
        }
      }
      return out;
    }

    const builder = {
      select(c) { ctx.cols = c; return builder; },
      eq(col, val) { ctx.filters.push(['eq', col, val]); return builder; },
      in(col, vals) { ctx.filters.push(['in', col, vals]); return builder; },
      is(col, val) {
        if (val === null) ctx.filters.push(['is_null', col, null]);
        else if (val === 'not.null') ctx.filters.push(['is_not_null', col, null]);
        return builder;
      },
      not(col, op, val) {
        if (op === 'is' && val === null) ctx.filters.push(['is_not_null', col, null]);
        return builder;
      },
      ilike(col, val) { ctx.filters.push(['ilike', col, val]); return builder; },
      order() { return builder; },
      single() { ctx.single = true; return runner(); },
      maybeSingle() { ctx.maybeSingle = true; return runner(); },
      then(onF, onR) { return runner().then(onF, onR); },
      insert(rows) {
        ctx.op = 'insert';
        ctx.insertRows = Array.isArray(rows) ? rows : [rows];
        return chainAfterMutate();
      },
      update(updates) {
        ctx.op = 'update';
        ctx.updates = updates;
        return chainAfterMutate();
      },
      delete() {
        ctx.op = 'delete';
        return chainAfterMutate();
      },
    };

    function chainAfterMutate() {
      return {
        eq: (...a) => { builder.eq(...a); return chainAfterMutate(); },
        in: (...a) => { builder.in(...a); return chainAfterMutate(); },
        is: (...a) => { builder.is(...a); return chainAfterMutate(); },
        ilike: (...a) => { builder.ilike(...a); return chainAfterMutate(); },
        select(c) { ctx.returning = c; return chainAfterMutate(); },
        single() { ctx.single = true; return runner(); },
        maybeSingle() { ctx.maybeSingle = true; return runner(); },
        then(onF, onR) { return runner().then(onF, onR); },
      };
    }

    function runner() {
      return Promise.resolve().then(() => {
        if (!db[table]) db[table] = [];
        const rows = db[table];

        if (ctx.op === 'select') {
          const filtered = applyFilters(rows);
          const data = filtered.map((r) => ({ ...r }));
          if (ctx.single) return { data: data[0] || null, error: data.length === 0 ? { message: 'no rows' } : null };
          if (ctx.maybeSingle) return { data: data[0] || null, error: null };
          return { data, error: null };
        }
        if (ctx.op === 'insert') {
          const inserted = ctx.insertRows.map((r) => {
            const row = { ...r };
            if (table === 'cleaner_ledger' && row.id == null) row.id = nextLedgerId++;
            if (row.payout_batch_id === undefined) row.payout_batch_id = null;
            return row;
          });
          rows.push(...inserted);
          const data = inserted.map((r) => ({ ...r }));
          if (ctx.single) return { data: data[0] || null, error: null };
          return { data, error: null };
        }
        if (ctx.op === 'update') {
          const filtered = applyFilters(rows);
          for (const r of filtered) Object.assign(r, ctx.updates);
          const data = filtered.map((r) => ({ ...r }));
          if (ctx.single) return { data: data[0] || null, error: null };
          return { data, error: null };
        }
        if (ctx.op === 'delete') {
          const filtered = applyFilters(rows);
          for (const r of filtered) {
            const idx = rows.indexOf(r);
            if (idx !== -1) rows.splice(idx, 1);
          }
          return { data: filtered, error: null };
        }
        return { data: null, error: null };
      });
    }

    return builder;
  }

  return { from, _db: db };
}

// ─────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────

function fixture142065(overrides = {}) {
  return {
    jobs: [{
      id: 142065, user_id: 2, team_member_id: 2669, status: 'completed',
      service_price: 179, price: 179, total: 204.37, total_amount: 204.37,
      invoice_amount: null, tip_amount: 20, incentive_amount: 0,
      hours_worked: null, duration: 210, estimated_duration: null,
      scheduled_date: '2026-05-07 10:00:00',
      additional_fees: 5.37, taxes: 0, discount: 0,
      cleaner_salary_override: null,
      fees_breakdown: [{ name: 'Processing fee', type: 'fee', amount: 5.37 }],
      ...overrides.job,
    }],
    job_team_assignments: overrides.job_team_assignments || [],
    team_members: overrides.team_members || [
      { id: 2669, first_name: 'Alina', last_name: 'Harbuz', hourly_rate: null, commission_percentage: 60, role: 'worker', status: 'active', salary_start_date: null },
    ],
    team_member_pay_rates: overrides.team_member_pay_rates || [],
    transactions: overrides.transactions || [
      { id: 1, job_id: 142065, status: 'completed', payment_method: 'stripe', amount: 204.37 },
    ],
    cleaner_ledger: overrides.cleaner_ledger || [],
  };
}

// ─────────────────────────────────────────────────────────────
// Tests — H series (per the design doc)
// ─────────────────────────────────────────────────────────────

describe('safeReconcileJobLedger — 142065 canonical case', () => {
  test('H1. existing unpaid earning $119.40 → UPDATE to $107.40 + INSERT tip $20', async () => {
    const shim = makeShim(fixture142065({
      cleaner_ledger: [{
        id: 90265, user_id: 2, team_member_id: 2669, job_id: 142065,
        type: 'earning', amount: 119.40, payout_batch_id: null,
        effective_date: '2026-05-07', metadata: { hours: 4, revenue: 199, member_count: 1, commission_pct: 60 },
        note: 'Earning for job #142065',
      }],
    }));

    const out = await safeReconcileJobLedger(shim, { jobId: 142065, userId: 2 });

    expect(out.eligible).toBe(true);
    expect(out.applied.updated).toHaveLength(1);
    expect(out.applied.updated[0]).toMatchObject({
      id: 90265, type: 'earning', amount: 107.40, payout_batch_id: null,
      previous_amount: 119.40,
    });
    expect(out.applied.inserted).toHaveLength(1);
    expect(out.applied.inserted[0]).toMatchObject({
      team_member_id: 2669, type: 'tip', amount: 20, payout_batch_id: null,
    });
    expect(out.skipped.paid_rows_with_drift).toEqual([]);

    // Verify DB state directly
    const ledger = shim._db.cleaner_ledger;
    const earning = ledger.find((r) => r.id === 90265);
    expect(earning.amount).toBe(107.40);
    expect(earning.metadata.previous_amount).toBe(119.40);
    expect(earning.metadata.reconcile_source).toBe('safeReconcileJobLedger');
    const tip = ledger.find((r) => r.type === 'tip');
    expect(tip.amount).toBe(20);
    expect(tip.payout_batch_id).toBe(null);
  });

  test('H2. existing PAID earning $119.40 → never mutated, reported as paid_rows_with_drift', async () => {
    const shim = makeShim(fixture142065({
      cleaner_ledger: [{
        id: 90265, user_id: 2, team_member_id: 2669, job_id: 142065,
        type: 'earning', amount: 119.40, payout_batch_id: 999, // PAID
        effective_date: '2026-05-07', metadata: {},
        note: 'Earning for job #142065',
      }],
    }));

    const out = await safeReconcileJobLedger(shim, { jobId: 142065, userId: 2 });

    expect(out.applied.updated).toEqual([]);
    expect(out.skipped.paid_rows_with_drift).toHaveLength(1);
    expect(out.skipped.paid_rows_with_drift[0]).toMatchObject({
      ledger_id: 90265, payout_batch_id: 999,
      paid_amount: 119.40, intended_amount: 107.40, delta: -12,
    });
    // Tip row IS still inserted (it has no existing collision)
    expect(out.applied.inserted).toHaveLength(1);
    expect(out.applied.inserted[0]).toMatchObject({ type: 'tip', amount: 20 });

    // Paid row in DB unchanged
    const earning = shim._db.cleaner_ledger.find((r) => r.id === 90265);
    expect(earning.amount).toBe(119.40);
    expect(earning.payout_batch_id).toBe(999);
  });

  test('H3. dry-run mode does not write', async () => {
    const shim = makeShim(fixture142065({
      cleaner_ledger: [{
        id: 90265, user_id: 2, team_member_id: 2669, job_id: 142065,
        type: 'earning', amount: 119.40, payout_batch_id: null,
        effective_date: '2026-05-07', metadata: {},
        note: 'Earning for job #142065',
      }],
    }));

    const before = JSON.parse(JSON.stringify(shim._db.cleaner_ledger));
    const out = await safeReconcileJobLedger(shim, { jobId: 142065, userId: 2, dryRun: true });

    expect(out.dry_run).toBe(true);
    expect(out.applied.updated[0]._dry_run).toBe(true);
    expect(out.applied.inserted[0]._dry_run).toBe(true);
    // DB unchanged
    expect(shim._db.cleaner_ledger).toEqual(before);
  });

  test('H4. ineligible job (status not completed) → eligible=false, no writes', async () => {
    const shim = makeShim(fixture142065({ job: { status: 'started' } }));
    const out = await safeReconcileJobLedger(shim, { jobId: 142065, userId: 2 });
    expect(out.eligible).toBe(false);
    expect(out.reason).toMatch(/job_status_not_completed/);
    expect(shim._db.cleaner_ledger).toEqual([]);
  });

  test('H5. fully matching ledger → no_change, no writes', async () => {
    const shim = makeShim(fixture142065({
      cleaner_ledger: [
        { id: 90265, user_id: 2, team_member_id: 2669, job_id: 142065, type: 'earning', amount: 107.40, payout_batch_id: null, effective_date: '2026-05-07', metadata: {}, note: 'Earning for job #142065' },
        { id: 90266, user_id: 2, team_member_id: 2669, job_id: 142065, type: 'tip', amount: 20, payout_batch_id: null, effective_date: '2026-05-07', metadata: {}, note: 'Tip for job #142065' },
      ],
    }));
    const out = await safeReconcileJobLedger(shim, { jobId: 142065, userId: 2 });
    expect(out.applied.inserted).toEqual([]);
    expect(out.applied.updated).toEqual([]);
    expect(out.no_change).toHaveLength(2);
  });

  test('H7. dry-run with jobOverrides (projected financial update) → intended ledger reflects post-fix amounts', async () => {
    // Reproduces the exact bug caught on staging: SF still has service_price=199
    // (not yet UPDATEd in dry-run mode), but the endpoint will write 179. Without
    // jobOverrides, the ledger reconcile would compute intended=119.40 (matching
    // the wrong existing row) and report no_change. WITH jobOverrides, it should
    // compute intended=107.40 and a missing tip $20.
    const shim = makeShim(fixture142065({
      job: {
        // Pre-update SF state: stale service_price + tip (this is the bug 142065 had)
        service_price: 199, price: 199, total: 199, total_amount: 199,
        tip_amount: 0, additional_fees: 5.37,
      },
      cleaner_ledger: [{
        id: 90298, user_id: 2, team_member_id: 2669, job_id: 142065,
        type: 'earning', amount: 119.40, payout_batch_id: null,
        effective_date: '2026-05-07', metadata: { hours: 4, revenue: 199 },
        note: 'Earning for job #142065',
      }],
    }));

    const out = await safeReconcileJobLedger(shim, {
      jobId: 142065, userId: 2, dryRun: true,
      jobOverrides: {
        service_price: 179, price: 179, total: 204.37, total_amount: 204.37,
        tip_amount: 20,
      },
    });

    // With overlay: intended earning is 179 × 60% = 107.40
    expect(out.applied.updated).toHaveLength(1);
    expect(out.applied.updated[0]).toMatchObject({
      ledger_id: 90298, intended_amount: 107.40, previous_amount: 119.40, _dry_run: true,
    });
    // Tip row should be in inserted (missing now, $20 after overlay)
    expect(out.applied.inserted).toHaveLength(1);
    expect(out.applied.inserted[0]).toMatchObject({ type: 'tip', amount: 20, _dry_run: true });
    expect(out.no_change).toEqual([]);
    // No DB writes in dry-run
    expect(shim._db.cleaner_ledger.find((r) => r.id === 90298).amount).toBe(119.40);
  });

  test('H8. without jobOverlay (no projected update) the dry-run uses live job data', async () => {
    // Sanity check: when caller doesn't pass jobOverrides, behavior is unchanged.
    const shim = makeShim(fixture142065({
      job: { service_price: 179, tip_amount: 20 },
      cleaner_ledger: [{
        id: 90298, user_id: 2, team_member_id: 2669, job_id: 142065,
        type: 'earning', amount: 107.40, payout_batch_id: null,
        effective_date: '2026-05-07', metadata: {},
        note: 'Earning for job #142065',
      }],
    }));
    const out = await safeReconcileJobLedger(shim, { jobId: 142065, userId: 2, dryRun: true });
    expect(out.applied.updated).toEqual([]);
    expect(out.no_change).toHaveLength(1);
    expect(out.applied.inserted).toHaveLength(1); // tip is missing
    expect(out.applied.inserted[0]).toMatchObject({ type: 'tip', amount: 20 });
  });

  test('H9. cancelled-job overlay → ledger reconciler sees ineligible, no new rows', async () => {
    // Job 141934 case: ZB now says canceled=true. The endpoint will route the
    // status flip through updateJobStatus separately, but it ALSO passes the
    // would-be status='cancelled' as a jobOverride. computeIntendedRows must
    // treat the job as ineligible (status not completed/paid) and produce no
    // intended rows — even if the job has stale earning/tip rows on it, the
    // safe-reconciler must NOT touch them (delete is forbidden in this path).
    const shim = makeShim(fixture142065({
      job: { status: 'completed' },   // SF current
      cleaner_ledger: [{
        id: 90400, user_id: 2, team_member_id: 2669, job_id: 142065,
        type: 'earning', amount: 107.40, payout_batch_id: null,
        effective_date: '2026-05-07', metadata: {},
        note: 'Earning for job #142065',
      }],
    }));
    const out = await safeReconcileJobLedger(shim, {
      jobId: 142065, userId: 2,
      jobOverrides: { status: 'cancelled' },  // would-be post-status-flip
    });
    expect(out.eligible).toBe(false);
    expect(out.reason).toMatch(/job_status_not_completed/);
    expect(out.applied.inserted).toEqual([]);
    expect(out.applied.updated).toEqual([]);
    // Existing earning row stays put — never deleted, never updated
    const earning = shim._db.cleaner_ledger.find((r) => r.id === 90400);
    expect(earning.amount).toBe(107.40);
    expect(earning.payout_batch_id).toBe(null);
  });

  test('H6. orphan existing unpaid row of type not in intended set → reported, untouched', async () => {
    const shim = makeShim(fixture142065({
      cleaner_ledger: [
        // Wrong-amount unpaid earning: gets UPDATEd
        { id: 90265, user_id: 2, team_member_id: 2669, job_id: 142065, type: 'earning', amount: 119.40, payout_batch_id: null, effective_date: '2026-05-07', metadata: {}, note: 'Earning' },
        // Orphan: incentive that shouldn't exist (job has 0 incentive_amount)
        { id: 90400, user_id: 2, team_member_id: 2669, job_id: 142065, type: 'incentive', amount: 5, payout_batch_id: null, effective_date: '2026-05-07', metadata: {}, note: 'Stale' },
      ],
    }));
    const out = await safeReconcileJobLedger(shim, { jobId: 142065, userId: 2 });
    expect(out.orphans).toHaveLength(1);
    expect(out.orphans[0]).toMatchObject({ ledger_id: 90400, type: 'incentive' });
    // Orphan still in DB unchanged
    const orphan = shim._db.cleaner_ledger.find((r) => r.id === 90400);
    expect(orphan).toBeDefined();
    expect(orphan.amount).toBe(5);
  });
});
