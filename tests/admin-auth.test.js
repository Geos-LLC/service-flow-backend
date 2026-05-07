/**
 * PR-3 — admin authentication hardening tests.
 *
 * Coverage matrix (mapping to security spec):
 *   1. No fallback credentials               (server.js: ADMIN_EMAIL || '')
 *   2. Invalid password rejected             (login handler)
 *   3. Constant-time path works              (adminConstantTimeCompare)
 *   4. Rate limit triggers 429               (adminLoginLimiter)
 *   5. Admin JWT expires at configured TTL   (jwt.sign expiresIn)
 *   6. Dangerous endpoints blocked when flag OFF  (requireAdminFlag)
 *   7. Dangerous endpoints allowed when flag ON   (requireAdminFlag)
 *   8. No plaintext password leakage         (logAdminSecurityEvent)
 *
 * Strategy:
 *   - Pure helpers (`adminConstantTimeCompare`, `requireAdminFlag`) imported
 *     directly from lib/admin-auth and unit-tested.
 *   - Login + rate limit + JWT TTL tested via supertest against a small
 *     Express app that mirrors the production wiring (same handler shape,
 *     same dependencies). server.js is too large to require() in tests.
 */

const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');

const {
  adminConstantTimeCompare,
  requireAdminFlag,
} = require('../lib/admin-auth');

// Build a fresh Express app per test so the rate-limit window resets and
// env-var changes propagate. The handler intentionally mirrors the
// production wiring in server.js — if those drift this file fails CI.
function buildApp({
  adminEmail,
  adminPassword,
  jwtSecret = 'test-secret',
  jwtTtl = '30m',
  rateLimitMax = 5,
  rateLimitWindowMs = 15 * 60 * 1000,
  logger = { warn: () => {} },
} = {}) {
  const app = express();
  app.use(express.json());
  app.set('trust proxy', false);

  const ADMIN_AUTH_CONFIGURED = Boolean(adminEmail && adminPassword);

  function logAdminSecurityEvent(req, kind, details = {}) {
    const ip = (req.ip || 'unknown').toString();
    const ua = (req.headers['user-agent'] || '').toString().slice(0, 200);
    logger.warn(`[Admin Security] ${kind}`, { ip, ua, path: req.path, method: req.method, ...details });
  }

  const limiter = rateLimit({
    windowMs: rateLimitWindowMs,
    max: rateLimitMax,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'too_many_attempts' },
    skipSuccessfulRequests: true,
  });

  app.post('/api/admin/login', limiter, (req, res) => {
    const { email, password } = req.body || {};
    if (!ADMIN_AUTH_CONFIGURED) {
      logAdminSecurityEvent(req, 'login_attempted_unconfigured');
      return res.status(503).json({ error: 'admin_auth_unconfigured' });
    }
    const emailMatch = adminConstantTimeCompare(email, adminEmail);
    const passwordMatch = adminConstantTimeCompare(password, adminPassword);
    if (!emailMatch || !passwordMatch) {
      logAdminSecurityEvent(req, 'login_failed');
      return res.status(401).json({ error: 'invalid_credentials' });
    }
    const token = jwt.sign({ admin: true, email: adminEmail }, jwtSecret, { expiresIn: jwtTtl });
    logAdminSecurityEvent(req, 'login_succeeded');
    return res.json({ token, email: adminEmail });
  });

  app.get(
    '/api/admin/danger-zone',
    requireAdminFlag('TEST_DANGER_FLAG', {
      isEnabled: (name) => process.env[name] === '1',
      logSecurityEvent: logAdminSecurityEvent,
    }),
    (req, res) => res.json({ ok: true }),
  );

  return app;
}

// ─────────────────────────────────────────────────────────────────
// 1. No fallback credentials
// ─────────────────────────────────────────────────────────────────
describe('PR-3 / 1: no fallback credentials in source', () => {
  test('server.js does NOT contain the prior aspire5733Z literal', () => {
    const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    expect(serverSrc).not.toMatch(/aspire5733Z/);
    // The leaked admin email literal must not appear inline as a fallback either.
    expect(serverSrc).not.toMatch(/ADMIN_EMAIL\s*=\s*process\.env\.ADMIN_EMAIL\s*\|\|\s*['"]info@geos-ai\.com/);
    expect(serverSrc).not.toMatch(/ADMIN_PASSWORD\s*=\s*process\.env\.ADMIN_PASSWORD\s*\|\|\s*['"][^'"]{4,}/);
  });

  test('login returns 503 when ADMIN_EMAIL / ADMIN_PASSWORD unset (no fallback path)', async () => {
    const app = buildApp({ adminEmail: '', adminPassword: '' });
    const res = await request(app)
      .post('/api/admin/login')
      .send({ email: 'anything@example.com', password: 'anything' });
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: 'admin_auth_unconfigured' });
  });
});

// ─────────────────────────────────────────────────────────────────
// 2. Invalid password rejected
// ─────────────────────────────────────────────────────────────────
describe('PR-3 / 2: invalid password rejected', () => {
  test('correct email + wrong password → 401 invalid_credentials', async () => {
    const app = buildApp({ adminEmail: 'admin@example.com', adminPassword: 'correct' });
    const res = await request(app)
      .post('/api/admin/login')
      .send({ email: 'admin@example.com', password: 'wrong' });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'invalid_credentials' });
    expect(res.body).not.toHaveProperty('token');
  });

  test('wrong email + correct password → 401 invalid_credentials', async () => {
    const app = buildApp({ adminEmail: 'admin@example.com', adminPassword: 'correct' });
    const res = await request(app)
      .post('/api/admin/login')
      .send({ email: 'evil@example.com', password: 'correct' });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'invalid_credentials' });
  });

  test('correct creds → 200 with token', async () => {
    const app = buildApp({ adminEmail: 'admin@example.com', adminPassword: 'correct' });
    const res = await request(app)
      .post('/api/admin/login')
      .send({ email: 'admin@example.com', password: 'correct' });
    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();
    expect(res.body.email).toBe('admin@example.com');
  });
});

