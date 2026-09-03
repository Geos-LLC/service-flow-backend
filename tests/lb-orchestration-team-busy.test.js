'use strict';

/**
 * /orchestration/team-busy — hermetic handler tests.
 *
 * This endpoint returns per-cleaner busy intervals across ALL locations,
 * for the cleaners eligible to serve a scoped territory. It is the fix
 * for the cross-location-double-booking bug that /busy cannot see
 * (because /busy filters jobs by territory_id, hiding cross-location
 * jobs from LB's slot filter).
 *
 * Covers:
 *   - 400 when from/to missing / range invalid / range > 60 days
 *   - excludes non-service-providers, inactive, owner/admin/manager
 *   - honors sf_location_id: only cleaners whose territories contain it
 *   - job pull is UNSCOPED by territory — cross-location jobs appear
 *     under the shared cleaner's busy_windows
 *   - fail-closed on unresolved external_business_id
 *   - falls back to jobs.team_member_id when no job_team_assignments row
 *   - audit row inserted to lb_orchestration_attempts
 *
 * Acceptance cases (per the design brief):
 *   1. Two cleaners eligible for St. Pete; Cleaner A busy in Tampa
 *      during requested slot, Cleaner B free everywhere → the response
 *      MUST show Cleaner A with a busy_window overlapping the slot AND
 *      Cleaner B with no busy_window in that slot. LB's per-cleaner
 *      filter can then determine "slot available (B is free)".
 *
 *   2. All eligible cleaners have conflicts spread across any
 *      combination of locations → every cleaner in the response MUST
 *      carry a busy_window overlapping the slot. LB's per-cleaner
 *      filter must then determine "slot unavailable".
 *
 * These pin against accidentally implementing flat-union behavior
 * during future refactors: the endpoint MUST return per-cleaner data
 * shaped so LB can make per-cleaner decisions.
 */

process.env.SF_INTEGRATION_ENC_KEY = Buffer.alloc(32, 7).toString('base64');

const { makeTeamBusyHandler } = require('../lib/lb-orchestration-handlers');

function makeStub({ teamMembers = [], jobs = [] } = {}) {
  const inserts = [];
  return {
    _inserts: inserts,
    from(table) {
      const filter = {};
      let inserting = null;
      const chain = {
        select() { return chain; },
        eq(k, v) { filter[k] = v; return chain; },
        neq(k, v) { filter[`__neq_${k}`] = v; return chain; },
        gte(k, v) { filter[`__gte_${k}`] = v; return chain; },
        lte(k, v) { filter[`__lte_${k}`] = v; return chain; },
        lt(k, v)  { filter[`__lt_${k}`]  = v; return chain; },
        in() { return chain; },
        order() { return chain; },
        limit() { return chain; },
        insert(row) { inserting = row; inserts.push({ table, row }); return chain; },
        maybeSingle() { return Promise.resolve({ data: null, error: null }); },
        then(resolve) {
          if (inserting) return void resolve({ error: null });
          if (table === 'team_members') {
            const rows = teamMembers.filter(t => matches(t, filter));
            return void resolve({ data: rows, error: null });
          }
          if (table === 'jobs') {
            const rows = jobs.filter(j => matches(j, filter));
            return void resolve({ data: rows, error: null });
          }
          resolve({ data: [], error: null });
        },
      };
      return chain;
    },
  };
  function matches(r, filter) {
    for (const [k, v] of Object.entries(filter)) {
      if (k.startsWith('__gte_')) {
        const c = k.slice(6);
        if (String(r[c] || '') < String(v)) return false;
      } else if (k.startsWith('__lte_')) {
        const c = k.slice(6);
        if (String(r[c] || '') > String(v)) return false;
      } else if (k.startsWith('__lt_')) {
        const c = k.slice(5);
        if (!(String(r[c] || '') < String(v))) return false;
      } else if (k.startsWith('__neq_')) {
        const c = k.slice(6);
        if (String(r[c]) === String(v)) return false;
      } else {
        if (String(r[k]) !== String(v)) return false;
      }
    }
    return true;
  }
}

const SILENT = { log() {}, warn() {}, error() {} };
function mockRes() {
  return {
    _status: 200, _body: null,
    status(c) { this._status = c; return this; },
    json(b) { this._body = b; return this; },
  };
}

