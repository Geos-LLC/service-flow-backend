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
  COMBINE_SUPPORTED_TYPES,
  DELETE_SUPPORTED_TYPES,
  VALID_SEVERITIES,
  VALID_STATUSES,
  listConflicts,
  getConflict,
  resolveConflict,
  deleteOwner,
  combine,
  summary,
  newConflictsPerDay,
  emitIdentityConflictLog,
  maskPhone,
  classifyExternalSource,
  enrichOwners,
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

// ────────────────────────────────────────────────────────────────────
// deleteOwner — delete one source entity row (P0.1.2, 2026-05-21)
// ────────────────────────────────────────────────────────────────────

function makeDeleteSupabase({ conflict = null, deleteError = null } = {}) {
  const captured = { deletes: [] };
  return {
    captured,
    from: jest.fn((tbl) => {
      if (tbl === 'identity_conflicts') {
        return {
          select: jest.fn(() => ({
            eq: jest.fn(() => ({
              eq: jest.fn(() => ({
                maybeSingle: jest.fn(async () => ({ data: conflict, error: null })),
              })),
            })),
          })),
        };
      }
      // customers / team_members / leads — handles DELETE
      return {
        delete: jest.fn(() => ({
          eq: jest.fn(() => ({
            eq: jest.fn(async (col, val) => {
              captured.deletes.push({ table: tbl, eq_col: col, eq_val: val });
              return { error: deleteError };
            }),
          })),
        })),
      };
    }),
  };
}

describe('deleteOwner', () => {
  const baseConflict = {
    id: 1,
    workspace_id: 2,
    normalized_phone: '2483462681',
    status: 'open',
    severity: 'cross_role_duplicate',
    owners: [
      { entity_type: 'customer',    entity_id: '23115' },
      { entity_type: 'customer',    entity_id: '23467' },
      { entity_type: 'team_member', entity_id: '2623' },
    ],
  };

  test('deletes a customer owner and emits audit log', async () => {
    const supabase = makeDeleteSupabase({ conflict: baseConflict });
    const logger = { log: jest.fn(), error: jest.fn() };
    const r = await deleteOwner(supabase, logger, 2, 1, 'customer', '23115');
    expect(r.ok).toBe(true);
    expect(r.deleted).toEqual({ entity_type: 'customer', entity_id: '23115' });
    expect(supabase.captured.deletes).toHaveLength(1);
    expect(supabase.captured.deletes[0].table).toBe('customers');
    expect(logger.log).toHaveBeenCalledWith(expect.stringMatching(/\[IdentityConflict\] action=delete_owner/));
  });

  test('routes team_member delete to team_members table', async () => {
    const supabase = makeDeleteSupabase({ conflict: baseConflict });
    await deleteOwner(supabase, { log: jest.fn() }, 2, 1, 'team_member', '2623');
    expect(supabase.captured.deletes[0].table).toBe('team_members');
  });

  test('routes lead delete to leads table', async () => {
    const conflict = {
      ...baseConflict,
      owners: [{ entity_type: 'lead', entity_id: '67' }],
    };
    const supabase = makeDeleteSupabase({ conflict });
    await deleteOwner(supabase, { log: jest.fn() }, 2, 1, 'lead', '67');
    expect(supabase.captured.deletes[0].table).toBe('leads');
  });

  test('refuses unsupported entity_type (user)', async () => {
    const supabase = makeDeleteSupabase({ conflict: baseConflict });
    const r = await deleteOwner(supabase, { log: jest.fn() }, 2, 1, 'user', '2');
    expect(r.ok).toBe(false);
    expect(r.error).toBe('unsupported_entity_type');
    expect(r.supported).toEqual(['customer', 'team_member', 'lead']);
  });

  test('refuses owner not in conflict (defensive against stale UI)', async () => {
    const supabase = makeDeleteSupabase({ conflict: baseConflict });
    const r = await deleteOwner(supabase, { log: jest.fn() }, 2, 1, 'customer', '99999');
    expect(r.ok).toBe(false);
    expect(r.error).toBe('owner_not_in_conflict');
  });

  test('404 when conflict missing', async () => {
    const supabase = makeDeleteSupabase({ conflict: null });
    const r = await deleteOwner(supabase, { log: jest.fn() }, 2, 999, 'customer', '23115');
    expect(r.ok).toBe(false);
    expect(r.error).toBe('not_found');
  });

  test('surfaces FK violation as source_delete_failed', async () => {
    const supabase = makeDeleteSupabase({
      conflict: baseConflict,
      deleteError: { message: 'violates foreign key constraint "jobs_customer_id_fkey"' },
    });
    const logger = { log: jest.fn(), error: jest.fn() };
    const r = await deleteOwner(supabase, logger, 2, 1, 'customer', '23115');
    expect(r.ok).toBe(false);
    expect(r.error).toBe('source_delete_failed');
    expect(r.sourceError).toMatch(/jobs_customer_id_fkey/);
    expect(logger.error).toHaveBeenCalled();
  });

  test('exports DELETE_SUPPORTED_TYPES is canonical 3-set', () => {
    expect(DELETE_SUPPORTED_TYPES).toEqual(['customer', 'team_member', 'lead']);
  });
});

