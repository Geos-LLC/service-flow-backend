'use strict';

/**
 * lib/lb-orchestration-admin-router.js — S3B tenant-state routes.
 *
 * Verifies:
 *   POST /enable
 *     - admin auth + flag enforcement
 *     - 400 missing/invalid user_id
 *     - 400 no_active_credential (no mint yet)
 *     - 404 communication_settings_not_found (row absent)
 *     - 200 sets leadbridge_connected=true + lb_orchestration_enabled_at=now
 *     - leaves credential rows unchanged (does NOT mint)
 *     - does NOT mutate webhook fields
 *
 *   POST /disable
 *     - admin auth + flag enforcement
 *     - 400 missing/invalid user_id
 *     - 200 revokes both active + rotating credentials
 *     - 200 clears lb_orchestration_enabled_at + leadbridge_connected=false
 *     - audit trail: revoked rows REMAIN in lb_orchestration_credentials
 *     - does NOT clear webhook fields (those belong to S4 disconnect)
 *     - cross-tenant: disable user N never touches user M's rows
 *
 *   GET /tenant-status
 *     - admin auth + flag enforcement
 *     - 400 missing/invalid user_id
 *     - returns credentials / enablement / webhook blocks
 *     - never returns token_hash or plaintext token
 *     - rotating_in_grace reflects grace window correctly
 *     - env override visible
 */

process.env.SF_ORCH_SIGNING_KEY     = Buffer.alloc(32, 0xAB).toString('base64');
process.env.SF_ORCH_SIGNING_KEY_KID = 'sf_orch_test_kid';

const express = require('express');
const request = require('supertest');

const { makeAdminCredentialRouter } = require('../lib/lb-orchestration-admin-router');
const creds = require('../lib/lb-orchestration-credentials');

const TABLE = 'lb_orchestration_credentials';

// ─────────────────────────────────────────────────────────────────
// Store — same shape as S3A test, with communication_settings support.
// ─────────────────────────────────────────────────────────────────
function makeStore({ settings = [] } = {}) {
  const rows = [];          // lb_orchestration_credentials
  const cs = settings;      // communication_settings
  let nextId = 1;
  const writeLog = [];

  function applyFilters(rs, filters) {
    return rs.filter((r) => {
      for (const f of filters) {
        if (f.type === 'eq' && String(r[f.col]) !== String(f.val)) return false;
        if (f.type === 'in' && !f.vals.map(String).includes(String(r[f.col]))) return false;
        if (f.type === 'lte') {
          const lhs = r[f.col] ? Date.parse(r[f.col]) : null;
          const rhs = Date.parse(f.val);
          if (lhs == null || !(lhs <= rhs)) return false;
        }
      }
      return true;
    });
  }

  function makeBuilder(table) {
    const state = { table, op: null, payload: null, filters: [], selectCols: null };
    const builder = {
      _state: state,
      insert(r) { state.op = 'insert'; state.payload = r; return builder; },
      update(p) { state.op = 'update'; state.payload = p; return builder; },
      select(c) { state.selectCols = c || '*'; if (!state.op) state.op = 'select'; return builder; },
      eq(c, v)  { state.filters.push({ type: 'eq', col: c, val: v }); return builder; },
      in(c, v)  { state.filters.push({ type: 'in', col: c, vals: v }); return builder; },
      lte(c, v) { state.filters.push({ type: 'lte', col: c, val: v }); return builder; },
      maybeSingle() { return exec(state).then(maybeSingle); },
      single()      { return exec(state).then(single); },
      then(onF, onR){ return exec(state).then(onF, onR); },
    };
    return builder;
  }

  function exec(state) {
    return new Promise((resolve) => {
      writeLog.push({
        op: state.op, table: state.table,
        payload: state.payload ? JSON.parse(JSON.stringify(state.payload)) : null,
        filters: state.filters.slice(),
      });

      // communication_settings handling
      if (state.table === 'communication_settings') {
        const userIdFilter = state.filters.find((f) => f.col === 'user_id');
        if (state.op === 'select' || state.op == null) {
          const row = cs.find((s) => s.user_id === userIdFilter?.val);
          return resolve({ data: row ? { ...row } : null, error: null });
        }
        if (state.op === 'update') {
          const matched = cs.filter((s) => s.user_id === userIdFilter?.val);
          for (const r of matched) Object.assign(r, state.payload);
          if (state.selectCols) return resolve({ data: matched.map((r) => ({ ...r }))[0] || null, error: null });
          return resolve({ data: null, error: null });
        }
        return resolve({ data: null, error: null });
      }

      // lb_orchestration_credentials handling
      if (state.table !== TABLE) {
        return resolve({ data: null, error: null });
      }
      if (state.op === 'insert') {
        if (state.payload.status === 'active') {
          const collision = rows.find((r) => r.user_id === state.payload.user_id && r.status === 'active');
          if (collision) return resolve({ data: null, error: { code: '23505', message: 'duplicate' } });
        }
        const newRow = { id: nextId++, ...state.payload };
        rows.push(newRow);
        if (state.selectCols) return resolve({ data: { id: newRow.id }, error: null });
        return resolve({ data: null, error: null });
      }
      if (state.op === 'update') {
        const matched = applyFilters(rows, state.filters);
        for (const r of matched) Object.assign(r, state.payload);
        if (state.selectCols) return resolve({ data: matched.map((r) => ({ ...r })), error: null });
        return resolve({ data: null, error: null });
      }
      const matched = applyFilters(rows, state.filters);
      return resolve({ data: matched.map((r) => ({ ...r })), error: null });
    });
  }

  function single({ data, error }) {
    if (error) return { data: null, error };
    if (Array.isArray(data)) return data.length === 0
      ? { data: null, error: { code: 'PGRST116' } }
      : { data: data[0], error: null };
    return { data, error: null };
  }
  function maybeSingle({ data, error }) {
    if (error) return { data: null, error };
    if (Array.isArray(data)) return { data: data[0] || null, error: null };
    return { data: data || null, error: null };
  }

  return {
    _rows: rows,
    _cs: cs,
    _writeLog: writeLog,
    from(t) { return makeBuilder(t); },
  };
}

