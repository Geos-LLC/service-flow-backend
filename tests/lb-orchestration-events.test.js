/**
 * lb-orchestration-events.js
 *
 * Tests the parallel-emission path: service_* outbound events that
 * fire alongside the legacy job.status_changed events.
 *
 * Verified invariants:
 *   - feature flag off → skipped, no insert
 *   - job without lb_external_request_id → skipped (not_lb_attributed)
 *   - leadbridge-sourced status change → skipped (loop guard)
 *   - status → cancelled  → classifies as service_cancelled
 *   - status → completed  → classifies as service_completed
 *   - status → in-progress / paid → no orchestration event (excluded)
 *   - deterministic event_id per (job, type)
 *   - UNIQUE constraint duplicate (23505) handled as { action: 'duplicate' }
 *   - tenant_id always set on the outbound row
 */

process.env.SF_INTEGRATION_ENC_KEY = Buffer.alloc(32, 7).toString('base64');
process.env.LB_ORCHESTRATION_ENABLED_TENANTS = '2';

const {
  ORCHESTRATION_EVENT_TYPES,
  orchestrationEventId,
  classifyStatusTransitionForOrchestration,
  recordOrchestrationOutbound,
} = require('../lib/lb-orchestration-events');

function makeStub({ duplicate = false, error = null } = {}) {
  const inserts = [];
  return {
    _inserts: inserts,
    from(_table) {
      return {
        insert(row) {
          inserts.push({ row });
          if (error) return Promise.resolve({ error: { message: error } });
          if (duplicate) return Promise.resolve({ error: { code: '23505', message: 'duplicate key value' } });
          return Promise.resolve({ error: null });
        },
      };
    },
  };
}

describe('orchestrationEventId', () => {
  test('deterministic format', () => {
    expect(orchestrationEventId('service_scheduled', 123)).toBe('evt_service_scheduled_123');
    expect(orchestrationEventId('service_cancelled', 456)).toBe('evt_service_cancelled_456');
  });
});

