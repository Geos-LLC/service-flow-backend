/**
 * lb-orchestration-token.js + lb-orchestration-feature-flag.js
 *
 * Pure unit tests — no DB, no network. Verifies:
 *   - slot_token signs + verifies round-trip
 *   - tampered tokens rejected
 *   - expired tokens rejected
 *   - wrong-tenant tokens rejected
 *   - feature flag parses LB_ORCHESTRATION_ENABLED_TENANTS correctly
 *   - middleware returns 403 when tenant not enrolled
 *   - hashIdempotencyKey is deterministic + tenant-bound + endpoint-bound
 */

process.env.SF_INTEGRATION_ENC_KEY = Buffer.alloc(32, 7).toString('base64');

const {
  signSlotToken, verifySlotToken, hashIdempotencyKey, SLOT_TOKEN_PREFIX, DEFAULT_MAX_AGE_MS,
} = require('../lib/lb-orchestration-token');

describe('signSlotToken + verifySlotToken', () => {
  test('round-trip succeeds for a fresh token', () => {
    const tok = signSlotToken({
      tenant_id: 2, service_id: 5,
      start_iso: '2026-06-01T10:00:00Z', end_iso: '2026-06-01T13:00:00Z',
    });
    expect(tok.startsWith(SLOT_TOKEN_PREFIX + '.')).toBe(true);
    const v = verifySlotToken(tok, { expected_tenant_id: 2 });
    expect(v.valid).toBe(true);
    expect(v.payload.tenant_id).toBe(2);
    expect(v.payload.start_iso).toBe('2026-06-01T10:00:00Z');
    expect(v.payload.end_iso).toBe('2026-06-01T13:00:00Z');
  });

  test('tampered payload → bad_signature', () => {
    const tok = signSlotToken({
      tenant_id: 2, service_id: 5,
      start_iso: '2026-06-01T10:00:00Z', end_iso: '2026-06-01T13:00:00Z',
    });
    // Flip one char in the payload section
    const parts = tok.split('.');
    parts[1] = parts[1].slice(0, -2) + (parts[1].endsWith('A') ? 'B' : 'A') + parts[1].slice(-1);
    const tampered = parts.join('.');
    const v = verifySlotToken(tampered, { expected_tenant_id: 2 });
    expect(v.valid).toBe(false);
    expect(['bad_signature', 'malformed_payload']).toContain(v.reason);
  });

  test('tampered signature → bad_signature', () => {
    const tok = signSlotToken({
      tenant_id: 2, service_id: 5,
      start_iso: '2026-06-01T10:00:00Z', end_iso: '2026-06-01T13:00:00Z',
    });
    const parts = tok.split('.');
    parts[2] = parts[2].slice(0, -2) + 'AA';
    const v = verifySlotToken(parts.join('.'), { expected_tenant_id: 2 });
    expect(v.valid).toBe(false);
    expect(v.reason).toBe('bad_signature');
  });

  test('wrong tenant → tenant_mismatch', () => {
    const tok = signSlotToken({
      tenant_id: 2, service_id: 5,
      start_iso: '2026-06-01T10:00:00Z', end_iso: '2026-06-01T13:00:00Z',
    });
    const v = verifySlotToken(tok, { expected_tenant_id: 9 });
    expect(v.valid).toBe(false);
    expect(v.reason).toBe('tenant_mismatch');
  });

  test('expired token (max_age_ms=0) → expired', () => {
    const tok = signSlotToken({
      tenant_id: 2, service_id: 5,
      start_iso: '2026-06-01T10:00:00Z', end_iso: '2026-06-01T13:00:00Z',
    });
    const v = verifySlotToken(tok, { expected_tenant_id: 2, max_age_ms: 0 });
    expect(v.valid).toBe(false);
    expect(v.reason).toBe('expired');
  });

  test('malformed token → malformed', () => {
    expect(verifySlotToken('not-a-token').valid).toBe(false);
    expect(verifySlotToken('slot_v1.only-two-parts').valid).toBe(false);
    expect(verifySlotToken('slot_v2.x.y').valid).toBe(false);
    expect(verifySlotToken('').valid).toBe(false);
  });

  test('default max-age is 10 minutes', () => {
    expect(DEFAULT_MAX_AGE_MS).toBe(10 * 60 * 1000);
  });
});