function makeAdminAuth({ allow = true } = {}) {
  return function authenticateAdmin(req, res, next) {
    if (!allow) return res.status(403).json({ error: 'Invalid admin token' });
    if (!req.headers['authorization']) return res.status(401).json({ error: 'Admin token required' });
    req.admin = { email: 'admin@test' };
    next();
  };
}

function makeFlagGate({ flagOn }) {
  return function requireAdminFlag(_flagName) {
    return function gate(req, res, next) {
      if (!flagOn) return res.status(403).json({ error: 'admin_endpoint_disabled', flag: _flagName });
      next();
    };
  };
}

function buildApp({ store, allowAdmin = true, flagOn = true, logger } = {}) {
  const app = express();
  app.use(express.json());
  app.use('/api/internal/lb-orchestration', makeAdminCredentialRouter({
    supabase: store, logger,
    authenticateAdmin: makeAdminAuth({ allow: allowAdmin }),
    requireAdminFlag:  makeFlagGate({ flagOn }),
  }));
  return app;
}

const ADMIN = { Authorization: 'Bearer fake.admin' };

// ─────────────────────────────────────────────────────────────────
// /enable
// ─────────────────────────────────────────────────────────────────
describe('POST /enable', () => {
  test('missing auth → 401', async () => {
    const app = buildApp({ store: makeStore() });
    const r = await request(app).post('/api/internal/lb-orchestration/enable').send({ user_id: 2 });
    expect(r.status).toBe(401);
  });

  test('flag off → 403', async () => {
    const app = buildApp({ store: makeStore(), flagOn: false });
    const r = await request(app).post('/api/internal/lb-orchestration/enable').set(ADMIN).send({ user_id: 2 });
    expect(r.status).toBe(403);
  });

  test('validation: missing user_id → 400', async () => {
    const app = buildApp({ store: makeStore() });
    const r = await request(app).post('/api/internal/lb-orchestration/enable').set(ADMIN).send({});
    expect(r.status).toBe(400);
  });

  test('validation: user_id=0 → 400', async () => {
    const app = buildApp({ store: makeStore() });
    const r = await request(app).post('/api/internal/lb-orchestration/enable').set(ADMIN).send({ user_id: 0 });
    expect(r.status).toBe(400);
  });

  test('no active credential → 400 no_active_credential', async () => {
    const store = makeStore({ settings: [{ user_id: 2 }] });
    const app = buildApp({ store });
    const r = await request(app).post('/api/internal/lb-orchestration/enable').set(ADMIN).send({ user_id: 2 });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('no_active_credential');
  });

  test('communication_settings row absent → 404 communication_settings_not_found', async () => {
    const store = makeStore();
    const app = buildApp({ store });
    // Mint a credential for tenant 7 — but no settings row exists.
    await creds.mintCredential(store, { userId: 7 });
    const r = await request(app).post('/api/internal/lb-orchestration/enable').set(ADMIN).send({ user_id: 7 });
    expect(r.status).toBe(404);
    expect(r.body.error).toBe('communication_settings_not_found');
  });

  test('happy path: sets leadbridge_connected=true + lb_orchestration_enabled_at', async () => {
    const store = makeStore({ settings: [{ user_id: 2, leadbridge_connected: false, lb_orchestration_enabled_at: null }] });
    const app = buildApp({ store });
    await creds.mintCredential(store, { userId: 2 });
    const r = await request(app).post('/api/internal/lb-orchestration/enable').set(ADMIN).send({ user_id: 2 });
    expect(r.status).toBe(200);
    expect(r.body.user_id).toBe(2);
    expect(r.body.leadbridge_connected).toBe(true);
    expect(r.body.lb_orchestration_enabled_at).toBeTruthy();
    expect(r.body.active_credential_count).toBe(1);

    const setting = store._cs.find((s) => s.user_id === 2);
    expect(setting.leadbridge_connected).toBe(true);
    expect(setting.lb_orchestration_enabled_at).toBeTruthy();
  });

  test('does NOT mint a credential', async () => {
    const store = makeStore({ settings: [{ user_id: 2 }] });
    const app = buildApp({ store });
    await creds.mintCredential(store, { userId: 2 });
    const credCountBefore = store._rows.length;
    await request(app).post('/api/internal/lb-orchestration/enable').set(ADMIN).send({ user_id: 2 });
    expect(store._rows.length).toBe(credCountBefore);
  });

  test('does NOT mutate webhook fields', async () => {
    const store = makeStore({
      settings: [{
        user_id: 2,
        lb_orchestration_webhook_url: 'https://existing.example.com/hook',
        lb_orchestration_webhook_secret_enc: 'existing_enc',
        lb_orchestration_webhook_set_at: '2026-01-01T00:00:00Z',
      }],
    });
    const app = buildApp({ store });
    await creds.mintCredential(store, { userId: 2 });
    await request(app).post('/api/internal/lb-orchestration/enable').set(ADMIN).send({ user_id: 2 });
    const setting = store._cs.find((s) => s.user_id === 2);
    expect(setting.lb_orchestration_webhook_url).toBe('https://existing.example.com/hook');
    expect(setting.lb_orchestration_webhook_secret_enc).toBe('existing_enc');
    expect(setting.lb_orchestration_webhook_set_at).toBe('2026-01-01T00:00:00Z');
  });
});

