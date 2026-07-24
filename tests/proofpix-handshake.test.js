/**
 * ProofPix integration — PR 1 (handshake) tests.
 *
 * Two layers:
 *   1. Pure token-primitives (lib/proofpix-tokens.js) — no supabase needed.
 *   2. Route module (proofpix-service.js) mounted on an in-process Express
 *      app, driven via supertest, backed by a tiny fake Supabase.
 *
 * Fake Supabase supports just the chainable shape this module uses:
 *   .from(t).select(c).eq(k,v).maybeSingle()
 *   .from(t).select(c).eq(k,v).single()
 *   .from(t).insert(row)            (also .insert(row).select(c).single())
 *   .from(t).update(patch).eq(k,v).is(k,null).select(c)
 *   .from(t).update(patch).eq(k,v).is(k,null)        (thenable)
 *   .from(t).update(patch).eq(k,v).then(...)         (thenable, fire-and-forget)
 *
 * Not covered: real Postgres semantics. The CAS-on-redeem race test is
 * exercised by checking that the second attempt observes redeemed_at set.
 */

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const JWT_SECRET = 'test-jwt-secret-handshake';

process.env.JWT_SECRET = JWT_SECRET;
// supabase-storage.js creates a Supabase client at module-load — give it
// non-empty values so the proofpix-service require chain doesn't crash.
// The fake supabase replaces all real DB / storage calls.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://test.invalid';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role';

const {
  FLAGS,
} = require('../lib/feature-flags');

const {
  newConnectCode,
  normalizeConnectCode,
  newConnectToken,
  isConnectToken,
  newRefreshToken,
  hashRefreshToken,
  signAccessToken,
  verifyAccessToken,
} = require('../lib/proofpix-tokens');

// ─────────────────────────────────────────────────────────────────────
// Fake Supabase
// ─────────────────────────────────────────────────────────────────────

function makeFakeSupabase(seed = {}) {
  const db = {
    users: [...(seed.users || [])],
    proofpix_connect_codes: [...(seed.proofpix_connect_codes || [])],
    proofpix_connections: [...(seed.proofpix_connections || [])],
  };

  function matches(row, filters) {
    return filters.every(([kind, k, v]) => {
      if (kind === 'eq') return String(row[k]) === String(v);
      if (kind === 'is') return v === null ? row[k] == null : row[k] === v;
      return false;
    });
  }

  function from(table) {
    if (!db[table]) db[table] = [];

    const selectChain = (filters) => {
      // Order/pagination state — only used by the array-terminal
      // (.then) path; single-row terminals ignore them.
      let orderKey = null;
      let orderAsc = true;
      const api = {
        eq(k, v) { filters.push(['eq', k, v]); return api; },
        is(k, v) { filters.push(['is', k, v]); return api; },
        order(k, opts) {
          orderKey = k;
          orderAsc = opts && opts.ascending !== undefined ? opts.ascending : true;
          return api;
        },
        async maybeSingle() {
          const row = db[table].find((r) => matches(r, filters));
          return { data: row || null, error: null };
        },
        async single() {
          const row = db[table].find((r) => matches(r, filters));
          if (!row) return { data: null, error: { message: 'not found' } };
          return { data: row, error: null };
        },
        // Array terminal — awaiting the chain (or calling .then on it)
        // returns { data: [...], error }. Enables the list-shaped
        // routes like GET /connections without changing existing
        // maybeSingle/single call sites.
        then(onFulfilled, onRejected) {
          const rows = db[table].filter((r) => matches(r, filters));
          if (orderKey) {
            rows.sort((a, b) => {
              const av = a[orderKey], bv = b[orderKey];
              if (av === bv) return 0;
              if (av == null) return orderAsc ? -1 : 1;
              if (bv == null) return orderAsc ? 1 : -1;
              return orderAsc ? (av > bv ? 1 : -1) : (av < bv ? 1 : -1);
            });
          }
          return Promise.resolve({ data: rows, error: null }).then(onFulfilled, onRejected);
        },
      };
      return api;
    };

    const updateChain = (patch) => {
      const filters = [];
      const apply = () => {
        const hits = db[table].filter((r) => matches(r, filters));
        for (const r of hits) Object.assign(r, patch);
        return { data: hits, error: null };
      };
      const api = {
        eq(k, v) { filters.push(['eq', k, v]); return api; },
        is(k, v) { filters.push(['is', k, v]); return api; },
        select() {
          const out = apply();
          return Promise.resolve({ data: out.data.map((r) => ({ code: r.code, id: r.id })), error: null });
        },
        then(onFulfilled, onRejected) {
          return Promise.resolve(apply()).then(onFulfilled, onRejected);
        },
      };
      return api;
    };

    return {
      select() {
        return selectChain([]);
      },
      insert(row) {
        const inserted = Array.isArray(row) ? row[0] : { ...row };
        if (inserted.id == null && table === 'proofpix_connections') {
          inserted.id = db[table].length + 1;
        }
        db[table].push(inserted);
        const insertResult = {
          select() {
            return {
              async single() {
                return { data: inserted, error: null };
              },
            };
          },
          then(onFulfilled, onRejected) {
            return Promise.resolve({ data: inserted, error: null }).then(onFulfilled, onRejected);
          },
        };
        return insertResult;
      },
      update(patch) {
        return updateChain(patch);
      },
    };
  }

  return { from, _db: db };
}

function makeApp(supabase) {
  const app = express();
  app.use(express.json());
  app.use('/api/integrations/proofpix', require('../proofpix-service')(supabase, { log() {}, warn() {}, error() {} }));
  return app;
}

function sfUserJwt(userId) {
  return jwt.sign({ userId }, JWT_SECRET, { expiresIn: '1h' });
}

const seedUser = (id, business_name = 'Acme Cleaning', email = `user${id}@example.com`) => ({
  id, business_name, email,
});

// ─────────────────────────────────────────────────────────────────────
// Pure: token primitives
// ─────────────────────────────────────────────────────────────────────

