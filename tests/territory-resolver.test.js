/**
 * Territory resolver — unit tests.
 *
 * Covers the 4-tier resolution:
 *   - explicit value wins (override-safe)
 *   - tier 1: customer's prior job territory (with warning)
 *   - tier 2a: exact city-to-territory-name match (no warning)
 *   - tier 2b: city-to-territory-location-prefix match (with warning)
 *   - no match: returns null + explanatory warning
 *   - ambiguous: returns null + warning
 *   - NEVER throws on Supabase error
 */

const { resolveTerritory, VALID_CONFIDENCES } = require('../lib/territory-resolver');

function makeSupabase({ priorJobs = null, priorJobsError = null, territories = null, territoriesError = null } = {}) {
  return {
    from: jest.fn((tbl) => {
      if (tbl === 'jobs') {
        // Chain: .from('jobs').select(...).eq('user_id',...).eq('customer_id',...).not('territory','is',null).neq('territory','').order(...).limit(1)
        const leaf = { data: priorJobs, error: priorJobsError };
        return {
          select: jest.fn(() => ({
            eq: jest.fn(() => ({
              eq: jest.fn(() => ({
                not: jest.fn(() => ({
                  neq: jest.fn(() => ({
                    order: jest.fn(() => ({
                      limit: jest.fn(async () => leaf),
                    })),
                  })),
                })),
              })),
            })),
          })),
        };
      }
      if (tbl === 'territories') {
        // Chain: .from('territories').select(...).eq('user_id',...).eq('status','active')
        return {
          select: jest.fn(() => ({
            eq: jest.fn(() => ({
              eq: jest.fn(async () => ({ data: territories, error: territoriesError })),
            })),
          })),
        };
      }
      return {};
    }),
  };
}

describe('resolveTerritory — Tier 0 (explicit)', () => {
  test('non-empty input value short-circuits all tiers', async () => {
    const supabase = makeSupabase();
    const r = await resolveTerritory(supabase, { user_id: 2, currentTerritory: 'Tampa' });
    expect(r.territory).toBe('Tampa');
    expect(r.confidence).toBe('explicit');
    expect(r.warning).toBeNull();
  });

  test('empty string input falls through to other tiers', async () => {
    const supabase = makeSupabase({ priorJobs: [{ id: 142190, territory: 'Tampa' }] });
    const r = await resolveTerritory(supabase, { user_id: 2, currentTerritory: '', customer_id: 23468 });
    expect(r.confidence).toBe('inherited_from_prior_job');
  });

  test('whitespace-only input falls through', async () => {
    const supabase = makeSupabase({ priorJobs: [{ id: 142190, territory: 'Tampa' }] });
    const r = await resolveTerritory(supabase, { user_id: 2, currentTerritory: '   ', customer_id: 23468 });
    expect(r.confidence).toBe('inherited_from_prior_job');
  });
});

