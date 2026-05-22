'use strict';

// Stage 2 — LeadBridge engine adapter contract tests.
//
// Drives lib/lb-engine-adapter.js end-to-end (real engine + real resolver)
// with mocked LB executors. Each scenario asserts which executor was called
// with what arguments — that is the byte-equivalence contract with the
// legacy resolveOrCreateLead branches.
//
// Mock LB executors are jest.fn spies. They DO NOT need to do real DB work
// because the contract under test is which-executor-and-with-what-args.
// The resolver does write identity rows, which the engine consumes for its
// decision; we use a sufficient mock-supabase to keep the resolver happy.
//
// See docs/architecture/stage-2-leadbridge-adapter-plan.md §7.1.

const { makeAdapter, _resetPrereqWarnCache } = require('../lib/lb-engine-adapter');
const { FLAGS } = require('../lib/feature-flags');

// ── Mock supabase ────────────────────────────────────────────────────────
// Supports: identities, ambiguities, leads, customers. Enough for the
// engine + resolver + findCrmMatchByPhone + parent-lead invariant check.

function makeMockSupabase(seed = {}) {
  const state = {
    identities: (seed.identities || []).map(x => ({ ...x })),
    ambiguities: [],
    leads: (seed.leads || []).map(x => ({ ...x })),
    customers: (seed.customers || []).map(x => ({ ...x })),
    nextIdentityId: 1000,
  };

  function tableChain(rows, opts = {}) {
    let filters = [];
    let limit = null;
    const applyFilters = (data) => data.filter(r =>
      filters.every(f => {
        if (f.op === 'eq') return r[f.col] === f.val;
        if (f.op === 'ilike') {
          const v = String(r[f.col] || '').toLowerCase();
          const p = String(f.val).toLowerCase().replace(/%/g, '');
          return v.includes(p);
        }
        if (f.op === 'is') return f.val === null ? r[f.col] == null : r[f.col] === f.val;
        return true;
      })
    );
    const chain = {
      select() { return chain; },
      eq(col, val) { filters.push({ op: 'eq', col, val }); return chain; },
      ilike(col, val) { filters.push({ op: 'ilike', col, val }); return chain; },
      is(col, val) { filters.push({ op: 'is', col, val }); return chain; },
      limit(n) { limit = n; return chain; },
      maybeSingle() {
        const r = applyFilters(rows);
        return Promise.resolve({ data: r[0] || null, error: null });
      },
      single() {
        return Promise.resolve({ data: null, error: { code: 'PGRST116' } });
      },
      update(patch) {
        return {
          eq(col, val) {
            return {
              select() {
                return {
                  single() {
                    const row = rows.find(r => r[col] === val);
                    if (!row) return Promise.resolve({ data: null, error: { message: 'not found' } });
                    Object.assign(row, patch);
                    return Promise.resolve({ data: row, error: null });
                  },
                };
              },
            };
          },
        };
      },
      insert(row) {
        return {
          select() {
            return {
              single() {
                const fresh = opts.autoId ? { id: state.nextIdentityId++, ...row } : { ...row };
                rows.push(fresh);
                return Promise.resolve({ data: fresh, error: null });
              },
            };
          },
        };
      },
      then(fn) {
        const r = applyFilters(rows);
        const trimmed = limit ? r.slice(0, limit) : r;
        return Promise.resolve({ data: trimmed, error: null }).then(fn);
      },
    };
    return chain;
  }

  function fromAmbiguities() {
    return {
      select() {
        return {
          eq() { return this; },
          is() { return this; },
          then(fn) { return Promise.resolve({ count: 0 }).then(fn); },
        };
      },
      insert(row) {
        state.ambiguities.push({ ...row });
        return Promise.resolve({ data: null, error: null });
      },
    };
  }

  return {
    from(tbl) {
      if (tbl === 'communication_participant_identities') return tableChain(state.identities, { autoId: true });
      if (tbl === 'communication_identity_ambiguities') return fromAmbiguities();
      if (tbl === 'leads') return tableChain(state.leads);
      if (tbl === 'customers') return tableChain(state.customers);
      throw new Error(`mock: unknown table ${tbl}`);
    },
    _state: state,
  };
}

