/**
 * Phase B — drainer network behavior tests.
 *
 * Scope:
 *   - Dry-run mode: drainer builds + signs but does NOT POST
 *   - 201 success: zenbooker_id extracted + state→sent
 *   - 4xx hard errors: state→failed (DLQ)
 *   - 5xx / network: retry-or-DLQ per backoff schedule
 *   - 409 idempotent duplicate: treat as sent
 *   - All paths NEVER throw out of processRow
 */

const {
  processRow,
  postToZb,
  handlePostResult,
  retryOrDlq,
  networkBackoff,
  markSent,
  NETWORK_MAX_ATTEMPTS,
} = require('../workers/zb-outbound-drainer');

function makeSupabase({ apiKey = 'test_key', tenantConnected = true } = {}) {
  const updates = [];
  return {
    updates,
    from: jest.fn((tbl) => {
      if (tbl === 'users') {
        return {
          select: jest.fn(() => ({
            eq: jest.fn(() => ({
              maybeSingle: jest.fn(async () => ({
                data: tenantConnected
                  ? { zenbooker_api_key: apiKey, zenbooker_status: 'connected' }
                  : { zenbooker_api_key: null, zenbooker_status: 'disconnected' },
              })),
            })),
          })),
        };
      }
      // zb_outbound_commands
      return {
        update: jest.fn((patch) => ({
          eq: jest.fn(async () => { updates.push(patch); return { error: null }; }),
        })),
      };
    }),
  };
}

function makeRow(overrides = {}) {
  return {
    id: 'cmd-1',
    event_id: 'zboe_test_1',
    user_id: 2,
    command_type: 'job.create',
    sf_job_id: '42',
    payload_json: { territory_id: 't', customer_id: 'c', services: [{ service_id: 's' }], timeslot: { type: 'specific_time', start_time: '2026-05-20T15:00:00Z' } },
    source_revision: {},
    intent_hash: 'hash1',
    attempts: 0,
    field_group: 'create',
    origin: 'user',
    ...overrides,
  };
}

const ORIGINAL_ENV = { ...process.env };
afterEach(() => { process.env = { ...ORIGINAL_ENV }; jest.restoreAllMocks(); });

describe('networkBackoff schedule', () => {
  test('matches design §3.3 + LB pattern: 0/10/60/600/3600', () => {
    expect(networkBackoff(1)).toBe(0);
    expect(networkBackoff(2)).toBe(10);
    expect(networkBackoff(3)).toBe(60);
    expect(networkBackoff(4)).toBe(600);
    expect(networkBackoff(5)).toBe(3600);
    // Caps at last value
    expect(networkBackoff(99)).toBe(3600);
  });
});

describe('processRow — dry-run', () => {
  test('DRY_RUN=true short-circuits before any HTTP', async () => {
    process.env.ZB_OUTBOUND_ENABLED = 'true';
    process.env.ZB_OUTBOUND_DRY_RUN = 'true';
    process.env.ZB_OUTBOUND_GLOBAL_FREEZE = 'false';
    const fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(() => { throw new Error('SHOULD NOT BE CALLED'); });
    const supabase = makeSupabase();
    const logs = [];
    await processRow({ supabase, logger: { log: (m) => logs.push(m), warn: () => {}, error: () => {} }, row: makeRow() });
    expect(fetchSpy).not.toHaveBeenCalled();
    // Drainer should have UPDATEd the row to state=sent with dry_run marker
    expect(supabase.updates.find((u) => u.state === 'sent')).toBeDefined();
    expect(supabase.updates[supabase.updates.length - 1].zb_response).toMatchObject({ dry_run: true });
  });
});