// ────────────────────────────────────────────────────────────────────
// combine — same-type merge via RPC (P0.1.2, 2026-05-21)
// ────────────────────────────────────────────────────────────────────

function makeCombineSupabase({ conflict = null, rpcResult = null, rpcError = null, updateCaptured = {} } = {}) {
  const captured = { rpcCalls: [], updates: [] };
  return {
    captured,
    from: jest.fn((tbl) => {
      if (tbl === 'identity_conflicts') {
        return {
          select: jest.fn(() => ({
            eq: jest.fn(() => ({
              eq: jest.fn(() => ({
                maybeSingle: jest.fn(async () => ({ data: conflict, error: null })),
              })),
            })),
          })),
          update: jest.fn((patch) => {
            captured.updates.push(patch);
            return {
              eq: jest.fn(() => ({
                eq: jest.fn(() => ({
                  eq: jest.fn(async () => ({ error: null })),
                })),
              })),
            };
          }),
        };
      }
      return {};
    }),
    rpc: jest.fn(async (name, args) => {
      captured.rpcCalls.push({ name, args });
      if (rpcError) return { data: null, error: rpcError };
      return { data: rpcResult || { ok: true, primary_id: args.p_primary_id, secondary_id: args.p_secondary_id }, error: null };
    }),
  };
}

