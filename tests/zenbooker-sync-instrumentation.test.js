/**
 * T2.1 (2026-05-09) — POST /sync instrumentation regression test.
 *
 * Pre-fix: the route's catch block returned `{error: "Failed to start sync"}`
 * with zero error context, and the only log line was the un-stack-augmented
 * `err.message`. The operator saw "Failed to start sync" in the browser and
 * could not see ANY trace of WHERE in the route the failure happened — Loki
 * showed nothing useful, browser DevTools showed nothing useful.
 *
 * Post-fix:
 *   - entry log fires for every /sync POST (so we know the route was hit)
 *   - `phase` variable tracks where we are inside the route handler
 *   - 4xx/5xx responses include `phase` and (where appropriate) `detail`
 *   - catch block logs err.stack and records the phase so anyone tailing
 *     Loki can see the exact failure mode without a repro
 *
 * Scope: behavior of the OUTER try/catch only. The fire-and-forget runSync()
 * is not exercised here — it has its own inner try/catch that lands in
 * syncProgress[userId].status='error' and is observable via GET /sync/progress.
 */

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const buildZenbookerRouter = require('../zenbooker-sync');

const JWT_SECRET = 'test-secret-for-zenbooker-sync-instrumentation';
process.env.JWT_SECRET = JWT_SECRET;

function makeToken(userId) {
  return jwt.sign({ userId }, JWT_SECRET);
}

function makeApp({ supabase, logger }) {
  const app = express();
  app.use(express.json());
  app.use('/api/zenbooker', buildZenbookerRouter(supabase, logger));
  return app;
}

function makeLogger() {
  const calls = { log: [], error: [], warn: [] };
  return {
    log: (...args) => calls.log.push(args.join(' ')),
    error: (...args) => calls.error.push(args.join(' ')),
    warn: (...args) => calls.warn.push(args.join(' ')),
    _calls: calls,
  };
}

/** Build a mock supabase whose `.from('users').select(...).eq(...).single()`
 *  resolves with the given { data, error } payload. */
function makeMockSupabase({ user = null, userErr = null, throwOnSelect = false } = {}) {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          single: () => {
            if (throwOnSelect) {
              return Promise.reject(new Error('synthetic supabase outage'));
            }
            return Promise.resolve({ data: user, error: userErr });
          },
        }),
      }),
      // No-op for users.update(zenbooker_last_sync) — runSync may call it but
      // we don't assert on it in these tests.
      update: () => ({ eq: () => Promise.resolve({ error: null }) }),
    }),
  };
}

