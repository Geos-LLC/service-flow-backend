/**
 * Phase B — producer unit tests.
 *
 * Scope:
 *   - isTenantOptedIn / parseSettingValue handle text/jsonb storage
 *   - buildZbBody produces the correct ZB-shaped payload from SF state
 *   - resolveZbLinkage fail-fast on missing zenbooker_id linkages
 *   - maybeEmitJobCreateCommand never throws
 */

const {
  isTenantOptedIn,
  parseSettingValue,
  buildZbBody,
  resolveZbLinkage,
  checkLedgerDrift,
  checkZbSyncDirty,
  maybeEmitJobCreateCommand,
  clearCache,
  SETTING_KEY,
} = require('../lib/zb-outbound-producer');

beforeEach(() => clearCache());

describe('parseSettingValue', () => {
  test('null/undefined → null', () => {
    expect(parseSettingValue(null)).toBeNull();
    expect(parseSettingValue(undefined)).toBeNull();
  });
  test('JSON string → parsed object', () => {
    const v = parseSettingValue('{"user_ids":[2,3]}');
    expect(v).toEqual({ user_ids: [2, 3] });
  });
  test('already-parsed object → passthrough', () => {
    expect(parseSettingValue({ user_ids: [2] })).toEqual({ user_ids: [2] });
  });
  test('malformed → null', () => {
    expect(parseSettingValue('not json')).toBeNull();
  });
});

describe('isTenantOptedIn', () => {
  test('absent setting → false', () => {
    expect(isTenantOptedIn(null, 2)).toBe(false);
  });
  test('user_ids missing → false', () => {
    expect(isTenantOptedIn({}, 2)).toBe(false);
  });
  test('user_id in list → true', () => {
    expect(isTenantOptedIn({ user_ids: [1, 2, 3] }, 2)).toBe(true);
  });
  test('user_id not in list → false', () => {
    expect(isTenantOptedIn({ user_ids: [1, 3] }, 2)).toBe(false);
  });
  test('string-vs-number id tolerated', () => {
    expect(isTenantOptedIn({ user_ids: ['2'] }, 2)).toBe(true);
    expect(isTenantOptedIn({ user_ids: [2] }, '2')).toBe(false); // we don't coerce numeric → string for this direction
  });
});

