'use strict';

// Stage 1 — pure decision-table tests for the reconciliation engine.
// No DB; no call sites exercised. The engine is dark code today; these
// tests prove the decision table matches docs/architecture/
// identity-reconciliation-engine-design.md §7 cell-by-cell.

const {
  reconcile,
  decideForLeadbridge,
  decideForZenbooker,
  decideForOpenphone,
  decideForSigcore,
  decideForManualSf,
  decideBySource,
  identityState,
  isWritingDecision,
  DECISIONS,
  CONFIDENCE,
  MATCH_STEP_TO_CONFIDENCE,
} = require('../lib/identity-reconciliation-engine');

// ── identityState ────────────────────────────────────────────────────────

describe('identityState', () => {
  test('null/undefined → missing', () => {
    expect(identityState(null)).toBe('missing');
    expect(identityState(undefined)).toBe('missing');
  });
  test('floating when both sf_* are null', () => {
    expect(identityState({ sf_lead_id: null, sf_customer_id: null })).toBe('floating');
  });
  test('has_lead when only sf_lead_id', () => {
    expect(identityState({ sf_lead_id: 100, sf_customer_id: null })).toBe('has_lead');
  });
  test('has_customer when only sf_customer_id', () => {
    expect(identityState({ sf_lead_id: null, sf_customer_id: 200 })).toBe('has_customer');
  });
  test('has_both when both populated', () => {
    expect(identityState({ sf_lead_id: 100, sf_customer_id: 200 })).toBe('has_both');
  });
});

// ── LB decision table (§7.1) ─────────────────────────────────────────────

describe('decideForLeadbridge', () => {
  const policyOn  = { childLeadsEnabled: true,  reactivationLeadsEnabled: true };
  const policyOff = { childLeadsEnabled: false, reactivationLeadsEnabled: false };

  test('has_lead + child-leads ON → child_acquisition', () => {
    const id = { sf_lead_id: 100, sf_customer_id: null };
    const r = decideForLeadbridge(id, {}, policyOn, null);
    expect(r.decision).toBe(DECISIONS.CHILD_ACQUISITION);
    expect(r.parentLeadId).toBe(100);
  });

  test('has_lead + child-leads OFF → enrich_only', () => {
    const id = { sf_lead_id: 100, sf_customer_id: null };
    const r = decideForLeadbridge(id, {}, policyOff, null);
    expect(r.decision).toBe(DECISIONS.ENRICH_ONLY);
  });

  test('has_both + child-leads ON → child_acquisition (parent=canonical)', () => {
    const id = { sf_lead_id: 100, sf_customer_id: 200 };
    const r = decideForLeadbridge(id, {}, policyOn, null);
    expect(r.decision).toBe(DECISIONS.CHILD_ACQUISITION);
    expect(r.parentLeadId).toBe(100);
  });

  test('has_customer + reactivation ON → reactivation_lead', () => {
    const id = { sf_lead_id: null, sf_customer_id: 200 };
    const r = decideForLeadbridge(id, {}, policyOn, null);
    expect(r.decision).toBe(DECISIONS.REACTIVATION_LEAD);
  });

  test('has_customer + reactivation OFF → noop_communication_only (current "identity_already_customer")', () => {
    const id = { sf_lead_id: null, sf_customer_id: 200 };
    const r = decideForLeadbridge(id, {}, policyOff, null);
    expect(r.decision).toBe(DECISIONS.NOOP_COMMUNICATION_ONLY);
    expect(r.reason).toBe('identity_already_customer');
  });

  test('floating + phone-anchored customer → attach_existing_customer', () => {
    const id = { sf_lead_id: null, sf_customer_id: null };
    const r = decideForLeadbridge(id, {}, policyOn, { type: 'customer', id: 500 });
    expect(r.decision).toBe(DECISIONS.ATTACH_EXISTING_CUSTOMER);
    expect(r.attachTarget).toEqual({ type: 'customer', id: 500 });
  });

  test('floating + phone-anchored lead → attach_existing_lead', () => {
    const id = { sf_lead_id: null, sf_customer_id: null };
    const r = decideForLeadbridge(id, {}, policyOn, { type: 'lead', id: 800 });
    expect(r.decision).toBe(DECISIONS.ATTACH_EXISTING_LEAD);
    expect(r.attachTarget).toEqual({ type: 'lead', id: 800 });
  });

  test('floating + no CRM match → canonical_lead_create', () => {
    const id = { sf_lead_id: null, sf_customer_id: null };
    const r = decideForLeadbridge(id, {}, policyOn, null);
    expect(r.decision).toBe(DECISIONS.CANONICAL_LEAD_CREATE);
  });
});