// ─────────────────────────────────────────────────────────────────
// /disable
// ─────────────────────────────────────────────────────────────────
describe('POST /disable', () => {
  test('missing auth → 401', async () => {
    const app = buildApp({ store: makeStore() });
    const r = await request(app).post('/api/internal/lb-orchestration/disable').send({ user_id: 2 });
    expect(r.status).toBe(401);
  });

  test('flag off → 403', async () => {
    const app = buildApp({ store: makeStore(), flagOn: false });
    const r = await request(app).post('/api/internal/lb-orchestration/disable').set(ADMIN).send({ user_id: 2 });
    expect(r.status).toBe(403);
  });

  test('validation: missing user_id → 400', async () => {
    const app = buildApp({ store: makeStore() });
    const r = await request(app).post('/api/internal/lb-orchestration/disable').set(ADMIN).send({});
    expect(r.status).toBe(400);
  });

  test('happy path: revokes active + rotating + clears enablement', async () => {
    const store = makeStore({
      settings: [{ user_id: 2, leadbridge_connected: true, lb_orchestration_enabled_at: '2026-05-27T00:00:00Z' }],
    });
    const app = buildApp({ store });
    await creds.mintCredential(store, { userId: 2 });
    await creds.rotateCredential(store, { userId: 2 });
    expect(store._rows.filter((r) => r.status === 'active')).toHaveLength(1);
    expect(store._rows.filter((r) => r.status === 'rotating')).toHaveLength(1);

    const r = await request(app).post('/api/internal/lb-orchestration/disable').set(ADMIN).send({ user_id: 2, reason: 'test' });
    expect(r.status).toBe(200);
    expect(r.body.revoked_count).toBe(2);
    expect(r.body.leadbridge_connected).toBe(false);
    expect(r.body.lb_orchestration_enabled_at).toBeNull();

    // Settings updated
    const setting = store._cs.find((s) => s.user_id === 2);
    expect(setting.leadbridge_connected).toBe(false);
    expect(setting.lb_orchestration_enabled_at).toBeNull();

    // All cred rows revoked
    expect(store._rows.every((r) => r.status === 'revoked')).toBe(true);
    expect(store._rows.every((r) => r.revoked_reason === 'test')).toBe(true);
  });

  test('audit trail preserved: revoked rows remain in lb_orchestration_credentials', async () => {
    const store = makeStore({ settings: [{ user_id: 2 }] });
    const app = buildApp({ store });
    await creds.mintCredential(store, { userId: 2 });
    const idsBefore = store._rows.map((r) => r.id);
    await request(app).post('/api/internal/lb-orchestration/disable').set(ADMIN).send({ user_id: 2 });
    const idsAfter = store._rows.map((r) => r.id);
    expect(idsAfter).toEqual(idsBefore);
    expect(store._rows.length).toBeGreaterThan(0);
  });

  test('does NOT clear webhook fields (those belong to S4 disconnect)', async () => {
    const store = makeStore({
      settings: [{
        user_id: 2,
        leadbridge_connected: true,
        lb_orchestration_enabled_at: '2026-05-27T00:00:00Z',
        lb_orchestration_webhook_url: 'https://lb.example.com/hook',
        lb_orchestration_webhook_secret_enc: 'enc',
        lb_orchestration_webhook_set_at: '2026-05-27T00:00:00Z',
      }],
    });
    const app = buildApp({ store });
    await creds.mintCredential(store, { userId: 2 });
    await request(app).post('/api/internal/lb-orchestration/disable').set(ADMIN).send({ user_id: 2 });
    const setting = store._cs.find((s) => s.user_id === 2);
    expect(setting.lb_orchestration_webhook_url).toBe('https://lb.example.com/hook');
    expect(setting.lb_orchestration_webhook_secret_enc).toBe('enc');
    expect(setting.lb_orchestration_webhook_set_at).toBe('2026-05-27T00:00:00Z');
  });

  test('cross-tenant: disable for user 2 leaves user 9 untouched', async () => {
    const store = makeStore({
      settings: [
        { user_id: 2, leadbridge_connected: true, lb_orchestration_enabled_at: '2026-05-27T00:00:00Z' },
        { user_id: 9, leadbridge_connected: true, lb_orchestration_enabled_at: '2026-05-27T00:00:00Z' },
      ],
    });
    const app = buildApp({ store });
    await creds.mintCredential(store, { userId: 2 });
    await creds.mintCredential(store, { userId: 9 });

    await request(app).post('/api/internal/lb-orchestration/disable').set(ADMIN).send({ user_id: 2 });

    const u2cred = store._rows.find((r) => r.user_id === 2);
    const u9cred = store._rows.find((r) => r.user_id === 9);
    expect(u2cred.status).toBe('revoked');
    expect(u9cred.status).toBe('active');

    const u2s = store._cs.find((s) => s.user_id === 2);
    const u9s = store._cs.find((s) => s.user_id === 9);
    expect(u2s.leadbridge_connected).toBe(false);
    expect(u9s.leadbridge_connected).toBe(true);
  });

  test('disable with nothing to revoke + no settings row → still 200 (idempotent close)', async () => {
    const store = makeStore();   // no creds, no settings
    const app = buildApp({ store });
    const r = await request(app).post('/api/internal/lb-orchestration/disable').set(ADMIN).send({ user_id: 7 });
    expect(r.status).toBe(200);
    expect(r.body.revoked_count).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────
// /tenant-status
// ─────────────────────────────────────────────────────────────────
describe('GET /tenant-status', () => {
  afterEach(() => { delete process.env.LB_ORCHESTRATION_ENABLED_TENANTS; });

  test('missing auth → 401', async () => {
    const app = buildApp({ store: makeStore() });
    const r = await request(app).get('/api/internal/lb-orchestration/tenant-status?user_id=2');
    expect(r.status).toBe(401);
  });

  test('flag off → 403', async () => {
    const app = buildApp({ store: makeStore(), flagOn: false });
    const r = await request(app).get('/api/internal/lb-orchestration/tenant-status?user_id=2').set(ADMIN);
    expect(r.status).toBe(403);
  });

  test('validation: missing user_id → 400', async () => {
    const app = buildApp({ store: makeStore() });
    const r = await request(app).get('/api/internal/lb-orchestration/tenant-status').set(ADMIN);
    expect(r.status).toBe(400);
  });

  test('returns full snapshot when nothing exists', async () => {
    const app = buildApp({ store: makeStore() });
    const r = await request(app).get('/api/internal/lb-orchestration/tenant-status?user_id=2').set(ADMIN);
    expect(r.status).toBe(200);
    expect(r.body.user_id).toBe(2);
    expect(r.body.credentials.active).toBeNull();
    expect(r.body.credentials.rotating).toBeNull();
    expect(r.body.credentials.total_count).toBe(0);
    expect(r.body.enablement.effective).toBe(false);
    expect(r.body.webhook.configured).toBe(false);
  });

  test('reflects active credential + enabled state', async () => {
    const store = makeStore({
      settings: [{ user_id: 2, leadbridge_connected: true, lb_orchestration_enabled_at: '2026-05-27T00:00:00Z' }],
    });
    const app = buildApp({ store });
    await creds.mintCredential(store, { userId: 2 });
    const r = await request(app).get('/api/internal/lb-orchestration/tenant-status?user_id=2').set(ADMIN);
    expect(r.status).toBe(200);
    expect(r.body.credentials.active).not.toBeNull();
    expect(r.body.credentials.active.status).toBe('active');
    expect(r.body.enablement.connection_state_enabled).toBe(true);
    expect(r.body.enablement.effective).toBe(true);
  });

  test('rotating_in_grace = true when grace_expires_at > now', async () => {
    const store = makeStore({
      settings: [{ user_id: 2, leadbridge_connected: true, lb_orchestration_enabled_at: '2026-05-27T00:00:00Z' }],
    });
    const app = buildApp({ store });
    await creds.mintCredential(store, { userId: 2 });
    await creds.rotateCredential(store, { userId: 2 });
    const r = await request(app).get('/api/internal/lb-orchestration/tenant-status?user_id=2').set(ADMIN);
    expect(r.status).toBe(200);
    expect(r.body.credentials.rotating).not.toBeNull();
    expect(r.body.credentials.rotating_in_grace).toBe(true);
  });

  test('rotating_in_grace = false when grace_expires_at passed', async () => {
    const store = makeStore({
      settings: [{ user_id: 2, leadbridge_connected: true, lb_orchestration_enabled_at: '2026-05-27T00:00:00Z' }],
    });
    const app = buildApp({ store });
    await creds.mintCredential(store, { userId: 2 });
    await creds.rotateCredential(store, { userId: 2 });
    const rotating = store._rows.find((r) => r.status === 'rotating');
    rotating.grace_expires_at = new Date(Date.now() - 60_000).toISOString();
    const r = await request(app).get('/api/internal/lb-orchestration/tenant-status?user_id=2').set(ADMIN);
    expect(r.body.credentials.rotating_in_grace).toBe(false);
  });

  test('env override visible + effective', async () => {
    process.env.LB_ORCHESTRATION_ENABLED_TENANTS = '+2';
    const store = makeStore();
    const app = buildApp({ store });
    const r = await request(app).get('/api/internal/lb-orchestration/tenant-status?user_id=2').set(ADMIN);
    expect(r.body.enablement.env_override).toBe(true);
    expect(r.body.enablement.effective).toBe(true);
  });

  test('env negative override overrides DB-enabled state', async () => {
    process.env.LB_ORCHESTRATION_ENABLED_TENANTS = '-2';
    const store = makeStore({
      settings: [{ user_id: 2, leadbridge_connected: true, lb_orchestration_enabled_at: '2026-05-27T00:00:00Z' }],
    });
    const app = buildApp({ store });
    await creds.mintCredential(store, { userId: 2 });
    const r = await request(app).get('/api/internal/lb-orchestration/tenant-status?user_id=2').set(ADMIN);
    expect(r.body.enablement.env_negative_override).toBe(true);
    expect(r.body.enablement.effective).toBe(false);
  });

  test('never returns token_hash or plaintext token', async () => {
    const store = makeStore({ settings: [{ user_id: 2, leadbridge_connected: true, lb_orchestration_enabled_at: '2026-05-27T00:00:00Z' }] });
    const app = buildApp({ store });
    const m = await creds.mintCredential(store, { userId: 2 });
    const r = await request(app).get('/api/internal/lb-orchestration/tenant-status?user_id=2').set(ADMIN);
    const body = JSON.stringify(r.body);
    expect(body).not.toMatch(/token_hash/);
    expect(body).not.toContain(m.token);
  });

  test('webhook.configured reflects DB state', async () => {
    const store = makeStore({
      settings: [{
        user_id: 2,
        lb_orchestration_webhook_url: 'https://lb.example.com/h',
        lb_orchestration_webhook_set_at: '2026-05-27T00:00:00Z',
      }],
    });
    const app = buildApp({ store });
    const r = await request(app).get('/api/internal/lb-orchestration/tenant-status?user_id=2').set(ADMIN);
    expect(r.body.webhook.configured).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────
// Full enable/disable lifecycle
// ─────────────────────────────────────────────────────────────────
describe('full lifecycle: mint → enable → disable', () => {
  test('end-to-end state transitions', async () => {
    const store = makeStore({ settings: [{ user_id: 2 }] });
    const app = buildApp({ store });
    const logs = [];
    // Note: this app uses its own injected logger inside the factory.

    // 1. mint
    const mint = await request(app).post('/api/internal/lb-orchestration/credentials/mint').set(ADMIN).send({ user_id: 2 });
    expect(mint.status).toBe(200);

    // 2. status before enable: effective=false
    let st = await request(app).get('/api/internal/lb-orchestration/tenant-status?user_id=2').set(ADMIN);
    expect(st.body.enablement.effective).toBe(false);

    // 3. enable
    const en = await request(app).post('/api/internal/lb-orchestration/enable').set(ADMIN).send({ user_id: 2 });
    expect(en.status).toBe(200);

    // 4. status after enable: effective=true via connection_state
    st = await request(app).get('/api/internal/lb-orchestration/tenant-status?user_id=2').set(ADMIN);
    expect(st.body.enablement.effective).toBe(true);
    expect(st.body.enablement.connection_state_enabled).toBe(true);

    // 5. disable
    const dis = await request(app).post('/api/internal/lb-orchestration/disable').set(ADMIN).send({ user_id: 2 });
    expect(dis.status).toBe(200);
    expect(dis.body.revoked_count).toBe(1);

    // 6. status after disable: effective=false; credentials revoked; settings cleared
    st = await request(app).get('/api/internal/lb-orchestration/tenant-status?user_id=2').set(ADMIN);
    expect(st.body.enablement.effective).toBe(false);
    expect(st.body.credentials.active).toBeNull();
    expect(st.body.credentials.revoked_count).toBe(1);
    expect(st.body.enablement.leadbridge_connected).toBe(false);
    expect(st.body.enablement.lb_orchestration_enabled_at).toBeNull();
  });

  test('plaintext token never appears in any /tenant-status or /enable or /disable payload', async () => {
    const store = makeStore({ settings: [{ user_id: 2 }] });
    const app = buildApp({ store });
    const m = await request(app).post('/api/internal/lb-orchestration/credentials/mint').set(ADMIN).send({ user_id: 2 });
    const en = await request(app).post('/api/internal/lb-orchestration/enable').set(ADMIN).send({ user_id: 2 });
    const st = await request(app).get('/api/internal/lb-orchestration/tenant-status?user_id=2').set(ADMIN);
    const dis = await request(app).post('/api/internal/lb-orchestration/disable').set(ADMIN).send({ user_id: 2 });
    const allOther = JSON.stringify(en.body) + JSON.stringify(st.body) + JSON.stringify(dis.body);
    expect(allOther).not.toContain(m.body.token);
  });
});