describe('buildZbBody', () => {
  const baseSfJob = {
    id: 42,
    user_id: 2,
    scheduled_date: '2026-05-20 15:00:00',
    duration: 120,
    notes: 'Test booking',
    service_address_street: '123 Main',
    service_address_city: 'Tampa',
    service_address_state: 'FL',
    service_address_zip: '33602',
  };
  const linkage = {
    customer_zb_id: 'cust_123',
    service_zb_id: 'svc_456',
    territory_zb_id: 'terr_789',
    team_member_zb_ids: ['prov_a', 'prov_b'],
    sf_address: { line1: '123 Main', city: 'Tampa', state: 'FL', postal_code: '33602', country: 'USA' },
  };

  test('produces ZB-shaped body with all required fields', () => {
    const body = buildZbBody(baseSfJob, linkage);
    expect(body.territory_id).toBe('terr_789');
    expect(body.customer_id).toBe('cust_123');
    expect(body.services).toEqual([{ service_id: 'svc_456' }]);
    expect(body.timeslot).toEqual({ type: 'specific_time', start: expect.any(String) });
  });

  test('converts SF local datetime to ISO 8601 Z form', () => {
    const body = buildZbBody(baseSfJob, linkage);
    expect(body.timeslot.start).toBe('2026-05-20T15:00:00Z');
  });

  test('preserves existing ISO format if already present', () => {
    const sf = { ...baseSfJob, scheduled_date: '2026-05-20T15:00:00Z' };
    const body = buildZbBody(sf, linkage);
    expect(body.timeslot.start).toBe('2026-05-20T15:00:00Z');
  });

  // Regression guards added after 2026-05-19 incident:
  // ZB 400 INVALID_TIME_SLOT — `timeslot.start_time` was the wrong key.
  // See docs/architecture/producer-field-contract-audit.md.
  test('timeslot uses ZB-required key `start` (not SF-style `start_time`)', () => {
    const body = buildZbBody(baseSfJob, linkage);
    expect(body.timeslot.start).toBe('2026-05-20T15:00:00Z');
    expect(body.timeslot.start_time).toBeUndefined();
    expect(body.timeslot.type).toBe('specific_time');
  });

  test('body has no SF-style aliases at top level', () => {
    const body = buildZbBody(baseSfJob, linkage);
    expect(body).not.toHaveProperty('start_time');
    expect(body).not.toHaveProperty('scheduled_date');
    expect(body).not.toHaveProperty('service_date');
  });

  test('includes assigned_providers when team mapped', () => {
    const body = buildZbBody(baseSfJob, linkage);
    expect(body.assigned_providers).toEqual(['prov_a', 'prov_b']);
    expect(body.assignment_method).toBe('auto');
  });

  test('omits assigned_providers when no team', () => {
    const body = buildZbBody(baseSfJob, { ...linkage, team_member_zb_ids: [] });
    expect(body.assigned_providers).toBeUndefined();
    expect(body.assignment_method).toBeUndefined();
  });

  test('embeds address when present', () => {
    const body = buildZbBody(baseSfJob, linkage);
    expect(body.address).toEqual({ line1: '123 Main', city: 'Tampa', state: 'FL', postal_code: '33602', country: 'USA' });
  });

  // Regression guard: 2026-05-19 second incident — ZB 400 INVALID_ADDRESS,
  // "Address object is missing required fields: country".
  // See docs/architecture/job-create-contract-discovery.md.
  test('address includes country sub-key (ZB-required per 2026-05-19 discovery)', () => {
    const body = buildZbBody(baseSfJob, linkage);
    expect(body.address).toHaveProperty('country');
    expect(body.address.country).toBe('USA');
  });

  // Regression guards added 2026-05-20 — SF owns notifications for
  // SF-originated jobs. ZB's native provider-notification SMS leaked
  // (see zb-outbound-command-confirmation.md §1.F).
  test('emits sms_notifications=false to suppress ZB-side SMS', () => {
    const body = buildZbBody(baseSfJob, linkage);
    expect(body.sms_notifications).toBe(false);
  });

  test('emits email_notifications=false to suppress ZB-side email', () => {
    const body = buildZbBody(baseSfJob, linkage);
    expect(body.email_notifications).toBe(false);
  });

  test('suppression flags do not displace assigned_providers / assignment_method', () => {
    const body = buildZbBody(baseSfJob, linkage);
    expect(body.assigned_providers).toEqual(['prov_a', 'prov_b']);
    expect(body.assignment_method).toBe('auto');
    expect(body.sms_notifications).toBe(false);
    expect(body.email_notifications).toBe(false);
  });

  test('omits address when fully empty', () => {
    const body = buildZbBody(baseSfJob, { ...linkage, sf_address: { line1: null, city: null, state: null, postal_code: null } });
    expect(body.address).toBeUndefined();
  });

  test('omits `notes` from ZB body (pending ZB acceptance verification — audit R3)', () => {
    const sf = { ...baseSfJob, notes: 'x'.repeat(2000) };
    const body = buildZbBody(sf, linkage);
    expect(body.notes).toBeUndefined();
  });
});

