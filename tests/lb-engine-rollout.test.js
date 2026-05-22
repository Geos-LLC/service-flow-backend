'use strict';

// Stage 2 — LeadBridge engine rollout + prerequisite tests.
//
// Drives lib/lb-engine-adapter.js with various feature-flag combinations
// to verify:
//   - per-tenant flag gating (engine for user 2, legacy for user 3)
//   - prerequisite chain enforcement (silent fallback if engine flag is on
//     but resolver / child-leads prereqs are missing)
//   - rate-limited warning format on prerequisite-miss
//   - legacy fallback preserves exact old behaviour
//
// See docs/architecture/stage-2-leadbridge-adapter-plan.md §7.2.

const {
  checkPrerequisites,
  emitPrereqMissingWarning,
  tenantPolicyForLB,
  _resetPrereqWarnCache,
} = require('../lib/lb-engine-adapter');
const { FLAGS } = require('../lib/feature-flags');

function makeLogger() {
  const calls = { log: [], warn: [], error: [] };
  return {
    log:   (msg) => calls.log.push(msg),
    warn:  (msg) => calls.warn.push(msg),
    error: (msg) => calls.error.push(msg),
    _calls: calls,
  };
}

function clearAllEngineFlags() {
  for (const name of Object.values(FLAGS)) {
    delete process.env[name];
    delete process.env[`${name}_TENANTS`];
  }
}

afterEach(() => {
  clearAllEngineFlags();
  _resetPrereqWarnCache();
});

// ── #1: All engine flags unset → legacy path, no warn ─────────────────

describe('rollout #1 — engine flag absent', () => {
  test('checkPrerequisites returns useEngine=false, engineFlagOn=false, no missing', () => {
    const p = checkPrerequisites(2);
    expect(p).toEqual({ useEngine: false, missing: [], engineFlagOn: false });
  });
  test('no warn emitted when engine flag absent', () => {
    const logger = makeLogger();
    emitPrereqMissingWarning(logger, 2, []);
    expect(logger._calls.warn.length).toBe(0);
  });
});

// ── #2: All three flags ON for user 2 → useEngine=true ────────────────

describe('rollout #2 — engine path enabled for user 2', () => {
  test('checkPrerequisites returns useEngine=true when all three flags include user 2', () => {
    process.env[`${FLAGS.RECONCILIATION_ENGINE_LEADBRIDGE}_TENANTS`] = '2';
    process.env[`${FLAGS.IDENTITY_RESOLVER_LEADBRIDGE}_TENANTS`] = '2';
    process.env[`${FLAGS.LEAD_CARDINALITY_CHILD_LEADS}_TENANTS`] = '2';
    const p = checkPrerequisites(2);
    expect(p).toEqual({ useEngine: true, missing: [], engineFlagOn: true });
  });
});

// ── #3: All three flags ON for user 2, user 3 untouched ──────────────

describe('rollout #3 — per-tenant isolation', () => {
  test('engine flag for user 2 does NOT affect user 3', () => {
    process.env[`${FLAGS.RECONCILIATION_ENGINE_LEADBRIDGE}_TENANTS`] = '2';
    process.env[`${FLAGS.IDENTITY_RESOLVER_LEADBRIDGE}_TENANTS`] = '2';
    process.env[`${FLAGS.LEAD_CARDINALITY_CHILD_LEADS}_TENANTS`] = '2';
    const p3 = checkPrerequisites(3);
    expect(p3.useEngine).toBe(false);
    expect(p3.engineFlagOn).toBe(false);
  });
});

// ── #4: Engine ON + resolver prereq missing → useEngine=false, missing=[resolver]

describe('rollout #4 — missing resolver prerequisite', () => {
  test('checkPrerequisites flags resolver as missing', () => {
    process.env[`${FLAGS.RECONCILIATION_ENGINE_LEADBRIDGE}_TENANTS`] = '2';
    process.env[`${FLAGS.LEAD_CARDINALITY_CHILD_LEADS}_TENANTS`] = '2';
    // intentionally NOT setting IDENTITY_RESOLVER_LEADBRIDGE_TENANTS
    const p = checkPrerequisites(2);
    expect(p.useEngine).toBe(false);
    expect(p.engineFlagOn).toBe(true);
    expect(p.missing).toEqual(['resolver']);
  });

  test('emitPrereqMissingWarning produces exact log shape', () => {
    const logger = makeLogger();
    const fired = emitPrereqMissingWarning(logger, 2, ['resolver']);
    expect(fired).toBe(true);
    expect(logger._calls.warn).toEqual([
      '[LB engine] path=legacy reason=missing_prerequisite tenant=2 missing=resolver',
    ]);
  });
});

