/**
 * Phase B — metrics emitter unit tests.
 *
 * Scope:
 *   - All 8 mandatory metric types per phase-b-readiness-v2.md §4.1
 *     can be emitted
 *   - Log format is the [ZB-outbound-metric] prefix with kv pairs
 *   - Latency_ms appears on confirmed type
 *   - Invalid type names are rejected (warning logged, no crash)
 *   - NEVER throws (logger error path swallowed)
 */

const {
  emit,
  emitQueued,
  emitSent,
  emitConfirmed,
  emitTimeout,
  emitConflict,
  emitSuperseded,
  emitInvalidated,
  emitDlq,
  emitSkippedPrecondition,
  VALID_METRIC_TYPES,
} = require('../lib/zb-outbound-metrics');

function makeLogger() {
  const lines = { log: [], warn: [] };
  return {
    lines,
    log: (m) => lines.log.push(m),
    warn: (m) => lines.warn.push(m),
  };
}

describe('emit() — invariants', () => {
  test('rejects unknown type', () => {
    const logger = makeLogger();
    emit({ type: 'bogus', userId: 2, commandType: 'job.create', logger });
    expect(logger.lines.warn).toHaveLength(1);
    expect(logger.lines.warn[0]).toMatch(/invalid_type/);
    expect(logger.lines.log).toHaveLength(0);
  });

  test('NEVER throws on bad input', () => {
    expect(() => emit(null)).not.toThrow();
    expect(() => emit({})).not.toThrow();
    expect(() => emit({ type: 'queued', logger: null })).not.toThrow();
  });

  test('logs structured [ZB-outbound-metric] line', () => {
    const logger = makeLogger();
    emit({ type: 'queued', userId: 2, commandType: 'job.create', fieldGroup: 'create', eventId: 'zboe_abc', logger });
    expect(logger.lines.log).toHaveLength(1);
    const line = logger.lines.log[0];
    expect(line.startsWith('[ZB-outbound-metric]')).toBe(true);
    expect(line).toMatch(/type=queued/);
    expect(line).toMatch(/user_id=2/);
    expect(line).toMatch(/command_type=job\.create/);
    expect(line).toMatch(/field_group=create/);
    expect(line).toMatch(/event_id=zboe_abc/);
  });

  test('confirmed type carries latency_ms', () => {
    const logger = makeLogger();
    emitConfirmed({ userId: 2, commandType: 'job.create', fieldGroup: 'create', eventId: 'zboe_x', latencyMs: 2300, logger });
    expect(logger.lines.log).toHaveLength(1);
    expect(logger.lines.log[0]).toMatch(/latency_ms=2300/);
  });

  test('dlq / conflict / timeout / invalidated emit at warn level', () => {
    const logger = makeLogger();
    emitDlq({ userId: 2, commandType: 'job.create', fieldGroup: 'create', eventId: 'zboe_1', errorClass: 'http_422', logger });
    emitConflict({ userId: 2, commandType: 'job.create', fieldGroup: 'create', eventId: 'zboe_2', logger });
    emitTimeout({ userId: 2, commandType: 'job.create', fieldGroup: 'create', eventId: 'zboe_3', logger });
    emitInvalidated({ userId: 2, commandType: 'job.create', fieldGroup: 'create', eventId: 'zboe_4', logger });
    expect(logger.lines.warn).toHaveLength(4);
    expect(logger.lines.warn[0]).toMatch(/type=dlq/);
    expect(logger.lines.warn[0]).toMatch(/error_class=http_422/);
    expect(logger.lines.warn[1]).toMatch(/type=conflict/);
    expect(logger.lines.warn[2]).toMatch(/type=timeout/);
    expect(logger.lines.warn[3]).toMatch(/type=invalidated/);
  });

  test('queued / sent / confirmed / superseded / skipped emit at log level', () => {
    const logger = makeLogger();
    emitQueued({ userId: 2, eventId: 'z1', logger });
    emitSent({ userId: 2, eventId: 'z2', logger });
    emitConfirmed({ userId: 2, eventId: 'z3', logger });
    emitSuperseded({ userId: 2, eventId: 'z4', logger });
    emitSkippedPrecondition({ userId: 2, eventId: 'z5', note: 'customer_not_in_zb', logger });
    expect(logger.lines.log).toHaveLength(5);
    expect(logger.lines.warn).toHaveLength(0);
  });

  test('VALID_METRIC_TYPES covers the readiness-v2 §4.1 list', () => {
    for (const t of ['queued', 'sent', 'confirmed', 'timeout', 'conflict', 'superseded', 'invalidated', 'dlq']) {
      expect(VALID_METRIC_TYPES).toContain(t);
    }
  });
});
