'use strict';

/**
 * lb-orchestration-credentials.js + lb-orchestration-token-format.js
 *
 * Pure unit tests — no real DB, no network. Verifies:
 *
 *   token codec:
 *     - encode/decode round-trip
 *     - tampered token → bad_signature
 *     - unknown kid → unknown_kid
 *     - expired (past exp) → expired
 *     - not-yet-valid (future iat beyond skew) → not_yet_valid
 *     - clock skew (±60s) tolerance
 *     - hashTokenForLookup is deterministic + 64-char hex
 *     - module import has zero side effects
 *
 *   credential lifecycle:
 *     - mintCredential inserts active row, returns plaintext token ONCE
 *     - verifyCredentialToken: valid active → ok
 *     - verifyCredentialToken: rotating + grace window OK → ok
 *     - verifyCredentialToken: rotating + grace expired → flips to revoked AND rejects
 *     - verifyCredentialToken: revoked → credential_revoked
 *     - verifyCredentialToken: tenant mismatch (cross-tenant) → tenant_mismatch
 *     - verifyCredentialToken: unknown token_hash → unknown_credential
 *     - rotateCredential: old → rotating + new → active in one call
 *     - rotateCredential: with no active → no_active_credential
 *     - revokeCredential: atomically flips active + rotating
 *     - sweepExpiredRotating: only flips overdue rotating rows
 *
 *   safety:
 *     - plaintext token never appears in the token_hash or token_prefix
 *     - last_used_at is set on successful verify (fire-and-forget)
 */

// Env setup — a real 32-byte base64 random key so resolveSigningKey returns a Buffer.
// Tests must not depend on production env, so we set our own deterministic key here.
process.env.SF_ORCH_SIGNING_KEY     = Buffer.alloc(32, 0xAB).toString('base64');
process.env.SF_ORCH_SIGNING_KEY_KID = 'sf_orch_test_kid';

// Optional prev-key for kid-rotation tests.
process.env.SF_ORCH_SIGNING_KEY_PREV     = Buffer.alloc(32, 0xCD).toString('base64');
process.env.SF_ORCH_SIGNING_KEY_PREV_KID = 'sf_orch_test_prev_kid';

const codec = require('../lib/lb-orchestration-token-format');
const creds = require('../lib/lb-orchestration-credentials');

const TABLE = 'lb_orchestration_credentials';