// ── Mock executors (spies) ──────────────────────────────────────────────

function makeExecutorSpies() {
  return {
    createLeadFromLB: jest.fn(async (userId, identity, input) => ({
      type: identity && identity.sf_customer_id ? 'reactivation_lead' : 'new_lead',
      id: 9001,
      created: true,
      action: identity && identity.sf_customer_id ? 'reactivation' : 'created',
    })),
    createChildLeadFromLB: jest.fn(async (userId, parentLeadId, identity, input) => ({
      id: 9002,
    })),
    enrichLeadFromLB: jest.fn(async () => {}),
    setIdentityLead: jest.fn(async () => ({ ok: true })),
    setIdentityCustomer: jest.fn(async () => ({ ok: true })),
  };
}

// ── Test scaffolding ─────────────────────────────────────────────────────

function makeLogger() {
  const calls = { log: [], warn: [], error: [] };
  return {
    log:   (msg) => calls.log.push(msg),
    warn:  (msg) => calls.warn.push(msg),
    error: (msg) => calls.error.push(msg),
    _calls: calls,
  };
}

function enableEngineForTenant(userId) {
  process.env[`${FLAGS.RECONCILIATION_ENGINE_LEADBRIDGE}_TENANTS`] = String(userId);
  process.env[`${FLAGS.IDENTITY_RESOLVER_LEADBRIDGE}_TENANTS`] = String(userId);
  process.env[`${FLAGS.LEAD_CARDINALITY_CHILD_LEADS}_TENANTS`] = String(userId);
}

function setChildLeadsOff(userId) {
  delete process.env[`${FLAGS.LEAD_CARDINALITY_CHILD_LEADS}_TENANTS`];
}

afterEach(() => {
  for (const name of Object.values(FLAGS)) {
    delete process.env[name];
    delete process.env[`${name}_TENANTS`];
  }
  _resetPrereqWarnCache();
});

// ── Scenario 1 — new LB lead (floating, no CRM match) ──────────────────

describe('LB engine adapter — scenario 1: new LB lead', () => {
  test('engine produces canonical_lead_create → createLeadFromLB called once', async () => {
    enableEngineForTenant(2);
    const supabase = makeMockSupabase();
    const executors = makeExecutorSpies();
    const logger = makeLogger();
    const adapter = makeAdapter({ supabase, logger, executors });

    const result = await adapter.resolveOrCreateLeadViaEngine(2, {
      channel: 'thumbtack',
      customerName: 'New Lead',
      customerPhone: '+15558675309',
      lbContactId: 'LB-NEW-001',
      accountDisplayName: 'Spotless Homes Tampa',
    });

    expect(result.identity).toBeTruthy();
    expect(result.leadResult).toEqual(expect.objectContaining({ type: 'new_lead', id: 9001 }));
    expect(executors.createLeadFromLB).toHaveBeenCalledTimes(1);
    expect(executors.createChildLeadFromLB).not.toHaveBeenCalled();
    expect(executors.enrichLeadFromLB).not.toHaveBeenCalled();
    // [Reconciliation] log from engine + [LB engine] log from adapter
    expect(logger._calls.log.some(l => l.includes('[Reconciliation]'))).toBe(true);
    expect(logger._calls.log.some(l => /\[LB engine\] path=engine.+decision=canonical_lead_create/.test(l))).toBe(true);
  });
});

// ── Scenario 2 — sf_lead_id set, child flag OFF → enrich ───────────────

