'use strict';

const {
  findProjectionGaps,
  applyOne,
  repairTenant,
} = require('../lib/converted-customer-projection-repair');

// ─────────────────────────────────────────────────────────────────────
// In-memory Supabase mock that mirrors the subset of features used by
// the repair module + projectIdentityToCRM in lib/identity-linker.js.
//
// Only the patterns we exercise here are implemented:
//   from(table).select(cols).eq(...).gt(...).order(...).limit(...).maybeSingle?
//   from(table).select(cols).in(col, arr)
//   from(table).update({...}).eq(...).is(...).select('id') / .maybeSingle()
//   from(table).insert({...})  (audit row)
//   rpc('pir_archive_entity', {...})  (no-op in tests)
//
// Each call returns { data, error } where error is null on success.
// ─────────────────────────────────────────────────────────────────────
function makeSupabase(state = {}) {
  state.identities ||= [];   // { id, user_id, sf_lead_id, sf_customer_id, status, last_hydrated_by, updated_at }
  state.leads ||= [];        // { id, user_id, converted_customer_id, converted_at, updated_at, pipeline_id }
  state.customers ||= [];    // { id, user_id }
  state.audit ||= [];        // identity_link_audit rows (best-effort tracking)
  state.rpcCalls ||= [];

  function table(name) {
    const rows = state[name === 'identity_link_audit' ? 'audit' :
                       name === 'communication_participant_identities' ? 'identities' :
                       name === 'leads' ? 'leads' :
                       name === 'customers' ? 'customers' :
                       name === 'lead_stages' ? 'leadStages' :
                       null];
    const q = {
      _filters: [],
      _isFilters: [],
      _orFilter: null,
      _orderBy: null,
      _limit: null,
      _inFilter: null,
      _select: '*',
      _action: 'select',
      _patch: null,
      _insertRow: null,
      select(cols) { q._select = cols; q._action = q._action === 'update' || q._action === 'insert' ? q._action : 'select'; return q; },
      eq(col, val) { q._filters.push({ op: 'eq', col, val }); return q; },
      not(col, op, val) { q._filters.push({ op: 'not_is_null', col }); return q; },
      gt(col, val) { q._filters.push({ op: 'gt', col, val }); return q; },
      is(col, val) {
        if (val === null) q._isFilters.push({ col, val: null });
        return q;
      },
      or(expr) { q._orFilter = expr; return q; },
      in(col, arr) { q._inFilter = { col, arr: new Set(arr) }; return q; },
      order(col, opts) { q._orderBy = { col, asc: opts?.ascending !== false }; return q; },
      limit(n) { q._limit = n; return q; },
      update(patch) { q._action = 'update'; q._patch = patch; return q; },
      insert(row) { q._action = 'insert'; q._insertRow = row; return q; },
      maybeSingle() { return execute(true); },
      single() { return execute(true); },
      then(resolve, reject) { return execute(false).then(resolve, reject); },
    };

    function applyFilters(arr) {
      let out = arr;
      for (const f of q._filters) {
        if (f.op === 'eq') out = out.filter(r => String(r[f.col]) === String(f.val));
        else if (f.op === 'not_is_null') out = out.filter(r => r[f.col] != null);
        else if (f.op === 'gt') out = out.filter(r => Number(r[f.col]) > Number(f.val));
      }
      for (const f of q._isFilters) {
        if (f.val === null) out = out.filter(r => r[f.col] == null);
      }
      if (q._inFilter) out = out.filter(r => q._inFilter.arr.has(r[q._inFilter.col]));
      if (q._orFilter) {
        // Only parse the limited patterns we use.
        // Pattern: "col.is.null,col.eq.value"
        const conds = q._orFilter.split(',');
        out = out.filter(r => conds.some(c => {
          const [col, op, val] = c.split('.');
          if (op === 'is' && val === 'null') return r[col] == null;
          if (op === 'eq') return String(r[col]) === String(val);
          return false;
        }));
      }
      if (q._orderBy) out = [...out].sort((a, b) => (q._orderBy.asc ? 1 : -1) * (Number(a[q._orderBy.col]) - Number(b[q._orderBy.col])));
      if (q._limit != null) out = out.slice(0, q._limit);
      return out;
    }

    async function execute(single) {
      if (q._action === 'select') {
        const data = applyFilters(rows);
        if (single) return { data: data[0] || null, error: null };
        return { data, error: null };
      }
      if (q._action === 'update') {
        const matched = applyFilters(rows);
        for (const r of matched) Object.assign(r, q._patch);
        if (q._select === 'id') return { data: matched.map(r => ({ id: r.id })), error: null };
        if (q._select === 'id, user_id, sf_lead_id, sf_customer_id, status') {
          const ret = matched.map(r => ({ id: r.id, user_id: r.user_id, sf_lead_id: r.sf_lead_id, sf_customer_id: r.sf_customer_id, status: r.status }));
          if (single) return { data: ret[0] || null, error: null };
          return { data: ret, error: null };
        }
        return { data: matched, error: null };
      }
      if (q._action === 'insert') {
        const row = Array.isArray(q._insertRow) ? q._insertRow[0] : q._insertRow;
        rows.push({ ...row, id: rows.length + 1000 });
        return { data: null, error: null };
      }
      return { data: null, error: null };
    }
    return q;
  }

  return {
    from: table,
    rpc: async (name, args) => { state.rpcCalls.push({ name, args }); return { data: null, error: null }; },
    _state: state,
  };
}

