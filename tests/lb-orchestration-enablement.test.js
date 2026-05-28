'use strict';

/**
 * lb-orchestration-feature-flag.js — layered enablement (S2).
 *
 * Confirms:
 *
 *   parseEnabledTenants:
 *     - '' → no enablement
 *     - '*' → all
 *     - '2,17' → positives {2,17}
 *     - '+2, -7' → positives {2}, negatives {7}
 *     - '-2' → negatives {2}
 *
 *   isOrchestrationEnabledForTenantLayered:
 *     - empty env + zero credentials → not enabled (BACKWARD COMPAT)
 *     - empty env + tenant connected + active cred → enabled via=connection_state
 *     - empty env + tenant connected, NO enabled_at → not enabled
 *     - empty env + connected + revoked cred → not enabled
 *     - empty env + connected + rotating in grace → enabled
 *     - empty env + connected + rotating past grace → not enabled
 *     - env '+2' → enabled via=env_override (no DB read needed)
 *     - env '-2' → not enabled via=env_negative_override (overrides DB)
 *     - env '*' → enabled for any tenant
 *     - DB error → via='error' (transient)
 *
 *   makeRequireOrchestrationEnabled middleware:
 *     - returns next() when enabled
 *     - returns 403 orchestration_not_enabled_for_tenant when not
 *     - returns 503 service_unavailable on DB error
 *
 *   Legacy isOrchestrationEnabledForTenant + requireOrchestrationEnabled
 *   continue to behave exactly as before (env-only, synchronous).
 */

const TABLE = 'lb_orchestration_credentials';

// Helper: build a tiny Supabase-like store that handles only the
// queries the layered check makes:
//   .from('communication_settings').select(...).eq('user_id', X).maybeSingle()
//   .from('lb_orchestration_credentials').select(...).eq('user_id', X).in('status', [...])
function makeStore({ settings = [], creds = [], failOn = null } = {}) {
  return {
    _settings: settings,
    _creds: creds,
    from(table) {
      const filters = [];
      let selectCols = null;
      const builder = {
        select(c) { selectCols = c || '*'; return builder; },
        eq(c, v)  { filters.push({ type: 'eq', col: c, val: v }); return builder; },
        in(c, v)  { filters.push({ type: 'in', col: c, vals: v }); return builder; },
        maybeSingle() {
          if (failOn === table) return Promise.resolve({ data: null, error: { message: 'simulated db failure' } });
          if (table === 'communication_settings') {
            const userIdFilter = filters.find((f) => f.col === 'user_id');
            const row = settings.find((s) => s.user_id === userIdFilter.val);
            return Promise.resolve({ data: row || null, error: null });
          }
          return Promise.resolve({ data: null, error: null });
        },
        then(onF, onR) {
          if (failOn === table) {
            return Promise.resolve({ data: null, error: { message: 'simulated db failure' } }).then(onF, onR);
          }
          if (table === TABLE) {
            const userIdFilter = filters.find((f) => f.col === 'user_id');
            const statusFilter = filters.find((f) => f.col === 'status' && f.type === 'in');
            let rows = creds.filter((c) => c.user_id === userIdFilter.val);
            if (statusFilter) rows = rows.filter((c) => statusFilter.vals.includes(c.status));
            return Promise.resolve({ data: rows.map((r) => ({ ...r })), error: null }).then(onF, onR);
          }
          return Promise.resolve({ data: null, error: null }).then(onF, onR);
        },
      };
      return builder;
    },
  };
}

function mockRes() {
  return {
    _status: 200, _body: null,
    status(c) { this._status = c; return this; },
    json(b)   { this._body   = b; return this; },
  };
}

// Re-require fresh after env mutation. Required because the legacy
// middleware tests delete env in-place.
function freshModule() {
  jest.resetModules();
  return require('../lib/lb-orchestration-feature-flag');
}

