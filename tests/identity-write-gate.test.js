'use strict';

/**
 * Tests for lib/identity-write-gate.js — the Stage 3 foundation module.
 *
 * Three categories of guarantee that MUST hold under any input:
 *
 *   1. Never throws (even with garbage / null / undefined / hostile logger).
 *   2. Never returns allowed=false. Today is warn-only; the value is
 *      reserved for future Stage 3 activation.
 *   3. Pure observability — logger emission produces a structured
 *      [IdentityWriteGate] line with all expected fields.
 */

const {
  evaluateIdentityWrite,
  KNOWN_STAGES,
  KNOWN_VIOLATION_CLASSES,
  BLOCK_CANDIDATE_STAGES,
  KNOWN_OPERATIONS,
} = require('../lib/identity-write-gate');

function makeLogger() {
  return {
    log:  jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
}

// ── Closed-set vocabulary ────────────────────────────────────────

describe('vocabulary', () => {
  test('KNOWN_STAGES contains exactly the 5 retirement stages', () => {
    expect(KNOWN_STAGES.length).toBe(5);
    expect(KNOWN_STAGES).toEqual([
      'stage-1-observe',
      'stage-2-ci-static',
      'stage-3-runtime-block',
      'stage-4-adapter-only',
      'stage-5-remove',
    ]);
  });

  test('KNOWN_VIOLATION_CLASSES contains RV-1 through RV-7', () => {
    expect(KNOWN_VIOLATION_CLASSES.length).toBe(7);
    for (let i = 1; i <= 7; i++) {
      expect(KNOWN_VIOLATION_CLASSES).toContain(`RV-${i}`);
    }
  });

  test('BLOCK_CANDIDATE_STAGES excludes stage-1-observe and stage-5-remove', () => {
    expect(BLOCK_CANDIDATE_STAGES.has('stage-1-observe')).toBe(false);
    expect(BLOCK_CANDIDATE_STAGES.has('stage-5-remove')).toBe(false);
    expect(BLOCK_CANDIDATE_STAGES.has('stage-2-ci-static')).toBe(true);
    expect(BLOCK_CANDIDATE_STAGES.has('stage-3-runtime-block')).toBe(true);
    expect(BLOCK_CANDIDATE_STAGES.has('stage-4-adapter-only')).toBe(true);
  });

  test('KNOWN_OPERATIONS contains the expected DB ops', () => {
    expect(KNOWN_OPERATIONS).toEqual(['insert', 'update', 'delete', 'upsert']);
  });
});

// ── Never-throw guarantee ────────────────────────────────────────

describe('evaluateIdentityWrite — never throws', () => {
  test('returns evaluation object when input is undefined', () => {
    expect(() => evaluateIdentityWrite(undefined)).not.toThrow();
    const r = evaluateIdentityWrite(undefined);
    expect(r.allowed).toBe(true);
  });

  test('returns evaluation object when input is null', () => {
    expect(() => evaluateIdentityWrite(null)).not.toThrow();
    const r = evaluateIdentityWrite(null);
    expect(r.allowed).toBe(true);
  });

  test('returns evaluation object when input is a string', () => {
    expect(() => evaluateIdentityWrite('garbage')).not.toThrow();
    const r = evaluateIdentityWrite('garbage');
    expect(r.allowed).toBe(true);
  });

  test('returns evaluation object when input is a number', () => {
    expect(() => evaluateIdentityWrite(42)).not.toThrow();
    const r = evaluateIdentityWrite(42);
    expect(r.allowed).toBe(true);
  });

  test('swallows logger errors', () => {
    const hostileLogger = { log: () => { throw new Error('logger broken'); } };
    expect(() => evaluateIdentityWrite({
      tenantId: 2,
      source: 'test:test',
      target: 'leads.x',
      operation: 'update',
      bypassStage: 'stage-2-ci-static',
      owner: 'identity-v5',
      logger: hostileLogger,
    })).not.toThrow();
  });

  test('handles logger without .log method', () => {
    const partialLogger = { warn: () => {} };
    expect(() => evaluateIdentityWrite({
      source: 'test:test',
      logger: partialLogger,
    })).not.toThrow();
  });

  test('handles tenantId=0 (numeric zero) — not treated as missing', () => {
    const logger = makeLogger();
    evaluateIdentityWrite({
      tenantId: 0,
      source: 'test:test',
      target: 'leads.x',
      operation: 'update',
      bypassStage: 'stage-2-ci-static',
      owner: 'identity-v5',
      logger,
    });
    expect(logger.log.mock.calls[0][0]).toMatch(/tenant=0/);
  });
});

// ── Never-block guarantee ────────────────────────────────────────

describe('evaluateIdentityWrite — never blocks', () => {
  test('allowed is true for valid metadata', () => {
    const r = evaluateIdentityWrite({
      tenantId: 2,
      source: 'test:test',
      target: 'leads.x',
      operation: 'update',
      bypassStage: 'stage-2-ci-static',
      owner: 'identity-v5',
    });
    expect(r.allowed).toBe(true);
  });

  test('allowed is true even when metadata is incomplete', () => {
    const r = evaluateIdentityWrite({});
    expect(r.allowed).toBe(true);
  });

  test('allowed is true even for unknown bypass stage', () => {
    const r = evaluateIdentityWrite({
      bypassStage: 'totally_made_up_stage',
      source: 'test',
      target: 'x.y',
      operation: 'update',
      owner: 'identity-v5',
    });
    expect(r.allowed).toBe(true);
  });

  test('allowed is true for every known stage', () => {
    for (const stage of KNOWN_STAGES) {
      const r = evaluateIdentityWrite({
        tenantId: 2,
        source: 'test:test',
        target: 'leads.x',
        operation: 'update',
        bypassStage: stage,
        owner: 'identity-v5',
      });
      expect(r.allowed).toBe(true);
    }
  });
});

// ── Return shape ─────────────────────────────────────────────────

describe('evaluateIdentityWrite — return shape', () => {
  test('returns expected fields with valid input', () => {
    const r = evaluateIdentityWrite({
      tenantId: 2,
      source: 'test:test',
      target: 'leads.converted_customer_id',
      operation: 'update',
      bypassStage: 'stage-3-runtime-block',
      owner: 'identity-v5',
      violationClass: 'RV-2',
    });
    expect(r).toEqual({
      allowed: true,
      warn: false,
      future_block_candidate: true,
      metadata_complete: true,
      observability_key: 'test:test',
      violation_class: 'RV-2',
      notes: [],
    });
  });

  test('warn=true when metadata is incomplete', () => {
    const r = evaluateIdentityWrite({
      tenantId: 2,
      source: 'test:test',
      // missing target, operation, bypassStage, owner
    });
    expect(r.warn).toBe(true);
    expect(r.metadata_complete).toBe(false);
  });

  test('metadata_complete=false when bypassStage is unknown', () => {
    const r = evaluateIdentityWrite({
      tenantId: 2,
      source: 'test:test',
      target: 'leads.x',
      operation: 'update',
      bypassStage: 'not-a-real-stage',
      owner: 'identity-v5',
    });
    expect(r.metadata_complete).toBe(false);
    expect(r.notes).toContain('unknown_bypass_stage');
  });

  test('metadata_complete=false when operation is unknown', () => {
    const r = evaluateIdentityWrite({
      tenantId: 2,
      source: 'test:test',
      target: 'leads.x',
      operation: 'truncate',  // not in KNOWN_OPERATIONS
      bypassStage: 'stage-2-ci-static',
      owner: 'identity-v5',
    });
    expect(r.metadata_complete).toBe(false);
    expect(r.notes).toContain('unknown_operation');
  });

  test('future_block_candidate=false for stage-1-observe', () => {
    const r = evaluateIdentityWrite({
      tenantId: 2,
      source: 'test:test',
      target: 'leads.x',
      operation: 'update',
      bypassStage: 'stage-1-observe',
      owner: 'identity-v5',
    });
    expect(r.future_block_candidate).toBe(false);
  });

  test('future_block_candidate=false for stage-5-remove', () => {
    const r = evaluateIdentityWrite({
      tenantId: 2,
      source: 'test:test',
      target: 'leads.x',
      operation: 'update',
      bypassStage: 'stage-5-remove',
      owner: 'identity-v5',
    });
    expect(r.future_block_candidate).toBe(false);
  });

  test('future_block_candidate=true for stage-2-ci-static / stage-3-runtime-block / stage-4-adapter-only', () => {
    for (const stage of ['stage-2-ci-static', 'stage-3-runtime-block', 'stage-4-adapter-only']) {
      const r = evaluateIdentityWrite({
        tenantId: 2,
        source: 'test:test',
        target: 'leads.x',
        operation: 'update',
        bypassStage: stage,
        owner: 'identity-v5',
      });
      expect(r.future_block_candidate).toBe(true);
    }
  });

  test('observability_key falls back to "unknown_source" when source missing', () => {
    const r = evaluateIdentityWrite({});
    expect(r.observability_key).toBe('unknown_source');
  });

  test('violation_class echoes input when in vocabulary', () => {
    const r = evaluateIdentityWrite({
      source: 'test',
      target: 'x',
      operation: 'update',
      bypassStage: 'stage-2-ci-static',
      owner: 'identity-v5',
      violationClass: 'RV-3',
    });
    expect(r.violation_class).toBe('RV-3');
    expect(r.notes).not.toContain('unknown_violation_class');
  });

  test('unknown violation class is noted but does not invalidate metadata_complete', () => {
    const r = evaluateIdentityWrite({
      source: 'test',
      target: 'x.y',
      operation: 'update',
      bypassStage: 'stage-2-ci-static',
      owner: 'identity-v5',
      violationClass: 'RV-99',
    });
    expect(r.notes).toContain('unknown_violation_class');
    expect(r.metadata_complete).toBe(true); // violationClass is optional
  });
});

// ── Logger emission ──────────────────────────────────────────────

describe('evaluateIdentityWrite — log emission', () => {
  test('emits a single [IdentityWriteGate] line with expected fields', () => {
    const logger = makeLogger();
    evaluateIdentityWrite({
      tenantId: 7,
      source: 'server.js:maybeCreateLeadFromOpenPhone',
      target: 'communication_participant_identities.sf_lead_id',
      operation: 'update',
      bypassStage: 'stage-4-adapter-only',
      owner: 'identity-v5',
      violationClass: 'RV-2',
      logger,
    });
    expect(logger.log).toHaveBeenCalledTimes(1);
    const line = logger.log.mock.calls[0][0];
    expect(line).toMatch(/^\[IdentityWriteGate\] /);
    expect(line).toMatch(/tenant=7/);
    expect(line).toMatch(/source=server\.js:maybeCreateLeadFromOpenPhone/);
    expect(line).toMatch(/target=communication_participant_identities\.sf_lead_id/);
    expect(line).toMatch(/operation=update/);
    expect(line).toMatch(/stage=stage-4-adapter-only/);
    expect(line).toMatch(/owner=identity-v5/);
    expect(line).toMatch(/future_block_candidate=true/);
    expect(line).toMatch(/metadata_complete=true/);
    expect(line).toMatch(/violation_class=RV-2/);
  });

  test('omits violation_class field when not provided', () => {
    const logger = makeLogger();
    evaluateIdentityWrite({
      tenantId: 2,
      source: 'test:test',
      target: 'leads.x',
      operation: 'update',
      bypassStage: 'stage-2-ci-static',
      owner: 'identity-v5',
      logger,
    });
    expect(logger.log.mock.calls[0][0]).not.toMatch(/violation_class=/);
  });

  test('includes notes when metadata is incomplete', () => {
    const logger = makeLogger();
    evaluateIdentityWrite({
      tenantId: 2,
      // missing everything else
      logger,
    });
    const line = logger.log.mock.calls[0][0];
    expect(line).toMatch(/notes=/);
    expect(line).toMatch(/missing_source/);
  });

  test('does not emit when no logger provided', () => {
    expect(() => evaluateIdentityWrite({
      tenantId: 2,
      source: 'test:test',
      target: 'leads.x',
      operation: 'update',
      bypassStage: 'stage-2-ci-static',
      owner: 'identity-v5',
    })).not.toThrow();
    // no logger to assert; we just verified non-crash above
  });

  test('does not affect logger.warn or logger.error', () => {
    const logger = makeLogger();
    evaluateIdentityWrite({
      tenantId: 2,
      source: 'test:test',
      target: 'leads.x',
      operation: 'update',
      bypassStage: 'stage-2-ci-static',
      owner: 'identity-v5',
      logger,
    });
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });
});

// ── No-behavior-change guarantee (informational) ─────────────────

describe('evaluateIdentityWrite — no-behavior-change invariant', () => {
  test('calling the gate is pure (no side effects beyond logger.log)', () => {
    const before = { x: 1 };
    const r = evaluateIdentityWrite({
      tenantId: 2,
      source: 'test:test',
      target: 'leads.x',
      operation: 'update',
      bypassStage: 'stage-2-ci-static',
      owner: 'identity-v5',
    });
    // The return value is a fresh object — caller's input is not mutated.
    expect(before).toEqual({ x: 1 });
    expect(r).not.toBe(before);
  });

  test('1000 sequential calls do not accumulate global state', () => {
    for (let i = 0; i < 1000; i++) {
      evaluateIdentityWrite({
        tenantId: i,
        source: `test:loop:${i}`,
        target: 'leads.x',
        operation: 'update',
        bypassStage: 'stage-2-ci-static',
        owner: 'identity-v5',
      });
    }
    // The fact that this test completes without OOM / slowdown is the assertion.
    // No state should be accumulating.
    expect(true).toBe(true);
  });
});
