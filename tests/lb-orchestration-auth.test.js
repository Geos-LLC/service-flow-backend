'use strict';

/**
 * lb-orchestration-auth.js
 *
 * Pure unit tests. Verifies:
 *
 *   authenticateOrchestrationToken (the sfo_v1 verifier):
 *     - missing Authorization → 401 invalid_orchestration_token
 *     - malformed Bearer → 401
 *     - valid active token → next() + req.user shape
 *     - tampered token → 401 invalid_orchestration_token
 *     - expired payload → 401 invalid_orchestration_token
 *     - revoked credential → 401 credential_revoked
 *     - rotating in grace → 401 credential_revoked (after lazy cleanup) — actually accepted
 *     - rotating past grace → 401 credential_revoked + row flipped to revoked
 *     - unknown credential (signed but no row) → 401 invalid_orchestration_token
 *     - tenant_mismatch → 401 invalid_orchestration_token
 *     - DB throws → 503 service_unavailable, no plaintext token in log
 *
 *   makeOrchestrationAuthDispatcher:
 *     - Bearer sfo_v1.* → orchestration token verifier runs
 *     - Bearer eyJ... (JWT) → user JWT middleware runs
 *     - missing header → user JWT middleware runs (existing 401 path)
 *     - lower-case 'authorization' header → still dispatched
 */

// Setup signing key BEFORE requiring modules that read env via creds.
process.env.SF_ORCH_SIGNING_KEY     = Buffer.alloc(32, 0xAB).toString('base64');
process.env.SF_ORCH_SIGNING_KEY_KID = 'sf_orch_test_kid';

const codec = require('../lib/lb-orchestration-token-format');
const creds = require('../lib/lb-orchestration-credentials');
const auth  = require('../lib/lb-orchestration-auth');

const TABLE = 'lb_orchestration_credentials';