// ── #5: Engine ON + child-leads prereq missing → useEngine=false, missing=[child_leads]

describe('rollout #5 — missing child-leads prerequisite', () => {
  test('checkPrerequisites flags child_leads as missing', () => {
    process.env[`${FLAGS.RECONCILIATION_ENGINE_LEADBRIDGE}_TENANTS`] = '2';
    process.env[`${FLAGS.IDENTITY_RESOLVER_LEADBRIDGE}_TENANTS`] = '2';
    const p = checkPrerequisites(2);
    expect(p.useEngine).toBe(false);
    expect(p.engineFlagOn).toBe(true);
    expect(p.missing).toEqual(['child_leads']);
  });

  test('emitPrereqMissingWarning produces exact log shape', () => {
    const logger = makeLogger();
    emitPrereqMissingWarning(logger, 2, ['child_leads']);
    expect(logger._calls.warn).toEqual([
      '[LB engine] path=legacy reason=missing_prerequisite tenant=2 missing=child_leads',
    ]);
  });
});

// ── #6: Engine ON + BOTH prereqs missing → useEngine=false, missing=[child_leads,resolver] sorted

describe('rollout #6 — both prereqs missing, alphabetised', () => {
  test('checkPrerequisites returns both missing entries', () => {
    process.env[`${FLAGS.RECONCILIATION_ENGINE_LEADBRIDGE}_TENANTS`] = '2';
    const p = checkPrerequisites(2);
    expect(p.useEngine).toBe(false);
    expect(p.engineFlagOn).toBe(true);
    expect(p.missing.sort()).toEqual(['child_leads', 'resolver']);
  });

  test('emitPrereqMissingWarning sorts missing values alphabetically', () => {
    const logger = makeLogger();
    // Pass in deliberately unsorted to assert the sort happens inside emit.
    emitPrereqMissingWarning(logger, 2, ['resolver', 'child_leads']);
    expect(logger._calls.warn).toEqual([
      '[LB engine] path=legacy reason=missing_prerequisite tenant=2 missing=child_leads,resolver',
    ]);
  });
});

// ── #7: Same-tenant rate-limit — warn fires at most once ─────────────

describe('rollout #7 — same-tenant rate-limit', () => {
  test('10 identical prereq-miss calls emit exactly 1 warn', () => {
    const logger = makeLogger();
    for (let i = 0; i < 10; i++) {
      emitPrereqMissingWarning(logger, 2, ['resolver']);
    }
    expect(logger._calls.warn.length).toBe(1);
  });
});

// ── #8: Different-tenant suppression — each tenant logs once ─────────

describe('rollout #8 — different-tenant suppression', () => {
  test('user 2 prereq-miss + user 7 prereq-miss (same missing) → 2 warns', () => {
    const logger = makeLogger();
    emitPrereqMissingWarning(logger, 2, ['resolver']);
    emitPrereqMissingWarning(logger, 7, ['resolver']);
    expect(logger._calls.warn.length).toBe(2);
    expect(logger._calls.warn[0]).toContain('tenant=2');
    expect(logger._calls.warn[1]).toContain('tenant=7');
  });
});

// ── #9: Different-missing-set suppression — keyed by (tenant, missingSet)

describe('rollout #9 — different missing-set suppression', () => {
  test('same tenant, different missing sets each fire once', () => {
    const logger = makeLogger();
    emitPrereqMissingWarning(logger, 2, ['resolver']);                  // fires 1
    emitPrereqMissingWarning(logger, 2, ['resolver']);                  // suppressed
    emitPrereqMissingWarning(logger, 2, ['child_leads', 'resolver']);   // different key → fires 2
    emitPrereqMissingWarning(logger, 2, ['child_leads']);               // different key → fires 3
    emitPrereqMissingWarning(logger, 2, ['child_leads']);               // suppressed
    expect(logger._calls.warn.length).toBe(3);
  });
});

// ── #10: Suppression reset via test hook (simulates process restart) ─

describe('rollout #10 — suppression reset', () => {
  test('_resetPrereqWarnCache clears suppression; next call re-fires', () => {
    const logger = makeLogger();
    emitPrereqMissingWarning(logger, 2, ['resolver']);          // fires
    emitPrereqMissingWarning(logger, 2, ['resolver']);          // suppressed
    expect(logger._calls.warn.length).toBe(1);
    _resetPrereqWarnCache();
    emitPrereqMissingWarning(logger, 2, ['resolver']);          // fires again
    expect(logger._calls.warn.length).toBe(2);
  });
});