describe('processRow — live mode HTTP responses', () => {
  beforeEach(() => {
    process.env.ZB_OUTBOUND_ENABLED = 'true';
    process.env.ZB_OUTBOUND_DRY_RUN = 'false';
    process.env.ZB_OUTBOUND_GLOBAL_FREEZE = 'false';
  });

  test('201 Created → state=sent with extracted zenbooker_id', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true, status: 201,
      text: async () => JSON.stringify({ id: 'zb_new_job_123' }),
      headers: { get: () => '120' },
    });
    const supabase = makeSupabase();
    await processRow({ supabase, logger: { log: () => {}, warn: () => {}, error: () => {} }, row: makeRow() });
    const sentUpdate = supabase.updates.find((u) => u.state === 'sent');
    expect(sentUpdate).toBeDefined();
    expect(sentUpdate.zenbooker_id).toBe('zb_new_job_123');
    expect(sentUpdate.confirmation_deadline).toBeDefined();
  });

  test('200 + response.job nested id is extracted (matching assign endpoint shape)', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true, status: 200,
      text: async () => JSON.stringify({ status: 'success', response: { job: 'zb_x', service_providers: [] } }),
      headers: { get: () => null },
    });
    const supabase = makeSupabase();
    await processRow({ supabase, logger: { log: () => {}, warn: () => {}, error: () => {} }, row: makeRow() });
    const sentUpdate = supabase.updates.find((u) => u.state === 'sent');
    expect(sentUpdate.zenbooker_id).toBe('zb_x');
  });

  test('409 Conflict (idempotent duplicate) → state=sent with duplicate note', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: false, status: 409,
      text: async () => JSON.stringify({ id: 'zb_dupe' }),
      headers: { get: () => null },
    });
    const supabase = makeSupabase();
    await processRow({ supabase, logger: { log: () => {}, warn: () => {}, error: () => {} }, row: makeRow() });
    expect(supabase.updates.find((u) => u.state === 'sent')).toBeDefined();
  });

  test('422 → state=failed (DLQ); no retry', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: false, status: 422,
      text: async () => JSON.stringify({ error: { message: 'Missing required parameter: territory_id', code: 'MISSING_PARAMETER' } }),
      headers: { get: () => null },
    });
    const supabase = makeSupabase();
    const warns = [];
    await processRow({ supabase, logger: { log: () => {}, warn: (m) => warns.push(m), error: () => {} }, row: makeRow() });
    const failedUpdate = supabase.updates.find((u) => u.state === 'failed');
    expect(failedUpdate).toBeDefined();
    expect(failedUpdate.last_error).toMatch(/http 422/);
    expect(failedUpdate.terminal_at).toBeDefined();
  });

  test('500 → retry within budget (state=pending with backoff)', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: false, status: 500,
      text: async () => 'internal error',
      headers: { get: () => null },
    });
    const supabase = makeSupabase();
    await processRow({ supabase, logger: { log: () => {}, warn: () => {}, error: () => {} }, row: makeRow({ attempts: 0 }) });
    const update = supabase.updates[supabase.updates.length - 1];
    expect(update.state).toBe('pending');
    expect(update.next_attempt_at).toBeDefined();
    expect(update.last_error).toMatch(/http 500/);
    expect(update.terminal_at).toBeUndefined();
  });

  test('5xx after max attempts → state=failed', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: false, status: 502,
      text: async () => 'bad gateway',
      headers: { get: () => null },
    });
    const supabase = makeSupabase();
    await processRow({ supabase, logger: { log: () => {}, warn: () => {}, error: () => {} }, row: makeRow({ attempts: NETWORK_MAX_ATTEMPTS }) });
    const update = supabase.updates[supabase.updates.length - 1];
    expect(update.state).toBe('failed');
    expect(update.terminal_at).toBeDefined();
  });

  test('Network error → retry within budget (state=pending)', async () => {
    jest.spyOn(global, 'fetch').mockRejectedValue(Object.assign(new Error('ECONNRESET'), { code: 'ECONNRESET' }));
    const supabase = makeSupabase();
    await processRow({ supabase, logger: { log: () => {}, warn: () => {}, error: () => {} }, row: makeRow({ attempts: 0 }) });
    const update = supabase.updates[supabase.updates.length - 1];
    expect(update.state).toBe('pending');
    expect(update.last_error).toMatch(/network:/);
  });

  test('Idempotency-Key header is sent on every POST', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true, status: 201,
      text: async () => JSON.stringify({ id: 'zb_x' }),
      headers: { get: () => null },
    });
    const supabase = makeSupabase();
    await processRow({ supabase, logger: { log: () => {}, warn: () => {}, error: () => {} }, row: makeRow({ event_id: 'zboe_idem_test' }) });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const call = fetchSpy.mock.calls[0];
    expect(call[1].headers['Idempotency-Key']).toBe('zboe_idem_test');
    expect(call[1].headers['Authorization']).toBe('Bearer test_key');
  });
});

describe('processRow — tenant disconnect', () => {
  test('user not connected → defers with zb_disconnected', async () => {
    process.env.ZB_OUTBOUND_ENABLED = 'true';
    process.env.ZB_OUTBOUND_DRY_RUN = 'false';
    process.env.ZB_OUTBOUND_GLOBAL_FREEZE = 'false';
    const fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(() => { throw new Error('SHOULD NOT BE CALLED'); });
    const supabase = makeSupabase({ tenantConnected: false });
    await processRow({ supabase, logger: { log: () => {}, warn: () => {}, error: () => {} }, row: makeRow() });
    expect(fetchSpy).not.toHaveBeenCalled();
    const update = supabase.updates[supabase.updates.length - 1];
    expect(update.state).toBe('pending');
    expect(update.defer_reason).toBe('zb_disconnected');
  });
});

describe('processRow — non-job.create command types skipped in Phase B', () => {
  test('job.cancel command defers with not_in_phase_b_scope', async () => {
    process.env.ZB_OUTBOUND_ENABLED = 'true';
    process.env.ZB_OUTBOUND_DRY_RUN = 'false';
    process.env.ZB_OUTBOUND_GLOBAL_FREEZE = 'false';
    const fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(() => { throw new Error('SHOULD NOT BE CALLED'); });
    const supabase = makeSupabase();
    await processRow({ supabase, logger: { log: () => {}, warn: () => {}, error: () => {} }, row: makeRow({ command_type: 'job.cancel' }) });
    expect(fetchSpy).not.toHaveBeenCalled();
    const update = supabase.updates[supabase.updates.length - 1];
    expect(update.defer_reason).toBe('not_in_phase_b_scope');
  });
});