// ── ZB decision table (§7.2) ─────────────────────────────────────────────

describe('decideForZenbooker', () => {
  test('has_customer → enrich_only', () => {
    const r = decideForZenbooker({ sf_lead_id: null, sf_customer_id: 200 }, {});
    expect(r.decision).toBe(DECISIONS.ENRICH_ONLY);
  });
  test('has_both → enrich_only', () => {
    const r = decideForZenbooker({ sf_lead_id: 100, sf_customer_id: 200 }, {});
    expect(r.decision).toBe(DECISIONS.ENRICH_ONLY);
  });
  test('has_lead → canonical_customer_create (cascade will link)', () => {
    const r = decideForZenbooker({ sf_lead_id: 100, sf_customer_id: null }, {});
    expect(r.decision).toBe(DECISIONS.CANONICAL_CUSTOMER_CREATE);
  });
  test('floating → canonical_customer_create', () => {
    const r = decideForZenbooker({ sf_lead_id: null, sf_customer_id: null }, {});
    expect(r.decision).toBe(DECISIONS.CANONICAL_CUSTOMER_CREATE);
  });
  test('ZB never produces child or reactivation', () => {
    // ZB is not an acquisition source — regardless of identity state, no
    // child or reactivation decision should ever appear.
    const states = [
      { sf_lead_id: null, sf_customer_id: null },
      { sf_lead_id: 100, sf_customer_id: null },
      { sf_lead_id: null, sf_customer_id: 200 },
      { sf_lead_id: 100, sf_customer_id: 200 },
    ];
    for (const id of states) {
      const r = decideForZenbooker(id, {});
      expect(r.decision).not.toBe(DECISIONS.CHILD_ACQUISITION);
      expect(r.decision).not.toBe(DECISIONS.REACTIVATION_LEAD);
    }
  });
});

// ── OP decision table (§7.3) ─────────────────────────────────────────────

describe('decideForOpenphone', () => {
  const policyOn  = { conditionalLeadCreationEnabled: true };
  const policyOff = { conditionalLeadCreationEnabled: false };
  const gateYes = { create: true,  reason: 'openphone_direct' };
  const gateNo  = { create: false, reason: 'noise_no_name' };

  test('has_lead → noop_communication_only (OP never creates shadow leads)', () => {
    const r = decideForOpenphone({ sf_lead_id: 100, sf_customer_id: null }, {}, policyOn, null, gateYes);
    expect(r.decision).toBe(DECISIONS.NOOP_COMMUNICATION_ONLY);
  });

  test('has_customer → noop_communication_only', () => {
    const r = decideForOpenphone({ sf_lead_id: null, sf_customer_id: 200 }, {}, policyOn, null, gateYes);
    expect(r.decision).toBe(DECISIONS.NOOP_COMMUNICATION_ONLY);
  });

  test('floating + conditional creation OFF → noop_communication_only', () => {
    const r = decideForOpenphone({}, {}, policyOff, null, gateYes);
    expect(r.decision).toBe(DECISIONS.NOOP_COMMUNICATION_ONLY);
    expect(r.reason).toBe('conditional_lead_creation_off');
  });

  test('floating + gate rejects (aggregator name etc.) → noop_communication_only', () => {
    const r = decideForOpenphone({}, {}, policyOn, null, gateNo);
    expect(r.decision).toBe(DECISIONS.NOOP_COMMUNICATION_ONLY);
    expect(r.reason).toBe('noise_no_name');
  });

  test('floating + gate passes + CRM customer match → attach_existing_customer', () => {
    const r = decideForOpenphone({}, {}, policyOn, { type: 'customer', id: 500 }, gateYes);
    expect(r.decision).toBe(DECISIONS.ATTACH_EXISTING_CUSTOMER);
  });

  test('floating + gate passes + CRM lead match → attach_existing_lead', () => {
    const r = decideForOpenphone({}, {}, policyOn, { type: 'lead', id: 800 }, gateYes);
    expect(r.decision).toBe(DECISIONS.ATTACH_EXISTING_LEAD);
  });

  test('floating + gate passes + no CRM match → canonical_lead_create', () => {
    const r = decideForOpenphone({}, {}, policyOn, null, gateYes);
    expect(r.decision).toBe(DECISIONS.CANONICAL_LEAD_CREATE);
  });
});