// ── #11: tenantPolicyForLB reflects flag state ─────────────────────────

describe('rollout #11 — tenantPolicyForLB reads flags per-call', () => {
  test('no flags set → policy is all-false', () => {
    const p = tenantPolicyForLB(2);
    expect(p).toEqual({
      childLeadsEnabled: false,
      reactivationLeadsEnabled: false,
      conditionalLeadCreationEnabled: false,
      freeze: false,
      allowStageMove: false,
    });
  });

  test('child-leads enabled for tenant → both childLeadsEnabled + reactivationLeadsEnabled true', () => {
    process.env[`${FLAGS.LEAD_CARDINALITY_CHILD_LEADS}_TENANTS`] = '2';
    const p = tenantPolicyForLB(2);
    expect(p.childLeadsEnabled).toBe(true);
    expect(p.reactivationLeadsEnabled).toBe(true);
  });

  test('IDENTITY_PROJECTION_FREEZE global ON → freeze=true', () => {
    process.env[FLAGS.IDENTITY_PROJECTION_FREEZE] = '1';
    const p = tenantPolicyForLB(2);
    expect(p.freeze).toBe(true);
  });

  test('policy re-reads env on every call (no caching)', () => {
    let p = tenantPolicyForLB(2);
    expect(p.childLeadsEnabled).toBe(false);
    process.env[`${FLAGS.LEAD_CARDINALITY_CHILD_LEADS}_TENANTS`] = '2';
    p = tenantPolicyForLB(2);
    expect(p.childLeadsEnabled).toBe(true);
    delete process.env[`${FLAGS.LEAD_CARDINALITY_CHILD_LEADS}_TENANTS`];
    p = tenantPolicyForLB(2);
    expect(p.childLeadsEnabled).toBe(false);
  });
});

// ── #12: Mixed-tenant batch — user 2 engine, user 3 legacy ───────────

describe('rollout #12 — mixed-tenant batch', () => {
  test('checkPrerequisites returns correct shape per tenant in same process', () => {
    process.env[`${FLAGS.RECONCILIATION_ENGINE_LEADBRIDGE}_TENANTS`] = '2';
    process.env[`${FLAGS.IDENTITY_RESOLVER_LEADBRIDGE}_TENANTS`] = '2';
    process.env[`${FLAGS.LEAD_CARDINALITY_CHILD_LEADS}_TENANTS`] = '2';

    const p2 = checkPrerequisites(2);
    const p3 = checkPrerequisites(3);

    expect(p2.useEngine).toBe(true);
    expect(p3.useEngine).toBe(false);
    expect(p3.engineFlagOn).toBe(false);
  });
});

// ── #13: No flag caching within a request — clear mid-process ────────

describe('rollout #13 — no flag caching', () => {
  test('clearing env mid-process flips checkPrerequisites result', () => {
    process.env[`${FLAGS.RECONCILIATION_ENGINE_LEADBRIDGE}_TENANTS`] = '2';
    process.env[`${FLAGS.IDENTITY_RESOLVER_LEADBRIDGE}_TENANTS`] = '2';
    process.env[`${FLAGS.LEAD_CARDINALITY_CHILD_LEADS}_TENANTS`] = '2';
    expect(checkPrerequisites(2).useEngine).toBe(true);
    delete process.env[`${FLAGS.RECONCILIATION_ENGINE_LEADBRIDGE}_TENANTS`];
    expect(checkPrerequisites(2).useEngine).toBe(false);
    expect(checkPrerequisites(2).engineFlagOn).toBe(false);
  });
});

// ── #14: Log-shape regression — ensure format stays stable ───────────

describe('rollout #14 — log shape regression', () => {
  test('the warn log format matches the runbook specification exactly', () => {
    const logger = makeLogger();
    emitPrereqMissingWarning(logger, 42, ['resolver', 'child_leads']);
    // Exact format: [LB engine] path=legacy reason=missing_prerequisite tenant=<id> missing=<sorted-csv>
    expect(logger._calls.warn[0]).toBe(
      '[LB engine] path=legacy reason=missing_prerequisite tenant=42 missing=child_leads,resolver'
    );
  });

  test('emit is a no-op when missing array is empty', () => {
    const logger = makeLogger();
    const fired = emitPrereqMissingWarning(logger, 2, []);
    expect(fired).toBe(false);
    expect(logger._calls.warn.length).toBe(0);
  });

  test('emit is a no-op when missing is undefined', () => {
    const logger = makeLogger();
    const fired = emitPrereqMissingWarning(logger, 2);
    expect(fired).toBe(false);
    expect(logger._calls.warn.length).toBe(0);
  });
});
