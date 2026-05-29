'use strict';

/**
 * lib/lb-orchestration-admin-router.js (S3A).
 *
 * Verifies:
 *   - factory rejects without supabase / authenticateAdmin / requireAdminFlag
 *   - all 4 endpoints require admin auth
 *   - all 4 endpoints require ENABLE_ADMIN_ORCH_CREDENTIALS flag
 *   - mint happy path returns plaintext token ONCE + writes row
 *   - mint validation (missing user_id, negative, non-integer)
 *   - mint conflict (active already exists) → 409
 *   - mint without signing key → 503
 *   - rotate happy path: old→rotating + new→active
 *   - rotate with no active → 404
 *   - revoke happy path: both active + rotating → revoked
 *   - revoke leaves other tenants untouched (cross-tenant isolation)
 *   - status returns active/rotating/webhook/enablement shape
 *   - status never returns token_hash
 *   - plaintext token never appears in logger output
 *   - validation: rejects user_id=0, negative, non-integer
 */

process.env.SF_ORCH_SIGNING_KEY     = Buffer.alloc(32, 0xAB).toString('base64');
process.env.SF_ORCH_SIGNING_KEY_KID = 'sf_orch_test_kid';

const express = require('express');
const request = require('supertest');

const { makeAdminCredentialRouter } = require('../lib/lb-orchestration-admin-router');
const creds = require('../lib/lb-orchestration-credentials');

const TABLE = 'lb_orchestration_credentials';

