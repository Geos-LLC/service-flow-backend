'use strict';

/**
 * Architectural hardening — violation emitter tests.
 *
 * Covers the warn-only `[IdentityGraphViolation]` emitter:
 *   - canonical line format
 *   - closed-set kind enforcement
 *   - never throws
 *   - tenant/target/source/reason field handling
 *   - call-path summary capture
 *   - transitional-bypass convenience wrapper
 */

const {
  emitViolation,
  recordTransitionalBypass,
  summariseCallPath,
  isKnownKind,
  VIOLATION_KINDS,
  ALL_KINDS,
} = require('../lib/identity-graph-violation');

function makeLogger() {
  return {
    log:   jest.fn(),
    warn:  jest.fn(),
    error: jest.fn(),
  };
}

// ── Closed-set kind catalogue ─────────────────────────────────────

describe('VIOLATION_KINDS catalogue', () => {
  test('all canonical kinds defined', () => {
    expect(VIOLATION_KINDS.DIRECT_CONVERTED_CUSTOMER_ID_WRITE).toBe('direct_converted_customer_id_write');
    expect(VIOLATION_KINDS.DIRECT_PARENT_LEAD_ID_WRITE).toBe('direct_parent_lead_id_write');
    expect(VIOLATION_KINDS.DIRECT_LEAD_ORIGIN_TYPE_WRITE).toBe('direct_lead_origin_type_write');
    expect(VIOLATION_KINDS.DIRECT_SF_LEAD_ID_WRITE).toBe('direct_sf_lead_id_write');
    expect(VIOLATION_KINDS.DIRECT_SF_CUSTOMER_ID_WRITE).toBe('direct_sf_customer_id_write');
    expect(VIOLATION_KINDS.DIRECT_IDENTITY_PROJECTION_WRITE).toBe('direct_identity_projection_write');
    expect(VIOLATION_KINDS.INTEGRATION_BYPASS).toBe('integration_bypass');
    expect(VIOLATION_KINDS.OPERATOR_OVERRIDE_OUTSIDE_LINKER).toBe('operator_override_outside_linker');
    expect(VIOLATION_KINDS.TRANSITIONAL_BYPASS).toBe('transitional_bypass');
  });

  test('VIOLATION_KINDS is frozen', () => {
    expect(() => { VIOLATION_KINDS.FOO = 'foo'; }).toThrow();
    expect(Object.isFrozen(VIOLATION_KINDS)).toBe(true);
  });

  test('ALL_KINDS lists all 9 kinds', () => {
    expect(ALL_KINDS.length).toBe(9);
    expect(ALL_KINDS).toContain('direct_converted_customer_id_write');
    expect(ALL_KINDS).toContain('transitional_bypass');
  });

  test('isKnownKind accepts catalogue values and rejects strangers', () => {
    expect(isKnownKind('direct_converted_customer_id_write')).toBe(true);
    expect(isKnownKind('transitional_bypass')).toBe(true);
    expect(isKnownKind('totally_made_up_kind')).toBe(false);
    expect(isKnownKind('')).toBe(false);
    expect(isKnownKind(undefined)).toBe(false);
  });
});

// ── Canonical line format ────────────────────────────────────────

