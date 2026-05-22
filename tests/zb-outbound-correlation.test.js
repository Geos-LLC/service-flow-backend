/**
 * Phase B — inbound→outbound correlation tests.
 *
 * Scope:
 *   - job.created webhook with matching zenbooker_id transitions
 *     state from sent → confirmed (single-match path)
 *   - Non-correlatable event types are no-op
 *   - Missing match → no-op (no transitions)
 *   - Multiple matches → all marked ambiguous_pending_review
 *   - NEVER throws on Supabase error
 *   - Latency_ms emitted on confirmation
 */

const { correlateInboundEcho, isCorrelatable, ECHO_TO_COMMAND_TYPE } = require('../lib/zb-outbound-correlation');

function makeSupabase({ candidates = [], lookupError = null, updateError = null } = {}) {
  const updates = [];
  return {
    updates,
    from: jest.fn(() => ({
      select: jest.fn(() => ({
        eq: jest.fn(() => ({
          eq: jest.fn(() => ({
            eq: jest.fn(() => ({
              in: jest.fn(async () => lookupError ? { error: lookupError } : { data: candidates }),
            })),
          })),
        })),
      })),
      update: jest.fn((patch) => ({
        eq: jest.fn(async () => { updates.push(patch); return { error: updateError }; }),
      })),
    })),
  };
}

function makeLogger() {
  const lines = { log: [], warn: [] };
  return { lines, log: (m) => lines.log.push(m), warn: (m) => lines.warn.push(m) };
}

describe('isCorrelatable', () => {
  test('job.created is correlatable in Phase B', () => {
    expect(isCorrelatable('job.created')).toBe(true);
  });
  test('Phase B does NOT correlate other event types (out of scope)', () => {
    expect(isCorrelatable('job.rescheduled')).toBe(false);
    expect(isCorrelatable('job.canceled')).toBe(false);
    expect(isCorrelatable('job.service_providers.assigned')).toBe(false);
    expect(isCorrelatable('customer.edited')).toBe(false);
    expect(isCorrelatable('invoice.payment_succeeded')).toBe(false);
  });
  test('ECHO_TO_COMMAND_TYPE maps job.created → job.create', () => {
    expect(ECHO_TO_COMMAND_TYPE['job.created']).toBe('job.create');
  });
});

describe('correlateInboundEcho', () => {
  test('non-correlatable event → no-op', async () => {
    const supabase = makeSupabase({ candidates: [{ id: 'should-not-touch' }] });
    const result = await correlateInboundEcho(supabase, {
      userId: 2, event: 'job.rescheduled', data: { id: 'zb_x' },
      webhookId: 'wh_1', logger: makeLogger(),
    });
    expect(result.correlated).toBe(0);
    expect(result.ambiguous).toBe(0);
    expect(supabase.updates).toHaveLength(0);
  });

  test('no candidates → no-op', async () => {
    const supabase = makeSupabase({ candidates: [] });
    const result = await correlateInboundEcho(supabase, {
      userId: 2, event: 'job.created', data: { id: 'zb_x' },
      webhookId: 'wh_1', logger: makeLogger(),
    });
    expect(result.correlated).toBe(0);
    expect(supabase.updates).toHaveLength(0);
  });

  test('single matching command → confirmed', async () => {
    const sentAt = new Date(Date.now() - 3000).toISOString(); // 3s ago
    const supabase = makeSupabase({
      candidates: [{
        id: 'cmd-1', event_id: 'zboe_x', command_type: 'job.create', sf_job_id: '42',
        user_id: 2, intent_hash: 'h', state: 'sent', sent_at: sentAt, field_group: 'create',
      }],
    });
    const logger = makeLogger();
    const result = await correlateInboundEcho(supabase, {
      userId: 2, event: 'job.created', data: { id: 'zb_new_job_123' },
      webhookId: 'wh_456', logger,
    });
    expect(result.correlated).toBe(1);
    expect(supabase.updates).toHaveLength(1);
    expect(supabase.updates[0].state).toBe('confirmed');
    expect(supabase.updates[0].correlation_confidence).toBe('exact');
    expect(supabase.updates[0].zb_event_id).toBe('wh_456');
    expect(supabase.updates[0].confirmed_at).toBeDefined();
    // Latency metric line emitted
    const metricLine = logger.lines.log.find((m) => m.startsWith('[ZB-outbound-metric] type=confirmed'));
    expect(metricLine).toBeDefined();
    expect(metricLine).toMatch(/latency_ms=\d+/);
  });

  test('multiple matches → all marked ambiguous_pending_review', async () => {
    const supabase = makeSupabase({
      candidates: [
        { id: 'a', event_id: 'zboe_a', command_type: 'job.create', state: 'sent', user_id: 2, field_group: 'create' },
        { id: 'b', event_id: 'zboe_b', command_type: 'job.create', state: 'sent', user_id: 2, field_group: 'create' },
      ],
    });
    const logger = makeLogger();
    const result = await correlateInboundEcho(supabase, {
      userId: 2, event: 'job.created', data: { id: 'zb_dupe' },
      webhookId: 'wh_x', logger,
    });
    expect(result.correlated).toBe(0);
    expect(result.ambiguous).toBe(2);
    expect(supabase.updates).toHaveLength(2);
    for (const u of supabase.updates) {
      expect(u.state).toBe('ambiguous_pending_review');
      expect(u.conflict_metadata.reason).toBe('multiple_matches_on_same_zenbooker_id');
    }
  });

  test('Supabase lookup error → no-op (NEVER throws)', async () => {
    const supabase = makeSupabase({ lookupError: { message: 'connection refused' } });
    const result = await correlateInboundEcho(supabase, {
      userId: 2, event: 'job.created', data: { id: 'zb_x' },
      webhookId: 'wh_x', logger: makeLogger(),
    });
    expect(result.correlated).toBe(0);
    expect(supabase.updates).toHaveLength(0);
  });

  test('missing data.id → no-op', async () => {
    const supabase = makeSupabase({ candidates: [{ id: 'never' }] });
    const result = await correlateInboundEcho(supabase, {
      userId: 2, event: 'job.created', data: {},
      webhookId: 'wh_x', logger: makeLogger(),
    });
    expect(result.correlated).toBe(0);
    expect(supabase.updates).toHaveLength(0);
  });

  test('missing userId → no-op (tenant scope guard)', async () => {
    const supabase = makeSupabase({ candidates: [{ id: 'should-not-match' }] });
    const result = await correlateInboundEcho(supabase, {
      userId: null, event: 'job.created', data: { id: 'zb_x' },
      webhookId: 'wh_x', logger: makeLogger(),
    });
    expect(result.correlated).toBe(0);
    expect(supabase.updates).toHaveLength(0);
  });
});
