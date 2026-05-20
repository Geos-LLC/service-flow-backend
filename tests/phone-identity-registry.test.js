/**
 * Phone Identity Registry — JS-side helper tests (P0.1).
 *
 * Trigger-side behavior (collision detection in PostgreSQL) is exercised
 * by the prod backfill which seeded 27 real conflicts on first run;
 * those are validated end-to-end via the operator endpoint smokes after
 * deploy. These unit tests cover:
 *
 *   - listConflicts pagination + filtering + tenant scope
 *   - getConflict tenant scope
 *   - resolveConflict happy paths (keep_separate, ignore)
 *   - resolveConflict guards (unsupported action, not_found, not_open)
 *   - summary aggregation
 *   - newConflictsPerDay bucket logic
 *   - emitIdentityConflictLog shape (Loki-searchable)
 *   - maskPhone PII protection
 */

const {
  PHASE_1_ACTIONS,
  VALID_SEVERITIES,
  VALID_STATUSES,
  listConflicts,
  getConflict,
  resolveConflict,
  summary,
  newConflictsPerDay,
  emitIdentityConflictLog,
  maskPhone,
} = require('../lib/phone-identity-registry');

// ────────────────────────────────────────────────────────────────────
// maskPhone
// ────────────────────────────────────────────────────────────────────

describe('maskPhone', () => {
  test('shows only last 2 digits', () => { expect(maskPhone('7272974561')).toBe('***61'); });
  test('handles formatted input', () => { expect(maskPhone('+1 (727) 297-4561')).toBe('***61'); });
  test('very short → ***', () => { expect(maskPhone('5')).toBe('***'); });
  test('null/undefined safe', () => { expect(maskPhone(null)).toBe('***'); });
});

// ────────────────────────────────────────────────────────────────────
// listConflicts
// ────────────────────────────────────────────────────────────────────

function makeListSupabase({ rows = [], count = null, error = null } = {}) {
  const captured = {};
  return {
    captured,
    from: jest.fn((tbl) => {
      captured.table = tbl;
      const chain = {
        eq: jest.fn(function (col, val) {
          captured[`eq_${col}`] = val;
          return chain;
        }),
        order: jest.fn(function () { return chain; }),
        range: jest.fn(async function (start, end) {
          captured.range = [start, end];
          return { data: rows, count: count != null ? count : rows.length, error };
        }),
      };
      return {
        select: jest.fn(function (cols, opts) {
          captured.select_cols = cols;
          captured.select_opts = opts;
          return chain;
        }),
      };
    }),
  };
}

describe('listConflicts', () => {
  test('returns rows + total, applies tenant scope', async () => {
    const supabase = makeListSupabase({ rows: [{ id: 1 }, { id: 2 }], count: 2 });
    const r = await listConflicts(supabase, 2);
    expect(r.rows).toHaveLength(2);
    expect(r.total).toBe(2);
    expect(supabase.captured.eq_workspace_id).toBe(2);
    expect(supabase.captured.eq_status).toBe('open');
  });

  test('defaults limit=50 offset=0', async () => {
    const supabase = makeListSupabase();
    await listConflicts(supabase, 2);
    expect(supabase.captured.range).toEqual([0, 49]);
  });

  test('respects custom limit + offset', async () => {
    const supabase = makeListSupabase();
    await listConflicts(supabase, 2, { limit: 25, offset: 50 });
    expect(supabase.captured.range).toEqual([50, 74]);
  });

  test('caps limit at 200', async () => {
    const supabase = makeListSupabase();
    await listConflicts(supabase, 2, { limit: 9999 });
    expect(supabase.captured.range).toEqual([0, 199]);
  });

  test('rejects unknown status', async () => {
    const supabase = makeListSupabase();
    const r = await listConflicts(supabase, 2, { status: 'banana' });
    expect(r.error).toBe('invalid_status');
    expect(r.rows).toEqual([]);
  });

  test('filters by severity when provided', async () => {
    const supabase = makeListSupabase();
    await listConflicts(supabase, 2, { severity: 'cross_role_duplicate' });
    expect(supabase.captured.eq_severity).toBe('cross_role_duplicate');
  });

  test('rejects unknown severity', async () => {
    const supabase = makeListSupabase();
    const r = await listConflicts(supabase, 2, { severity: 'banana' });
    expect(r.error).toBe('invalid_severity');
  });
});