function silentLogger() {
  return { log: () => {}, warn: () => {}, error: () => {} };
}

// ─────────────────────────────────────────────────────────────────────
// Test fixtures
// ─────────────────────────────────────────────────────────────────────

function seedHappyPath() {
  return {
    identities: [
      { id: 100, user_id: 2, sf_lead_id: 67, sf_customer_id: 23421, status: 'resolved_both', updated_at: '2026-05-01' },
    ],
    leads: [
      { id: 67, user_id: 2, converted_customer_id: null, converted_at: null, updated_at: '2026-04-08', pipeline_id: 1 },
    ],
    customers: [
      { id: 23421, user_id: 2 },
    ],
  };
}

function seedConflict() {
  return {
    identities: [
      { id: 100, user_id: 2, sf_lead_id: 67, sf_customer_id: 23421 },
    ],
    leads: [
      // lead already pointing at a DIFFERENT customer — must be preserved
      { id: 67, user_id: 2, converted_customer_id: 99999, converted_at: '2026-04-10', updated_at: '2026-04-10', pipeline_id: 1 },
    ],
    customers: [
      { id: 23421, user_id: 2 },
      { id: 99999, user_id: 2 },
    ],
  };
}

function seedAlreadyCorrect() {
  return {
    identities: [
      { id: 100, user_id: 2, sf_lead_id: 67, sf_customer_id: 23421 },
    ],
    leads: [
      { id: 67, user_id: 2, converted_customer_id: 23421, converted_at: '2026-04-10', updated_at: '2026-04-10', pipeline_id: 1 },
    ],
    customers: [
      { id: 23421, user_id: 2 },
    ],
  };
}

// ─────────────────────────────────────────────────────────────────────
// findProjectionGaps
// ─────────────────────────────────────────────────────────────────────