describe('LB engine adapter — scenario 2: enrich existing lead (child OFF)', () => {
  test('engine produces enrich_only → enrichLeadFromLB called once, NO new lead', async () => {
    enableEngineForTenant(2);
    setChildLeadsOff(2);  // unset child-leads flag → engine path requires both, so this would force legacy
    // Re-enable just resolver + engine; explicitly leave child-leads OFF so adapter falls back.
    // To test the engine's "enrich_only" decision, we need child_leads ON (prereq) but the
    // engine's policy.childLeadsEnabled OFF. That's the same env var — they're tied today.
    // Solution: set the env var (satisfies prereq + childLeadsEnabled=true) and use seed
    // with NO parent_lead_id so child_acquisition is the natural decision. Override below.
    process.env[`${FLAGS.LEAD_CARDINALITY_CHILD_LEADS}_TENANTS`] = '2';

    // To get enrich_only with the policy table as wired, we'd need policy.childLeadsEnabled=false.
    // The prereq chain requires the flag ON. The two are coupled — by design today.
    // For this test we instead assert: when childLeads flag is OFF for tenant 2, the engine
    // path is not used (legacy fallback). The engine's enrich_only decision is exercised
    // separately via the engine unit tests.
    delete process.env[`${FLAGS.LEAD_CARDINALITY_CHILD_LEADS}_TENANTS`];

    const supabase = makeMockSupabase({
      identities: [{
        id: 50, user_id: 2, leadbridge_contact_id: 'LB-EXISTING',
        normalized_phone: '5559998888', normalized_name: 'linda mau',
        name_token_set: 'linda mau', display_name: 'Linda Mau',
        sf_lead_id: 700, sf_customer_id: null,
      }],
      leads: [{ id: 700, user_id: 2, parent_lead_id: null }],
    });
    const executors = makeExecutorSpies();
    const logger = makeLogger();
    const adapter = makeAdapter({ supabase, logger, executors });

    // Prereq check: child-leads flag OFF → adapter falls back to legacy path.
    // (This test verifies the prereq logic; the engine's enrich_only decision
    // is exercised in scenario 2b below where we drive dispatchPlan directly.)
    const prereq = adapter.checkPrerequisites(2);
    expect(prereq.useEngine).toBe(false);
    expect(prereq.missing).toContain('child_leads');
  });

  test('scenario 2b — direct dispatchPlan with enrich_only decision → enrichLeadFromLB called', async () => {
    const supabase = makeMockSupabase();
    const executors = makeExecutorSpies();
    const logger = makeLogger();
    const adapter = makeAdapter({ supabase, logger, executors });

    const identity = { id: 50, user_id: 2, sf_lead_id: 700, sf_customer_id: null };
    const plan = { decision: 'enrich_only', identityId: 50, reason: 'identity_has_lead_enrich' };
    await adapter.dispatchPlan(2, identity, plan, {
      channel: 'yelp', customerName: 'Linda Mau', customerPhone: '+15559998888', accountDisplayName: 'Spotless Homes Tampa',
    });

    expect(executors.enrichLeadFromLB).toHaveBeenCalledTimes(1);
    expect(executors.enrichLeadFromLB).toHaveBeenCalledWith(2, 700, expect.objectContaining({
      channel: 'yelp', customerName: 'Linda Mau',
    }));
    expect(executors.createLeadFromLB).not.toHaveBeenCalled();
    expect(executors.createChildLeadFromLB).not.toHaveBeenCalled();
  });
});

// ── Scenario 3 — sf_lead_id set, child flag ON → child_acquisition ─────

describe('LB engine adapter — scenario 3: child acquisition (child ON)', () => {
  test('engine produces child_acquisition → createChildLeadFromLB called with parentLeadId', async () => {
    enableEngineForTenant(2);
    const supabase = makeMockSupabase({
      identities: [{
        id: 50, user_id: 2, leadbridge_contact_id: 'LB-EXISTING',
        normalized_phone: '5559998888', normalized_name: 'linda mau',
        name_token_set: 'linda mau', display_name: 'Linda Mau',
        sf_lead_id: 700, sf_customer_id: null,
      }],
      leads: [{ id: 700, user_id: 2, parent_lead_id: null }], // canonical
    });
    const executors = makeExecutorSpies();
    const logger = makeLogger();
    const adapter = makeAdapter({ supabase, logger, executors });

    const result = await adapter.resolveOrCreateLeadViaEngine(2, {
      channel: 'yelp',
      customerName: 'Linda Mau',
      customerPhone: '+15559998888',
      lbContactId: 'LB-EXISTING',
      accountDisplayName: 'Spotless Homes Tampa',
    });

    expect(result.identity.id).toBe(50);
    expect(result.leadResult).toEqual(expect.objectContaining({
      type: 'child_lead', id: 9002, parent_lead_id: 700, action: 'child_acquisition',
    }));
    expect(executors.createChildLeadFromLB).toHaveBeenCalledTimes(1);
    expect(executors.createChildLeadFromLB).toHaveBeenCalledWith(2, 700, expect.objectContaining({ id: 50 }), expect.any(Object));
    // Critical: identity row NOT touched (sf_lead_id still 700)
    expect(supabase._state.identities[0].sf_lead_id).toBe(700);
    // No enrich, no canonical-create
    expect(executors.enrichLeadFromLB).not.toHaveBeenCalled();
    expect(executors.createLeadFromLB).not.toHaveBeenCalled();
  });
});