describe('POST /api/zenbooker/sync — instrumentation (T2.1, 2026-05-09)', () => {
  it('returns 401 with "No token provided" when auth header missing (unchanged behavior)', async () => {
    const logger = makeLogger();
    const app = makeApp({ supabase: makeMockSupabase(), logger });
    const res = await request(app).post('/api/zenbooker/sync').send({});
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('No token provided');
  });

  it('logs an entry log on every authenticated POST (T2.1 — proves route is reached, but does NOT include request body)', async () => {
    const logger = makeLogger();
    const supabase = makeMockSupabase({ user: { zenbooker_api_key: 'k', zenbooker_status: 'connected' } });
    const app = makeApp({ supabase, logger });
    // Body contains a canary that previously got dumped into logs and would
    // have been captured below. After PR-4 the entry log only carries
    // userId; everything in `req.body` must NOT appear in logs because the
    // Zenbooker re-auth flow used to put raw integration keys in this body.
    await request(app)
      .post('/api/zenbooker/sync')
      .set('Authorization', `Bearer ${makeToken(42)}`)
      .send({ entity: 'jobs', _canary: 'pr4-body-leak-canary' });
    const entryLog = logger._calls.log.find((m) => /POST \/sync entry/.test(m));
    expect(entryLog).toBeDefined();
    expect(entryLog).toContain('userId=42');
    // Negative assertions: neither the entity name nor the canary string
    // should appear anywhere in the entry log.
    expect(entryLog).not.toContain('jobs');
    expect(entryLog).not.toContain('pr4-body-leak-canary');
  });

  it('returns 400 with phase=load_user when user is connected=null', async () => {
    const logger = makeLogger();
    const supabase = makeMockSupabase({ user: { zenbooker_api_key: null, zenbooker_status: null } });
    const app = makeApp({ supabase, logger });
    const res = await request(app).post('/api/zenbooker/sync').set('Authorization', `Bearer ${makeToken(42)}`).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Zenbooker not connected');
    expect(res.body.phase).toBe('load_user');
    expect(res.body.status).toBe(null);
  });

  it('returns 400 with phase=load_user when user has key but status is "error"', async () => {
    const logger = makeLogger();
    const supabase = makeMockSupabase({ user: { zenbooker_api_key: 'k', zenbooker_status: 'error' } });
    const app = makeApp({ supabase, logger });
    const res = await request(app).post('/api/zenbooker/sync').set('Authorization', `Bearer ${makeToken(42)}`).send({});
    expect(res.status).toBe(400);
    expect(res.body.phase).toBe('load_user');
    expect(res.body.status).toBe('error');
  });

  it('returns 500 with phase=load_user when supabase users lookup returns error', async () => {
    const logger = makeLogger();
    const supabase = makeMockSupabase({ userErr: { message: 'PGRST116: no rows', code: 'PGRST116' } });
    const app = makeApp({ supabase, logger });
    const res = await request(app).post('/api/zenbooker/sync').set('Authorization', `Bearer ${makeToken(42)}`).send({});
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Failed to load user');
    expect(res.body.phase).toBe('load_user');
    expect(res.body.detail).toContain('PGRST116');
    const errLog = logger._calls.error.find((m) => /supabase users lookup failed/.test(m));
    expect(errLog).toBeDefined();
  });

  it('returns 500 with phase=load_user + detail + stack when supabase throws synchronously', async () => {
    const logger = makeLogger();
    const supabase = makeMockSupabase({ throwOnSelect: true });
    const app = makeApp({ supabase, logger });
    const res = await request(app).post('/api/zenbooker/sync').set('Authorization', `Bearer ${makeToken(42)}`).send({});
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Failed to start sync');
    expect(res.body.phase).toBe('load_user');
    expect(res.body.detail).toBe('synthetic supabase outage');
    // In test (NODE_ENV !== 'production'), stack is exposed.
    expect(typeof res.body.stack).toBe('string');
    // Loki-side log line must include the phase + the error message.
    const errLog = logger._calls.error.find((m) => /trigger error at phase=load_user/.test(m));
    expect(errLog).toBeDefined();
    const stackLog = logger._calls.error.find((m) => /\/sync stack:/.test(m));
    expect(stackLog).toBeDefined();
  });

  it('returns 409 with phase=check_running when a sync is already running for the user', async () => {
    const logger = makeLogger();
    // First call kicks off a sync. We can't easily await runSync, so we
    // simulate the in-progress state by sending a second request immediately
    // BUT we need access to the syncProgress map. The simplest path is to
    // send two concurrent requests against the same user — the second hits
    // the running state. That's flaky if runSync resolves too fast, so
    // instead we mock `runSync` indirectly by pointing supabase at a user
    // whose api key is valid; the first req kicks runSync (which will throw
    // inside the inner catch when ZB calls fail) then immediately fire the
    // second request before the inner catch resolves.
    const supabase = makeMockSupabase({ user: { zenbooker_api_key: 'k', zenbooker_status: 'connected' } });
    const app = makeApp({ supabase, logger });
    const tok = makeToken(99);
    const [r1, r2] = await Promise.all([
      request(app).post('/api/zenbooker/sync').set('Authorization', `Bearer ${tok}`).send({}),
      request(app).post('/api/zenbooker/sync').set('Authorization', `Bearer ${tok}`).send({}),
    ]);
    // One of them gets the kick-off, the other gets 409. Order is racy but
    // exactly one 409 is expected.
    const codes = [r1.status, r2.status].sort();
    expect(codes).toEqual([200, 409]);
    const conflict = r1.status === 409 ? r1 : r2;
    expect(conflict.body.error).toBe('Sync already in progress');
    expect(conflict.body.phase).toBe('check_running');
    expect(conflict.body.currentProgress).toBeDefined();
  });
});