describe('emitViolation — line format', () => {
  test('emits a single [IdentityGraphViolation] warn line with all fields', () => {
    const logger = makeLogger();
    emitViolation(logger, {
      kind: VIOLATION_KINDS.DIRECT_CONVERTED_CUSTOMER_ID_WRITE,
      tenant: 2,
      target: 'leads.converted_customer_id',
      source: 'customer_merge_endpoint',
      reason: 'operator_initiated_customer_merge',
      includeCallPath: false,
    });

    expect(logger.warn).toHaveBeenCalledTimes(1);
    const line = logger.warn.mock.calls[0][0];
    expect(line).toMatch(/^\[IdentityGraphViolation\] /);
    expect(line).toMatch(/kind=direct_converted_customer_id_write/);
    expect(line).toMatch(/tenant=2/);
    expect(line).toMatch(/target=leads\.converted_customer_id/);
    expect(line).toMatch(/source=customer_merge_endpoint/);
    expect(line).toMatch(/reason=operator_initiated_customer_merge/);
  });

  test('omits optional fields when not provided', () => {
    const logger = makeLogger();
    emitViolation(logger, {
      kind: VIOLATION_KINDS.INTEGRATION_BYPASS,
      tenant: 7,
      includeCallPath: false,
    });

    const line = logger.warn.mock.calls[0][0];
    expect(line).toMatch(/kind=integration_bypass/);
    expect(line).toMatch(/tenant=7/);
    expect(line).not.toMatch(/target=/);
    expect(line).not.toMatch(/source=/);
    expect(line).not.toMatch(/reason=/);
  });

  test('tenant=null when not provided', () => {
    const logger = makeLogger();
    emitViolation(logger, {
      kind: VIOLATION_KINDS.DIRECT_PARENT_LEAD_ID_WRITE,
      includeCallPath: false,
    });
    expect(logger.warn.mock.calls[0][0]).toMatch(/tenant=null/);
  });

  test('tenant=0 (numeric zero, edge case) preserved', () => {
    // 0 is a legitimate user_id in some environments; must not be treated as null.
    const logger = makeLogger();
    emitViolation(logger, {
      kind: VIOLATION_KINDS.INTEGRATION_BYPASS,
      tenant: 0,
      includeCallPath: false,
    });
    expect(logger.warn.mock.calls[0][0]).toMatch(/tenant=0/);
  });
});

// ── Defensive posture (never throws, no false positives) ─────────