describe('findProjectionGaps — read-only scan', () => {
  test('returns a missing-projection row when both sides set and converted_customer_id IS NULL', async () => {
    const supa = makeSupabase(seedHappyPath());
    const gaps = await findProjectionGaps(supa, 2);
    expect(gaps).toEqual([
      { identity_id: 100, sf_lead_id: 67, sf_customer_id: 23421, current_converted_customer_id: null, classification: 'missing' },
    ]);
  });

  test('classifies as mismatch when lead points at a different customer', async () => {
    const supa = makeSupabase(seedConflict());
    const gaps = await findProjectionGaps(supa, 2);
    expect(gaps).toHaveLength(1);
    expect(gaps[0].classification).toBe('mismatch');
    expect(gaps[0].current_converted_customer_id).toBe(99999);
  });

  test('returns nothing when projection is already correct', async () => {
    const supa = makeSupabase(seedAlreadyCorrect());
    const gaps = await findProjectionGaps(supa, 2);
    expect(gaps).toEqual([]);
  });

  test('skips identities with only one side set (lead-only or customer-only)', async () => {
    const supa = makeSupabase({
      identities: [
        { id: 100, user_id: 2, sf_lead_id: 67, sf_customer_id: null },
        { id: 101, user_id: 2, sf_lead_id: null, sf_customer_id: 23421 },
      ],
      leads: [{ id: 67, user_id: 2, converted_customer_id: null }],
      customers: [{ id: 23421, user_id: 2 }],
    });
    const gaps = await findProjectionGaps(supa, 2);
    expect(gaps).toEqual([]);
  });

  test('strict tenant scope: identities from another tenant are not returned', async () => {
    const supa = makeSupabase({
      identities: [
        { id: 100, user_id: 2, sf_lead_id: 67, sf_customer_id: 23421 },
        { id: 200, user_id: 7, sf_lead_id: 999, sf_customer_id: 88888 },
      ],
      leads: [
        { id: 67, user_id: 2, converted_customer_id: null },
        { id: 999, user_id: 7, converted_customer_id: null },
      ],
      customers: [
        { id: 23421, user_id: 2 },
        { id: 88888, user_id: 7 },
      ],
    });
    const gapsForUser2 = await findProjectionGaps(supa, 2);
    const gapsForUser7 = await findProjectionGaps(supa, 7);
    expect(gapsForUser2.map(g => g.identity_id)).toEqual([100]);
    expect(gapsForUser7.map(g => g.identity_id)).toEqual([200]);
  });
});

// ─────────────────────────────────────────────────────────────────────
// repairTenant — dry-run mode
// ─────────────────────────────────────────────────────────────────────