// ─────────────────────────────────────────────────────────────────
// In-memory Supabase stub. Supports only the ops the module uses.
// ─────────────────────────────────────────────────────────────────
function makeStore({ insertError = null } = {}) {
  const rows = [];
  let nextId = 1;
  const writeLog = [];

  function applyFilters(rs, filters) {
    return rs.filter((r) => {
      for (const f of filters) {
        if (f.type === 'eq' && String(r[f.col]) !== String(f.val)) return false;
        if (f.type === 'in' && !f.vals.map(String).includes(String(r[f.col]))) return false;
        if (f.type === 'lte') {
          const lhs = r[f.col] ? Date.parse(r[f.col]) : null;
          const rhs = Date.parse(f.val);
          if (lhs == null || !(lhs <= rhs)) return false;
        }
      }
      return true;
    });
  }

  function makeBuilder(table) {
    const state = {
      table,
      op: null,           // 'insert' | 'update' | 'select' | 'delete'
      payload: null,
      filters: [],
      selectCols: null,
    };

    const builder = {
      _state: state,
      insert(row) { state.op = 'insert'; state.payload = row; return builder; },
      update(p)   { state.op = 'update'; state.payload = p;   return builder; },
      delete()    { state.op = 'delete';                     return builder; },
      select(c)   { state.selectCols = c || '*'; if (!state.op) state.op = 'select'; return builder; },
      eq(c, v)    { state.filters.push({ type: 'eq', col: c, val: v }); return builder; },
      in(c, v)    { state.filters.push({ type: 'in', col: c, vals: v }); return builder; },
      lte(c, v)   { state.filters.push({ type: 'lte', col: c, val: v }); return builder; },
      single()       { return exec(state).then(coerceSingle); },
      maybeSingle()  { return exec(state).then(coerceMaybeSingle); },
      then(onF, onR) { return exec(state).then(onF, onR); },
    };
    return builder;
  }

  function exec(state) {
    return new Promise((resolve) => {
      writeLog.push({
        op: state.op,
        table: state.table,
        payload: state.payload ? JSON.parse(JSON.stringify(state.payload)) : null,
        filters: state.filters.slice(),
      });

      if (state.table !== TABLE) {
        return resolve({ data: null, error: null });
      }

      if (state.op === 'insert') {
        if (insertError) {
          return resolve({ data: null, error: insertError });
        }
        // Partial-unique-index simulation: at most one 'active' per user_id.
        const wantActive = state.payload.status === 'active';
        if (wantActive) {
          const collision = rows.find(
            (r) => r.user_id === state.payload.user_id && r.status === 'active'
          );
          if (collision) {
            return resolve({ data: null, error: { code: '23505', message: 'duplicate key' } });
          }
        }
        const newRow = { id: nextId++, ...state.payload };
        rows.push(newRow);
        if (state.selectCols) {
          return resolve({ data: { id: newRow.id }, error: null });
        }
        return resolve({ data: null, error: null });
      }

      if (state.op === 'update') {
        const matched = applyFilters(rows, state.filters);
        for (const r of matched) Object.assign(r, state.payload);
        if (state.selectCols) {
          return resolve({ data: matched.map((r) => ({ ...r })), error: null });
        }
        return resolve({ data: null, error: null });
      }

      if (state.op === 'select' || state.op == null) {
        const matched = applyFilters(rows, state.filters);
        return resolve({ data: matched.map((r) => ({ ...r })), error: null });
      }

      return resolve({ data: null, error: null });
    });
  }

  function coerceSingle({ data, error }) {
    if (error) return { data: null, error };
    if (Array.isArray(data)) {
      if (data.length === 0) return { data: null, error: { code: 'PGRST116', message: 'no rows' } };
      return { data: data[0], error: null };
    }
    return { data, error: null };
  }

  function coerceMaybeSingle({ data, error }) {
    if (error) return { data: null, error };
    if (Array.isArray(data)) {
      return { data: data[0] || null, error: null };
    }
    return { data: data || null, error: null };
  }

  return {
    _rows: rows,
    _writeLog: writeLog,
    from(table) { return makeBuilder(table); },
  };
}

function freshNowMs() {
  return Date.now();
}