// ─────────────────────────────────────────────────────────────────
// In-memory store, sufficient for the admin endpoints.
// Handles `from(table).insert/update/select/eq/in/maybeSingle/single`.
// ─────────────────────────────────────────────────────────────────
function makeStore({ settings = [] } = {}) {
  const rows = [];
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
      if (state.table === 'communication_settings') {
        if (state.op === 'select' || state.op == null) {
          const userIdFilter = state.filters.find((f) => f.col === 'user_id');
          const row = settings.find((s) => s.user_id === userIdFilter?.val);
          return resolve({ data: row ? { ...row } : null, error: null });
        }
        return resolve({ data: null, error: null });
      }
      if (state.table !== TABLE) {
        return resolve({ data: null, error: null });
      }
      if (state.op === 'insert') {
        if (state.payload.status === 'active') {
          const collision = rows.find((r) => r.user_id === state.payload.user_id && r.status === 'active');
          if (collision) return resolve({ data: null, error: { code: '23505', message: 'duplicate key' } });
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
    _writeLog: writeLog,
    from(t) { return makeBuilder(t); },
  };
}

// ─────────────────────────────────────────────────────────────────
// Stub admin auth + flag gate
// ─────────────────────────────────────────────────────────────────
function makeAdminAuth({ allow = true } = {}) {
  return function authenticateAdmin(req, res, next) {
    if (!allow) return res.status(403).json({ error: 'Invalid admin token' });
    if (!req.headers['authorization']) return res.status(401).json({ error: 'Admin token required' });
    req.admin = { email: 'admin@example.com' };
    next();
  };
}

function makeFlagGate({ flagOn }) {
  return function requireAdminFlag(_flagName) {
    return function flagGate(req, res, next) {
      if (!flagOn) return res.status(403).json({ error: 'admin_endpoint_disabled', flag: _flagName });
      next();
    };
  };
}

function buildApp({ store, allowAdmin = true, flagOn = true, logger } = {}) {
  const app = express();
  app.use(express.json());
  const router = makeAdminCredentialRouter({
    supabase: store,
    logger,
    authenticateAdmin: makeAdminAuth({ allow: allowAdmin }),
    requireAdminFlag:  makeFlagGate({ flagOn }),
  });
  app.use('/api/internal/lb-orchestration', router);
  return app;
}

const ADMIN_HEADERS = { Authorization: 'Bearer fake.admin.jwt' };

// ─────────────────────────────────────────────────────────────────
// Factory guards
// ─────────────────────────────────────────────────────────────────
describe('factory guards', () => {
  test('rejects without supabase', () => {
    expect(() => makeAdminCredentialRouter({
      authenticateAdmin: () => {},
      requireAdminFlag: () => () => {},
    })).toThrow(/supabase/);
  });
  test('rejects without authenticateAdmin', () => {
    expect(() => makeAdminCredentialRouter({
      supabase: makeStore(),
      requireAdminFlag: () => () => {},
    })).toThrow(/authenticateAdmin/);
  });
  test('rejects without requireAdminFlag', () => {
    expect(() => makeAdminCredentialRouter({
      supabase: makeStore(),
      authenticateAdmin: () => {},
    })).toThrow(/requireAdminFlag/);
  });
});

// ─────────────────────────────────────────────────────────────────
// Admin auth + flag gate enforcement (all 4 endpoints)
// ─────────────────────────────────────────────────────────────────
describe('admin auth + flag gate', () => {
  test('mint: missing auth header → 401', async () => {
    const app = buildApp({ store: makeStore() });
    const r = await request(app).post('/api/internal/lb-orchestration/credentials/mint').send({ user_id: 2 });
    expect(r.status).toBe(401);
  });

  test('mint: flag off → 403 admin_endpoint_disabled', async () => {
    const app = buildApp({ store: makeStore(), flagOn: false });
    const r = await request(app).post('/api/internal/lb-orchestration/credentials/mint')
      .set(ADMIN_HEADERS).send({ user_id: 2 });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('admin_endpoint_disabled');
  });

  test('rotate: missing auth → 401', async () => {
    const app = buildApp({ store: makeStore() });
    const r = await request(app).post('/api/internal/lb-orchestration/credentials/rotate').send({ user_id: 2 });
    expect(r.status).toBe(401);
  });

  test('rotate: flag off → 403', async () => {
    const app = buildApp({ store: makeStore(), flagOn: false });
    const r = await request(app).post('/api/internal/lb-orchestration/credentials/rotate').set(ADMIN_HEADERS).send({ user_id: 2 });
    expect(r.status).toBe(403);
  });

  test('revoke: missing auth → 401', async () => {
    const app = buildApp({ store: makeStore() });
    const r = await request(app).post('/api/internal/lb-orchestration/credentials/revoke').send({ user_id: 2 });
    expect(r.status).toBe(401);
  });

  test('revoke: flag off → 403', async () => {
    const app = buildApp({ store: makeStore(), flagOn: false });
    const r = await request(app).post('/api/internal/lb-orchestration/credentials/revoke').set(ADMIN_HEADERS).send({ user_id: 2 });
    expect(r.status).toBe(403);
  });

  test('status: missing auth → 401', async () => {
    const app = buildApp({ store: makeStore() });
    const r = await request(app).get('/api/internal/lb-orchestration/credentials/status?user_id=2');
    expect(r.status).toBe(401);
  });

  test('status: flag off → 403', async () => {
    const app = buildApp({ store: makeStore(), flagOn: false });
    const r = await request(app).get('/api/internal/lb-orchestration/credentials/status?user_id=2').set(ADMIN_HEADERS);
    expect(r.status).toBe(403);
  });
});

// ─────────────────────────────────────────────────────────────────
// POST /credentials/mint
// ─────────────────────────────────────────────────────────────────
describe('POST /credentials/mint', () => {
  test('happy path: 200 + plaintext token + writes active row', async () => {
    const store = makeStore();
    const app = buildApp({ store });
    const r = await request(app).post('/api/internal/lb-orchestration/credentials/mint')
      .set(ADMIN_HEADERS).send({ user_id: 99999 });
    expect(r.status).toBe(200);
    expect(r.body.token).toMatch(/^sfo_v1\./);
    expect(r.body.credential_id).toEqual(expect.any(Number));
    expect(r.body.token_prefix).toBe(r.body.token.slice(0, 13));
    expect(r.body.kid).toBe('sf_orch_test_kid');
    expect(r.body.scope).toBe('lb_orchestration');
    expect(store._rows).toHaveLength(1);
    expect(store._rows[0].status).toBe('active');
    expect(store._rows[0].user_id).toBe(99999);
    expect(store._rows[0].token_hash).not.toBe(r.body.token);    // hashed, not plaintext
  });

  test('returns token plaintext only in response (never in store payloads)', async () => {
    const store = makeStore();
    const app = buildApp({ store });
    const r = await request(app).post('/api/internal/lb-orchestration/credentials/mint')
      .set(ADMIN_HEADERS).send({ user_id: 99999 });
    expect(r.status).toBe(200);
    const allWrites = JSON.stringify(store._writeLog);
    expect(allWrites).not.toContain(r.body.token);
  });

  test('logger never receives plaintext token', async () => {
    const store = makeStore();
    const logs = [];
    const logger = {
      log:   (m) => logs.push(['log', m]),
      warn:  (m) => logs.push(['warn', m]),
      error: (m) => logs.push(['error', m]),
      debug: (m) => logs.push(['debug', m]),
    };
    const app = buildApp({ store, logger });
    const r = await request(app).post('/api/internal/lb-orchestration/credentials/mint')
      .set(ADMIN_HEADERS).send({ user_id: 99999 });
    expect(r.status).toBe(200);
    const allLogs = JSON.stringify(logs);
    expect(allLogs).not.toContain(r.body.token);
    // prefix IS allowed (truncated, safe)
    expect(allLogs).toContain(r.body.token_prefix);
  });

  test('conflict: active already exists → 409', async () => {
    const store = makeStore();
    const app = buildApp({ store });
    const r1 = await request(app).post('/api/internal/lb-orchestration/credentials/mint').set(ADMIN_HEADERS).send({ user_id: 2 });
    expect(r1.status).toBe(200);
    const r2 = await request(app).post('/api/internal/lb-orchestration/credentials/mint').set(ADMIN_HEADERS).send({ user_id: 2 });
    expect(r2.status).toBe(409);
    expect(r2.body.error).toBe('active_credential_already_exists');
  });

  test('validation: missing user_id → 400', async () => {
    const app = buildApp({ store: makeStore() });
    const r = await request(app).post('/api/internal/lb-orchestration/credentials/mint').set(ADMIN_HEADERS).send({});
    expect(r.status).toBe(400);
  });

  test('validation: user_id = 0 → 400', async () => {
    const app = buildApp({ store: makeStore() });
    const r = await request(app).post('/api/internal/lb-orchestration/credentials/mint').set(ADMIN_HEADERS).send({ user_id: 0 });
    expect(r.status).toBe(400);
  });

  test('validation: user_id negative → 400', async () => {
    const app = buildApp({ store: makeStore() });
    const r = await request(app).post('/api/internal/lb-orchestration/credentials/mint').set(ADMIN_HEADERS).send({ user_id: -1 });
    expect(r.status).toBe(400);
  });

  test('validation: user_id non-integer → 400', async () => {
    const app = buildApp({ store: makeStore() });
    const r = await request(app).post('/api/internal/lb-orchestration/credentials/mint').set(ADMIN_HEADERS).send({ user_id: 1.5 });
    expect(r.status).toBe(400);
  });

  test('signing key not configured → 503', async () => {
    const store = makeStore();
    const app = buildApp({ store });
    // Use an unrecognized kid so resolveSigningKey returns null.
    const r = await request(app).post('/api/internal/lb-orchestration/credentials/mint')
      .set(ADMIN_HEADERS).send({ user_id: 99999, kid: 'never_set_kid' });
    expect(r.status).toBe(503);
    expect(r.body.error).toBe('signing_key_not_configured');
  });
});

// ─────────────────────────────────────────────────────────────────
// POST /credentials/rotate
// ─────────────────────────────────────────────────────────────────
describe('POST /credentials/rotate', () => {
  test('happy path: old→rotating + new→active', async () => {
    const store = makeStore();
    const app = buildApp({ store });
    const m = await request(app).post('/api/internal/lb-orchestration/credentials/mint').set(ADMIN_HEADERS).send({ user_id: 2 });
    expect(m.status).toBe(200);

    const r = await request(app).post('/api/internal/lb-orchestration/credentials/rotate').set(ADMIN_HEADERS).send({ user_id: 2 });
    expect(r.status).toBe(200);
    expect(r.body.token).toMatch(/^sfo_v1\./);
    expect(r.body.token).not.toBe(m.body.token);
    expect(r.body.previous_credential_id).toBe(m.body.credential_id);
    expect(r.body.previous_grace_expires_at).toMatch(/T/);

    const active   = store._rows.filter((x) => x.status === 'active');
    const rotating = store._rows.filter((x) => x.status === 'rotating');
    expect(active).toHaveLength(1);
    expect(rotating).toHaveLength(1);
    expect(active[0].rotated_from_id).toBe(rotating[0].id);
  });

  test('rotate with no active → 404', async () => {
    const app = buildApp({ store: makeStore() });
    const r = await request(app).post('/api/internal/lb-orchestration/credentials/rotate').set(ADMIN_HEADERS).send({ user_id: 88888 });
    expect(r.status).toBe(404);
    expect(r.body.error).toBe('no_active_credential');
  });

  test('rotate validation: missing user_id → 400', async () => {
    const app = buildApp({ store: makeStore() });
    const r = await request(app).post('/api/internal/lb-orchestration/credentials/rotate').set(ADMIN_HEADERS).send({});
    expect(r.status).toBe(400);
  });

  test('rotate response never echoes the old token plaintext', async () => {
    const store = makeStore();
    const app = buildApp({ store });
    const m = await request(app).post('/api/internal/lb-orchestration/credentials/mint').set(ADMIN_HEADERS).send({ user_id: 2 });
    const r = await request(app).post('/api/internal/lb-orchestration/credentials/rotate').set(ADMIN_HEADERS).send({ user_id: 2 });
    const body = JSON.stringify(r.body);
    expect(body).not.toContain(m.body.token);
  });
});

// ─────────────────────────────────────────────────────────────────
// POST /credentials/revoke
// ─────────────────────────────────────────────────────────────────
describe('POST /credentials/revoke', () => {
  test('happy path: revokes both active + rotating atomically', async () => {
    const store = makeStore();
    const app = buildApp({ store });
    await request(app).post('/api/internal/lb-orchestration/credentials/mint').set(ADMIN_HEADERS).send({ user_id: 2 });
    await request(app).post('/api/internal/lb-orchestration/credentials/rotate').set(ADMIN_HEADERS).send({ user_id: 2 });
    expect(store._rows.filter((x) => x.status === 'active')).toHaveLength(1);
    expect(store._rows.filter((x) => x.status === 'rotating')).toHaveLength(1);

    const r = await request(app).post('/api/internal/lb-orchestration/credentials/revoke').set(ADMIN_HEADERS).send({ user_id: 2, reason: 'test' });
    expect(r.status).toBe(200);
    expect(r.body.revoked_count).toBe(2);
    expect(r.body.revoked_ids).toHaveLength(2);

    expect(store._rows.every((x) => x.status === 'revoked')).toBe(true);
    expect(store._rows.every((x) => x.revoked_reason === 'test')).toBe(true);
  });

  test('cross-tenant: revoke for user 2 leaves user 9 untouched', async () => {
    const store = makeStore();
    const app = buildApp({ store });
    await request(app).post('/api/internal/lb-orchestration/credentials/mint').set(ADMIN_HEADERS).send({ user_id: 2 });
    await request(app).post('/api/internal/lb-orchestration/credentials/mint').set(ADMIN_HEADERS).send({ user_id: 9 });

    await request(app).post('/api/internal/lb-orchestration/credentials/revoke').set(ADMIN_HEADERS).send({ user_id: 2 });
    const u2 = store._rows.find((x) => x.user_id === 2);
    const u9 = store._rows.find((x) => x.user_id === 9);
    expect(u2.status).toBe('revoked');
    expect(u9.status).toBe('active');
  });

  test('revoke with nothing live → 200 + revoked_count=0', async () => {
    const app = buildApp({ store: makeStore() });
    const r = await request(app).post('/api/internal/lb-orchestration/credentials/revoke').set(ADMIN_HEADERS).send({ user_id: 7 });
    expect(r.status).toBe(200);
    expect(r.body.revoked_count).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────
// GET /credentials/status
// ─────────────────────────────────────────────────────────────────
describe('GET /credentials/status', () => {
  test('returns active/rotating/webhook/enablement shape', async () => {
    const store = makeStore({
      settings: [{
        user_id: 2, leadbridge_connected: true,
        lb_orchestration_enabled_at: '2026-05-27T00:00:00Z',
        lb_orchestration_webhook_url: 'https://lb.example.com/hook',
        lb_orchestration_webhook_set_at: '2026-05-27T00:00:00Z',
      }],
    });
    const app = buildApp({ store });
    await request(app).post('/api/internal/lb-orchestration/credentials/mint').set(ADMIN_HEADERS).send({ user_id: 2 });

    const r = await request(app).get('/api/internal/lb-orchestration/credentials/status?user_id=2').set(ADMIN_HEADERS);
    expect(r.status).toBe(200);
    expect(r.body.user_id).toBe(2);
    expect(r.body.active).toMatchObject({ status: 'active', kid: 'sf_orch_test_kid', scope: 'lb_orchestration' });
    expect(r.body.rotating).toBeNull();
    expect(r.body.webhook.url).toBe('https://lb.example.com/hook');
    expect(r.body.enablement.leadbridge_connected).toBe(true);
    expect(r.body.enablement.connection_state_enabled).toBe(true);
    expect(r.body.enablement.effective).toBe(true);
  });

  test('returns null active when no credential', async () => {
    const store = makeStore();
    const app = buildApp({ store });
    const r = await request(app).get('/api/internal/lb-orchestration/credentials/status?user_id=2').set(ADMIN_HEADERS);
    expect(r.status).toBe(200);
    expect(r.body.active).toBeNull();
    expect(r.body.rotating).toBeNull();
    expect(r.body.enablement.effective).toBe(false);
  });

  test('never returns token_hash in any payload', async () => {
    const store = makeStore();
    const app = buildApp({ store });
    await request(app).post('/api/internal/lb-orchestration/credentials/mint').set(ADMIN_HEADERS).send({ user_id: 2 });
    const r = await request(app).get('/api/internal/lb-orchestration/credentials/status?user_id=2').set(ADMIN_HEADERS);
    expect(r.status).toBe(200);
    const body = JSON.stringify(r.body);
    expect(body).not.toMatch(/token_hash/);
  });

  test('reflects rotating credential after rotate', async () => {
    const store = makeStore();
    const app = buildApp({ store });
    await request(app).post('/api/internal/lb-orchestration/credentials/mint').set(ADMIN_HEADERS).send({ user_id: 2 });
    await request(app).post('/api/internal/lb-orchestration/credentials/rotate').set(ADMIN_HEADERS).send({ user_id: 2 });
    const r = await request(app).get('/api/internal/lb-orchestration/credentials/status?user_id=2').set(ADMIN_HEADERS);
    expect(r.status).toBe(200);
    expect(r.body.active).not.toBeNull();
    expect(r.body.rotating).not.toBeNull();
    expect(r.body.rotating.status).toBe('rotating');
    expect(r.body.rotating.grace_expires_at).toMatch(/T/);
  });

  test('validation: missing user_id query → 400', async () => {
    const app = buildApp({ store: makeStore() });
    const r = await request(app).get('/api/internal/lb-orchestration/credentials/status').set(ADMIN_HEADERS);
    expect(r.status).toBe(400);
  });

  test('env override visible in enablement block', async () => {
    process.env.LB_ORCHESTRATION_ENABLED_TENANTS = '+2';
    const store = makeStore();
    const app = buildApp({ store });
    const r = await request(app).get('/api/internal/lb-orchestration/credentials/status?user_id=2').set(ADMIN_HEADERS);
    expect(r.status).toBe(200);
    expect(r.body.enablement.env_override).toBe(true);
    expect(r.body.enablement.effective).toBe(true);
    delete process.env.LB_ORCHESTRATION_ENABLED_TENANTS;
  });

  test('env negative override forces enablement=false even with active cred', async () => {
    process.env.LB_ORCHESTRATION_ENABLED_TENANTS = '-2';
    const store = makeStore({
      settings: [{ user_id: 2, leadbridge_connected: true, lb_orchestration_enabled_at: '2026-05-27T00:00:00Z' }],
    });
    const app = buildApp({ store });
    await request(app).post('/api/internal/lb-orchestration/credentials/mint').set(ADMIN_HEADERS).send({ user_id: 2 });
    const r = await request(app).get('/api/internal/lb-orchestration/credentials/status?user_id=2').set(ADMIN_HEADERS);
    expect(r.status).toBe(200);
    expect(r.body.enablement.env_negative_override).toBe(true);
    expect(r.body.enablement.effective).toBe(false);
    delete process.env.LB_ORCHESTRATION_ENABLED_TENANTS;
  });
});

// ─────────────────────────────────────────────────────────────────
// Full lifecycle safety — plaintext token never appears anywhere
// outside the mint/rotate response body
// ─────────────────────────────────────────────────────────────────
describe('full lifecycle safety', () => {
  test('plaintext token never appears in DB writes or status payloads across mint/rotate/revoke/status', async () => {
    const store = makeStore({
      settings: [{ user_id: 2, leadbridge_connected: true, lb_orchestration_enabled_at: '2026-05-27T00:00:00Z' }],
    });
    const logs = [];
    const logger = {
      log: (m) => logs.push(['log', m]),
      warn: (m) => logs.push(['warn', m]),
      error: (m) => logs.push(['error', m]),
      debug: (m) => logs.push(['debug', m]),
    };
    const app = buildApp({ store, logger });

    const m = await request(app).post('/api/internal/lb-orchestration/credentials/mint').set(ADMIN_HEADERS).send({ user_id: 2 });
    const rot = await request(app).post('/api/internal/lb-orchestration/credentials/rotate').set(ADMIN_HEADERS).send({ user_id: 2 });
    const status = await request(app).get('/api/internal/lb-orchestration/credentials/status?user_id=2').set(ADMIN_HEADERS);
    await request(app).post('/api/internal/lb-orchestration/credentials/revoke').set(ADMIN_HEADERS).send({ user_id: 2 });

    const allWrites = JSON.stringify(store._writeLog);
    const allLogs   = JSON.stringify(logs);
    const allStatus = JSON.stringify(status.body);

    expect(allWrites).not.toContain(m.body.token);
    expect(allWrites).not.toContain(rot.body.token);
    expect(allLogs).not.toContain(m.body.token);
    expect(allLogs).not.toContain(rot.body.token);
    expect(allStatus).not.toContain(m.body.token);
    expect(allStatus).not.toContain(rot.body.token);
  });
});
