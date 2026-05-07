/**
 * PR-2 — webhook signature verification tests.
 *
 * Pure unit tests for lib/webhook-signature.js. The handler integration
 * is tested separately in tests/sigcore-webhook-auth.test.js and
 * tests/lb-webhook-auth.test.js.
 */

const crypto = require('crypto');
const {
  DEFAULT_TOLERANCE_S,
  verifySingleHmac,
  verifyTimestampWindow,
  findMatchingCandidate,
  authenticateWebhook,
} = require('../lib/webhook-signature');

const { FLAGS, isEnabled } = require('../lib/feature-flags');

// Helper — produce a valid signature for a given secret/timestamp/body
function signWith(secret, ts, body) {
  return crypto.createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');
}

describe('verifySingleHmac', () => {
  test('valid signature → { valid: true, reason: null }', () => {
    const secret = 'sekret-1';
    const ts = '1714780800';
    const body = '{"event":"x"}';
    const sig = signWith(secret, ts, body);
    const r = verifySingleHmac({ secret, signatureHeader: sig, timestamp: ts, rawBody: body });
    expect(r).toEqual({ valid: true, reason: null });
  });

  test('tolerates sha256= prefix on signature header', () => {
    const secret = 'sekret-1';
    const ts = '1714780800';
    const body = '{"a":1}';
    const sig = 'sha256=' + signWith(secret, ts, body);
    expect(verifySingleHmac({ secret, signatureHeader: sig, timestamp: ts, rawBody: body }).valid).toBe(true);
  });

  test('case-insensitive sha256= prefix', () => {
    const secret = 'k';
    const ts = '1';
    const body = 'b';
    const sig = 'SHA256=' + signWith(secret, ts, body);
    expect(verifySingleHmac({ secret, signatureHeader: sig, timestamp: ts, rawBody: body }).valid).toBe(true);
  });

  test('tampered body → mismatch', () => {
    const secret = 'sekret-1';
    const ts = '1714780800';
    const body = '{"event":"x"}';
    const sig = signWith(secret, ts, body);
    const r = verifySingleHmac({ secret, signatureHeader: sig, timestamp: ts, rawBody: '{"event":"y"}' });
    expect(r.valid).toBe(false);
    expect(r.reason).toBe('signature_mismatch');
  });

  test('tampered timestamp → mismatch', () => {
    const secret = 'sekret-1';
    const ts = '1714780800';
    const body = '{}';
    const sig = signWith(secret, ts, body);
    expect(verifySingleHmac({ secret, signatureHeader: sig, timestamp: '1714780801', rawBody: body }).valid).toBe(false);
  });

  test('wrong secret → mismatch', () => {
    const ts = '1';
    const body = '{}';
    const sig = signWith('right', ts, body);
    expect(verifySingleHmac({ secret: 'wrong', signatureHeader: sig, timestamp: ts, rawBody: body }).valid).toBe(false);
  });

  test('missing inputs', () => {
    expect(verifySingleHmac({ secret: '', signatureHeader: 'a', timestamp: '1', rawBody: 'b' }).reason).toBe('missing_secret');
    expect(verifySingleHmac({ secret: 's', signatureHeader: '', timestamp: '1', rawBody: 'b' }).reason).toBe('missing_signature');
    expect(verifySingleHmac({ secret: 's', signatureHeader: 'a', timestamp: '', rawBody: 'b' }).reason).toBe('missing_timestamp');
  });

  test('non-hex signature → invalid_hex (not a crash)', () => {
    const r = verifySingleHmac({ secret: 's', signatureHeader: 'not-hex!', timestamp: '1', rawBody: 'b' });
    expect(r.valid).toBe(false);
    // Either length_mismatch or invalid_hex depending on hex parser tolerance
    expect(['invalid_hex', 'length_mismatch', 'signature_mismatch']).toContain(r.reason);
  });

  test('Buffer rawBody works the same as string', () => {
    const secret = 'k';
    const ts = '1';
    const body = '{"x":1}';
    const sig = signWith(secret, ts, body);
    expect(verifySingleHmac({ secret, signatureHeader: sig, timestamp: ts, rawBody: Buffer.from(body) }).valid).toBe(true);
  });

  test('timing-safe even on length-mismatch (no early throw)', () => {
    // Provided sig is half-length — should fail length check, not throw.
    expect(() => verifySingleHmac({
      secret: 'k', signatureHeader: 'abc', timestamp: '1', rawBody: 'b',
    })).not.toThrow();
  });
});

describe('verifyTimestampWindow', () => {
  test('within tolerance', () => {
    expect(verifyTimestampWindow('1000', 60, 1000).valid).toBe(true);
    expect(verifyTimestampWindow('1059', 60, 1000).valid).toBe(true);
    expect(verifyTimestampWindow('941', 60, 1000).valid).toBe(true);
  });

  test('outside tolerance', () => {
    const r = verifyTimestampWindow('1000', 60, 1100);
    expect(r.valid).toBe(false);
    expect(r.reason).toBe('stale_timestamp');
  });

  test('invalid timestamp', () => {
    expect(verifyTimestampWindow('not-a-number').valid).toBe(false);
    expect(verifyTimestampWindow('').valid).toBe(false);
    expect(verifyTimestampWindow(null).valid).toBe(false);
  });

  test('default tolerance is 5 minutes', () => {
    expect(DEFAULT_TOLERANCE_S).toBe(300);
  });
});

