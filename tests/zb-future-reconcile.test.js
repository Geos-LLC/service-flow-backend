'use strict';

/**
 * Tests for lib/zb-future-reconciler.js.
 *
 * Covers the test matrix specified for the silent-cancel safety-net work:
 *
 *   1. recurring_booking.canceled fetches a booking's instances and reconciles them.
 *   2. An individual recurring instance silently canceled in ZB (no webhook) is
 *      caught by reconcileFutureJobs (the cron's call site).
 *   3. SF jobs in hard-terminal states (completed / paid / cancelled) are NEVER
 *      regressed by either entry point — even if ZB says canceled=true.
 *   4. ZB 404 → skipped_missing_upstream; SF row is preserved (not deleted, not
 *      mutated).
 *   5. Idempotency: a second pass over the same data is a no-op.
 *   6. Per-tenant isolation: reconcileFutureJobs scoped to user A never touches
 *      user B's rows.
 *   7. Dry-run produces no writes (no status flip, no ledger delete, no
 *      updateJobStatus call).
 *   8. Only eligible fields are written — apply path touches `status` via the
 *      injected updateJobStatus and triggers the ledger-immutability helper
 *      for cancellation cleanup. Nothing else is mutated.
 */

const {
  reconcileJobAgainstZB,
  reconcileFutureJobs,
  reconcileRecurringBooking,
} = require('../lib/zb-future-reconciler');

// ── Minimal in-memory Supabase mock ────────────────────────────────
//
// Only implements the surface the reconciler actually uses:
//   .from(t).select().eq().not().in().gte().lte() → list rows
//   .from('cleaner_ledger').delete().eq().in().is().select() → delete + return ids
//
// State is mutable so tests can assert on writes made by the apply path.

function makeSupabase(seed = {}) {
  const state = {
    jobs: (seed.jobs || []).map(r => ({ ...r })),
    cleaner_ledger: (seed.cleaner_ledger || []).map(r => ({ ...r })),
  };

  function buildSelectChain(tableName) {
    const filters = [];

    const applyFilters = (rows) => rows.filter(r =>
      filters.every(f => {
        if (f.op === 'eq') return r[f.col] === f.val;
        if (f.op === 'in') return f.val.includes(r[f.col]);
        if (f.op === 'not_is_null') return r[f.col] !== null && r[f.col] !== undefined;
        if (f.op === 'is_null') return r[f.col] === null || r[f.col] === undefined;
        if (f.op === 'gte') return String(r[f.col]) >= String(f.val);
        if (f.op === 'lte') return String(r[f.col]) <= String(f.val);
        return true;
      })
    );

    const chain = {
      select() { return chain; },
      eq(col, val) { filters.push({ op: 'eq', col, val }); return chain; },
      in(col, vals) { filters.push({ op: 'in', col, val: vals }); return chain; },
      not(col, op, val) {
        if (op === 'is' && val === null) filters.push({ op: 'not_is_null', col });
        return chain;
      },
      is(col, val) {
        if (val === null) filters.push({ op: 'is_null', col });
        return chain;
      },
      gte(col, val) { filters.push({ op: 'gte', col, val }); return chain; },
      lte(col, val) { filters.push({ op: 'lte', col, val }); return chain; },
      order() { return chain; },
      limit() { return chain; },
      then(resolve, reject) {
        const rows = applyFilters(state[tableName] || []);
        return Promise.resolve({ data: rows, error: null }).then(resolve, reject);
      },
      maybeSingle() {
        const rows = applyFilters(state[tableName] || []);
        return Promise.resolve({ data: rows[0] || null, error: null });
      },
    };
    return chain;
  }

  function buildDeleteChain(tableName) {
    const filters = [];

    const applyFilters = (rows) => rows.filter(r =>
      filters.every(f => {
        if (f.op === 'eq') return r[f.col] === f.val;
        if (f.op === 'in') return f.val.includes(r[f.col]);
        if (f.op === 'is_null') return r[f.col] === null || r[f.col] === undefined;
        if (f.op === 'not_is_null') return r[f.col] !== null && r[f.col] !== undefined;
        return true;
      })
    );

    const chain = {
      eq(col, val) { filters.push({ op: 'eq', col, val }); return chain; },
      in(col, vals) { filters.push({ op: 'in', col, val: vals }); return chain; },
      is(col, val) {
        if (val === null) filters.push({ op: 'is_null', col });
        return chain;
      },
      not(col, op, val) {
        if (op === 'is' && val === null) filters.push({ op: 'not_is_null', col });
        return chain;
      },
      select() {
        return {
          then(resolve, reject) {
            const all = state[tableName] || [];
            const matched = applyFilters(all);
            state[tableName] = all.filter(r => !matched.includes(r));
            return Promise.resolve({ data: matched.map(r => ({ id: r.id })), error: null }).then(resolve, reject);
          },
        };
      },
    };
    return chain;
  }

  return {
    from(tableName) {
      return {
        select: (...a) => buildSelectChain(tableName).select(...a),
        delete: () => buildDeleteChain(tableName),
      };
    },
    _state: state,
  };
}

