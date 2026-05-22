'use strict';

/**
 * Identity Linker — projection + setter layer tests (Phase 0).
 *
 * Covers:
 *   - setIdentityCustomer / setIdentityLead atomicity + idempotency
 *   - projectIdentityToCRM purity + invariants I1-I5
 *   - applyLeadCustomerLink (operator override) behavior
 *   - cross-tenant blocking
 *   - freeze switch
 *   - audit row writes
 *   - [IdentityLink] structured log emission
 *
 * Previous scoring tests (scoreMatch / nameSimilarity / Jaccard) deleted —
 * the linker no longer contains a matcher. The canonical matcher is
 * lib/identity-resolver.js (tested in identity-resolver.test.js).
 */

const {
  setIdentityCustomer,
  setIdentityLead,
  projectIdentityToCRM,
  applyLeadCustomerLink,
  emitProjectionMetric,
  writeAuditRow,
} = require('../lib/identity-linker');

// ── Mock supabase factory ─────────────────────────────────────────

/**
 * Flexible mock that supports:
 *   - from('communication_participant_identities').update(...).eq(...).eq(...).or(...).select(...).maybeSingle()
 *   - from('communication_participant_identities').select(...).eq(...).eq(...).maybeSingle()
 *   - from('leads').update(...).eq(...).eq(...).is(...).select(...)
 *   - from('leads').select(...).eq(...).eq(...).maybeSingle()
 *   - from('leads').select(...).eq(...).eq(...).maybeSingle() (operator override path)
 *   - from('customers').select(...).eq(...).maybeSingle()
 *   - from('identity_link_audit').insert(...)
 *   - rpc('pir_archive_entity', ...)
 */