// Helper: does any of the cleaner's busy_windows overlap the interval?
// Same overlap semantic LB will apply (ANY overlap → busy).
function overlapsAny(cleaner, startIso, endIso) {
  const s = new Date(startIso).getTime();
  const e = new Date(endIso).getTime();
  return cleaner.busy_windows.some(w => {
    const ws = new Date(w.start).getTime();
    const we = new Date(w.end).getTime();
    return ws < e && s < we;
  });
}

describe('team-busy handler — validation', () => {
  test('400 when from/to missing', async () => {
    const h = makeTeamBusyHandler({ supabase: makeStub(), logger: SILENT });
    const res = mockRes();
    await h({ user: { userId: 2 }, query: {} }, res);
    expect(res._status).toBe(400);
  });

  test('400 when to <= from', async () => {
    const h = makeTeamBusyHandler({ supabase: makeStub(), logger: SILENT });
    const res = mockRes();
    await h({
      user: { userId: 2 },
      query: { from: '2026-09-03T00:00:00Z', to: '2026-09-03T00:00:00Z' },
    }, res);
    expect(res._status).toBe(400);
  });

  test('400 when range > 60 days', async () => {
    const h = makeTeamBusyHandler({ supabase: makeStub(), logger: SILENT });
    const res = mockRes();
    await h({
      user: { userId: 2 },
      query: { from: '2026-01-01T00:00:00Z', to: '2026-06-01T00:00:00Z' },
    }, res);
    expect(res._status).toBe(400);
    expect(res._body.error).toMatch(/range too large/);
  });
});

describe('team-busy handler — cleaner eligibility', () => {
  test('excludes non-service-providers, inactive, owner/admin/manager', async () => {
    const teamMembers = [
      { id: 1, first_name: 'Field',    last_name: 'A', user_id: 2, is_service_provider: true,  is_active: true,  status: 'active',   role: 'cleaner',       territories: [340] },
      { id: 2, first_name: 'Manager',  last_name: 'B', user_id: 2, is_service_provider: false, is_active: true,  status: 'active',   role: 'manager',       territories: [340] },
      { id: 3, first_name: 'Owner',    last_name: 'C', user_id: 2, is_service_provider: true,  is_active: true,  status: 'active',   role: 'account owner', territories: [340] },
      { id: 4, first_name: 'Inactive', last_name: 'D', user_id: 2, is_service_provider: true,  is_active: false, status: 'inactive', role: 'cleaner',       territories: [340] },
      { id: 5, first_name: 'Admin',    last_name: 'E', user_id: 2, is_service_provider: true,  is_active: true,  status: 'active',   role: 'admin',         territories: [340] },
    ];
    const h = makeTeamBusyHandler({ supabase: makeStub({ teamMembers }), logger: SILENT });
    const res = mockRes();
    await h({
      user: { userId: 2 },
      query: { from: '2026-09-03T00:00:00Z', to: '2026-09-03T23:59:00Z', sf_location_id: '340' },
    }, res);
    expect(res._status).toBe(200);
    expect(res._body.team.map(t => t.team_member_id)).toEqual([1]);
  });

  test('scope filter honors sf_location_id — cleaner not in territories is excluded', async () => {
    const teamMembers = [
      { id: 10, first_name: 'StPeteOnly', user_id: 2, is_service_provider: true, is_active: true, status: 'active', role: 'cleaner', territories: [340] },
      { id: 11, first_name: 'TampaOnly',  user_id: 2, is_service_provider: true, is_active: true, status: 'active', role: 'cleaner', territories: [345] },
      { id: 12, first_name: 'Both',       user_id: 2, is_service_provider: true, is_active: true, status: 'active', role: 'cleaner', territories: [340, 345] },
    ];
    const h = makeTeamBusyHandler({ supabase: makeStub({ teamMembers }), logger: SILENT });
    const res = mockRes();
    await h({
      user: { userId: 2 },
      query: { from: '2026-09-03T00:00:00Z', to: '2026-09-03T23:59:00Z', sf_location_id: '340' },
    }, res);
    expect(res._status).toBe(200);
    const ids = res._body.team.map(t => t.team_member_id).sort();
    expect(ids).toEqual([10, 12]);
  });
});