describe('resolveZbLinkage — fail-fast on missing linkage', () => {
  function makeSupabase({ customer = null, service = null, territory = null, members = null } = {}) {
    // Both customer/service and territory chains go: .select().eq().eq().maybeSingle()
    // — two .eq() calls before maybeSingle. The mock handles all three at the
    // same nesting level by dispatching on the table name.
    const innerLeaf = (tbl) => ({
      maybeSingle: jest.fn(async () => {
        if (tbl === 'customers') return { data: customer };
        if (tbl === 'services') return { data: service };
        if (tbl === 'territories') return { data: territory };
        return { data: null };
      }),
      in: jest.fn(async () => ({ data: members || [] })),
    });
    return {
      from: jest.fn((tbl) => ({
        select: jest.fn(() => ({
          eq: jest.fn(() => ({
            eq: jest.fn(() => innerLeaf(tbl)),
            in: jest.fn(async () => ({ data: members || [] })),
          })),
        })),
      })),
    };
  }

  test('missing scheduled_date → defer', async () => {
    const r = await resolveZbLinkage(makeSupabase(), { user_id: 2, id: 42 });
    expect(r.ok).toBe(false);
    expect(r.defer_reason).toBe('missing_scheduled_date');
  });

  test('missing customer → defer', async () => {
    const r = await resolveZbLinkage(makeSupabase(), { user_id: 2, id: 42, scheduled_date: '2026-05-20' });
    expect(r.ok).toBe(false);
    expect(r.defer_reason).toBe('missing_customer');
  });

  test('customer without zenbooker_id → defer customer_not_in_zb', async () => {
    const sup = makeSupabase({ customer: { id: 100, zenbooker_id: null } });
    const r = await resolveZbLinkage(sup, { user_id: 2, id: 42, scheduled_date: '2026-05-20', customer_id: 100 });
    expect(r.ok).toBe(false);
    expect(r.defer_reason).toBe('customer_not_in_zb');
  });

  test('all required linkage present + no team → ok', async () => {
    const sup = makeSupabase({
      customer: { id: 100, zenbooker_id: 'cust_x' },
      service: { id: 7, zenbooker_id: 'svc_y' },
      territory: { id: 1, zenbooker_id: 'terr_z', name: 'Tampa' },
    });
    const r = await resolveZbLinkage(sup, {
      user_id: 2, id: 42, scheduled_date: '2026-05-20 15:00:00',
      customer_id: 100, service_id: 7, territory: 'Tampa',
    });
    expect(r.ok).toBe(true);
    expect(r.customer_zb_id).toBe('cust_x');
    expect(r.service_zb_id).toBe('svc_y');
    expect(r.territory_zb_id).toBe('terr_z');
    expect(r.team_member_zb_ids).toEqual([]);
  });

  // Country sub-key per 2026-05-19 discovery (audit Q16 / §13 Q16 resolved).
  test('sf_address.country flows through from sfJob.service_address_country', async () => {
    const sup = makeSupabase({
      customer: { id: 100, zenbooker_id: 'cust_x' },
      service: { id: 7, zenbooker_id: 'svc_y' },
      territory: { id: 1, zenbooker_id: 'terr_z', name: 'Tampa' },
    });
    const r = await resolveZbLinkage(sup, {
      user_id: 2, id: 42, scheduled_date: '2026-05-20 15:00:00',
      customer_id: 100, service_id: 7, territory: 'Tampa',
      service_address_country: 'USA',
    });
    expect(r.ok).toBe(true);
    expect(r.sf_address.country).toBe('USA');
  });

  test('sf_address.country defaults to "USA" when sfJob omits the field', async () => {
    const sup = makeSupabase({
      customer: { id: 100, zenbooker_id: 'cust_x' },
      service: { id: 7, zenbooker_id: 'svc_y' },
      territory: { id: 1, zenbooker_id: 'terr_z', name: 'Tampa' },
    });
    const r = await resolveZbLinkage(sup, {
      user_id: 2, id: 42, scheduled_date: '2026-05-20 15:00:00',
      customer_id: 100, service_id: 7, territory: 'Tampa',
      // no service_address_country
    });
    expect(r.ok).toBe(true);
    expect(r.sf_address.country).toBe('USA');
  });
});

// ────────────────────────────────────────────────────────────────────
// PC16 / Amendment A — P0/P1 hard gate: drift + dirty refuse enqueue.
// See docs/architecture/phase-b-readiness-v3.md §3 PC16.
// ────────────────────────────────────────────────────────────────────

// Minimal mock that returns the chain shape used by checkLedgerDrift /
// checkZbSyncDirty: .from(tbl).select().eq().eq().is().limit() → {data, error}.
function makeDriftDirtySupabase({ data = [], error = null } = {}) {
  return {
    from: jest.fn(() => ({
      select: jest.fn(() => ({
        eq: jest.fn(() => ({
          eq: jest.fn(() => ({
            is: jest.fn(() => ({
              limit: jest.fn(async () => ({ data, error })),
            })),
          })),
        })),
      })),
    })),
  };
}

describe('checkLedgerDrift', () => {
  test('unresolved row present → found=true with row_id', async () => {
    const sup = makeDriftDirtySupabase({ data: [{ id: 4242 }] });
    const r = await checkLedgerDrift(sup, 2, 142206);
    expect(r.found).toBe(true);
    expect(r.row_id).toBe(4242);
  });

  test('empty array → found=false', async () => {
    const sup = makeDriftDirtySupabase({ data: [] });
    const r = await checkLedgerDrift(sup, 2, 142206);
    expect(r.found).toBe(false);
    expect(r.row_id).toBeNull();
  });

  test('supabase error → fail-open (found=false) + logs', async () => {
    const sup = makeDriftDirtySupabase({ error: { message: 'db hiccup' } });
    const logger = { error: jest.fn() };
    const r = await checkLedgerDrift(sup, 2, 142206, logger);
    expect(r.found).toBe(false);
    expect(logger.error).toHaveBeenCalledWith(expect.stringMatching(/ledger_drift_detected.*db hiccup/));
  });

  test('thrown exception → fail-open (found=false) + logs', async () => {
    const sup = { from: jest.fn(() => { throw new Error('boom'); }) };
    const logger = { error: jest.fn() };
    const r = await checkLedgerDrift(sup, 2, 142206, logger);
    expect(r.found).toBe(false);
    expect(logger.error).toHaveBeenCalledWith(expect.stringMatching(/threw.*boom/));
  });
});

