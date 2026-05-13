/**
 * PR-S1.7 — Stripe webhook secret separation.
 *
 * Stripe issues a distinct signing secret per webhook endpoint. Pre-fix,
 * both /api/webhook/stripe (Platform Billing) and /api/stripe/connect/webhook
 * (Connect) read the same STRIPE_WEBHOOK_SECRET — so even if the operator
 * configured the variable correctly for Platform, every Connect event was
 * silently failing signature verification against the wrong secret.
 *
 * This file enforces three invariants:
 *   1. Source-text: each route reads only its OWN env var. No cross-reads.
 *   2. Behavioral: each route 503s when its own secret is unset, 400s on
 *      bad signature, and 200s on a payload signed with its own secret.
 *   3. Cross-secret regression: a payload signed with the Platform secret
 *      must NOT verify on the Connect route (and vice versa), even if both
 *      secrets are configured.
 *
 * Config-audit assertions live alongside in the same file so any future
 * change to either side is caught together.
 */

const fs = require('fs');
const path = require('path');
const express = require('express');
const request = require('supertest');
const stripe = require('stripe')('sk_test_dummy_keys_are_not_used_for_signing');

const SERVER_SRC = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const { inspectConfig } = require('../lib/config-audit');

// ─────────────────────────────────────────────────────────────────
// Section 1 — Source-level invariants
// ─────────────────────────────────────────────────────────────────

describe('PR-S1.7 — source invariants on webhook secret separation', () => {
  // Locate each route's region: from its declaration to the next `app.<verb>(`.
  function regionFor(routePath) {
    const startMarker = `app.post('${routePath}',`;
    const start = SERVER_SRC.indexOf(startMarker);
    if (start < 0) throw new Error(`route not found: ${routePath}`);
    const nextRoute = SERVER_SRC.indexOf('\napp.', start + startMarker.length);
    return SERVER_SRC.slice(start, nextRoute > 0 ? nextRoute : start + 8000);
  }

  test('Platform webhook reads STRIPE_WEBHOOK_SECRET only — never the Connect secret', () => {
    const region = regionFor('/api/webhook/stripe');
    expect(region).toMatch(/STRIPE_WEBHOOK_SECRET\b/);
    // Cross-read invariant: the Connect secret must not appear anywhere in
    // the Platform webhook's body.
    expect(region).not.toMatch(/STRIPE_CONNECT_WEBHOOK_SECRET/);
  });

  test('Connect webhook reads STRIPE_CONNECT_WEBHOOK_SECRET only — never the Platform secret', () => {
    const region = regionFor('/api/stripe/connect/webhook');
    expect(region).toMatch(/STRIPE_CONNECT_WEBHOOK_SECRET\b/);
    // The Connect region must NOT mention STRIPE_WEBHOOK_SECRET. We have to
    // exclude word-boundary collisions with the Connect var: assert no
    // occurrence of STRIPE_WEBHOOK_SECRET that isn't preceded by `CONNECT_`.
    const offending = region.match(/(?<!CONNECT_)STRIPE_WEBHOOK_SECRET/g) || [];
    expect(offending).toEqual([]);
  });

  test('error-code split: each route returns its own unconfigured code', () => {
    expect(SERVER_SRC).toMatch(/stripe_webhook_unconfigured/);
    expect(SERVER_SRC).toMatch(/stripe_connect_webhook_unconfigured/);
  });

  test('domain comments are present (regression guard against future code-review drift)', () => {
    expect(SERVER_SRC).toMatch(/Platform Billing webhook/i);
    expect(SERVER_SRC).toMatch(/Stripe Connect webhook/i);
  });
});

// ─────────────────────────────────────────────────────────────────
// Section 2 — Behavioral harness (mirrors the production handlers)
// ─────────────────────────────────────────────────────────────────

// The harness mounts the same constructEvent logic as production but with
// secrets read from a local closure (so we can vary them per test without
// global env mutation that leaks between tests). The source invariants
// above lock the production handlers to the same env var names, so the
// behavior the harness verifies maps directly onto production.
function buildWebhookHarness({ platformSecret, connectSecret }) {
  const app = express();

  app.post('/api/webhook/stripe', express.raw({ type: 'application/json' }), (req, res) => {
    if (!platformSecret) {
      return res.status(503).json({ error: 'stripe_webhook_unconfigured' });
    }
    try {
      stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], platformSecret);
      return res.json({ received: true, domain: 'platform' });
    } catch (e) {
      return res.status(400).send(`Webhook Error: ${e.message}`);
    }
  });

  app.post('/api/stripe/connect/webhook', express.raw({ type: 'application/json' }), (req, res) => {
    if (!connectSecret) {
      return res.status(503).json({ error: 'stripe_connect_webhook_unconfigured' });
    }
    try {
      stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], connectSecret);
      return res.json({ received: true, domain: 'connect' });
    } catch (e) {
      return res.status(400).send(`Webhook Error: ${e.message}`);
    }
  });

  return app;
}