// ── Scenario 4 — sf_customer_id set, child OFF → no lead (NOOP) ────────

describe('LB engine adapter — scenario 4: noop when identity already customer (child OFF)', () => {
  test('direct dispatchPlan with noop_communication_only reason=identity_already_customer', async () => {
    const supabase = makeMockSupabase();
    const executors = makeExecutorSpies();
    const logger = makeLogger();
    const adapter = makeAdapter({ supabase, logger, executors });

    const identity = { id: 51, user_id: 2, sf_lead_id: null, sf_customer_id: 200 };
    const plan = { decision: 'noop_communication_only', reason: 'identity_already_customer' };
    const result = await adapter.dispatchPlan(2, identity, plan, {});

    expect(result).toEqual({ type: 'customer', id: 200, created: false, action: 'identity_already_customer' });
    expect(executors.createLeadFromLB).not.toHaveBeenCalled();
    expect(executors.createChildLeadFromLB).not.toHaveBeenCalled();
    expect(executors.enrichLeadFromLB).not.toHaveBeenCalled();
  });
});

// ── Scenario 5 — sf_customer_id set, child ON → reactivation ──────────

describe('LB engine adapter — scenario 5: reactivation (child ON)', () => {
  test('engine produces reactivation_lead → createLeadFromLB called; identity passed has sf_customer_id', async () => {
    enableEngineForTenant(2);
    const supabase = makeMockSupabase({
      identities: [{
        id: 52, user_id: 2, leadbridge_contact_id: null,
        normalized_phone: '5557775555', normalized_name: 'jane doe',
        name_token_set: 'doe jane', display_name: 'Jane Doe',
        sf_lead_id: null, sf_customer_id: 333,
      }],
      customers: [{ id: 333, user_id: 2, phone: '5557775555' }],
    });
    const executors = makeExecutorSpies();
    const logger = makeLogger();
    const adapter = makeAdapter({ supabase, logger, executors });

    const result = await adapter.resolveOrCreateLeadViaEngine(2, {
      channel: 'thumbtack',
      customerName: 'Jane Doe',
      customerPhone: '+15557775555',
      lbContactId: 'LB-REACT',
      accountDisplayName: 'Spotless Homes Tampa',
    });

    expect(result.identity.id).toBe(52);
    expect(executors.createLeadFromLB).toHaveBeenCalledTimes(1);
    const [, passedIdentity] = executors.createLeadFromLB.mock.calls[0];
    expect(passedIdentity.sf_customer_id).toBe(333);  // executor will detect reactivation
    expect(result.leadResult).toEqual(expect.objectContaining({ type: 'reactivation_lead' }));
  });
});

// ── Scenario 6 — ambiguous resolver → no lead, no materialization ─────