describe('repairTenant — dry-run (READ ONLY)', () => {
  test('reports classification and writes nothing', async () => {
    const seed = seedHappyPath();
    const supa = makeSupabase(seed);
    const summary = await repairTenant(supa, silentLogger(), 2, { apply: false });
    expect(summary.mode).toBe('dry-run');
    expect(summary.found).toBe(1);
    expect(summary.success).toBe(1);
    expect(summary.conflict).toBe(0);
    // Verify NO writes happened.
    expect(seed.leads[0].converted_customer_id).toBeNull();
    expect(seed.leads[0].converted_at).toBeNull();
  });

  test('reports conflict candidates separately, writes nothing', async () => {
    const seed = seedConflict();
    const supa = makeSupabase(seed);
    const summary = await repairTenant(supa, silentLogger(), 2, { apply: false });
    expect(summary.found).toBe(1);
    expect(summary.success).toBe(0);
    expect(summary.conflict).toBe(1);
    expect(seed.leads[0].converted_customer_id).toBe(99999); // unchanged
  });

  test('returns empty summary when nothing to do', async () => {
    const supa = makeSupabase(seedAlreadyCorrect());
    const summary = await repairTenant(supa, silentLogger(), 2, { apply: false });
    expect(summary.found).toBe(0);
    expect(summary.samples).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────
// repairTenant — apply mode
// ─────────────────────────────────────────────────────────────────────

describe('repairTenant — apply mode (writes through projectIdentityToCRM)', () => {
  test('projects converted_customer_id for a missing-projection row', async () => {
    const seed = seedHappyPath();
    const supa = makeSupabase(seed);
    const summary = await repairTenant(supa, silentLogger(), 2, { apply: true });
    expect(summary.found).toBe(1);
    expect(summary.success).toBe(1);
    expect(summary.conflict).toBe(0);
    expect(seed.leads[0].converted_customer_id).toBe(23421);
    expect(seed.leads[0].converted_at).toBeTruthy();
  });

  test('idempotent — re-running yields noop_idempotent (no new writes, no new audit)', async () => {
    const seed = seedHappyPath();
    const supa = makeSupabase(seed);
    await repairTenant(supa, silentLogger(), 2, { apply: true });

    // Re-run finds zero gaps (already projected).
    const rerunGaps = await findProjectionGaps(supa, 2);
    expect(rerunGaps).toEqual([]);

    const rerun = await repairTenant(supa, silentLogger(), 2, { apply: true });
    expect(rerun.found).toBe(0);
    expect(seed.leads[0].converted_customer_id).toBe(23421); // unchanged
  });

  test('CONFLICT — does NOT overwrite a lead already converted to a different customer', async () => {
    const seed = seedConflict();
    const supa = makeSupabase(seed);
    const summary = await repairTenant(supa, silentLogger(), 2, { apply: true });
    expect(summary.found).toBe(1);
    expect(summary.success).toBe(0);
    // applyOne calls projectIdentityToCRM which guards with .is('converted_customer_id', null).
    // The UPDATE matches zero rows, falls into the diagnostic branch, sees the existing
    // value != target, returns reason 'lead_already_linked_to_other' → status 'conflict'.
    expect(summary.conflict).toBe(1);
    expect(seed.leads[0].converted_customer_id).toBe(99999); // preserved
  });

  test('cross-tenant repair is impossible — scoping by userId means other-tenant rows never appear', async () => {
    const seed = {
      identities: [
        { id: 100, user_id: 2, sf_lead_id: 67, sf_customer_id: 23421 },
        { id: 200, user_id: 7, sf_lead_id: 999, sf_customer_id: 88888 },
      ],
      leads: [
        { id: 67, user_id: 2, converted_customer_id: null, updated_at: '2026-04-08' },
        { id: 999, user_id: 7, converted_customer_id: null, updated_at: '2026-04-08' },
      ],
      customers: [
        { id: 23421, user_id: 2 },
        { id: 88888, user_id: 7 },
      ],
    };
    const supa = makeSupabase(seed);
    await repairTenant(supa, silentLogger(), 2, { apply: true });
    // user 2's lead got projected
    expect(seed.leads[0].converted_customer_id).toBe(23421);
    // user 7's lead untouched
    expect(seed.leads[1].converted_customer_id).toBeNull();
  });

  test('replay safety — running dry-run THEN apply produces same end-state as apply alone', async () => {
    const a = seedHappyPath();
    const supaA = makeSupabase(a);
    await repairTenant(supaA, silentLogger(), 2, { apply: false });
    await repairTenant(supaA, silentLogger(), 2, { apply: true });

    const b = seedHappyPath();
    const supaB = makeSupabase(b);
    await repairTenant(supaB, silentLogger(), 2, { apply: true });

    expect(a.leads[0].converted_customer_id).toBe(b.leads[0].converted_customer_id);
  });

  test('does NOT modify identity row, customer row, phone, email, or name fields', async () => {
    const seed = seedHappyPath();
    seed.identities[0].status = 'resolved_both';
    seed.identities[0].last_hydrated_by = null;
    seed.customers[0].first_name = 'Kira';
    seed.customers[0].phone = '+15555550100';
    const supa = makeSupabase(seed);

    await repairTenant(supa, silentLogger(), 2, { apply: true });
    // identity untouched by the repair (status/hydrated_by unchanged)
    expect(seed.identities[0].status).toBe('resolved_both');
    expect(seed.identities[0].last_hydrated_by).toBeNull();
    // customer untouched
    expect(seed.customers[0].first_name).toBe('Kira');
    expect(seed.customers[0].phone).toBe('+15555550100');
    // lead — only converted_customer_id / converted_at / updated_at allowed
    expect(seed.leads[0].converted_customer_id).toBe(23421);
  });
});