describe('combine', () => {
  const baseConflict = {
    id: 14,
    workspace_id: 2,
    normalized_phone: '3475273907',
    status: 'open',
    severity: 'same_role_duplicate',
    owners: [
      { entity_type: 'customer', entity_id: '100' },
      { entity_type: 'customer', entity_id: '101' },
      { entity_type: 'customer', entity_id: '102' },
    ],
  };

  test('combines two customer secondaries into primary via RPC', async () => {
    const supabase = makeCombineSupabase({ conflict: baseConflict });
    const logger = { log: jest.fn(), error: jest.fn() };
    const r = await combine(supabase, logger, 2, 14,
      { entity_type: 'customer', entity_id: '100' },
      [{ entity_type: 'customer', entity_id: '101' }, { entity_type: 'customer', entity_id: '102' }]
    );
    expect(r.ok).toBe(true);
    expect(supabase.captured.rpcCalls).toHaveLength(2);
    expect(supabase.captured.rpcCalls[0]).toEqual({
      name: 'pir_combine_customers',
      args: { p_workspace_id: 2, p_primary_id: 100, p_secondary_id: 101 },
    });
    expect(supabase.captured.rpcCalls[1].args.p_secondary_id).toBe(102);
    expect(supabase.captured.updates[0].status).toBe('resolved');
    expect(supabase.captured.updates[0].resolution).toBe('merge');
    expect(logger.log).toHaveBeenCalledWith(expect.stringMatching(/\[IdentityConflict\] action=combine/));
  });

  test('routes lead combine to pir_combine_leads', async () => {
    const leadConflict = {
      ...baseConflict,
      owners: [
        { entity_type: 'lead', entity_id: '50' },
        { entity_type: 'lead', entity_id: '51' },
      ],
    };
    const supabase = makeCombineSupabase({ conflict: leadConflict });
    await combine(supabase, { log: jest.fn() }, 2, 14,
      { entity_type: 'lead', entity_id: '50' },
      [{ entity_type: 'lead', entity_id: '51' }]
    );
    expect(supabase.captured.rpcCalls[0].name).toBe('pir_combine_leads');
  });

  test('refuses unsupported primary type (team_member)', async () => {
    const supabase = makeCombineSupabase({ conflict: baseConflict });
    const r = await combine(supabase, { log: jest.fn() }, 2, 14,
      { entity_type: 'team_member', entity_id: '2623' },
      [{ entity_type: 'team_member', entity_id: '2624' }]
    );
    expect(r.ok).toBe(false);
    expect(r.error).toBe('unsupported_primary_type');
    expect(r.supported).toEqual(['customer', 'lead']);
  });

  test('refuses mixed entity types in secondaries', async () => {
    const supabase = makeCombineSupabase({ conflict: baseConflict });
    const r = await combine(supabase, { log: jest.fn() }, 2, 14,
      { entity_type: 'customer', entity_id: '100' },
      [{ entity_type: 'lead', entity_id: '101' }]
    );
    expect(r.error).toBe('mixed_entity_types_not_supported');
  });

  test('refuses empty secondaries', async () => {
    const supabase = makeCombineSupabase({ conflict: baseConflict });
    const r = await combine(supabase, { log: jest.fn() }, 2, 14,
      { entity_type: 'customer', entity_id: '100' },
      []
    );
    expect(r.error).toBe('no_secondaries');
  });

  test('refuses secondary not in conflict (defensive)', async () => {
    const supabase = makeCombineSupabase({ conflict: baseConflict });
    const r = await combine(supabase, { log: jest.fn() }, 2, 14,
      { entity_type: 'customer', entity_id: '100' },
      [{ entity_type: 'customer', entity_id: '999' }]
    );
    expect(r.error).toBe('secondary_not_in_conflict');
  });

  test('refuses primary equal to a secondary', async () => {
    const supabase = makeCombineSupabase({ conflict: baseConflict });
    const r = await combine(supabase, { log: jest.fn() }, 2, 14,
      { entity_type: 'customer', entity_id: '100' },
      [{ entity_type: 'customer', entity_id: '100' }]
    );
    expect(r.error).toBe('secondary_equals_primary');
  });

  test('surfaces RPC failure with sourceError; returns partial progress', async () => {
    const supabase = makeCombineSupabase({
      conflict: baseConflict,
      rpcError: { message: 'transaction aborted: deadlock' },
    });
    const logger = { log: jest.fn(), error: jest.fn() };
    const r = await combine(supabase, logger, 2, 14,
      { entity_type: 'customer', entity_id: '100' },
      [{ entity_type: 'customer', entity_id: '101' }]
    );
    expect(r.ok).toBe(false);
    expect(r.error).toBe('combine_rpc_failed');
    expect(r.sourceError).toMatch(/deadlock/);
    expect(logger.error).toHaveBeenCalled();
  });

  test('exports COMBINE_SUPPORTED_TYPES is canonical 2-set', () => {
    expect(COMBINE_SUPPORTED_TYPES).toEqual(['customer', 'lead']);
  });
});

// ────────────────────────────────────────────────────────────────────
// classifyExternalSource + enrichOwners (added 2026-05-20 evening)
// ────────────────────────────────────────────────────────────────────

describe('classifyExternalSource', () => {
  test('customer with zenbooker_id → zenbooker', () => {
    expect(classifyExternalSource('customer', { zenbooker_id: '1778631…', source: 'Thumbtack Tampa' }))
      .toBe('zenbooker');
  });
  test('team_member with zenbooker_id → zenbooker', () => {
    expect(classifyExternalSource('team_member', { zenbooker_id: 'x' })).toBe('zenbooker');
  });
  test('customer with leadbridge-style source → leadbridge', () => {
    expect(classifyExternalSource('customer', { source: 'leadbridge_thumbtack' })).toBe('leadbridge');
    expect(classifyExternalSource('customer', { source: 'Thumbtack Tampa' })).toBe('leadbridge');
    expect(classifyExternalSource('customer', { source: 'Yelp Jacksonville' })).toBe('leadbridge');
  });
  test('lead with thumbtack/yelp source → leadbridge', () => {
    expect(classifyExternalSource('lead', { source: 'Spotless Homes Tampa (thumbtack)' }))
      .toBe('leadbridge');
  });
  test('source contains openphone → openphone', () => {
    expect(classifyExternalSource('customer', { source: 'openphone_sync' })).toBe('openphone');
  });
  test('no zenbooker_id and no external source → sf', () => {
    expect(classifyExternalSource('customer', { source: 'Website' })).toBe('sf');
    expect(classifyExternalSource('lead', { source: 'Cold Call' })).toBe('sf');
    expect(classifyExternalSource('team_member', { zenbooker_id: null })).toBe('sf');
  });
  test('null row → unknown', () => {
    expect(classifyExternalSource('customer', null)).toBe('unknown');
  });
});