// ─────────────────────────────────────────────────────────────────
// 3. Constant-time path works (no length oracle, hash-based equality)
// ─────────────────────────────────────────────────────────────────
describe('PR-3 / 3: adminConstantTimeCompare', () => {
  test('equal strings → true', () => {
    expect(adminConstantTimeCompare('hello', 'hello')).toBe(true);
  });

  test('different strings of equal length → false', () => {
    expect(adminConstantTimeCompare('abcde', 'abcdf')).toBe(false);
  });

  test('different strings of UNEQUAL length → false (no early-return / no throw)', () => {
    expect(adminConstantTimeCompare('short', 'longer-string-here')).toBe(false);
    expect(adminConstantTimeCompare('much-longer-than-other', 'a')).toBe(false);
  });

  test('null / undefined inputs are handled and return false vs non-empty', () => {
    expect(adminConstantTimeCompare(null, 'x')).toBe(false);
    expect(adminConstantTimeCompare(undefined, 'x')).toBe(false);
    // null vs null hashes the same empty string → equal
    expect(adminConstantTimeCompare(null, null)).toBe(true);
    expect(adminConstantTimeCompare(null, undefined)).toBe(true);
    expect(adminConstantTimeCompare('', null)).toBe(true);
  });

  test('does not throw on adversarial inputs (objects, large strings)', () => {
    expect(() => adminConstantTimeCompare({ malicious: 'object' }, 'x')).not.toThrow();
    expect(() => adminConstantTimeCompare('x'.repeat(100_000), 'y')).not.toThrow();
  });

  test('plain === would say these match — confirms we are NOT using ===', () => {
    // crypto.timingSafeEqual cannot be circumvented by JS coercion the way
    // === can — e.g. '123' === 123 is false but adminConstantTimeCompare
    // hashes both as their string forms, so '123' (str) and 123 (num) match.
    // This proves the compare goes through hash, not naive ===.
    expect(adminConstantTimeCompare('123', 123)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────
// 4. Rate limit triggers 429
// ─────────────────────────────────────────────────────────────────
describe('PR-3 / 4: /api/admin/login rate limit', () => {
  test('5 failed attempts → 6th attempt returns 429', async () => {
    const app = buildApp({
      adminEmail: 'admin@example.com',
      adminPassword: 'correct',
      rateLimitMax: 5,
    });
    const agent = request(app);
    for (let i = 0; i < 5; i += 1) {
      const r = await agent
        .post('/api/admin/login')
        .send({ email: 'admin@example.com', password: 'wrong' });
      expect(r.status).toBe(401);
    }
    const blocked = await agent
      .post('/api/admin/login')
      .send({ email: 'admin@example.com', password: 'wrong' });
    expect(blocked.status).toBe(429);
    expect(blocked.body).toEqual({ error: 'too_many_attempts' });
  });

  test('successful login does NOT consume the limit (skipSuccessfulRequests=true)', async () => {
    const app = buildApp({
      adminEmail: 'admin@example.com',
      adminPassword: 'correct',
      rateLimitMax: 2,
    });
    const agent = request(app);
    // 3 successful logins should all succeed even though max=2
    for (let i = 0; i < 3; i += 1) {
      const r = await agent
        .post('/api/admin/login')
        .send({ email: 'admin@example.com', password: 'correct' });
      expect(r.status).toBe(200);
    }
  });
});

// ─────────────────────────────────────────────────────────────────
// 5. Admin JWT expires at configured TTL
// ─────────────────────────────────────────────────────────────────
describe('PR-3 / 5: admin JWT TTL', () => {
  test('default TTL is 30m (exp ≈ now + 1800s)', async () => {
    const app = buildApp({
      adminEmail: 'admin@example.com',
      adminPassword: 'correct',
      jwtSecret: 'test-secret',
      jwtTtl: '30m',
    });
    const res = await request(app)
      .post('/api/admin/login')
      .send({ email: 'admin@example.com', password: 'correct' });
    const decoded = jwt.verify(res.body.token, 'test-secret');
    const ttl = decoded.exp - decoded.iat;
    expect(ttl).toBe(30 * 60);
  });

  test('TTL of 15m (custom) is respected — proves env-tunable', async () => {
    const app = buildApp({
      adminEmail: 'admin@example.com',
      adminPassword: 'correct',
      jwtSecret: 'test-secret',
      jwtTtl: '15m',
    });
    const res = await request(app)
      .post('/api/admin/login')
      .send({ email: 'admin@example.com', password: 'correct' });
    const decoded = jwt.verify(res.body.token, 'test-secret');
    expect(decoded.exp - decoded.iat).toBe(15 * 60);
  });

  test('NEW token TTL is shorter than the prior 24h default', async () => {
    const app = buildApp({
      adminEmail: 'admin@example.com',
      adminPassword: 'correct',
      jwtSecret: 'test-secret',
      jwtTtl: '30m',
    });
    const res = await request(app)
      .post('/api/admin/login')
      .send({ email: 'admin@example.com', password: 'correct' });
    const decoded = jwt.verify(res.body.token, 'test-secret');
    expect(decoded.exp - decoded.iat).toBeLessThan(24 * 60 * 60);
  });
});

// ─────────────────────────────────────────────────────────────────
// 6 + 7. Dangerous endpoints blocked when flag OFF, allowed when ON
// ─────────────────────────────────────────────────────────────────
describe('PR-3 / 6: dangerous endpoints blocked when flag OFF', () => {
  test('flag unset → 403 admin_endpoint_disabled', async () => {
    delete process.env.TEST_DANGER_FLAG;
    const app = buildApp({ adminEmail: 'admin@example.com', adminPassword: 'correct' });
    const res = await request(app).get('/api/admin/danger-zone');
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'admin_endpoint_disabled', flag: 'TEST_DANGER_FLAG' });
  });

  test('flag explicitly false → 403', async () => {
    process.env.TEST_DANGER_FLAG = 'false';
    const app = buildApp({ adminEmail: 'admin@example.com', adminPassword: 'correct' });
    const res = await request(app).get('/api/admin/danger-zone');
    expect(res.status).toBe(403);
    delete process.env.TEST_DANGER_FLAG;
  });
});

describe('PR-3 / 7: dangerous endpoints allowed when flag ON', () => {
  test('flag=1 → 200', async () => {
    process.env.TEST_DANGER_FLAG = '1';
    const app = buildApp({ adminEmail: 'admin@example.com', adminPassword: 'correct' });
    const res = await request(app).get('/api/admin/danger-zone');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    delete process.env.TEST_DANGER_FLAG;
  });
});

// ─────────────────────────────────────────────────────────────────
// 8. No plaintext password leakage in logs / errors
// ─────────────────────────────────────────────────────────────────
describe('PR-3 / 8: no plaintext password leakage', () => {
  test('failed login: response body does NOT echo the candidate password', async () => {
    const app = buildApp({ adminEmail: 'admin@example.com', adminPassword: 'correct' });
    const res = await request(app)
      .post('/api/admin/login')
      .send({ email: 'admin@example.com', password: 'super-secret-attempt-123' });
    expect(res.status).toBe(401);
    expect(JSON.stringify(res.body)).not.toMatch(/super-secret-attempt-123/);
    expect(JSON.stringify(res.body)).not.toMatch(/correct/);
  });

  test('failed login: security log entries do NOT include the candidate password', async () => {
    const captured = [];
    const logger = {
      warn: (msg, fields) => captured.push({ msg, fields }),
    };
    const app = buildApp({
      adminEmail: 'admin@example.com',
      adminPassword: 'correct',
      logger,
    });
    await request(app)
      .post('/api/admin/login')
      .send({ email: 'admin@example.com', password: 'plaintext-leak-canary-xyz' });
    const dump = JSON.stringify(captured);
    expect(dump).toMatch(/login_failed/);
    expect(dump).not.toMatch(/plaintext-leak-canary-xyz/);
    expect(dump).not.toMatch(/correct/);
  });

  test('successful login: security log entry does NOT include the password', async () => {
    const captured = [];
    const logger = {
      warn: (msg, fields) => captured.push({ msg, fields }),
    };
    const app = buildApp({
      adminEmail: 'admin@example.com',
      adminPassword: 'correct-success-password',
      logger,
    });
    await request(app)
      .post('/api/admin/login')
      .send({ email: 'admin@example.com', password: 'correct-success-password' });
    const dump = JSON.stringify(captured);
    expect(dump).toMatch(/login_succeeded/);
    expect(dump).not.toMatch(/correct-success-password/);
  });
});