// ────────────────────────────────────────────────────────────────────
// getConflict + resolveConflict
// ────────────────────────────────────────────────────────────────────

function makeSingleSupabase({ row = null, error = null, updateError = null } = {}) {
  const captured = { update_calls: [] };
  return {
    captured,
    from: jest.fn((tbl) => {
      captured.table = tbl;
      return {
        select: jest.fn(() => ({
          eq: jest.fn(() => ({
            eq: jest.fn(() => ({
              maybeSingle: jest.fn(async () => ({ data: row, error })),
            })),
          })),
        })),
        update: jest.fn((patch) => {
          captured.update_calls.push(patch);
          return {
            eq: jest.fn(() => ({
              eq: jest.fn(async () => ({ error: updateError })),
            })),
          };
        }),
      };
    }),
  };
}

describe('getConflict', () => {
  test('returns row when found', async () => {
    const supabase = makeSingleSupabase({ row: { id: 1, status: 'open', workspace_id: 2 } });
    const r = await getConflict(supabase, 2, 1);
    expect(r.row).toEqual({ id: 1, status: 'open', workspace_id: 2 });
  });

  test('returns null when not found', async () => {
    const supabase = makeSingleSupabase({ row: null });
    const r = await getConflict(supabase, 2, 999);
    expect(r.row).toBeNull();
  });

  test('propagates supabase error', async () => {
    const supabase = makeSingleSupabase({ error: { message: 'db fault' } });
    const r = await getConflict(supabase, 2, 1);
    expect(r.error).toBe('db fault');
  });
});

describe('resolveConflict — happy path', () => {
  test('keep_separate marks status=resolved + emits log + updates resolution', async () => {
    const supabase = makeSingleSupabase({
      row: { id: 1, status: 'open', workspace_id: 2, normalized_phone: '7272974561', severity: 'cross_role_duplicate', owners: [{}, {}] },
    });
    const logger = { log: jest.fn(), error: jest.fn() };
    const r = await resolveConflict(supabase, logger, 2, 1, 'keep_separate', { note: 'intentional twin', resolvedByUserId: 99 });

    expect(r.ok).toBe(true);
    const patch = supabase.captured.update_calls[0];
    expect(patch.status).toBe('resolved');
    expect(patch.resolution).toBe('keep_separate');
    expect(patch.resolved_by).toBe(99);
    expect(patch.resolution_note).toBe('intentional twin');
    expect(logger.log).toHaveBeenCalledWith(expect.stringMatching(/^\[IdentityConflict\] action=keep_separate/));
  });

  test('ignore sets status=ignored (not resolved)', async () => {
    const supabase = makeSingleSupabase({
      row: { id: 1, status: 'open', workspace_id: 2, normalized_phone: '7272974561', severity: 'cross_role_duplicate', owners: [{}, {}] },
    });
    const logger = { log: jest.fn(), error: jest.fn() };
    const r = await resolveConflict(supabase, logger, 2, 1, 'ignore');
    expect(r.ok).toBe(true);
    expect(supabase.captured.update_calls[0].status).toBe('ignored');
    expect(supabase.captured.update_calls[0].resolution).toBe('ignore');
  });

  test('note >1000 chars is truncated', async () => {
    const supabase = makeSingleSupabase({
      row: { id: 1, status: 'open', workspace_id: 2, normalized_phone: '7272974561', severity: 'cross_role_duplicate', owners: [] },
    });
    const logger = { log: jest.fn() };
    await resolveConflict(supabase, logger, 2, 1, 'keep_separate', { note: 'x'.repeat(5000) });
    expect(supabase.captured.update_calls[0].resolution_note.length).toBe(1000);
  });
});