function makeEnrichSupabase({ customers = [], team_members = [], leads = [], users = [] } = {}) {
  return {
    from: jest.fn((tbl) => {
      const rowsForTable = tbl === 'customers' ? customers
        : tbl === 'team_members' ? team_members
        : tbl === 'leads' ? leads
        : tbl === 'users' ? users
        : [];
      return {
        select: jest.fn(() => ({
          eq: jest.fn(() => ({
            in: jest.fn(async (col, ids) => ({
              data: rowsForTable.filter((r) => ids.map(String).includes(String(r.id))),
              error: null,
            })),
          })),
          in: jest.fn(async (col, ids) => ({
            data: rowsForTable.filter((r) => ids.map(String).includes(String(r.id))),
            error: null,
          })),
        })),
      };
    }),
  };
}

describe('enrichOwners — owner name + external_source + phone', () => {
  test('Kira Osipova case: customer (ZB) + lead (LB)', async () => {
    const supabase = makeEnrichSupabase({
      customers: [{ id: 23421, first_name: 'Kira', last_name: 'Osipova', phone: '3013272882', email: null, zenbooker_id: '1778…', source: 'Thumbtack Tampa' }],
      leads:     [{ id: 67,    first_name: 'Kira', last_name: 'Osipova', phone: '+13013272882', email: null, source: 'Spotless Homes Tampa (thumbtack)' }],
    });
    const rows = [{
      id: 2, normalized_phone: '3013272882',
      owners: [
        { entity_type: 'customer', entity_id: '23421', source: 'backfill_customer', first_seen: '2026-05-20T...' },
        { entity_type: 'lead',     entity_id: '67',    source: 'backfill_lead',     first_seen: '2026-05-20T...' },
      ],
    }];
    const [out] = await enrichOwners(supabase, 2, rows);
    expect(out.owners).toHaveLength(2);
    expect(out.owners[0]).toMatchObject({
      entity_type: 'customer', entity_id: '23421',
      name: 'Kira Osipova', phone: '3013272882', external_source: 'zenbooker',
    });
    expect(out.owners[1]).toMatchObject({
      entity_type: 'lead', entity_id: '67',
      name: 'Kira Osipova', phone: '+13013272882', external_source: 'leadbridge',
    });
  });

  test('missing source row → owner marked missing=true (gracefully)', async () => {
    const supabase = makeEnrichSupabase({ customers: [], leads: [] });
    const [out] = await enrichOwners(supabase, 2, [{
      id: 99, owners: [
        { entity_type: 'customer', entity_id: '99999' },
      ],
    }]);
    expect(out.owners[0].missing).toBe(true);
    expect(out.owners[0]).not.toHaveProperty('name');
  });

  test('row without owners array is left unchanged', async () => {
    const supabase = makeEnrichSupabase();
    const out = await enrichOwners(supabase, 2, [{ id: 1, status: 'open' }]);
    expect(out[0]).toEqual({ id: 1, status: 'open' });
  });

  test('user (workspace owner) enrichment uses business_name', async () => {
    const supabase = makeEnrichSupabase({
      users: [{ id: 2, first_name: 'Georgiy', last_name: 'S', email: 'g@x.com', phone: '+18139212100', business_name: 'Spotless Homes Florida LLC' }],
    });
    const [out] = await enrichOwners(supabase, 2, [{
      owners: [{ entity_type: 'user', entity_id: '2' }],
    }]);
    expect(out.owners[0].name).toBe('Spotless Homes Florida LLC');
  });

  test('batched across many conflicts: at most one query per entity type', async () => {
    const fromCalls = [];
    const supabase = {
      from: jest.fn((tbl) => {
        fromCalls.push(tbl);
        return {
          select: jest.fn(() => ({
            eq: jest.fn(() => ({
              in: jest.fn(async () => ({ data: [], error: null })),
            })),
            in: jest.fn(async () => ({ data: [], error: null })),
          })),
        };
      }),
    };
    const rows = Array.from({ length: 50 }, (_, i) => ({
      id: i, owners: [
        { entity_type: 'customer', entity_id: String(1000 + i) },
        { entity_type: 'lead',     entity_id: String(2000 + i) },
      ],
    }));
    await enrichOwners(supabase, 2, rows);
    // Customers, leads, team_members (empty), users (empty) — at most 4 total.
    expect(fromCalls.length).toBeLessThanOrEqual(4);
  });
});

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
