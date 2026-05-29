'use strict';

/**
 * R1B — Credential refresh contract tests.
 *
 * Coverage:
 *   1. markForRotation primitive
 *      - sets needs_refresh_at on active credential
 *      - no_active_credential when none exists
 *      - already_marked when called twice (idempotent return)
 *
 *   2. performRefreshRotation primitive (gated rotation)
 *      - 200 happy path: active + marker → rotated, new plaintext returned
 *      - 409 no_pending_rotation: active + no marker
 *      - 409 already_rotated_this_cycle: bearer is rotating
 *      - 401 credential_revoked: bearer is revoked
 *      - 401 unknown_credential: bearer cred_id doesn't exist
 *      - 401 tenant_mismatch: bearer cred_id belongs to another tenant
 *      - concurrent first-caller-wins (single-flight)
 *
 *   3. performMarkForRotation wrapper (handshake.js)
 *      - sets marker + enqueues credential.rotated event with refresh_required: true
 *      - skips event enqueue if no webhook configured (rotation marker still set)
 *      - idempotent: duplicate event_id collides on UNIQUE index, treated as no-op
 *
 *   4. performRefresh wrapper (handshake.js)
 *      - 410 connection_revoked when communication_settings.leadbridge_connected=false
 *      - propagates inner reasons (no_pending_rotation, etc.)
 *
 *   5. buildCredentialRotationRequiredEvent
 *      - emits credential.rotated event_type with refresh_required: true
 *      - event_id format: evt_credential_rotated_<tenant>_<current_cred_id>
 *      - previous_grace_expires_at: null (rotation hasn't happened yet)
 *
 *   6. Provisioning payload exposes credentials_refresh endpoint
 */

process.env.SF_ORCH_SIGNING_KEY     = Buffer.alloc(32, 0xAB).toString('base64');
process.env.SF_ORCH_SIGNING_KEY_KID = 'sf_orch_test_kid';
process.env.SF_INTEGRATION_ENC_KEY  = Buffer.alloc(32, 0xCD).toString('base64');

const credentials = require('../lib/lb-orchestration-credentials');
const handshake   = require('../lib/lb-orchestration-handshake');
const events      = require('../lib/lb-orchestration-event-builders');
const payload     = require('../lib/lb-orchestration-provisioning-payload');

const CREDS_TABLE  = 'lb_orchestration_credentials';
const OUTBOX_TABLE = 'lb_orchestration_outbox';
const SETTINGS_TABLE = 'communication_settings';
const VALID_SECRET = Buffer.alloc(32, 0xAA).toString('base64');
const SILENT = { log() {}, warn() {}, error() {}, debug() {} };

