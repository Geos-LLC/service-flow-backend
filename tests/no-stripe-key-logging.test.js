/**
 * CI guard — Stripe key partial-logging must not reappear.
 *
 * Pre-PR-S1, server.js had multiple `console.log('… key ending in:',
 * <key>.slice(-4))` lines on hot paths (the public /api/public/stripe-config
 * endpoint hit on every customer-invoice page load, and a tenant-direct-key
 * payment-intent path). Even logging the last 4 characters is exposure on a
 * public endpoint — combined with timing or request correlation, partial
 * keys can be reconstructed or used to verify a guess against the live key.
 *
 * This test asserts no future commit reintroduces the patterns. Read-only
 * source-text invariant — does not exercise routes.
 */

const fs = require('fs');
const path = require('path');

const SERVER_SRC = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

describe('Stripe key partial-logging — no reintroduction', () => {
  test('no occurrences of "secret key ending in" log strings', () => {
    expect(SERVER_SRC).not.toMatch(/secret key ending in/i);
  });

  test('no .slice(-4) on stripe_secret_key', () => {
    expect(SERVER_SRC).not.toMatch(/stripe_secret_key[^=\n]*\.slice\s*\(\s*-4\s*\)/);
  });

  test('no .slice(-4) on stripe_publishable_key in log statements', () => {
    // Allow .slice() elsewhere (e.g. parsing key prefix) — only flag when
    // adjacent to console.log. The strict check above on secret_key is enough
    // to catch the worst case; this one catches the public-key partial-log
    // that the audit also removed.
    const lines = SERVER_SRC.split('\n');
    const offenders = lines
      .map((l, i) => ({ l, i: i + 1 }))
      .filter(({ l }) =>
        /console\.(log|warn|error|info|debug)/.test(l) &&
        /stripe_publishable_key[^=\n]*\.slice/.test(l)
      );
    expect(offenders).toEqual([]);
  });

  test('no `hasSecretKey:` log block', () => {
    // The pre-fix block logged `{ hasSecretKey: !!billingData?.stripe_secret_key, ... }`
    // which is also a side-channel signal (presence of secret on a public path).
    expect(SERVER_SRC).not.toMatch(/hasSecretKey\s*:\s*!!/);
  });

  test('no console.* lines that print process.env.STRIPE_SECRET_KEY directly', () => {
    const lines = SERVER_SRC.split('\n');
    const offenders = lines
      .map((l, i) => ({ l, i: i + 1 }))
      .filter(({ l }) =>
        /console\.(log|warn|error|info|debug)/.test(l) &&
        /process\.env\.STRIPE_SECRET_KEY/.test(l)
      );
    expect(offenders).toEqual([]);
  });
});