describe('hashIdempotencyKey', () => {
  test('deterministic', () => {
    const a = hashIdempotencyKey(2, 'booking_request', 'key-1');
    const b = hashIdempotencyKey(2, 'booking_request', 'key-1');
    expect(a).toBe(b);
    expect(a).toHaveLength(16);
  });

  test('different tenant → different hash', () => {
    const a = hashIdempotencyKey(2, 'booking_request', 'key-1');
    const b = hashIdempotencyKey(9, 'booking_request', 'key-1');
    expect(a).not.toBe(b);
  });

  test('different endpoint → different hash', () => {
    const a = hashIdempotencyKey(2, 'booking_request', 'key-1');
    const b = hashIdempotencyKey(2, 'booking_cancel', 'key-1');
    expect(a).not.toBe(b);
  });

  test('null key → null', () => {
    expect(hashIdempotencyKey(2, 'booking_request', null)).toBeNull();
    expect(hashIdempotencyKey(2, 'booking_request', '')).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────
// Feature flag
// ──────────────────────────────────────────────────────────────────
describe('isOrchestrationEnabledForTenant', () => {
  // Re-require with manipulated env per test
  function freshFlag() {
    jest.resetModules();
    return require('../lib/lb-orchestration-feature-flag');
  }

  afterEach(() => { delete process.env.LB_ORCHESTRATION_ENABLED_TENANTS; });

  test('empty env → all tenants disabled', () => {
    delete process.env.LB_ORCHESTRATION_ENABLED_TENANTS;
    const { isOrchestrationEnabledForTenant } = freshFlag();
    expect(isOrchestrationEnabledForTenant(2)).toBe(false);
    expect(isOrchestrationEnabledForTenant(0)).toBe(false);
  });

  test('"*" → all tenants enabled', () => {
    process.env.LB_ORCHESTRATION_ENABLED_TENANTS = '*';
    const { isOrchestrationEnabledForTenant } = freshFlag();
    expect(isOrchestrationEnabledForTenant(2)).toBe(true);
    expect(isOrchestrationEnabledForTenant(9)).toBe(true);
  });

  test('"2,17" → only those tenants', () => {
    process.env.LB_ORCHESTRATION_ENABLED_TENANTS = '2,17';
    const { isOrchestrationEnabledForTenant } = freshFlag();
    expect(isOrchestrationEnabledForTenant(2)).toBe(true);
    expect(isOrchestrationEnabledForTenant(17)).toBe(true);
    expect(isOrchestrationEnabledForTenant(42)).toBe(false);
  });

  test('userId null → false', () => {
    process.env.LB_ORCHESTRATION_ENABLED_TENANTS = '*';
    const { isOrchestrationEnabledForTenant } = freshFlag();
    expect(isOrchestrationEnabledForTenant(null)).toBe(false);
  });

  test('requireOrchestrationEnabled middleware: 403 when disabled', () => {
    delete process.env.LB_ORCHESTRATION_ENABLED_TENANTS;
    const { requireOrchestrationEnabled } = freshFlag();
    let statusCode = null; let body = null;
    const res = {
      status(c) { statusCode = c; return this; },
      json(b) { body = b; return this; },
    };
    requireOrchestrationEnabled({ user: { userId: 2 } }, res, () => { throw new Error('should not call next') });
    expect(statusCode).toBe(403);
    expect(body.error).toBe('orchestration_not_enabled_for_tenant');
  });

  test('requireOrchestrationEnabled middleware: calls next when enabled', () => {
    process.env.LB_ORCHESTRATION_ENABLED_TENANTS = '2';
    const { requireOrchestrationEnabled } = freshFlag();
    let nextCalled = false;
    requireOrchestrationEnabled({ user: { userId: 2 } }, {}, () => { nextCalled = true; });
    expect(nextCalled).toBe(true);
  });
});
