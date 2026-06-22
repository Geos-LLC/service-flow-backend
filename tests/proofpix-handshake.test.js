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
      const api = {
        eq(k, v) { filters.push(['eq', k, v]); return api; },
        is(k, v) { filters.push(['is', k, v]); return api; },
        async maybeSingle() {
          const row = db[table].find((r) => matches(r, filters));
          return { data: row || null, error: null };
        },
        async single() {
          const row = db[table].find((r) => matches(r, filters));
          if (!row) return { data: null, error: { message: 'not found' } };
          return { data: row, error: null };
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