describe('team-busy handler — cross-location busy windows', () => {
  test('shared cleaner returns Tampa job in busy_windows when queried through St. Pete', async () => {
    const teamMembers = [{
      id: 2657, first_name: 'Larisa', last_name: 'Shumelda',
      user_id: 2, is_service_provider: true, is_active: true, status: 'active', role: 'cleaner',
      territories: [340, 345],
    }];
    const jobs = [
      // Tampa (345) job — MUST appear in St. Pete (340) query response
      { id: 999, user_id: 2, status: 'scheduled', team_member_id: 2657,
        territory_id: 345,
        scheduled_date: '2026-09-03T14:00:00.000Z', duration: 240, end_time: null,
        job_team_assignments: [{ team_member_id: 2657 }] },
    ];
    const h = makeTeamBusyHandler({ supabase: makeStub({ teamMembers, jobs }), logger: SILENT });
    const res = mockRes();
    await h({
      user: { userId: 2 },
      query: { from: '2026-09-03T00:00:00Z', to: '2026-09-05T00:00:00Z', sf_location_id: '340' },
    }, res);
    expect(res._status).toBe(200);
    expect(res._body.scope).toEqual({ resolution: 'explicit', location_id: 340 });
    expect(res._body.team).toHaveLength(1);
    const larisa = res._body.team[0];
    expect(larisa.team_member_id).toBe(2657);
    expect(larisa.busy_windows).toHaveLength(1);
    expect(larisa.busy_windows[0]).toEqual({
      start: '2026-09-03T14:00:00.000Z',
      end:   '2026-09-03T18:00:00.000Z',
      sf_location_id: 345,
    });
  });

  test('falls back to jobs.team_member_id when job_team_assignments is empty', async () => {
    const teamMembers = [{
      id: 100, first_name: 'X', user_id: 2, is_service_provider: true, is_active: true, status: 'active', role: 'cleaner',
      territories: [340],
    }];
    const jobs = [{
      id: 1, user_id: 2, status: 'scheduled', team_member_id: 100,
      territory_id: 340,
      scheduled_date: '2026-09-03T10:00:00.000Z', duration: 120, end_time: null,
      job_team_assignments: [],
    }];
    const h = makeTeamBusyHandler({ supabase: makeStub({ teamMembers, jobs }), logger: SILENT });
    const res = mockRes();
    await h({
      user: { userId: 2 },
      query: { from: '2026-09-03T00:00:00Z', to: '2026-09-04T00:00:00Z', sf_location_id: '340' },
    }, res);
    expect(res._status).toBe(200);
    expect(res._body.team[0].busy_windows).toHaveLength(1);
  });

  test('excludes cancelled jobs', async () => {
    const teamMembers = [{
      id: 1, first_name: 'X', user_id: 2, is_service_provider: true, is_active: true, status: 'active', role: 'cleaner',
      territories: [340],
    }];
    const jobs = [{
      id: 1, user_id: 2, status: 'cancelled', team_member_id: 1,
      territory_id: 340, scheduled_date: '2026-09-03T10:00:00.000Z', duration: 120, end_time: null,
      job_team_assignments: [],
    }];
    const h = makeTeamBusyHandler({ supabase: makeStub({ teamMembers, jobs }), logger: SILENT });
    const res = mockRes();
    await h({
      user: { userId: 2 },
      query: { from: '2026-09-03T00:00:00Z', to: '2026-09-04T00:00:00Z', sf_location_id: '340' },
    }, res);
    expect(res._body.team[0].busy_windows).toEqual([]);
  });

  test('drops jobs assigned only to non-eligible cleaners (matches team-free-windows semantics)', async () => {
    const teamMembers = [{
      id: 1, first_name: 'Eligible', user_id: 2, is_service_provider: true, is_active: true, status: 'active', role: 'cleaner',
      territories: [340],
    }];
    const jobs = [{
      id: 1, user_id: 2, status: 'scheduled', team_member_id: 999, // 999 is not in team
      territory_id: 340, scheduled_date: '2026-09-03T10:00:00.000Z', duration: 120, end_time: null,
      job_team_assignments: [{ team_member_id: 999 }],
    }];
    const h = makeTeamBusyHandler({ supabase: makeStub({ teamMembers, jobs }), logger: SILENT });
    const res = mockRes();
    await h({
      user: { userId: 2 },
      query: { from: '2026-09-03T00:00:00Z', to: '2026-09-04T00:00:00Z', sf_location_id: '340' },
    }, res);
    expect(res._body.team[0].busy_windows).toEqual([]);
  });
});

