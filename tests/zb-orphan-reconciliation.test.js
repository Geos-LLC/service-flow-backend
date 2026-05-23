'use strict';

/**
 * Tests for lib/zb-orphan-reconciliation.js — orphan classification +
 * detach/archive/review apply path + ZB import ambiguity queue.
 *
 * Covers the 10 acceptance criteria:
 *
 *   1. SF orphan source-only customer with cancelled job → archived in apply mode.
 *   2. SF orphan mixed with OP mapping → ZB detached, customer preserved.
 *   3. SF orphan with active job → review_required, no mutation on customer.
 *   4. ZB missing import with multiple phone matches → ambiguity row created.
 *   5. Ambiguity row contains enough metadata to attach ZB customer to chosen SF customer.
 *   6. Cross-tenant orphan cleanup blocked.
 *   7. Dry-run and apply counts match.
 *   8. Idempotent apply: second run no-ops.
 *   9. Audit logs emitted via [ZBReconcile] structured lines.
 *  10. No phone-only auto-merge: ambiguity is queued, not auto-merged.
 */

const {
  classifyOrphan,
  reconcileOrphans,
  applyOrphanAction,
  recordZbImportAmbiguity,
} = require('../lib/zb-orphan-reconciliation');

// ── Minimal in-memory Supabase mock ──────────────────────────────

function makeSupabase(seed = {}) {
  const state = {
    customers: (seed.customers || []).map(x => ({ ...x })),
    jobs: (seed.jobs || []).map(x => ({ ...x })),
    identities: (seed.identities || []).map(x => ({ ...x })),
    op_mappings: (seed.op_mappings || []).map(x => ({ ...x })),
    ambiguities: (seed.ambiguities || []).map(x => ({ ...x })),
    identity_conflicts: (seed.identity_conflicts || []).map(x => ({ ...x })),
    nextId: { ambiguities: 100, identity_conflicts: 500 },
  };

  function makeChain(tableName) {
    const filters = [];
    let limit = null;
    let _order = null;
    let _selectFields = '*';
    let _selectOpts = null;

    const applyFilters = (rows) => rows.filter(r =>
      filters.every(f => {
        if (f.op === 'eq') return r[f.col] === f.val;
        if (f.op === 'in') return f.val.includes(r[f.col]);
        if (f.op === 'not_is_null') return r[f.col] !== null && r[f.col] !== undefined;
        if (f.op === 'is_null') return r[f.col] === null || r[f.col] === undefined;
        if (f.op === 'gt') return r[f.col] > f.val;
        return true;
      })
    );

    const chain = {
      select(fields, opts) {
        _selectFields = fields;
        _selectOpts = opts || null;
        return chain;
      },
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
      gt(col, val) { filters.push({ op: 'gt', col, val }); return chain; },
      order(col, opts) { _order = { col, opts }; return chain; },
      limit(n) { limit = n; return chain; },
      maybeSingle() {
        const rows = applyFilters(getTable(tableName));
        return Promise.resolve({ data: rows[0] || null, error: null });
      },
      single() {
        const rows = applyFilters(getTable(tableName));
        if (!rows.length) return Promise.resolve({ data: null, error: { code: 'PGRST116' } });
        return Promise.resolve({ data: rows[0], error: null });
      },
      then(resolve, reject) {
        const rows = applyFilters(getTable(tableName));
        let result = [...rows];
        if (_order) result.sort((a, b) => (a[_order.col] - b[_order.col]) * (_order.opts && _order.opts.ascending === false ? -1 : 1));
        if (limit) result = result.slice(0, limit);
        if (_selectOpts && _selectOpts.count === 'exact' && _selectOpts.head === true) {
          return Promise.resolve({ data: null, count: result.length, error: null }).then(resolve, reject);
        }
        if (_selectOpts && _selectOpts.count === 'exact') {
          return Promise.resolve({ data: result, count: result.length, error: null }).then(resolve, reject);
        }
        return Promise.resolve({ data: result, error: null }).then(resolve, reject);
      },
      update(patch) {
        return {
          eq(col, val) {
            filters.push({ op: 'eq', col, val });
            return {
              eq(col2, val2) {
                filters.push({ op: 'eq', col: col2, val: val2 });
                const rows = applyFilters(getTable(tableName));
                rows.forEach(r => Object.assign(r, patch));
                return Promise.resolve({ data: null, error: null });
              },
              then(resolve, reject) {
                const rows = applyFilters(getTable(tableName));
                rows.forEach(r => Object.assign(r, patch));
                return Promise.resolve({ data: null, error: null }).then(resolve, reject);
              },
            };
          },
        };
      },
      insert(payload) {
        const table = getTable(tableName);
        const id = state.nextId[tableName] !== undefined ? state.nextId[tableName]++ : (Math.max(0, ...table.map(r => r.id || 0)) + 1);
        const row = { id, ...payload, created_at: new Date().toISOString() };
        table.push(row);
        return {
          select(fields) {
            return {
              maybeSingle() { return Promise.resolve({ data: row, error: null }); },
              single() { return Promise.resolve({ data: row, error: null }); },
            };
          },
          then(resolve, reject) {
            return Promise.resolve({ data: row, error: null }).then(resolve, reject);
          },
        };
      },
    };
    return chain;
  }

  function getTable(name) {
    switch (name) {
      case 'customers': return state.customers;
      case 'jobs': return state.jobs;
      case 'communication_participant_identities': return state.identities;
      case 'communication_participant_mappings': return state.op_mappings;
      case 'communication_identity_ambiguities': return state.ambiguities;
      case 'identity_conflicts': return state.identity_conflicts;
      default: return [];
    }
  }

  return {
    from: makeChain,
    _state: state,
  };
}