function quietLogger() {
  return { log: () => {}, warn: () => {}, error: () => {} };
}

// ── reconcileJobAgainstZB ──────────────────────────────────────────

describe('reconcileJobAgainstZB', () => {
  test('updates SF to cancelled when ZB says canceled=true (apply)', async () => {
    const supabase = makeSupabase();
    const updateJobStatusFn = jest.fn().mockResolvedValue({});
    const zbFetchFn = jest.fn().mockResolvedValue({ canceled: true, status: 'scheduled' });

    const result = await reconcileJobAgainstZB({
      supabase,
      sfJob: { id: 100, user_id: 2, zenbooker_id: 'zb_abc', status: 'scheduled' },
      apiKey: 'k',
      dryRun: false,
      logger: quietLogger(),
      zbFetchFn,
      updateJobStatusFn,
    });

    expect(result.action).toBe('updated_cancelled');
    expect(result.afterStatus).toBe('cancelled');
    expect(updateJobStatusFn).toHaveBeenCalledTimes(1);
    expect(updateJobStatusFn.mock.calls[0][1].newStatus).toBe('cancelled');
    expect(updateJobStatusFn.mock.calls[0][1].userId).toBe(2);
  });

  test('dry-run does not call updateJobStatus or delete ledger', async () => {
    const supabase = makeSupabase({
      cleaner_ledger: [
        { id: 9, job_id: 100, type: 'earning', amount: 50, payout_batch_id: null },
      ],
    });
    const updateJobStatusFn = jest.fn();
    const zbFetchFn = jest.fn().mockResolvedValue({ canceled: true, status: 'scheduled' });

    const result = await reconcileJobAgainstZB({
      supabase,
      sfJob: { id: 100, user_id: 2, zenbooker_id: 'zb_abc', status: 'scheduled' },
      apiKey: 'k',
      dryRun: true,
      logger: quietLogger(),
      zbFetchFn,
      updateJobStatusFn,
    });

    expect(result.action).toBe('would_update_cancelled');
    expect(updateJobStatusFn).not.toHaveBeenCalled();
    expect(supabase._state.cleaner_ledger).toHaveLength(1);
  });

  test('skips when ZB job is NOT canceled', async () => {
    const supabase = makeSupabase();
    const updateJobStatusFn = jest.fn();
    const zbFetchFn = jest.fn().mockResolvedValue({ canceled: false, status: 'scheduled' });

    const result = await reconcileJobAgainstZB({
      supabase,
      sfJob: { id: 100, user_id: 2, zenbooker_id: 'zb_abc', status: 'scheduled' },
      apiKey: 'k',
      dryRun: false,
      logger: quietLogger(),
      zbFetchFn,
      updateJobStatusFn,
    });

    expect(result.action).toBe('already_in_sync');
    expect(updateJobStatusFn).not.toHaveBeenCalled();
  });

  test('never regresses hard-terminal SF statuses (completed)', async () => {
    const supabase = makeSupabase();
    const updateJobStatusFn = jest.fn();
    const zbFetchFn = jest.fn().mockResolvedValue({ canceled: true });

    const result = await reconcileJobAgainstZB({
      supabase,
      sfJob: { id: 100, user_id: 2, zenbooker_id: 'zb_abc', status: 'completed' },
      apiKey: 'k',
      dryRun: false,
      logger: quietLogger(),
      zbFetchFn,
      updateJobStatusFn,
    });

    expect(result.action).toBe('skipped_hard_terminal');
    expect(updateJobStatusFn).not.toHaveBeenCalled();
    // ZB should not even be called for a terminal SF row.
    expect(zbFetchFn).not.toHaveBeenCalled();
  });

  test('never regresses hard-terminal SF statuses (paid)', async () => {
    const supabase = makeSupabase();
    const updateJobStatusFn = jest.fn();
    const zbFetchFn = jest.fn();

    const result = await reconcileJobAgainstZB({
      supabase,
      sfJob: { id: 100, user_id: 2, zenbooker_id: 'zb_abc', status: 'paid' },
      apiKey: 'k',
      dryRun: false,
      logger: quietLogger(),
      zbFetchFn,
      updateJobStatusFn,
    });

    expect(result.action).toBe('skipped_hard_terminal');
    expect(zbFetchFn).not.toHaveBeenCalled();
  });

  test('skipped_missing_upstream on ZB 404 — SF row not mutated', async () => {
    const supabase = makeSupabase({
      jobs: [
        { id: 100, user_id: 2, zenbooker_id: 'zb_abc', status: 'scheduled', scheduled_date: '2026-06-01' },
      ],
    });
    const updateJobStatusFn = jest.fn();
    const zbFetchFn = jest.fn().mockRejectedValue(new Error('Zenbooker API 404: not found'));

    const result = await reconcileJobAgainstZB({
      supabase,
      sfJob: supabase._state.jobs[0],
      apiKey: 'k',
      dryRun: false,
      logger: quietLogger(),
      zbFetchFn,
      updateJobStatusFn,
    });

    expect(result.action).toBe('skipped_missing_upstream');
    expect(updateJobStatusFn).not.toHaveBeenCalled();
    expect(supabase._state.jobs[0].status).toBe('scheduled'); // unchanged
  });

  test('failed on other ZB errors — SF row not mutated', async () => {
    const supabase = makeSupabase();
    const updateJobStatusFn = jest.fn();
    const zbFetchFn = jest.fn().mockRejectedValue(new Error('Zenbooker API 500: server error'));

    const result = await reconcileJobAgainstZB({
      supabase,
      sfJob: { id: 100, user_id: 2, zenbooker_id: 'zb_abc', status: 'scheduled' },
      apiKey: 'k',
      dryRun: false,
      logger: quietLogger(),
      zbFetchFn,
      updateJobStatusFn,
    });

    expect(result.action).toBe('failed');
    expect(updateJobStatusFn).not.toHaveBeenCalled();
  });

  test('skipped_no_zb_id when SF row has no zenbooker_id', async () => {
    const supabase = makeSupabase();
    const updateJobStatusFn = jest.fn();
    const zbFetchFn = jest.fn();

    const result = await reconcileJobAgainstZB({
      supabase,
      sfJob: { id: 100, user_id: 2, zenbooker_id: null, status: 'scheduled' },
      apiKey: 'k',
      dryRun: false,
      logger: quietLogger(),
      zbFetchFn,
      updateJobStatusFn,
    });

    expect(result.action).toBe('skipped_no_zb_id');
    expect(zbFetchFn).not.toHaveBeenCalled();
  });

  test('apply path deletes UNBATCHED ledger rows but leaves settled rows', async () => {
    const supabase = makeSupabase({
      cleaner_ledger: [
        { id: 1, job_id: 100, type: 'earning',  amount: 50,  payout_batch_id: null },
        { id: 2, job_id: 100, type: 'tip',      amount: 10,  payout_batch_id: null },
        { id: 3, job_id: 100, type: 'incentive', amount: 5,   payout_batch_id: 99 }, // settled — must survive
        { id: 4, job_id: 999, type: 'earning',  amount: 99,  payout_batch_id: null }, // different job
      ],
    });
    const updateJobStatusFn = jest.fn().mockResolvedValue({});
    const zbFetchFn = jest.fn().mockResolvedValue({ canceled: true });

    const result = await reconcileJobAgainstZB({
      supabase,
      sfJob: { id: 100, user_id: 2, zenbooker_id: 'zb_abc', status: 'scheduled' },
      apiKey: 'k',
      dryRun: false,
      logger: quietLogger(),
      zbFetchFn,
      updateJobStatusFn,
    });

    expect(result.action).toBe('updated_cancelled');
    const remaining = supabase._state.cleaner_ledger.map(r => r.id).sort();
    expect(remaining).toEqual([3, 4]); // settled row 3 preserved; foreign job 4 untouched
  });
});