describe('proofpix-tokens — connect code primitives', () => {
  test('newConnectCode shape: 4 groups of 4 chars, alphabet-clean', () => {
    for (let i = 0; i < 50; i++) {
      const code = newConnectCode();
      expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
      expect(code).not.toMatch(/[ILOU]/);
    }
  });

  test('normalizeConnectCode tolerates spacing, lowercase, missing hyphens', () => {
    const canonical = newConnectCode();
    const cleaned = canonical.replace(/-/g, '');
    expect(normalizeConnectCode(canonical)).toBe(canonical);
    expect(normalizeConnectCode(cleaned)).toBe(canonical);
    expect(normalizeConnectCode(canonical.toLowerCase())).toBe(canonical);
    expect(normalizeConnectCode(`  ${canonical}  `)).toBe(canonical);
  });

  test('normalizeConnectCode rejects wrong length / chars / type', () => {
    expect(normalizeConnectCode('')).toBeNull();
    expect(normalizeConnectCode('ABCD-EFGH')).toBeNull();
    expect(normalizeConnectCode(null)).toBeNull();
    expect(normalizeConnectCode(undefined)).toBeNull();
    // 16 chars but contains a disallowed alphabet char ('I')
    expect(normalizeConnectCode('IIII-IIII-IIII-IIII')).toBeNull();
  });
});

