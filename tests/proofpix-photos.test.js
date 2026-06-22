/**
 * ProofPix integration — PR 3 (POST /jobs/:jobId/photos) tests.
 *
 * Fake Supabase extends the jobs-test cousin with a `.storage` shim
 * (upload / getPublicUrl / remove) and unique-constraint emulation on
 * customer_files insert so we can exercise both the pre-check dedup
 * path AND the race-via-unique-violation fallback.
 */

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const JWT_SECRET = 'test-jwt-secret-photos';
process.env.JWT_SECRET = JWT_SECRET;
// supabase-storage.js creates a Supabase client at module-load — give it
// any non-empty values so the require chain doesn't crash. The handler
// uses our injected fake supabase, never this client.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://test.invalid';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role';

const { FLAGS } = require('../lib/feature-flags');
const { signAccessToken } = require('../lib/proofpix-tokens');

// 1×1 transparent PNG; tiny so tests stay fast.
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=',
  'base64'
);
const TINY_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEASABIAAD//gATQ3JlYXRlZCB3aXRoIEdJTVD/2wBDAP////////////////////////////////////////////////////////////////////////////////////8B////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAr/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAAP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AL+AB//Z',
  'base64'
);

function makeFakeSupabase(seed = {}) {
  const db = {
    users: [...(seed.users || [])],
    jobs: [...(seed.jobs || [])],
    customers: [...(seed.customers || [])],
    customer_files: [...(seed.customer_files || [])],
    proofpix_connections: [...(seed.proofpix_connections || [])],
  };
  let nextFileId = (db.customer_files.reduce((m, r) => Math.max(m, r.id || 0), 0)) + 1;
  const storage = { uploads: [], removed: [] };
  // Per-test override: set { upload: { error } } to force upload failures, etc.
  const storageOverrides = {};
  // Per-test override: force insert into customer_files to fail with a given error.
  let insertErrorOverride = null;
  // Per-test override: when set, the next insert into customer_files
  // first pushes this "racing" row into the table, then returns 23505.
  // Models a concurrent insert landing between our pre-check and our
  // insert — what the handler's post-error re-fetch should find.
  let raceRowOnNextInsert = null;

  function from(table) {
    if (!db[table]) db[table] = [];
    const state = { filters: [], order: [], limit: null, selectArg: null };

    function applyFilters() {
      let rows = db[table].slice();
      for (const f of state.filters) {
        rows = rows.filter((r) => {
          if (f.kind === 'eq') return String(r[f.col]) === String(f.val);
          if (f.kind === 'is') return f.val === null ? r[f.col] == null : r[f.col] === f.val;
          if (f.kind === 'in') return f.vals.map(String).includes(String(r[f.col]));
          return true;
        });
      }
      return rows;
    }

    const chain = {
      select(arg) { state.selectArg = arg; return chain; },
      eq(col, val) { state.filters.push({ kind: 'eq', col, val }); return chain; },
      is(col, val) { state.filters.push({ kind: 'is', col, val }); return chain; },
      in(col, vals) { state.filters.push({ kind: 'in', col, vals }); return chain; },
      async maybeSingle() {
        const rows = applyFilters();
        return { data: rows[0] || null, error: null };
      },
      async single() {
        const rows = applyFilters();
        if (!rows[0]) return { data: null, error: { message: 'not found' } };
        return { data: rows[0], error: null };
      },
    };

    // Insert (used for customer_files); enforces the unique (user_id, proofpix_photo_id)
    // partial index when proofpix_photo_id is non-null.
    chain.insert = (row) => {
      // Race simulation: land the conflicting row first, then return 23505.
      if (raceRowOnNextInsert && table === 'customer_files') {
        db.customer_files.push(raceRowOnNextInsert);
        raceRowOnNextInsert = null;
        return {
          select() {
            return {
              async single() {
                return { data: null, error: { code: '23505', message: 'duplicate key value' } };
              },
            };
          },
        };
      }
      if (insertErrorOverride && table === 'customer_files') {
        const err = insertErrorOverride;
        insertErrorOverride = null;
        return {
          select() {
            return {
              async single() { return { data: null, error: err }; },
            };
          },
        };
      }
      if (table === 'customer_files' && row && row.proofpix_photo_id) {
        const dupe = db.customer_files.find(
          (r) => r.user_id === row.user_id
            && r.proofpix_photo_id === row.proofpix_photo_id
            && r.deleted_at == null
        );
        if (dupe) {
          return {
            select() {
              return {
                async single() {
                  return { data: null, error: { code: '23505', message: 'duplicate key value' } };
                },
              };
            },
          };
        }
      }
      const inserted = Array.isArray(row) ? row[0] : { ...row };
      if (table === 'customer_files') {
        inserted.id = nextFileId++;
        if (!inserted.uploaded_at) inserted.uploaded_at = new Date().toISOString();
      }
      db[table].push(inserted);
      return {
        select() {
          return {
            async single() { return { data: inserted, error: null }; },
          };
        },
      };
    };
    return chain;
  }

  // Bare-minimum supabase.storage shim
  const storageApi = {
    from(bucket) {
      return {
        async upload(p, buffer, opts) {
          if (storageOverrides.uploadShouldFail) return { error: { message: 'upload exploded' } };
          storage.uploads.push({ bucket, path: p, bytes: buffer.length, ...opts });
          return { error: null };
        },
        getPublicUrl(p) {
          return { data: { publicUrl: `https://fake-supabase.test/${bucket}/${p}` } };
        },
        async remove(paths) {
          for (const p of paths) storage.removed.push({ bucket, path: p });
          return { error: null };
        },
      };
    },
  };

  return {
    from,
    storage: storageApi,
    _db: db,
    _storage: storage,
    setUploadFailure(yes) { storageOverrides.uploadShouldFail = yes; },
    setNextInsertError(err) { insertErrorOverride = err; },
    simulateRaceOnNextInsert(row) { raceRowOnNextInsert = row; },
  };
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
    id: connectionId, user_id: userId, refresh_token_hash: 'h',
    device_label: null, revoked_at: null, created_at: new Date().toISOString(),
    last_used_at: null,
  };
}

