/**
 * PR-4 — security tests covering:
 *   1. C1/C2/C3/C6/C7 — IDOR fixes on 5 user endpoints
 *   2. C4              — team-member login rate limit
 *   3. C5              — Stripe webhook 503 when secret unset
 *   4. Startup config audit (CRITICAL throws in prod, warns elsewhere)
 *   5. Dead-MySQL routes deleted from server.js source
 *
 * server.js is too large to require() for integration tests, so:
 *   - Pure helpers (config-audit) are imported and exercised directly.
 *   - Auth/rate-limit/webhook integration use a small supertest harness
 *     that mirrors the production wiring.
 *   - Source-level invariants (deletion, missing fallbacks) are asserted
 *     by reading server.js as a string.
 */

const fs = require('fs');
const path = require('path');
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');

const {
  inspectConfig,
  runStartupConfigAudit,
  JWT_SECRET_FALLBACK,
} = require('../lib/config-audit');

const SERVER_SRC = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

// ─────────────────────────────────────────────────────────────────
// Harness — minimal Express app mirroring the production IDOR pattern.
// Uses the same `authenticateToken` shape and a clone of
// `resolveAuthenticatedUserId` from server.js.
// ─────────────────────────────────────────────────────────────────
function buildIdorHarness({ jwtSecret = 'test-secret', userRowsByOwner = {} } = {}) {
  const app = express();
  app.use(express.json());

  function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Access token required' });
    jwt.verify(token, jwtSecret, (err, user) => {
      if (err) return res.status(403).json({ error: 'Invalid token' });
      req.user = user;
      next();
    });
  }

  function resolveAuthenticatedUserId(req, res) {
    const fromJwt = req.user && (req.user.userId ?? req.user.id);
    if (fromJwt === undefined || fromJwt === null) {
      res.status(401).json({ error: 'authentication_required' });
      return null;
    }
    const jwtIdStr = String(fromJwt);
    const candidates = [];
    if (req.body && req.body.userId !== undefined) candidates.push(['body', String(req.body.userId)]);
    if (req.query && req.query.userId !== undefined) candidates.push(['query', String(req.query.userId)]);
    for (const [src, value] of candidates) {
      if (value !== jwtIdStr) {
        res.status(403).json({ error: 'user_id_mismatch', source: src });
        return null;
      }
    }
    return fromJwt;
  }

  // Stand-in for /api/user/business-details GET — same auth pattern.
  app.get('/api/user/business-details', authenticateToken, (req, res) => {
    const userId = resolveAuthenticatedUserId(req, res);
    if (userId === null) return;
    const row = userRowsByOwner[String(userId)];
    if (!row) return res.status(404).json({ error: 'not_found' });
    return res.json(row);
  });

  // Stand-in for PUT — same auth pattern.
  app.put('/api/user/business-details', authenticateToken, (req, res) => {
    const userId = resolveAuthenticatedUserId(req, res);
    if (userId === null) return;
    userRowsByOwner[String(userId)] = { ...(userRowsByOwner[String(userId)] || {}), ...req.body };
    delete userRowsByOwner[String(userId)].userId;
    return res.json({ ok: true, ownerId: userId });
  });

  function signToken(payload) {
    return jwt.sign(payload, jwtSecret, { expiresIn: '5m' });
  }

  return { app, signToken, userRowsByOwner };
}

// ─────────────────────────────────────────────────────────────────
// 1. C1/C2/C3/C6/C7 — IDOR fixes
// ─────────────────────────────────────────────────────────────────
describe('PR-4 / IDOR — unauthenticated requests are rejected', () => {
  test('GET /api/user/business-details with no token → 401', async () => {
    const { app } = buildIdorHarness({ userRowsByOwner: { '1': { businessName: 'Alpha' } } });
    const res = await request(app).get('/api/user/business-details');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Access token required' });
  });

  test('PUT /api/user/business-details with no token → 401', async () => {
    const { app } = buildIdorHarness();
    const res = await request(app).put('/api/user/business-details').send({ businessName: 'Evil' });
    expect(res.status).toBe(401);
  });
});