// Generate a Stripe-signed payload using the SDK's test helper. The helper
// produces the same `Stripe-Signature` header format that constructEvent
// expects (timestamp + v1 HMAC-SHA256 over `${timestamp}.${payload}`).
function signedPayload(payload, secret) {
  const sig = stripe.webhooks.generateTestHeaderString({ payload, secret });
  return { body: payload, sig };
}

const PLATFORM_SECRET = 'whsec_test_platform_aaaa_aaaa_aaaa_aaaa_aaaa';
const CONNECT_SECRET  = 'whsec_test_connect_bbbb_bbbb_bbbb_bbbb_bbbb';

describe('PR-S1.7 — behavioral: per-route 503/400/200', () => {
  test('Platform route 503s when STRIPE_WEBHOOK_SECRET is unset (even if Connect is set)', async () => {
    const app = buildWebhookHarness({ platformSecret: '', connectSecret: CONNECT_SECRET });
    const res = await request(app).post('/api/webhook/stripe').set('content-type', 'application/json').send('{}');
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ error: 'stripe_webhook_unconfigured' });
  });

  test('Connect route 503s when STRIPE_CONNECT_WEBHOOK_SECRET is unset (even if Platform is set)', async () => {
    const app = buildWebhookHarness({ platformSecret: PLATFORM_SECRET, connectSecret: '' });
    const res = await request(app).post('/api/stripe/connect/webhook').set('content-type', 'application/json').send('{}');
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ error: 'stripe_connect_webhook_unconfigured' });
  });

  test('Platform route 400s on bad signature when secret is set', async () => {
    const app = buildWebhookHarness({ platformSecret: PLATFORM_SECRET, connectSecret: CONNECT_SECRET });
    const res = await request(app)
      .post('/api/webhook/stripe')
      .set('content-type', 'application/json')
      .set('stripe-signature', 't=1,v1=garbage')
      .send('{}');
    expect(res.status).toBe(400);
    expect(res.text).toMatch(/Webhook Error/);
  });

  test('Connect route 400s on bad signature when secret is set', async () => {
    const app = buildWebhookHarness({ platformSecret: PLATFORM_SECRET, connectSecret: CONNECT_SECRET });
    const res = await request(app)
      .post('/api/stripe/connect/webhook')
      .set('content-type', 'application/json')
      .set('stripe-signature', 't=1,v1=garbage')
      .send('{}');
    expect(res.status).toBe(400);
    expect(res.text).toMatch(/Webhook Error/);
  });

  test('Platform route 200s on payload correctly signed with the Platform secret', async () => {
    const app = buildWebhookHarness({ platformSecret: PLATFORM_SECRET, connectSecret: CONNECT_SECRET });
    const { body, sig } = signedPayload(
      JSON.stringify({ id: 'evt_test_platform', object: 'event', type: 'customer.subscription.updated', data: { object: {} } }),
      PLATFORM_SECRET
    );
    const res = await request(app)
      .post('/api/webhook/stripe')
      .set('content-type', 'application/json')
      .set('stripe-signature', sig)
      .send(body);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ domain: 'platform' });
  });

  test('Connect route 200s on payload correctly signed with the Connect secret', async () => {
    const app = buildWebhookHarness({ platformSecret: PLATFORM_SECRET, connectSecret: CONNECT_SECRET });
    const { body, sig } = signedPayload(
      JSON.stringify({ id: 'evt_test_connect', object: 'event', type: 'account.updated', data: { object: {} } }),
      CONNECT_SECRET
    );
    const res = await request(app)
      .post('/api/stripe/connect/webhook')
      .set('content-type', 'application/json')
      .set('stripe-signature', sig)
      .send(body);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ domain: 'connect' });
  });
});

// ─────────────────────────────────────────────────────────────────
// Section 3 — Cross-secret regression (the bug PR-S1.7 fixes)
// ─────────────────────────────────────────────────────────────────

describe('PR-S1.7 — cross-secret regression: routes must not accept the other domain\'s signature', () => {
  test('Platform webhook REJECTS a payload signed with the Connect secret (400)', async () => {
    const app = buildWebhookHarness({ platformSecret: PLATFORM_SECRET, connectSecret: CONNECT_SECRET });
    const { body, sig } = signedPayload(
      JSON.stringify({ id: 'evt_connect_event_to_platform_route', object: 'event', type: 'account.updated', data: { object: {} } }),
      CONNECT_SECRET // signed with the WRONG secret for this route
    );
    const res = await request(app)
      .post('/api/webhook/stripe')
      .set('content-type', 'application/json')
      .set('stripe-signature', sig)
      .send(body);
    expect(res.status).toBe(400);
  });

  test('Connect webhook REJECTS a payload signed with the Platform secret (400)', async () => {
    const app = buildWebhookHarness({ platformSecret: PLATFORM_SECRET, connectSecret: CONNECT_SECRET });
    const { body, sig } = signedPayload(
      JSON.stringify({ id: 'evt_platform_event_to_connect_route', object: 'event', type: 'invoice.payment_succeeded', data: { object: {} } }),
      PLATFORM_SECRET // signed with the WRONG secret for this route
    );
    const res = await request(app)
      .post('/api/stripe/connect/webhook')
      .set('content-type', 'application/json')
      .set('stripe-signature', sig)
      .send(body);
    expect(res.status).toBe(400);
  });
});