describe('resolveConflict — guards', () => {
  test('rejects unsupported action (merge)', async () => {
    const supabase = makeSingleSupabase({ row: { id: 1, status: 'open' } });
    const logger = { log: jest.fn() };
    const r = await resolveConflict(supabase, logger, 2, 1, 'merge');
    expect(r.ok).toBe(false);
    expect(r.error).toBe('unsupported_action');
    expect(r.supported).toEqual(['keep_separate', 'ignore']);
  });

  test('rejects unsupported action (change_owner) — Phase 2', async () => {
    const supabase = makeSingleSupabase({ row: { id: 1, status: 'open' } });
    const r = await resolveConflict(supabase, { log: jest.fn() }, 2, 1, 'change_owner');
    expect(r.ok).toBe(false);
    expect(r.error).toBe('unsupported_action');
  });

  test('rejects unknown action', async () => {
    const supabase = makeSingleSupabase({ row: { id: 1, status: 'open' } });
    const r = await resolveConflict(supabase, { log: jest.fn() }, 2, 1, 'banana');
    expect(r.error).toBe('unsupported_action');
  });

  test('404 when conflict not found', async () => {
    const supabase = makeSingleSupabase({ row: null });
    const r = await resolveConflict(supabase, { log: jest.fn() }, 2, 999, 'keep_separate');
    expect(r.error).toBe('not_found');
  });

  test('409 when conflict already resolved', async () => {
    const supabase = makeSingleSupabase({ row: { id: 1, status: 'resolved' } });
    const r = await resolveConflict(supabase, { log: jest.fn() }, 2, 1, 'keep_separate');
    expect(r.error).toBe('not_open');
    expect(r.current_status).toBe('resolved');
  });

  test('logs error on supabase update failure', async () => {
    const supabase = makeSingleSupabase({
      row: { id: 1, status: 'open', normalized_phone: '7272974561', severity: 'cross_role_duplicate', owners: [] },
      updateError: { message: 'db fault' },
    });
    const logger = { log: jest.fn(), error: jest.fn() };
    const r = await resolveConflict(supabase, logger, 2, 1, 'keep_separate');
    expect(r.ok).toBe(false);
    expect(logger.error).toHaveBeenCalledWith(expect.stringMatching(/resolve failed/));
  });
});

// ────────────────────────────────────────────────────────────────────
// summary
// ────────────────────────────────────────────────────────────────────

function makeSummarySupabase(counts) {
  // counts: { allOpen, crossRole, sameRole, newInWindow }
  let callIdx = 0;
  const order = ['allOpen', 'crossRole', 'sameRole', 'newInWindow'];
  return {
    from: jest.fn(() => ({
      select: jest.fn(() => ({
        eq: jest.fn(function () {
          // Chained .eq() calls — we don't care about which; only return the head-count.
          const self = this;
          return {
            eq: jest.fn(function () {
              return self;
            }),
            gte: jest.fn(function () { return self; }),
            then: undefined,
          };
        }),
        gte: jest.fn(function () { return this; }),
        then: undefined,
      })),
    })),
  };
}

describe('summary', () => {
  test('returns ok=true with all counts', async () => {
    // Simpler approach: stub select chain to terminate with parallel-friendly thenables.
    const makeChain = (count) => {
      const chain = {
        eq: jest.fn(() => chain),
        gte: jest.fn(() => chain),
        then: (onFulfilled) => onFulfilled({ count, data: null, error: null }),
      };
      return chain;
    };
    let i = 0;
    const counts = [27, 17, 10, 3]; // allOpen, crossRole, sameRole, newInWindow
    const supabase = {
      from: jest.fn(() => ({
        select: jest.fn(() => makeChain(counts[i++])),
      })),
    };
    const r = await summary(supabase, 2);
    expect(r.ok).toBe(true);
    expect(r.identity_conflict_count).toBe(27);
    expect(r.cross_role_phone_count).toBe(17);
    expect(r.same_role_phone_count).toBe(10);
    expect(r.new_conflicts_in_window).toBe(3);
    expect(r.window_days).toBe(7);
    expect(r.generated_at).toEqual(expect.any(String));
  });

  test('respects custom windowDays (capped at 90)', async () => {
    let i = 0;
    const counts = [0, 0, 0, 0];
    const makeChain = () => {
      const chain = {
        eq: jest.fn(() => chain),
        gte: jest.fn(() => chain),
        then: (onFulfilled) => onFulfilled({ count: counts[i++], error: null }),
      };
      return chain;
    };
    const supabase = { from: jest.fn(() => ({ select: jest.fn(() => makeChain()) })) };
    const r = await summary(supabase, 2, { windowDays: 9999 });
    expect(r.window_days).toBe(90);
  });
});

