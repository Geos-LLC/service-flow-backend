/**
 * PR-S1.6 — Restricted-key validation support for tenant direct-key setup.
 *
 * Pre-fix, /api/stripe/setup-credentials and /api/stripe/test-connection
 * both called stripe.accounts.retrieve() during validation. That works for
 * standard sk_* keys but fails for restricted rk_* keys lacking the Account
 * read scope. Tenants who followed Stripe's "third-party application" path
 * (which produces a restricted key by default) hit a 400 even when their
 * key had every permission SF actually needs.
 *
 * This test file enforces:
 *   1. The new validator (lib/stripe-credentials.js) categorizes inputs
 *      into invalid_key / mode_mismatch / insufficient_permissions /
 *      ok across all key shapes and scope combinations.
 *   2. Source invariants: /setup-credentials and /test-connection are
 *      wired to the new validator and no longer reject non-sk_ keys at
 *      the format level.
 *   3. requireBillingOwner gate is preserved on both routes (PR-S1.5
 *      regression guard).
 *   4. No key string, prefix, suffix, or raw Stripe message text is
 *      written to logs by the validator or the route paths.
 */

const fs = require('fs');
const path = require('path');
const { validateStripeCredentials, detectStripeMode, _internal } = require('../lib/stripe-credentials');

const SERVER_SRC = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

// ─────────────────────────────────────────────────────────────────
// Section 1 — Source invariants
// ─────────────────────────────────────────────────────────────────