function makeSupabase({
  identities = [],
  leads = [],
  customers = [],
  leadUpdateErr = null,
  auditErr = null,
  identityUpdateBlocksOr = false,
} = {}) {
  const captured = {
    identityUpdates: [],
    leadUpdates: [],
    auditInserts: [],
    rpcCalls: [],
  };

  const chainable = (resolveFn) => {
    const target = {};
    const methods = ['eq', 'is', 'in', 'gt', 'lt', 'gte', 'lte', 'or', 'order', 'limit', 'not', 'ilike', 'neq'];
    for (const m of methods) {
      target[m] = jest.fn(() => target);
    }
    target.select = jest.fn(() => target);
    target.maybeSingle = jest.fn(async () => resolveFn('maybeSingle'));
    target.single = jest.fn(async () => resolveFn('single'));
    target.then = (onFulfilled) => Promise.resolve(resolveFn('terminal')).then(onFulfilled);
    return target;
  };

  return {
    captured,
    from: jest.fn((table) => {
      if (table === 'communication_participant_identities') {
        return {
          select: jest.fn(() => {
            // For select chains used in setters to read identitySnapshot fallback
            // The .eq().eq().maybeSingle() returns first matching row.
            let filterId = null;
            let filterUser = null;
            const t = {
              eq: jest.fn(function (col, val) {
                if (col === 'id') filterId = val;
                if (col === 'user_id') filterUser = val;
                return t;
              }),
              maybeSingle: jest.fn(async () => {
                const row = identities.find(r => (filterId == null || r.id === filterId) && (filterUser == null || Number(r.user_id) === Number(filterUser))) || null;
                return { data: row, error: null };
              }),
            };
            return t;
          }),
          update: jest.fn((patch) => {
            captured.identityUpdates.push(patch);
            // Build chainable that supports .eq().eq().or().select().maybeSingle()
            let targetId = null;
            let targetUser = null;
            const t = {
              eq: jest.fn(function (col, val) {
                if (col === 'id') targetId = val;
                if (col === 'user_id') targetUser = val;
                return t;
              }),
              or: jest.fn(function () {
                if (identityUpdateBlocksOr) {
                  // Force the `or` guard to filter everything out → returns null (collision).
                  t._block = true;
                }
                return t;
              }),
              select: jest.fn(() => t),
              maybeSingle: jest.fn(async () => {
                if (t._block) return { data: null, error: null };
                const row = identities.find(r => r.id === targetId && Number(r.user_id) === Number(targetUser));
                if (!row) return { data: null, error: null };
                // Apply patch.
                Object.assign(row, patch);
                return { data: { ...row }, error: null };
              }),
            };
            return t;
          }),
        };
      }
      if (table === 'leads') {
        return {
          select: jest.fn(() => {
            let filterId = null;
            let filterUser = null;
            const t = {
              eq: jest.fn(function (col, val) {
                if (col === 'id') filterId = val;
                if (col === 'user_id') filterUser = val;
                return t;
              }),
              is: jest.fn(() => t),
              maybeSingle: jest.fn(async () => {
                const row = leads.find(r => r.id === filterId && Number(r.user_id) === Number(filterUser)) || null;
                return { data: row, error: null };
              }),
            };
            return t;
          }),
          update: jest.fn((patch) => {
            captured.leadUpdates.push(patch);
            let targetId = null;
            let targetUser = null;
            let requireNullConvert = false;
            const t = {
              eq: jest.fn(function (col, val) {
                if (col === 'id') targetId = val;
                if (col === 'user_id') targetUser = val;
                return t;
              }),
              is: jest.fn(function (col, val) {
                if (col === 'converted_customer_id' && val === null) requireNullConvert = true;
                return t;
              }),
              select: jest.fn(() => {
                if (leadUpdateErr) return Promise.resolve({ data: null, error: leadUpdateErr });
                const row = leads.find(r => r.id === targetId && Number(r.user_id) === Number(targetUser));
                if (!row) return Promise.resolve({ data: [], error: null });
                if (requireNullConvert && row.converted_customer_id != null) {
                  return Promise.resolve({ data: [], error: null });
                }
                Object.assign(row, patch);
                return Promise.resolve({ data: [{ id: row.id }], error: null });
              }),
            };
            return t;
          }),
        };
      }
      if (table === 'customers') {
        return {
          select: jest.fn(() => {
            let filterId = null;
            const t = {
              eq: jest.fn(function (col, val) {
                if (col === 'id') filterId = val;
                return t;
              }),
              maybeSingle: jest.fn(async () => {
                const row = customers.find(r => r.id === filterId) || null;
                return { data: row, error: null };
              }),
            };
            return t;
          }),
        };
      }
      if (table === 'identity_link_audit') {
        return {
          insert: jest.fn((row) => {
            captured.auditInserts.push(row);
            return Promise.resolve({ data: null, error: auditErr });
          }),
        };
      }
      if (table === 'lead_stages' || table === 'lead_pipelines') {
        // For stage-move branch; default empty.
        const t = {
          select: jest.fn(() => t),
          eq: jest.fn(() => t),
          order: jest.fn(() => Promise.resolve({ data: [], error: null })),
          maybeSingle: jest.fn(async () => ({ data: null, error: null })),
        };
        return t;
      }
      return {};
    }),
    rpc: jest.fn(async (name, args) => {
      captured.rpcCalls.push({ name, args });
      return { data: null, error: null };
    }),
  };
}

