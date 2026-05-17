/**
 * Q2-B instrumentation — body-key observation sampler.
 *
 * Scope:
 *   - No-op when platform_settings row absent.
 *   - Sampled until remaining hits 0.
 *   - Sampled within 24h window; expired window → no-op.
 *   - Logs ONLY top-level key names (no values, no headers).
 *   - NEVER throws — exceptions swallowed and reported via logger.warn.
 *   - Cache is 60s; clearCache resets between tests for determinism.
 */

const { observe, isWithinWindow, clearCache, CACHE_TTL_MS } = require('../lib/zb-body-observe');

// `mode = 'text' | 'object'` — production stores text (JSON-serialized
// string) in platform_settings.value, so we default to text. The
// object mode is kept for forward compatibility if the column ever
// becomes jsonb.
function makeSupabase({ setting = null, updateError = null, fetchError = null, mode = 'text' } = {}) {
  let current = setting;
  const encode = (v) => (mode === 'text' && v != null ? JSON.stringify(v) : v);
  const decode = (v) => (mode === 'text' && typeof v === 'string' ? JSON.parse(v) : v);
  return {
    from: jest.fn(() => ({
      select: jest.fn(() => ({
        eq: jest.fn(() => ({
          maybeSingle: jest.fn(async () => fetchError ? { error: fetchError } : { data: current != null ? { value: encode(current) } : null }),
        })),
      })),
      update: jest.fn((patch) => ({
        eq: jest.fn(async () => {
          if (updateError) return { error: updateError };
          if (current && current.remaining > 0) {
            current = decode(patch.value);
          }
          return { error: null };
        }),
      })),
    })),
  };
}

beforeEach(() => clearCache());

describe('isWithinWindow', () => {
  test('null setting → false', () => {
    expect(isWithinWindow(null)).toBe(false);
  });
  test('remaining 0 → false', () => {
    expect(isWithinWindow({ remaining: 0, started_at: new Date().toISOString() })).toBe(false);
  });
  test('remaining > 0 + recent started_at → true', () => {
    expect(isWithinWindow({ remaining: 50, started_at: new Date().toISOString(), max_age_hours: 24 })).toBe(true);
  });
  test('expired window → false', () => {
    const oldIso = new Date(Date.now() - 25 * 3600 * 1000).toISOString();
    expect(isWithinWindow({ remaining: 50, started_at: oldIso, max_age_hours: 24 })).toBe(false);
  });
});

describe('observe()', () => {
  test('no setting → not sampled, no log', async () => {
    const logs = [];
    const supabase = makeSupabase({ setting: null });
    const res = await observe(supabase, { event: 'job.x', data: {}, account_id: 'a' }, { logger: { log: (m) => logs.push(m), warn: () => {} } });
    expect(res.sampled).toBe(false);
    expect(logs).toHaveLength(0);
  });

  test('active setting → samples and logs only KEY names', async () => {
    const logs = [];
    const supabase = makeSupabase({ setting: { remaining: 5, started_at: new Date().toISOString(), max_age_hours: 24 } });
    const body = { event: 'job.service_providers.assigned', data: { id: 'j1', status: 'scheduled' }, account_id: 'acc-1' };
    const res = await observe(supabase, body, { logger: { log: (m) => logs.push(m), warn: () => {} }, eventType: body.event });
    expect(res.sampled).toBe(true);
    expect(res.keys.sort()).toEqual(['account_id', 'data', 'event']);
    expect(logs).toHaveLength(1);
    const line = logs[0];
    expect(line).toMatch(/\[ZB-body-observe\]/);
    expect(line).toMatch(/top_level_keys=account_id,data,event/);
    expect(line).toMatch(/event_type=job\.service_providers\.assigned/);
    expect(line).toMatch(/data_keys_count=2/);
    // No values logged
    expect(line).not.toContain('j1');
    expect(line).not.toContain('scheduled');
    expect(line).not.toContain('acc-1');
  });

  test('expired window → not sampled, no log', async () => {
    const logs = [];
    const oldIso = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
    const supabase = makeSupabase({ setting: { remaining: 30, started_at: oldIso, max_age_hours: 24 } });
    const res = await observe(supabase, { event: 'x', data: {}, account_id: 'a' }, { logger: { log: (m) => logs.push(m), warn: () => {} } });
    expect(res.sampled).toBe(false);
    expect(logs).toHaveLength(0);
  });

  test('decrement reduces remaining each call', async () => {
    const logs = [];
    const setting = { remaining: 2, started_at: new Date().toISOString(), max_age_hours: 24 };
    const supabase = makeSupabase({ setting });
    // First call
    clearCache();
    const r1 = await observe(supabase, { event: 'x', data: {}, account_id: 'a' }, { logger: { log: (m) => logs.push(m), warn: () => {} } });
    expect(r1.sampled).toBe(true);
    expect(r1.remaining).toBe(1);
    // Second call
    clearCache();
    const r2 = await observe(supabase, { event: 'x', data: {}, account_id: 'a' }, { logger: { log: (m) => logs.push(m), warn: () => {} } });
    expect(r2.sampled).toBe(true);
    expect(r2.remaining).toBe(0);
    // Third call — remaining is now 0
    clearCache();
    const r3 = await observe(supabase, { event: 'x', data: {}, account_id: 'a' }, { logger: { log: (m) => logs.push(m), warn: () => {} } });
    expect(r3.sampled).toBe(false);
  });

  test('NEVER throws — supabase fetch error → not sampled', async () => {
    const supabase = makeSupabase({ fetchError: new Error('connection refused') });
    const res = await observe(supabase, { event: 'x', data: {}, account_id: 'a' }, { logger: { log: () => {}, warn: () => {} } });
    expect(res.sampled).toBe(false);
  });

  test('NEVER throws — bad body shape → not sampled, no crash', async () => {
    const supabase = makeSupabase({ setting: { remaining: 5, started_at: new Date().toISOString() } });
    const res = await observe(supabase, null, { logger: { log: () => {}, warn: () => {} } });
    expect(res.sampled).toBe(false);
  });

  test('cache TTL constant is 60s', () => {
    expect(CACHE_TTL_MS).toBe(60 * 1000);
  });
});