describe('emitViolation — defensive posture', () => {
  test('does nothing when logger is null/undefined', () => {
    expect(() => emitViolation(null, { kind: VIOLATION_KINDS.DIRECT_PARENT_LEAD_ID_WRITE })).not.toThrow();
    expect(() => emitViolation(undefined, { kind: VIOLATION_KINDS.DIRECT_PARENT_LEAD_ID_WRITE })).not.toThrow();
  });

  test('does nothing when logger has no warn method', () => {
    const logger = { log: () => {} };
    expect(() => emitViolation(logger, { kind: VIOLATION_KINDS.DIRECT_PARENT_LEAD_ID_WRITE })).not.toThrow();
  });

  test('does nothing when fields is null/undefined', () => {
    const logger = makeLogger();
    expect(() => emitViolation(logger, null)).not.toThrow();
    expect(() => emitViolation(logger, undefined)).not.toThrow();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  test('does nothing when kind is missing or empty', () => {
    const logger = makeLogger();
    emitViolation(logger, {});
    emitViolation(logger, { kind: '' });
    emitViolation(logger, { kind: null });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  test('swallows logger.warn errors', () => {
    const logger = { warn: jest.fn(() => { throw new Error('logger broken'); }) };
    expect(() => emitViolation(logger, {
      kind: VIOLATION_KINDS.INTEGRATION_BYPASS,
      tenant: 2,
      includeCallPath: false,
    })).not.toThrow();
  });

  test('NOT a false positive: well-formed fields produce one emit, not multiple', () => {
    const logger = makeLogger();
    emitViolation(logger, {
      kind: VIOLATION_KINDS.DIRECT_CONVERTED_CUSTOMER_ID_WRITE,
      tenant: 2,
      target: 'leads.converted_customer_id',
      source: 'test',
    });
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  test('NOT a false positive: emit does not affect logger.log or logger.error', () => {
    const logger = makeLogger();
    emitViolation(logger, { kind: VIOLATION_KINDS.INTEGRATION_BYPASS, includeCallPath: false });
    expect(logger.log).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });
});

// ── Call-path summary ─────────────────────────────────────────────

describe('summariseCallPath', () => {
  test('returns a string with file:line frames when invoked', () => {
    function level3() { return summariseCallPath(); }
    function level2() { return level3(); }
    function level1() { return level2(); }
    const path = level1();
    expect(typeof path).toBe('string');
    expect(path.length).toBeGreaterThan(0);
    // Should reference this test file at least once.
    expect(path).toMatch(/identity-graph-violation\.test\.js/);
  });

  test('respects maxFrames', () => {
    function deep(n) { return n === 0 ? summariseCallPath(2) : deep(n - 1); }
    const path = deep(20);
    // With maxFrames=2 we get at most 2 frame entries (joined by `;`).
    expect(path.split(';').length).toBeLessThanOrEqual(2);
  });

  test('filters the emitter file itself out of the summary', () => {
    const path = summariseCallPath();
    expect(path).not.toMatch(/identity-graph-violation\.js/);
  });

  test('emitViolation includes path=... when includeCallPath is default', () => {
    const logger = makeLogger();
    emitViolation(logger, {
      kind: VIOLATION_KINDS.INTEGRATION_BYPASS,
      tenant: 2,
    });
    expect(logger.warn.mock.calls[0][0]).toMatch(/path=/);
  });

  test('emitViolation omits path=... when includeCallPath=false', () => {
    const logger = makeLogger();
    emitViolation(logger, {
      kind: VIOLATION_KINDS.INTEGRATION_BYPASS,
      tenant: 2,
      includeCallPath: false,
    });
    expect(logger.warn.mock.calls[0][0]).not.toMatch(/path=/);
  });
});

// ── recordTransitionalBypass convenience wrapper ──────────────────

describe('recordTransitionalBypass', () => {
  test('emits a transitional_bypass kind with given fields', () => {
    const logger = makeLogger();
    recordTransitionalBypass(logger, {
      tenant: 2,
      target: 'leads.converted_customer_id',
      source: 'customer_merge_endpoint',
      reason: 'operator_initiated',
      includeCallPath: false,
    });
    const line = logger.warn.mock.calls[0][0];
    expect(line).toMatch(/kind=transitional_bypass/);
    expect(line).toMatch(/tenant=2/);
    expect(line).toMatch(/source=customer_merge_endpoint/);
    expect(line).toMatch(/reason=operator_initiated/);
  });

  test('overrides any kind passed by caller — wrapper enforces transitional', () => {
    const logger = makeLogger();
    recordTransitionalBypass(logger, {
      kind: 'something_else',
      tenant: 2,
      includeCallPath: false,
    });
    expect(logger.warn.mock.calls[0][0]).toMatch(/kind=transitional_bypass/);
  });

  test('does nothing when logger missing', () => {
    expect(() => recordTransitionalBypass(null, { tenant: 2 })).not.toThrow();
  });
});

// ── Tenant safety (no cross-tenant leakage in emitted lines) ──────

describe('tenant safety', () => {
  test('emitted line carries the exact tenant id provided (no inference)', () => {
    const logger = makeLogger();
    emitViolation(logger, {
      kind: VIOLATION_KINDS.INTEGRATION_BYPASS,
      tenant: 42,
      includeCallPath: false,
    });
    expect(logger.warn.mock.calls[0][0]).toMatch(/tenant=42/);
    // Make sure it isn't double-counted or coerced.
    expect(logger.warn.mock.calls[0][0].match(/tenant=/g).length).toBe(1);
  });

  test('numeric and string tenant ids both rendered', () => {
    const logger = makeLogger();
    emitViolation(logger, { kind: VIOLATION_KINDS.INTEGRATION_BYPASS, tenant: 2, includeCallPath: false });
    emitViolation(logger, { kind: VIOLATION_KINDS.INTEGRATION_BYPASS, tenant: '2', includeCallPath: false });
    expect(logger.warn.mock.calls[0][0]).toMatch(/tenant=2/);
    expect(logger.warn.mock.calls[1][0]).toMatch(/tenant=2/);
  });
});
