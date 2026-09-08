/**
 * ProofPix integration — PR 2 (GET /jobs) tests.
 *
 * Fake Supabase is a more capable cousin of the one in
 * proofpix-handshake.test.js — it adds chainable .in(), .or(), .order(),
 * .limit() and a .rpc() entry point so we can exercise the real
 * filter/sort/cursor branches end-to-end.
 *
 * The .or() filter parser is intentionally minimal — it handles the
 * exact shapes our handler emits:
 *   - "a.ilike.%x%,b.ilike.%y%"
 *   - "a.eq.X,and(b.eq.Y,c.lt.Z)"
 *   - "a.lt.X,and(a.eq.X,b.lt.Y)"
 */

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const JWT_SECRET = 'test-jwt-secret-jobs';
process.env.JWT_SECRET = JWT_SECRET;
// supabase-storage.js creates a Supabase client at module-load — give it
// non-empty values so the proofpix-service require chain doesn't crash.
// The fake supabase replaces all real DB / storage calls.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://test.invalid';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role';

const { FLAGS } = require('../lib/feature-flags');
const { signAccessToken } = require('../lib/proofpix-tokens');

// ─────────────────────────────────────────────────────────────────────
// Fake Supabase with enough verbs to drive the /jobs handler
// ─────────────────────────────────────────────────────────────────────

function makeFakeSupabase(seed = {}) {
  const db = {
    users: [...(seed.users || [])],
    jobs: [...(seed.jobs || [])],
    customers: [...(seed.customers || [])],
    customer_files: [...(seed.customer_files || [])],
    proofpix_connections: [...(seed.proofpix_connections || [])],
    job_team_assignments: [...(seed.job_team_assignments || [])],
    team_members: [...(seed.team_members || [])],
  };
  const rpcCalls = [];

  function from(table) {
    if (!db[table]) db[table] = [];
    const state = {
      filters: [],   // [{kind, ...}]
      order:   [],   // [{col, ascending}]
      limit:   null,
      selectArg: null,
    };

    function applyFilters() {
      let rows = db[table].slice();
      for (const f of state.filters) {
        rows = rows.filter((r) => matchOne(r, f));
      }
      return rows;
    }

    function matchOne(row, f) {
      if (f.kind === 'eq') return String(row[f.col]) === String(f.val);
      if (f.kind === 'is') return f.val === null ? row[f.col] == null : row[f.col] === f.val;
      if (f.kind === 'in') return f.vals.map(String).includes(String(row[f.col]));
      if (f.kind === 'gte') return row[f.col] != null && String(row[f.col]) >= String(f.val);
      if (f.kind === 'or') return f.clauses.some((c) => matchOrClause(row, c));
      return true;
    }

    function matchOrClause(row, clause) {
      // clause can be a flat "col.OP.val" or "and(...,...,...)"
      const trim = clause.trim();
      const andMatch = trim.match(/^and\((.*)\)$/);
      if (andMatch) {
        const parts = splitTop(andMatch[1]);
        return parts.every((p) => matchOrClause(row, p));
      }
      // op forms
      const m = trim.match(/^([\w_]+)\.(eq|is|lt|gt|le|ge|ilike|in)\.(.+)$/);
      if (!m) return false;
      const [, col, op, raw] = m;
      const val = raw;
      const cell = row[col];
      if (op === 'eq') return String(cell) === String(val);
      if (op === 'is') return val === 'null' ? cell == null : cell === val;
      if (op === 'lt') return cell != null && String(cell) < String(val);
      if (op === 'gt') return cell != null && String(cell) > String(val);
      if (op === 'ilike') {
        const re = new RegExp(
          '^' + val.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*') + '$',
          'i'
        );
        return cell != null && re.test(String(cell));
      }
      if (op === 'in') {
        const inner = val.replace(/^\(/, '').replace(/\)$/, '');
        const list = inner.split(',').map((s) => s.trim());
        return list.includes(String(cell));
      }
      return false;
    }

    // Splits top-level CSV inside an and(...) body, respecting nested parens.
    function splitTop(s) {
      const out = [];
      let depth = 0, start = 0;
      for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (ch === '(') depth++;
        else if (ch === ')') depth--;
        else if (ch === ',' && depth === 0) {
          out.push(s.slice(start, i));
          start = i + 1;
        }
      }
      out.push(s.slice(start));
      return out;
    }

    function executeRead() {
      let rows = applyFilters();
      // Handle select with embedded relation: customers!left ( first_name, last_name )
      // Just attach the matching customer row as .customers prop.
      if (typeof state.selectArg === 'string' && /customers!left/.test(state.selectArg)) {
        rows = rows.map((j) => ({
          ...j,
          customers: db.customers.find((c) => c.id === j.customer_id) || null,
        }));
      }
      // Order
      if (state.order.length > 0) {
        rows.sort((a, b) => {
          for (const o of state.order) {
            const av = a[o.col]; const bv = b[o.col];
            if (av === bv) continue;
            const cmp = av == null ? -1 : bv == null ? 1 : av < bv ? -1 : 1;
            return o.ascending ? cmp : -cmp;
          }
          return 0;
        });
      }
      if (state.limit != null) rows = rows.slice(0, state.limit);
      return { data: rows, error: null };
    }

    const chain = {
      select(arg) { state.selectArg = arg; return chain; },
      eq(col, val) { state.filters.push({ kind: 'eq', col, val }); return chain; },
      is(col, val) { state.filters.push({ kind: 'is', col, val }); return chain; },
      in(col, vals) { state.filters.push({ kind: 'in', col, vals }); return chain; },
      gte(col, val) { state.filters.push({ kind: 'gte', col, val }); return chain; },
      or(str) {
        const clauses = splitTop(str);
        state.filters.push({ kind: 'or', clauses });
        return chain;
      },
      order(col, opts) {
        state.order.push({ col, ascending: opts ? !!opts.ascending : true });
        return chain;
      },
      limit(n) { state.limit = n; return chain; },
      then(onFulfilled, onRejected) {
        return Promise.resolve(executeRead()).then(onFulfilled, onRejected);
      },
      async maybeSingle() {
        const out = executeRead();
        return { data: out.data[0] || null, error: null };
      },
      async single() {
        const out = executeRead();
        if (!out.data[0]) return { data: null, error: { message: 'not found' } };
        return { data: out.data[0], error: null };
      },
    };
    return chain;
  }

  async function rpc(name, args) {
    rpcCalls.push({ name, args });
    if (name === 'proofpix_job_photo_counts') {
      const { p_user_id, p_job_ids } = args;
      const counts = {};
      for (const f of db.customer_files) {
        if (f.user_id !== p_user_id) continue;
        if (!p_job_ids.includes(f.job_id)) continue;
        if (f.deleted_at) continue;
        counts[f.job_id] = (counts[f.job_id] || 0) + 1;
      }
      const data = Object.entries(counts).map(([job_id, photo_count]) => ({
        job_id: Number(job_id),
        photo_count: Number(photo_count),
      }));
      return { data, error: null };
    }
    if (name === 'proofpix_customer_first_job') {
      // Mirror migration 077: for each (workspace, customer) in
      // p_customer_ids, return the earliest non-cancelled
      // (scheduled_date, id) tuple.
      const { p_user_id, p_customer_ids } = args;
      const earliestByCustomer = new Map();
      for (const j of db.jobs) {
        if (j.user_id !== p_user_id) continue;
        if (j.customer_id == null || !p_customer_ids.includes(j.customer_id)) continue;
        if (j.status === 'cancelled') continue;
        const prior = earliestByCustomer.get(j.customer_id);
        // Lexicographic on scheduled_date (safe: shared 'YYYY-MM-DD'
        // prefix), then id ascending.
        if (!prior
          || j.scheduled_date < prior.scheduled_date
          || (j.scheduled_date === prior.scheduled_date && j.id < prior.job_id)) {
          earliestByCustomer.set(j.customer_id, {
            customer_id: j.customer_id,
            scheduled_date: j.scheduled_date,
            job_id: j.id,
          });
        }
      }
      return { data: Array.from(earliestByCustomer.values()), error: null };
    }
    return { data: null, error: { message: 'unknown rpc' } };
  }

  return { from, rpc, _db: db, _rpcCalls: rpcCalls };
}