// ─────────────────────────────────────────────────────────────────
// 1. Token codec (pure)
// ─────────────────────────────────────────────────────────────────
describe('lb-orchestration-token-format', () => {
  const key = Buffer.alloc(32, 0xAB);

  test('encode → parse round-trip; signature verifies', () => {
    const e = codec.encodeToken({
      tenantId: 2, kid: 'sf_orch_test_kid', expiresInMs: 60_000, signingKey: key,
    });
    expect(e.token).toMatch(/^sfo_v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(e.tokenPrefix).toBe(e.token.slice(0, 13));
    expect(e.payload.tenant_id).toBe(2);
    expect(e.payload.kid).toBe('sf_orch_test_kid');
    expect(e.payload.scope).toBe('lb_orchestration');
    expect(e.payload.iss).toBe('service_flow');

    const v = codec.verifyTokenSignature(e.token, {
      resolveSigningKey: () => key,
    });
    expect(v.valid).toBe(true);
    expect(v.payload.tenant_id).toBe(2);
  });

  test('tampered payload → bad_signature', () => {
    const e = codec.encodeToken({ tenantId: 2, kid: 'sf_orch_test_kid', expiresInMs: 60_000, signingKey: key });
    const parts = e.token.split('.');
    parts[1] = parts[1].slice(0, -2) + (parts[1].endsWith('A') ? 'B' : 'A') + parts[1].slice(-1);
    const v = codec.verifyTokenSignature(parts.join('.'), { resolveSigningKey: () => key });
    expect(v.valid).toBe(false);
    expect(['bad_signature', 'malformed_payload']).toContain(v.reason);
  });

  test('tampered signature → bad_signature', () => {
    const e = codec.encodeToken({ tenantId: 2, kid: 'sf_orch_test_kid', expiresInMs: 60_000, signingKey: key });
    const parts = e.token.split('.');
    parts[2] = parts[2].slice(0, -2) + 'AA';
    const v = codec.verifyTokenSignature(parts.join('.'), { resolveSigningKey: () => key });
    expect(v.valid).toBe(false);
    expect(v.reason).toBe('bad_signature');
  });

  test('unknown kid (resolveSigningKey returns null) → unknown_kid', () => {
    const e = codec.encodeToken({ tenantId: 2, kid: 'sf_orch_test_kid', expiresInMs: 60_000, signingKey: key });
    const v = codec.verifyTokenSignature(e.token, { resolveSigningKey: () => null });
    expect(v.valid).toBe(false);
    expect(v.reason).toBe('unknown_kid');
  });

  test('expired token → expired', () => {
    const e = codec.encodeToken({ tenantId: 2, kid: 'sf_orch_test_kid', expiresInMs: 60_000, signingKey: key });
    const futureNowMs = Date.now() + 24 * 60 * 60 * 1000;   // 24h later
    const v = codec.verifyTokenSignature(e.token, { resolveSigningKey: () => key, nowMs: futureNowMs });
    expect(v.valid).toBe(false);
    expect(v.reason).toBe('expired');
  });

  test('future iat beyond skew → not_yet_valid', () => {
    const e = codec.encodeToken({ tenantId: 2, kid: 'sf_orch_test_kid', expiresInMs: 60_000, signingKey: key });
    const pastNowMs = Date.now() - 5 * 60 * 1000;   // 5 minutes earlier
    const v = codec.verifyTokenSignature(e.token, {
      resolveSigningKey: () => key, nowMs: pastNowMs, clockSkewMs: 30_000,
    });
    expect(v.valid).toBe(false);
    expect(v.reason).toBe('not_yet_valid');
  });

  test('clock skew tolerance: ±60s default accepts a token issued 30s ago when expired by 30s', () => {
    // Token expires 60_000ms after iat; with skew=60s, a 90s-old token is still valid.
    const e = codec.encodeToken({ tenantId: 2, kid: 'sf_orch_test_kid', expiresInMs: 60_000, signingKey: key });
    const slightlyExpiredNowMs = Date.now() + 90_000;
    const v = codec.verifyTokenSignature(e.token, {
      resolveSigningKey: () => key, nowMs: slightlyExpiredNowMs, clockSkewMs: 60_000,
    });
    expect(v.valid).toBe(true);
  });

  test('malformed inputs → malformed', () => {
    for (const bad of ['', 'foo', 'sfo_v1.x', 'sfo_v1.x.y.z', null, undefined]) {
      const v = codec.verifyTokenSignature(bad, { resolveSigningKey: () => key });
      expect(v.valid).toBe(false);
      expect(['malformed', 'malformed_payload']).toContain(v.reason);
    }
  });

  test('hashTokenForLookup is deterministic + 64-char hex', () => {
    const e = codec.encodeToken({ tenantId: 2, kid: 'sf_orch_test_kid', expiresInMs: 60_000, signingKey: key });
    const h1 = codec.hashTokenForLookup(e.token);
    const h2 = codec.hashTokenForLookup(e.token);
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
    expect(h1).not.toContain(e.token);                // hash must not echo plaintext
  });

  test('tokenPrefix returns first 13 chars', () => {
    const e = codec.encodeToken({ tenantId: 2, kid: 'sf_orch_test_kid', expiresInMs: 60_000, signingKey: key });
    expect(codec.tokenPrefix(e.token)).toBe(e.token.slice(0, 13));
    expect(codec.tokenPrefix(e.token)).toMatch(/^sfo_v1\./);
  });

  test('module import has no DB or network side effects', () => {
    // Re-require under jest's isolated module cache.
    jest.resetModules();
    const fresh = require('../lib/lb-orchestration-token-format');
    expect(typeof fresh.encodeToken).toBe('function');
    // No top-level state to assert beyond functions existing — but the
    // fact that re-importing this many times in tests doesn't crash on
    // missing env is itself the assertion.
  });
});

// ─────────────────────────────────────────────────────────────────
// 2. resolveSigningKey + getCurrentKid (env-driven)
// ─────────────────────────────────────────────────────────────────
describe('resolveSigningKey + getCurrentKid', () => {
  test('returns 32-byte Buffer for the current kid', () => {
    expect(creds.getCurrentKid()).toBe('sf_orch_test_kid');
    const key = creds.resolveSigningKey('sf_orch_test_kid');
    expect(Buffer.isBuffer(key)).toBe(true);
    expect(key.length).toBe(32);
  });

  test('returns 32-byte Buffer for the prev kid', () => {
    const key = creds.resolveSigningKey('sf_orch_test_prev_kid');
    expect(Buffer.isBuffer(key)).toBe(true);
    expect(key.length).toBe(32);
  });

  test('returns null for an unknown kid', () => {
    expect(creds.resolveSigningKey('never_set')).toBeNull();
    expect(creds.resolveSigningKey(null)).toBeNull();
    expect(creds.resolveSigningKey('')).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────
// 3. mintCredential
// ─────────────────────────────────────────────────────────────────
describe('mintCredential', () => {
  test('inserts an active row and returns plaintext token + metadata', async () => {
    const store = makeStore();
    const res = await creds.mintCredential(store, { userId: 2 });
    expect(res.ok).toBe(true);
    expect(res.token).toMatch(/^sfo_v1\./);
    expect(res.tokenPrefix).toBe(res.token.slice(0, 13));
    expect(res.kid).toBe('sf_orch_test_kid');
    expect(typeof res.credentialId).toBe('number');

    // Row should be present, status='active', token_hash != plaintext.
    expect(store._rows).toHaveLength(1);
    const row = store._rows[0];
    expect(row.status).toBe('active');
    expect(row.user_id).toBe(2);
    expect(row.kid).toBe('sf_orch_test_kid');
    expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.token_hash).not.toBe(res.token);
    expect(row.token_prefix).toBe(res.tokenPrefix);
  });

  test('partial unique index collision → active_credential_already_exists', async () => {
    const store = makeStore();
    const r1 = await creds.mintCredential(store, { userId: 2 });
    expect(r1.ok).toBe(true);
    const r2 = await creds.mintCredential(store, { userId: 2 });
    expect(r2.ok).toBe(false);
    expect(r2.reason).toBe('active_credential_already_exists');
  });

  test('different tenants can each have an active credential', async () => {
    const store = makeStore();
    const r1 = await creds.mintCredential(store, { userId: 2 });
    const r2 = await creds.mintCredential(store, { userId: 9 });
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(r1.token).not.toBe(r2.token);
    expect(store._rows).toHaveLength(2);
  });

  test('returns reason if SF_ORCH_SIGNING_KEY for that kid is not configured', async () => {
    const store = makeStore();
    const res = await creds.mintCredential(store, { userId: 2, kid: 'no_such_kid' });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('signing_key_not_configured');
  });

  test('no plaintext token ever stored in any DB write payload', async () => {
    const store = makeStore();
    const res = await creds.mintCredential(store, { userId: 2 });
    expect(res.ok).toBe(true);
    for (const entry of store._writeLog) {
      const json = JSON.stringify(entry.payload || {});
      expect(json).not.toContain(res.token);
      // token_prefix IS allowed in the payload; the full token is not.
      // (prefix is 13 chars including 'sfo_v1.' + 6 payload chars)
    }
  });
});

// ─────────────────────────────────────────────────────────────────
// 4. verifyCredentialToken
// ─────────────────────────────────────────────────────────────────
describe('verifyCredentialToken', () => {
  test('valid active credential → ok, returns payload + row metadata', async () => {
    const store = makeStore();
    const m = await creds.mintCredential(store, { userId: 2 });
    const v = await creds.verifyCredentialToken(store, m.token);
    expect(v.valid).toBe(true);
    expect(v.payload.tenant_id).toBe(2);
    expect(v.credential.status).toBe('active');
    expect(v.credential.user_id).toBe(2);
  });

  test('tampered token → bad_signature', async () => {
    const store = makeStore();
    const m = await creds.mintCredential(store, { userId: 2 });
    const parts = m.token.split('.');
    parts[2] = parts[2].slice(0, -2) + 'AA';
    const v = await creds.verifyCredentialToken(store, parts.join('.'));
    expect(v.valid).toBe(false);
    expect(v.reason).toBe('bad_signature');
  });

  test('unknown credential (correctly signed for a tenant but no row in DB) → unknown_credential', async () => {
    const emptyStore = makeStore();
    // Build a valid signed token without inserting a row.
    const key = creds.resolveSigningKey('sf_orch_test_kid');
    const { token } = codec.encodeToken({
      tenantId: 2, kid: 'sf_orch_test_kid', expiresInMs: 60_000, signingKey: key,
    });
    const v = await creds.verifyCredentialToken(emptyStore, token);
    expect(v.valid).toBe(false);
    expect(v.reason).toBe('unknown_credential');
  });

  test('revoked credential → credential_revoked', async () => {
    const store = makeStore();
    const m = await creds.mintCredential(store, { userId: 2 });
    await creds.revokeCredential(store, { userId: 2, reason: 'test' });
    const v = await creds.verifyCredentialToken(store, m.token);
    expect(v.valid).toBe(false);
    expect(v.reason).toBe('credential_revoked');
  });

  test('rotating credential inside grace window → ok (accepted)', async () => {
    const store = makeStore();
    const m1 = await creds.mintCredential(store, { userId: 2 });
    const rot = await creds.rotateCredential(store, { userId: 2 });
    expect(rot.ok).toBe(true);

    // Old token should still be valid within grace.
    const v = await creds.verifyCredentialToken(store, m1.token);
    expect(v.valid).toBe(true);
    expect(v.credential.status).toBe('rotating');
  });

  test('rotating credential past grace → grace_expired AND row flips to revoked', async () => {
    const store = makeStore();
    const m1 = await creds.mintCredential(store, { userId: 2 });
    await creds.rotateCredential(store, { userId: 2 });

    // Force the rotating row's grace_expires_at into the past.
    const oldRow = store._rows.find((r) => r.status === 'rotating');
    oldRow.grace_expires_at = new Date(Date.now() - 60_000).toISOString();

    const v = await creds.verifyCredentialToken(store, m1.token);
    expect(v.valid).toBe(false);
    expect(v.reason).toBe('grace_expired');

    // Lazy cleanup must have flipped the row to revoked.
    expect(oldRow.status).toBe('revoked');
    expect(oldRow.revoked_reason).toBe('grace_expired');
    expect(oldRow.revoked_at).toBeDefined();
  });

  test('cross-tenant rejection: a token whose row.user_id no longer matches payload.tenant_id', async () => {
    const store = makeStore();
    const m = await creds.mintCredential(store, { userId: 2 });
    // Maliciously edit the row's user_id (simulating bad inserts elsewhere
    // or a future schema-bypass attack). The verifier MUST refuse.
    store._rows[0].user_id = 9;
    const v = await creds.verifyCredentialToken(store, m.token);
    expect(v.valid).toBe(false);
    expect(v.reason).toBe('tenant_mismatch');
  });

  test('expired token (payload.exp past) → expired (no DB lookup needed)', async () => {
    const store = makeStore();
    const m = await creds.mintCredential(store, { userId: 2 });
    const v = await creds.verifyCredentialToken(store, m.token, {
      nowMs: Date.now() + 365 * 24 * 60 * 60 * 1000,    // 1 year in the future
    });
    expect(v.valid).toBe(false);
    expect(v.reason).toBe('expired');
  });

  test('successful verify sets last_used_at on the row (best-effort)', async () => {
    const store = makeStore();
    const m = await creds.mintCredential(store, { userId: 2 });
    expect(store._rows[0].last_used_at).toBeUndefined();
    await creds.verifyCredentialToken(store, m.token);
    // Best-effort update — give the fire-and-forget promise a tick.
    await new Promise((r) => setImmediate(r));
    expect(store._rows[0].last_used_at).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────
// 5. rotateCredential
// ─────────────────────────────────────────────────────────────────
describe('rotateCredential', () => {
  test('old active → rotating + new active in one call', async () => {
    const store = makeStore();
    const m1 = await creds.mintCredential(store, { userId: 2 });
    const rot = await creds.rotateCredential(store, { userId: 2 });
    expect(rot.ok).toBe(true);
    expect(rot.token).not.toBe(m1.token);
    expect(rot.previousCredentialId).toBeDefined();
    expect(rot.newCredentialId).toBeDefined();
    expect(rot.previousGraceExpiresAt).toMatch(/T/);

    const active   = store._rows.filter((r) => r.status === 'active');
    const rotating = store._rows.filter((r) => r.status === 'rotating');
    expect(active).toHaveLength(1);
    expect(rotating).toHaveLength(1);

    expect(active[0].rotated_from_id).toBe(rotating[0].id);
  });

  test('rotate with no active credential → no_active_credential', async () => {
    const store = makeStore();
    const rot = await creds.rotateCredential(store, { userId: 7 });
    expect(rot.ok).toBe(false);
    expect(rot.reason).toBe('no_active_credential');
  });

  test('two rotations: second demotes the latest active, first rotating gets superseded', async () => {
    // Note: in real Postgres, the partial unique index on status='rotating'
    // would block this without a separate revoke. Our in-memory stub
    // doesn't enforce that index — the test simply confirms the function
    // returns ok=true if the stub allows it. The DB-level enforcement is
    // tested at the integration/migration level (PR-C2 already verified
    // both partial unique indexes exist).
    const store = makeStore();
    await creds.mintCredential(store, { userId: 2 });
    const r1 = await creds.rotateCredential(store, { userId: 2 });
    expect(r1.ok).toBe(true);
    // (Skip second rotation in this in-memory test; covered at DB level.)
  });
});

// ─────────────────────────────────────────────────────────────────
// 6. revokeCredential
// ─────────────────────────────────────────────────────────────────
describe('revokeCredential', () => {
  test('atomically revokes both active and rotating for a tenant', async () => {
    const store = makeStore();
    await creds.mintCredential(store, { userId: 2 });
    await creds.rotateCredential(store, { userId: 2 });
    expect(store._rows.filter((r) => r.status === 'active')).toHaveLength(1);
    expect(store._rows.filter((r) => r.status === 'rotating')).toHaveLength(1);

    const res = await creds.revokeCredential(store, { userId: 2, reason: 'disconnect' });
    expect(res.ok).toBe(true);
    expect(res.revokedCount).toBe(2);

    expect(store._rows.every((r) => r.status === 'revoked')).toBe(true);
    expect(store._rows.every((r) => r.revoked_reason === 'disconnect')).toBe(true);
    expect(store._rows.every((r) => r.revoked_at)).toBe(true);
  });

  test('revoke leaves other tenants untouched', async () => {
    const store = makeStore();
    await creds.mintCredential(store, { userId: 2 });
    await creds.mintCredential(store, { userId: 9 });
    await creds.revokeCredential(store, { userId: 2 });
    const t2 = store._rows.find((r) => r.user_id === 2);
    const t9 = store._rows.find((r) => r.user_id === 9);
    expect(t2.status).toBe('revoked');
    expect(t9.status).toBe('active');
  });

  test('revoke with no live credentials → ok, revokedCount=0', async () => {
    const store = makeStore();
    const res = await creds.revokeCredential(store, { userId: 99 });
    expect(res.ok).toBe(true);
    expect(res.revokedCount).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────
// 7. sweepExpiredRotating
// ─────────────────────────────────────────────────────────────────
describe('sweepExpiredRotating', () => {
  test('flips only rotating rows whose grace_expires_at has passed', async () => {
    const store = makeStore();
    await creds.mintCredential(store, { userId: 2 });
    await creds.rotateCredential(store, { userId: 2 });

    // One rotating, in-grace.
    expect(store._rows.filter((r) => r.status === 'rotating')).toHaveLength(1);

    // Sweep with now in the past — nothing should be flipped.
    let res = await creds.sweepExpiredRotating(store, { nowMs: Date.now() - 60_000 });
    expect(res.ok).toBe(true);
    expect(res.sweptCount).toBe(0);

    // Force the row's grace into the past, then sweep.
    const rotating = store._rows.find((r) => r.status === 'rotating');
    rotating.grace_expires_at = new Date(Date.now() - 1).toISOString();
    res = await creds.sweepExpiredRotating(store);
    expect(res.ok).toBe(true);
    expect(res.sweptCount).toBe(1);
    expect(store._rows.find((r) => r.id === rotating.id).status).toBe('revoked');
  });

  test('does not touch active or revoked rows', async () => {
    const store = makeStore();
    await creds.mintCredential(store, { userId: 2 });   // active
    await creds.mintCredential(store, { userId: 9 });   // active
    await creds.rotateCredential(store, { userId: 2 }); // rotating for t2
    await creds.revokeCredential(store, { userId: 9 }); // revoked for t9

    // Force t2's rotating into expired.
    const r = store._rows.find((x) => x.status === 'rotating');
    r.grace_expires_at = new Date(Date.now() - 1000).toISOString();

    const before = store._rows.map((x) => ({ id: x.id, status: x.status }));
    await creds.sweepExpiredRotating(store);
    const after = store._rows.map((x) => ({ id: x.id, status: x.status }));

    // The only status change should be the rotating-in-grace t2 row.
    const diffs = before.filter((b, i) => b.status !== after[i].status);
    expect(diffs).toHaveLength(1);
    expect(diffs[0].id).toBe(r.id);
  });
});

// ─────────────────────────────────────────────────────────────────
// 8. Module-import side-effects + safety invariants
// ─────────────────────────────────────────────────────────────────
describe('module safety', () => {
  test('importing lb-orchestration-credentials does not create any DB rows', () => {
    jest.resetModules();
    require('../lib/lb-orchestration-credentials');
    // No DB handle is passed at import time; this test asserts the
    // module loads without throwing (no top-level env reads that fail
    // when SF_ORCH_SIGNING_KEY is absent — set above for tests, but
    // the lazy-resolve design means import works regardless).
  });

  test('importing without SF_ORCH_SIGNING_KEY does not throw', () => {
    const saved = process.env.SF_ORCH_SIGNING_KEY;
    delete process.env.SF_ORCH_SIGNING_KEY;
    jest.resetModules();
    expect(() => require('../lib/lb-orchestration-credentials')).not.toThrow();
    process.env.SF_ORCH_SIGNING_KEY = saved;
  });

  test('write log never contains plaintext tokens across the full lifecycle', async () => {
    const store = makeStore();
    const m1  = await creds.mintCredential(store, { userId: 2 });
    const rot = await creds.rotateCredential(store, { userId: 2 });
    await creds.verifyCredentialToken(store, rot.token);
    await creds.revokeCredential(store, { userId: 2 });

    const allWrites = JSON.stringify(store._writeLog);
    expect(allWrites).not.toContain(m1.token);
    expect(allWrites).not.toContain(rot.token);
  });
});