describe('checkZbSyncDirty', () => {
  test('unresolved row present → found=true with row_id', async () => {
    const sup = makeDriftDirtySupabase({ data: [{ id: 99 }] });
    const r = await checkZbSyncDirty(sup, 2, 142206);
    expect(r.found).toBe(true);
    expect(r.row_id).toBe(99);
  });

  test('empty array → found=false', async () => {
    const sup = makeDriftDirtySupabase({ data: [] });
    const r = await checkZbSyncDirty(sup, 2, 142206);
    expect(r.found).toBe(false);
    expect(r.row_id).toBeNull();
  });

  test('supabase error → fail-open (found=false) + logs', async () => {
    const sup = makeDriftDirtySupabase({ error: { message: 'db hiccup' } });
    const logger = { error: jest.fn() };
    const r = await checkZbSyncDirty(sup, 2, 142206, logger);
    expect(r.found).toBe(false);
    expect(logger.error).toHaveBeenCalledWith(expect.stringMatching(/zb_sync_dirty.*db hiccup/));
  });

  test('thrown exception → fail-open (found=false) + logs', async () => {
    const sup = { from: jest.fn(() => { throw new Error('boom'); }) };
    const logger = { error: jest.fn() };
    const r = await checkZbSyncDirty(sup, 2, 142206, logger);
    expect(r.found).toBe(false);
    expect(logger.error).toHaveBeenCalledWith(expect.stringMatching(/threw.*boom/));
  });
});

// ────────────────────────────────────────────────────────────────────
// End-to-end producer behavior with the new PC16 gate wired in.
// Uses a flexible mock that routes by table name and pretends gates
// 1–4 succeed by default so each test isolates the PC16 surface.
// ────────────────────────────────────────────────────────────────────

function makeProducerSupabase({ drift = [], dirty = [], capturedInsert = {} } = {}) {
  // Tables we need to satisfy: platform_settings, customers, services,
  // territories, team_members, ledger_drift_detected, zb_sync_dirty,
  // zb_outbound_commands.
  const happyCustomer = { id: 100, zenbooker_id: 'cust_x', first_name: 'A', last_name: 'B' };
  const happyService = { id: 7, zenbooker_id: 'svc_y', name: 'Std' };
  const happyTerritory = { id: 1, zenbooker_id: 'terr_z', name: 'Tampa' };
  const insertCapture = capturedInsert;

  return {
    from: jest.fn((tbl) => {
      // platform_settings (readOptInList): .from('platform_settings').select('value').eq('key', ...).maybeSingle()
      if (tbl === 'platform_settings') {
        return {
          select: jest.fn(() => ({
            eq: jest.fn(() => ({
              maybeSingle: jest.fn(async () => ({ data: { value: '{"user_ids":[2]}' } })),
            })),
          })),
        };
      }
      // resolveZbLinkage: customers/services/territories — .select().eq().eq().maybeSingle()
      if (tbl === 'customers' || tbl === 'services' || tbl === 'territories') {
        const row = tbl === 'customers' ? happyCustomer
          : tbl === 'services' ? happyService
          : happyTerritory;
        return {
          select: jest.fn(() => ({
            eq: jest.fn(() => ({
              eq: jest.fn(() => ({
                maybeSingle: jest.fn(async () => ({ data: row })),
              })),
            })),
          })),
        };
      }
      // team_members: .select().eq('user_id', ...).in('id', [...])
      if (tbl === 'team_members') {
        return {
          select: jest.fn(() => ({
            eq: jest.fn(() => ({
              in: jest.fn(async () => ({ data: [] })),
            })),
          })),
        };
      }
      // drift + dirty: .select().eq().eq().is().limit()
      if (tbl === 'ledger_drift_detected') {
        return {
          select: jest.fn(() => ({
            eq: jest.fn(() => ({
              eq: jest.fn(() => ({
                is: jest.fn(() => ({
                  limit: jest.fn(async () => ({ data: drift, error: null })),
                })),
              })),
            })),
          })),
        };
      }
      if (tbl === 'zb_sync_dirty') {
        return {
          select: jest.fn(() => ({
            eq: jest.fn(() => ({
              eq: jest.fn(() => ({
                is: jest.fn(() => ({
                  limit: jest.fn(async () => ({ data: dirty, error: null })),
                })),
              })),
            })),
          })),
        };
      }
      // zb_outbound_commands insert path. Two shapes used:
      //  - producer happy path: .from(...).insert(row).select(...).single()
      //  - insertSkippedRow:    .from(...).insert(row)  (no .select chain)
      if (tbl === 'zb_outbound_commands') {
        return {
          insert: jest.fn((row) => {
            // Capture the row whether or not .select() is chained.
            insertCapture.row = row;
            const chain = Promise.resolve({ error: null });
            chain.select = () => ({
              single: jest.fn(async () => ({
                data: { id: 'fake-uuid', event_id: row.event_id || 'fake-event', state: row.state || 'pending' },
                error: null,
              })),
            });
            return chain;
          }),
        };
      }
      return {};
    }),
  };
}

