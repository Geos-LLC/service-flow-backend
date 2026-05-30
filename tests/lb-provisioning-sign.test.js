'use strict';

/**
 * HMAC signing for SF → LB provisioning calls.
 *
 * Covers:
 *   - getSharedSecret: env-driven, throws when unset
 *   - signCanonical: stable hex sha256 over `${ts}.${body}`
 *   - buildProvisioningHeaders: requires now (Date); produces headers
 *     + serialized body
 *   - verifyProvisioningRequest: positive/negative + timing-safe + skew
 */

const SHARED_SECRET = 'p2c-shared-secret-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
process.env.SF_LB_PROVISIONING_SHARED_SECRET = SHARED_SECRET;

const {
  getSharedSecret,
  signCanonical,
  buildProvisioningHeaders,
  verifyProvisioningRequest,
} = require('../lib/lb-provisioning-sign');

describe('getSharedSecret', () => {
  test('returns the env value', () => {
    expect(getSharedSecret()).toBe(SHARED_SECRET);
  });

  test('throws if env is unset', () => {
    const saved = process.env.SF_LB_PROVISIONING_SHARED_SECRET;
    delete process.env.SF_LB_PROVISIONING_SHARED_SECRET;
    expect(() => getSharedSecret()).toThrow(/SF_LB_PROVISIONING_SHARED_SECRET/);
    process.env.SF_LB_PROVISIONING_SHARED_SECRET = saved;
  });

  test('throws if env is empty string', () => {
    const saved = process.env.SF_LB_PROVISIONING_SHARED_SECRET;
    process.env.SF_LB_PROVISIONING_SHARED_SECRET = '';
    expect(() => getSharedSecret()).toThrow(/SF_LB_PROVISIONING_SHARED_SECRET/);
    process.env.SF_LB_PROVISIONING_SHARED_SECRET = saved;
  });
});

describe('signCanonical', () => {
  test('produces hex sha256 HMAC over `${ts}.${body}`', () => {
    const sig = signCanonical('secret', '1780011918', '{"foo":"bar"}');
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
  });

  test('different secrets → different signatures', () => {
    const a = signCanonical('one', '100', 'body');
    const b = signCanonical('two', '100', 'body');
    expect(a).not.toBe(b);
  });

  test('different timestamps → different signatures (timestamp binding)', () => {
    const a = signCanonical('s', '100', 'body');
    const b = signCanonical('s', '200', 'body');
    expect(a).not.toBe(b);
  });

  test('different bodies → different signatures', () => {
    const a = signCanonical('s', '100', '{}');
    const b = signCanonical('s', '100', '{"x":1}');
    expect(a).not.toBe(b);
  });

  test('throws on missing secret', () => {
    expect(() => signCanonical('', '100', 'body')).toThrow();
  });

  test('throws if body is not a string', () => {
    expect(() => signCanonical('s', '100', {})).toThrow();
  });
});

describe('buildProvisioningHeaders', () => {
  test('happy path: returns headers + body', () => {
    const body = '{"hello":"world"}';
    const now = new Date('2026-05-29T16:00:00.000Z');
    const out = buildProvisioningHeaders({ body, now });
    expect(out.body).toBe(body);
    expect(out.headers['Content-Type']).toBe('application/json');
    expect(out.headers['X-SF-LB-Timestamp']).toBe(String(Math.floor(now.getTime() / 1000)));
    expect(out.headers['X-SF-LB-Signature']).toMatch(/^[0-9a-f]{64}$/);
  });

  test('signature recomputable from headers + body + secret', () => {
    const body = '{"x":1}';
    const now = new Date('2026-05-29T16:00:00.000Z');
    const out = buildProvisioningHeaders({ body, now });
    const expected = signCanonical(SHARED_SECRET, out.headers['X-SF-LB-Timestamp'], body);
    expect(out.headers['X-SF-LB-Signature']).toBe(expected);
  });

  test('two consecutive calls with same now produce identical headers', () => {
    const body = '{"a":1}';
    const now = new Date('2026-05-29T16:00:00.000Z');
    const a = buildProvisioningHeaders({ body, now });
    const b = buildProvisioningHeaders({ body, now });
    expect(a.headers).toEqual(b.headers);
  });

  test('throws when now is missing', () => {
    expect(() => buildProvisioningHeaders({ body: '{}' })).toThrow(/now/);
  });

  test('throws when body is not a string', () => {
    expect(() => buildProvisioningHeaders({ body: {}, now: new Date() })).toThrow(/body/);
  });
});