// ─────────────────────────────────────────────────────────────────
// In-memory supabase stub — supports the chain methods R1B uses,
// including `.is()` (for needs_refresh_at IS NULL) and `.not(col, 'is', value)`.
// ─────────────────────────────────────────────────────────────────
function makeStore({ settings = [] } = {}) {
  const rows = { [CREDS_TABLE]: [], [OUTBOX_TABLE]: [], [SETTINGS_TABLE]: settings };
  let nextCredId = 1;
  let nextOutboxId = 1;

  function applyFilters(rs, filters) {
    return rs.filter((r) => filters.every((f) => {
      if (f.type === 'eq') return String(r[f.col]) === String(f.val);
      if (f.type === 'in') return f.vals.map(String).includes(String(r[f.col]));
      if (f.type === 'is') {
        if (f.val === null) return r[f.col] === null || r[f.col] === undefined;
        return r[f.col] === f.val;
      }
      if (f.type === 'not_is') {
        if (f.val === null) return r[f.col] !== null && r[f.col] !== undefined;
        return r[f.col] !== f.val;
      }
      return true;
    }));
  }

  function makeBuilder(table) {
    const state = { table, op: null, payload: null, filters: [], selectCols: null };
    const builder = {
      _state: state,
      insert(r) { state.op = 'insert'; state.payload = r; return builder; },
      update(p) { state.op = 'update'; state.payload = p; return builder; },
      select(c) { state.selectCols = c || '*'; if (!state.op) state.op = 'select'; return builder; },
      eq(c, v)  { state.filters.push({ type: 'eq', col: c, val: v }); return builder; },
      in(c, v)  { state.filters.push({ type: 'in', col: c, vals: v }); return builder; },
      is(c, v)  { state.filters.push({ type: 'is', col: c, val: v }); return builder; },
      not(c, op, v) {
        if (op === 'is') state.filters.push({ type: 'not_is', col: c, val: v });
        return builder;
      },
      maybeSingle() { return exec(state).then(maybeSingle); },
      single()      { return exec(state).then(single); },
      then(onF, onR){ return exec(state).then(onF, onR); },
    };
    return builder;
  }

  function exec(state) {
    return new Promise((resolve) => {
      if (!rows[state.table]) rows[state.table] = [];

      if (state.op === 'insert') {
        if (state.table === CREDS_TABLE && state.payload.status === 'active') {
          const dup = rows[state.table].find((r) => r.user_id === state.payload.user_id && r.status === 'active');
          if (dup) return resolve({ data: null, error: { code: '23505', message: 'duplicate active' } });
        }
        if (state.table === OUTBOX_TABLE) {
          const dup = rows[state.table].find((r) => r.event_id === state.payload.event_id);
          if (dup) return resolve({ data: null, error: { code: '23505', message: 'duplicate event_id' } });
        }
        const id = state.table === CREDS_TABLE ? nextCredId++
                 : state.table === OUTBOX_TABLE ? nextOutboxId++
                 : null;
        const newRow = id ? { id, ...state.payload } : { ...state.payload };
        rows[state.table].push(newRow);
        if (state.selectCols) return resolve({ data: id ? { id } : newRow, error: null });
        return resolve({ data: null, error: null });
      }

      if (state.op === 'update') {
        const matched = applyFilters(rows[state.table], state.filters);
        for (const r of matched) Object.assign(r, state.payload);
        if (state.selectCols) return resolve({ data: matched.map((r) => ({ ...r })), error: null });
        return resolve({ data: null, error: null });
      }

      const matched = applyFilters(rows[state.table], state.filters);
      return resolve({ data: matched.map((r) => ({ ...r })), error: null });
    });
  }

  function single({ data, error }) {
    if (error) return { data: null, error };
    if (Array.isArray(data)) return data.length === 0
      ? { data: null, error: { code: 'PGRST116' } }
      : { data: data[0], error: null };
    return { data, error: null };
  }
  function maybeSingle({ data, error }) {
    if (error) return { data: null, error };
    if (Array.isArray(data)) return { data: data[0] || null, error: null };
    return { data: data || null, error: null };
  }

  return { _rows: rows, from(t) { return makeBuilder(t); } };
}

// ─────────────────────────────────────────────────────────────────
// 1. markForRotation primitive
// ─────────────────────────────────────────────────────────────────
describe('markForRotation primitive', () => {
  test('sets needs_refresh_at on active credential', async () => {
    const store = makeStore({ settings: [{ user_id: 2 }] });
    await credentials.mintCredential(store, { userId: 2 });
    const r = await credentials.markForRotation(store, { userId: 2 });
    expect(r.ok).toBe(true);
    expect(r.credentialId).toBeDefined();
    expect(r.needsRefreshAt).toMatch(/T/);
    const row = store._rows[CREDS_TABLE].find((c) => c.status === 'active');
    expect(row.needs_refresh_at).toBe(r.needsRefreshAt);
  });

  test('no_active_credential when none exists', async () => {
    const store = makeStore({ settings: [{ user_id: 2 }] });
    const r = await credentials.markForRotation(store, { userId: 2 });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('no_active_credential');
  });

  test('already_marked when called twice (returns existing timestamp)', async () => {
    const store = makeStore({ settings: [{ user_id: 2 }] });
    await credentials.mintCredential(store, { userId: 2 });
    const r1 = await credentials.markForRotation(store, { userId: 2 });
    expect(r1.ok).toBe(true);
    const r2 = await credentials.markForRotation(store, { userId: 2 });
    expect(r2.ok).toBe(false);
    expect(r2.reason).toBe('already_marked');
    expect(r2.credentialId).toBe(r1.credentialId);
    expect(r2.needsRefreshAt).toBe(r1.needsRefreshAt);
  });
});