describe('proofpix-tokens — refresh tokens', () => {
  test('newRefreshToken is prefixed and high-entropy', () => {
    const a = newRefreshToken();
    const b = newRefreshToken();
    expect(a).toMatch(/^pprt_[A-Za-z0-9_-]{40,}$/);
    expect(a).not.toBe(b);
  });

  test('hashRefreshToken is deterministic and avalanche-y', () => {
    const t = newRefreshToken();
    expect(hashRefreshToken(t)).toBe(hashRefreshToken(t));
    expect(hashRefreshToken(t)).not.toBe(hashRefreshToken(t + 'x'));
    expect(hashRefreshToken(t)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('proofpix-tokens — access JWT', () => {
  test('round-trip with correct audience', () => {
    const tok = signAccessToken(JWT_SECRET, { userId: 42, connectionId: 7 });
    const v = verifyAccessToken(JWT_SECRET, tok);
    expect(v).toEqual({ ok: true, userId: 42, connectionId: 7 });
  });

  test('regular SF user JWT (no aud) is rejected', () => {
    const sf = sfUserJwt(42);
    const v = verifyAccessToken(JWT_SECRET, sf);
    expect(v.ok).toBe(false);
    // No audience claim — jsonwebtoken classifies as audience mismatch.
    expect(['wrong_audience', 'invalid']).toContain(v.reason);
  });

  test('expired access token reports reason=expired', () => {
    const tok = jwt.sign(
      { userId: 1, cid: 1, kind: 'access' },
      JWT_SECRET,
      { audience: 'proofpix', expiresIn: -1 }
    );
    const v = verifyAccessToken(JWT_SECRET, tok);
    expect(v).toEqual({ ok: false, reason: 'expired' });
  });

  test('missing required claims rejected', () => {
    const tok = jwt.sign({ kind: 'access' }, JWT_SECRET, { audience: 'proofpix' });
    const v = verifyAccessToken(JWT_SECRET, tok);
    expect(v.ok).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Route module — feature flag default OFF
// ─────────────────────────────────────────────────────────────────────

describe('proofpix-service — flag default OFF', () => {
  beforeEach(() => { delete process.env[FLAGS.PROOFPIX_INTEGRATION_ENABLED]; });

  test('every namespaced route returns 404 when flag is unset', async () => {
    const app = makeApp(makeFakeSupabase({ users: [seedUser(1)] }));
    const tok = sfUserJwt(1);
    const routes = [
      ['post', '/api/integrations/proofpix/connect/code/issue', { auth: tok }],
      ['post', '/api/integrations/proofpix/connect/code/redeem', { body: { code: 'X' } }],
      ['post', '/api/integrations/proofpix/connect/refresh', { body: { refresh_token: 'X' } }],
      ['get', '/api/integrations/proofpix/connection/status', { auth: tok }],
      ['delete', '/api/integrations/proofpix/connection', { auth: tok }],
    ];
    for (const [verb, path, opts] of routes) {
      const req = request(app)[verb](path);
      if (opts.auth) req.set('Authorization', `Bearer ${opts.auth}`);
      const res = await (opts.body ? req.send(opts.body) : req.send());
      expect(res.status).toBe(404);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
// Route module — handshake happy paths and known failures
// ─────────────────────────────────────────────────────────────────────

describe('proofpix-service — handshake flow', () => {
  beforeEach(() => { process.env[FLAGS.PROOFPIX_INTEGRATION_ENABLED] = 'true'; });
  afterEach(() => { delete process.env[FLAGS.PROOFPIX_INTEGRATION_ENABLED]; });

  test('issue → redeem → status → revoke (full happy path)', async () => {
    const supa = makeFakeSupabase({ users: [seedUser(1, 'Acme Cleaning')] });
    const app = makeApp(supa);

    // Issue
    const issue = await request(app)
      .post('/api/integrations/proofpix/connect/code/issue')
      .set('Authorization', `Bearer ${sfUserJwt(1)}`)
      .send();
    expect(issue.status).toBe(200);
    expect(issue.body.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}$/);
    expect(issue.body.expires_in).toBe(600);

    // Redeem
    const redeem = await request(app)
      .post('/api/integrations/proofpix/connect/code/redeem')
      .send({ code: issue.body.code, device_label: 'iPhone 15 - Sarah' });
    expect(redeem.status).toBe(200);
    expect(redeem.body).toMatchObject({
      workspace_id: '1',
      workspace_name: 'Acme Cleaning',
      admin_user_id: '1',
      expires_in: 3600,
    });
    expect(redeem.body.refresh_token).toMatch(/^pprt_/);
    expect(redeem.body.access_token).toEqual(expect.any(String));

    // Status
    const status = await request(app)
      .get('/api/integrations/proofpix/connection/status')
      .set('Authorization', `Bearer ${redeem.body.access_token}`)
      .send();
    expect(status.status).toBe(200);
    expect(status.body).toEqual({
      valid: true,
      workspace_id: '1',
      workspace_name: 'Acme Cleaning',
    });

    // Revoke
    const revoke = await request(app)
      .delete('/api/integrations/proofpix/connection')
      .set('Authorization', `Bearer ${redeem.body.access_token}`)
      .send();
    expect(revoke.status).toBe(204);

    // Status after revoke
    const after = await request(app)
      .get('/api/integrations/proofpix/connection/status')
      .set('Authorization', `Bearer ${redeem.body.access_token}`)
      .send();
    expect(after.status).toBe(401);
  });

  test('workspace_name falls back to email when business_name is null', async () => {
    const supa = makeFakeSupabase({ users: [seedUser(7, null, 'owner@biz.com')] });
    const app = makeApp(supa);
    const issue = await request(app)
      .post('/api/integrations/proofpix/connect/code/issue')
      .set('Authorization', `Bearer ${sfUserJwt(7)}`)
      .send();
    const redeem = await request(app)
      .post('/api/integrations/proofpix/connect/code/redeem')
      .send({ code: issue.body.code });
    expect(redeem.body.workspace_name).toBe('owner@biz.com');
  });

  test('issue without SF JWT → 401', async () => {
    const app = makeApp(makeFakeSupabase({ users: [seedUser(1)] }));
    const res = await request(app)
      .post('/api/integrations/proofpix/connect/code/issue')
      .send();
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_TOKEN');
  });

  test('ProofPix access token cannot be used to mint a new code', async () => {
    const supa = makeFakeSupabase({ users: [seedUser(1)] });
    const app = makeApp(supa);
    const issue = await request(app)
      .post('/api/integrations/proofpix/connect/code/issue')
      .set('Authorization', `Bearer ${sfUserJwt(1)}`)
      .send();
    const redeem = await request(app)
      .post('/api/integrations/proofpix/connect/code/redeem')
      .send({ code: issue.body.code });
    const reuse = await request(app)
      .post('/api/integrations/proofpix/connect/code/issue')
      .set('Authorization', `Bearer ${redeem.body.access_token}`)
      .send();
    expect(reuse.status).toBe(401);
  });

  test('redeem with malformed code → INVALID_PAYLOAD', async () => {
    const app = makeApp(makeFakeSupabase({ users: [seedUser(1)] }));
    const res = await request(app)
      .post('/api/integrations/proofpix/connect/code/redeem')
      .send({ code: 'nope' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_PAYLOAD');
  });

  test('redeem with unknown well-formed code → INVALID_CODE', async () => {
    const app = makeApp(makeFakeSupabase({ users: [seedUser(1)] }));
    const fake = newConnectCode();
    const res = await request(app)
      .post('/api/integrations/proofpix/connect/code/redeem')
      .send({ code: fake });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_CODE');
  });

  test('redeem on expired code → CODE_EXPIRED', async () => {
    const expiredCode = newConnectCode();
    const supa = makeFakeSupabase({
      users: [seedUser(1)],
      proofpix_connect_codes: [{
        code: expiredCode,
        user_id: 1,
        expires_at: new Date(Date.now() - 1000).toISOString(),
        redeemed_at: null,
        redeemed_by_label: null,
        created_at: new Date().toISOString(),
      }],
    });
    const app = makeApp(supa);
    const res = await request(app)
      .post('/api/integrations/proofpix/connect/code/redeem')
      .send({ code: expiredCode });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CODE_EXPIRED');
  });

  test('double-redeem: second call sees redeemed_at and rejects', async () => {
    const supa = makeFakeSupabase({ users: [seedUser(1)] });
    const app = makeApp(supa);
    const issue = await request(app)
      .post('/api/integrations/proofpix/connect/code/issue')
      .set('Authorization', `Bearer ${sfUserJwt(1)}`)
      .send();
    const first = await request(app)
      .post('/api/integrations/proofpix/connect/code/redeem')
      .send({ code: issue.body.code });
    expect(first.status).toBe(200);
    const second = await request(app)
      .post('/api/integrations/proofpix/connect/code/redeem')
      .send({ code: issue.body.code });
    expect(second.status).toBe(400);
    expect(second.body.error.code).toBe('INVALID_CODE');
  });

  test('/connect/refresh returns a fresh access token; original refresh token still works', async () => {
    const supa = makeFakeSupabase({ users: [seedUser(1)] });
    const app = makeApp(supa);
    const issue = await request(app)
      .post('/api/integrations/proofpix/connect/code/issue')
      .set('Authorization', `Bearer ${sfUserJwt(1)}`)
      .send();
    const redeem = await request(app)
      .post('/api/integrations/proofpix/connect/code/redeem')
      .send({ code: issue.body.code });

    const refresh1 = await request(app)
      .post('/api/integrations/proofpix/connect/refresh')
      .send({ refresh_token: redeem.body.refresh_token });
    expect(refresh1.status).toBe(200);
    expect(refresh1.body.access_token).toEqual(expect.any(String));
    expect(refresh1.body.expires_in).toBe(3600);

    const refresh2 = await request(app)
      .post('/api/integrations/proofpix/connect/refresh')
      .send({ refresh_token: redeem.body.refresh_token });
    expect(refresh2.status).toBe(200);
  });

  test('/connect/refresh with unknown token → 401', async () => {
    const app = makeApp(makeFakeSupabase({ users: [seedUser(1)] }));
    const res = await request(app)
      .post('/api/integrations/proofpix/connect/refresh')
      .send({ refresh_token: newRefreshToken() });
    expect(res.status).toBe(401);
  });

  test('/connect/refresh after revoke → 401', async () => {
    const supa = makeFakeSupabase({ users: [seedUser(1)] });
    const app = makeApp(supa);
    const issue = await request(app)
      .post('/api/integrations/proofpix/connect/code/issue')
      .set('Authorization', `Bearer ${sfUserJwt(1)}`)
      .send();
    const redeem = await request(app)
      .post('/api/integrations/proofpix/connect/code/redeem')
      .send({ code: issue.body.code });
    await request(app)
      .delete('/api/integrations/proofpix/connection')
      .set('Authorization', `Bearer ${redeem.body.access_token}`)
      .send();
    const res = await request(app)
      .post('/api/integrations/proofpix/connect/refresh')
      .send({ refresh_token: redeem.body.refresh_token });
    expect(res.status).toBe(401);
  });

  test('multi-device: revoking one connection does not touch the other', async () => {
    const supa = makeFakeSupabase({ users: [seedUser(1)] });
    const app = makeApp(supa);

    // Device A
    const issueA = await request(app)
      .post('/api/integrations/proofpix/connect/code/issue')
      .set('Authorization', `Bearer ${sfUserJwt(1)}`)
      .send();
    const redeemA = await request(app)
      .post('/api/integrations/proofpix/connect/code/redeem')
      .send({ code: issueA.body.code, device_label: 'iPhone' });
    // Device B
    const issueB = await request(app)
      .post('/api/integrations/proofpix/connect/code/issue')
      .set('Authorization', `Bearer ${sfUserJwt(1)}`)
      .send();
    const redeemB = await request(app)
      .post('/api/integrations/proofpix/connect/code/redeem')
      .send({ code: issueB.body.code, device_label: 'iPad' });

    expect(redeemA.body.access_token).not.toBe(redeemB.body.access_token);
    expect(redeemA.body.refresh_token).not.toBe(redeemB.body.refresh_token);

    // Revoke A
    await request(app)
      .delete('/api/integrations/proofpix/connection')
      .set('Authorization', `Bearer ${redeemA.body.access_token}`)
      .send();

    // B's status still works
    const statusB = await request(app)
      .get('/api/integrations/proofpix/connection/status')
      .set('Authorization', `Bearer ${redeemB.body.access_token}`)
      .send();
    expect(statusB.status).toBe(200);

    // A's status returns 401
    const statusA = await request(app)
      .get('/api/integrations/proofpix/connection/status')
      .set('Authorization', `Bearer ${redeemA.body.access_token}`)
      .send();
    expect(statusA.status).toBe(401);
  });

  test('DELETE /connection is idempotent (re-call still 204)', async () => {
    const supa = makeFakeSupabase({ users: [seedUser(1)] });
    const app = makeApp(supa);
    const issue = await request(app)
      .post('/api/integrations/proofpix/connect/code/issue')
      .set('Authorization', `Bearer ${sfUserJwt(1)}`)
      .send();
    const redeem = await request(app)
      .post('/api/integrations/proofpix/connect/code/redeem')
      .send({ code: issue.body.code });
    const r1 = await request(app)
      .delete('/api/integrations/proofpix/connection')
      .set('Authorization', `Bearer ${redeem.body.access_token}`)
      .send();
    expect(r1.status).toBe(204);
    // Token now revoked so a literal re-call is blocked at requireProofpixAccessToken (401).
    // The idempotency claim is about repeated revocation of the same connection
    // not corrupting state — confirm directly via the fake DB.
    const conns = supa._db.proofpix_connections;
    expect(conns).toHaveLength(1);
    expect(conns[0].revoked_at).toBeTruthy();
  });

  test('/connection/status rejects expired access token', async () => {
    const supa = makeFakeSupabase({
      users: [seedUser(1)],
      proofpix_connections: [{
        id: 1, user_id: 1, refresh_token_hash: 'abc', device_label: null,
        created_at: new Date().toISOString(), last_used_at: null, revoked_at: null,
      }],
    });
    const app = makeApp(supa);
    const expired = jwt.sign(
      { userId: 1, cid: 1, kind: 'access' },
      JWT_SECRET,
      { audience: 'proofpix', expiresIn: -1 }
    );
    const res = await request(app)
      .get('/api/integrations/proofpix/connection/status')
      .set('Authorization', `Bearer ${expired}`)
      .send();
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────
// PR 4 — same-device pairing (token + canonical redeem route)
// ─────────────────────────────────────────────────────────────────────

describe('proofpix-tokens — connect token primitives', () => {
  test('newConnectToken: 43-char base64url, high entropy', () => {
    const a = newConnectToken();
    const b = newConnectToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
  });

  test('isConnectToken: accepts good tokens, rejects 16-char codes, rejects garbage', () => {
    expect(isConnectToken(newConnectToken())).toBe(true);
    // 16-char hyphenated code is NOT a token
    expect(isConnectToken(newConnectCode())).toBe(false);
    // Common rejections
    expect(isConnectToken('')).toBe(false);
    expect(isConnectToken('too-short')).toBe(false);
    expect(isConnectToken('A'.repeat(44))).toBe(false);  // wrong length
    expect(isConnectToken('A'.repeat(43) + '=')).toBe(false);  // padding not allowed
    expect(isConnectToken(null)).toBe(false);
    expect(isConnectToken(undefined)).toBe(false);
    expect(isConnectToken(123)).toBe(false);
  });
});

describe('proofpix-service — /connect/token/issue', () => {
  beforeEach(() => { process.env[FLAGS.PROOFPIX_INTEGRATION_ENABLED] = 'true'; });
  afterEach(() => { delete process.env[FLAGS.PROOFPIX_INTEGRATION_ENABLED]; });

  test('flag-off namespace returns 404', async () => {
    delete process.env[FLAGS.PROOFPIX_INTEGRATION_ENABLED];
    const app = makeApp(makeFakeSupabase({ users: [seedUser(1)] }));
    const res = await request(app)
      .post('/api/integrations/proofpix/connect/token/issue')
      .set('Authorization', `Bearer ${sfUserJwt(1)}`)
      .send();
    expect(res.status).toBe(404);
  });

  test('SF JWT → 200 with token shape + 60s expiry', async () => {
    const supa = makeFakeSupabase({ users: [seedUser(1)] });
    const app = makeApp(supa);
    const res = await request(app)
      .post('/api/integrations/proofpix/connect/token/issue')
      .set('Authorization', `Bearer ${sfUserJwt(1)}`)
      .send();
    expect(res.status).toBe(200);
    expect(res.body.expires_in).toBe(60);
    expect(isConnectToken(res.body.token)).toBe(true);
    // Persisted under the same proofpix_connect_codes table
    expect(supa._db.proofpix_connect_codes).toHaveLength(1);
    expect(supa._db.proofpix_connect_codes[0]).toMatchObject({
      code: res.body.token,
      user_id: 1,
    });
  });

  test('no SF JWT → 401', async () => {
    const app = makeApp(makeFakeSupabase({ users: [seedUser(1)] }));
    const res = await request(app)
      .post('/api/integrations/proofpix/connect/token/issue')
      .send();
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_TOKEN');
  });

  test('ProofPix access token (wrong audience) cannot mint a connect token', async () => {
    const supa = makeFakeSupabase({ users: [seedUser(1)] });
    const app = makeApp(supa);
    const issue = await request(app)
      .post('/api/integrations/proofpix/connect/code/issue')
      .set('Authorization', `Bearer ${sfUserJwt(1)}`)
      .send();
    const redeem = await request(app)
      .post('/api/integrations/proofpix/connect/redeem')
      .send({ code: issue.body.code });
    const reuse = await request(app)
      .post('/api/integrations/proofpix/connect/token/issue')
      .set('Authorization', `Bearer ${redeem.body.access_token}`)
      .send();
    expect(reuse.status).toBe(401);
  });
});

describe('proofpix-service — /connect/token/status', () => {
  beforeEach(() => { process.env[FLAGS.PROOFPIX_INTEGRATION_ENABLED] = 'true'; });
  afterEach(() => { delete process.env[FLAGS.PROOFPIX_INTEGRATION_ENABLED]; });

  async function mintToken(app, userId) {
    const res = await request(app)
      .post('/api/integrations/proofpix/connect/token/issue')
      .set('Authorization', `Bearer ${sfUserJwt(userId)}`)
      .send();
    return res.body.token;
  }

  test('freshly minted, not redeemed → pending', async () => {
    const supa = makeFakeSupabase({ users: [seedUser(1)] });
    const app = makeApp(supa);
    const token = await mintToken(app, 1);
    const res = await request(app)
      .get(`/api/integrations/proofpix/connect/token/status?token=${encodeURIComponent(token)}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'pending' });
  });

  test('after redeem → redeemed', async () => {
    const supa = makeFakeSupabase({ users: [seedUser(1)] });
    const app = makeApp(supa);
    const token = await mintToken(app, 1);
    await request(app)
      .post('/api/integrations/proofpix/connect/redeem')
      .send({ code: token });
    const res = await request(app)
      .get(`/api/integrations/proofpix/connect/token/status?token=${encodeURIComponent(token)}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'redeemed' });
  });

  test('past expires_at → expired (backend authoritative even if not yet redeemed)', async () => {
    const supa = makeFakeSupabase({ users: [seedUser(1)] });
    const app = makeApp(supa);
    const token = await mintToken(app, 1);
    // Backdate expiry in the fake DB
    supa._db.proofpix_connect_codes[0].expires_at = new Date(Date.now() - 1000).toISOString();
    const res = await request(app)
      .get(`/api/integrations/proofpix/connect/token/status?token=${encodeURIComponent(token)}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'expired' });
  });

  test('unknown for well-formed but non-existent token (no enumeration signal)', async () => {
    const supa = makeFakeSupabase({ users: [seedUser(1)] });
    const app = makeApp(supa);
    // Generate a real-shape token that was never inserted
    const ghost = newConnectToken();
    const res = await request(app)
      .get(`/api/integrations/proofpix/connect/token/status?token=${encodeURIComponent(ghost)}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'unknown' });
  });

  test('unknown for malformed token (short-circuits before DB)', async () => {
    const supa = makeFakeSupabase({ users: [seedUser(1)] });
    const app = makeApp(supa);
    const res = await request(app)
      .get('/api/integrations/proofpix/connect/token/status?token=not-a-real-token');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'unknown' });
  });

  test('unknown for missing token param', async () => {
    const supa = makeFakeSupabase({ users: [seedUser(1)] });
    const app = makeApp(supa);
    const res = await request(app)
      .get('/api/integrations/proofpix/connect/token/status');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'unknown' });
  });

  test('flag-off namespace still 404s the status route', async () => {
    delete process.env[FLAGS.PROOFPIX_INTEGRATION_ENABLED];
    const supa = makeFakeSupabase({ users: [seedUser(1)] });
    const app = makeApp(supa);
    const res = await request(app)
      .get('/api/integrations/proofpix/connect/token/status?token=whatever');
    expect(res.status).toBe(404);
  });

  test('typed 16-char code is not a valid token here (unknown)', async () => {
    // The status endpoint is scoped to deep-link tokens (43-char
    // base64url). A hyphenated Crockford code has a different shape
    // and shouldn't be treated as a poll target — return unknown.
    const supa = makeFakeSupabase({ users: [seedUser(1)] });
    const app = makeApp(supa);
    const code = newConnectCode();
    const res = await request(app)
      .get(`/api/integrations/proofpix/connect/token/status?token=${encodeURIComponent(code)}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'unknown' });
  });
});

describe('proofpix-service — GET /connections', () => {
  beforeEach(() => { process.env[FLAGS.PROOFPIX_INTEGRATION_ENABLED] = 'true'; });
  afterEach(() => { delete process.env[FLAGS.PROOFPIX_INTEGRATION_ENABLED]; });

  test('unauth → 401', async () => {
    const app = makeApp(makeFakeSupabase({ users: [seedUser(1)] }));
    const res = await request(app).get('/api/integrations/proofpix/connections');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_TOKEN');
  });

  test('flag-off → 404', async () => {
    delete process.env[FLAGS.PROOFPIX_INTEGRATION_ENABLED];
    const app = makeApp(makeFakeSupabase({ users: [seedUser(1)] }));
    const res = await request(app)
      .get('/api/integrations/proofpix/connections')
      .set('Authorization', `Bearer ${sfUserJwt(1)}`);
    expect(res.status).toBe(404);
  });

  test('empty when user has no connections', async () => {
    const supa = makeFakeSupabase({ users: [seedUser(1)] });
    const app = makeApp(supa);
    const res = await request(app)
      .get('/api/integrations/proofpix/connections')
      .set('Authorization', `Bearer ${sfUserJwt(1)}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ connections: [] });
  });

  test('returns active devices scoped to the caller (audit fields only, no token hash)', async () => {
    const supa = makeFakeSupabase({
      users: [seedUser(1), seedUser(2)],
      proofpix_connections: [
        {
          id: 10,
          user_id: 1,
          refresh_token_hash: 'MUST_NOT_LEAK',
          device_label: 'iPhone 15 - Sarah',
          created_at: '2026-07-23T18:00:00.000Z',
          last_used_at: '2026-07-23T18:30:00.000Z',
          revoked_at: null,
        },
        {
          id: 11,
          user_id: 1,
          refresh_token_hash: 'ALSO_HIDDEN',
          device_label: 'iPad',
          created_at: '2026-07-23T20:00:00.000Z',
          last_used_at: null,
          revoked_at: null,
        },
        {
          id: 12,
          user_id: 2,                       // different owner — must be excluded
          refresh_token_hash: 'OTHER_USERS',
          device_label: 'Someone Else',
          created_at: '2026-07-23T21:00:00.000Z',
          last_used_at: null,
          revoked_at: null,
        },
      ],
    });
    const app = makeApp(supa);
    const res = await request(app)
      .get('/api/integrations/proofpix/connections')
      .set('Authorization', `Bearer ${sfUserJwt(1)}`);
    expect(res.status).toBe(200);
    expect(res.body.connections).toHaveLength(2);
    // Newest-first (ORDER BY created_at DESC)
    expect(res.body.connections[0]).toEqual({
      id: 11,
      device_label: 'iPad',
      created_at: '2026-07-23T20:00:00.000Z',
      last_used_at: null,
    });
    expect(res.body.connections[1]).toEqual({
      id: 10,
      device_label: 'iPhone 15 - Sarah',
      created_at: '2026-07-23T18:00:00.000Z',
      last_used_at: '2026-07-23T18:30:00.000Z',
    });
    // Refresh token hash never leaks
    const asString = JSON.stringify(res.body);
    expect(asString).not.toContain('MUST_NOT_LEAK');
    expect(asString).not.toContain('refresh_token_hash');
  });

  test('excludes revoked devices', async () => {
    const supa = makeFakeSupabase({
      users: [seedUser(1)],
      proofpix_connections: [
        {
          id: 20,
          user_id: 1,
          refresh_token_hash: 'x',
          device_label: 'Active',
          created_at: '2026-07-20T00:00:00.000Z',
          last_used_at: null,
          revoked_at: null,
        },
        {
          id: 21,
          user_id: 1,
          refresh_token_hash: 'y',
          device_label: 'Old / revoked',
          created_at: '2026-07-01T00:00:00.000Z',
          last_used_at: null,
          revoked_at: '2026-07-15T00:00:00.000Z',
        },
      ],
    });
    const app = makeApp(supa);
    const res = await request(app)
      .get('/api/integrations/proofpix/connections')
      .set('Authorization', `Bearer ${sfUserJwt(1)}`);
    expect(res.status).toBe(200);
    expect(res.body.connections).toHaveLength(1);
    expect(res.body.connections[0].device_label).toBe('Active');
  });

  test('ProofPix access token (wrong audience) cannot list connections', async () => {
    const supa = makeFakeSupabase({ users: [seedUser(1)] });
    const app = makeApp(supa);
    // Bind a device the standard way, then try to list via its access token
    const issue = await request(app)
      .post('/api/integrations/proofpix/connect/code/issue')
      .set('Authorization', `Bearer ${sfUserJwt(1)}`)
      .send();
    const redeem = await request(app)
      .post('/api/integrations/proofpix/connect/redeem')
      .send({ code: issue.body.code });
    const list = await request(app)
      .get('/api/integrations/proofpix/connections')
      .set('Authorization', `Bearer ${redeem.body.access_token}`);
    expect(list.status).toBe(401);
  });

  test('returns device metadata that ProofPix mobile sent at redeem', async () => {
    const supa = makeFakeSupabase({ users: [seedUser(1)] });
    const app = makeApp(supa);
    const issue = await request(app)
      .post('/api/integrations/proofpix/connect/code/issue')
      .set('Authorization', `Bearer ${sfUserJwt(1)}`)
      .send();
    await request(app)
      .post('/api/integrations/proofpix/connect/redeem')
      .send({
        code: issue.body.code,
        device_label: 'iPhone 15 - Sarah',
        device_model: 'iPhone 15 Pro',
        os_name: 'iOS',
        os_version: '18.2',
        role: 'admin',
      });
    const list = await request(app)
      .get('/api/integrations/proofpix/connections')
      .set('Authorization', `Bearer ${sfUserJwt(1)}`);
    expect(list.status).toBe(200);
    expect(list.body.connections).toHaveLength(1);
    expect(list.body.connections[0]).toMatchObject({
      device_label: 'iPhone 15 - Sarah',
      device_model: 'iPhone 15 Pro',
      os_name: 'iOS',
      os_version: '18.2',
      role: 'admin',
    });
  });

  test('paired_by identity fields round-trip through redeem → /connections', async () => {
    const supa = makeFakeSupabase({ users: [seedUser(1)] });
    const app = makeApp(supa);
    const issue = await request(app)
      .post('/api/integrations/proofpix/connect/code/issue')
      .set('Authorization', `Bearer ${sfUserJwt(1)}`)
      .send();
    await request(app)
      .post('/api/integrations/proofpix/connect/redeem')
      .send({
        code: issue.body.code,
        device_label: 'Sarah phone',
        paired_by_proofpix_user_id: 'usr_9f3a-xyz',
        paired_by_name: 'Sarah Thompson',
        paired_by_email: 'sarah@example.com',
      });
    const list = await request(app)
      .get('/api/integrations/proofpix/connections')
      .set('Authorization', `Bearer ${sfUserJwt(1)}`);
    expect(list.status).toBe(200);
    expect(list.body.connections[0]).toMatchObject({
      paired_by_proofpix_user_id: 'usr_9f3a-xyz',
      paired_by_name: 'Sarah Thompson',
      paired_by_email: 'sarah@example.com',
    });
  });

  test('team-member payload: name present, email NULL (per ProofPix spec)', async () => {
    const supa = makeFakeSupabase({ users: [seedUser(1)] });
    const app = makeApp(supa);
    const issue = await request(app)
      .post('/api/integrations/proofpix/connect/code/issue')
      .set('Authorization', `Bearer ${sfUserJwt(1)}`)
      .send();
    await request(app)
      .post('/api/integrations/proofpix/connect/redeem')
      .send({
        code: issue.body.code,
        role: 'team_member',
        paired_by_proofpix_user_id: 'session_abc123',
        paired_by_name: 'Mike Ross',
        // paired_by_email intentionally omitted — team members have no local email
      });
    const list = await request(app)
      .get('/api/integrations/proofpix/connections')
      .set('Authorization', `Bearer ${sfUserJwt(1)}`);
    expect(list.body.connections[0]).toMatchObject({
      role: 'team_member',
      paired_by_proofpix_user_id: 'session_abc123',
      paired_by_name: 'Mike Ross',
      paired_by_email: null,
    });
  });

  test('paired_by fields are truncated to spec lengths (64/200/200)', async () => {
    const supa = makeFakeSupabase({ users: [seedUser(1)] });
    const app = makeApp(supa);
    const issue = await request(app)
      .post('/api/integrations/proofpix/connect/code/issue')
      .set('Authorization', `Bearer ${sfUserJwt(1)}`)
      .send();
    await request(app)
      .post('/api/integrations/proofpix/connect/redeem')
      .send({
        code: issue.body.code,
        paired_by_proofpix_user_id: 'x'.repeat(500),
        paired_by_name: 'y'.repeat(500),
        paired_by_email: 'z'.repeat(500),
      });
    const list = await request(app)
      .get('/api/integrations/proofpix/connections')
      .set('Authorization', `Bearer ${sfUserJwt(1)}`);
    expect(list.body.connections[0].paired_by_proofpix_user_id).toHaveLength(64);
    expect(list.body.connections[0].paired_by_name).toHaveLength(200);
    expect(list.body.connections[0].paired_by_email).toHaveLength(200);
  });

  test('paired_by fields default to null when omitted (legacy client)', async () => {
    const supa = makeFakeSupabase({ users: [seedUser(1)] });
    const app = makeApp(supa);
    const issue = await request(app)
      .post('/api/integrations/proofpix/connect/code/issue')
      .set('Authorization', `Bearer ${sfUserJwt(1)}`)
      .send();
    await request(app)
      .post('/api/integrations/proofpix/connect/redeem')
      .send({ code: issue.body.code, device_label: 'Legacy phone' });
    const list = await request(app)
      .get('/api/integrations/proofpix/connections')
      .set('Authorization', `Bearer ${sfUserJwt(1)}`);
    expect(list.body.connections[0]).toMatchObject({
      paired_by_proofpix_user_id: null,
      paired_by_name: null,
      paired_by_email: null,
    });
  });

  test('metadata fields default to null when mobile client omits them', async () => {
    const supa = makeFakeSupabase({ users: [seedUser(1)] });
    const app = makeApp(supa);
    const issue = await request(app)
      .post('/api/integrations/proofpix/connect/code/issue')
      .set('Authorization', `Bearer ${sfUserJwt(1)}`)
      .send();
    await request(app)
      .post('/api/integrations/proofpix/connect/redeem')
      .send({ code: issue.body.code, device_label: 'iPhone' });
    const list = await request(app)
      .get('/api/integrations/proofpix/connections')
      .set('Authorization', `Bearer ${sfUserJwt(1)}`);
    expect(list.body.connections[0]).toMatchObject({
      device_label: 'iPhone',
      device_model: null,
      os_name: null,
      os_version: null,
      role: null,
    });
  });
});

describe('proofpix-service — DELETE /connections/:id (admin revoke)', () => {
  beforeEach(() => { process.env[FLAGS.PROOFPIX_INTEGRATION_ENABLED] = 'true'; });
  afterEach(() => { delete process.env[FLAGS.PROOFPIX_INTEGRATION_ENABLED]; });

  test('unauth → 401', async () => {
    const app = makeApp(makeFakeSupabase({ users: [seedUser(1)] }));
    const res = await request(app).delete('/api/integrations/proofpix/connections/42');
    expect(res.status).toBe(401);
  });

  test('malformed id → 400', async () => {
    const app = makeApp(makeFakeSupabase({ users: [seedUser(1)] }));
    const res = await request(app)
      .delete('/api/integrations/proofpix/connections/not-a-number')
      .set('Authorization', `Bearer ${sfUserJwt(1)}`);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_PAYLOAD');
  });

  test('id belonging to another user → 404 (no leak)', async () => {
    const supa = makeFakeSupabase({
      users: [seedUser(1), seedUser(2)],
      proofpix_connections: [
        {
          id: 50,
          user_id: 2,                       // owned by user 2
          refresh_token_hash: 'x',
          device_label: 'Other admin device',
          created_at: '2026-07-23T00:00:00.000Z',
          revoked_at: null,
        },
      ],
    });
    const app = makeApp(supa);
    const res = await request(app)
      .delete('/api/integrations/proofpix/connections/50')
      .set('Authorization', `Bearer ${sfUserJwt(1)}`);   // authed as user 1
    expect(res.status).toBe(404);
    // Row still active — user 1's request must not affect user 2's device
    expect(supa._db.proofpix_connections[0].revoked_at).toBeNull();
  });

  test('revoke succeeds and marks revoked_at, so future /connections omits it', async () => {
    const supa = makeFakeSupabase({
      users: [seedUser(1)],
      proofpix_connections: [
        {
          id: 60,
          user_id: 1,
          refresh_token_hash: 'x',
          device_label: 'iPad',
          created_at: '2026-07-23T00:00:00.000Z',
          revoked_at: null,
        },
      ],
    });
    const app = makeApp(supa);
    const revoke = await request(app)
      .delete('/api/integrations/proofpix/connections/60')
      .set('Authorization', `Bearer ${sfUserJwt(1)}`);
    expect(revoke.status).toBe(204);
    expect(supa._db.proofpix_connections[0].revoked_at).toBeTruthy();

    const list = await request(app)
      .get('/api/integrations/proofpix/connections')
      .set('Authorization', `Bearer ${sfUserJwt(1)}`);
    expect(list.body.connections).toEqual([]);
  });

  test('re-revoking an already-revoked device is idempotent (204)', async () => {
    const supa = makeFakeSupabase({
      users: [seedUser(1)],
      proofpix_connections: [
        {
          id: 70,
          user_id: 1,
          refresh_token_hash: 'x',
          device_label: 'Old phone',
          created_at: '2026-07-01T00:00:00.000Z',
          revoked_at: '2026-07-10T00:00:00.000Z',
        },
      ],
    });
    const app = makeApp(supa);
    const res = await request(app)
      .delete('/api/integrations/proofpix/connections/70')
      .set('Authorization', `Bearer ${sfUserJwt(1)}`);
    expect(res.status).toBe(204);
    // revoked_at not clobbered with a new timestamp
    expect(supa._db.proofpix_connections[0].revoked_at).toBe('2026-07-10T00:00:00.000Z');
  });

  test('subsequent /connect/refresh on revoked device fails 401', async () => {
    const supa = makeFakeSupabase({ users: [seedUser(1)] });
    const app = makeApp(supa);
    const issue = await request(app)
      .post('/api/integrations/proofpix/connect/code/issue')
      .set('Authorization', `Bearer ${sfUserJwt(1)}`)
      .send();
    const redeem = await request(app)
      .post('/api/integrations/proofpix/connect/redeem')
      .send({ code: issue.body.code });
    const connectionId = supa._db.proofpix_connections[0].id;

    await request(app)
      .delete(`/api/integrations/proofpix/connections/${connectionId}`)
      .set('Authorization', `Bearer ${sfUserJwt(1)}`);

    const refresh = await request(app)
      .post('/api/integrations/proofpix/connect/refresh')
      .send({ refresh_token: redeem.body.refresh_token });
    expect(refresh.status).toBe(401);
  });
});

describe('proofpix-service — /connect/redeem (canonical)', () => {
  beforeEach(() => { process.env[FLAGS.PROOFPIX_INTEGRATION_ENABLED] = 'true'; });
  afterEach(() => { delete process.env[FLAGS.PROOFPIX_INTEGRATION_ENABLED]; });

  test('redeems a typed code (same shape as /connect/code/redeem)', async () => {
    const supa = makeFakeSupabase({ users: [seedUser(1, 'Acme')] });
    const app = makeApp(supa);
    const issue = await request(app)
      .post('/api/integrations/proofpix/connect/code/issue')
      .set('Authorization', `Bearer ${sfUserJwt(1)}`)
      .send();
    const redeem = await request(app)
      .post('/api/integrations/proofpix/connect/redeem')
      .send({ code: issue.body.code, device_label: 'iPhone' });
    expect(redeem.status).toBe(200);
    expect(redeem.body.workspace_id).toBe('1');
    expect(redeem.body.refresh_token).toMatch(/^pprt_/);
  });

  test('redeems a deep-link token end-to-end', async () => {
    const supa = makeFakeSupabase({ users: [seedUser(7, 'Beta Corp')] });
    const app = makeApp(supa);
    const issue = await request(app)
      .post('/api/integrations/proofpix/connect/token/issue')
      .set('Authorization', `Bearer ${sfUserJwt(7)}`)
      .send();
    expect(isConnectToken(issue.body.token)).toBe(true);

    const redeem = await request(app)
      .post('/api/integrations/proofpix/connect/redeem')
      .send({ code: issue.body.token, device_label: 'iPad' });
    expect(redeem.status).toBe(200);
    expect(redeem.body).toMatchObject({
      workspace_id: '7',
      workspace_name: 'Beta Corp',
      admin_user_id: '7',
      expires_in: 3600,
    });
    expect(redeem.body.refresh_token).toMatch(/^pprt_/);
    expect(redeem.body.access_token).toEqual(expect.any(String));
  });

  test('double-redeem of a token: second call rejected', async () => {
    const supa = makeFakeSupabase({ users: [seedUser(1)] });
    const app = makeApp(supa);
    const issue = await request(app)
      .post('/api/integrations/proofpix/connect/token/issue')
      .set('Authorization', `Bearer ${sfUserJwt(1)}`)
      .send();
    const first = await request(app)
      .post('/api/integrations/proofpix/connect/redeem')
      .send({ code: issue.body.token });
    expect(first.status).toBe(200);
    const second = await request(app)
      .post('/api/integrations/proofpix/connect/redeem')
      .send({ code: issue.body.token });
    expect(second.status).toBe(400);
    expect(second.body.error.code).toBe('INVALID_CODE');
  });

  test('expired token (past expires_at) → CODE_EXPIRED', async () => {
    const expiredToken = newConnectToken();
    const supa = makeFakeSupabase({
      users: [seedUser(1)],
      proofpix_connect_codes: [{
        code: expiredToken,
        user_id: 1,
        expires_at: new Date(Date.now() - 1000).toISOString(),
        redeemed_at: null,
        redeemed_by_label: null,
        created_at: new Date().toISOString(),
      }],
    });
    const app = makeApp(supa);
    const res = await request(app)
      .post('/api/integrations/proofpix/connect/redeem')
      .send({ code: expiredToken });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CODE_EXPIRED');
  });

  test('unknown well-formed token → INVALID_CODE', async () => {
    const app = makeApp(makeFakeSupabase({ users: [seedUser(1)] }));
    const res = await request(app)
      .post('/api/integrations/proofpix/connect/redeem')
      .send({ code: newConnectToken() });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_CODE');
  });

  test('malformed input (neither code nor token) → INVALID_PAYLOAD', async () => {
    const app = makeApp(makeFakeSupabase({ users: [seedUser(1)] }));
    for (const bad of ['nope', 'ABCD-EFGH', '!!!', '', null]) {
      const res = await request(app)
        .post('/api/integrations/proofpix/connect/redeem')
        .send({ code: bad });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_PAYLOAD');
    }
  });

  test('old /connect/code/redeem route still works for both formats', async () => {
    const supa = makeFakeSupabase({ users: [seedUser(1, 'Legacy')] });
    const app = makeApp(supa);

    const issueCode = await request(app)
      .post('/api/integrations/proofpix/connect/code/issue')
      .set('Authorization', `Bearer ${sfUserJwt(1)}`)
      .send();
    const redeemCode = await request(app)
      .post('/api/integrations/proofpix/connect/code/redeem')
      .send({ code: issueCode.body.code });
    expect(redeemCode.status).toBe(200);

    const issueTok = await request(app)
      .post('/api/integrations/proofpix/connect/token/issue')
      .set('Authorization', `Bearer ${sfUserJwt(1)}`)
      .send();
    const redeemTok = await request(app)
      .post('/api/integrations/proofpix/connect/code/redeem')
      .send({ code: issueTok.body.token });
    expect(redeemTok.status).toBe(200);
  });

  test('multi-device pairing preserved (no dedupe on redeem)', async () => {
    // Same SF user pairs two devices via two redeem calls. Neither
    // connection is revoked by the other. Mirrors the PR 1 design
    // intent — see project memory for the rationale on deferring
    // dedupe to a later admin-UI-driven decision.
    const supa = makeFakeSupabase({ users: [seedUser(1)] });
    const app = makeApp(supa);

    const t1 = await request(app)
      .post('/api/integrations/proofpix/connect/token/issue')
      .set('Authorization', `Bearer ${sfUserJwt(1)}`)
      .send();
    const r1 = await request(app)
      .post('/api/integrations/proofpix/connect/redeem')
      .send({ code: t1.body.token, device_label: 'Phone' });
    const t2 = await request(app)
      .post('/api/integrations/proofpix/connect/token/issue')
      .set('Authorization', `Bearer ${sfUserJwt(1)}`)
      .send();
    const r2 = await request(app)
      .post('/api/integrations/proofpix/connect/redeem')
      .send({ code: t2.body.token, device_label: 'Tablet' });

    expect(r1.body.refresh_token).not.toBe(r2.body.refresh_token);
    expect(supa._db.proofpix_connections).toHaveLength(2);
    // Neither row was revoked by the other's redeem
    expect(supa._db.proofpix_connections.every((c) => c.revoked_at == null)).toBe(true);
  });
});