describe('verifyProvisioningRequest', () => {
  function freshHeaders(body, now) {
    return buildProvisioningHeaders({ body, now });
  }

  test('happy path: returns ok', () => {
    const body = '{"x":1}';
    const now = new Date();
    const { headers } = freshHeaders(body, now);
    const v = verifyProvisioningRequest({
      body,
      timestamp: headers['X-SF-LB-Timestamp'],
      signature: headers['X-SF-LB-Signature'],
      now,
    });
    expect(v.ok).toBe(true);
  });

  test('tampered body → signature_mismatch', () => {
    const body = '{"x":1}';
    const now = new Date();
    const { headers } = freshHeaders(body, now);
    const v = verifyProvisioningRequest({
      body: '{"x":2}',
      timestamp: headers['X-SF-LB-Timestamp'],
      signature: headers['X-SF-LB-Signature'],
      now,
    });
    expect(v.ok).toBe(false);
    expect(v.reason).toBe('signature_mismatch');
  });

  test('refreshed timestamp without re-signing → signature_mismatch', () => {
    const body = '{"x":1}';
    const signedAt = new Date(Date.now() - 60_000);
    const { headers } = freshHeaders(body, signedAt);
    const v = verifyProvisioningRequest({
      body,
      timestamp: String(Math.floor(Date.now() / 1000)),  // refreshed
      signature: headers['X-SF-LB-Signature'],            // original
      now: new Date(),
    });
    expect(v.ok).toBe(false);
    expect(v.reason).toBe('signature_mismatch');
  });

  test('timestamp outside skew window → timestamp_skewed', () => {
    const body = '{"x":1}';
    const old  = new Date(Date.now() - 10 * 60_000);   // 10 minutes ago
    const { headers } = freshHeaders(body, old);
    const v = verifyProvisioningRequest({
      body,
      timestamp: headers['X-SF-LB-Timestamp'],
      signature: headers['X-SF-LB-Signature'],
      now: new Date(),
    });
    expect(v.ok).toBe(false);
    expect(v.reason).toBe('timestamp_skewed');
  });

  test('unparseable timestamp → timestamp_unparseable', () => {
    const v = verifyProvisioningRequest({
      body: '{}',
      timestamp: 'not-a-number',
      signature: 'a'.repeat(64),
      now: new Date(),
    });
    expect(v.ok).toBe(false);
    expect(v.reason).toBe('timestamp_unparseable');
  });

  test('missing fields → specific reason', () => {
    expect(verifyProvisioningRequest({ body: '{}',  timestamp: '0', signature: '', now: new Date() }).reason).toBe('signature_missing');
    expect(verifyProvisioningRequest({ body: '{}',  timestamp: '',  signature: 'x', now: new Date() }).reason).toBe('timestamp_missing');
    expect(verifyProvisioningRequest({ body: null, timestamp: '0', signature: 'x', now: new Date() }).reason).toBe('body_missing');
  });

  test('signature length mismatch → signature_mismatch (not crash)', () => {
    const v = verifyProvisioningRequest({
      body: '{}',
      timestamp: String(Math.floor(Date.now() / 1000)),
      signature: '01',                            // too short
      now: new Date(),
    });
    expect(v.ok).toBe(false);
    expect(v.reason).toBe('signature_mismatch');
  });

  test('shared secret unset → secret_not_configured', () => {
    const saved = process.env.SF_LB_PROVISIONING_SHARED_SECRET;
    delete process.env.SF_LB_PROVISIONING_SHARED_SECRET;
    const v = verifyProvisioningRequest({
      body: '{}',
      timestamp: String(Math.floor(Date.now() / 1000)),
      signature: 'a'.repeat(64),
      now: new Date(),
    });
    expect(v.ok).toBe(false);
    expect(v.reason).toBe('secret_not_configured');
    process.env.SF_LB_PROVISIONING_SHARED_SECRET = saved;
  });
});