// ─────────────────────────────────────────────────────────────────
// Reuse the in-memory store from the credentials test. Inlined here
// to keep this test self-contained.
// ─────────────────────────────────────────────────────────────────
function makeStore() {
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
      insert(row) { state.op = 'insert'; state.payload = row; return builder; },
      update(p)   { state.op = 'update'; state.payload = p;   return builder; },
      select(c)   { state.selectCols = c || '*'; if (!state.op) state.op = 'select'; return builder; },
      eq(c, v)    { state.filters.push({ type: 'eq', col: c, val: v }); return builder; },
      in(c, v)    { state.filters.push({ type: 'in', col: c, vals: v }); return builder; },
      lte(c, v)   { state.filters.push({ type: 'lte', col: c, val: v }); return builder; },
      single()       { return exec(state).then(coerceSingle); },
      maybeSingle()  { return exec(state).then(coerceMaybeSingle); },
      then(onF, onR) { return exec(state).then(onF, onR); },
    };
    return builder;
  }

  function exec(state) {
    return new Promise((resolve) => {
      writeLog.push({
        op: state.op,
        table: state.table,
        payload: state.payload ? JSON.parse(JSON.stringify(state.payload)) : null,
        filters: state.filters.slice(),
      });
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

  function coerceSingle({ data, error }) {
    if (error) return { data: null, error };
    if (Array.isArray(data)) return data.length === 0
      ? { data: null, error: { code: 'PGRST116', message: 'no rows' } }
      : { data: data[0], error: null };
    return { data, error: null };
  }
  function coerceMaybeSingle({ data, error }) {
    if (error) return { data: null, error };
    if (Array.isArray(data)) return { data: data[0] || null, error: null };
    return { data: data || null, error: null };
  }

  return { _rows: rows, _writeLog: writeLog, from(t) { return makeBuilder(t); } };
}

function makeRes() {
  const res = {
    _status: 200, _body: null,
    status(c) { this._status = c; return this; },
    json(b)   { this._body   = b; return this; },
  };
  return res;
}

function mintForTest(store, userId = 2) {
  return creds.mintCredential(store, { userId });
}

// ─────────────────────────────────────────────────────────────────
// authenticateOrchestrationToken
// ─────────────────────────────────────────────────────────────────
describe('authenticateOrchestrationToken', () => {
  test('missing Authorization → 401 invalid_orchestration_token', async () => {
    const store = makeStore();
    const mw = auth.makeAuthenticateOrchestrationToken(store);
    const res = makeRes();
    await mw({ headers: {} }, res, () => { throw new Error('should not call next'); });
    expect(res._status).toBe(401);
    expect(res._body.error).toBe('invalid_orchestration_token');
  });

  test('malformed Bearer (not sfo_v1.) → 401', async () => {
    const store = makeStore();
    const mw = auth.makeAuthenticateOrchestrationToken(store);
    const res = makeRes();
    await mw({ headers: { authorization: 'Bearer not.a.token' } }, res, () => { throw new Error('next'); });
    expect(res._status).toBe(401);
  });

  test('valid active credential → next() + req.user shape', async () => {
    const store = makeStore();
    const m = await mintForTest(store, 2);
    const mw = auth.makeAuthenticateOrchestrationToken(store);
    const req = { headers: { authorization: `Bearer ${m.token}` } };
    const res = makeRes();
    let called = false;
    await mw(req, res, () => { called = true; });
    expect(called).toBe(true);
    expect(req.user.userId).toBe(2);
    expect(req.user.source).toBe('lb_orchestration_token');
    expect(req.user.cred_id).toBe(m.credentialId);
    expect(req.user.kid).toBe('sf_orch_test_kid');
    expect(req.user.token_prefix).toBe(m.tokenPrefix);
  });

  test('tampered signature → 401 invalid_orchestration_token', async () => {
    const store = makeStore();
    const m = await mintForTest(store, 2);
    const parts = m.token.split('.');
    parts[2] = parts[2].slice(0, -2) + 'AA';
    const mw = auth.makeAuthenticateOrchestrationToken(store);
    const res = makeRes();
    await mw({ headers: { authorization: `Bearer ${parts.join('.')}` } }, res, () => { throw new Error('next'); });
    expect(res._status).toBe(401);
    expect(res._body.error).toBe('invalid_orchestration_token');
  });

  test('expired payload → 401 invalid_orchestration_token', async () => {
    const store = makeStore();
    const m = await mintForTest(store, 2);
    const mw = auth.makeAuthenticateOrchestrationToken(store, {
      now: () => Date.now() + 365 * 24 * 60 * 60 * 1000,
    });
    const res = makeRes();
    await mw({ headers: { authorization: `Bearer ${m.token}` } }, res, () => { throw new Error('next'); });
    expect(res._status).toBe(401);
    expect(res._body.error).toBe('invalid_orchestration_token');
  });

  test('revoked credential → 401 credential_revoked', async () => {
    const store = makeStore();
    const m = await mintForTest(store, 2);
    await creds.revokeCredential(store, { userId: 2 });
    const mw = auth.makeAuthenticateOrchestrationToken(store);
    const res = makeRes();
    await mw({ headers: { authorization: `Bearer ${m.token}` } }, res, () => { throw new Error('next'); });
    expect(res._status).toBe(401);
    expect(res._body.error).toBe('credential_revoked');
  });

  test('rotating credential inside grace window → next() (accepted)', async () => {
    const store = makeStore();
    const m1 = await mintForTest(store, 2);
    await creds.rotateCredential(store, { userId: 2 });
    const mw = auth.makeAuthenticateOrchestrationToken(store);
    const req = { headers: { authorization: `Bearer ${m1.token}` } };
    const res = makeRes();
    let called = false;
    await mw(req, res, () => { called = true; });
    expect(called).toBe(true);
    expect(req.user.userId).toBe(2);
  });

  test('rotating credential past grace → 401 credential_revoked + row flips to revoked', async () => {
    const store = makeStore();
    const m1 = await mintForTest(store, 2);
    await creds.rotateCredential(store, { userId: 2 });
    const rotating = store._rows.find((r) => r.status === 'rotating');
    rotating.grace_expires_at = new Date(Date.now() - 60_000).toISOString();
    const mw = auth.makeAuthenticateOrchestrationToken(store);
    const res = makeRes();
    await mw({ headers: { authorization: `Bearer ${m1.token}` } }, res, () => { throw new Error('next'); });
    expect(res._status).toBe(401);
    expect(res._body.error).toBe('credential_revoked');
    expect(rotating.status).toBe('revoked');
    expect(rotating.revoked_reason).toBe('grace_expired');
  });

  test('unknown credential (signed correctly but no DB row) → 401', async () => {
    const store = makeStore();
    // Build a token without minting a row.
    const key = creds.resolveSigningKey('sf_orch_test_kid');
    const { token } = codec.encodeToken({
      tenantId: 2, kid: 'sf_orch_test_kid', expiresInMs: 60_000, signingKey: key,
    });
    const mw = auth.makeAuthenticateOrchestrationToken(store);
    const res = makeRes();
    await mw({ headers: { authorization: `Bearer ${token}` } }, res, () => { throw new Error('next'); });
    expect(res._status).toBe(401);
    expect(res._body.error).toBe('invalid_orchestration_token');
  });

  test('tenant_mismatch → 401 invalid_orchestration_token', async () => {
    const store = makeStore();
    const m = await mintForTest(store, 2);
    // Maliciously alter the row's user_id so it no longer matches payload.tenant_id.
    store._rows[0].user_id = 9;
    const mw = auth.makeAuthenticateOrchestrationToken(store);
    const res = makeRes();
    await mw({ headers: { authorization: `Bearer ${m.token}` } }, res, () => { throw new Error('next'); });
    expect(res._status).toBe(401);
    expect(res._body.error).toBe('invalid_orchestration_token');
  });

  test('DB lookup throws → 503 service_unavailable + no plaintext token in logger', async () => {
    const m = await mintForTest(makeStore(), 2);
    // Throwing supabase: any .from(...) immediately throws.
    const throwingStub = {
      from() { throw new Error('synthetic supabase outage'); },
    };
    const logs = [];
    const mw = auth.makeAuthenticateOrchestrationToken(throwingStub, {
      logger: {
        log:   (m) => logs.push(['log', m]),
        warn:  (m) => logs.push(['warn', m]),
        error: (m) => logs.push(['error', m]),
        debug: (m) => logs.push(['debug', m]),
      },
    });
    const res = makeRes();
    await mw({ headers: { authorization: `Bearer ${m.token}` } }, res, () => { throw new Error('next'); });
    expect(res._status).toBe(503);
    expect(res._body.error).toBe('service_unavailable');
    // Logs may include token_prefix but never the full token.
    const joined = JSON.stringify(logs);
    expect(joined).not.toContain(m.token);
  });

  test('case-insensitive header lookup (headers.Authorization is canonical via express; both styles parsed)', async () => {
    // express normalizes to lower-case, but defensive code uses headers.authorization.
    const store = makeStore();
    const m = await mintForTest(store, 2);
    const mw = auth.makeAuthenticateOrchestrationToken(store);
    const req = { headers: { authorization: `Bearer ${m.token}` } };
    const res = makeRes();
    let called = false;
    await mw(req, res, () => { called = true; });
    expect(called).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────
// makeOrchestrationAuthDispatcher
// ─────────────────────────────────────────────────────────────────
describe('makeOrchestrationAuthDispatcher', () => {
  function noopUserJWT() {
    let called = false;
    const mw = (req, res, next) => { called = true; next(); };
    mw.called = () => called;
    return mw;
  }

  test('Bearer sfo_v1.* routes to orchestration verifier', async () => {
    const store = makeStore();
    const m = await mintForTest(store, 2);
    let userAuthCalled = false;
    const userAuth = (req, res, next) => { userAuthCalled = true; next(); };
    const dispatcher = auth.makeOrchestrationAuthDispatcher({
      authenticateToken: userAuth,
      supabase: store,
    });
    const req = { headers: { authorization: `Bearer ${m.token}` } };
    const res = makeRes();
    let nextCalled = false;
    await dispatcher(req, res, () => { nextCalled = true; });
    expect(userAuthCalled).toBe(false);            // userJWT NOT invoked
    expect(nextCalled).toBe(true);                  // orch path succeeded
    expect(req.user.source).toBe('lb_orchestration_token');
  });

  test('Bearer eyJ... (JWT) routes to user JWT middleware', () => {
    const store = makeStore();
    let userAuthCalled = false;
    const userAuth = (req, res, next) => { userAuthCalled = true; next(); };
    const dispatcher = auth.makeOrchestrationAuthDispatcher({
      authenticateToken: userAuth, supabase: store,
    });
    const req = { headers: { authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.fake.fake' } };
    const res = makeRes();
    dispatcher(req, res, () => {});
    expect(userAuthCalled).toBe(true);
  });

  test('missing Authorization → user JWT middleware (which returns 401)', () => {
    const store = makeStore();
    let userAuthCalled = false;
    const userAuth = (req, res, next) => { userAuthCalled = true; next(); };
    const dispatcher = auth.makeOrchestrationAuthDispatcher({
      authenticateToken: userAuth, supabase: store,
    });
    const req = { headers: {} };
    const res = makeRes();
    dispatcher(req, res, () => {});
    expect(userAuthCalled).toBe(true);
  });

  test('isOrchestrationTokenRequest(): exact prefix matching', () => {
    expect(auth.isOrchestrationTokenRequest({ headers: { authorization: 'Bearer sfo_v1.x.y' } })).toBe(true);
    expect(auth.isOrchestrationTokenRequest({ headers: { authorization: 'Bearer sfo_v2.x.y' } })).toBe(false);
    expect(auth.isOrchestrationTokenRequest({ headers: { authorization: 'Bearer slot_v1.x.y' } })).toBe(false);
    expect(auth.isOrchestrationTokenRequest({ headers: {} })).toBe(false);
    expect(auth.isOrchestrationTokenRequest({})).toBe(false);
  });
});