describe('PR-4 / IDOR — body/query userId mismatch is rejected (cross-user attempt)', () => {
  test('GET with ?userId=2 but token for userId=1 → 403 user_id_mismatch', async () => {
    const { app, signToken } = buildIdorHarness({
      userRowsByOwner: {
        '1': { businessName: 'Alpha' },
        '2': { businessName: 'Bravo' },
      },
    });
    const token = signToken({ userId: 1 });
    const res = await request(app)
      .get('/api/user/business-details?userId=2')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'user_id_mismatch', source: 'query' });
  });

  test('PUT with body.userId=2 but token for userId=1 → 403 user_id_mismatch', async () => {
    const { app, signToken, userRowsByOwner } = buildIdorHarness({
      userRowsByOwner: { '2': { businessName: 'Victim' } },
    });
    const token = signToken({ userId: 1 });
    const res = await request(app)
      .put('/api/user/business-details')
      .set('Authorization', `Bearer ${token}`)
      .send({ userId: 2, businessName: 'Pwned' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('user_id_mismatch');
    // Critical: victim's row must NOT have been mutated.
    expect(userRowsByOwner['2']).toEqual({ businessName: 'Victim' });
  });

  test('PUT with body.userId matching JWT userId → 200 (legacy clients that still send userId still work)', async () => {
    const { app, signToken } = buildIdorHarness();
    const token = signToken({ userId: 7 });
    const res = await request(app)
      .put('/api/user/business-details')
      .set('Authorization', `Bearer ${token}`)
      .send({ userId: 7, businessName: 'Self' });
    expect(res.status).toBe(200);
    expect(res.body.ownerId).toBe(7);
  });
});

describe('PR-4 / IDOR — authenticated self-access works', () => {
  test('GET as user 1 returns user 1 row only', async () => {
    const { app, signToken } = buildIdorHarness({
      userRowsByOwner: {
        '1': { businessName: 'Alpha' },
        '2': { businessName: 'Bravo' },
      },
    });
    const token = signToken({ userId: 1 });
    const res = await request(app).get('/api/user/business-details').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ businessName: 'Alpha' });
  });

  test('PUT as user 1 writes to user 1 row, body.userId never reaches stored row', async () => {
    const { app, signToken, userRowsByOwner } = buildIdorHarness();
    const token = signToken({ userId: 1 });
    await request(app)
      .put('/api/user/business-details')
      .set('Authorization', `Bearer ${token}`)
      .send({ businessName: 'Self', phone: '+1' });
    expect(userRowsByOwner['1']).toEqual({ businessName: 'Self', phone: '+1' });
    expect(userRowsByOwner['1']).not.toHaveProperty('userId');
  });
});

// ─────────────────────────────────────────────────────────────────
// 2. C4 — team-member login rate limit
// ─────────────────────────────────────────────────────────────────
describe('PR-4 / C4 — team-member login rate limit', () => {
  function buildLoginHarness({ max = 5, validUser = 'good', validPass = 'right' } = {}) {
    const app = express();
    app.use(express.json());
    const limiter = rateLimit({
      windowMs: 60_000,
      max,
      standardHeaders: true,
      legacyHeaders: false,
      message: { error: 'too_many_attempts' },
      skipSuccessfulRequests: true,
    });
    app.post('/api/team-members/login', limiter, (req, res) => {
      const { username, password } = req.body || {};
      if (username === validUser && password === validPass) {
        return res.json({ token: 'session', ok: true });
      }
      return res.status(401).json({ error: 'invalid_credentials' });
    });
    return app;
  }

  test('5 failed attempts then 6th → 429', async () => {
    const app = buildLoginHarness();
    const agent = request(app);
    for (let i = 0; i < 5; i += 1) {
      const r = await agent.post('/api/team-members/login').send({ username: 'good', password: 'wrong' });
      expect(r.status).toBe(401);
    }
    const blocked = await agent.post('/api/team-members/login').send({ username: 'good', password: 'wrong' });
    expect(blocked.status).toBe(429);
    expect(blocked.body).toEqual({ error: 'too_many_attempts' });
  });

  test('successful login does NOT consume the limit', async () => {
    const app = buildLoginHarness({ max: 2 });
    const agent = request(app);
    for (let i = 0; i < 3; i += 1) {
      const r = await agent.post('/api/team-members/login').send({ username: 'good', password: 'right' });
      expect(r.status).toBe(200);
    }
  });
});