describe('team-busy handler — acceptance cases (per-cleaner semantics guard)', () => {
  // ACCEPTANCE CASE 1:
  //   Two cleaners eligible for St. Pete (loc=340).
  //   Cleaner A (Kateryna, id=2671) has a Tampa job 10 AM-2 PM Thu Sep 3.
  //   Cleaner B (Lesia, id=2682) has no jobs anywhere Thu.
  //   Requested slot: Thu 10-12 St. Pete.
  //
  //   The endpoint MUST report:
  //     - Cleaner A: busy_window overlapping 10-12
  //     - Cleaner B: no busy_window overlapping 10-12
  //
  //   That gives LB the information it needs to conclude "slot
  //   available (Cleaner B is free)" via per-cleaner evaluation.
  //   If we ever accidentally flat-union the response, this test
  //   will still pass (both cleaners see the union), which would
  //   let LB draw the WRONG conclusion "slot unavailable". So the
  //   assertion below explicitly checks Cleaner B's busy_windows
  //   is empty — flat-union would fail here.
  test('cleaner A busy in Tampa, cleaner B free everywhere → per-cleaner data supports "slot available"', async () => {
    const teamMembers = [
      { id: 2671, first_name: 'Kateryna', last_name: 'Kridnieva',
        user_id: 2, is_service_provider: true, is_active: true, status: 'active', role: 'cleaner',
        territories: [340, 345] },
      { id: 2682, first_name: 'Lesia', last_name: 'Tampa',
        user_id: 2, is_service_provider: true, is_active: true, status: 'active', role: 'cleaner',
        territories: [340, 345] },
    ];
    const jobs = [
      // Kateryna busy in Tampa Thu 10-2
      { id: 1, user_id: 2, status: 'scheduled', team_member_id: 2671,
        territory_id: 345,
        scheduled_date: '2026-09-03T14:00:00.000Z', duration: 240, end_time: null,
        job_team_assignments: [{ team_member_id: 2671 }] },
    ];
    const h = makeTeamBusyHandler({ supabase: makeStub({ teamMembers, jobs }), logger: SILENT });
    const res = mockRes();
    await h({
      user: { userId: 2 },
      query: { from: '2026-09-03T00:00:00Z', to: '2026-09-04T00:00:00Z', sf_location_id: '340' },
    }, res);
    expect(res._status).toBe(200);
    expect(res._body.team).toHaveLength(2);

    const kateryna = res._body.team.find(t => t.team_member_id === 2671);
    const lesia    = res._body.team.find(t => t.team_member_id === 2682);
    expect(kateryna).toBeDefined();
    expect(lesia).toBeDefined();

    // Kateryna MUST have the Tampa job in her list (with sf_location_id trace)
    expect(kateryna.busy_windows).toHaveLength(1);
    expect(kateryna.busy_windows[0].sf_location_id).toBe(345);

    // Lesia MUST have zero busy_windows. Guard against accidental flat-union
    // implementation (which would smear Kateryna's Tampa job onto Lesia).
    expect(lesia.busy_windows).toEqual([]);

    // Per-cleaner overlap check LB will use: at least one cleaner has NO
    // overlap with the requested slot → slot available.
    const slotStart = '2026-09-03T14:00:00.000Z'; // 10 AM ET
    const slotEnd   = '2026-09-03T16:00:00.000Z'; // 12 PM ET
    const anyFree = res._body.team.some(c => !overlapsAny(c, slotStart, slotEnd));
    expect(anyFree).toBe(true);
  });

  // ACCEPTANCE CASE 2:
  //   Two cleaners eligible for St. Pete.
  //   Cleaner A (Kateryna) has a Tampa job 10 AM-2 PM Thu Sep 3.
  //   Cleaner B (Lesia)   has a St. Pete job 11 AM-1 PM Thu Sep 3.
  //   Requested slot: Thu 11:30 AM-12:30 PM St. Pete.
  //
  //   Both cleaners' busy_windows overlap the slot (across two
  //   different territories). LB's per-cleaner filter MUST conclude
  //   "no eligible cleaner free → slot unavailable".
  test('all eligible cleaners busy across different locations → per-cleaner data supports "slot unavailable"', async () => {
    const teamMembers = [
      { id: 2671, first_name: 'Kateryna', user_id: 2, is_service_provider: true, is_active: true, status: 'active', role: 'cleaner', territories: [340, 345] },
      { id: 2682, first_name: 'Lesia',    user_id: 2, is_service_provider: true, is_active: true, status: 'active', role: 'cleaner', territories: [340, 345] },
    ];
    const jobs = [
      { id: 1, user_id: 2, status: 'scheduled', team_member_id: 2671,
        territory_id: 345,
        scheduled_date: '2026-09-03T14:00:00.000Z', duration: 240, end_time: null,
        job_team_assignments: [{ team_member_id: 2671 }] },
      { id: 2, user_id: 2, status: 'scheduled', team_member_id: 2682,
        territory_id: 340,
        scheduled_date: '2026-09-03T15:00:00.000Z', duration: 120, end_time: null,
        job_team_assignments: [{ team_member_id: 2682 }] },
    ];
    const h = makeTeamBusyHandler({ supabase: makeStub({ teamMembers, jobs }), logger: SILENT });
    const res = mockRes();
    await h({
      user: { userId: 2 },
      query: { from: '2026-09-03T00:00:00Z', to: '2026-09-04T00:00:00Z', sf_location_id: '340' },
    }, res);
    expect(res._status).toBe(200);
    expect(res._body.team).toHaveLength(2);

    const slotStart = '2026-09-03T15:30:00.000Z'; // 11:30 AM ET
    const slotEnd   = '2026-09-03T16:30:00.000Z'; // 12:30 PM ET
    const anyFree = res._body.team.some(c => !overlapsAny(c, slotStart, slotEnd));
    expect(anyFree).toBe(false);

    // And confirm each cleaner's window carries its true sf_location_id.
    const kateryna = res._body.team.find(t => t.team_member_id === 2671);
    const lesia    = res._body.team.find(t => t.team_member_id === 2682);
    expect(kateryna.busy_windows[0].sf_location_id).toBe(345);
    expect(lesia.busy_windows[0].sf_location_id).toBe(340);
  });
});

