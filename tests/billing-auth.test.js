/**
 * PR-S1 — billing route auth + IDOR enforcement tests.
 *
 * server.js is too large to require() into a Jest test, so this suite
 * uses two strategies:
 *   1. Source-level invariants — assert that the five /api/user/billing/*
 *      route registrations in server.js are decorated with authenticateToken.
 *   2. Behavioral check — exercise a minimal Express harness mirroring the
 *      PR-S1 `resolveBillingUserId` helper, verifying warning-only mismatch
 *      behavior (legacy body.userId still allowed when it matches; warning
 *      logged when it differs; never 403).
 */

const fs = require('fs');
const path = require('path');
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const SERVER_SRC = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

describe('PR-S1 — source invariants on /api/user/billing/* routes', () => {
  // Each line below MUST exist in server.js with authenticateToken AND
  // requireBillingOwner (in that order). If a future refactor drops
  // either middleware, this test fails the build.
  const billingRoutePatterns = [
    /app\.get\(\s*'\/api\/user\/billing'\s*,\s*authenticateToken\s*,\s*requireBillingOwner\s*,/,
    /app\.post\(\s*'\/api\/user\/billing\/setup-intent'\s*,\s*authenticateToken\s*,\s*requireBillingOwner\s*,/,
    /app\.post\(\s*'\/api\/user\/billing\/subscription'\s*,\s*authenticateToken\s*,\s*requireBillingOwner\s*,/,
    /app\.get\(\s*'\/api\/user\/billing\/payment-methods'\s*,\s*authenticateToken\s*,\s*requireBillingOwner\s*,/,
    /app\.post\(\s*'\/api\/user\/billing\/cancel-subscription'\s*,\s*authenticateToken\s*,\s*requireBillingOwner\s*,/,
  ];

  for (const pattern of billingRoutePatterns) {
    test(`route is gated by authenticateToken + requireBillingOwner: ${pattern}`, () => {
      expect(SERVER_SRC).toMatch(pattern);
    });
  }

  test('resolveBillingUserId helper is defined in server.js', () => {
    expect(SERVER_SRC).toMatch(/function\s+resolveBillingUserId\s*\(\s*req\s*\)/);
  });

  test('requireBillingOwner helper is defined in server.js', () => {
    expect(SERVER_SRC).toMatch(/function\s+requireBillingOwner\s*\(\s*req\s*,\s*res\s*,\s*next\s*\)/);
  });

  test('no unauthenticated /api/user/billing/* route exists', () => {
    // Find any app.<verb>('/api/user/billing...') line and assert it has
    // authenticateToken in the same registration line OR on the next non-blank line.
    const lines = SERVER_SRC.split('\n');
    const routeLineRe = /app\.(get|post|put|patch|delete)\(\s*'\/api\/user\/billing[^']*'/;
    const offenders = [];
    lines.forEach((line, i) => {
      if (routeLineRe.test(line)) {
        // Inspect the line itself + next 3 lines for the middleware token
        const window = lines.slice(i, i + 4).join(' ');
        if (!/authenticateToken/.test(window)) {
          offenders.push({ lineNumber: i + 1, line: line.trim().slice(0, 120) });
        }
      }
    });
    expect(offenders).toEqual([]);
  });
});

describe('PR-S1 — resolveBillingUserId behavior (in-process harness)', () => {
  // Reimplement the helper exactly as in server.js to test the policy.
  // If server.js ever drifts from this spec, the source-invariant test
  // above will not catch the body — but the contract is small enough
  // that an inline duplicate is acceptable and the test is the canonical
  // behavior reference.
  function buildHarness({ jwtSecret = 'test-secret' } = {}) {
    const app = express();
    app.use(express.json());
    const warnings = [];
    const logger = { warn: (msg) => warnings.push(msg) };

    function authenticateToken(req, res, next) {
      const token = (req.headers['authorization'] || '').split(' ')[1];
      if (!token) return res.status(401).json({ error: 'No token provided' });
      try {
        req.user = jwt.verify(token, jwtSecret);
        next();
      } catch {
        return res.status(401).json({ error: 'Invalid token' });
      }
    }

    function resolveBillingUserId(req) {
      const fromJwt = req.user && req.user.userId;
      if (fromJwt === undefined || fromJwt === null) return null;
      const jwtIdStr = String(fromJwt);
      const sources = [];
      if (req.body && req.body.userId !== undefined) sources.push(['body', String(req.body.userId)]);
      if (req.query && req.query.userId !== undefined) sources.push(['query', String(req.query.userId)]);
      for (const [src, value] of sources) {
        if (value !== jwtIdStr) {
          logger.warn(`[Billing IDOR] ${src}.userId="${value}" does not match JWT userId="${jwtIdStr}" — using JWT (cross-user attempt or stale client)`);
        }
      }
      return fromJwt;
    }

    app.post('/billing/test', authenticateToken, (req, res) => {
      const userId = resolveBillingUserId(req);
      if (userId == null) return res.status(401).json({ error: 'authentication_required' });
      res.json({ userId, warnings });
    });

    return { app, sign: (payload) => jwt.sign(payload, jwtSecret, { expiresIn: '5m' }), warnings };
  }

  test('401 when no Authorization header', async () => {
    const { app } = buildHarness();
    const res = await request(app).post('/billing/test').send({});
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('No token provided');
  });

  test('200 + JWT userId when token present and no body userId', async () => {
    const { app, sign } = buildHarness();
    const token = sign({ userId: 42 });
    const res = await request(app).post('/billing/test').set('Authorization', `Bearer ${token}`).send({});
    expect(res.status).toBe(200);
    expect(res.body.userId).toBe(42);
    expect(res.body.warnings).toEqual([]);
  });

  test('200 + JWT userId + no warning when body userId matches JWT', async () => {
    const { app, sign } = buildHarness();
    const token = sign({ userId: 42 });
    const res = await request(app).post('/billing/test').set('Authorization', `Bearer ${token}`).send({ userId: 42 });
    expect(res.status).toBe(200);
    expect(res.body.userId).toBe(42);
    expect(res.body.warnings).toEqual([]);
  });

  test('200 + JWT userId + warning logged when body userId differs (warning-only policy)', async () => {
    const { app, sign } = buildHarness();
    const token = sign({ userId: 42 });
    const res = await request(app).post('/billing/test').set('Authorization', `Bearer ${token}`).send({ userId: 999 });
    expect(res.status).toBe(200); // NOT 403 — warning-only per PR-S1 design
    expect(res.body.userId).toBe(42); // JWT wins
    expect(res.body.warnings).toHaveLength(1);
    expect(res.body.warnings[0]).toMatch(/Billing IDOR.*body\.userId="999".*JWT userId="42"/);
  });

  test('200 + warning logged when query userId differs from JWT', async () => {
    const { app, sign } = buildHarness();
    const token = sign({ userId: 42 });
    const res = await request(app).post('/billing/test?userId=999').set('Authorization', `Bearer ${token}`).send({});
    expect(res.status).toBe(200);
    expect(res.body.userId).toBe(42);
    expect(res.body.warnings[0]).toMatch(/query\.userId="999"/);
  });

  test('numeric vs string userId equality (body sends "42" matches JWT 42)', async () => {
    const { app, sign } = buildHarness();
    const token = sign({ userId: 42 });
    const res = await request(app).post('/billing/test').set('Authorization', `Bearer ${token}`).send({ userId: '42' });
    expect(res.body.warnings).toEqual([]);
  });
});

describe('PR-S1 — requireBillingOwner gate (in-process harness)', () => {
  function buildHarness({ jwtSecret = 'test-secret' } = {}) {
    const app = express();
    app.use(express.json());

    function authenticateToken(req, res, next) {
      const token = (req.headers['authorization'] || '').split(' ')[1];
      if (!token) return res.status(401).json({ error: 'No token provided' });
      try { req.user = jwt.verify(token, jwtSecret); next(); }
      catch { return res.status(401).json({ error: 'Invalid token' }); }
    }

    function requireBillingOwner(req, res, next) {
      const role = String((req.user && req.user.role) || '').toLowerCase();
      const isOwnerOrAdmin = role === 'account owner' || role === 'owner' || role === 'admin';
      const isTeamMember = !!(req.user && req.user.teamMemberId);
      if (!isOwnerOrAdmin || isTeamMember) {
        return res.status(403).json({ error: 'billing_owner_only' });
      }
      next();
    }

    app.post('/billing/owner-only', authenticateToken, requireBillingOwner, (req, res) => {
      res.json({ ok: true, userId: req.user.userId });
    });

    return { app, sign: (payload) => jwt.sign(payload, jwtSecret, { expiresIn: '5m' }) };
  }

  test('account-owner role → 200', async () => {
    const { app, sign } = buildHarness();
    const token = sign({ userId: 1, role: 'account owner' });
    const res = await request(app).post('/billing/owner-only').set('Authorization', `Bearer ${token}`).send({});
    expect(res.status).toBe(200);
  });

  test('owner role → 200', async () => {
    const { app, sign } = buildHarness();
    const token = sign({ userId: 1, role: 'owner' });
    const res = await request(app).post('/billing/owner-only').set('Authorization', `Bearer ${token}`).send({});
    expect(res.status).toBe(200);
  });

  test('admin role → 200', async () => {
    const { app, sign } = buildHarness();
    const token = sign({ userId: 1, role: 'admin' });
    const res = await request(app).post('/billing/owner-only').set('Authorization', `Bearer ${token}`).send({});
    expect(res.status).toBe(200);
  });

  test('team-member JWT (teamMemberId set) → 403 billing_owner_only', async () => {
    const { app, sign } = buildHarness();
    const token = sign({ userId: 99, role: 'cleaner', teamMemberId: 5 });
    const res = await request(app).post('/billing/owner-only').set('Authorization', `Bearer ${token}`).send({});
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('billing_owner_only');
  });

  test('worker/cleaner role without teamMemberId → 403 (not an owner)', async () => {
    const { app, sign } = buildHarness();
    const token = sign({ userId: 99, role: 'worker' });
    const res = await request(app).post('/billing/owner-only').set('Authorization', `Bearer ${token}`).send({});
    expect(res.status).toBe(403);
  });

  test('no role claim at all → 403 (closed by default)', async () => {
    const { app, sign } = buildHarness();
    const token = sign({ userId: 1 });
    const res = await request(app).post('/billing/owner-only').set('Authorization', `Bearer ${token}`).send({});
    expect(res.status).toBe(403);
  });

  test('owner role BUT teamMemberId set (impersonation guard) → 403', async () => {
    // Edge case: JWT claims account-owner role AND teamMemberId. The
    // teamMemberId field is the "you're acting as a team member"
    // signal — block billing actions regardless of role claim.
    const { app, sign } = buildHarness();
    const token = sign({ userId: 1, role: 'account owner', teamMemberId: 7 });
    const res = await request(app).post('/billing/owner-only').set('Authorization', `Bearer ${token}`).send({});
    expect(res.status).toBe(403);
  });
});