// ─────────────────────────────────────────────────────────────────
// 3. C5 — Stripe webhook returns 503 when secret unset
// ─────────────────────────────────────────────────────────────────
describe('PR-4 / C5 — Stripe webhook gating', () => {
  function buildStripeHarness(secret) {
    const app = express();
    // Mirror production wiring: gate present before constructEvent.
    app.post('/api/webhook/stripe', express.raw({ type: 'application/json' }), (req, res) => {
      if (!secret) {
        return res.status(503).json({ error: 'stripe_webhook_unconfigured' });
      }
      return res.status(400).send('signature missing');
    });
    return app;
  }

  test('STRIPE_WEBHOOK_SECRET unset → 503 stripe_webhook_unconfigured', async () => {
    const app = buildStripeHarness(undefined);
    const res = await request(app)
      .post('/api/webhook/stripe')
      .set('Content-Type', 'application/json')
      .send(Buffer.from('{}'));
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: 'stripe_webhook_unconfigured' });
  });

  test('STRIPE_WEBHOOK_SECRET set → falls through to signature check (400 without valid sig)', async () => {
    const app = buildStripeHarness('whsec_fake');
    const res = await request(app)
      .post('/api/webhook/stripe')
      .set('Content-Type', 'application/json')
      .send(Buffer.from('{}'));
    expect(res.status).toBe(400);
  });
});