function baseSeed({ jobs = [] } = {}) {
  return {
    users: [{ id: 1, business_name: 'Acme', email: 'a@b' }],
    proofpix_connections: [seedConnection(1)],
    customers: [{ id: 50, user_id: 1, first_name: 'Sarah', last_name: 'Lopez' }],
    jobs: jobs.length ? jobs : [{ id: 100, user_id: 1, customer_id: 50, status: 'pending' }],
  };
}

function validMetadata(over = {}) {
  return {
    filename: 'photo.jpg',
    mode: 'before',
    room: 'front_roof',
    timestamp: Date.now(),
    gps: null,
    captured_by: null,
    notes: '',
    proofpix_photo_id: `pp-${Math.random().toString(36).slice(2)}`,
    proofpix_project_id: 'proj-1',
    ...over,
  };
}

function postPhoto(app, { token, jobId, file, mime = 'image/jpeg', filename = 'photo.jpg', metadata }) {
  const req = request(app)
    .post(`/api/integrations/proofpix/jobs/${jobId}/photos`);
  if (token) req.set('Authorization', `Bearer ${token}`);
  req.field('metadata', JSON.stringify(metadata));
  req.attach('file', file, { filename, contentType: mime });
  return req;
}

// ─────────────────────────────────────────────────────────────────────
// Flag-off
// ─────────────────────────────────────────────────────────────────────