function makeLogger() {
  const lines = [];
  return {
    log: jest.fn(msg => lines.push(msg)),
    warn: jest.fn(msg => lines.push('WARN ' + msg)),
    error: jest.fn(msg => lines.push('ERROR ' + msg)),
    lines,
  };
}

// ── classifyOrphan ───────────────────────────────────────────────

describe('classifyOrphan', () => {
  test('source_only_orphan: no identity, no OP, only cancelled jobs', () => {
    const r = classifyOrphan({
      jobs: [{ status: 'cancelled' }],
      identity: null,
      opMappingCount: 0,
      leadIdsLinkedViaIdentity: 0,
      hasInvoiceOrPayment: false,
    });
    expect(r.class).toBe('source_only_orphan');
    expect(r.proposed_action).toBe('archive');
  });

  test('source_only_orphan: zero jobs, no identity', () => {
    const r = classifyOrphan({ jobs: [], identity: null, opMappingCount: 0, leadIdsLinkedViaIdentity: 0 });
    expect(r.class).toBe('source_only_orphan');
    expect(r.proposed_action).toBe('archive');
  });

  test('mixed_orphan: has identity with OP mapping but only cancelled jobs', () => {
    const r = classifyOrphan({
      jobs: [{ status: 'cancelled' }],
      identity: { id: 42 },
      opMappingCount: 1,
      leadIdsLinkedViaIdentity: 0,
    });
    expect(r.class).toBe('mixed_orphan');
    expect(r.proposed_action).toBe('detach');
    expect(r.reason).toContain('identity_42');
    expect(r.reason).toContain('op_mappings_1');
  });

  test('mixed_orphan: identity links a lead', () => {
    const r = classifyOrphan({
      jobs: [],
      identity: { id: 7 },
      opMappingCount: 0,
      leadIdsLinkedViaIdentity: 1,
    });
    expect(r.class).toBe('mixed_orphan');
    expect(r.proposed_action).toBe('detach');
  });

  test('risky_orphan: active job present', () => {
    const r = classifyOrphan({
      jobs: [{ status: 'scheduled' }, { status: 'cancelled' }],
      identity: null,
      opMappingCount: 0,
    });
    expect(r.class).toBe('risky_orphan');
    expect(r.proposed_action).toBe('review');
  });

  test('risky_orphan: has invoice/payment evidence', () => {
    const r = classifyOrphan({
      jobs: [{ status: 'cancelled' }],
      identity: null,
      hasInvoiceOrPayment: true,
    });
    expect(r.class).toBe('risky_orphan');
    expect(r.proposed_action).toBe('review');
  });

  test('risky beats mixed when active jobs exist', () => {
    const r = classifyOrphan({
      jobs: [{ status: 'completed' }],
      identity: { id: 1 },
      opMappingCount: 2,
    });
    expect(r.class).toBe('risky_orphan');
  });
});

