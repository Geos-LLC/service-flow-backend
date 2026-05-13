/**
 * P0.2 (Synchronization Constitution §6.1) — Zenbooker webhook authentication.
 *
 * Pure tests for lib/zenbooker-webhook-auth.js. Source-text scan asserts the
 * webhook handler in zenbooker-sync.js calls the authenticator BEFORE any
 * mutation occurs.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const {
  verifyHmacSignature,
  verifySharedSecret,
  checkIpAllowlist,
  authenticateZenbookerWebhook,
} = require('../lib/zenbooker-webhook-auth');

const { FLAGS } = require('../lib/feature-flags');

const ZB_SYNC_JS = fs.readFileSync(path.join(__dirname, '..', 'zenbooker-sync.js'), 'utf8');

function makeReq({ headers = {}, body = {}, ip = '1.2.3.4' } = {}) {
  const lower = {};
  for (const k of Object.keys(headers)) lower[k.toLowerCase()] = headers[k];
  const rawBody = Buffer.from(JSON.stringify(body));
  return { headers: lower, rawBody, body, ip };
}

function sign(secret, body) {
  return crypto.createHmac('sha256', secret).update(JSON.stringify(body)).digest('hex');
}

// ─── verifyHmacSignature ──────────────────────────────────────────────

describe('verifyHmacSignature', () => {
  const secret = 'super-secret';
  const body = { event: 'job.completed', data: { id: 'x' } };

  test('valid signature passes', () => {
    const sig = sign(secret, body);
    const rawBody = Buffer.from(JSON.stringify(body));
    const r = verifyHmacSignature({ secret, signatureHeader: sig, rawBody });
    expect(r).toEqual({ valid: true, reason: null });
  });

  test('tolerates sha256= prefix', () => {
    const sig = 'sha256=' + sign(secret, body);
    const rawBody = Buffer.from(JSON.stringify(body));
    expect(verifyHmacSignature({ secret, signatureHeader: sig, rawBody }).valid).toBe(true);
  });

  test('rejects tampered body', () => {
    const sig = sign(secret, body);
    const tampered = Buffer.from(JSON.stringify({ event: 'job.completed', data: { id: 'EVIL' } }));
    const r = verifyHmacSignature({ secret, signatureHeader: sig, rawBody: tampered });
    expect(r.valid).toBe(false);
    expect(r.reason).toBe('signature_mismatch');
  });

  test('rejects missing secret', () => {
    expect(verifyHmacSignature({ secret: '', signatureHeader: 'abc', rawBody: '' })).toEqual({
      valid: false,
      reason: 'missing_secret_env',
    });
  });

  test('rejects missing signature header', () => {
    expect(verifyHmacSignature({ secret, signatureHeader: '', rawBody: '' })).toEqual({
      valid: false,
      reason: 'missing_signature',
    });
  });
});

// ─── verifySharedSecret ───────────────────────────────────────────────

describe('verifySharedSecret', () => {
  test('matching secret passes', () => {
    expect(verifySharedSecret({ secret: 'abc', secretHeader: 'abc' })).toEqual({ valid: true, reason: null });
  });

  test('mismatch rejected', () => {
    expect(verifySharedSecret({ secret: 'abc', secretHeader: 'xyz' }).valid).toBe(false);
  });

  test('missing env rejected', () => {
    expect(verifySharedSecret({ secret: '', secretHeader: 'abc' }).reason).toBe('missing_secret_env');
  });

  test('missing header rejected', () => {
    expect(verifySharedSecret({ secret: 'abc', secretHeader: '' }).reason).toBe('missing_secret_header');
  });

  test('length differs but bytes look similar — still rejected (timing-safe)', () => {
    expect(verifySharedSecret({ secret: 'abc', secretHeader: 'abcd' }).valid).toBe(false);
  });
});

// ─── checkIpAllowlist ─────────────────────────────────────────────────

describe('checkIpAllowlist', () => {
  test('empty list = applies false, allowed true (open by default)', () => {
    const r = checkIpAllowlist({ allowlist: [], requestIp: '1.2.3.4' });
    expect(r.applies).toBe(false);
    expect(r.allowed).toBe(true);
  });

  test('exact IP match', () => {
    const r = checkIpAllowlist({ allowlist: ['1.2.3.4', '5.6.7.8'], requestIp: '1.2.3.4' });
    expect(r.allowed).toBe(true);
  });

  test('prefix match (trailing dot)', () => {
    const r = checkIpAllowlist({ allowlist: ['10.0.'], requestIp: '10.0.5.7' });
    expect(r.allowed).toBe(true);
  });

  test('IP not in list rejected', () => {
    const r = checkIpAllowlist({ allowlist: ['1.2.3.4'], requestIp: '9.9.9.9' });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('ip_not_in_allowlist');
  });

  test('missing IP when list is set rejected', () => {
    const r = checkIpAllowlist({ allowlist: ['1.2.3.4'], requestIp: null });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('missing_ip');
  });
});

// ─── authenticateZenbookerWebhook (orchestrator) ─────────────────────

describe('authenticateZenbookerWebhook', () => {
  const SECRET = 'sf-zb-secret-2026';
  const flagEnvKey = FLAGS.ZB_WEBHOOK_AUTH_REQUIRED;

  beforeEach(() => {
    process.env.ZENBOOKER_WEBHOOK_SECRET = SECRET;
    delete process.env.ZENBOOKER_WEBHOOK_ALLOWED_IPS;
    delete process.env[flagEnvKey];
  });

  afterAll(() => {
    delete process.env.ZENBOOKER_WEBHOOK_SECRET;
    delete process.env.ZENBOOKER_WEBHOOK_ALLOWED_IPS;
    delete process.env[flagEnvKey];
  });

  // ── Flag OFF (rollout phase) ──────────────────────────────────────

  test('flag OFF + no auth attempted → ok, attempted=false', () => {
    const r = authenticateZenbookerWebhook(makeReq({ body: { event: 'job.completed' } }));
    expect(r.ok).toBe(true);
    expect(r.flag).toBe('off');
    expect(r.attempted).toBe(false);
  });

  test('flag OFF + valid HMAC → ok, mode=hmac', () => {
    const body = { event: 'job.completed' };
    const sig = sign(SECRET, body);
    const r = authenticateZenbookerWebhook(makeReq({ body, headers: { 'x-zb-signature': sig } }));
    expect(r.ok).toBe(true);
    expect(r.mode).toBe('hmac');
  });

  test('flag OFF + bad HMAC → still ok (rollout), but reason logged', () => {
    const r = authenticateZenbookerWebhook(makeReq({
      body: { event: 'x' }, headers: { 'x-zb-signature': 'deadbeef' }
    }));
    expect(r.ok).toBe(true);
    expect(r.flag).toBe('off');
    expect(r.attempted).toBe(true);
    expect(r.reason).toMatch(/mismatch|length_mismatch|signature_mismatch/);
  });

  // ── Flag ON (enforcement phase) ───────────────────────────────────

  test('flag ON + no auth → 401', () => {
    process.env[flagEnvKey] = 'true';
    const r = authenticateZenbookerWebhook(makeReq({ body: { event: 'x' } }));
    expect(r.ok).toBe(false);
    expect(r.status).toBe(401);
  });

  test('flag ON + valid HMAC → ok', () => {
    process.env[flagEnvKey] = 'true';
    const body = { event: 'job.completed' };
    const sig = sign(SECRET, body);
    const r = authenticateZenbookerWebhook(makeReq({ body, headers: { 'x-zb-signature': sig } }));
    expect(r.ok).toBe(true);
    expect(r.mode).toBe('hmac');
  });

  test('flag ON + valid shared secret → ok', () => {
    process.env[flagEnvKey] = 'true';
    const r = authenticateZenbookerWebhook(makeReq({
      body: { event: 'x' }, headers: { 'x-zb-secret': SECRET }
    }));
    expect(r.ok).toBe(true);
    expect(r.mode).toBe('shared_secret');
  });

  test('flag ON + wrong shared secret → 401', () => {
    process.env[flagEnvKey] = 'true';
    const r = authenticateZenbookerWebhook(makeReq({
      body: { event: 'x' }, headers: { 'x-zb-secret': 'wrong' }
    }));
    expect(r.ok).toBe(false);
    expect(r.status).toBe(401);
    expect(r.reason).toBe('secret_mismatch');
  });

  test('flag ON + no ZENBOOKER_WEBHOOK_SECRET env → 503 misconfig', () => {
    process.env[flagEnvKey] = 'true';
    delete process.env.ZENBOOKER_WEBHOOK_SECRET;
    const r = authenticateZenbookerWebhook(makeReq({ body: { event: 'x' } }));
    expect(r.ok).toBe(false);
    expect(r.status).toBe(503);
  });

  test('flag ON + valid auth but IP not in allowlist → 401', () => {
    process.env[flagEnvKey] = 'true';
    process.env.ZENBOOKER_WEBHOOK_ALLOWED_IPS = '99.99.99.99';
    const r = authenticateZenbookerWebhook(makeReq({
      body: { event: 'x' },
      headers: { 'x-zb-secret': SECRET, 'x-forwarded-for': '1.2.3.4' },
    }));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/ip/);
  });

  test('flag ON + valid auth AND IP in allowlist → ok', () => {
    process.env[flagEnvKey] = 'true';
    process.env.ZENBOOKER_WEBHOOK_ALLOWED_IPS = '1.2.3.4';
    const r = authenticateZenbookerWebhook(makeReq({
      body: { event: 'x' },
      headers: { 'x-zb-secret': SECRET, 'x-forwarded-for': '1.2.3.4' },
    }));
    expect(r.ok).toBe(true);
  });
});

// ─── Handler integration scan ─────────────────────────────────────────

describe('zenbooker-sync.js webhook handler', () => {
  test('imports the authenticator helper', () => {
    expect(ZB_SYNC_JS).toMatch(/require\('\.\/lib\/zenbooker-webhook-auth'\)/);
  });

  test('webhook handler calls authenticateZenbookerWebhook before mutation', () => {
    const handlerStart = ZB_SYNC_JS.indexOf("router.post('/webhook'");
    expect(handlerStart).toBeGreaterThan(0);
    const handlerBody = ZB_SYNC_JS.slice(handlerStart, handlerStart + 4000);

    // Authenticator must be called before any downstream processing function.
    const authIdx = handlerBody.indexOf('authenticateZenbookerWebhook(req)');
    const handleJobIdx = handlerBody.indexOf('handleJobEvent(');
    const handlePaymentIdx = handlerBody.indexOf('handlePaymentEvent(');
    expect(authIdx).toBeGreaterThan(0);
    if (handleJobIdx > 0) expect(authIdx).toBeLessThan(handleJobIdx);
    if (handlePaymentIdx > 0) expect(authIdx).toBeLessThan(handlePaymentIdx);
  });

  test('webhook returns auth.status when auth fails', () => {
    const handlerStart = ZB_SYNC_JS.indexOf("router.post('/webhook'");
    const handlerBody = ZB_SYNC_JS.slice(handlerStart, handlerStart + 4000);
    expect(handlerBody).toMatch(/res\.status\(auth\.status\)/);
    expect(handlerBody).toMatch(/webhook_auth_failed/);
  });
});