// ─────────────────────────────────────────────────────────────────
// Env parsing
// ─────────────────────────────────────────────────────────────────
describe('parseEnabledTenants', () => {
  afterEach(() => { delete process.env.LB_ORCHESTRATION_ENABLED_TENANTS; });

  test('empty env → nothing enabled', () => {
    delete process.env.LB_ORCHESTRATION_ENABLED_TENANTS;
    const { _parseEnabledTenants } = freshModule();
    const r = _parseEnabledTenants();
    expect(r.all).toBe(false);
    expect(r.positives.size).toBe(0);
    expect(r.negatives.size).toBe(0);
  });

  test('"*" → all', () => {
    process.env.LB_ORCHESTRATION_ENABLED_TENANTS = '*';
    const { _parseEnabledTenants } = freshModule();
    const r = _parseEnabledTenants();
    expect(r.all).toBe(true);
  });

  test('"2,17" → positives {2,17}', () => {
    process.env.LB_ORCHESTRATION_ENABLED_TENANTS = '2,17';
    const { _parseEnabledTenants } = freshModule();
    const r = _parseEnabledTenants();
    expect(r.positives.has('2')).toBe(true);
    expect(r.positives.has('17')).toBe(true);
    expect(r.negatives.size).toBe(0);
  });

  test('"+2, -7" → positives {2}, negatives {7}', () => {
    process.env.LB_ORCHESTRATION_ENABLED_TENANTS = '+2, -7';
    const { _parseEnabledTenants } = freshModule();
    const r = _parseEnabledTenants();
    expect(r.positives.has('2')).toBe(true);
    expect(r.negatives.has('7')).toBe(true);
  });

  test('"-2" → negatives {2}', () => {
    process.env.LB_ORCHESTRATION_ENABLED_TENANTS = '-2';
    const { _parseEnabledTenants } = freshModule();
    const r = _parseEnabledTenants();
    expect(r.negatives.has('2')).toBe(true);
    expect(r.positives.size).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────
// isOrchestrationEnabledForTenantLayered (async)
// ─────────────────────────────────────────────────────────────────
describe('isOrchestrationEnabledForTenantLayered', () => {
  afterEach(() => { delete process.env.LB_ORCHESTRATION_ENABLED_TENANTS; });

  test('BACKWARD COMPAT — empty env + zero credentials → not enabled', async () => {
    delete process.env.LB_ORCHESTRATION_ENABLED_TENANTS;
    const { isOrchestrationEnabledForTenantLayered } = freshModule();
    const store = makeStore();
    const r = await isOrchestrationEnabledForTenantLayered(store, 2);
    expect(r.enabled).toBe(false);
    expect(r.via).toBe('no_match');
  });

  test('connection-state path: connected + enabled_at + active cred → enabled', async () => {
    delete process.env.LB_ORCHESTRATION_ENABLED_TENANTS;
    const { isOrchestrationEnabledForTenantLayered } = freshModule();
    const store = makeStore({
      settings: [{ user_id: 2, leadbridge_connected: true, lb_orchestration_enabled_at: '2026-05-27T00:00:00Z' }],
      creds:    [{ user_id: 2, status: 'active', grace_expires_at: null }],
    });
    const r = await isOrchestrationEnabledForTenantLayered(store, 2);
    expect(r.enabled).toBe(true);
    expect(r.via).toBe('connection_state');
  });

  test('connected but enabled_at NULL → not enabled', async () => {
    const { isOrchestrationEnabledForTenantLayered } = freshModule();
    const store = makeStore({
      settings: [{ user_id: 2, leadbridge_connected: true, lb_orchestration_enabled_at: null }],
      creds:    [{ user_id: 2, status: 'active' }],
    });
    const r = await isOrchestrationEnabledForTenantLayered(store, 2);
    expect(r.enabled).toBe(false);
    expect(r.via).toBe('no_match');
  });

  test('connection state set but cred revoked → not enabled', async () => {
    const { isOrchestrationEnabledForTenantLayered } = freshModule();
    const store = makeStore({
      settings: [{ user_id: 2, leadbridge_connected: true, lb_orchestration_enabled_at: '2026-05-27T00:00:00Z' }],
      creds:    [{ user_id: 2, status: 'revoked' }],
    });
    const r = await isOrchestrationEnabledForTenantLayered(store, 2);
    expect(r.enabled).toBe(false);
    expect(r.via).toBe('no_match');
  });

  test('rotating credential inside grace → enabled', async () => {
    const { isOrchestrationEnabledForTenantLayered } = freshModule();
    const futureIso = new Date(Date.now() + 60_000).toISOString();
    const store = makeStore({
      settings: [{ user_id: 2, leadbridge_connected: true, lb_orchestration_enabled_at: '2026-05-27T00:00:00Z' }],
      creds:    [{ user_id: 2, status: 'rotating', grace_expires_at: futureIso }],
    });
    const r = await isOrchestrationEnabledForTenantLayered(store, 2);
    expect(r.enabled).toBe(true);
  });

  test('rotating credential past grace → not enabled', async () => {
    const { isOrchestrationEnabledForTenantLayered } = freshModule();
    const pastIso = new Date(Date.now() - 60_000).toISOString();
    const store = makeStore({
      settings: [{ user_id: 2, leadbridge_connected: true, lb_orchestration_enabled_at: '2026-05-27T00:00:00Z' }],
      creds:    [{ user_id: 2, status: 'rotating', grace_expires_at: pastIso }],
    });
    const r = await isOrchestrationEnabledForTenantLayered(store, 2);
    expect(r.enabled).toBe(false);
  });

  test('env "+2" → enabled via env_override, no DB read needed', async () => {
    process.env.LB_ORCHESTRATION_ENABLED_TENANTS = '+2';
    const { isOrchestrationEnabledForTenantLayered } = freshModule();
    const store = makeStore();   // empty DB
    const r = await isOrchestrationEnabledForTenantLayered(store, 2);
    expect(r.enabled).toBe(true);
    expect(r.via).toBe('env_override');
  });

  test('env "-2" → disabled via env_negative_override, OVERRIDES DB state', async () => {
    process.env.LB_ORCHESTRATION_ENABLED_TENANTS = '-2';
    const { isOrchestrationEnabledForTenantLayered } = freshModule();
    const store = makeStore({
      // tenant 2 has all the right DB state for enablement
      settings: [{ user_id: 2, leadbridge_connected: true, lb_orchestration_enabled_at: '2026-05-27T00:00:00Z' }],
      creds:    [{ user_id: 2, status: 'active' }],
    });
    const r = await isOrchestrationEnabledForTenantLayered(store, 2);
    expect(r.enabled).toBe(false);
    expect(r.via).toBe('env_negative_override');
  });

  test('env "*" → enabled for any tenant', async () => {
    process.env.LB_ORCHESTRATION_ENABLED_TENANTS = '*';
    const { isOrchestrationEnabledForTenantLayered } = freshModule();
    const store = makeStore();
    const r = await isOrchestrationEnabledForTenantLayered(store, 999);
    expect(r.enabled).toBe(true);
    expect(r.via).toBe('env_override');
  });

  test('env "*" with "-2" → tenant 2 still disabled (negative wins)', async () => {
    process.env.LB_ORCHESTRATION_ENABLED_TENANTS = '*';
    const { isOrchestrationEnabledForTenantLayered } = freshModule();
    const store = makeStore();
    // First: tenant 999 enabled via *
    expect((await isOrchestrationEnabledForTenantLayered(store, 999)).enabled).toBe(true);
    // Now disable tenant 2 explicitly via negative.
    process.env.LB_ORCHESTRATION_ENABLED_TENANTS = '*, -2';
    const { isOrchestrationEnabledForTenantLayered: again } = freshModule();
    const r = await again(store, 2);
    expect(r.enabled).toBe(false);
    expect(r.via).toBe('env_negative_override');
  });

  test('DB error on communication_settings → via=error', async () => {
    const { isOrchestrationEnabledForTenantLayered } = freshModule();
    const store = makeStore({ failOn: 'communication_settings' });
    const r = await isOrchestrationEnabledForTenantLayered(store, 2);
    expect(r.enabled).toBe(false);
    expect(r.via).toBe('error');
  });

  test('DB error on credentials → via=error', async () => {
    const { isOrchestrationEnabledForTenantLayered } = freshModule();
    const store = makeStore({
      settings: [{ user_id: 2, leadbridge_connected: true, lb_orchestration_enabled_at: '2026-05-27T00:00:00Z' }],
      failOn: TABLE,
    });
    const r = await isOrchestrationEnabledForTenantLayered(store, 2);
    expect(r.enabled).toBe(false);
    expect(r.via).toBe('error');
  });

  test('userId null → not enabled', async () => {
    const { isOrchestrationEnabledForTenantLayered } = freshModule();
    const store = makeStore();
    expect((await isOrchestrationEnabledForTenantLayered(store, null)).enabled).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────
// makeRequireOrchestrationEnabled middleware
// ─────────────────────────────────────────────────────────────────
describe('makeRequireOrchestrationEnabled middleware', () => {
  afterEach(() => { delete process.env.LB_ORCHESTRATION_ENABLED_TENANTS; });

  test('enabled tenant → next() called', async () => {
    process.env.LB_ORCHESTRATION_ENABLED_TENANTS = '+2';
    const { makeRequireOrchestrationEnabled } = freshModule();
    const mw = makeRequireOrchestrationEnabled({ supabase: makeStore() });
    let nextCalled = false;
    await mw({ user: { userId: 2 } }, mockRes(), () => { nextCalled = true; });
    expect(nextCalled).toBe(true);
  });

  test('not-enabled tenant → 403 orchestration_not_enabled_for_tenant', async () => {
    const { makeRequireOrchestrationEnabled } = freshModule();
    const mw = makeRequireOrchestrationEnabled({ supabase: makeStore() });
    const res = mockRes();
    await mw({ user: { userId: 2 } }, res, () => { throw new Error('should not call next'); });
    expect(res._status).toBe(403);
    expect(res._body.error).toBe('orchestration_not_enabled_for_tenant');
  });

  test('DB error → 503 service_unavailable (NOT 403)', async () => {
    const { makeRequireOrchestrationEnabled } = freshModule();
    const store = makeStore({ failOn: 'communication_settings' });
    const mw = makeRequireOrchestrationEnabled({ supabase: store });
    const res = mockRes();
    await mw({ user: { userId: 2 } }, res, () => { throw new Error('next'); });
    expect(res._status).toBe(503);
    expect(res._body.error).toBe('service_unavailable');
  });

  test('factory rejects when supabase missing', () => {
    const { makeRequireOrchestrationEnabled } = freshModule();
    expect(() => makeRequireOrchestrationEnabled({})).toThrow(/supabase/);
  });
});

// ─────────────────────────────────────────────────────────────────
// Legacy sync API — must continue to work unchanged
// ─────────────────────────────────────────────────────────────────
describe('legacy sync API (kept for backward compat)', () => {
  afterEach(() => { delete process.env.LB_ORCHESTRATION_ENABLED_TENANTS; });

  test('isOrchestrationEnabledForTenant: empty env → false', () => {
    delete process.env.LB_ORCHESTRATION_ENABLED_TENANTS;
    const { isOrchestrationEnabledForTenant } = freshModule();
    expect(isOrchestrationEnabledForTenant(2)).toBe(false);
  });

  test('isOrchestrationEnabledForTenant: env "2,17" → both enabled', () => {
    process.env.LB_ORCHESTRATION_ENABLED_TENANTS = '2,17';
    const { isOrchestrationEnabledForTenant } = freshModule();
    expect(isOrchestrationEnabledForTenant(2)).toBe(true);
    expect(isOrchestrationEnabledForTenant(17)).toBe(true);
    expect(isOrchestrationEnabledForTenant(42)).toBe(false);
  });

  test('isOrchestrationEnabledForTenant: env "-2" disables tenant 2', () => {
    process.env.LB_ORCHESTRATION_ENABLED_TENANTS = '-2';
    const { isOrchestrationEnabledForTenant } = freshModule();
    expect(isOrchestrationEnabledForTenant(2)).toBe(false);
  });

  test('requireOrchestrationEnabled: 403 when disabled (sync)', () => {
    delete process.env.LB_ORCHESTRATION_ENABLED_TENANTS;
    const { requireOrchestrationEnabled } = freshModule();
    const res = mockRes();
    requireOrchestrationEnabled({ user: { userId: 2 } }, res, () => { throw new Error('should not call next') });
    expect(res._status).toBe(403);
    expect(res._body.error).toBe('orchestration_not_enabled_for_tenant');
  });

  test('requireOrchestrationEnabled: next when enabled via env', () => {
    process.env.LB_ORCHESTRATION_ENABLED_TENANTS = '2';
    const { requireOrchestrationEnabled } = freshModule();
    let nextCalled = false;
    requireOrchestrationEnabled({ user: { userId: 2 } }, {}, () => { nextCalled = true });
    expect(nextCalled).toBe(true);
  });
});