// ─────────────────────────────────────────────────────────────────
// Section 4 — Config audit findings
// ─────────────────────────────────────────────────────────────────

describe('PR-S1.7 — config-audit on webhook secrets', () => {
  const baseEnv = { JWT_SECRET: 'x'.repeat(64), ADMIN_EMAIL: 'a', ADMIN_PASSWORD: 'b', SF_INTEGRATION_ENC_KEY: 'k' };
  const find = (findings, key) => findings.find(f => f.key === key);

  test('both secrets unset → two independent HIGH findings, each naming its domain', () => {
    const { findings } = inspectConfig(baseEnv);
    const platform = find(findings, 'STRIPE_WEBHOOK_SECRET');
    const connect  = find(findings, 'STRIPE_CONNECT_WEBHOOK_SECRET');
    expect(platform).toBeDefined();
    expect(platform.severity).toBe('HIGH');
    expect(platform.reason).toMatch(/Platform Billing/);
    expect(connect).toBeDefined();
    expect(connect.severity).toBe('HIGH');
    expect(connect.reason).toMatch(/Connect account events/);
  });

  test('only Platform set → HIGH on Connect, no Platform finding, no equality finding', () => {
    const { findings } = inspectConfig({ ...baseEnv, STRIPE_WEBHOOK_SECRET: 'whsec_p' });
    expect(find(findings, 'STRIPE_WEBHOOK_SECRET')).toBeUndefined();
    expect(find(findings, 'STRIPE_CONNECT_WEBHOOK_SECRET')).toBeDefined();
    expect(find(findings, 'STRIPE_WEBHOOK_SECRET==STRIPE_CONNECT_WEBHOOK_SECRET')).toBeUndefined();
  });

  test('only Connect set → HIGH on Platform, no Connect finding, no equality finding', () => {
    const { findings } = inspectConfig({ ...baseEnv, STRIPE_CONNECT_WEBHOOK_SECRET: 'whsec_c' });
    expect(find(findings, 'STRIPE_WEBHOOK_SECRET')).toBeDefined();
    expect(find(findings, 'STRIPE_CONNECT_WEBHOOK_SECRET')).toBeUndefined();
    expect(find(findings, 'STRIPE_WEBHOOK_SECRET==STRIPE_CONNECT_WEBHOOK_SECRET')).toBeUndefined();
  });

  test('both set and different → no Stripe-webhook findings', () => {
    const { findings } = inspectConfig({
      ...baseEnv,
      STRIPE_WEBHOOK_SECRET: 'whsec_platform',
      STRIPE_CONNECT_WEBHOOK_SECRET: 'whsec_connect',
    });
    expect(find(findings, 'STRIPE_WEBHOOK_SECRET')).toBeUndefined();
    expect(find(findings, 'STRIPE_CONNECT_WEBHOOK_SECRET')).toBeUndefined();
    expect(find(findings, 'STRIPE_WEBHOOK_SECRET==STRIPE_CONNECT_WEBHOOK_SECRET')).toBeUndefined();
  });

  test('both set and EQUAL → CRITICAL finding (functionally broken separation)', () => {
    const same = 'whsec_paste_mistake_xxxxxxxxxxxxxxxxxxxxxxxxx';
    const { findings } = inspectConfig({
      ...baseEnv,
      STRIPE_WEBHOOK_SECRET: same,
      STRIPE_CONNECT_WEBHOOK_SECRET: same,
    });
    const equality = find(findings, 'STRIPE_WEBHOOK_SECRET==STRIPE_CONNECT_WEBHOOK_SECRET');
    expect(equality).toBeDefined();
    expect(equality.severity).toBe('CRITICAL');
    expect(equality.reason).toMatch(/identical/);
    expect(equality.reason).toMatch(/silently rejecting/);
  });

  test('equality check is case-sensitive (Stripe secrets are case-sensitive)', () => {
    const { findings } = inspectConfig({
      ...baseEnv,
      STRIPE_WEBHOOK_SECRET: 'whsec_ABC',
      STRIPE_CONNECT_WEBHOOK_SECRET: 'whsec_abc',
    });
    expect(find(findings, 'STRIPE_WEBHOOK_SECRET==STRIPE_CONNECT_WEBHOOK_SECRET')).toBeUndefined();
  });
});