describe('team-busy handler — scope resolver', () => {
  test('fail-closed when external_business_id cannot be resolved', async () => {
    const h = makeTeamBusyHandler({
      supabase: makeStub(), logger: SILENT,
      resolveLocationForOrchestrationScope: async () => ({ locationId: null, resolution: 'unknown_business' }),
    });
    const res = mockRes();
    await h({
      user: { userId: 2 },
      query: { from: '2026-09-03T00:00:00Z', to: '2026-09-03T23:59:00Z', external_business_id: 'yelp-XYZ' },
    }, res);
    expect(res._status).toBe(200);
    expect(res._body.team).toEqual([]);
    expect(res._body.scope.resolution).toBe('unknown_business');
  });
});

describe('team-busy handler — audit', () => {
  test('inserts one row into lb_orchestration_attempts on success', async () => {
    const teamMembers = [{
      id: 1, first_name: 'A', user_id: 2, is_service_provider: true, is_active: true, status: 'active', role: 'cleaner',
      territories: [340],
    }];
    const stub = makeStub({ teamMembers });
    const h = makeTeamBusyHandler({ supabase: stub, logger: SILENT });
    await h({
      user: { userId: 2 },
      query: { from: '2026-09-03T00:00:00Z', to: '2026-09-03T23:59:00Z', sf_location_id: '340' },
    }, mockRes());
    const audit = stub._inserts.filter(i => i.table === 'lb_orchestration_attempts');
    expect(audit.length).toBe(1);
    expect(audit[0].row.endpoint).toBe('team_busy');
    expect(audit[0].row.result).toBe('success');
  });
});