// ── Acceptance 1: source-only orphan → archived in apply mode ────

describe('acceptance 1 — source-only orphan archived in apply mode', () => {
  test('source-only customer with cancelled job is detached (zenbooker_id NULLed) in apply mode', async () => {
    const supabase = makeSupabase({
      customers: [{ id: 100, user_id: 2, zenbooker_id: 'ZB_ORPHAN_1', first_name: 'A', last_name: 'B', phone: '555' }],
      jobs: [{ id: 1, customer_id: 100, user_id: 2, status: 'cancelled', zenbooker_id: 'ZB_JOB_1' }],
    });
    const logger = makeLogger();
    const report = await reconcileOrphans({
      supabase, logger, userId: 2, zbCustomerIds: new Set(), mode: 'apply',
    });
    expect(report.orphans).toHaveLength(1);
    expect(report.orphans[0].class).toBe('source_only_orphan');
    expect(report.orphans[0].applied).toBe(true);
    expect(report.summary.applied_archive).toBe(1);
    // Customer row preserved; zenbooker_id NULLed.
    expect(supabase._state.customers[0].zenbooker_id).toBeNull();
    expect(supabase._state.customers[0].first_name).toBe('A');
    // Audit log emitted.
    expect(logger.lines.some(l => /\[ZBReconcile\] action=archive_orphan result=success/.test(l))).toBe(true);
  });
});

// ── Acceptance 2: mixed orphan → ZB detached, customer + identity preserved

describe('acceptance 2 — mixed orphan detached, history preserved', () => {
  test('orphan with OP mapping detaches ZB but keeps customer + identity + OP', async () => {
    const supabase = makeSupabase({
      customers: [{ id: 200, user_id: 2, zenbooker_id: 'ZB_MIXED', first_name: 'M', last_name: 'X', phone: '777' }],
      jobs: [{ id: 2, customer_id: 200, user_id: 2, status: 'cancelled' }],
      identities: [{ id: 999, user_id: 2, sf_customer_id: 200, sf_lead_id: null, normalized_phone: '777' }],
      op_mappings: [{ id: 1, identity_id: 999, tenant_id: 2, sigcore_participant_id: 'sig-1', provider_contact_id: 'op-1' }],
    });
    const logger = makeLogger();
    const report = await reconcileOrphans({
      supabase, logger, userId: 2, zbCustomerIds: new Set(), mode: 'apply',
    });
    expect(report.orphans).toHaveLength(1);
    expect(report.orphans[0].class).toBe('mixed_orphan');
    expect(report.summary.applied_detach).toBe(1);
    expect(supabase._state.customers[0].zenbooker_id).toBeNull();           // detached
    expect(supabase._state.customers[0].first_name).toBe('M');              // preserved
    expect(supabase._state.identities[0].id).toBe(999);                     // identity untouched
    expect(supabase._state.op_mappings[0].identity_id).toBe(999);           // OP mapping untouched
    expect(logger.lines.some(l => /action=detach_orphan result=success/.test(l))).toBe(true);
  });
});

// ── Acceptance 3: risky orphan → review_required, no mutation ─

describe('acceptance 3 — risky orphan creates review item, no customer mutation', () => {
  test('active-job orphan → review_required, customer row UNCHANGED', async () => {
    const supabase = makeSupabase({
      customers: [{ id: 300, user_id: 2, zenbooker_id: 'ZB_RISKY', first_name: 'R', last_name: 'K', phone: '888' }],
      jobs: [{ id: 3, customer_id: 300, user_id: 2, status: 'scheduled' }],
    });
    const logger = makeLogger();
    const report = await reconcileOrphans({
      supabase, logger, userId: 2, zbCustomerIds: new Set(), mode: 'apply',
    });
    expect(report.orphans[0].class).toBe('risky_orphan');
    expect(report.summary.applied_review).toBe(1);
    // Customer NOT detached.
    expect(supabase._state.customers[0].zenbooker_id).toBe('ZB_RISKY');
    // identity_conflicts row inserted.
    expect(supabase._state.identity_conflicts).toHaveLength(1);
    expect(supabase._state.identity_conflicts[0].workspace_id).toBe(2);
    expect(supabase._state.identity_conflicts[0].status).toBe('open');
    expect(logger.lines.some(l => /action=review_required result=success/.test(l))).toBe(true);
  });
});