describe('resolveTerritory — Tier 1 (prior-job inheritance)', () => {
  test('customer with prior non-empty territory → inherits + warning', async () => {
    const supabase = makeSupabase({ priorJobs: [{ id: 142190, territory: 'Tampa' }] });
    const r = await resolveTerritory(supabase, { user_id: 2, customer_id: 23468, service_address_city: 'Winter Haven' });
    expect(r.territory).toBe('Tampa');
    expect(r.confidence).toBe('inherited_from_prior_job');
    expect(r.warning).toMatch(/auto-inherited.*prior job #142190/);
    expect(r.source).toBe('prior_job_142190');
  });

  test('customer with no prior jobs falls through to Tier 2', async () => {
    const supabase = makeSupabase({ priorJobs: [], territories: [{ id: 345, name: 'Tampa', location: 'Tampa, FL, USA' }] });
    const r = await resolveTerritory(supabase, { user_id: 2, customer_id: 99, service_address_city: 'Tampa' });
    expect(r.confidence).toBe('exact_name');
    expect(r.territory).toBe('Tampa');
  });

  test('no customer_id → skips Tier 1, goes to Tier 2', async () => {
    const supabase = makeSupabase({ territories: [{ id: 345, name: 'Tampa', location: 'Tampa, FL, USA' }] });
    const r = await resolveTerritory(supabase, { user_id: 2, service_address_city: 'Tampa' });
    expect(r.confidence).toBe('exact_name');
  });
});

describe('resolveTerritory — Tier 2a (exact city name)', () => {
  test('city matches territory.name (case-insensitive) → no warning', async () => {
    const supabase = makeSupabase({
      priorJobs: [],
      territories: [
        { id: 345, name: 'Tampa', location: 'Tampa, FL, USA' },
        { id: 343, name: 'Miami', location: 'Miami, FL, USA' },
      ],
    });
    const r = await resolveTerritory(supabase, { user_id: 2, customer_id: 99, service_address_city: 'tampa' });
    expect(r.territory).toBe('Tampa');
    expect(r.confidence).toBe('exact_name');
    expect(r.warning).toBeNull();
    expect(r.source).toBe('city_name_match');
  });

  test('multiple territories with same name → ambiguous, returns null', async () => {
    const supabase = makeSupabase({
      priorJobs: [],
      territories: [
        { id: 345, name: 'Tampa', location: 'Tampa, FL, USA' },
        { id: 999, name: 'Tampa', location: 'Tampa, OK, USA' },
      ],
    });
    const r = await resolveTerritory(supabase, { user_id: 2, customer_id: 99, service_address_city: 'Tampa' });
    expect(r.territory).toBeNull();
    expect(r.confidence).toBe('ambiguous');
    expect(r.warning).toMatch(/Multiple territories named/);
  });
});

describe('resolveTerritory — Tier 2b (location-prefix match)', () => {
  test('city as location prefix → fills with warning', async () => {
    const supabase = makeSupabase({
      priorJobs: [],
      territories: [{ id: 345, name: 'Tampa Bay', location: 'Tampa, FL, USA' }],
    });
    const r = await resolveTerritory(supabase, { user_id: 2, customer_id: 99, service_address_city: 'Tampa' });
    expect(r.territory).toBe('Tampa Bay');
    expect(r.confidence).toBe('location_prefix');
    expect(r.warning).toMatch(/matched by location prefix/);
    expect(r.source).toBe('location_prefix_match');
  });

  test('multiple location-prefix matches → ambiguous', async () => {
    const supabase = makeSupabase({
      priorJobs: [],
      territories: [
        { id: 345, name: 'Tampa A', location: 'Tampa, FL, USA' },
        { id: 999, name: 'Tampa B', location: 'Tampa, OK, USA' },
      ],
    });
    const r = await resolveTerritory(supabase, { user_id: 2, customer_id: 99, service_address_city: 'Tampa' });
    expect(r.territory).toBeNull();
    expect(r.confidence).toBe('ambiguous');
    expect(r.warning).toMatch(/Multiple territories' location/);
  });
});

describe('resolveTerritory — no match cases', () => {
  test('no prior job, city does not match any territory → null + warning', async () => {
    const supabase = makeSupabase({
      priorJobs: [],
      territories: [{ id: 345, name: 'Tampa', location: 'Tampa, FL, USA' }],
    });
    const r = await resolveTerritory(supabase, { user_id: 2, customer_id: 99, service_address_city: 'Winter Haven' });
    expect(r.territory).toBeNull();
    expect(r.confidence).toBe('no_match');
    expect(r.warning).toMatch(/No territory found matching city "Winter Haven"/);
  });

  test('no prior job, no city → null + warning about missing city', async () => {
    const supabase = makeSupabase({ priorJobs: [] });
    const r = await resolveTerritory(supabase, { user_id: 2, customer_id: 99 });
    expect(r.territory).toBeNull();
    expect(r.confidence).toBe('no_match');
    expect(r.warning).toMatch(/Service address city missing/);
  });

  test('no territories configured for tenant + city present → null + tenant-level warning', async () => {
    const supabase = makeSupabase({ priorJobs: [], territories: [] });
    const r = await resolveTerritory(supabase, { user_id: 2, customer_id: 99, service_address_city: 'Tampa' });
    expect(r.territory).toBeNull();
    expect(r.confidence).toBe('no_match');
    expect(r.warning).toMatch(/No active territories configured/);
  });
});

describe('resolveTerritory — never-throws', () => {
  test('missing user_id → error verdict, no throw', async () => {
    const supabase = makeSupabase();
    const r = await resolveTerritory(supabase, {});
    expect(r.territory).toBeNull();
    expect(r.confidence).toBe('error');
  });

  test('Supabase prior-jobs error swallowed → falls through to Tier 2', async () => {
    const supabase = makeSupabase({
      priorJobsError: { message: 'connection refused' },
      territories: [{ id: 345, name: 'Tampa', location: 'Tampa, FL, USA' }],
    });
    const r = await resolveTerritory(supabase, { user_id: 2, customer_id: 99, service_address_city: 'Tampa' });
    expect(r.confidence).toBe('exact_name');
    expect(r.territory).toBe('Tampa');
  });

  test('logger.warn never crashes the resolver', async () => {
    const supabase = { from: jest.fn(() => { throw new Error('boom'); }) };
    const r = await resolveTerritory(supabase, { user_id: 2, customer_id: 99 });
    expect(r.confidence).toBe('error');
  });
});

describe('VALID_CONFIDENCES exposure', () => {
  test('all returned confidences are in VALID_CONFIDENCES', () => {
    expect(VALID_CONFIDENCES).toContain('explicit');
    expect(VALID_CONFIDENCES).toContain('inherited_from_prior_job');
    expect(VALID_CONFIDENCES).toContain('exact_name');
    expect(VALID_CONFIDENCES).toContain('location_prefix');
    expect(VALID_CONFIDENCES).toContain('no_match');
    expect(VALID_CONFIDENCES).toContain('ambiguous');
    expect(VALID_CONFIDENCES).toContain('error');
  });
});