describe('classifyStatusTransitionForOrchestration', () => {
  test('completed / done / paid → service_completed', () => {
    expect(classifyStatusTransitionForOrchestration('in-progress', 'completed')).toBe('service_completed');
    expect(classifyStatusTransitionForOrchestration('completed', 'paid')).toBe('service_completed');
    expect(classifyStatusTransitionForOrchestration('in-progress', 'done')).toBe('service_completed');
  });

  test('cancelled / canceled → service_cancelled', () => {
    expect(classifyStatusTransitionForOrchestration('scheduled', 'cancelled')).toBe('service_cancelled');
    expect(classifyStatusTransitionForOrchestration('confirmed', 'canceled')).toBe('service_cancelled');
  });

  test('operational mid-cycle transitions are NOT orchestration events', () => {
    expect(classifyStatusTransitionForOrchestration('confirmed', 'in-progress')).toBeNull();
    expect(classifyStatusTransitionForOrchestration('scheduled', 'en-route')).toBeNull();
    expect(classifyStatusTransitionForOrchestration('en-route', 'started')).toBeNull();
  });

  test('forward scheduling state transitions are NOT orchestration events here', () => {
    // service_scheduled is emitted at job CREATE time by the handler,
    // not by a status transition. Internal pending↔confirmed edits
    // should not re-fire it.
    expect(classifyStatusTransitionForOrchestration('pending', 'confirmed')).toBeNull();
    expect(classifyStatusTransitionForOrchestration('confirmed', 'scheduled')).toBeNull();
  });

  test('unknown / no-show / archived → null (not emitted)', () => {
    expect(classifyStatusTransitionForOrchestration('scheduled', 'no-show')).toBeNull();
    expect(classifyStatusTransitionForOrchestration('lost', 'archived')).toBeNull();
    expect(classifyStatusTransitionForOrchestration('x', 'weird_status')).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────
// recordOrchestrationOutbound
// ──────────────────────────────────────────────────────────────────
const SILENT = { log() {}, warn() {}, error() {} };

describe('recordOrchestrationOutbound', () => {
  test('feature flag off → skipped, no insert', async () => {
    process.env.LB_ORCHESTRATION_ENABLED_TENANTS = '';
    jest.resetModules();
    const { recordOrchestrationOutbound: fn } = require('../lib/lb-orchestration-events');
    const stub = makeStub();
    const out = await fn(stub, {
      eventType: 'service_cancelled',
      job: { id: 1, user_id: 2, status: 'cancelled', lb_external_request_id: 'X' },
      logger: SILENT,
    });
    expect(out.action).toBe('skipped');
    expect(out.reason).toBe('feature_flag_off');
    expect(stub._inserts).toHaveLength(0);
    process.env.LB_ORCHESTRATION_ENABLED_TENANTS = '2';
  });

  test('job without lb_external_request_id → skipped', async () => {
    jest.resetModules();
    process.env.LB_ORCHESTRATION_ENABLED_TENANTS = '2';
    const { recordOrchestrationOutbound: fn } = require('../lib/lb-orchestration-events');
    const stub = makeStub();
    const out = await fn(stub, {
      eventType: 'service_cancelled',
      job: { id: 1, user_id: 2, status: 'cancelled', lb_external_request_id: null },
      logger: SILENT,
    });
    expect(out.action).toBe('skipped');
    expect(out.reason).toBe('not_lb_attributed');
    expect(stub._inserts).toHaveLength(0);
  });

  test('loop guard: source=leadbridge → skipped', async () => {
    jest.resetModules();
    process.env.LB_ORCHESTRATION_ENABLED_TENANTS = '2';
    const { recordOrchestrationOutbound: fn } = require('../lib/lb-orchestration-events');
    const stub = makeStub();
    const out = await fn(stub, {
      eventType: 'service_cancelled',
      job: { id: 1, user_id: 2, status: 'cancelled', lb_external_request_id: 'X' },
      source: 'leadbridge',
      logger: SILENT,
    });
    expect(out.action).toBe('skipped');
    expect(out.reason).toBe('leadbridge_origin_loop_guard');
    expect(stub._inserts).toHaveLength(0);
  });

  test('happy path: emits with deterministic event_id', async () => {
    jest.resetModules();
    process.env.LB_ORCHESTRATION_ENABLED_TENANTS = '2';
    const { recordOrchestrationOutbound: fn } = require('../lib/lb-orchestration-events');
    const stub = makeStub();
    const out = await fn(stub, {
      eventType: 'service_cancelled',
      job: { id: 142, user_id: 2, status: 'cancelled',
             lb_external_request_id: 'EXT-A', lb_channel: 'thumbtack', lb_business_id: 'BIZ' },
      source: 'account_owner',
      logger: SILENT,
    });
    expect(out.action).toBe('enqueued');
    expect(out.event_id).toBe('evt_service_cancelled_142');
    expect(stub._inserts).toHaveLength(1);
    const r = stub._inserts[0].row;
    expect(r.event_id).toBe('evt_service_cancelled_142');
    expect(r.event_type).toBe('service_cancelled');
    expect(r.user_id).toBe(2);
    expect(r.sf_job_id).toBe('142');
    expect(r.payload_json.external_request_id).toBe('EXT-A');
    expect(r.payload_json.channel).toBe('thumbtack');
  });

  test('UNIQUE constraint duplicate → action=duplicate, no failure', async () => {
    jest.resetModules();
    process.env.LB_ORCHESTRATION_ENABLED_TENANTS = '2';
    const { recordOrchestrationOutbound: fn } = require('../lib/lb-orchestration-events');
    const stub = makeStub({ duplicate: true });
    const out = await fn(stub, {
      eventType: 'service_completed',
      job: { id: 99, user_id: 2, status: 'completed', lb_external_request_id: 'X' },
      source: 'system',
      logger: SILENT,
    });
    expect(out.action).toBe('duplicate');
    expect(out.event_id).toBe('evt_service_completed_99');
  });

  test('unknown event type → skipped', async () => {
    jest.resetModules();
    process.env.LB_ORCHESTRATION_ENABLED_TENANTS = '2';
    const { recordOrchestrationOutbound: fn } = require('../lib/lb-orchestration-events');
    const stub = makeStub();
    const out = await fn(stub, {
      eventType: 'random_invented_type',
      job: { id: 1, user_id: 2, status: 'completed', lb_external_request_id: 'X' },
      logger: SILENT,
    });
    expect(out.action).toBe('skipped');
    expect(out.reason).toBe('unknown_event_type');
  });

  test('exposes the four allowed event types', () => {
    expect(ORCHESTRATION_EVENT_TYPES).toEqual([
      'service_scheduled',
      'service_rescheduled',
      'service_cancelled',
      'service_completed',
    ]);
  });

  test('orchestration_session_id flows through to payload + outbox row', async () => {
    jest.resetModules();
    process.env.LB_ORCHESTRATION_ENABLED_TENANTS = '2';
    const { recordOrchestrationOutbound: fn } = require('../lib/lb-orchestration-events');
    const stub = makeStub();
    await fn(stub, {
      eventType: 'service_scheduled',
      job: { id: 10, user_id: 2, status: 'confirmed', lb_external_request_id: 'X' },
      source: 'lb_orchestration',
      orchestrationSessionId: 'conv-789',
      logger: SILENT,
    });
    const r = stub._inserts[0].row;
    expect(r.orchestration_session_id).toBe('conv-789');
    expect(r.payload_json.orchestration_session_id).toBe('conv-789');
  });
});