// ── Acceptance 4: ZB missing import → ambiguity row created ──

describe('acceptance 4 — ZB import ambiguity creates queue row', () => {
  test('recordZbImportAmbiguity writes a row with ZB-specific reason and source_payload', async () => {
    const supabase = makeSupabase({
      identities: [{ id: 17, user_id: 2, sf_customer_id: 50, sf_lead_id: null, display_name: 'Existing Candidate' }],
      customers: [{ id: 50, user_id: 2, zenbooker_id: 'existing-zb' }],
    });
    const logger = makeLogger();
    const result = await recordZbImportAmbiguity({
      supabase, logger, userId: 2,
      zbCustomer: { id: 'NEW_ZB', name: 'New Person', phone: '999', email: 'np@example.com' },
      attemptedPhone: '999',
      candidateIdentityIds: [17],
      resolverReason: 'phone_name_conflict_or_multi',
    });
    expect(result.ok).toBe(true);
    expect(result.action).toBe('ambiguity_queue');
    expect(supabase._state.ambiguities).toHaveLength(1);
    const row = supabase._state.ambiguities[0];
    expect(row.user_id).toBe(2);
    expect(row.source).toBe('zenbooker');
    expect(row.attempted_external_id).toBe('NEW_ZB');
    expect(row.attempted_phone).toBe('999');
    expect(row.attempted_name).toBe('New Person');
    expect(row.reason).toBe('zb_customer_import_ambiguous');
    expect(row.status).toBe('open');
    expect(row.candidate_identity_ids).toEqual([17]);
    expect(row.source_payload.zenbooker_id).toBe('NEW_ZB');
    expect(row.source_payload.zb_email).toBe('np@example.com');
    expect(row.source_payload.resolver_reason).toBe('phone_name_conflict_or_multi');
    expect(row.source_payload.candidate_sf_customer_ids).toEqual([50]);
  });
});

// ── Acceptance 5: ambiguity metadata supports operator resolution ─

describe('acceptance 5 — ambiguity row metadata sufficient for operator resolution', () => {
  test('ambiguity row includes candidate_sf_customer_ids and candidate_detail with leadbridge_contact_id', async () => {
    const supabase = makeSupabase({
      identities: [
        { id: 17, user_id: 2, sf_customer_id: 50, sf_lead_id: 70, leadbridge_contact_id: 'lb-abc', display_name: 'A' },
        { id: 18, user_id: 2, sf_customer_id: 51, sf_lead_id: null, leadbridge_contact_id: null, display_name: 'B' },
      ],
    });
    const logger = makeLogger();
    await recordZbImportAmbiguity({
      supabase, logger, userId: 2,
      zbCustomer: { id: 'NEW_ZB', name: 'Tester', phone: '999', email: null },
      attemptedPhone: '999',
      candidateIdentityIds: [17, 18],
      resolverReason: 'phone_name_conflict_or_multi',
    });
    const row = supabase._state.ambiguities[0];
    // Operator can see both candidate SF customers + the LB attribution on one of them.
    expect(row.source_payload.candidate_sf_customer_ids.sort()).toEqual([50, 51]);
    expect(row.source_payload.candidate_detail).toEqual(expect.arrayContaining([
      expect.objectContaining({ identity_id: 17, sf_customer_id: 50, sf_lead_id: 70, leadbridge_contact_id: 'lb-abc' }),
      expect.objectContaining({ identity_id: 18, sf_customer_id: 51 }),
    ]));
  });
});

// ── Acceptance 6: cross-tenant orphan cleanup blocked ────────