describe('findMatchingCandidate', () => {
  test('returns the first matching candidate', () => {
    const ts = '100';
    const body = '{"e":1}';
    const candidates = [
      { user_id: 1, secret: 'wrong-1' },
      { user_id: 2, secret: 'right-secret' },
      { user_id: 3, secret: 'wrong-3' },
    ];
    const sig = signWith('right-secret', ts, body);
    const m = findMatchingCandidate(candidates, { signatureHeader: sig, timestamp: ts, rawBody: body });
    expect(m).toBeTruthy();
    expect(m.user_id).toBe(2);
  });

  test('returns null when no candidate matches', () => {
    const candidates = [{ user_id: 1, secret: 'a' }, { user_id: 2, secret: 'b' }];
    const sig = signWith('c', '1', 'x');
    expect(findMatchingCandidate(candidates, { signatureHeader: sig, timestamp: '1', rawBody: 'x' })).toBeNull();
  });

  test('empty / null candidates', () => {
    expect(findMatchingCandidate([], { signatureHeader: 'x', timestamp: '1', rawBody: 'b' })).toBeNull();
    expect(findMatchingCandidate(null, { signatureHeader: 'x', timestamp: '1', rawBody: 'b' })).toBeNull();
  });
});

describe('authenticateWebhook', () => {
  function ok(opts) { return authenticateWebhook(opts); }
  const ts = String(Math.floor(Date.now() / 1000));
  const body = '{"event":"x"}';

  test('accepts valid signature against matching candidate', () => {
    const cand = { user_id: 42, secret: 'k' };
    const sig = signWith('k', ts, body);
    const r = ok({
      signatureHeader: sig, timestampHeader: ts, rawBody: body, candidates: [cand],
    });
    expect(r.ok).toBe(true);
    expect(r.candidate.user_id).toBe(42);
  });

  test('rejects missing signature header', () => {
    const r = ok({ signatureHeader: '', timestampHeader: ts, rawBody: body, candidates: [{ user_id: 1, secret: 'k' }] });
    expect(r).toEqual({ ok: false, status: 401, reason: 'missing_signature_or_timestamp' });
  });

  test('rejects missing timestamp', () => {
    const r = ok({ signatureHeader: 'abc', timestampHeader: '', rawBody: body, candidates: [] });
    expect(r).toEqual({ ok: false, status: 401, reason: 'missing_signature_or_timestamp' });
  });

  test('rejects stale timestamp (replay protection)', () => {
    const old = String(Math.floor(Date.now() / 1000) - 400);
    const sig = signWith('k', old, body);
    const r = ok({ signatureHeader: sig, timestampHeader: old, rawBody: body, candidates: [{ user_id: 1, secret: 'k' }] });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(401);
    expect(r.reason).toBe('stale_timestamp');
  });

  test('rejects when no candidates configured', () => {
    const sig = signWith('k', ts, body);
    const r = ok({ signatureHeader: sig, timestampHeader: ts, rawBody: body, candidates: [] });
    expect(r).toEqual({ ok: false, status: 401, reason: 'no_candidates' });
  });

  test('rejects when signature does not match any candidate', () => {
    const sig = signWith('not-our-secret', ts, body);
    const r = ok({ signatureHeader: sig, timestampHeader: ts, rawBody: body, candidates: [{ user_id: 1, secret: 'k' }] });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(401);
    expect(r.reason).toBe('signature_mismatch');
  });

  test('replay timestamp BEFORE the body change → still mismatch', () => {
    // Attacker tries to reuse a captured (sig, ts) pair on a different body.
    const goodTs = ts;
    const goodBody = body;
    const goodSig = signWith('k', goodTs, goodBody);
    const r = ok({
      signatureHeader: goodSig,
      timestampHeader: goodTs,
      rawBody: '{"different":true}',
      candidates: [{ user_id: 1, secret: 'k' }],
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('signature_mismatch');
  });

  test('cross-tenant attempt: signing with tenant A secret reaches tenant A only', () => {
    const tenA = { user_id: 100, secret: 'A' };
    const tenB = { user_id: 200, secret: 'B' };
    const sig = signWith('A', ts, body);
    const r = ok({ signatureHeader: sig, timestampHeader: ts, rawBody: body, candidates: [tenA, tenB] });
    expect(r.ok).toBe(true);
    expect(r.candidate.user_id).toBe(100); // not 200 — signature determines tenant
  });
});

describe('feature flag wiring', () => {
  afterEach(() => {
    delete process.env.SIGCORE_WEBHOOK_HMAC_REQUIRED;
    delete process.env.LB_INBOUND_HMAC_REQUIRED;
  });

  test('SIGCORE_WEBHOOK_HMAC_REQUIRED is registered + defaults OFF', () => {
    expect(FLAGS.SIGCORE_WEBHOOK_HMAC_REQUIRED).toBe('SIGCORE_WEBHOOK_HMAC_REQUIRED');
    expect(isEnabled(FLAGS.SIGCORE_WEBHOOK_HMAC_REQUIRED)).toBe(false);
  });

  test('LB_INBOUND_HMAC_REQUIRED is registered + defaults OFF', () => {
    expect(FLAGS.LB_INBOUND_HMAC_REQUIRED).toBe('LB_INBOUND_HMAC_REQUIRED');
    expect(isEnabled(FLAGS.LB_INBOUND_HMAC_REQUIRED)).toBe(false);
  });

  test('env opt-in turns each flag on', () => {
    process.env.SIGCORE_WEBHOOK_HMAC_REQUIRED = '1';
    expect(isEnabled(FLAGS.SIGCORE_WEBHOOK_HMAC_REQUIRED)).toBe(true);
    process.env.LB_INBOUND_HMAC_REQUIRED = 'true';
    expect(isEnabled(FLAGS.LB_INBOUND_HMAC_REQUIRED)).toBe(true);
  });
});
