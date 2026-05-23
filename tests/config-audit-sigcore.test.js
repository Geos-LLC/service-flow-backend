'use strict';

/**
 * Coverage for the Sigcore checks added to lib/config-audit.js.
 *
 * Sigcore is APP-LEVEL infrastructure — tenants never see or set the
 * workspace key. Boot must warn loudly if the platform forgot to set
 * SIGCORE_URL / SIGCORE_WORKSPACE_KEY, because the symptom otherwise
 * is a per-tenant HTTP 500 with no boot-time signal.
 */

const { inspectConfig, runStartupConfigAudit } = require('../lib/config-audit');

// Minimal env that satisfies every PRE-EXISTING check so we can isolate the
// Sigcore findings under test.
function envWithEverythingElseSet(overrides = {}) {
  return {
    NODE_ENV: 'test',
    JWT_SECRET: 'a-real-strong-jwt-secret-that-is-not-the-fallback-value-aaaaaaaa',
    STRIPE_WEBHOOK_SECRET: 'whsec_platform',
    STRIPE_CONNECT_WEBHOOK_SECRET: 'whsec_connect_different',
    ADMIN_EMAIL: 'admin@example.com',
    ADMIN_PASSWORD: 'admin-pass',
    SF_INTEGRATION_ENC_KEY: Buffer.alloc(32).toString('base64'),
    SIGCORE_WEBHOOK_HMAC_REQUIRED: 'true',
    LB_INBOUND_HMAC_REQUIRED: 'true',
    SOURCE_ACCOUNT_BOUNDARY_ENFORCED: 'true',
    ...overrides,
  };
}

describe('config-audit — SIGCORE_URL coverage', () => {
  test('warns HIGH when SIGCORE_URL is unset', () => {
    const env = envWithEverythingElseSet({
      SIGCORE_WORKSPACE_KEY: 'platform-key-value',
      // SIGCORE_URL intentionally omitted
    });
    const { findings } = inspectConfig(env);
    const f = findings.find(x => x.key === 'SIGCORE_URL');
    expect(f).toBeDefined();
    expect(f.severity).toBe('HIGH');
    expect(f.reason).toMatch(/SIGCORE_URL is unset/);
    expect(f.fix).toMatch(/sigcore-production\.up\.railway\.app/);
  });

  test('does NOT warn when SIGCORE_URL is set', () => {
    const env = envWithEverythingElseSet({
      SIGCORE_URL: 'https://sigcore-production.up.railway.app/api',
      SIGCORE_WORKSPACE_KEY: 'platform-key-value',
    });
    const { findings } = inspectConfig(env);
    expect(findings.find(x => x.key === 'SIGCORE_URL')).toBeUndefined();
  });

  test('warning severity is HIGH (not CRITICAL — no auth bypass, just feature outage)', () => {
    const env = envWithEverythingElseSet({
      SIGCORE_WORKSPACE_KEY: 'platform-key-value',
    });
    const { findings } = inspectConfig(env);
    const f = findings.find(x => x.key === 'SIGCORE_URL');
    expect(f.severity).toBe('HIGH');
    expect(f.severity).not.toBe('CRITICAL');
  });
});

describe('config-audit — SIGCORE_WORKSPACE_KEY coverage', () => {
  test('warns HIGH when SIGCORE_WORKSPACE_KEY is unset', () => {
    const env = envWithEverythingElseSet({
      SIGCORE_URL: 'https://sigcore-production.up.railway.app/api',
      // SIGCORE_WORKSPACE_KEY intentionally omitted
    });
    const { findings } = inspectConfig(env);
    const f = findings.find(x => x.key === 'SIGCORE_WORKSPACE_KEY');
    expect(f).toBeDefined();
    expect(f.severity).toBe('HIGH');
    expect(f.reason).toMatch(/SIGCORE_WORKSPACE_KEY is unset/);
    expect(f.reason).toMatch(/Sigcore is app-level infrastructure/);
    expect(f.fix).toMatch(/sigcore-prod-secrets/);
  });

  test('does NOT warn when SIGCORE_WORKSPACE_KEY is set', () => {
    const env = envWithEverythingElseSet({
      SIGCORE_URL: 'https://sigcore-production.up.railway.app/api',
      SIGCORE_WORKSPACE_KEY: 'platform-key-value',
    });
    const { findings } = inspectConfig(env);
    expect(findings.find(x => x.key === 'SIGCORE_WORKSPACE_KEY')).toBeUndefined();
  });

  test('reason mentions tenant-blocking failure mode (HTTP 500)', () => {
    const env = envWithEverythingElseSet({});
    const { findings } = inspectConfig(env);
    const f = findings.find(x => x.key === 'SIGCORE_WORKSPACE_KEY');
    expect(f.reason).toMatch(/500/);
    expect(f.reason).toMatch(/connect-openphone/);
  });
});