describe('acceptance 6 — cross-tenant orphan cleanup blocked', () => {
  test('reconcile for tenant 2 does not see or touch tenant 7 customers', async () => {
    const supabase = makeSupabase({
      customers: [
        { id: 100, user_id: 2, zenbooker_id: 'ZB_T2', first_name: 'T2' },
        { id: 101, user_id: 7, zenbooker_id: 'ZB_T7', first_name: 'T7' }, // tenant 7 should be invisible
      ],
    });
    const logger = makeLogger();
    const report = await reconcileOrphans({
      supabase, logger, userId: 2, zbCustomerIds: new Set(), mode: 'apply',
    });
    expect(report.sf_zb_customer_count).toBe(1);            // only the tenant-2 row was seen
    expect(report.orphans).toHaveLength(1);
    expect(report.orphans[0].sf_customer_id).toBe(100);
    expect(supabase._state.customers[1].zenbooker_id).toBe('ZB_T7');   // tenant-7 customer untouched
  });

  test('applyOrphanAction refuses to detach a customer that belongs to a different tenant', async () => {
    const supabase = makeSupabase({
      customers: [{ id: 101, user_id: 7, zenbooker_id: 'ZB_T7' }],
    });
    const logger = makeLogger();
    const res = await applyOrphanAction({
      supabase, logger, userId: 2,       // wrong tenant
      row: { sf_customer_id: 101, zenbooker_id: 'ZB_T7', identity: null, opMappingCount: 0 },
      classification: { class: 'source_only_orphan', reason: 'source_only_jobs_0', proposed_action: 'archive' },
    });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('customer_not_found_or_cross_tenant');
    expect(supabase._state.customers[0].zenbooker_id).toBe('ZB_T7');
  });
});

// ── Acceptance 7: dry-run and apply counts match ─────────────

describe('acceptance 7 — dryRun and apply produce matching classification counts', () => {
  test('counts of orphans + per-class summaries match between dryRun and apply', async () => {
    const seed = {
      customers: [
        { id: 1, user_id: 2, zenbooker_id: 'A', phone: '1' },
        { id: 2, user_id: 2, zenbooker_id: 'B', phone: '2' },
        { id: 3, user_id: 2, zenbooker_id: 'C', phone: '3' },
      ],
      jobs: [
        { id: 11, customer_id: 1, user_id: 2, status: 'cancelled' },    // source-only
        { id: 12, customer_id: 2, user_id: 2, status: 'cancelled' },    // mixed (has identity below)
        { id: 13, customer_id: 3, user_id: 2, status: 'scheduled' },    // risky (active job)
      ],
      identities: [{ id: 50, user_id: 2, sf_customer_id: 2, normalized_phone: '2' }],
    };
    const dry = await reconcileOrphans({
      supabase: makeSupabase(seed), logger: makeLogger(), userId: 2,
      zbCustomerIds: new Set(), mode: 'dryRun',
    });
    const apply = await reconcileOrphans({
      supabase: makeSupabase(seed), logger: makeLogger(), userId: 2,
      zbCustomerIds: new Set(), mode: 'apply',
    });
    expect(dry.orphans.length).toBe(apply.orphans.length);
    expect(dry.summary.source_only).toBe(apply.summary.source_only);
    expect(dry.summary.mixed).toBe(apply.summary.mixed);
    expect(dry.summary.risky).toBe(apply.summary.risky);
    // Counts before apply.
    expect(dry.summary).toMatchObject({ source_only: 1, mixed: 1, risky: 1 });
  });
});

// ── Acceptance 8: idempotent apply ───────────────────────────

describe('acceptance 8 — apply is idempotent (second run no-ops)', () => {
  test('second apply on same tenant performs zero mutations on detached rows', async () => {
    const supabase = makeSupabase({
      customers: [{ id: 1, user_id: 2, zenbooker_id: 'A', phone: '1' }],
      jobs: [{ id: 11, customer_id: 1, user_id: 2, status: 'cancelled' }],
    });
    const logger1 = makeLogger();
    const first = await reconcileOrphans({
      supabase, logger: logger1, userId: 2, zbCustomerIds: new Set(), mode: 'apply',
    });
    expect(first.summary.applied_archive).toBe(1);
    expect(supabase._state.customers[0].zenbooker_id).toBeNull();
    // Second run: no orphans left (the customer's zenbooker_id is now NULL,
    // so it isn't even in the snapshot — the orphan set is empty).
    const logger2 = makeLogger();
    const second = await reconcileOrphans({
      supabase, logger: logger2, userId: 2, zbCustomerIds: new Set(), mode: 'apply',
    });
    expect(second.orphans).toHaveLength(0);
    expect(second.summary.applied_archive).toBe(0);
    expect(second.summary.applied_detach).toBe(0);
    expect(second.summary.applied_review).toBe(0);
  });

  test('recordZbImportAmbiguity is idempotent on (user, source, external_id, status=open)', async () => {
    const supabase = makeSupabase({});
    const logger = makeLogger();
    const r1 = await recordZbImportAmbiguity({
      supabase, logger, userId: 2,
      zbCustomer: { id: 'NEW_ZB', name: 'T', phone: '1' }, attemptedPhone: '1',
      candidateIdentityIds: [], resolverReason: 'x',
    });
    const r2 = await recordZbImportAmbiguity({
      supabase, logger, userId: 2,
      zbCustomer: { id: 'NEW_ZB', name: 'T', phone: '1' }, attemptedPhone: '1',
      candidateIdentityIds: [], resolverReason: 'x',
    });
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(r2.note).toBe('already_open');
    expect(supabase._state.ambiguities).toHaveLength(1);
  });
});