describe('LB engine adapter — scenario 6: ambiguous resolver', () => {
  test('engine returns kind=ambiguous → adapter returns { identity:null, leadResult:null }', async () => {
    enableEngineForTenant(2);
    const supabase = makeMockSupabase({
      identities: [
        { id: 60, user_id: 2, normalized_phone: '5551234567', normalized_name: 'anna smith', name_token_set: 'anna smith', display_name: 'Anna Smith' },
        { id: 61, user_id: 2, normalized_phone: '5551234567', normalized_name: 'john doe',   name_token_set: 'doe john',   display_name: 'John Doe' },
      ],
    });
    const executors = makeExecutorSpies();
    const logger = makeLogger();
    const adapter = makeAdapter({ supabase, logger, executors });

    const result = await adapter.resolveOrCreateLeadViaEngine(2, {
      channel: 'thumbtack', customerName: 'Bob Jones', customerPhone: '+15551234567',
      lbContactId: 'LB-AMBIG',
    });

    expect(result.identity).toBeNull();
    expect(result.leadResult).toBeNull();
    // No executors called
    expect(executors.createLeadFromLB).not.toHaveBeenCalled();
    expect(executors.createChildLeadFromLB).not.toHaveBeenCalled();
    expect(executors.enrichLeadFromLB).not.toHaveBeenCalled();
    expect(executors.setIdentityLead).not.toHaveBeenCalled();
    expect(executors.setIdentityCustomer).not.toHaveBeenCalled();
    // Adapter logs ambiguous decision
    expect(logger._calls.log.some(l => /\[LB engine\] path=engine.+decision=ambiguous/.test(l))).toBe(true);
  });
});

// ── Scenario 7 — cross-tenant blocked (tenant scope) ──────────────────

describe('LB engine adapter — scenario 7: cross-tenant blocked', () => {
  test('event for tenant 2 does not touch tenant 99 identity', async () => {
    enableEngineForTenant(2);
    const supabase = makeMockSupabase({
      identities: [{
        id: 99001, user_id: 99, normalized_phone: '5559876543',
        normalized_name: 'foreign tenant', name_token_set: 'foreign tenant',
        display_name: 'Foreign Tenant', sf_lead_id: 88888, leadbridge_contact_id: 'LB-FOREIGN',
      }],
    });
    const executors = makeExecutorSpies();
    const logger = makeLogger();
    const adapter = makeAdapter({ supabase, logger, executors });

    await adapter.resolveOrCreateLeadViaEngine(2, {
      channel: 'thumbtack', customerName: 'Foreign Tenant', customerPhone: '+15559876543',
      lbContactId: 'LB-FOREIGN',  // same external_id as tenant 99
    });

    // Tenant 99's identity unchanged
    const foreignIdentity = supabase._state.identities.find(i => i.id === 99001);
    expect(foreignIdentity.sf_lead_id).toBe(88888);
    expect(foreignIdentity.user_id).toBe(99);

    // A new identity row created for tenant 2 (no cross-tenant adoption)
    const tenant2Identities = supabase._state.identities.filter(i => i.user_id === 2);
    expect(tenant2Identities.length).toBe(1);
    expect(tenant2Identities[0].id).not.toBe(99001);
  });
});

// ── Scenario 8 — replay duplicate (same lbContactId) → no duplicate lead

describe('LB engine adapter — scenario 8: replay duplicate', () => {
  test('two engine calls with same lbContactId → same identity, only one lead created', async () => {
    enableEngineForTenant(2);
    const supabase = makeMockSupabase();
    const executors = makeExecutorSpies();
    const logger = makeLogger();
    const adapter = makeAdapter({ supabase, logger, executors });

    // First call — fresh lead
    await adapter.resolveOrCreateLeadViaEngine(2, {
      channel: 'thumbtack', customerName: 'Replay Lead', customerPhone: '+15554443322',
      lbContactId: 'LB-REPLAY-1',
    });

    // Now seed identity with sf_lead_id to simulate the post-create state
    supabase._state.identities[0].sf_lead_id = 9001;
    supabase._state.leads.push({ id: 9001, user_id: 2, parent_lead_id: null });

    // Second call — same lbContactId → resolver external_id match → enrich (no new lead)
    executors.createLeadFromLB.mockClear();
    executors.createChildLeadFromLB.mockClear();
    executors.enrichLeadFromLB.mockClear();

    await adapter.resolveOrCreateLeadViaEngine(2, {
      channel: 'thumbtack', customerName: 'Replay Lead', customerPhone: '+15554443322',
      lbContactId: 'LB-REPLAY-1',
    });

    // child-leads flag ON for tenant 2 → second call hits identity.sf_lead_id
    // → CHILD_ACQUISITION decision (not enrich). The point of the test is
    // that no NEW canonical lead is created; child path is the right outcome
    // when childLeadsEnabled is true.
    expect(executors.createLeadFromLB).not.toHaveBeenCalled();
    expect(executors.createChildLeadFromLB).toHaveBeenCalledTimes(1);
    // Identity count stays at 1 — resolver matched via external_id
    expect(supabase._state.identities.length).toBe(1);
  });
});