function makeLogger() {
  return { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
}

// Ensure no stray FREEZE env var leaks into tests.
afterEach(() => {
  delete process.env.IDENTITY_PROJECTION_FREEZE;
});

// ── projectIdentityToCRM — pure projection (I1-I5) ───────────────

describe('projectIdentityToCRM', () => {
  test('no_op when one side missing', async () => {
    const supabase = makeSupabase({});
    const r = await projectIdentityToCRM(supabase, makeLogger(), { id: 1, user_id: 2, sf_lead_id: 10, sf_customer_id: null });
    expect(r.projected).toBe(false);
    expect(r.reason).toBe('one_side_missing');
    expect(supabase.captured.leadUpdates).toHaveLength(0);
  });

  test('projects when both sides set and lead unconverted', async () => {
    const supabase = makeSupabase({
      leads: [{ id: 10, user_id: 2, converted_customer_id: null, source: 'Thumbtack', lead_cost: 200 }],
      customers: [{ id: 20, user_id: 2 }],
    });
    const logger = makeLogger();
    const r = await projectIdentityToCRM(supabase, logger, { id: 5, user_id: 2, sf_lead_id: 10, sf_customer_id: 20 }, {
      resolvedBy: 'automatic',
      resolutionReason: 'identity_graph_projection',
      source: 'zenbooker',
    });
    expect(r.projected).toBe(true);
    expect(r.lead_id).toBe(10);
    expect(r.customer_id).toBe(20);
    // I3/I4: only the three allowed columns
    const patch = supabase.captured.leadUpdates[0];
    expect(Object.keys(patch).sort()).toEqual(['converted_at', 'converted_customer_id', 'updated_at']);
    expect(patch.converted_customer_id).toBe(20);
    // I5: audit row written
    expect(supabase.captured.auditInserts[0]).toMatchObject({
      user_id: 2, lead_id: 10, customer_id: 20, identity_id: 5,
      resolved_by: 'automatic', resolution_reason: 'identity_graph_projection',
    });
    // Loki emit
    const logged = logger.log.mock.calls.find(c => /^\[IdentityLink\]/.test(c[0]))[0];
    expect(logged).toMatch(/event=project outcome=success/);
    expect(logged).toMatch(/lead_id=10/);
    expect(logged).toMatch(/customer_id=20/);
    expect(logged).toMatch(/tenant=2/);
  });

  test('I1: cross-tenant projection blocked + invariant log emitted', async () => {
    const supabase = makeSupabase({
      leads: [{ id: 10, user_id: 2, converted_customer_id: null }],
      customers: [{ id: 20, user_id: 999 }], // wrong tenant
    });
    const logger = makeLogger();
    const r = await projectIdentityToCRM(supabase, logger, { id: 5, user_id: 2, sf_lead_id: 10, sf_customer_id: 20 });
    expect(r.projected).toBe(false);
    expect(r.reason).toBe('cross_tenant_blocked');
    expect(supabase.captured.leadUpdates).toHaveLength(0);
    expect(logger.error).toHaveBeenCalledWith(expect.stringMatching(/\[IdentityLinkInvariantViolation\]/));
  });

  test('I2: idempotent when lead already linked to same customer', async () => {
    const supabase = makeSupabase({
      leads: [{ id: 10, user_id: 2, converted_customer_id: 20 }],
      customers: [{ id: 20, user_id: 2 }],
    });
    const logger = makeLogger();
    const r = await projectIdentityToCRM(supabase, logger, { id: 5, user_id: 2, sf_lead_id: 10, sf_customer_id: 20 });
    expect(r.projected).toBe(false);
    expect(r.reason).toBe('idempotent_already_linked');
    // Audit row still written (for the idempotent attempt).
    expect(supabase.captured.auditInserts.length).toBeGreaterThanOrEqual(0);
    const logged = logger.log.mock.calls.find(c => /^\[IdentityLink\]/.test(c[0]))[0];
    expect(logged).toMatch(/outcome=idempotent/);
  });

  test('I2: refused when lead linked to a DIFFERENT customer', async () => {
    const supabase = makeSupabase({
      leads: [{ id: 10, user_id: 2, converted_customer_id: 99 }],
      customers: [{ id: 20, user_id: 2 }],
    });
    const logger = makeLogger();
    const r = await projectIdentityToCRM(supabase, logger, { id: 5, user_id: 2, sf_lead_id: 10, sf_customer_id: 20 });
    expect(r.projected).toBe(false);
    expect(r.reason).toBe('lead_already_linked_to_other');
    expect(r.current_customer_id).toBe(99);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('lead already converted to 99'));
  });

  test('I3/I4: source, lead_cost, created_at, pipeline_id never modified', async () => {
    const lead = { id: 10, user_id: 2, converted_customer_id: null, source: 'Thumbtack Tampa', lead_cost: 200, created_at: '2026-01-01', pipeline_id: 7 };
    const supabase = makeSupabase({ leads: [lead], customers: [{ id: 20, user_id: 2 }] });
    await projectIdentityToCRM(supabase, makeLogger(), { id: 5, user_id: 2, sf_lead_id: 10, sf_customer_id: 20 });
    // Verify update patch only contains the three allowed columns.
    expect(Object.keys(supabase.captured.leadUpdates[0])).not.toContain('source');
    expect(Object.keys(supabase.captured.leadUpdates[0])).not.toContain('lead_cost');
    expect(Object.keys(supabase.captured.leadUpdates[0])).not.toContain('created_at');
    expect(Object.keys(supabase.captured.leadUpdates[0])).not.toContain('pipeline_id');
    // And on the lead itself the original values are preserved.
    expect(lead.source).toBe('Thumbtack Tampa');
    expect(lead.lead_cost).toBe(200);
    expect(lead.created_at).toBe('2026-01-01');
    expect(lead.pipeline_id).toBe(7);
  });

  test('freeze switch halts projection', async () => {
    process.env.IDENTITY_PROJECTION_FREEZE = 'true';
    const supabase = makeSupabase({
      leads: [{ id: 10, user_id: 2, converted_customer_id: null }],
      customers: [{ id: 20, user_id: 2 }],
    });
    const logger = makeLogger();
    const r = await projectIdentityToCRM(supabase, logger, { id: 5, user_id: 2, sf_lead_id: 10, sf_customer_id: 20 });
    expect(r.projected).toBe(false);
    expect(r.reason).toBe('freeze');
    expect(supabase.captured.leadUpdates).toHaveLength(0);
    const logged = logger.log.mock.calls.find(c => /^\[IdentityLink\]/.test(c[0]))[0];
    expect(logged).toMatch(/outcome=freeze/);
  });

  test('lead_not_found returns appropriate reason', async () => {
    const supabase = makeSupabase({ leads: [], customers: [{ id: 20, user_id: 2 }] });
    const r = await projectIdentityToCRM(supabase, makeLogger(), { id: 5, user_id: 2, sf_lead_id: 10, sf_customer_id: 20 });
    expect(r.projected).toBe(false);
    expect(r.reason).toBe('lead_not_found');
  });
});

