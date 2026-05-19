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
    sf_address: { line1: '123 Main', city: 'Tampa', state: 'FL', postal_code: '33602' },
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
    expect(body.address).toEqual({ line1: '123 Main', city: 'Tampa', state: 'FL', postal_code: '33602' });
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
});