// ── Sigcore decision table (§7.4) ────────────────────────────────────────

describe('decideForSigcore', () => {
  test('always enrich_only — no CRM materialization from sigcore-direct events', () => {
    const states = [
      { sf_lead_id: null, sf_customer_id: null },
      { sf_lead_id: 100, sf_customer_id: null },
      { sf_lead_id: null, sf_customer_id: 200 },
      { sf_lead_id: 100, sf_customer_id: 200 },
    ];
    for (const id of states) {
      const r = decideForSigcore(id, {}, {});
      expect(r.decision).toBe(DECISIONS.ENRICH_ONLY);
    }
  });
});

// ── manual_sf decision table (§7.5) ──────────────────────────────────────

describe('decideForManualSf', () => {
  test('lead subject + has_lead → enrich_only', () => {
    const r = decideForManualSf(
      { sf_lead_id: 100, sf_customer_id: null },
      { event: { type: 'operator_action', subject: 'lead' } },
      {}, null,
    );
    expect(r.decision).toBe(DECISIONS.ENRICH_ONLY);
  });

  test('customer subject + has_customer → enrich_only', () => {
    const r = decideForManualSf(
      { sf_lead_id: null, sf_customer_id: 200 },
      { event: { type: 'operator_action', subject: 'customer' } },
      {}, null,
    );
    expect(r.decision).toBe(DECISIONS.ENRICH_ONLY);
  });

  test('floating + phone-anchored customer → attach_existing_customer (operator sees 409)', () => {
    const r = decideForManualSf(
      { sf_lead_id: null, sf_customer_id: null },
      { event: { type: 'operator_action', subject: 'customer' } },
      {}, { type: 'customer', id: 500 },
    );
    expect(r.decision).toBe(DECISIONS.ATTACH_EXISTING_CUSTOMER);
  });

  test('lead subject + floating + no anchor → canonical_lead_create', () => {
    const r = decideForManualSf(
      { sf_lead_id: null, sf_customer_id: null },
      { event: { type: 'operator_action', subject: 'lead' } },
      {}, null,
    );
    expect(r.decision).toBe(DECISIONS.CANONICAL_LEAD_CREATE);
  });

  test('customer subject + floating + no anchor → canonical_customer_create', () => {
    const r = decideForManualSf(
      { sf_lead_id: null, sf_customer_id: null },
      { event: { type: 'operator_action', subject: 'customer' } },
      {}, null,
    );
    expect(r.decision).toBe(DECISIONS.CANONICAL_CUSTOMER_CREATE);
  });
});

// ── decideBySource dispatch ──────────────────────────────────────────────

describe('decideBySource', () => {
  test('dispatches to the right per-source function', () => {
    const id = { sf_lead_id: null, sf_customer_id: null };
    expect(decideBySource('leadbridge', id, {}, { childLeadsEnabled: true }, null, null).decision)
      .toBe(DECISIONS.CANONICAL_LEAD_CREATE);
    expect(decideBySource('zenbooker', id, {}, {}, null, null).decision)
      .toBe(DECISIONS.CANONICAL_CUSTOMER_CREATE);
    expect(decideBySource('sigcore', id, {}, {}, null, null).decision)
      .toBe(DECISIONS.ENRICH_ONLY);
  });
  test('throws on unknown source', () => {
    expect(() => decideBySource('unknown', {}, {}, {}, null, null)).toThrow(/unknown source/);
  });
});