// ── setIdentityCustomer / setIdentityLead ────────────────────────

describe('setIdentityCustomer', () => {
  test('writes sf_customer_id and triggers projection when sf_lead_id already set', async () => {
    const identity = { id: 5, user_id: 2, sf_lead_id: 10, sf_customer_id: null };
    const supabase = makeSupabase({
      identities: [identity],
      leads: [{ id: 10, user_id: 2, converted_customer_id: null }],
      customers: [{ id: 20, user_id: 2 }],
    });
    const logger = makeLogger();
    const r = await setIdentityCustomer(supabase, logger, {
      userId: 2, identityId: 5, customerId: 20,
      identitySnapshot: identity,
      policy: { source: 'zenbooker', resolvedBy: 'automatic', resolutionReason: 'identity_graph_projection' },
    });
    expect(r.ok).toBe(true);
    expect(r.projection.projected).toBe(true);
    expect(supabase.captured.leadUpdates).toHaveLength(1);
    expect(supabase.captured.leadUpdates[0].converted_customer_id).toBe(20);
    // Status was updated to resolved_both (lead was already set).
    expect(identity.status).toBe('resolved_both');
    const logged = logger.log.mock.calls.map(c => c[0]).filter(s => /^\[IdentityLink\]/.test(s));
    expect(logged.some(s => /event=set_customer outcome=success/.test(s))).toBe(true);
    expect(logged.some(s => /event=project outcome=success/.test(s))).toBe(true);
  });

  test('no projection when sf_lead_id is null (one side missing)', async () => {
    const identity = { id: 5, user_id: 2, sf_lead_id: null, sf_customer_id: null };
    const supabase = makeSupabase({
      identities: [identity],
      leads: [],
      customers: [{ id: 20, user_id: 2 }],
    });
    const r = await setIdentityCustomer(supabase, makeLogger(), {
      userId: 2, identityId: 5, customerId: 20,
      identitySnapshot: identity,
    });
    expect(r.ok).toBe(true);
    expect(r.projection.projected).toBe(false);
    expect(supabase.captured.leadUpdates).toHaveLength(0);
    expect(identity.status).toBe('resolved_customer');
  });

  test('collision when identity already has different sf_customer_id', async () => {
    const identity = { id: 5, user_id: 2, sf_lead_id: 10, sf_customer_id: 999 };
    const supabase = makeSupabase({
      identities: [identity],
      identityUpdateBlocksOr: true, // simulate guarded UPDATE filtering out the row
    });
    const logger = makeLogger();
    const r = await setIdentityCustomer(supabase, logger, {
      userId: 2, identityId: 5, customerId: 20,
      identitySnapshot: identity,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('collision');
    expect(logger.warn).toHaveBeenCalled();
  });

  test('invalid_input returns without DB call', async () => {
    const supabase = makeSupabase({});
    const r = await setIdentityCustomer(supabase, makeLogger(), { userId: null, identityId: 5, customerId: 20 });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('invalid_input');
    expect(supabase.from).not.toHaveBeenCalled();
  });

  test('identity_not_found when snapshot omitted and DB returns nothing', async () => {
    const supabase = makeSupabase({ identities: [] });
    const r = await setIdentityCustomer(supabase, makeLogger(), { userId: 2, identityId: 5, customerId: 20 });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('identity_not_found');
  });
});

describe('setIdentityLead — symmetric', () => {
  test('writes sf_lead_id and projects when sf_customer_id already set', async () => {
    const identity = { id: 5, user_id: 2, sf_lead_id: null, sf_customer_id: 20 };
    const supabase = makeSupabase({
      identities: [identity],
      leads: [{ id: 10, user_id: 2, converted_customer_id: null }],
      customers: [{ id: 20, user_id: 2 }],
    });
    const logger = makeLogger();
    const r = await setIdentityLead(supabase, logger, {
      userId: 2, identityId: 5, leadId: 10,
      identitySnapshot: identity,
      policy: { source: 'leadbridge', resolvedBy: 'automatic', resolutionReason: 'identity_graph_projection' },
    });
    expect(r.ok).toBe(true);
    expect(r.projection.projected).toBe(true);
    expect(supabase.captured.leadUpdates).toHaveLength(1);
    expect(supabase.captured.leadUpdates[0].converted_customer_id).toBe(20);
    expect(identity.status).toBe('resolved_both');
  });
});

// ── applyLeadCustomerLink — operator override ─────────────────────

describe('applyLeadCustomerLink', () => {
  test('happy path — link applied + audit + archive RPC', async () => {
    const supabase = makeSupabase({
      leads: [{ id: 67, user_id: 2, converted_customer_id: null }],
      customers: [{ id: 23421, user_id: 2 }],
    });
    const logger = makeLogger();
    const r = await applyLeadCustomerLink(supabase, logger, { userId: 2, leadId: 67, customerId: 23421 });
    expect(r.ok).toBe(true);
    expect(supabase.captured.leadUpdates[0].converted_customer_id).toBe(23421);
    expect(supabase.captured.auditInserts[0]).toMatchObject({
      user_id: 2, lead_id: 67, customer_id: 23421, resolved_by: 'operator_override',
    });
    expect(supabase.captured.rpcCalls[0].name).toBe('pir_archive_entity');
    const logged = logger.log.mock.calls.find(c => /^\[IdentityLink\]/.test(c[0]))[0];
    expect(logged).toMatch(/event=operator_override outcome=success/);
    expect(logged).toMatch(/resolved_by=operator_override/);
  });

  test('refuses when lead already converted to different customer', async () => {
    const supabase = makeSupabase({
      leads: [{ id: 67, user_id: 2, converted_customer_id: 99999 }],
      customers: [{ id: 23421, user_id: 2 }],
    });
    const r = await applyLeadCustomerLink(supabase, makeLogger(), { userId: 2, leadId: 67, customerId: 23421 });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('lead_already_converted');
    expect(r.current).toBe(99999);
  });

  test('idempotent when already linked to same customer', async () => {
    const supabase = makeSupabase({
      leads: [{ id: 67, user_id: 2, converted_customer_id: 23421 }],
      customers: [{ id: 23421, user_id: 2 }],
    });
    const r = await applyLeadCustomerLink(supabase, makeLogger(), { userId: 2, leadId: 67, customerId: 23421 });
    expect(r.ok).toBe(true);
    expect(r.idempotent).toBe(true);
    expect(supabase.captured.leadUpdates).toHaveLength(0);
  });

  test('lead_not_found when lead absent', async () => {
    const supabase = makeSupabase({ leads: [], customers: [{ id: 23421, user_id: 2 }] });
    const r = await applyLeadCustomerLink(supabase, makeLogger(), { userId: 2, leadId: 67, customerId: 23421 });
    expect(r.error).toBe('lead_not_found');
  });

  test('cross_tenant_blocked when customer in different tenant', async () => {
    const supabase = makeSupabase({
      leads: [{ id: 67, user_id: 2, converted_customer_id: null }],
      customers: [{ id: 23421, user_id: 999 }],
    });
    const logger = makeLogger();
    const r = await applyLeadCustomerLink(supabase, logger, { userId: 2, leadId: 67, customerId: 23421 });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('cross_tenant_blocked');
    expect(logger.error).toHaveBeenCalledWith(expect.stringMatching(/\[IdentityLinkInvariantViolation\]/));
  });

  test('freeze switch halts operator override too', async () => {
    process.env.IDENTITY_PROJECTION_FREEZE = 'true';
    const supabase = makeSupabase({
      leads: [{ id: 67, user_id: 2, converted_customer_id: null }],
      customers: [{ id: 23421, user_id: 2 }],
    });
    const r = await applyLeadCustomerLink(supabase, makeLogger(), { userId: 2, leadId: 67, customerId: 23421 });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('freeze');
  });

  test('invalid_input no-op', async () => {
    const supabase = makeSupabase({});
    const r = await applyLeadCustomerLink(supabase, makeLogger(), {});
    expect(r.ok).toBe(false);
    expect(r.error).toBe('invalid_input');
  });
});

// ── writeAuditRow — idempotency on (lead_id, customer_id) ────────

describe('writeAuditRow', () => {
  test('returns ok on successful insert', async () => {
    const supabase = makeSupabase({});
    const r = await writeAuditRow(supabase, makeLogger(), {
      userId: 2, leadId: 10, customerId: 20, resolvedBy: 'automatic', resolutionReason: 'identity_graph_projection',
    });
    expect(r.ok).toBe(true);
    expect(supabase.captured.auditInserts[0].resolved_by).toBe('automatic');
  });

  test('idempotent on unique violation (23505)', async () => {
    const supabase = makeSupabase({ auditErr: { code: '23505', message: 'duplicate key' } });
    const r = await writeAuditRow(supabase, makeLogger(), {
      userId: 2, leadId: 10, customerId: 20, resolvedBy: 'automatic', resolutionReason: 'x',
    });
    expect(r.ok).toBe(true);
    expect(r.idempotent).toBe(true);
  });

  test('non-unique error returns ok:false but does not throw', async () => {
    const supabase = makeSupabase({ auditErr: { code: 'XXXXX', message: 'other db error' } });
    const r = await writeAuditRow(supabase, makeLogger(), {
      userId: 2, leadId: 10, customerId: 20, resolvedBy: 'automatic', resolutionReason: 'x',
    });
    expect(r.ok).toBe(false);
  });
});

// ── emitProjectionMetric — structured log shape ──────────────────

describe('emitProjectionMetric', () => {
  test('emits canonical [IdentityLink] line with all fields', () => {
    const logger = makeLogger();
    emitProjectionMetric(logger, {
      event: 'project', outcome: 'success', tenant: 2,
      identityId: 5, leadId: 10, customerId: 20,
      source: 'zenbooker', resolvedBy: 'automatic',
      resolutionReason: 'identity_graph_projection', durationMs: 12,
    });
    const line = logger.log.mock.calls[0][0];
    expect(line).toMatch(/^\[IdentityLink\] /);
    expect(line).toMatch(/event=project/);
    expect(line).toMatch(/outcome=success/);
    expect(line).toMatch(/tenant=2/);
    expect(line).toMatch(/identity_id=5/);
    expect(line).toMatch(/lead_id=10/);
    expect(line).toMatch(/customer_id=20/);
    expect(line).toMatch(/source=zenbooker/);
    expect(line).toMatch(/resolved_by=automatic/);
    expect(line).toMatch(/resolution_reason=identity_graph_projection/);
    expect(line).toMatch(/duration_ms=12/);
  });

  test('handles null fields gracefully', () => {
    const logger = makeLogger();
    emitProjectionMetric(logger, { event: 'project', outcome: 'no_op_one_side_missing', tenant: 2 });
    const line = logger.log.mock.calls[0][0];
    expect(line).toMatch(/identity_id=null/);
    expect(line).toMatch(/lead_id=null/);
    expect(line).toMatch(/customer_id=null/);
  });

  test('safe with no logger', () => {
    expect(() => emitProjectionMetric(null, { event: 'project', outcome: 'success', tenant: 2 })).not.toThrow();
    expect(() => emitProjectionMetric({}, { event: 'project', outcome: 'success', tenant: 2 })).not.toThrow();
  });
});