describe('config-audit — Sigcore + other findings interact correctly', () => {
  test('both Sigcore findings fire when both env vars are unset', () => {
    const env = envWithEverythingElseSet({});
    const { findings } = inspectConfig(env);
    const sigcoreFindings = findings.filter(f => f.key === 'SIGCORE_URL' || f.key === 'SIGCORE_WORKSPACE_KEY');
    expect(sigcoreFindings).toHaveLength(2);
    for (const f of sigcoreFindings) expect(f.severity).toBe('HIGH');
  });

  test('Sigcore findings do not fire if both env vars are set, regardless of other findings', () => {
    // Knock out JWT_SECRET to introduce a CRITICAL finding — confirm Sigcore findings remain absent.
    const env = envWithEverythingElseSet({
      JWT_SECRET: undefined,
      SIGCORE_URL: 'https://sigcore-production.up.railway.app/api',
      SIGCORE_WORKSPACE_KEY: 'platform-key-value',
    });
    const { findings } = inspectConfig(env);
    expect(findings.find(f => f.key === 'JWT_SECRET')).toBeDefined();
    expect(findings.find(f => f.key === 'SIGCORE_URL')).toBeUndefined();
    expect(findings.find(f => f.key === 'SIGCORE_WORKSPACE_KEY')).toBeUndefined();
  });

  test('Sigcore HIGH findings do not throw runStartupConfigAudit in production', () => {
    // HIGH findings are warnings, not blockers. Only CRITICAL throws.
    const env = envWithEverythingElseSet({ NODE_ENV: 'production' });
    const logger = { warn: jest.fn(), error: jest.fn() };
    expect(() => runStartupConfigAudit({ env, logger })).not.toThrow();
    // Confirm the SIGCORE_WORKSPACE_KEY warning was logged.
    const allWarns = logger.warn.mock.calls.flat().join(' ');
    expect(allWarns).toMatch(/SIGCORE_WORKSPACE_KEY/);
    expect(allWarns).toMatch(/SIGCORE_URL/);
  });

  test('production environment still throws when JWT_SECRET is missing even if Sigcore is set', () => {
    const env = envWithEverythingElseSet({
      NODE_ENV: 'production',
      JWT_SECRET: undefined,
      SIGCORE_URL: 'https://sigcore-production.up.railway.app/api',
      SIGCORE_WORKSPACE_KEY: 'platform-key-value',
    });
    const logger = { warn: jest.fn(), error: jest.fn() };
    expect(() => runStartupConfigAudit({ env, logger })).toThrow(/CONFIG_AUDIT|CRITICAL/);
  });
});

describe('config-audit — fix advice contains the right operational hints', () => {
  test('SIGCORE_URL fix mentions Railway env + admin Global Settings as alternates', () => {
    const env = envWithEverythingElseSet({});
    const { findings } = inspectConfig(env);
    const f = findings.find(x => x.key === 'SIGCORE_URL');
    expect(f.fix).toMatch(/Railway/);
    expect(f.fix).toMatch(/communication_settings/);
    expect(f.fix).toMatch(/global_workspace/);
  });

  test('SIGCORE_WORKSPACE_KEY fix points to AWS Secrets Manager', () => {
    const env = envWithEverythingElseSet({});
    const { findings } = inspectConfig(env);
    const f = findings.find(x => x.key === 'SIGCORE_WORKSPACE_KEY');
    expect(f.fix).toMatch(/AWS Secrets Manager/);
    expect(f.fix).toMatch(/SIGCORE_SERVICE_KEY/);
    expect(f.fix).toMatch(/Admin Global Settings/);
  });
});