// ── isWritingDecision ────────────────────────────────────────────────────

describe('isWritingDecision', () => {
  test('writing decisions', () => {
    for (const d of [
      DECISIONS.CANONICAL_CUSTOMER_CREATE,
      DECISIONS.CANONICAL_LEAD_CREATE,
      DECISIONS.CHILD_ACQUISITION,
      DECISIONS.REACTIVATION_LEAD,
      DECISIONS.ATTACH_EXISTING_CUSTOMER,
      DECISIONS.ATTACH_EXISTING_LEAD,
    ]) {
      expect(isWritingDecision(d)).toBe(true);
    }
  });
  test('non-writing decisions', () => {
    for (const d of [
      DECISIONS.ENRICH_ONLY,
      DECISIONS.NOOP_COMMUNICATION_ONLY,
      DECISIONS.FROZEN,
      DECISIONS.AMBIGUOUS,
    ]) {
      expect(isWritingDecision(d)).toBe(false);
    }
  });
});

// ── Confidence mapping (R7: never upgrade) ───────────────────────────────

describe('MATCH_STEP_TO_CONFIDENCE', () => {
  test('strong steps → auto_strong', () => {
    expect(MATCH_STEP_TO_CONFIDENCE.external_id).toBe(CONFIDENCE.AUTO_STRONG);
    expect(MATCH_STEP_TO_CONFIDENCE.phone_strong).toBe(CONFIDENCE.AUTO_STRONG);
    expect(MATCH_STEP_TO_CONFIDENCE.email).toBe(CONFIDENCE.AUTO_STRONG);
    expect(MATCH_STEP_TO_CONFIDENCE.via_linked_crm).toBe(CONFIDENCE.AUTO_STRONG);
  });
  test('weak / anchor / floating stay distinct', () => {
    expect(MATCH_STEP_TO_CONFIDENCE.phone_weak).toBe(CONFIDENCE.AUTO_WEAK);
    expect(MATCH_STEP_TO_CONFIDENCE.crm_anchor).toBe(CONFIDENCE.CRM_ANCHOR);
    expect(MATCH_STEP_TO_CONFIDENCE.created_floating).toBe(CONFIDENCE.CREATED_FLOATING);
  });
});

// ── reconcile() integration (with mock DB) ───────────────────────────────
//
// We exercise the orchestration: resolver call → ambiguity short-circuit →
// decision → return shape. The resolver itself has its own dedicated tests;
// here we only confirm the engine threads the result through correctly.