describe('PR-S1.6 — source invariants', () => {
  test('setup-credentials route uses validateStripeCredentials', () => {
    const idx = SERVER_SRC.indexOf("app.post('/api/stripe/setup-credentials'");
    expect(idx).toBeGreaterThan(0);
    // Read the handler body — bounded by the next `app.<verb>(` declaration.
    const next = SERVER_SRC.indexOf('\napp.', idx + 60);
    const region = SERVER_SRC.slice(idx, next > 0 ? next : idx + 8000);
    expect(region).toMatch(/validateStripeCredentials\s*\(/);
  });

  test('setup-credentials no longer requires sk_ prefix or pk_ prefix at the route level', () => {
    // The legacy code did `if (!publishableKey.startsWith('pk_'))`. That
    // check has been replaced by the validator's structured format check
    // which also accepts rk_* secret keys. Confirm the legacy literal is
    // gone from the setup-credentials region.
    const idx = SERVER_SRC.indexOf("app.post('/api/stripe/setup-credentials'");
    const next = SERVER_SRC.indexOf('\napp.', idx + 60);
    const region = SERVER_SRC.slice(idx, next > 0 ? next : idx + 8000);
    expect(region).not.toMatch(/!publishableKey\.startsWith\('pk_'\)/);
  });

  test('test-connection probes scopes via customers.list, not accounts.retrieve only', () => {
    const idx = SERVER_SRC.indexOf("app.get('/api/stripe/test-connection'");
    expect(idx).toBeGreaterThan(0);
    const next = SERVER_SRC.indexOf('\napp.', idx + 60);
    const region = SERVER_SRC.slice(idx, next > 0 ? next : idx + 8000);
    expect(region).toMatch(/customers\.list\(\s*\{\s*limit:\s*1\s*\}\s*\)/);
  });

  test('requireBillingOwner gate is preserved on both PR-S1.6-touched routes', () => {
    expect(SERVER_SRC).toMatch(
      /app\.post\(\s*'\/api\/stripe\/setup-credentials'\s*,\s*authenticateToken\s*,\s*requireBillingOwner\b/
    );
    expect(SERVER_SRC).toMatch(
      /app\.get\(\s*'\/api\/stripe\/test-connection'\s*,\s*authenticateToken\s*,\s*requireBillingOwner\b/
    );
  });

  test('no raw Stripe error message logging in the affected route paths', () => {
    // The legacy validator did `console.error('… ', stripeError.message)`
    // which can leak key prefixes embedded in Stripe error strings. Confirm
    // setup-credentials' validation block doesn't expose error.message at
    // any log level. The outer catch is allowed to log generic error info,
    // not Stripe message strings.
    const idx = SERVER_SRC.indexOf("app.post('/api/stripe/setup-credentials'");
    const next = SERVER_SRC.indexOf('\napp.', idx + 60);
    const region = SERVER_SRC.slice(idx, next > 0 ? next : idx + 8000);
    expect(region).not.toMatch(/stripeError\.message/);
  });
});

// ─────────────────────────────────────────────────────────────────
// Section 2 — Validator format checks (deterministic)
// ─────────────────────────────────────────────────────────────────

describe('PR-S1.6 — format checks (no API calls required)', () => {
  test('rejects publishable key with wrong prefix', async () => {
    const res = await validateStripeCredentials('rk_test_x', 'sk_test_y', { stripeFactory: () => ({}) });
    expect(res).toEqual({ ok: false, code: 'invalid_key', details: expect.stringMatching(/pk_test_ or pk_live_/) });
  });

  test('rejects secret key with wrong prefix', async () => {
    const res = await validateStripeCredentials('pk_test_x', 'pk_test_y', { stripeFactory: () => ({}) });
    expect(res).toEqual({ ok: false, code: 'invalid_key', details: expect.stringMatching(/sk_test_, sk_live_, rk_test_, or rk_live_/) });
  });

  test('rejects null / non-string inputs', async () => {
    const res1 = await validateStripeCredentials(null, 'sk_test_x', { stripeFactory: () => ({}) });
    expect(res1.code).toBe('invalid_key');
    const res2 = await validateStripeCredentials('pk_test_x', undefined, { stripeFactory: () => ({}) });
    expect(res2.code).toBe('invalid_key');
  });

  test('rejects sk_test_ paired with pk_live_ (mode mismatch)', async () => {
    const res = await validateStripeCredentials('pk_live_x', 'sk_test_y', { stripeFactory: () => ({}) });
    expect(res).toEqual({
      ok: false,
      code: 'mode_mismatch',
      details: expect.stringMatching(/live mode but secret key is test mode/),
      mode_publishable: 'live',
      mode_secret: 'test',
    });
  });

  test('rejects rk_live_ paired with pk_test_ (mode mismatch)', async () => {
    const res = await validateStripeCredentials('pk_test_x', 'rk_live_y', { stripeFactory: () => ({}) });
    expect(res.code).toBe('mode_mismatch');
    expect(res.mode_publishable).toBe('test');
    expect(res.mode_secret).toBe('live');
  });

  test('detectStripeMode handles all 6 prefix variants', () => {
    expect(detectStripeMode('pk_test_abc')).toBe('test');
    expect(detectStripeMode('pk_live_abc')).toBe('live');
    expect(detectStripeMode('sk_test_abc')).toBe('test');
    expect(detectStripeMode('sk_live_abc')).toBe('live');
    expect(detectStripeMode('rk_test_abc')).toBe('test');
    expect(detectStripeMode('rk_live_abc')).toBe('live');
    expect(detectStripeMode('weird_abc')).toBeNull();
    expect(detectStripeMode(null)).toBeNull();
    expect(detectStripeMode(42)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────
// Section 3 — Scope probing (mocked Stripe SDK)
// ─────────────────────────────────────────────────────────────────

// Helper — build a mock Stripe client whose 4 probe methods return either
// a successful list response or a structured error. Lets us simulate any
// combination of granted/missing scopes without hitting real Stripe.
function mockStripeClient({ customers, invoices, paymentIntents, paymentLinks } = {}) {
  const resolveOrThrow = (override) => async () => {
    if (override instanceof Error) throw override;
    return override === undefined ? { data: [] } : override;
  };
  return {
    customers: { list: resolveOrThrow(customers) },
    invoices: { list: resolveOrThrow(invoices) },
    paymentIntents: { list: resolveOrThrow(paymentIntents) },
    paymentLinks: { list: resolveOrThrow(paymentLinks) },
  };
}

function permissionError(resource) {
  const err = new Error(`The provided key does not have access to ${resource}.`);
  err.type = 'StripePermissionError';
  err.code = 'permission_error';
  err.statusCode = 403;
  return err;
}

function authError() {
  const err = new Error('Invalid API Key provided.');
  err.type = 'StripeAuthenticationError';
  err.code = 'api_key_invalid';
  err.statusCode = 401;
  return err;
}

describe('PR-S1.6 — scope probing', () => {
  const stripeFactory = (stripeClient) => () => stripeClient;

  test('standard sk_test_ key with all scopes → ok (test mode)', async () => {
    const res = await validateStripeCredentials('pk_test_pp', 'sk_test_ss', {
      stripeFactory: stripeFactory(mockStripeClient({})),
    });
    expect(res).toEqual({ ok: true, mode: 'test' });
  });

  test('standard sk_live_ key with all scopes → ok (live mode)', async () => {
    const res = await validateStripeCredentials('pk_live_pp', 'sk_live_ss', {
      stripeFactory: stripeFactory(mockStripeClient({})),
    });
    expect(res).toEqual({ ok: true, mode: 'live' });
  });

  test('restricted rk_test_ key with all four scopes → ok', async () => {
    const res = await validateStripeCredentials('pk_test_pp', 'rk_test_ss', {
      stripeFactory: stripeFactory(mockStripeClient({})),
    });
    expect(res).toEqual({ ok: true, mode: 'test' });
  });

  test('restricted rk_live_ key with all four scopes → ok', async () => {
    const res = await validateStripeCredentials('pk_live_pp', 'rk_live_ss', {
      stripeFactory: stripeFactory(mockStripeClient({})),
    });
    expect(res).toEqual({ ok: true, mode: 'live' });
  });

  test('restricted key missing Invoices scope → insufficient_permissions with details', async () => {
    const res = await validateStripeCredentials('pk_test_pp', 'rk_test_ss', {
      stripeFactory: stripeFactory(mockStripeClient({
        invoices: permissionError('invoices'),
      })),
    });
    expect(res.ok).toBe(false);
    expect(res.code).toBe('insufficient_permissions');
    expect(res.missing_permissions).toEqual(['Invoices']);
    expect(res.details).toMatch(/Invoices/);
  });

  test('restricted key missing multiple scopes → all listed in missing_permissions', async () => {
    const res = await validateStripeCredentials('pk_test_pp', 'rk_test_ss', {
      stripeFactory: stripeFactory(mockStripeClient({
        invoices: permissionError('invoices'),
        paymentLinks: permissionError('payment_links'),
      })),
    });
    expect(res.code).toBe('insufficient_permissions');
    expect(res.missing_permissions).toEqual(['Invoices', 'Payment Links']);
    expect(res.details).toMatch(/Invoices.*Payment Links|Payment Links.*Invoices/);
  });

  test('restricted key missing ALL four scopes → all listed', async () => {
    const allDenied = mockStripeClient({
      customers: permissionError('customers'),
      invoices: permissionError('invoices'),
      paymentIntents: permissionError('payment_intents'),
      paymentLinks: permissionError('payment_links'),
    });
    const res = await validateStripeCredentials('pk_test_pp', 'rk_test_ss', {
      stripeFactory: stripeFactory(allDenied),
    });
    expect(res.code).toBe('insufficient_permissions');
    expect(res.missing_permissions).toEqual(['Customers', 'Invoices', 'Payment Intents', 'Payment Links']);
  });

  test('invalid key (Stripe 401) → invalid_key, NOT insufficient_permissions', async () => {
    const res = await validateStripeCredentials('pk_test_pp', 'sk_test_bad', {
      stripeFactory: stripeFactory(mockStripeClient({
        customers: authError(),
        invoices: authError(),
        paymentIntents: authError(),
        paymentLinks: authError(),
      })),
    });
    expect(res).toEqual({ ok: false, code: 'invalid_key', details: expect.stringMatching(/invalid or expired/) });
  });

  test('mixed: one auth error and three permission errors → invalid_key wins', async () => {
    // If the key itself is invalid, listing missing scopes is misleading.
    const res = await validateStripeCredentials('pk_test_pp', 'sk_test_bad', {
      stripeFactory: stripeFactory(mockStripeClient({
        customers: authError(),
        invoices: permissionError('invoices'),
        paymentIntents: permissionError('payment_intents'),
        paymentLinks: permissionError('payment_links'),
      })),
    });
    expect(res.code).toBe('invalid_key');
  });

  test('non-auth, non-permission errors (e.g., 5xx) → unknown_stripe_error', async () => {
    const networkError = Object.assign(new Error('ECONNRESET'), { code: 'ECONNRESET' });
    const res = await validateStripeCredentials('pk_test_pp', 'sk_test_x', {
      stripeFactory: stripeFactory(mockStripeClient({
        customers: networkError,
      })),
    });
    expect(res.code).toBe('unknown_stripe_error');
  });

  test('stripeFactory throwing → invalid_key', async () => {
    const res = await validateStripeCredentials('pk_test_pp', 'sk_test_x', {
      stripeFactory: () => { throw new Error('bad init'); },
    });
    expect(res.code).toBe('invalid_key');
  });
});

// ─────────────────────────────────────────────────────────────────
// Section 4 — No-key-leak invariant on internal helpers
// ─────────────────────────────────────────────────────────────────

describe('PR-S1.6 — no key/prefix leakage from validator', () => {
  test('the returned details string never includes the literal secret key value', async () => {
    const SECRET_SHAPED_LIKE_REAL = 'rk_test_51AbCdEfGhIjKlMnOpQrStUvWxYz1234567890ZyXwVuTsRqPo';
    const PUB_SHAPED_LIKE_REAL    = 'pk_test_51AbCdEfGhIjKlMnOpQrStUvWxYz1234567890ZyXwVuTsRqPo';
    const cases = [
      // format errors
      validateStripeCredentials('not_a_pk', SECRET_SHAPED_LIKE_REAL, { stripeFactory: () => ({}) }),
      validateStripeCredentials(PUB_SHAPED_LIKE_REAL, 'not_a_sk', { stripeFactory: () => ({}) }),
      // mode mismatch
      validateStripeCredentials('pk_live_xxx', SECRET_SHAPED_LIKE_REAL, { stripeFactory: () => ({}) }),
      // auth error
      validateStripeCredentials(PUB_SHAPED_LIKE_REAL, SECRET_SHAPED_LIKE_REAL, {
        stripeFactory: () => mockStripeClient({
          customers: authError(),
          invoices: authError(),
          paymentIntents: authError(),
          paymentLinks: authError(),
        }),
      }),
      // permission error
      validateStripeCredentials(PUB_SHAPED_LIKE_REAL, SECRET_SHAPED_LIKE_REAL, {
        stripeFactory: () => mockStripeClient({ invoices: permissionError('invoices') }),
      }),
    ];
    const results = await Promise.all(cases);
    for (const r of results) {
      const blob = JSON.stringify(r);
      expect(blob).not.toContain(SECRET_SHAPED_LIKE_REAL);
      expect(blob).not.toContain('rk_test_51AbCdEfGhIjKlMnOpQrStUvWxYz1234567890');
      // The prefix alone (rk_test_) is fine to mention in error copy — it's
      // the static substring we ask users to provide. Just the full key /
      // suffix must not appear.
      expect(blob).not.toContain(SECRET_SHAPED_LIKE_REAL.slice(-8));
    }
  });

  test('helper exports are stable (called by /test-connection route)', () => {
    expect(typeof _internal.isAuthError).toBe('function');
    expect(typeof _internal.isPermissionError).toBe('function');
    expect(_internal.isAuthError(authError())).toBe(true);
    expect(_internal.isPermissionError(permissionError('x'))).toBe(true);
    expect(_internal.isAuthError(permissionError('x'))).toBe(false);
    expect(_internal.isPermissionError(authError())).toBe(false);
  });
});
