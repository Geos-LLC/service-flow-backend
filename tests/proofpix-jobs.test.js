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
      const m = trim.match(/^([\w_]+)\.(eq|lt|gt|le|ge|ilike|in)\.(.+)$/);
      if (!m) return false;
      const [, col, op, raw] = m;
      const val = raw;
      const cell = row[col];
      if (op === 'eq') return String(cell) === String(val);
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
    expect(res.body).toEqual({ jobs: [], next_cursor: null });
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
      address: '123 Main St, Austin, TX 78701',
      status: 'active',
      scheduled_at: Date.parse('2026-07-15T09:00:00'),
      photo_count: 2,
    });
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

  test('scheduled_at handles "YYYY-MM-DD HH:MM:SS" format in scheduled_date (ZB sync legacy data)', async () => {
    const supa = makeFakeSupabase({
      users: [{ id: 1, business_name: 'A', email: 'a@b' }],
      proofpix_connections: [seedConnection(1)],
      jobs: [makeJob({
        scheduled_date: '2026-05-16 09:00:00',   // not just YYYY-MM-DD
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