// ── Acceptance 9: audit logs emitted ─────────────────────────

describe('acceptance 9 — [ZBReconcile] audit logs emitted for every action', () => {
  test('dryRun emits proposed_* log lines for every orphan', async () => {
    const supabase = makeSupabase({
      customers: [
        { id: 1, user_id: 2, zenbooker_id: 'A', phone: '1' },
        { id: 2, user_id: 2, zenbooker_id: 'B', phone: '2' },
      ],
      jobs: [{ id: 11, customer_id: 1, user_id: 2, status: 'cancelled' }],
    });
    const logger = makeLogger();
    await reconcileOrphans({ supabase, logger, userId: 2, zbCustomerIds: new Set(), mode: 'dryRun' });
    const proposed = logger.lines.filter(l => /\[ZBReconcile\] mode=dryRun action=proposed_/.test(l));
    expect(proposed.length).toBe(2);
  });

  test('apply emits action=archive_orphan|detach_orphan|review_required result=success on each row', async () => {
    const supabase = makeSupabase({
      customers: [
        { id: 1, user_id: 2, zenbooker_id: 'A', phone: '1' },
        { id: 2, user_id: 2, zenbooker_id: 'B', phone: '2' },
        { id: 3, user_id: 2, zenbooker_id: 'C', phone: '3' },
      ],
      jobs: [
        { id: 11, customer_id: 1, user_id: 2, status: 'cancelled' },
        { id: 12, customer_id: 2, user_id: 2, status: 'cancelled' },
        { id: 13, customer_id: 3, user_id: 2, status: 'completed' },
      ],
      identities: [{ id: 50, user_id: 2, sf_customer_id: 2, normalized_phone: '2' }],
    });
    const logger = makeLogger();
    await reconcileOrphans({ supabase, logger, userId: 2, zbCustomerIds: new Set(), mode: 'apply' });
    expect(logger.lines.some(l => /action=archive_orphan result=success/.test(l))).toBe(true);
    expect(logger.lines.some(l => /action=detach_orphan result=success/.test(l))).toBe(true);
    expect(logger.lines.some(l => /action=review_required result=success/.test(l))).toBe(true);
  });
});

// ── Acceptance 10: no phone-only auto-merge ──────────────────

describe('acceptance 10 — ambiguity is queued for review, not phone-only auto-merged', () => {
  test('recordZbImportAmbiguity always writes status=open (never auto_merged_weak)', async () => {
    const supabase = makeSupabase({});
    const logger = makeLogger();
    await recordZbImportAmbiguity({
      supabase, logger, userId: 2,
      // Multiple candidates with same phone — exactly the phone-only-merge risk.
      zbCustomer: { id: 'NEW_ZB', name: 'Generic', phone: '5550000' },
      attemptedPhone: '5550000',
      candidateIdentityIds: [10, 11, 12],
      resolverReason: 'multi_phone_name_strong',
    });
    expect(supabase._state.ambiguities).toHaveLength(1);
    expect(supabase._state.ambiguities[0].status).toBe('open');
    expect(supabase._state.ambiguities[0].status).not.toBe('auto_merged_weak');
    expect(supabase._state.ambiguities[0].reason).toBe('zb_customer_import_ambiguous');
  });
});