// ─────────────────────────────────────────────────────────────────
// 2. performRefreshRotation primitive (gated rotation)
// ─────────────────────────────────────────────────────────────────
describe('performRefreshRotation primitive', () => {
  test('happy path: active + marker → rotated, new plaintext returned', async () => {
    const store = makeStore({ settings: [{ user_id: 2 }] });
    const m = await credentials.mintCredential(store, { userId: 2 });
    await credentials.markForRotation(store, { userId: 2 });

    const r = await credentials.performRefreshRotation(store, {
      userId: 2, bearerCredentialId: m.credentialId,
    });
    expect(r.ok).toBe(true);
    expect(r.token).toMatch(/^sfo_v1\./);
    expect(r.newCredentialId).toBeGreaterThan(m.credentialId);
    expect(r.previousCredentialId).toBe(m.credentialId);
    expect(r.previousGraceExpiresAt).toMatch(/T/);

    // Old → rotating, marker cleared. New → active.
    const oldRow = store._rows[CREDS_TABLE].find((c) => c.id === m.credentialId);
    expect(oldRow.status).toBe('rotating');
    expect(oldRow.needs_refresh_at).toBeNull();
    expect(oldRow.grace_expires_at).toBe(r.previousGraceExpiresAt);

    const newRow = store._rows[CREDS_TABLE].find((c) => c.id === r.newCredentialId);
    expect(newRow.status).toBe('active');
    expect(newRow.rotated_from_id).toBe(m.credentialId);
  });

  test('409 no_pending_rotation: active + no marker', async () => {
    const store = makeStore({ settings: [{ user_id: 2 }] });
    const m = await credentials.mintCredential(store, { userId: 2 });
    const r = await credentials.performRefreshRotation(store, {
      userId: 2, bearerCredentialId: m.credentialId,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('no_pending_rotation');
  });

  test('409 already_rotated_this_cycle: bearer is rotating', async () => {
    const store = makeStore({ settings: [{ user_id: 2 }] });
    const m = await credentials.mintCredential(store, { userId: 2 });
    await credentials.markForRotation(store, { userId: 2 });
    // First caller succeeds.
    const first = await credentials.performRefreshRotation(store, {
      userId: 2, bearerCredentialId: m.credentialId,
    });
    expect(first.ok).toBe(true);
    // Second caller with the same (now rotating) bearer → 409.
    const second = await credentials.performRefreshRotation(store, {
      userId: 2, bearerCredentialId: m.credentialId,
    });
    expect(second.ok).toBe(false);
    expect(second.reason).toBe('already_rotated_this_cycle');
  });

  test('401 credential_revoked: bearer is revoked', async () => {
    const store = makeStore({ settings: [{ user_id: 2 }] });
    const m = await credentials.mintCredential(store, { userId: 2 });
    await credentials.revokeCredential(store, { userId: 2, reason: 'test' });
    const r = await credentials.performRefreshRotation(store, {
      userId: 2, bearerCredentialId: m.credentialId,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('credential_revoked');
  });

  test('401 unknown_credential: bearer cred_id does not exist', async () => {
    const store = makeStore({ settings: [{ user_id: 2 }] });
    const r = await credentials.performRefreshRotation(store, {
      userId: 2, bearerCredentialId: 9999,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('unknown_credential');
  });

  test('tenant_mismatch: bearer cred_id belongs to another tenant (defensive)', async () => {
    const store = makeStore({ settings: [{ user_id: 2 }, { user_id: 9 }] });
    const m = await credentials.mintCredential(store, { userId: 9 });
    await credentials.markForRotation(store, { userId: 9 });
    const r = await credentials.performRefreshRotation(store, {
      userId: 2, bearerCredentialId: m.credentialId,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('tenant_mismatch');
  });

  test('first-caller-wins serialization: only one of two concurrent refreshes rotates', async () => {
    const store = makeStore({ settings: [{ user_id: 2 }] });
    const m = await credentials.mintCredential(store, { userId: 2 });
    await credentials.markForRotation(store, { userId: 2 });

    const [a, b] = await Promise.all([
      credentials.performRefreshRotation(store, { userId: 2, bearerCredentialId: m.credentialId }),
      credentials.performRefreshRotation(store, { userId: 2, bearerCredentialId: m.credentialId }),
    ]);
    const successes = [a, b].filter((x) => x.ok);
    const failures  = [a, b].filter((x) => !x.ok);
    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);
    expect(failures[0].reason).toBe('already_rotated_this_cycle');
  });
});

// ─────────────────────────────────────────────────────────────────
// 3. performMarkForRotation wrapper
// ─────────────────────────────────────────────────────────────────
describe('performMarkForRotation wrapper', () => {
  test('sets marker + enqueues credential.rotated event with refresh_required: true', async () => {
    const store = makeStore({ settings: [{ user_id: 2 }] });
    // Pretend we already had a handshake — set webhook fields so the
    // wrapper has something to snapshot.
    store._rows[SETTINGS_TABLE][0].lb_orchestration_webhook_url = 'https://lb.example.com/h';
    store._rows[SETTINGS_TABLE][0].lb_orchestration_webhook_secret_enc = 'v1:fake:fake:fake';
    await credentials.mintCredential(store, { userId: 2 });

    const r = await handshake.performMarkForRotation(store, { userId: 2, reason: 'operator_request', logger: SILENT });
    expect(r.ok).toBe(true);
    expect(r.credentialId).toBeDefined();
    expect(r.needsRefreshAt).toMatch(/T/);
    expect(r.event_id).toMatch(/^evt_credential_rotated_2_\d+_refresh_\d{10}$/);
    expect(r.event_enqueued).toBe(true);

    const outboxRow = store._rows[OUTBOX_TABLE][0];
    expect(outboxRow.event_type).toBe('credential.rotated');
    expect(outboxRow.payload_json.data.refresh_required).toBe(true);
    expect(outboxRow.payload_json.data.previous_grace_expires_at).toBeNull();
    expect(outboxRow.payload_json.data.refresh_endpoint).toBe('/api/integrations/leadbridge/orchestration/credentials/refresh');
  });

  test('no webhook configured → marker still set, no event enqueued', async () => {
    const store = makeStore({ settings: [{ user_id: 2 }] });
    await credentials.mintCredential(store, { userId: 2 });
    const r = await handshake.performMarkForRotation(store, { userId: 2, logger: SILENT });
    expect(r.ok).toBe(true);
    expect(r.event_id).toBeNull();
    expect(r.event_enqueued).toBe(false);
    expect(store._rows[OUTBOX_TABLE]).toHaveLength(0);
    // Marker is set on the credential row.
    expect(store._rows[CREDS_TABLE].find((c) => c.status === 'active').needs_refresh_at).toBeTruthy();
  });

  test('idempotent: second call returns ok=true alreadyMarked=true; duplicate event absorbed by UNIQUE index', async () => {
    const store = makeStore({ settings: [{ user_id: 2 }] });
    store._rows[SETTINGS_TABLE][0].lb_orchestration_webhook_url = 'https://lb.example.com/h';
    store._rows[SETTINGS_TABLE][0].lb_orchestration_webhook_secret_enc = 'v1:fake:fake:fake';
    await credentials.mintCredential(store, { userId: 2 });

    const r1 = await handshake.performMarkForRotation(store, { userId: 2, logger: SILENT });
    expect(r1.ok).toBe(true);
    expect(r1.alreadyMarked).toBe(false);
    expect(store._rows[OUTBOX_TABLE]).toHaveLength(1);

    const r2 = await handshake.performMarkForRotation(store, { userId: 2, logger: SILENT });
    expect(r2.ok).toBe(true);
    expect(r2.alreadyMarked).toBe(true);
    // Same event_id, UNIQUE absorbs → still only 1 outbox row.
    expect(store._rows[OUTBOX_TABLE]).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────
// 4. performRefresh wrapper
// ─────────────────────────────────────────────────────────────────
describe('performRefresh wrapper', () => {
  test('410 connection_revoked when leadbridge_connected=false', async () => {
    const store = makeStore({ settings: [{ user_id: 2, leadbridge_connected: false }] });
    const m = await credentials.mintCredential(store, { userId: 2 });
    const r = await handshake.performRefresh(store, {
      userId: 2, bearerCredentialId: m.credentialId, logger: SILENT,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('connection_revoked');
  });

  test('410 connection_revoked when lb_orchestration_enabled_at is null', async () => {
    const store = makeStore({ settings: [{ user_id: 2, leadbridge_connected: true, lb_orchestration_enabled_at: null }] });
    const m = await credentials.mintCredential(store, { userId: 2 });
    await credentials.markForRotation(store, { userId: 2 });
    const r = await handshake.performRefresh(store, {
      userId: 2, bearerCredentialId: m.credentialId, logger: SILENT,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('connection_revoked');
  });

  test('happy path returns wire-shaped credential + rotation blocks', async () => {
    const store = makeStore({ settings: [{ user_id: 2, leadbridge_connected: true, lb_orchestration_enabled_at: '2026-05-27T00:00:00Z' }] });
    const m = await credentials.mintCredential(store, { userId: 2 });
    await credentials.markForRotation(store, { userId: 2 });
    const r = await handshake.performRefresh(store, {
      userId: 2, bearerCredentialId: m.credentialId, reason: 'rotation_event', logger: SILENT,
    });
    expect(r.ok).toBe(true);
    expect(r.credential.token).toMatch(/^sfo_v1\./);
    expect(r.credential.token_prefix).toBe(r.credential.token.slice(0, 13));
    expect(r.credential.kid).toBe('sf_orch_test_kid');
    expect(r.credential.scope).toBe('lb_orchestration');
    expect(r.credential.issued_at).toMatch(/T/);
    expect(r.credential.expires_at).toMatch(/T/);
    expect(r.rotation.previous_credential_id).toBe(m.credentialId);
    expect(r.rotation.previous_grace_expires_at).toMatch(/T/);
    expect(r.rotation.reason).toBe('rotation_event');
  });

  test('propagates inner reasons (no_pending_rotation)', async () => {
    const store = makeStore({ settings: [{ user_id: 2, leadbridge_connected: true, lb_orchestration_enabled_at: '2026-05-27T00:00:00Z' }] });
    const m = await credentials.mintCredential(store, { userId: 2 });
    // No markForRotation call.
    const r = await handshake.performRefresh(store, {
      userId: 2, bearerCredentialId: m.credentialId, logger: SILENT,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('no_pending_rotation');
  });

  test('plaintext token never appears in DB writes', async () => {
    const store = makeStore({ settings: [{ user_id: 2, leadbridge_connected: true, lb_orchestration_enabled_at: '2026-05-27T00:00:00Z' }] });
    const m = await credentials.mintCredential(store, { userId: 2 });
    await credentials.markForRotation(store, { userId: 2 });
    const r = await handshake.performRefresh(store, {
      userId: 2, bearerCredentialId: m.credentialId, logger: SILENT,
    });
    expect(r.ok).toBe(true);
    const dbJson = JSON.stringify(store._rows[CREDS_TABLE]);
    expect(dbJson).not.toContain(r.credential.token);
  });
});

// ─────────────────────────────────────────────────────────────────
// 5. buildCredentialRotationRequiredEvent
// ─────────────────────────────────────────────────────────────────
describe('buildCredentialRotationRequiredEvent', () => {
  test('envelope shape + refresh_required flag + event_id format', () => {
    const e = events.buildCredentialRotationRequiredEvent({
      tenantId: 2, currentCredentialId: 173, reason: 'operator_request',
      tsSeconds: 1780011918,                                   // injectable for determinism
    });
    expect(e.event_id).toBe('evt_credential_rotated_2_173_refresh_1780011918');
    expect(e.event_type).toBe('credential.rotated');
    expect(e.sf_tenant_id).toBe(2);
    expect(e.source).toBe('service_flow_orchestration');
    expect(e.data.refresh_required).toBe(true);
    expect(e.data.previous_cred_id).toBe(173);
    expect(e.data.previous_grace_expires_at).toBeNull();
    expect(e.data.reason).toBe('operator_request');
    expect(e.data.refresh_endpoint).toBe('/api/integrations/leadbridge/orchestration/credentials/refresh');
  });

  test('event_id default ts uses current epoch seconds', () => {
    const before = Math.floor(Date.now() / 1000);
    const e = events.buildCredentialRotationRequiredEvent({
      tenantId: 2, currentCredentialId: 173,
    });
    const after = Math.floor(Date.now() / 1000);
    expect(e.event_id).toMatch(/^evt_credential_rotated_2_173_refresh_\d{10}$/);
    const tsInId = parseInt(e.event_id.split('_').pop(), 10);
    expect(tsInId).toBeGreaterThanOrEqual(before);
    expect(tsInId).toBeLessThanOrEqual(after);
  });

  test('two consecutive calls with different tsSeconds produce different event_ids', () => {
    const e1 = events.buildCredentialRotationRequiredEvent({
      tenantId: 2, currentCredentialId: 173, tsSeconds: 1780011918,
    });
    const e2 = events.buildCredentialRotationRequiredEvent({
      tenantId: 2, currentCredentialId: 173, tsSeconds: 1780011919,
    });
    expect(e1.event_id).not.toBe(e2.event_id);
  });

  test('throws on missing required fields', () => {
    expect(() => events.buildCredentialRotationRequiredEvent({ tenantId: 2 })).toThrow();
    expect(() => events.buildCredentialRotationRequiredEvent({ currentCredentialId: 1 })).toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────
// 6. Provisioning payload exposes credentials_refresh
// ─────────────────────────────────────────────────────────────────
describe('provisioning payload — R1B endpoint', () => {
  test('endpoints block includes credentials_refresh', () => {
    const p = payload.buildProvisioningPayload({
      tenant:    { sf_tenant_id: 2 },
      credential:{ token: 't', token_prefix: 'tp', kid: 'k', scope: 'lb_orchestration', issued_at: 'i', expires_at: 'e' },
      webhook:   { url: 'u', set_at: 's' },
    });
    expect(p.endpoints.credentials_refresh).toBe('/api/integrations/leadbridge/orchestration/credentials/refresh');
    // Other endpoints still present
    expect(p.endpoints.availability).toBeTruthy();
    expect(p.endpoints.booking_request).toBeTruthy();
    expect(p.endpoints.disconnect).toBeTruthy();
  });
});