const baseLiveSfJob = {
  id: 142210,
  user_id: 2,
  customer_id: 100,
  service_id: 7,
  territory: 'Tampa',
  scheduled_date: '2026-05-21 13:30:00',
  duration: 120,
  service_address_street: '1 Main',
  service_address_city: 'Tampa',
  service_address_state: 'FL',
  service_address_zip: '33602',
};

describe('maybeEmitJobCreateCommand — PC16 P0/P1 gate', () => {
  beforeEach(() => {
    process.env.ZB_OUTBOUND_ENABLED = 'true';
    clearCache();
  });
  afterAll(() => { delete process.env.ZB_OUTBOUND_ENABLED; });

  test('unresolved ledger_drift_detected → skipped_precondition with defer_reason=ledger_drift', async () => {
    const capture = {};
    const sup = makeProducerSupabase({ drift: [{ id: 4242 }], capturedInsert: capture });
    const r = await maybeEmitJobCreateCommand(sup, baseLiveSfJob, { type: 'system' });
    expect(r.action).toBe('skipped_precondition');
    expect(r.defer_reason).toBe('ledger_drift');
    expect(capture.row.state).toBe('skipped_precondition');
    expect(capture.row.defer_reason).toBe('ledger_drift');
    expect(capture.row.last_error).toMatch(/ledger_drift_detected row #4242/);
    expect(capture.row.terminal_at).toBeTruthy();
  });

  test('unresolved zb_sync_dirty → skipped_precondition with defer_reason=zb_sync_dirty', async () => {
    const capture = {};
    const sup = makeProducerSupabase({ dirty: [{ id: 99 }], capturedInsert: capture });
    const r = await maybeEmitJobCreateCommand(sup, baseLiveSfJob, { type: 'system' });
    expect(r.action).toBe('skipped_precondition');
    expect(r.defer_reason).toBe('zb_sync_dirty');
    expect(capture.row.state).toBe('skipped_precondition');
    expect(capture.row.defer_reason).toBe('zb_sync_dirty');
    expect(capture.row.last_error).toMatch(/zb_sync_dirty row #99/);
    expect(capture.row.terminal_at).toBeTruthy();
  });

  test('no drift, no dirty → enqueue proceeds (pending row inserted)', async () => {
    const capture = {};
    const sup = makeProducerSupabase({ drift: [], dirty: [], capturedInsert: capture });
    const r = await maybeEmitJobCreateCommand(sup, baseLiveSfJob, { type: 'system' });
    expect(r.action).toBe('queued');
    expect(capture.row.state).toBe('pending');
    expect(capture.row.defer_reason).toBeFalsy();
  });

  test('drift takes precedence over dirty when both present', async () => {
    const capture = {};
    const sup = makeProducerSupabase({ drift: [{ id: 4242 }], dirty: [{ id: 99 }], capturedInsert: capture });
    const r = await maybeEmitJobCreateCommand(sup, baseLiveSfJob, { type: 'system' });
    expect(r.defer_reason).toBe('ledger_drift');
    expect(capture.row.defer_reason).toBe('ledger_drift');
  });

  test('skipped row carries field_group=create + origin=user (visible in /status aggregates)', async () => {
    const capture = {};
    const sup = makeProducerSupabase({ drift: [{ id: 4242 }], capturedInsert: capture });
    await maybeEmitJobCreateCommand(sup, baseLiveSfJob, { type: 'system', id: 1 });
    expect(capture.row.field_group).toBe('create');
    expect(capture.row.origin).toBe('user');
    expect(capture.row.user_id).toBe(2);
    expect(capture.row.sf_job_id).toBe(String(baseLiveSfJob.id));
    expect(capture.row.command_type).toBe('job.create');
  });
});