function makeMockSupabase(seed = {}) {
  const state = {
    identities: (seed.identities || []).map(x => ({ ...x })),
    leads: (seed.leads || []).map(x => ({ ...x })),
    customers: (seed.customers || []).map(x => ({ ...x })),
    ambiguities: [],
    nextIdentityId: 1000,
  };

  function fromIdentities() {
    let filters = [];
    let limit = null;
    const applyFilters = (rows) => rows.filter(r =>
      filters.every(f => {
        if (f.op === 'eq') return r[f.col] === f.val;
        if (f.op === 'ilike') {
          const v = String(r[f.col] || '').toLowerCase();
          const p = String(f.val).toLowerCase().replace(/%/g, '');
          return v.includes(p);
        }
        return true;
      })
    );
    const chain = {
      select() { return chain; },
      eq(col, val) { filters.push({ op: 'eq', col, val }); return chain; },
      ilike(col, val) { filters.push({ op: 'ilike', col, val }); return chain; },
      limit(n) { limit = n; return chain; },
      maybeSingle() {
        const r = applyFilters(state.identities);
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
                    const row = state.identities.find(r => r[col] === val);
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
                const fresh = { id: state.nextIdentityId++, ...row };
                state.identities.push(fresh);
                return Promise.resolve({ data: fresh, error: null });
              },
            };
          },
        };
      },
      then(fn) {
        const r = applyFilters(state.identities);
        const trimmed = limit ? r.slice(0, limit) : r;
        return Promise.resolve({ data: trimmed, error: null }).then(fn);
      },
    };
    return chain;
  }

  function fromAmbiguities() {
    return {
      select() {
        // Used by resolver's dedupe path; return zero count.
        return {
          eq() { return this; },
          is() { return this; },
          then(fn) { return Promise.resolve({ count: 0 }).then(fn); },
        };
      },
      insert(row) {
        state.ambiguities.push(row);
        return Promise.resolve({ data: null, error: null });
      },
    };
  }

  function fromTable(tbl) {
    let filters = [];
    let limit = null;
    const tableData = () => state[tbl] || [];
    const applyFilters = (rows) => rows.filter(r =>
      filters.every(f => {
        if (f.op === 'eq') return r[f.col] === f.val;
        if (f.op === 'ilike') {
          const v = String(r[f.col] || '').toLowerCase();
          const p = String(f.val).toLowerCase().replace(/%/g, '');
          return v.includes(p);
        }
        return true;
      })
    );
    const chain = {
      select() { return chain; },
      eq(col, val) { filters.push({ op: 'eq', col, val }); return chain; },
      ilike(col, val) { filters.push({ op: 'ilike', col, val }); return chain; },
      limit(n) { limit = n; return chain; },
      maybeSingle() {
        const r = applyFilters(tableData());
        return Promise.resolve({ data: r[0] || null, error: null });
      },
    };
    return chain;
  }

  return {
    from(tbl) {
      if (tbl === 'communication_participant_identities') return fromIdentities();
      if (tbl === 'communication_identity_ambiguities') return fromAmbiguities();
      if (tbl === 'leads' || tbl === 'customers') return fromTable(tbl);
      throw new Error(`mock: unknown table ${tbl}`);
    },
    _state: state,
  };
}