// ── reconcileFutureJobs (the cron path) ────────────────────────────

describe('reconcileFutureJobs', () => {
  function makeFutureDate(daysAhead) {
    const d = new Date(Date.now() + daysAhead * 86400000);
    return d.toISOString();
  }

  test('catches a silent cancellation in the future window', async () => {
    const supabase = makeSupabase({
      jobs: [
        { id: 200, user_id: 2, zenbooker_id: 'zb_future', status: 'scheduled', scheduled_date: makeFutureDate(7) },
        { id: 201, user_id: 2, zenbooker_id: 'zb_other',  status: 'scheduled', scheduled_date: makeFutureDate(14) },
      ],
    });
    const updateJobStatusFn = jest.fn().mockResolvedValue({});
    const zbFetchFn = jest.fn(async (apiKey, path) => {
      if (path.endsWith('/zb_future')) return { canceled: true };
      return { canceled: false };
    });

    const { summary, changes } = await reconcileFutureJobs({
      supabase,
      userId: 2,
      apiKey: 'k',
      dryRun: false,
      lookaheadDays: 30,
      perJobDelayMs: 0,
      logger: quietLogger(),
      zbFetchFn,
      updateJobStatusFn,
    });

    expect(summary.scanned).toBe(2);
    expect(summary.updated_cancelled).toBe(1);
    expect(summary.already_in_sync).toBe(1);
    expect(changes).toHaveLength(1);
    expect(changes[0].jobId).toBe(200);
    expect(updateJobStatusFn).toHaveBeenCalledTimes(1);
  });

  test('per-tenant isolation: never touches another user\'s rows', async () => {
    const supabase = makeSupabase({
      jobs: [
        { id: 300, user_id: 2, zenbooker_id: 'zb_user2', status: 'scheduled', scheduled_date: makeFutureDate(5) },
        { id: 301, user_id: 7, zenbooker_id: 'zb_user7', status: 'scheduled', scheduled_date: makeFutureDate(5) },
      ],
    });
    const updateJobStatusFn = jest.fn().mockResolvedValue({});
    const zbFetchFn = jest.fn().mockResolvedValue({ canceled: true });

    const { summary } = await reconcileFutureJobs({
      supabase,
      userId: 2,
      apiKey: 'k',
      dryRun: false,
      lookaheadDays: 30,
      perJobDelayMs: 0,
      logger: quietLogger(),
      zbFetchFn,
      updateJobStatusFn,
    });

    expect(summary.scanned).toBe(1);
    expect(updateJobStatusFn).toHaveBeenCalledTimes(1);
    expect(updateJobStatusFn.mock.calls[0][1].jobId).toBe(300);
    // Verify the other tenant's row was never seen.
    const allUpdatedJobIds = updateJobStatusFn.mock.calls.map(c => c[1].jobId);
    expect(allUpdatedJobIds).not.toContain(301);
  });

  test('idempotent second run is a no-op (sees only cancelled status which is skipped_ineligible)', async () => {
    const supabase = makeSupabase({
      jobs: [
        { id: 400, user_id: 2, zenbooker_id: 'zb_x', status: 'scheduled', scheduled_date: makeFutureDate(7) },
      ],
    });
    const updateJobStatusFn = jest.fn(async (sb, { jobId, newStatus }) => {
      const row = sb._state.jobs.find(j => j.id === jobId);
      if (row) row.status = newStatus;
    });
    const zbFetchFn = jest.fn().mockResolvedValue({ canceled: true });

    const first = await reconcileFutureJobs({
      supabase, userId: 2, apiKey: 'k', dryRun: false,
      lookaheadDays: 30, perJobDelayMs: 0, logger: quietLogger(),
      zbFetchFn, updateJobStatusFn,
    });
    expect(first.summary.updated_cancelled).toBe(1);

    // Second pass: the row is now cancelled, which is NOT in ELIGIBLE_FROM_STATUSES,
    // so the eligible-status filter on the query excludes it entirely. summary.scanned=0.
    const second = await reconcileFutureJobs({
      supabase, userId: 2, apiKey: 'k', dryRun: false,
      lookaheadDays: 30, perJobDelayMs: 0, logger: quietLogger(),
      zbFetchFn, updateJobStatusFn,
    });
    expect(second.summary.scanned).toBe(0);
    expect(second.summary.updated_cancelled).toBe(0);
    expect(updateJobStatusFn).toHaveBeenCalledTimes(1); // unchanged from first run
  });

  test('does not regress a paid SF row even when ZB says canceled', async () => {
    const supabase = makeSupabase({
      jobs: [
        { id: 500, user_id: 2, zenbooker_id: 'zb_paid', status: 'paid', scheduled_date: makeFutureDate(2) },
      ],
    });
    const updateJobStatusFn = jest.fn();
    const zbFetchFn = jest.fn().mockResolvedValue({ canceled: true });

    const { summary } = await reconcileFutureJobs({
      supabase, userId: 2, apiKey: 'k', dryRun: false,
      lookaheadDays: 30, perJobDelayMs: 0, logger: quietLogger(),
      zbFetchFn, updateJobStatusFn,
    });

    // The eligible-status filter excludes 'paid' at query time, so scanned=0.
    expect(summary.scanned).toBe(0);
    expect(updateJobStatusFn).not.toHaveBeenCalled();
  });

  test('dry-run produces no writes across all rows', async () => {
    const supabase = makeSupabase({
      jobs: [
        { id: 600, user_id: 2, zenbooker_id: 'zb_a', status: 'scheduled', scheduled_date: makeFutureDate(3) },
        { id: 601, user_id: 2, zenbooker_id: 'zb_b', status: 'scheduled', scheduled_date: makeFutureDate(4) },
      ],
      cleaner_ledger: [
        { id: 80, job_id: 600, type: 'earning', amount: 50, payout_batch_id: null },
      ],
    });
    const updateJobStatusFn = jest.fn();
    const zbFetchFn = jest.fn().mockResolvedValue({ canceled: true });

    const { summary, changes } = await reconcileFutureJobs({
      supabase, userId: 2, apiKey: 'k', dryRun: true,
      lookaheadDays: 30, perJobDelayMs: 0, logger: quietLogger(),
      zbFetchFn, updateJobStatusFn,
    });

    expect(summary.would_update_cancelled).toBe(2);
    expect(summary.updated_cancelled).toBe(0);
    expect(changes).toHaveLength(2);
    expect(changes.every(c => c.dryRun === true)).toBe(true);
    expect(updateJobStatusFn).not.toHaveBeenCalled();
    // Ledger row should still be present.
    expect(supabase._state.cleaner_ledger.map(r => r.id)).toEqual([80]);
  });

  test('respects zenbookerIdFilter (one-shot repair use case)', async () => {
    const supabase = makeSupabase({
      jobs: [
        { id: 700, user_id: 2, zenbooker_id: 'zb_target', status: 'scheduled', scheduled_date: makeFutureDate(2) },
        { id: 701, user_id: 2, zenbooker_id: 'zb_other',  status: 'scheduled', scheduled_date: makeFutureDate(3) },
      ],
    });
    const updateJobStatusFn = jest.fn().mockResolvedValue({});
    const zbFetchFn = jest.fn().mockResolvedValue({ canceled: true });

    const { summary } = await reconcileFutureJobs({
      supabase, userId: 2, apiKey: 'k', dryRun: false,
      lookaheadDays: 30, perJobDelayMs: 0, logger: quietLogger(),
      zenbookerIdFilter: ['zb_target'],
      zbFetchFn, updateJobStatusFn,
    });

    expect(summary.scanned).toBe(1);
    expect(summary.updated_cancelled).toBe(1);
    expect(updateJobStatusFn.mock.calls[0][1].jobId).toBe(700);
  });
});

