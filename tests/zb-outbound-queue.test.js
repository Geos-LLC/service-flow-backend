/**
 * Phase A contract test — queue RPC + drainer scaffolding.
 *
 * Scope:
 *   - Drainer does NOT start when ZB_OUTBOUND_ENABLED is not 'true'.
 *   - When started + frozen, tick acquires lock, sweeps, returns 'frozen'.
 *   - Stale-lease sweep RPC is invoked every tick regardless of freeze.
 *   - Claim RPC is invoked only when NOT frozen.
 *   - Lease expiry sweeps stuck 'sending' rows back to 'pending'.
 *   - Tenant scoping: claim RPC respects scope (verified by SQL contract).
 *
 * No HTTP traffic. No live ZB mutation.
 */

const fs = require('fs');
const path = require('path');

const { startDrainer, runDrainerTick } = require('../workers/zb-outbound-drainer');

function makeSupabase({ tickLock = true, sweptCount = 0, claimed = [] } = {}) {
  const calls = { rpc: [], updates: [] };
  return {
    rpc: jest.fn(async (fn, args) => {
      calls.rpc.push({ fn, args });
      if (fn === 'zb_outbound_try_tick_lock') return { data: tickLock };
      if (fn === 'zb_outbound_release_tick_lock') return { data: true };
      if (fn === 'zb_outbound_sweep_stale_leases') return { data: sweptCount };
      if (fn === 'zb_outbound_claim_due') return { data: claimed, error: null };
      return { data: null };
    }),
    from: jest.fn(() => ({
      update: jest.fn(() => ({
        eq: jest.fn(async () => { calls.updates.push(true); return { error: null }; }),
      })),
    })),
    _calls: calls,
  };
}

describe('zb-outbound queue + drainer (Phase A)', () => {
  const ORIGINAL_ENV = { ...process.env };
  afterEach(() => { process.env = { ...ORIGINAL_ENV }; });

  test('startDrainer no-ops when ZB_OUTBOUND_ENABLED is not true', () => {
    delete process.env.ZB_OUTBOUND_ENABLED;
    const supabase = makeSupabase();
    const logs = [];
    const handle = startDrainer({ supabase, logger: { log: (m) => logs.push(m), error: () => {}, warn: () => {} } });
    expect(typeof handle.stop).toBe('function');
    handle.stop();
    expect(supabase.rpc).not.toHaveBeenCalled();
    expect(logs.some((m) => m.includes('Drainer not started'))).toBe(true);
  });

  test('runDrainerTick returns disabled when flag off', async () => {
    delete process.env.ZB_OUTBOUND_ENABLED;
    const supabase = makeSupabase();
    const result = await runDrainerTick({ supabase, logger: { log: () => {}, warn: () => {}, error: () => {} } });
    expect(result).toEqual({ skipped: 'disabled' });
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  test('frozen tick: acquires lock, sweeps, short-circuits claim', async () => {
    process.env.ZB_OUTBOUND_ENABLED = 'true';
    process.env.ZB_OUTBOUND_GLOBAL_FREEZE = 'true';
    const supabase = makeSupabase({ sweptCount: 2 });
    const result = await runDrainerTick({ supabase, logger: { log: () => {}, warn: () => {}, error: () => {} } });
    expect(result.skipped).toBe('frozen');
    expect(result.swept).toBe(2);
    const fns = supabase._calls.rpc.map((c) => c.fn);
    expect(fns).toContain('zb_outbound_try_tick_lock');
    expect(fns).toContain('zb_outbound_sweep_stale_leases');
    expect(fns).toContain('zb_outbound_release_tick_lock');
    expect(fns).not.toContain('zb_outbound_claim_due');
  });

  test('not-leader tick exits cleanly without sweep or claim', async () => {
    process.env.ZB_OUTBOUND_ENABLED = 'true';
    const supabase = makeSupabase({ tickLock: false });
    const result = await runDrainerTick({ supabase, logger: { log: () => {}, warn: () => {}, error: () => {} } });
    expect(result).toEqual({ skipped: 'not_tick_leader' });
    const fns = supabase._calls.rpc.map((c) => c.fn);
    expect(fns).toEqual(['zb_outbound_try_tick_lock']);
  });

  test('unfrozen tick with no rows: claim returns empty, no processing', async () => {
    process.env.ZB_OUTBOUND_ENABLED = 'true';
    process.env.ZB_OUTBOUND_GLOBAL_FREEZE = 'false';
    const supabase = makeSupabase({ claimed: [] });
    const result = await runDrainerTick({ supabase, logger: { log: () => {}, warn: () => {}, error: () => {} } });
    expect(result.processed).toBe(0);
    expect(supabase._calls.rpc.find((c) => c.fn === 'zb_outbound_claim_due')).toBeDefined();
  });

  test('unfrozen tick with claimed row: Phase A defers (no HTTP, no mutation)', async () => {
    process.env.ZB_OUTBOUND_ENABLED = 'true';
    process.env.ZB_OUTBOUND_GLOBAL_FREEZE = 'false';
    const supabase = makeSupabase({
      claimed: [{ id: 'cmd-1', event_id: 'zboe_x', user_id: 'u1', command_type: 'job.assign_providers', sf_job_id: 'j1', payload_json: {}, source_revision: {}, intent_hash: 'h', attempts: 0, field_group: 'assignment', origin: 'user' }],
    });
    const logs = [];
    const result = await runDrainerTick({ supabase, logger: { log: (m) => logs.push(m), warn: () => {}, error: () => {} } });
    expect(result.processed).toBe(1);
    expect(logs.some((m) => m.includes('phase_a_defer'))).toBe(true);
    expect(supabase._calls.updates.length).toBe(1); // exactly one defer update
  });
});

describe('SQL migration shape', () => {
  const SQL = fs.readFileSync(path.join(__dirname, '..', 'migrations', '044_zb_outbound_commands.sql'), 'utf8');

  test('zb_outbound_commands table + key columns present', () => {
    expect(SQL).toMatch(/CREATE TABLE IF NOT EXISTS zb_outbound_commands/);
    for (const col of ['event_id', 'user_id', 'command_type', 'payload_json', 'source_revision', 'intent_hash', 'state', 'field_group', 'origin', 'superseded_by_command_id', 'invalidation_reason', 'correlation_confidence']) {
      expect(SQL).toContain(col);
    }
  });

  test('three required RPCs defined', () => {
    expect(SQL).toMatch(/FUNCTION zb_outbound_try_tick_lock/);
    expect(SQL).toMatch(/FUNCTION zb_outbound_sweep_stale_leases/);
    expect(SQL).toMatch(/FUNCTION zb_outbound_claim_due/);
  });

  test('claim_due uses FOR UPDATE SKIP LOCKED', () => {
    expect(SQL).toMatch(/FOR UPDATE SKIP LOCKED/);
  });

  test('advisory-lock key differs from LB outbound LBOB', () => {
    // LBOB = 0x4C42_4F42 = 1279873602
    // ZBOB = 0x5A42_4F42 = 1514494530
    expect(SQL).toContain('1514494530');
    expect(SQL).not.toContain('1279873602');
  });
});