describe('reconcile() — integration', () => {
  test('ambiguous resolver result → kind=ambiguous, no plan', async () => {
    // Two phone candidates with conflicting names → resolver returns ambiguous.
    const supabase = makeMockSupabase({
      identities: [
        { id: 1, user_id: 2, normalized_phone: '5551234567', normalized_name: 'anna smith', name_token_set: 'anna smith', display_name: 'Anna Smith' },
        { id: 2, user_id: 2, normalized_phone: '5551234567', normalized_name: 'john doe',   name_token_set: 'doe john',   display_name: 'John Doe' },
      ],
    });
    const r = await reconcile(supabase, null, {
      userId: 2, source: 'leadbridge', phone: '+15551234567', displayName: 'Bob Jones',
      event: { type: 'lead_received' },
    }, { childLeadsEnabled: false });
    expect(r.kind).toBe('ambiguous');
    expect(r.identityCandidates.length).toBeGreaterThan(0);
  });

  test('matched + floating + LB + no CRM → canonical_lead_create plan', async () => {
    const supabase = makeMockSupabase();
    const r = await reconcile(supabase, null, {
      userId: 2, source: 'leadbridge', externalId: 'LB-NEW',
      phone: '+15558675309', displayName: 'New Lead',
      event: { type: 'lead_received', channel: 'thumbtack' },
    }, { childLeadsEnabled: false });
    expect(r.kind).toBe('matched');
    expect(r.plan.decision).toBe(DECISIONS.CANONICAL_LEAD_CREATE);
    expect(r.plan.identityId).toBeTruthy();
    expect(r.plan.confidence).toBe(CONFIDENCE.CREATED_FLOATING);
  });

  test('matched + identity has sf_lead_id + child-leads ON → child_acquisition', async () => {
    const supabase = makeMockSupabase({
      identities: [{
        id: 5, user_id: 2, leadbridge_contact_id: 'LB100',
        normalized_phone: '5559998888', normalized_name: 'linda mau',
        name_token_set: 'linda mau', display_name: 'Linda Mau',
        sf_lead_id: 700, sf_customer_id: null,
      }],
      leads: [{ id: 700, user_id: 2, parent_lead_id: null }],
    });
    const r = await reconcile(supabase, null, {
      userId: 2, source: 'leadbridge', externalId: 'LB100',
      phone: '+15559998888', displayName: 'Linda Mau',
      event: { type: 'lead_received', channel: 'yelp' },
    }, { childLeadsEnabled: true });
    expect(r.kind).toBe('matched');
    expect(r.plan.decision).toBe(DECISIONS.CHILD_ACQUISITION);
    expect(r.plan.parentLeadId).toBe(700);
  });

  test('matched + grandchild parent → engine refuses child decision (R5)', async () => {
    // identity points at a lead row that is itself a child — should NOT
    // produce a grandchild; engine surfaces noop_communication_only with
    // a structural reason.
    const supabase = makeMockSupabase({
      identities: [{
        id: 6, user_id: 2, leadbridge_contact_id: 'LB200',
        normalized_phone: '5557776666', normalized_name: 'maria diaz',
        name_token_set: 'diaz maria', display_name: 'Maria Diaz',
        sf_lead_id: 245, sf_customer_id: null,
      }],
      leads: [{ id: 245, user_id: 2, parent_lead_id: 100 }], // parent is itself a child
    });
    const r = await reconcile(supabase, null, {
      userId: 2, source: 'leadbridge', externalId: 'LB200',
      phone: '+15557776666', displayName: 'Maria Diaz',
      event: { type: 'lead_received', channel: 'yelp' },
    }, { childLeadsEnabled: true });
    expect(r.kind).toBe('matched');
    expect(r.plan.decision).toBe(DECISIONS.NOOP_COMMUNICATION_ONLY);
    expect(r.plan.reason).toMatch(/parent_invariant/);
  });

  test('freeze switch → decision becomes FROZEN, intendedDecision preserved', async () => {
    const supabase = makeMockSupabase();
    const r = await reconcile(supabase, null, {
      userId: 2, source: 'leadbridge', externalId: 'LB-X',
      phone: '+15554443322', displayName: 'Test',
      event: { type: 'lead_received', channel: 'thumbtack' },
    }, { childLeadsEnabled: false, freeze: true });
    expect(r.kind).toBe('matched');
    expect(r.plan.decision).toBe(DECISIONS.FROZEN);
    expect(r.plan.intendedDecision).toBe(DECISIONS.CANONICAL_LEAD_CREATE);
  });

  test('input validation — userId required', async () => {
    await expect(reconcile(null, null, { source: 'leadbridge', event: { type: 'x' }, phone: '+15551112222' }, {}))
      .rejects.toThrow(/userId is required/);
  });

  test('input validation — unknown source rejected', async () => {
    await expect(reconcile(null, null, { userId: 1, source: 'fake', event: { type: 'x' }, phone: '+15551112222' }, {}))
      .rejects.toThrow();
  });

  test('input validation — at least one identity signal required', async () => {
    await expect(reconcile(null, null, { userId: 1, source: 'leadbridge', event: { type: 'x' } }, {}))
      .rejects.toThrow(/at least one of/);
  });
});

// ── Invariant R13 — no duplicate graph truth ─────────────────────────────

describe('Invariant R13 — engine never persists a ProjectionPlan', () => {
  test('plan is a plain object returned to caller, not written anywhere', async () => {
    const supabase = makeMockSupabase();
    const r = await reconcile(supabase, null, {
      userId: 2, source: 'leadbridge', externalId: 'LB-CHECK',
      phone: '+15551231234', displayName: 'Plan Check',
      event: { type: 'lead_received', channel: 'thumbtack' },
    }, { childLeadsEnabled: false });
    expect(r.kind).toBe('matched');
    // No `leads` or `customers` rows should have been created by the engine.
    expect(supabase._state.leads.length).toBe(0);
    expect(supabase._state.customers.length).toBe(0);
    // Identity row WAS created — that's the resolver's job, not the engine's.
    expect(supabase._state.identities.length).toBe(1);
  });
});