// ────────────────────────────────────────────────────────────────────
// newConflictsPerDay
// ────────────────────────────────────────────────────────────────────

describe('newConflictsPerDay', () => {
  test('buckets rows by ISO day', async () => {
    const supabase = {
      from: jest.fn(() => ({
        select: jest.fn(() => ({
          eq: jest.fn(() => ({
            gte: jest.fn(async () => ({
              data: [
                { created_at: '2026-05-18T01:02:03Z' },
                { created_at: '2026-05-18T13:00:00Z' },
                { created_at: '2026-05-19T07:00:00Z' },
                { created_at: '2026-05-20T00:00:00Z' },
                { created_at: '2026-05-20T23:59:59Z' },
              ],
              error: null,
            })),
          })),
        })),
      })),
    };
    const r = await newConflictsPerDay(supabase, 2, 14);
    expect(r.ok).toBe(true);
    expect(r.rows).toEqual([
      { day: '2026-05-18', count: 2 },
      { day: '2026-05-19', count: 1 },
      { day: '2026-05-20', count: 2 },
    ]);
  });

  test('clamps days to [1, 90]', async () => {
    const supabase = {
      from: jest.fn(() => ({
        select: jest.fn(() => ({
          eq: jest.fn(() => ({ gte: jest.fn(async () => ({ data: [], error: null })) })),
        })),
      })),
    };
    expect((await newConflictsPerDay(supabase, 2, 0)).window_days).toBe(1);
    expect((await newConflictsPerDay(supabase, 2, 9999)).window_days).toBe(90);
  });
});

// ────────────────────────────────────────────────────────────────────
// emitIdentityConflictLog — Loki shape
// ────────────────────────────────────────────────────────────────────

describe('emitIdentityConflictLog', () => {
  test('emits structured log line with [IdentityConflict] prefix', () => {
    const logger = { log: jest.fn() };
    emitIdentityConflictLog(logger, {
      action: 'keep_separate',
      conflict_id: 18,
      workspace_id: 2,
      normalized_phone: '7272974561',
      severity: 'cross_role_duplicate',
      owners_count: 2,
      resolved_by: 99,
      result: 'success',
    });
    const msg = logger.log.mock.calls[0][0];
    expect(msg).toMatch(/^\[IdentityConflict\]/);
    expect(msg).toMatch(/action=keep_separate/);
    expect(msg).toMatch(/conflict_id=18/);
    expect(msg).toMatch(/workspace_id=2/);
    expect(msg).toMatch(/normalized_phone=\*\*\*61/); // PII masked
    expect(msg).toMatch(/severity=cross_role_duplicate/);
    expect(msg).toMatch(/owners_count=2/);
    expect(msg).toMatch(/resolved_by=99/);
    expect(msg).toMatch(/result=success/);
  });

  test('masks raw phone, never prints full digits', () => {
    const logger = { log: jest.fn() };
    emitIdentityConflictLog(logger, { normalized_phone: '7272974561' });
    const msg = logger.log.mock.calls[0][0];
    expect(msg).not.toMatch(/7272974561/);
  });

  test('does not throw when logger missing', () => {
    expect(() => emitIdentityConflictLog(null, {})).not.toThrow();
    expect(() => emitIdentityConflictLog({}, {})).not.toThrow();
  });
});

// ────────────────────────────────────────────────────────────────────
// Exports sanity
// ────────────────────────────────────────────────────────────────────

describe('exports sanity', () => {
  test('PHASE_1_ACTIONS contains only keep_separate + ignore', () => {
    expect(PHASE_1_ACTIONS).toEqual(['keep_separate', 'ignore']);
  });
  test('VALID_SEVERITIES is the canonical 3-set', () => {
    expect(VALID_SEVERITIES).toEqual([
      'same_role_duplicate',
      'cross_role_duplicate',
      'cross_tenant_duplicate',
    ]);
  });
  test('VALID_STATUSES is the canonical 3-set', () => {
    expect(VALID_STATUSES).toEqual(['open', 'resolved', 'ignored']);
  });
});