// ── reconcileRecurringBooking (the recurring_booking.canceled path) ─

describe('reconcileRecurringBooking', () => {
  test('fetches the booking, reconciles each instance, preserves completed ones', async () => {
    const supabase = makeSupabase({
      jobs: [
        { id: 800, user_id: 2, zenbooker_id: 'zb_past_done',   status: 'completed', scheduled_date: '2026-05-01' },
        { id: 801, user_id: 2, zenbooker_id: 'zb_future_cxl',  status: 'scheduled', scheduled_date: '2026-06-01' },
        { id: 802, user_id: 2, zenbooker_id: 'zb_future_open', status: 'scheduled', scheduled_date: '2026-06-08' },
      ],
    });
    const updateJobStatusFn = jest.fn(async (sb, { jobId, newStatus }) => {
      const row = sb._state.jobs.find(j => j.id === jobId);
      if (row) row.status = newStatus;
    });
    const zbFetchFn = jest.fn(async (apiKey, path) => {
      if (path === '/recurring-bookings/rb1') {
        return { id: 'rb1', jobs: ['zb_past_done', 'zb_future_cxl', 'zb_future_open'] };
      }
      if (path === '/jobs/zb_past_done')   return { canceled: false };  // (would be skipped anyway; SF is completed)
      if (path === '/jobs/zb_future_cxl')  return { canceled: true };
      if (path === '/jobs/zb_future_open') return { canceled: false };
      throw new Error(`unexpected path ${path}`);
    });

    const { summary, jobsFromZb, changes } = await reconcileRecurringBooking({
      supabase,
      userId: 2,
      apiKey: 'k',
      recurringBookingZbId: 'rb1',
      dryRun: false,
      logger: quietLogger(),
      zbFetchFn,
      updateJobStatusFn,
    });

    expect(jobsFromZb).toBe(3);
    expect(summary.scanned).toBe(3);
    expect(summary.updated_cancelled).toBe(1);
    expect(summary.skipped_hard_terminal).toBe(1);
    expect(summary.already_in_sync).toBe(1);
    expect(changes).toHaveLength(1);
    expect(changes[0].jobId).toBe(801);

    // Verify only the targeted row mutated.
    const statuses = supabase._state.jobs.reduce((m, j) => { m[j.id] = j.status; return m; }, {});
    expect(statuses).toEqual({ 800: 'completed', 801: 'cancelled', 802: 'scheduled' });
  });

  test('cross-tenant safety: ZB job ids that match a different user are not touched', async () => {
    const supabase = makeSupabase({
      jobs: [
        // A foreign tenant has a row with the same zenbooker_id we'll see in the booking.
        // The reconciler MUST scope by user_id and never touch this.
        { id: 900, user_id: 99, zenbooker_id: 'zb_shared', status: 'scheduled', scheduled_date: '2026-06-01' },
        { id: 901, user_id: 2,  zenbooker_id: 'zb_mine',   status: 'scheduled', scheduled_date: '2026-06-08' },
      ],
    });
    const updateJobStatusFn = jest.fn().mockResolvedValue({});
    const zbFetchFn = jest.fn(async (apiKey, path) => {
      if (path === '/recurring-bookings/rb_x') return { jobs: ['zb_shared', 'zb_mine'] };
      return { canceled: true };
    });

    const { summary } = await reconcileRecurringBooking({
      supabase,
      userId: 2,
      apiKey: 'k',
      recurringBookingZbId: 'rb_x',
      dryRun: false,
      logger: quietLogger(),
      zbFetchFn,
      updateJobStatusFn,
    });

    // Only the user_id=2 row should be in scope, even though both ZB ids appear.
    expect(summary.scanned).toBe(1);
    expect(summary.updated_cancelled).toBe(1);
    const updatedJobIds = updateJobStatusFn.mock.calls.map(c => c[1].jobId);
    expect(updatedJobIds).toEqual([901]);
    // Foreign tenant row untouched.
    expect(supabase._state.jobs.find(j => j.id === 900).status).toBe('scheduled');
  });

  test('booking returning empty jobs array logs and returns zeroes', async () => {
    const supabase = makeSupabase({ jobs: [] });
    const updateJobStatusFn = jest.fn();
    const zbFetchFn = jest.fn().mockResolvedValue({ jobs: [] });

    const { summary, jobsFromZb } = await reconcileRecurringBooking({
      supabase, userId: 2, apiKey: 'k',
      recurringBookingZbId: 'rb_empty',
      dryRun: false, logger: quietLogger(),
      zbFetchFn, updateJobStatusFn,
    });

    expect(jobsFromZb).toBe(0);
    expect(summary.scanned).toBe(0);
    expect(updateJobStatusFn).not.toHaveBeenCalled();
  });

  test('ZB fetch failure on the booking is surfaced but does not throw', async () => {
    const supabase = makeSupabase();
    const updateJobStatusFn = jest.fn();
    const zbFetchFn = jest.fn().mockRejectedValue(new Error('Zenbooker API 500: boom'));

    const { summary, jobsFromZb } = await reconcileRecurringBooking({
      supabase, userId: 2, apiKey: 'k',
      recurringBookingZbId: 'rb_fail',
      dryRun: false, logger: quietLogger(),
      zbFetchFn, updateJobStatusFn,
    });

    expect(jobsFromZb).toBe(0);
    expect(summary.scanned).toBe(0);
    expect(updateJobStatusFn).not.toHaveBeenCalled();
  });
});