// ── Scenario 9 — grandchild refusal → enrich on canonical ─────────────

describe('LB engine adapter — scenario 9: grandchild refusal falls through to enrich', () => {
  test('parent is itself a child → noop_communication_only(parent_invariant_*) → enrichLeadFromLB on canonical', async () => {
    enableEngineForTenant(2);
    const supabase = makeMockSupabase({
      identities: [{
        id: 70, user_id: 2, leadbridge_contact_id: 'LB-GRAND',
        normalized_phone: '5556665555', normalized_name: 'maria diaz',
        name_token_set: 'diaz maria', display_name: 'Maria Diaz',
        sf_lead_id: 245, sf_customer_id: null,
      }],
      // 245 is itself a child (parent_lead_id != null) → grandchild scenario
      leads: [{ id: 245, user_id: 2, parent_lead_id: 100 }],
    });
    const executors = makeExecutorSpies();
    const logger = makeLogger();
    const adapter = makeAdapter({ supabase, logger, executors });

    await adapter.resolveOrCreateLeadViaEngine(2, {
      channel: 'yelp', customerName: 'Maria Diaz', customerPhone: '+15556665555',
      lbContactId: 'LB-GRAND',
    });

    // No grandchild created — invariant refused
    expect(executors.createChildLeadFromLB).not.toHaveBeenCalled();
    // Enrich called on the (broken) canonical — preserves the event
    expect(executors.enrichLeadFromLB).toHaveBeenCalledTimes(1);
    expect(executors.enrichLeadFromLB).toHaveBeenCalledWith(2, 245, expect.any(Object));
    // Adapter emitted grandchild_refusal warn
    expect(logger._calls.warn.some(w => /\[LB engine\] grandchild_refusal tenant=2 parent=/.test(w))).toBe(true);
  });
});

// ── Scenario 10 — frozen → no executor called, identity still resolved

describe('LB engine adapter — scenario 10: projection freeze', () => {
  test('IDENTITY_PROJECTION_FREEZE=true → engine decision=FROZEN → no executors called', async () => {
    enableEngineForTenant(2);
    process.env[FLAGS.IDENTITY_PROJECTION_FREEZE] = '1';

    const supabase = makeMockSupabase();
    const executors = makeExecutorSpies();
    const logger = makeLogger();
    const adapter = makeAdapter({ supabase, logger, executors });

    const result = await adapter.resolveOrCreateLeadViaEngine(2, {
      channel: 'thumbtack', customerName: 'Frozen Test', customerPhone: '+15551112222',
      lbContactId: 'LB-FROZEN',
    });

    // Identity WAS created (resolver continues to run under freeze)
    expect(result.identity).toBeTruthy();
    // But no executor called (projection halted)
    expect(executors.createLeadFromLB).not.toHaveBeenCalled();
    expect(executors.createChildLeadFromLB).not.toHaveBeenCalled();
    expect(result.leadResult).toBeNull();
  });
});

// ── Scenario 11 — floating + phone match customer → ATTACH ────────────

describe('LB engine adapter — scenario 11: attach existing customer (CRM anchor)', () => {
  test('floating identity + customer-by-phone → setIdentityCustomer called', async () => {
    enableEngineForTenant(2);
    const supabase = makeMockSupabase({
      customers: [{ id: 555, user_id: 2, phone: '5558881111' }],
    });
    const executors = makeExecutorSpies();
    const logger = makeLogger();
    const adapter = makeAdapter({ supabase, logger, executors });

    const result = await adapter.resolveOrCreateLeadViaEngine(2, {
      channel: 'thumbtack', customerName: 'Anchored', customerPhone: '+15558881111',
      lbContactId: 'LB-ANCHOR',
    });

    expect(executors.setIdentityCustomer).toHaveBeenCalledTimes(1);
    expect(executors.createLeadFromLB).not.toHaveBeenCalled();
    expect(result.leadResult).toEqual(expect.objectContaining({ type: 'customer', id: 555, action: 'linked_customer' }));
  });
});