describe('POST /jobs/:jobId/photos — flag off', () => {
  beforeEach(() => { delete process.env[FLAGS.PROOFPIX_INTEGRATION_ENABLED]; });

  test('returns 404 when flag is unset', async () => {
    const supa = makeFakeSupabase(baseSeed());
    const app = makeApp(supa);
    const res = await postPhoto(app, {
      token: accessTokenFor(1),
      jobId: 100,
      file: TINY_JPEG,
      metadata: validMetadata(),
    });
    expect(res.status).toBe(404);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Auth
// ─────────────────────────────────────────────────────────────────────

describe('POST /jobs/:jobId/photos — auth', () => {
  beforeEach(() => { process.env[FLAGS.PROOFPIX_INTEGRATION_ENABLED] = 'true'; });
  afterEach(() => { delete process.env[FLAGS.PROOFPIX_INTEGRATION_ENABLED]; });

  test('no token → 401', async () => {
    const app = makeApp(makeFakeSupabase(baseSeed()));
    const res = await postPhoto(app, { jobId: 100, file: TINY_JPEG, metadata: validMetadata() });
    expect(res.status).toBe(401);
  });

  test('SF user JWT (no aud=proofpix) → 401', async () => {
    const app = makeApp(makeFakeSupabase(baseSeed()));
    const sfJwt = jwt.sign({ userId: 1 }, JWT_SECRET, { expiresIn: '1h' });
    const res = await postPhoto(app, {
      token: sfJwt, jobId: 100, file: TINY_JPEG, metadata: validMetadata(),
    });
    expect(res.status).toBe(401);
  });

  test('revoked connection → 401', async () => {
    const supa = makeFakeSupabase({
      ...baseSeed(),
      proofpix_connections: [{ ...seedConnection(1), revoked_at: new Date().toISOString() }],
    });
    const app = makeApp(supa);
    const res = await postPhoto(app, {
      token: accessTokenFor(1), jobId: 100, file: TINY_JPEG, metadata: validMetadata(),
    });
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Happy path + persistence
// ─────────────────────────────────────────────────────────────────────

describe('POST /jobs/:jobId/photos — happy path', () => {
  beforeEach(() => { process.env[FLAGS.PROOFPIX_INTEGRATION_ENABLED] = 'true'; });
  afterEach(() => { delete process.env[FLAGS.PROOFPIX_INTEGRATION_ENABLED]; });

  test('jpeg upload returns 200 with crm_photo_id and photo_url', async () => {
    const supa = makeFakeSupabase(baseSeed());
    const app = makeApp(supa);
    const meta = validMetadata({ proofpix_photo_id: 'pp-abc-123' });
    const res = await postPhoto(app, {
      token: accessTokenFor(1), jobId: 100, file: TINY_JPEG, metadata: meta,
    });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.crm_photo_id).toMatch(/^\d+$/);
    expect(res.body.photo_url).toMatch(/^https:\/\/fake-supabase\.test\/proofpix-photos\/user-1\/job-100\/pp-abc-123\.jpg$/);

    // Persisted row carries source + metadata + customer_id from the job
    expect(supa._db.customer_files).toHaveLength(1);
    const row = supa._db.customer_files[0];
    expect(row).toMatchObject({
      user_id: 1, customer_id: 50, job_id: 100,
      filename: 'photo.jpg', mime_type: 'image/jpeg',
      source: 'proofpix', proofpix_photo_id: 'pp-abc-123',
    });
    expect(row.proofpix_metadata).toMatchObject({
      mode: 'before', room: 'front_roof', proofpix_project_id: 'proj-1',
    });
    // Blob persisted to bucket
    expect(supa._storage.uploads).toHaveLength(1);
    expect(supa._storage.uploads[0]).toMatchObject({
      bucket: 'proofpix-photos',
      path: 'user-1/job-100/pp-abc-123.jpg',
      contentType: 'image/jpeg',
      upsert: false,
    });
  });

  test('png upload sets contentType + extension correctly', async () => {
    const supa = makeFakeSupabase(baseSeed());
    const app = makeApp(supa);
    const res = await postPhoto(app, {
      token: accessTokenFor(1), jobId: 100,
      file: TINY_PNG, mime: 'image/png', filename: 'shot.png',
      metadata: validMetadata({ proofpix_photo_id: 'pp-png', filename: 'shot.png' }),
    });
    expect(res.status).toBe(200);
    expect(supa._storage.uploads[0].path).toMatch(/pp-png\.png$/);
    expect(supa._storage.uploads[0].contentType).toBe('image/png');
  });

  test('job without customer_id stores customer_id=null', async () => {
    const supa = makeFakeSupabase({
      ...baseSeed({ jobs: [{ id: 100, user_id: 1, customer_id: null, status: 'pending' }] }),
    });
    const app = makeApp(supa);
    const res = await postPhoto(app, {
      token: accessTokenFor(1), jobId: 100, file: TINY_JPEG, metadata: validMetadata(),
    });
    expect(res.status).toBe(200);
    expect(supa._db.customer_files[0].customer_id).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────
// Idempotency
// ─────────────────────────────────────────────────────────────────────

describe('POST /jobs/:jobId/photos — idempotency', () => {
  beforeEach(() => { process.env[FLAGS.PROOFPIX_INTEGRATION_ENABLED] = 'true'; });
  afterEach(() => { delete process.env[FLAGS.PROOFPIX_INTEGRATION_ENABLED]; });

  test('second upload with same proofpix_photo_id returns 409 with the first crm_photo_id (pre-check path)', async () => {
    const supa = makeFakeSupabase(baseSeed());
    const app = makeApp(supa);
    const meta = validMetadata({ proofpix_photo_id: 'pp-idempo-1' });

    const first = await postPhoto(app, { token: accessTokenFor(1), jobId: 100, file: TINY_JPEG, metadata: meta });
    expect(first.status).toBe(200);

    const second = await postPhoto(app, { token: accessTokenFor(1), jobId: 100, file: TINY_JPEG, metadata: meta });
    expect(second.status).toBe(409);
    expect(second.body).toEqual({
      success: true,
      crm_photo_id: first.body.crm_photo_id,
      photo_url:    first.body.photo_url,
    });
    // No duplicate row, no duplicate blob from the second attempt
    expect(supa._db.customer_files).toHaveLength(1);
    expect(supa._storage.uploads).toHaveLength(1);
  });

  test('post-insert race (23505): handler re-fetches existing row, returns 409, cleans orphan blob', async () => {
    // Genuine race: pre-check misses (table empty), blob upload
    // succeeds, then a concurrent insert lands the conflicting row,
    // our insert fails with 23505, our re-fetch finds it.
    const supa = makeFakeSupabase(baseSeed());
    const PHOTO_ID = 'pp-race';
    supa.simulateRaceOnNextInsert({
      id: 7777, user_id: 1, customer_id: 50, job_id: 100,
      filename: 'race-conflicting.jpg',
      file_url: 'https://fake-supabase.test/race-conflicting.jpg',
      mime_type: 'image/jpeg', size_bytes: 999, uploaded_by: 1,
      source: 'proofpix', proofpix_photo_id: PHOTO_ID, deleted_at: null,
      uploaded_at: new Date().toISOString(),
    });

    const app = makeApp(supa);
    const res = await postPhoto(app, {
      token: accessTokenFor(1), jobId: 100, file: TINY_JPEG,
      metadata: validMetadata({ proofpix_photo_id: PHOTO_ID }),
    });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      success: true,
      crm_photo_id: '7777',
      photo_url:    'https://fake-supabase.test/race-conflicting.jpg',
    });
    // Blob was uploaded (pre-check missed) but then cleaned up
    expect(supa._storage.uploads).toHaveLength(1);
    expect(supa._storage.removed).toHaveLength(1);
    expect(supa._storage.removed[0].path).toBe(supa._storage.uploads[0].path);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Validation
// ─────────────────────────────────────────────────────────────────────

describe('POST /jobs/:jobId/photos — validation', () => {
  beforeEach(() => { process.env[FLAGS.PROOFPIX_INTEGRATION_ENABLED] = 'true'; });
  afterEach(() => { delete process.env[FLAGS.PROOFPIX_INTEGRATION_ENABLED]; });

  test('wrong tenant (job belongs to another user) → 404 JOB_NOT_FOUND', async () => {
    const supa = makeFakeSupabase({
      ...baseSeed({ jobs: [{ id: 100, user_id: 2, customer_id: null, status: 'pending' }] }),
    });
    const app = makeApp(supa);
    const res = await postPhoto(app, {
      token: accessTokenFor(1), jobId: 100, file: TINY_JPEG, metadata: validMetadata(),
    });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('JOB_NOT_FOUND');
  });

  test('non-existent job → 404 JOB_NOT_FOUND', async () => {
    const supa = makeFakeSupabase(baseSeed());
    const app = makeApp(supa);
    const res = await postPhoto(app, {
      token: accessTokenFor(1), jobId: 999, file: TINY_JPEG, metadata: validMetadata(),
    });
    expect(res.status).toBe(404);
  });

  test('non-numeric jobId → 404', async () => {
    const supa = makeFakeSupabase(baseSeed());
    const app = makeApp(supa);
    const res = await request(app)
      .post('/api/integrations/proofpix/jobs/abc/photos')
      .set('Authorization', `Bearer ${accessTokenFor(1)}`)
      .field('metadata', JSON.stringify(validMetadata()))
      .attach('file', TINY_JPEG, { filename: 'p.jpg', contentType: 'image/jpeg' });
    expect(res.status).toBe(404);
  });

  test('missing metadata → 400 INVALID_PAYLOAD', async () => {
    const supa = makeFakeSupabase(baseSeed());
    const app = makeApp(supa);
    const res = await request(app)
      .post('/api/integrations/proofpix/jobs/100/photos')
      .set('Authorization', `Bearer ${accessTokenFor(1)}`)
      .attach('file', TINY_JPEG, { filename: 'p.jpg', contentType: 'image/jpeg' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_PAYLOAD');
  });

  test('missing file → 400 INVALID_PAYLOAD', async () => {
    const supa = makeFakeSupabase(baseSeed());
    const app = makeApp(supa);
    const res = await request(app)
      .post('/api/integrations/proofpix/jobs/100/photos')
      .set('Authorization', `Bearer ${accessTokenFor(1)}`)
      .field('metadata', JSON.stringify(validMetadata()));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_PAYLOAD');
  });

  test('metadata not valid JSON → 400', async () => {
    const supa = makeFakeSupabase(baseSeed());
    const app = makeApp(supa);
    const res = await request(app)
      .post('/api/integrations/proofpix/jobs/100/photos')
      .set('Authorization', `Bearer ${accessTokenFor(1)}`)
      .field('metadata', '{nope')
      .attach('file', TINY_JPEG, { filename: 'p.jpg', contentType: 'image/jpeg' });
    expect(res.status).toBe(400);
  });

  test('metadata.mode invalid → 400', async () => {
    const supa = makeFakeSupabase(baseSeed());
    const app = makeApp(supa);
    const res = await postPhoto(app, {
      token: accessTokenFor(1), jobId: 100, file: TINY_JPEG,
      metadata: validMetadata({ mode: 'sideways' }),
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_PAYLOAD');
  });

  test.each([
    ['filename', { filename: '' }],
    ['room',     { room: '' }],
    ['proofpix_photo_id',   { proofpix_photo_id: '' }],
    ['proofpix_project_id', { proofpix_project_id: '' }],
    ['timestamp non-numeric', { timestamp: 'now' }],
  ])('missing/invalid metadata.%s → 400', async (_label, over) => {
    const supa = makeFakeSupabase(baseSeed());
    const app = makeApp(supa);
    const res = await postPhoto(app, {
      token: accessTokenFor(1), jobId: 100, file: TINY_JPEG, metadata: validMetadata(over),
    });
    expect(res.status).toBe(400);
  });

  test('non-image mime (image/gif) → 400 INVALID_PAYLOAD', async () => {
    const supa = makeFakeSupabase(baseSeed());
    const app = makeApp(supa);
    const res = await postPhoto(app, {
      token: accessTokenFor(1), jobId: 100, file: TINY_PNG,
      mime: 'image/gif', filename: 'p.gif',
      metadata: validMetadata(),
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_PAYLOAD');
  });

  test('file > 20MB → 413 PAYLOAD_TOO_LARGE', async () => {
    const supa = makeFakeSupabase(baseSeed());
    const app = makeApp(supa);
    // 21MB buffer of zeros, served as jpeg
    const huge = Buffer.alloc(21 * 1024 * 1024);
    const res = await postPhoto(app, {
      token: accessTokenFor(1), jobId: 100, file: huge, mime: 'image/jpeg',
      filename: 'big.jpg', metadata: validMetadata({ proofpix_photo_id: 'pp-huge' }),
    });
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });
});

// ─────────────────────────────────────────────────────────────────────
// Failure paths (storage / DB)
// ─────────────────────────────────────────────────────────────────────

describe('POST /jobs/:jobId/photos — backend failures', () => {
  beforeEach(() => { process.env[FLAGS.PROOFPIX_INTEGRATION_ENABLED] = 'true'; });
  afterEach(() => { delete process.env[FLAGS.PROOFPIX_INTEGRATION_ENABLED]; });

  test('storage upload error → 500 INTERNAL, no DB row', async () => {
    const supa = makeFakeSupabase(baseSeed());
    supa.setUploadFailure(true);
    const app = makeApp(supa);
    const res = await postPhoto(app, {
      token: accessTokenFor(1), jobId: 100, file: TINY_JPEG, metadata: validMetadata(),
    });
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('INTERNAL');
    expect(supa._db.customer_files).toHaveLength(0);
  });

  test('non-23505 DB insert error → 500 INTERNAL, blob cleanup attempted', async () => {
    const supa = makeFakeSupabase(baseSeed());
    supa.setNextInsertError({ code: '12345', message: 'permission denied' });
    const app = makeApp(supa);
    const res = await postPhoto(app, {
      token: accessTokenFor(1), jobId: 100, file: TINY_JPEG, metadata: validMetadata(),
    });
    expect(res.status).toBe(500);
    expect(supa._storage.removed.length).toBeGreaterThan(0);
  });
});