function makeApp(supabase) {
  const app = express();
  app.use(express.json());
  app.use('/api/integrations/proofpix', require('../proofpix-service')(supabase, {
    log() {}, warn() {}, error() {},
  }));
  return app;
}

function accessTokenFor(userId, connectionId = 1) {
  return signAccessToken(JWT_SECRET, { userId, connectionId });
}

function seedConnection(userId, connectionId = 1) {
  return {
    id: connectionId,
    user_id: userId,
    refresh_token_hash: 'h',
    device_label: null,
    revoked_at: null,
    created_at: new Date().toISOString(),
    last_used_at: null,
  };
}

function makeJob(over = {}) {
  return {
    id: 1,
    user_id: 1,
    customer_id: null,
    status: 'pending',
    service_name: 'Standard Cleaning',
    scheduled_date: '2026-07-15',
    scheduled_time: '09:00:00',
    created_at: '2026-06-01T00:00:00Z',
    service_address_street: '123 Main St',
    service_address_city: 'Austin',
    service_address_state: 'TX',
    service_address_zip: '78701',
    ...over,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Flag-off invisibility
// ─────────────────────────────────────────────────────────────────────

describe('GET /jobs — flag off', () => {
  beforeEach(() => { delete process.env[FLAGS.PROOFPIX_INTEGRATION_ENABLED]; });

  test('returns 404 when flag is unset', async () => {
    const supa = makeFakeSupabase({ users: [{ id: 1, business_name: 'A', email: 'a@b' }] });
    const app = makeApp(supa);
    const res = await request(app)
      .get('/api/integrations/proofpix/jobs')
      .set('Authorization', `Bearer ${accessTokenFor(1)}`)
      .send();
    expect(res.status).toBe(404);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Happy paths + shape
// ─────────────────────────────────────────────────────────────────────

describe('GET /jobs — shape and fields', () => {
  beforeEach(() => { process.env[FLAGS.PROOFPIX_INTEGRATION_ENABLED] = 'true'; });
  afterEach(() => { delete process.env[FLAGS.PROOFPIX_INTEGRATION_ENABLED]; });

  test('empty list returns jobs:[], next_cursor:null', async () => {
    const supa = makeFakeSupabase({
      users: [{ id: 1, business_name: 'A', email: 'a@b' }],
      proofpix_connections: [seedConnection(1)],
    });
    const app = makeApp(supa);
    const res = await request(app)
      .get('/api/integrations/proofpix/jobs')
      .set('Authorization', `Bearer ${accessTokenFor(1)}`)
      .send();
    expect(res.status).toBe(200);
    expect(res.body.jobs).toEqual([]);
    expect(res.body.next_cursor).toBeNull();
  });

  test('shapes a job correctly: id string, title, customer_name, address, status bucket, scheduled_at ms, photo_count', async () => {
    const supa = makeFakeSupabase({
      users: [{ id: 1, business_name: 'A', email: 'a@b' }],
      proofpix_connections: [seedConnection(1)],
      customers: [{ id: 50, user_id: 1, first_name: 'Sarah', last_name: 'Lopez' }],
      jobs: [makeJob({ id: 100, customer_id: 50, status: 'in-progress' })],
      customer_files: [
        { id: 1, user_id: 1, job_id: 100, deleted_at: null },
        { id: 2, user_id: 1, job_id: 100, deleted_at: null },
        { id: 3, user_id: 1, job_id: 100, deleted_at: '2026-06-01' },   // soft-deleted, excluded
      ],
    });
    const app = makeApp(supa);
    const res = await request(app)
      .get('/api/integrations/proofpix/jobs')
      .set('Authorization', `Bearer ${accessTokenFor(1)}`)
      .send();
    expect(res.status).toBe(200);
    expect(res.body.jobs).toHaveLength(1);
    expect(res.body.jobs[0]).toEqual({
      id: '100',
      title: 'Standard Cleaning',
      customer_name: 'Sarah Lopez',
      customer_id: 50,
      is_first_job_for_customer: true,
      address: '123 Main St, Austin, TX 78701',
      status: 'active',
      scheduled_at: Date.parse('2026-07-15T09:00:00'),
      photo_count: 2,
      team_member_id: null,
      team_member_ids: [],
    });
  });

  test('team_member_id + team_member_ids populate from jobs.team_member_id and job_team_assignments', async () => {
    const supa = makeFakeSupabase({
      users: [{ id: 1, business_name: 'A', email: 'a@b' }],
      proofpix_connections: [seedConnection(1)],
      jobs: [
        makeJob({ id: 100, team_member_id: 42 }),                    // primary only
        makeJob({ id: 101, team_member_id: null }),                  // no primary, only via join
        makeJob({ id: 102, team_member_id: 42 }),                    // primary + co-assignees
        makeJob({ id: 103, team_member_id: null }),                  // completely unassigned
      ],
      job_team_assignments: [
        { id: 1, job_id: 101, team_member_id: 43, is_primary: true },
        { id: 2, job_id: 102, team_member_id: 44, is_primary: false },
        { id: 3, job_id: 102, team_member_id: 45, is_primary: false },
      ],
    });
    const app = makeApp(supa);
    const res = await request(app)
      .get('/api/integrations/proofpix/jobs?status=all')
      .set('Authorization', `Bearer ${accessTokenFor(1)}`);
    expect(res.status).toBe(200);
    const byId = new Map(res.body.jobs.map((j) => [Number(j.id), j]));
    expect(byId.get(100)).toMatchObject({ team_member_id: 42, team_member_ids: [] });
    expect(byId.get(101)).toMatchObject({ team_member_id: null, team_member_ids: [43] });
    expect(byId.get(102)).toMatchObject({
      team_member_id: 42,
      team_member_ids: expect.arrayContaining([44, 45]),
    });
    expect(byId.get(102).team_member_ids).toHaveLength(2);
    expect(byId.get(103)).toMatchObject({ team_member_id: null, team_member_ids: [] });
  });

  test('team_member_ids dedupes if the same member appears twice in job_team_assignments', async () => {
    const supa = makeFakeSupabase({
      users: [{ id: 1, business_name: 'A', email: 'a@b' }],
      proofpix_connections: [seedConnection(1)],
      jobs: [makeJob({ id: 100, team_member_id: null })],
      job_team_assignments: [
        { id: 1, job_id: 100, team_member_id: 42, is_primary: true },
        { id: 2, job_id: 100, team_member_id: 42, is_primary: false },  // duplicate — should dedupe
      ],
    });
    const app = makeApp(supa);
    const res = await request(app)
      .get('/api/integrations/proofpix/jobs?status=all')
      .set('Authorization', `Bearer ${accessTokenFor(1)}`);
    expect(res.body.jobs[0].team_member_ids).toEqual([42]);
  });

  test('title falls back to Job #<id> when service_name is null/empty', async () => {
    const supa = makeFakeSupabase({
      users: [{ id: 1, business_name: 'A', email: 'a@b' }],
      proofpix_connections: [seedConnection(1)],
      jobs: [makeJob({ id: 7, service_name: null })],
    });
    const app = makeApp(supa);
    const res = await request(app)
      .get('/api/integrations/proofpix/jobs')
      .set('Authorization', `Bearer ${accessTokenFor(1)}`)
      .send();
    expect(res.body.jobs[0].title).toBe('Job #7');
  });

  test('address handles partial nulls (street + city only)', async () => {
    const supa = makeFakeSupabase({
      users: [{ id: 1, business_name: 'A', email: 'a@b' }],
      proofpix_connections: [seedConnection(1)],
      jobs: [makeJob({
        service_address_street: '5 Pine Rd',
        service_address_city: 'Boise',
        service_address_state: null,
        service_address_zip: null,
      })],
    });
    const app = makeApp(supa);
    const res = await request(app)
      .get('/api/integrations/proofpix/jobs')
      .set('Authorization', `Bearer ${accessTokenFor(1)}`)
      .send();
    expect(res.body.jobs[0].address).toBe('5 Pine Rd, Boise');
  });

  test('address is null when every part is missing', async () => {
    const supa = makeFakeSupabase({
      users: [{ id: 1, business_name: 'A', email: 'a@b' }],
      proofpix_connections: [seedConnection(1)],
      jobs: [makeJob({
        service_address_street: null,
        service_address_city: null,
        service_address_state: null,
        service_address_zip: null,
      })],
    });
    const app = makeApp(supa);
    const res = await request(app)
      .get('/api/integrations/proofpix/jobs')
      .set('Authorization', `Bearer ${accessTokenFor(1)}`)
      .send();
    expect(res.body.jobs[0].address).toBeNull();
  });

  test('customer_name handles first-only and missing customer', async () => {
    const supa = makeFakeSupabase({
      users: [{ id: 1, business_name: 'A', email: 'a@b' }],
      proofpix_connections: [seedConnection(1)],
      customers: [{ id: 50, user_id: 1, first_name: 'Madonna', last_name: null }],
      jobs: [
        makeJob({ id: 1, customer_id: 50 }),
        makeJob({ id: 2, customer_id: null }),
      ],
    });
    const app = makeApp(supa);
    const res = await request(app)
      .get('/api/integrations/proofpix/jobs?status=all')
      .set('Authorization', `Bearer ${accessTokenFor(1)}`)
      .send();
    const byId = Object.fromEntries(res.body.jobs.map((j) => [j.id, j]));
    expect(byId['1'].customer_name).toBe('Madonna');
    expect(byId['2'].customer_name).toBeNull();
  });

  test('scheduled_at defaults to 09:00 when scheduled_time missing', async () => {
    const supa = makeFakeSupabase({
      users: [{ id: 1, business_name: 'A', email: 'a@b' }],
      proofpix_connections: [seedConnection(1)],
      jobs: [makeJob({ scheduled_time: null })],
    });
    const app = makeApp(supa);
    const res = await request(app)
      .get('/api/integrations/proofpix/jobs')
      .set('Authorization', `Bearer ${accessTokenFor(1)}`)
      .send();
    expect(res.body.jobs[0].scheduled_at).toBe(Date.parse('2026-07-15T09:00:00'));
  });

  test('scheduled_at prefers the time embedded in scheduled_date over scheduled_time (filler avoidance)', async () => {
    // Live SF data (per prod audit 2026-07-28): scheduled_time is
    // often a default '09:00:00' filler while the real appointment
    // time lives embedded in scheduled_date as 'YYYY-MM-DD HH:MM:SS'.
    // Prior mapper stripped the embedded time and used the filler,
    // collapsing every job to 09:00 → sort ties. Fix: honor
    // embedded time when present; fall back to scheduled_time only
    // for bare 'YYYY-MM-DD' dates.
    const supa = makeFakeSupabase({
      users: [{ id: 1, business_name: 'A', email: 'a@b' }],
      proofpix_connections: [seedConnection(1)],
      jobs: [makeJob({
        scheduled_date: '2026-05-16 14:30:00',   // embedded time is authoritative
        scheduled_time: '09:00:00',              // filler — should NOT win
      })],
    });
    const app = makeApp(supa);
    const res = await request(app)
      .get('/api/integrations/proofpix/jobs')
      .set('Authorization', `Bearer ${accessTokenFor(1)}`)
      .send();
    expect(res.body.jobs[0].scheduled_at).toBe(Date.parse('2026-05-16T14:30:00'));
  });

  test('scheduled_at handles HH:MM (no seconds) embedded in scheduled_date', async () => {
    const supa = makeFakeSupabase({
      users: [{ id: 1, business_name: 'A', email: 'a@b' }],
      proofpix_connections: [seedConnection(1)],
      jobs: [makeJob({
        scheduled_date: '2026-05-16 15:00',    // ambiguous separator, no seconds
        scheduled_time: '09:00:00',
      })],
    });
    const app = makeApp(supa);
    const res = await request(app)
      .get('/api/integrations/proofpix/jobs')
      .set('Authorization', `Bearer ${accessTokenFor(1)}`)
      .send();
    expect(res.body.jobs[0].scheduled_at).toBe(Date.parse('2026-05-16T15:00:00'));
  });

  test('scheduled_at falls back to scheduled_time for bare YYYY-MM-DD dates', async () => {
    // Bare date (no embedded time) → scheduled_time is the source of truth.
    const supa = makeFakeSupabase({
      users: [{ id: 1, business_name: 'A', email: 'a@b' }],
      proofpix_connections: [seedConnection(1)],
      jobs: [makeJob({
        scheduled_date: '2026-05-16',
        scheduled_time: '14:30:00',
      })],
    });
    const app = makeApp(supa);
    const res = await request(app)
      .get('/api/integrations/proofpix/jobs')
      .set('Authorization', `Bearer ${accessTokenFor(1)}`)
      .send();
    expect(res.body.jobs[0].scheduled_at).toBe(Date.parse('2026-05-16T14:30:00'));
  });

  test('scheduled_at is null when scheduled_date is non-parseable', async () => {
    const supa = makeFakeSupabase({
      users: [{ id: 1, business_name: 'A', email: 'a@b' }],
      proofpix_connections: [seedConnection(1)],
      jobs: [makeJob({ scheduled_date: 'junk-data' })],
    });
    const app = makeApp(supa);
    const res = await request(app)
      .get('/api/integrations/proofpix/jobs')
      .set('Authorization', `Bearer ${accessTokenFor(1)}`)
      .send();
    expect(res.body.jobs[0].scheduled_at).toBeNull();
  });

  test('photo_count defaults to 0 when RPC fails (logged, not 500)', async () => {
    const supa = makeFakeSupabase({
      users: [{ id: 1, business_name: 'A', email: 'a@b' }],
      proofpix_connections: [seedConnection(1)],
      jobs: [makeJob({ id: 9 })],
    });
    // Override rpc to simulate failure
    supa.rpc = async () => ({ data: null, error: { message: 'boom' } });
    const app = makeApp(supa);
    const res = await request(app)
      .get('/api/integrations/proofpix/jobs')
      .set('Authorization', `Bearer ${accessTokenFor(1)}`)
      .send();
    expect(res.status).toBe(200);
    expect(res.body.jobs[0].photo_count).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Status bucketing + filter
// ─────────────────────────────────────────────────────────────────────

describe('GET /jobs — status mapping + filter', () => {
  beforeEach(() => { process.env[FLAGS.PROOFPIX_INTEGRATION_ENABLED] = 'true'; });
  afterEach(() => { delete process.env[FLAGS.PROOFPIX_INTEGRATION_ENABLED]; });

  function mixedSupa() {
    return makeFakeSupabase({
      users: [{ id: 1, business_name: 'A', email: 'a@b' }],
      proofpix_connections: [seedConnection(1)],
      jobs: [
        makeJob({ id: 1, status: 'pending' }),
        makeJob({ id: 2, status: 'confirmed' }),
        makeJob({ id: 3, status: 'in-progress' }),
        makeJob({ id: 4, status: 'completed' }),
        makeJob({ id: 5, status: 'complete' }),
        makeJob({ id: 6, status: 'paid' }),
        makeJob({ id: 7, status: 'cancelled' }),
        makeJob({ id: 8, status: 'scheduled' }),
        makeJob({ id: 9, status: 'rescheduled' }),
        makeJob({ id: 10, status: 'en-route' }),
        makeJob({ id: 11, status: 'started' }),
        makeJob({ id: 12, status: 'late' }),
      ],
    });
  }

  test('default ?status=active returns the 7 active SF statuses', async () => {
    const app = makeApp(mixedSupa());
    const res = await request(app)
      .get('/api/integrations/proofpix/jobs')
      .set('Authorization', `Bearer ${accessTokenFor(1)}`)
      .send();
    expect(res.status).toBe(200);
    const ids = res.body.jobs.map((j) => Number(j.id)).sort((a, b) => a - b);
    expect(ids).toEqual([1, 2, 3, 9, 10, 11, 12]);
    // every returned job buckets to 'active'
    expect(res.body.jobs.every((j) => j.status === 'active')).toBe(true);
  });

  test('?status=completed returns completed/complete/paid, all bucketed as completed', async () => {
    const app = makeApp(mixedSupa());
    const res = await request(app)
      .get('/api/integrations/proofpix/jobs?status=completed')
      .set('Authorization', `Bearer ${accessTokenFor(1)}`)
      .send();
    const ids = res.body.jobs.map((j) => Number(j.id)).sort((a, b) => a - b);
    expect(ids).toEqual([4, 5, 6]);
    expect(res.body.jobs.every((j) => j.status === 'completed')).toBe(true);
  });

  test('?status=cancelled returns cancelled only', async () => {
    const app = makeApp(mixedSupa());
    const res = await request(app)
      .get('/api/integrations/proofpix/jobs?status=cancelled')
      .set('Authorization', `Bearer ${accessTokenFor(1)}`)
      .send();
    expect(res.body.jobs.map((j) => Number(j.id))).toEqual([7]);
    expect(res.body.jobs[0].status).toBe('cancelled');
  });

  test('?status=scheduled returns scheduled only', async () => {
    const app = makeApp(mixedSupa());
    const res = await request(app)
      .get('/api/integrations/proofpix/jobs?status=scheduled')
      .set('Authorization', `Bearer ${accessTokenFor(1)}`)
      .send();
    expect(res.body.jobs.map((j) => Number(j.id))).toEqual([8]);
    expect(res.body.jobs[0].status).toBe('scheduled');
  });

  test('?status=all returns everything across the 4 buckets', async () => {
    const app = makeApp(mixedSupa());
    const res = await request(app)
      .get('/api/integrations/proofpix/jobs?status=all&limit=100')
      .set('Authorization', `Bearer ${accessTokenFor(1)}`)
      .send();
    expect(res.body.jobs).toHaveLength(12);
    const buckets = new Set(res.body.jobs.map((j) => j.status));
    expect(buckets).toEqual(new Set(['active', 'completed', 'cancelled', 'scheduled']));
  });

  test('?status=open returns active ∪ scheduled (matches SF web default list)', async () => {
    const app = makeApp(mixedSupa());
    const res = await request(app)
      .get('/api/integrations/proofpix/jobs?status=open&limit=100')
      .set('Authorization', `Bearer ${accessTokenFor(1)}`)
      .send();
    // 7 active (pending, confirmed, in-progress, rescheduled, en-route,
    // started, late) + 1 scheduled = 8. No completed/complete/paid/cancelled.
    expect(res.body.jobs).toHaveLength(8);
    const buckets = new Set(res.body.jobs.map((j) => j.status));
    expect(buckets).toEqual(new Set(['active', 'scheduled']));
    // Explicit sanity: ids 4/5/6/7 (completed/complete/paid/cancelled) excluded.
    const ids = res.body.jobs.map((j) => Number(j.id));
    expect(ids).not.toContain(4);
    expect(ids).not.toContain(5);
    expect(ids).not.toContain(6);
    expect(ids).not.toContain(7);
  });

  test('?status=junk → 400 INVALID_PAYLOAD', async () => {
    const app = makeApp(mixedSupa());
    const res = await request(app)
      .get('/api/integrations/proofpix/jobs?status=urgent')
      .set('Authorization', `Bearer ${accessTokenFor(1)}`)
      .send();
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_PAYLOAD');
  });
});

// ─────────────────────────────────────────────────────────────────────
// Tenant isolation
// ─────────────────────────────────────────────────────────────────────

describe('GET /jobs — tenant isolation', () => {
  beforeEach(() => { process.env[FLAGS.PROOFPIX_INTEGRATION_ENABLED] = 'true'; });
  afterEach(() => { delete process.env[FLAGS.PROOFPIX_INTEGRATION_ENABLED]; });

  test('only returns jobs for the authenticated user', async () => {
    const supa = makeFakeSupabase({
      users: [
        { id: 1, business_name: 'A', email: 'a@a' },
        { id: 2, business_name: 'B', email: 'b@b' },
      ],
      proofpix_connections: [seedConnection(1, 1), seedConnection(2, 2)],
      jobs: [
        makeJob({ id: 100, user_id: 1, service_name: 'A-job' }),
        makeJob({ id: 200, user_id: 2, service_name: 'B-job' }),
      ],
    });
    const app = makeApp(supa);
    const resA = await request(app)
      .get('/api/integrations/proofpix/jobs')
      .set('Authorization', `Bearer ${accessTokenFor(1, 1)}`)
      .send();
    const resB = await request(app)
      .get('/api/integrations/proofpix/jobs')
      .set('Authorization', `Bearer ${accessTokenFor(2, 2)}`)
      .send();
    expect(resA.body.jobs.map((j) => j.title)).toEqual(['A-job']);
    expect(resB.body.jobs.map((j) => j.title)).toEqual(['B-job']);
  });

  test('photo_count RPC only counts photos for the calling tenant', async () => {
    const supa = makeFakeSupabase({
      users: [{ id: 1, business_name: 'A', email: 'a@a' }, { id: 2, business_name: 'B', email: 'b@b' }],
      proofpix_connections: [seedConnection(1, 1)],
      jobs: [makeJob({ id: 100, user_id: 1 })],
      customer_files: [
        { id: 1, user_id: 1, job_id: 100, deleted_at: null },
        // foreign tenant trying to attribute photos to job 100 — must NOT count
        { id: 2, user_id: 2, job_id: 100, deleted_at: null },
      ],
    });
    const app = makeApp(supa);
    const res = await request(app)
      .get('/api/integrations/proofpix/jobs')
      .set('Authorization', `Bearer ${accessTokenFor(1, 1)}`)
      .send();
    expect(res.body.jobs[0].photo_count).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Pagination (cursor)
// ─────────────────────────────────────────────────────────────────────

describe('GET /jobs — pagination', () => {
  beforeEach(() => { process.env[FLAGS.PROOFPIX_INTEGRATION_ENABLED] = 'true'; });
  afterEach(() => { delete process.env[FLAGS.PROOFPIX_INTEGRATION_ENABLED]; });

  test('limit caps at 100', async () => {
    const jobs = [];
    for (let i = 1; i <= 150; i++) {
      jobs.push(makeJob({ id: i, scheduled_date: `2026-07-${String(i).padStart(2, '0')}` }));
    }
    const supa = makeFakeSupabase({
      users: [{ id: 1, business_name: 'A', email: 'a@b' }],
      proofpix_connections: [seedConnection(1)],
      jobs,
    });
    const app = makeApp(supa);
    const res = await request(app)
      .get('/api/integrations/proofpix/jobs?limit=500')
      .set('Authorization', `Bearer ${accessTokenFor(1)}`)
      .send();
    expect(res.body.jobs.length).toBe(100);
    expect(res.body.next_cursor).toBeTruthy();
  });

  test('limit defaults to 50 when not provided or invalid', async () => {
    const jobs = [];
    for (let i = 1; i <= 60; i++) {
      jobs.push(makeJob({ id: i, scheduled_date: `2026-07-${String((i % 28) + 1).padStart(2, '0')}` }));
    }
    const supa = makeFakeSupabase({
      users: [{ id: 1, business_name: 'A', email: 'a@b' }],
      proofpix_connections: [seedConnection(1)],
      jobs,
    });
    const app = makeApp(supa);
    const r1 = await request(app)
      .get('/api/integrations/proofpix/jobs')
      .set('Authorization', `Bearer ${accessTokenFor(1)}`)
      .send();
    const r2 = await request(app)
      .get('/api/integrations/proofpix/jobs?limit=junk')
      .set('Authorization', `Bearer ${accessTokenFor(1)}`)
      .send();
    expect(r1.body.jobs.length).toBe(50);
    expect(r2.body.jobs.length).toBe(50);
  });

  test('cursor: page 1 returns N + cursor, page 2 returns remainder + null', async () => {
    const jobs = [
      makeJob({ id: 10, scheduled_date: '2026-07-10' }),
      makeJob({ id: 20, scheduled_date: '2026-07-09' }),
      makeJob({ id: 30, scheduled_date: '2026-07-08' }),
    ];
    const supa = makeFakeSupabase({
      users: [{ id: 1, business_name: 'A', email: 'a@b' }],
      proofpix_connections: [seedConnection(1)],
      jobs,
    });
    const app = makeApp(supa);

    const page1 = await request(app)
      .get('/api/integrations/proofpix/jobs?limit=2')
      .set('Authorization', `Bearer ${accessTokenFor(1)}`)
      .send();
    expect(page1.body.jobs.map((j) => j.id)).toEqual(['10', '20']);
    expect(page1.body.next_cursor).toBeTruthy();

    const page2 = await request(app)
      .get(`/api/integrations/proofpix/jobs?limit=2&cursor=${encodeURIComponent(page1.body.next_cursor)}`)
      .set('Authorization', `Bearer ${accessTokenFor(1)}`)
      .send();
    expect(page2.body.jobs.map((j) => j.id)).toEqual(['30']);
    expect(page2.body.next_cursor).toBeNull();
  });

  test('malformed cursor → 400 INVALID_PAYLOAD', async () => {
    const supa = makeFakeSupabase({
      users: [{ id: 1, business_name: 'A', email: 'a@b' }],
      proofpix_connections: [seedConnection(1)],
    });
    const app = makeApp(supa);
    const res = await request(app)
      .get('/api/integrations/proofpix/jobs?cursor=garbage')
      .set('Authorization', `Bearer ${accessTokenFor(1)}`)
      .send();
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_PAYLOAD');
  });
});

// ─────────────────────────────────────────────────────────────────────
// Search
// ─────────────────────────────────────────────────────────────────────

describe('GET /jobs — search', () => {
  beforeEach(() => { process.env[FLAGS.PROOFPIX_INTEGRATION_ENABLED] = 'true'; });
  afterEach(() => { delete process.env[FLAGS.PROOFPIX_INTEGRATION_ENABLED]; });

  test('matches service_name (case-insensitive)', async () => {
    const supa = makeFakeSupabase({
      users: [{ id: 1, business_name: 'A', email: 'a@b' }],
      proofpix_connections: [seedConnection(1)],
      jobs: [
        makeJob({ id: 1, service_name: 'Deep Cleaning' }),
        makeJob({ id: 2, service_name: 'Window Wash' }),
      ],
    });
    const app = makeApp(supa);
    const res = await request(app)
      .get('/api/integrations/proofpix/jobs?search=window')
      .set('Authorization', `Bearer ${accessTokenFor(1)}`)
      .send();
    expect(res.body.jobs.map((j) => Number(j.id))).toEqual([2]);
  });

  test('matches customer name across the customers table', async () => {
    const supa = makeFakeSupabase({
      users: [{ id: 1, business_name: 'A', email: 'a@b' }],
      proofpix_connections: [seedConnection(1)],
      customers: [
        { id: 10, user_id: 1, first_name: 'Sarah', last_name: 'Lopez' },
        { id: 11, user_id: 1, first_name: 'Mike', last_name: 'Tannen' },
      ],
      jobs: [
        makeJob({ id: 1, customer_id: 10 }),
        makeJob({ id: 2, customer_id: 11 }),
      ],
    });
    const app = makeApp(supa);
    const res = await request(app)
      .get('/api/integrations/proofpix/jobs?search=Lopez')
      .set('Authorization', `Bearer ${accessTokenFor(1)}`)
      .send();
    expect(res.body.jobs.map((j) => Number(j.id))).toEqual([1]);
  });

  test('numeric search hits job id', async () => {
    const supa = makeFakeSupabase({
      users: [{ id: 1, business_name: 'A', email: 'a@b' }],
      proofpix_connections: [seedConnection(1)],
      jobs: [makeJob({ id: 42 }), makeJob({ id: 99 })],
    });
    const app = makeApp(supa);
    const res = await request(app)
      .get('/api/integrations/proofpix/jobs?search=%2342')   // "#42"
      .set('Authorization', `Bearer ${accessTokenFor(1)}`)
      .send();
    expect(res.body.jobs.map((j) => Number(j.id))).toEqual([42]);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Auth
// ─────────────────────────────────────────────────────────────────────

describe('GET /jobs — auth', () => {
  beforeEach(() => { process.env[FLAGS.PROOFPIX_INTEGRATION_ENABLED] = 'true'; });
  afterEach(() => { delete process.env[FLAGS.PROOFPIX_INTEGRATION_ENABLED]; });

  test('no token → 401', async () => {
    const app = makeApp(makeFakeSupabase({
      users: [{ id: 1, business_name: 'A', email: 'a@b' }],
      proofpix_connections: [seedConnection(1)],
    }));
    const res = await request(app)
      .get('/api/integrations/proofpix/jobs')
      .send();
    expect(res.status).toBe(401);
  });

  test('SF user JWT (no proofpix aud) → 401', async () => {
    const app = makeApp(makeFakeSupabase({
      users: [{ id: 1, business_name: 'A', email: 'a@b' }],
      proofpix_connections: [seedConnection(1)],
    }));
    const sfJwt = jwt.sign({ userId: 1 }, JWT_SECRET, { expiresIn: '1h' });
    const res = await request(app)
      .get('/api/integrations/proofpix/jobs')
      .set('Authorization', `Bearer ${sfJwt}`)
      .send();
    expect(res.status).toBe(401);
  });

  test('revoked connection → 401', async () => {
    const supa = makeFakeSupabase({
      users: [{ id: 1, business_name: 'A', email: 'a@b' }],
      proofpix_connections: [{
        ...seedConnection(1),
        revoked_at: new Date().toISOString(),
      }],
    });
    const app = makeApp(supa);
    const res = await request(app)
      .get('/api/integrations/proofpix/jobs')
      .set('Authorization', `Bearer ${accessTokenFor(1)}`)
      .send();
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Team-member scoping — a device linked to a specific SF team member
// only sees jobs assigned to them (via jobs.team_member_id OR
// job_team_assignments join table).
// ─────────────────────────────────────────────────────────────────────

describe('GET /jobs — linked_sf_team_member scoping', () => {
  beforeEach(() => { process.env[FLAGS.PROOFPIX_INTEGRATION_ENABLED] = 'true'; });
  afterEach(() => { delete process.env[FLAGS.PROOFPIX_INTEGRATION_ENABLED]; });

  test('unlinked (admin) connection sees ALL workspace jobs (baseline)', async () => {
    const supa = makeFakeSupabase({
      users: [{ id: 1, business_name: 'A', email: 'a@b' }],
      proofpix_connections: [seedConnection(1)],   // linked_sf_team_member_id absent → null
      jobs: [
        makeJob({ id: 100, status: 'pending', team_member_id: null }),
        makeJob({ id: 101, status: 'pending', team_member_id: 42 }),
        makeJob({ id: 102, status: 'pending', team_member_id: 99 }),
      ],
    });
    const app = makeApp(supa);
    const res = await request(app)
      .get('/api/integrations/proofpix/jobs?status=all')
      .set('Authorization', `Bearer ${accessTokenFor(1)}`);
    expect(res.status).toBe(200);
    expect(res.body.jobs.map((j) => Number(j.id)).sort()).toEqual([100, 101, 102]);
  });

  test('linked connection filters via jobs.team_member_id (single-assignee path)', async () => {
    const supa = makeFakeSupabase({
      users: [{ id: 1, business_name: 'A', email: 'a@b' }],
      proofpix_connections: [{ ...seedConnection(1), linked_sf_team_member_id: 42 }],
      jobs: [
        makeJob({ id: 100, status: 'pending', team_member_id: null }),
        makeJob({ id: 101, status: 'pending', team_member_id: 42 }),   // ← Sarah
        makeJob({ id: 102, status: 'pending', team_member_id: 99 }),
      ],
    });
    const app = makeApp(supa);
    const res = await request(app)
      .get('/api/integrations/proofpix/jobs?status=all')
      .set('Authorization', `Bearer ${accessTokenFor(1)}`);
    expect(res.status).toBe(200);
    expect(res.body.jobs.map((j) => Number(j.id))).toEqual([101]);
  });

  test('linked connection also picks up jobs via job_team_assignments (multi-assignee path)', async () => {
    const supa = makeFakeSupabase({
      users: [{ id: 1, business_name: 'A', email: 'a@b' }],
      proofpix_connections: [{ ...seedConnection(1), linked_sf_team_member_id: 42 }],
      jobs: [
        // Only direct-assigned via team_member_id
        makeJob({ id: 100, status: 'pending', team_member_id: 42 }),
        // Only assigned via job_team_assignments (jobs.team_member_id = null)
        makeJob({ id: 101, status: 'pending', team_member_id: null }),
        // Not assigned to Sarah at all
        makeJob({ id: 102, status: 'pending', team_member_id: null }),
      ],
      job_team_assignments: [
        { id: 1, job_id: 101, team_member_id: 42, is_primary: true },
        { id: 2, job_id: 102, team_member_id: 99, is_primary: true },   // different member
      ],
    });
    const app = makeApp(supa);
    const res = await request(app)
      .get('/api/integrations/proofpix/jobs?status=all')
      .set('Authorization', `Bearer ${accessTokenFor(1)}`);
    expect(res.status).toBe(200);
    // Union: 100 (direct) + 101 (via assignments) — but NOT 102.
    expect(res.body.jobs.map((j) => Number(j.id)).sort()).toEqual([100, 101]);
  });

  test('linked connection with no assignments at all → empty list', async () => {
    const supa = makeFakeSupabase({
      users: [{ id: 1, business_name: 'A', email: 'a@b' }],
      proofpix_connections: [{ ...seedConnection(1), linked_sf_team_member_id: 42 }],
      jobs: [
        makeJob({ id: 100, status: 'pending', team_member_id: null }),
        makeJob({ id: 101, status: 'pending', team_member_id: 99 }),
      ],
    });
    const app = makeApp(supa);
    const res = await request(app)
      .get('/api/integrations/proofpix/jobs?status=all')
      .set('Authorization', `Bearer ${accessTokenFor(1)}`);
    expect(res.status).toBe(200);
    expect(res.body.jobs).toEqual([]);
  });

  test('per-request ?team_member_id filters an admin-scope connection (proxy pattern)', async () => {
    // Admin-scope connection (linked_sf_team_member_id null) — proxy
    // adds ?team_member_id=X on each call to route to that cleaner
    // without re-pairing.
    const supa = makeFakeSupabase({
      users: [{ id: 1, business_name: 'A', email: 'a@b' }],
      proofpix_connections: [seedConnection(1)],   // no linked_sf_team_member_id
      team_members: [{ id: 42, user_id: 1, first_name: 'Sarah', status: 'active' }],
      jobs: [
        makeJob({ id: 100, status: 'pending', team_member_id: null }),
        makeJob({ id: 101, status: 'pending', team_member_id: 42 }),
      ],
    });
    const app = makeApp(supa);
    const res = await request(app)
      .get('/api/integrations/proofpix/jobs?status=all&team_member_id=42')
      .set('Authorization', `Bearer ${accessTokenFor(1)}`);
    expect(res.status).toBe(200);
    expect(res.body.jobs.map((j) => Number(j.id))).toEqual([101]);
  });

  test('per-request ?team_member_id must belong to caller workspace (400 for cross-tenant)', async () => {
    const supa = makeFakeSupabase({
      users: [{ id: 1, business_name: 'A', email: 'a@b' }, { id: 2, business_name: 'B', email: 'b@b' }],
      proofpix_connections: [seedConnection(1)],
      team_members: [{ id: 200, user_id: 2, first_name: 'Other', status: 'active' }],   // owned by user 2
      jobs: [makeJob({ id: 100, status: 'pending', team_member_id: 200 })],
    });
    const app = makeApp(supa);
    const res = await request(app)
      .get('/api/integrations/proofpix/jobs?team_member_id=200')
      .set('Authorization', `Bearer ${accessTokenFor(1)}`);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_TEAM_MEMBER');
  });

  test('per-request ?team_member_id on scoped connection: mismatch → 403', async () => {
    // Scoped-pair invariant — connection is pinned to Sarah (42);
    // the proxy can't reroute to Mike (43) on this connection.
    const supa = makeFakeSupabase({
      users: [{ id: 1, business_name: 'A', email: 'a@b' }],
      proofpix_connections: [{ ...seedConnection(1), linked_sf_team_member_id: 42 }],
      team_members: [
        { id: 42, user_id: 1, first_name: 'Sarah', status: 'active' },
        { id: 43, user_id: 1, first_name: 'Mike',  status: 'active' },
      ],
      jobs: [makeJob({ id: 100, status: 'pending', team_member_id: 43 })],
    });
    const app = makeApp(supa);
    const res = await request(app)
      .get('/api/integrations/proofpix/jobs?team_member_id=43')
      .set('Authorization', `Bearer ${accessTokenFor(1)}`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  test('per-request ?team_member_id on scoped connection: match → OK (filters as usual)', async () => {
    const supa = makeFakeSupabase({
      users: [{ id: 1, business_name: 'A', email: 'a@b' }],
      proofpix_connections: [{ ...seedConnection(1), linked_sf_team_member_id: 42 }],
      team_members: [{ id: 42, user_id: 1, first_name: 'Sarah', status: 'active' }],
      jobs: [
        makeJob({ id: 100, status: 'pending', team_member_id: 42 }),
        makeJob({ id: 101, status: 'pending', team_member_id: null }),
      ],
    });
    const app = makeApp(supa);
    const res = await request(app)
      .get('/api/integrations/proofpix/jobs?status=all&team_member_id=42')
      .set('Authorization', `Bearer ${accessTokenFor(1)}`);
    expect(res.status).toBe(200);
    expect(res.body.jobs.map((j) => Number(j.id))).toEqual([100]);
  });

  test('team-member scope composes with status filter (only Sarah\'s active jobs)', async () => {
    const supa = makeFakeSupabase({
      users: [{ id: 1, business_name: 'A', email: 'a@b' }],
      proofpix_connections: [{ ...seedConnection(1), linked_sf_team_member_id: 42 }],
      jobs: [
        makeJob({ id: 100, status: 'completed', team_member_id: 42 }),   // Sarah's but wrong status
        makeJob({ id: 101, status: 'in-progress', team_member_id: 42 }), // Sarah's active
        makeJob({ id: 102, status: 'in-progress', team_member_id: 99 }), // active but not Sarah's
      ],
    });
    const app = makeApp(supa);
    const res = await request(app)
      .get('/api/integrations/proofpix/jobs?status=active')
      .set('Authorization', `Bearer ${accessTokenFor(1)}`);
    expect(res.status).toBe(200);
    expect(res.body.jobs.map((j) => Number(j.id))).toEqual([101]);
  });
});

// ─────────────────────────────────────────────────────────────────────
// is_first_job_for_customer — semantics per migration 077
// ─────────────────────────────────────────────────────────────────────

describe('GET /jobs — is_first_job_for_customer', () => {
  beforeEach(() => { process.env[FLAGS.PROOFPIX_INTEGRATION_ENABLED] = 'true'; });
  afterEach(() => { delete process.env[FLAGS.PROOFPIX_INTEGRATION_ENABLED]; });

  test('customer with a single non-cancelled job → true', async () => {
    const supa = makeFakeSupabase({
      users: [{ id: 1, business_name: 'A', email: 'a@b' }],
      proofpix_connections: [seedConnection(1)],
      customers: [{ id: 200, user_id: 1, first_name: 'Ada', last_name: 'One' }],
      jobs: [makeJob({ id: 500, customer_id: 200, status: 'confirmed', scheduled_date: '2026-08-15' })],
    });
    const res = await request(makeApp(supa))
      .get('/api/integrations/proofpix/jobs?status=all')
      .set('Authorization', `Bearer ${accessTokenFor(1)}`);
    expect(res.status).toBe(200);
    expect(res.body.jobs.find((j) => j.id === '500').is_first_job_for_customer).toBe(true);
  });

  test('customer with 3 jobs → only the earliest returns true', async () => {
    const supa = makeFakeSupabase({
      users: [{ id: 1, business_name: 'A', email: 'a@b' }],
      proofpix_connections: [seedConnection(1)],
      customers: [{ id: 201, user_id: 1, first_name: 'Ben', last_name: 'Two' }],
      jobs: [
        makeJob({ id: 610, customer_id: 201, status: 'confirmed', scheduled_date: '2026-08-01' }),
        makeJob({ id: 611, customer_id: 201, status: 'confirmed', scheduled_date: '2026-08-15' }),
        makeJob({ id: 612, customer_id: 201, status: 'confirmed', scheduled_date: '2026-08-30' }),
      ],
    });
    const res = await request(makeApp(supa))
      .get('/api/integrations/proofpix/jobs?status=all')
      .set('Authorization', `Bearer ${accessTokenFor(1)}`);
    expect(res.status).toBe(200);
    const flags = Object.fromEntries(res.body.jobs.map((j) => [j.id, j.is_first_job_for_customer]));
    expect(flags['610']).toBe(true);
    expect(flags['611']).toBe(false);
    expect(flags['612']).toBe(false);
  });

  test('cancelled earlier booking does not consume first — next real booking is first', async () => {
    const supa = makeFakeSupabase({
      users: [{ id: 1, business_name: 'A', email: 'a@b' }],
      proofpix_connections: [seedConnection(1)],
      customers: [{ id: 202, user_id: 1, first_name: 'Cara', last_name: 'Three' }],
      jobs: [
        makeJob({ id: 700, customer_id: 202, status: 'cancelled', scheduled_date: '2026-08-01' }),
        makeJob({ id: 701, customer_id: 202, status: 'confirmed', scheduled_date: '2026-08-10' }),
      ],
    });
    const res = await request(makeApp(supa))
      .get('/api/integrations/proofpix/jobs?status=all')
      .set('Authorization', `Bearer ${accessTokenFor(1)}`);
    expect(res.status).toBe(200);
    const flags = Object.fromEntries(res.body.jobs.map((j) => [j.id, j.is_first_job_for_customer]));
    expect(flags['700']).toBe(false); // cancelled → always false
    expect(flags['701']).toBe(true);  // next real booking is first
  });

  test('a cancelled job itself is never first, even when it is the only row', async () => {
    const supa = makeFakeSupabase({
      users: [{ id: 1, business_name: 'A', email: 'a@b' }],
      proofpix_connections: [seedConnection(1)],
      customers: [{ id: 203, user_id: 1, first_name: 'Dana', last_name: 'Four' }],
      jobs: [
        makeJob({ id: 800, customer_id: 203, status: 'cancelled', scheduled_date: '2026-08-05' }),
      ],
    });
    const res = await request(makeApp(supa))
      .get('/api/integrations/proofpix/jobs?status=all')
      .set('Authorization', `Bearer ${accessTokenFor(1)}`);
    expect(res.status).toBe(200);
    expect(res.body.jobs.find((j) => j.id === '800').is_first_job_for_customer).toBe(false);
  });

  test('same job re-fetched returns the same flag (deterministic)', async () => {
    const supa = makeFakeSupabase({
      users: [{ id: 1, business_name: 'A', email: 'a@b' }],
      proofpix_connections: [seedConnection(1)],
      customers: [{ id: 204, user_id: 1, first_name: 'Ed', last_name: 'Five' }],
      jobs: [
        makeJob({ id: 910, customer_id: 204, status: 'confirmed', scheduled_date: '2026-08-01' }),
        makeJob({ id: 911, customer_id: 204, status: 'confirmed', scheduled_date: '2026-08-20' }),
      ],
    });
    const app = makeApp(supa);
    const first = await request(app).get('/api/integrations/proofpix/jobs?status=all')
      .set('Authorization', `Bearer ${accessTokenFor(1)}`);
    const second = await request(app).get('/api/integrations/proofpix/jobs?status=all')
      .set('Authorization', `Bearer ${accessTokenFor(1)}`);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const flags = (r) => Object.fromEntries(r.body.jobs.map((j) => [j.id, j.is_first_job_for_customer]));
    expect(flags(second)).toEqual(flags(first));
  });

  test('same date + different ids → deterministic tie-breaker on lower id', async () => {
    const supa = makeFakeSupabase({
      users: [{ id: 1, business_name: 'A', email: 'a@b' }],
      proofpix_connections: [seedConnection(1)],
      customers: [{ id: 205, user_id: 1, first_name: 'Fay', last_name: 'Six' }],
      jobs: [
        makeJob({ id: 950, customer_id: 205, status: 'confirmed', scheduled_date: '2026-08-15' }),
        makeJob({ id: 951, customer_id: 205, status: 'confirmed', scheduled_date: '2026-08-15' }),
      ],
    });
    const res = await request(makeApp(supa))
      .get('/api/integrations/proofpix/jobs?status=all')
      .set('Authorization', `Bearer ${accessTokenFor(1)}`);
    expect(res.status).toBe(200);
    const flags = Object.fromEntries(res.body.jobs.map((j) => [j.id, j.is_first_job_for_customer]));
    expect(flags['950']).toBe(true);
    expect(flags['951']).toBe(false);
  });

  test('workspace isolation: same customer_id in another workspace never affects flag', async () => {
    // customer_id 300 exists in both workspaces. Workspace 1's earliest
    // is 2026-08-20; workspace 2's earliest is 2026-01-01. Workspace 1's
    // job should still be first for workspace 1, even though a chronologically
    // earlier row exists under the same customer_id in workspace 2.
    const supa = makeFakeSupabase({
      users: [
        { id: 1, business_name: 'A', email: 'a@b' },
        { id: 2, business_name: 'B', email: 'b@c' },
      ],
      proofpix_connections: [seedConnection(1), seedConnection(2, 2)],
      customers: [
        { id: 300, user_id: 1, first_name: 'Cross', last_name: 'One' },
        { id: 300, user_id: 2, first_name: 'Cross', last_name: 'Two' },
      ],
      jobs: [
        makeJob({ id: 1200, user_id: 1, customer_id: 300, status: 'confirmed', scheduled_date: '2026-08-20' }),
        makeJob({ id: 1201, user_id: 2, customer_id: 300, status: 'confirmed', scheduled_date: '2026-01-01' }),
      ],
    });
    const app = makeApp(supa);
    const w1 = await request(app).get('/api/integrations/proofpix/jobs?status=all')
      .set('Authorization', `Bearer ${accessTokenFor(1)}`);
    expect(w1.status).toBe(200);
    expect(w1.body.jobs.find((j) => j.id === '1200').is_first_job_for_customer).toBe(true);
    const w2 = await request(app).get('/api/integrations/proofpix/jobs?status=all')
      .set('Authorization', `Bearer ${accessTokenFor(2, 2)}`);
    expect(w2.status).toBe(200);
    expect(w2.body.jobs.find((j) => j.id === '1201').is_first_job_for_customer).toBe(true);
  });

  test('customer_id present on the response even when is_first flag lookup empty', async () => {
    const supa = makeFakeSupabase({
      users: [{ id: 1, business_name: 'A', email: 'a@b' }],
      proofpix_connections: [seedConnection(1)],
      customers: [{ id: 301, user_id: 1, first_name: 'Gil', last_name: 'Seven' }],
      jobs: [makeJob({ id: 1300, customer_id: 301, status: 'confirmed', scheduled_date: '2026-08-15' })],
    });
    const res = await request(makeApp(supa))
      .get('/api/integrations/proofpix/jobs?status=all')
      .set('Authorization', `Bearer ${accessTokenFor(1)}`);
    expect(res.status).toBe(200);
    expect(res.body.jobs[0].customer_id).toBe(301);
  });

  test('is_first_job_for_customer is null when RPC fails (mobile then fails safely)', async () => {
    const supa = makeFakeSupabase({
      users: [{ id: 1, business_name: 'A', email: 'a@b' }],
      proofpix_connections: [seedConnection(1)],
      customers: [{ id: 302, user_id: 1, first_name: 'Ivy', last_name: 'Eight' }],
      jobs: [makeJob({ id: 1400, customer_id: 302, status: 'confirmed', scheduled_date: '2026-08-15' })],
    });
    // Override rpc — force proofpix_customer_first_job to fail while
    // photo-count still succeeds so the rest of the response is intact.
    const origRpc = supa.rpc;
    supa.rpc = async (name, args) => {
      if (name === 'proofpix_customer_first_job') return { data: null, error: { message: 'boom' } };
      return origRpc(name, args);
    };
    const res = await request(makeApp(supa))
      .get('/api/integrations/proofpix/jobs?status=all')
      .set('Authorization', `Bearer ${accessTokenFor(1)}`);
    expect(res.status).toBe(200);
    expect(res.body.jobs[0].is_first_job_for_customer).toBe(null);
    // customer_id must remain populated so the mobile side can still
    // identify the customer even when the first-job lookup failed.
    expect(res.body.jobs[0].customer_id).toBe(302);
  });

  test('rescheduled status is treated as non-cancelled (consumes first)', async () => {
    const supa = makeFakeSupabase({
      users: [{ id: 1, business_name: 'A', email: 'a@b' }],
      proofpix_connections: [seedConnection(1)],
      customers: [{ id: 303, user_id: 1, first_name: 'Jo', last_name: 'Nine' }],
      jobs: [
        makeJob({ id: 1500, customer_id: 303, status: 'rescheduled', scheduled_date: '2026-08-01' }),
        makeJob({ id: 1501, customer_id: 303, status: 'confirmed', scheduled_date: '2026-08-20' }),
      ],
    });
    const res = await request(makeApp(supa))
      .get('/api/integrations/proofpix/jobs?status=all')
      .set('Authorization', `Bearer ${accessTokenFor(1)}`);
    expect(res.status).toBe(200);
    const flags = Object.fromEntries(res.body.jobs.map((j) => [j.id, j.is_first_job_for_customer]));
    expect(flags['1500']).toBe(true);  // rescheduled counts
    expect(flags['1501']).toBe(false);
  });

  test('page-scoped RPC — customers OUTSIDE the current page do not appear in the lookup', async () => {
    // Two customers; small page size = 1. Both should still get correct
    // flags across two page fetches because each request scopes the RPC
    // to that page's customer_ids.
    const supa = makeFakeSupabase({
      users: [{ id: 1, business_name: 'A', email: 'a@b' }],
      proofpix_connections: [seedConnection(1)],
      customers: [
        { id: 401, user_id: 1, first_name: 'Ken', last_name: 'A' },
        { id: 402, user_id: 1, first_name: 'Liz', last_name: 'B' },
      ],
      jobs: [
        makeJob({ id: 1600, customer_id: 401, status: 'confirmed', scheduled_date: '2026-08-10' }),
        makeJob({ id: 1601, customer_id: 402, status: 'confirmed', scheduled_date: '2026-08-11' }),
      ],
    });
    const res = await request(makeApp(supa))
      .get('/api/integrations/proofpix/jobs?status=all&limit=100')
      .set('Authorization', `Bearer ${accessTokenFor(1)}`);
    expect(res.status).toBe(200);
    const flags = Object.fromEntries(res.body.jobs.map((j) => [j.id, j.is_first_job_for_customer]));
    expect(flags['1600']).toBe(true);
    expect(flags['1601']).toBe(true);
    // Sanity: no N+1 — one RPC call for photo counts, one for first-job.
    const firstJobCalls = supa._rpcCalls.filter((c) => c.name === 'proofpix_customer_first_job');
    expect(firstJobCalls).toHaveLength(1);
    expect(firstJobCalls[0].args.p_customer_ids.sort()).toEqual([401, 402]);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Recurring-job visibility — recurring jobs always appear in the
// response. The old is_recurring gate was replaced by the
// customer-history filter (proofpix_new_customers_only), which is a
// strict superset: any prior booking → hidden, regardless of whether
// the job schedule is recurring or one-off.
// ─────────────────────────────────────────────────────────────────────

describe('GET /jobs — recurring jobs always included', () => {
  beforeEach(() => { process.env[FLAGS.PROOFPIX_INTEGRATION_ENABLED] = 'true'; });
  afterEach(() => { delete process.env[FLAGS.PROOFPIX_INTEGRATION_ENABLED]; });

  test('returns is_recurring=true, false, and NULL rows together', async () => {
    const supa = makeFakeSupabase({
      users: [{ id: 1, business_name: 'A', email: 'a@b' }],
      proofpix_connections: [seedConnection(1)],
      jobs: [
        makeJob({ id: 700, status: 'confirmed', is_recurring: true }),
        makeJob({ id: 701, status: 'confirmed', is_recurring: false }),
        makeJob({ id: 702, status: 'confirmed' }),   // is_recurring absent → NULL
      ],
    });
    const res = await request(makeApp(supa))
      .get('/api/integrations/proofpix/jobs?status=all&limit=100')
      .set('Authorization', `Bearer ${accessTokenFor(1)}`);
    expect(res.status).toBe(200);
    expect(res.body.jobs.map((j) => j.id).sort()).toEqual(['700', '701', '702']);
  });
});

// ─────────────────────────────────────────────────────────────────────
// since (date-window) filter
// ─────────────────────────────────────────────────────────────────────

describe('GET /jobs — since= date filter', () => {
  beforeEach(() => { process.env[FLAGS.PROOFPIX_INTEGRATION_ENABLED] = 'true'; });
  afterEach(() => { delete process.env[FLAGS.PROOFPIX_INTEGRATION_ENABLED]; });

  test('since=2026-08-01 drops jobs scheduled before that date, keeps on/after', async () => {
    const supa = makeFakeSupabase({
      users: [{ id: 1, business_name: 'A', email: 'a@b' }],
      proofpix_connections: [seedConnection(1)],
      jobs: [
        makeJob({ id: 900, status: 'scheduled', scheduled_date: '2025-06-15' }), // stale — drop
        makeJob({ id: 901, status: 'scheduled', scheduled_date: '2026-07-31' }), // day before — drop
        makeJob({ id: 902, status: 'scheduled', scheduled_date: '2026-08-01' }), // boundary — keep
        makeJob({ id: 903, status: 'scheduled', scheduled_date: '2026-09-01 14:30:00' }), // future w/ time — keep
      ],
    });
    const res = await request(makeApp(supa))
      .get('/api/integrations/proofpix/jobs?status=open&limit=100&since=2026-08-01')
      .set('Authorization', `Bearer ${accessTokenFor(1)}`);
    expect(res.status).toBe(200);
    expect(res.body.jobs.map((j) => j.id).sort()).toEqual(['902', '903']);
    expect(res.body.filters.since).toBe('2026-08-01');
  });

  test('since absent → no date filter (backward compat)', async () => {
    const supa = makeFakeSupabase({
      users: [{ id: 1, business_name: 'A', email: 'a@b' }],
      proofpix_connections: [seedConnection(1)],
      jobs: [
        makeJob({ id: 900, status: 'scheduled', scheduled_date: '2025-06-15' }),
        makeJob({ id: 902, status: 'scheduled', scheduled_date: '2026-08-01' }),
      ],
    });
    const res = await request(makeApp(supa))
      .get('/api/integrations/proofpix/jobs?status=open&limit=100')
      .set('Authorization', `Bearer ${accessTokenFor(1)}`);
    expect(res.status).toBe(200);
    expect(res.body.jobs.map((j) => j.id).sort()).toEqual(['900', '902']);
    expect(res.body.filters.since).toBeNull();
  });

  test('since="2026/08/01" → 400 (only ISO YYYY-MM-DD accepted)', async () => {
    const supa = makeFakeSupabase({
      users: [{ id: 1, business_name: 'A', email: 'a@b' }],
      proofpix_connections: [seedConnection(1)],
    });
    const res = await request(makeApp(supa))
      .get('/api/integrations/proofpix/jobs?since=2026/08/01')
      .set('Authorization', `Bearer ${accessTokenFor(1)}`);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_PAYLOAD');
  });

  test('since drops stale rows and keeps future recurring + one-off', async () => {
    const supa = makeFakeSupabase({
      users: [{ id: 1, business_name: 'A', email: 'a@b' }],
      proofpix_connections: [seedConnection(1)],
      jobs: [
        makeJob({ id: 910, status: 'scheduled', scheduled_date: '2025-01-01', is_recurring: true }),   // stale recurring
        makeJob({ id: 911, status: 'scheduled', scheduled_date: '2026-09-01', is_recurring: true }),   // future recurring
        makeJob({ id: 912, status: 'scheduled', scheduled_date: '2026-09-01', is_recurring: false }),  // future one-off
      ],
    });
    const res = await request(makeApp(supa))
      .get('/api/integrations/proofpix/jobs?status=open&limit=100&since=2026-08-21')
      .set('Authorization', `Bearer ${accessTokenFor(1)}`);
    expect(res.status).toBe(200);
    expect(res.body.jobs.map((j) => j.id).sort()).toEqual(['911', '912']);
  });
});