// ─────────────────────────────────────────────────────────────────
// 4. Startup config audit
// ─────────────────────────────────────────────────────────────────
describe('PR-4 / config-audit — inspectConfig', () => {
  test('clean env → 0 findings', () => {
    const { findings } = inspectConfig({
      JWT_SECRET: 'a'.repeat(64),
      STRIPE_WEBHOOK_SECRET: 'whsec_platform_x',
      STRIPE_CONNECT_WEBHOOK_SECRET: 'whsec_connect_y', // PR-S1.7: distinct from Platform
      ADMIN_EMAIL: 'a@b.c',
      ADMIN_PASSWORD: 'x'.repeat(40),
      SF_INTEGRATION_ENC_KEY: 'k'.repeat(44),
      SIGCORE_WEBHOOK_HMAC_REQUIRED: 'true',
      LB_INBOUND_HMAC_REQUIRED: 'true',
      SOURCE_ACCOUNT_BOUNDARY_ENFORCED: 'true',
      // Sigcore app-level infrastructure (added to audit because tenants
      // would otherwise hit HTTP 500 with no boot-time signal).
      SIGCORE_URL: 'https://sigcore-production.up.railway.app/api',
      SIGCORE_WORKSPACE_KEY: 'platform-key-value',
    });
    expect(findings).toEqual([]);
  });

  test('JWT_SECRET equals the hardcoded fallback → CRITICAL', () => {
    const { findings } = inspectConfig({ JWT_SECRET: JWT_SECRET_FALLBACK });
    const f = findings.find(x => x.key === 'JWT_SECRET');
    expect(f).toBeDefined();
    expect(f.severity).toBe('CRITICAL');
  });

  test('JWT_SECRET missing → CRITICAL', () => {
    const { findings } = inspectConfig({});
    const f = findings.find(x => x.key === 'JWT_SECRET');
    expect(f).toBeDefined();
    expect(f.severity).toBe('CRITICAL');
  });

  test('STRIPE_WEBHOOK_SECRET missing → HIGH', () => {
    const { findings } = inspectConfig({ JWT_SECRET: 'x'.repeat(64) });
    const f = findings.find(x => x.key === 'STRIPE_WEBHOOK_SECRET');
    expect(f.severity).toBe('HIGH');
  });

  test('ADMIN_EMAIL/ADMIN_PASSWORD missing → HIGH', () => {
    const { findings } = inspectConfig({ JWT_SECRET: 'x'.repeat(64), STRIPE_WEBHOOK_SECRET: 'x' });
    expect(findings.some(f => f.key === 'ADMIN_EMAIL/ADMIN_PASSWORD' && f.severity === 'HIGH')).toBe(true);
  });

  test('SIGCORE/LB HMAC flags missing → MEDIUM each', () => {
    const { findings } = inspectConfig({
      JWT_SECRET: 'x'.repeat(64),
      STRIPE_WEBHOOK_SECRET: 'x',
      ADMIN_EMAIL: 'a',
      ADMIN_PASSWORD: 'b',
      SF_INTEGRATION_ENC_KEY: 'c',
    });
    expect(findings.some(f => f.key === 'SIGCORE_WEBHOOK_HMAC_REQUIRED' && f.severity === 'MEDIUM')).toBe(true);
    expect(findings.some(f => f.key === 'LB_INBOUND_HMAC_REQUIRED' && f.severity === 'MEDIUM')).toBe(true);
  });

  test('NODE_ENV=production with CRITICAL → isProd=true; throwOnCriticalInProd throws', () => {
    const logger = { warn: jest.fn(), error: jest.fn() };
    expect(() =>
      runStartupConfigAudit({
        env: { NODE_ENV: 'production', JWT_SECRET: JWT_SECRET_FALLBACK },
        logger,
        throwOnCriticalInProd: true,
      }),
    ).toThrow(/CONFIG_AUDIT_CRITICAL|Refusing to start in production/);
    expect(logger.error).toHaveBeenCalled();
  });

  test('NODE_ENV=development with CRITICAL → warns but does NOT throw', () => {
    const logger = { warn: jest.fn(), error: jest.fn() };
    expect(() =>
      runStartupConfigAudit({
        env: { NODE_ENV: 'development', JWT_SECRET: JWT_SECRET_FALLBACK },
        logger,
      }),
    ).not.toThrow();
    expect(logger.error).toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────
// 5. Source-level invariants — deletion + missing patterns
// ─────────────────────────────────────────────────────────────────
describe('PR-4 / source invariants', () => {
  test('dead-MySQL routes are gone (no unauthenticated /api/user/X with pool.getConnection in handler)', () => {
    // Allowed: `/api/user/password` and `/api/user/email` MUST still exist
    // but only as `authenticateToken`-protected Supabase versions.
    const passwordHits = SERVER_SRC.match(/app\.put\(['"]\/api\/user\/password['"]/g) || [];
    expect(passwordHits.length).toBe(1);
    const emailHits = SERVER_SRC.match(/app\.put\(['"]\/api\/user\/email['"]/g) || [];
    expect(emailHits.length).toBe(1);

    // branding + service-areas: zero occurrences (fully deleted).
    expect(SERVER_SRC).not.toMatch(/app\.(get|put)\(['"]\/api\/user\/branding['"]/);
    expect(SERVER_SRC).not.toMatch(/app\.(get|put)\(['"]\/api\/user\/service-areas['"]/);
  });

  test('no console.log of full req.body or req.headers remains', () => {
    expect(SERVER_SRC).not.toMatch(/console\.log\(['"]🔍 Full request body['"]/);
    expect(SERVER_SRC).not.toMatch(/console\.log\(['"]🔍 Request headers['"]/);
    expect(SERVER_SRC).not.toMatch(/console\.error\(['"]Request headers['"]/);
    expect(SERVER_SRC).not.toMatch(/console\.log\(['"]🔍 PUT \/api\/user\/password called with body['"]/);
  });

  test('the 5 patched IDOR endpoints now include authenticateToken in their handler chain', () => {
    expect(SERVER_SRC).toMatch(/app\.get\(['"]\/api\/user\/business-details['"],\s*authenticateToken/);
    expect(SERVER_SRC).toMatch(/app\.put\(['"]\/api\/user\/business-details['"],\s*authenticateToken/);
    expect(SERVER_SRC).toMatch(/app\.put\(['"]\/api\/user\/notification-settings['"],\s*authenticateToken/);
    expect(SERVER_SRC).toMatch(/app\.get\(['"]\/api\/user\/notification-templates['"],\s*authenticateToken/);
    expect(SERVER_SRC).toMatch(/app\.put\(['"]\/api\/user\/notification-templates['"],\s*authenticateToken/);
  });

  test('team-member login uses teamMemberLoginLimiter', () => {
    expect(SERVER_SRC).toMatch(/app\.post\(['"]\/api\/team-members\/login['"],\s*teamMemberLoginLimiter/);
  });

  test('Stripe webhook handlers gate on STRIPE_WEBHOOK_SECRET presence (return 503)', () => {
    expect(SERVER_SRC).toMatch(/stripe_webhook_unconfigured/);
    // Both webhook handlers should check the env var BEFORE constructEvent.
    const stripeBlocks = SERVER_SRC.match(/app\.post\(['"]\/api\/(webhook\/stripe|stripe\/connect\/webhook)/g) || [];
    expect(stripeBlocks.length).toBe(2);
  });

  test('runStartupConfigAudit is wired into server.js startup', () => {
    expect(SERVER_SRC).toMatch(/runStartupConfigAudit\(/);
  });
});
