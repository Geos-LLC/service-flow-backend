'use strict';

/**
 * S4 — Handshake module + webhook drainer integration tests.
 *
 * Covers:
 *   performHandshake — happy + signing key missing + settings missing + rollback on update failure
 *   performDisconnect — emits connection.revoked BEFORE clearing webhook + atomic teardown
 *   webhook drainer — happy + retry-on-fail + dlq + decrypt failure + idempotency
 */

process.env.SF_ORCH_SIGNING_KEY     = Buffer.alloc(32, 0xAB).toString('base64');
process.env.SF_ORCH_SIGNING_KEY_KID = 'sf_orch_test_kid';
process.env.SF_INTEGRATION_ENC_KEY  = Buffer.alloc(32, 0xCD).toString('base64');
process.env.SF_SOURCE_INSTANCE      = 'sf-staging'; // matches event builders' default

const handshake = require('../lib/lb-orchestration-handshake');
const drainer   = require('../workers/lb-orchestration-webhook-drainer');
const creds     = require('../lib/lb-orchestration-credentials');

const CREDS_TABLE  = 'lb_orchestration_credentials';
const OUTBOX_TABLE = 'lb_orchestration_outbox';
const SETTINGS_TABLE = 'communication_settings';

// ─────────────────────────────────────────────────────────────────
// Store
// ─────────────────────────────────────────────────────────────────
function makeStore({ settings = [], updateError = null } = {}) {
  const rows = {
    [CREDS_TABLE]:  [],
    [OUTBOX_TABLE]: [],
    [SETTINGS_TABLE]: settings,
  };
  let nextCredId = 1;
  let nextOutboxId = 1;

  // Resolve a column reference that may be a JSON path like
  // `payload_json->>source_instance`. Returns the value at that path or
  // the column's direct value.
  function resolveColumn(r, col) {
    if (typeof col === 'string' && col.includes('->>')) {
      const [base, key] = col.split('->>');
      const o = r[base];
      return o && typeof o === 'object' ? o[key] : undefined;
    }
    return r[col];
  }

  function applyFilters(rs, filters) {
    return rs.filter((r) => filters.every((f) => {
      if (f.type === 'eq') return String(resolveColumn(r, f.col)) === String(f.val);
      if (f.type === 'in') return f.vals.map(String).includes(String(resolveColumn(r, f.col)));
      if (f.type === 'lte') {
        const v = resolveColumn(r, f.col);
        const lhs = v ? Date.parse(v) : null;
        return lhs != null && lhs <= Date.parse(f.val);
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
      lte(c, v) { state.filters.push({ type: 'lte', col: c, val: v }); return builder; },
      order()   { return builder; },
      limit(n)  { state.limitN = n; return builder; },
      maybeSingle() { return exec(state).then(maybeSingle); },
      single()      { return exec(state).then(single); },
      then(onF, onR){ return exec(state).then(onF, onR); },
    };
    return builder;
  }

  function exec(state) {
    return new Promise((resolve) => {
      const T = state.table;
      if (T === SETTINGS_TABLE && updateError && state.op === 'update') {
        return resolve({ data: null, error: { message: updateError } });
      }
      if (!rows[T]) rows[T] = [];

      if (state.op === 'insert') {
        if (T === CREDS_TABLE && state.payload.status === 'active') {
          const dup = rows[T].find((r) => r.user_id === state.payload.user_id && r.status === 'active');
          if (dup) return resolve({ data: null, error: { code: '23505', message: 'duplicate' } });
        }
        if (T === OUTBOX_TABLE) {
          const dup = rows[T].find((r) => r.event_id === state.payload.event_id);
          if (dup) return resolve({ data: null, error: { code: '23505', message: 'duplicate event_id' } });
        }
        const id = T === CREDS_TABLE ? nextCredId++ : (T === OUTBOX_TABLE ? nextOutboxId++ : null);
        const newRow = id ? { id, ...state.payload } : { ...state.payload };
        rows[T].push(newRow);
        if (state.selectCols) return resolve({ data: id ? { id } : newRow, error: null });
        return resolve({ data: null, error: null });
      }

      if (state.op === 'update') {
        const matched = applyFilters(rows[T], state.filters);
        for (const r of matched) Object.assign(r, state.payload);
        if (state.selectCols) return resolve({ data: matched.map((r) => ({ ...r })), error: null });
        return resolve({ data: null, error: null });
      }

      // select
      const matched = applyFilters(rows[T], state.filters);
      const limited = state.limitN != null ? matched.slice(0, state.limitN) : matched;
      return resolve({ data: limited.map((r) => ({ ...r })), error: null });
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

  return {
    _rows: rows,
    from(t) { return makeBuilder(t); },
  };
}

const SILENT = { log() {}, warn() {}, error() {}, debug() {} };
const VALID_SECRET = Buffer.alloc(32, 0xAA).toString('base64');

// ─────────────────────────────────────────────────────────────────
// performHandshake
// ─────────────────────────────────────────────────────────────────
describe('performHandshake', () => {
  test('happy path: mints cred + sets enablement + persists webhook + enqueues connection.connected', async () => {
    const store = makeStore({ settings: [{ user_id: 2 }] });
    const r = await handshake.performHandshake(store, {
      userId: 2,
      webhookUrl: 'https://lb.example.com/hook',
      webhookSecret: VALID_SECRET,
      subscriptionId: 'sub-1',
      stateRef: 'sr-1',
      logger: SILENT,
    });
    expect(r.ok).toBe(true);
    expect(r.credential.token).toMatch(/^sfo_v1\./);
    expect(r.credential.tokenPrefix).toBe(r.credential.token.slice(0, 13));
    expect(r.event_id).toMatch(/^evt_connection_connected_2_/);
    expect(r.event_enqueued).toBe(true);

    // Credential row exists, active.
    expect(store._rows[CREDS_TABLE].filter((c) => c.status === 'active')).toHaveLength(1);
    // Settings updated.
    const setting = store._rows[SETTINGS_TABLE][0];
    expect(setting.leadbridge_connected).toBe(true);
    expect(setting.lb_orchestration_enabled_at).toBeTruthy();
    expect(setting.lb_orchestration_webhook_url).toBe('https://lb.example.com/hook');
    expect(setting.lb_orchestration_webhook_secret_enc).toMatch(/^v1:/);   // AES envelope
    expect(setting.lb_orchestration_subscription_id).toBe('sub-1');
    expect(setting.lb_orchestration_state_ref).toBe('sr-1');
    // Outbox row exists with the connection.connected payload.
    expect(store._rows[OUTBOX_TABLE]).toHaveLength(1);
    expect(store._rows[OUTBOX_TABLE][0].event_type).toBe('connection.connected');
  });

  test('signing key missing → preflight failure, no writes', async () => {
    const saved = process.env.SF_ORCH_SIGNING_KEY;
    delete process.env.SF_ORCH_SIGNING_KEY;
    const store = makeStore({ settings: [{ user_id: 2 }] });
    const r = await handshake.performHandshake(store, {
      userId: 2,
      webhookUrl: 'https://lb.example.com/h',
      webhookSecret: VALID_SECRET,
      logger: SILENT,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('signing_key_not_configured');
    expect(store._rows[CREDS_TABLE]).toHaveLength(0);
    process.env.SF_ORCH_SIGNING_KEY = saved;
  });

  test('communication_settings row missing → 404, no credential minted', async () => {
    const store = makeStore({ settings: [] });
    const r = await handshake.performHandshake(store, {
      userId: 2, webhookUrl: 'https://lb.example.com/h', webhookSecret: VALID_SECRET, logger: SILENT,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('communication_settings_not_found');
    expect(store._rows[CREDS_TABLE]).toHaveLength(0);
  });

  test('active credential already exists → already_connected', async () => {
    const store = makeStore({ settings: [{ user_id: 2 }] });
    await creds.mintCredential(store, { userId: 2 });
    const r = await handshake.performHandshake(store, {
      userId: 2, webhookUrl: 'https://lb.example.com/h', webhookSecret: VALID_SECRET, logger: SILENT,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('already_connected');
  });

  test('settings update fails → rollback (credential gets revoked)', async () => {
    const store = makeStore({ settings: [{ user_id: 2 }], updateError: 'simulated db update failure' });
    const r = await handshake.performHandshake(store, {
      userId: 2, webhookUrl: 'https://lb.example.com/h', webhookSecret: VALID_SECRET, logger: SILENT,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('db_error');
    expect(r.step).toBe('settings_update');
    // Credential row should be revoked by rollback.
    const credRows = store._rows[CREDS_TABLE];
    expect(credRows).toHaveLength(1);
    expect(credRows[0].status).toBe('revoked');
    expect(credRows[0].revoked_reason).toBe('handshake_settings_update_failed');
  });

  test('plaintext webhook secret never appears in DB writes', async () => {
    const sentinel = Buffer.from('THIS_IS_THE_PLAINTEXT_SECRET_SENTINEL_32B').toString('base64');
    const store = makeStore({ settings: [{ user_id: 2 }] });
    await handshake.performHandshake(store, {
      userId: 2, webhookUrl: 'https://lb.example.com/h', webhookSecret: sentinel, logger: SILENT,
    });
    // The DB tables should not contain the plaintext secret anywhere.
    const allRows = JSON.stringify(store._rows);
    expect(allRows).not.toContain('THIS_IS_THE_PLAINTEXT_SECRET_SENTINEL');
  });
});

// ─────────────────────────────────────────────────────────────────
// performDisconnect
// ─────────────────────────────────────────────────────────────────
describe('performDisconnect', () => {
  test('emits connection.revoked BEFORE clearing webhook, revokes credentials, clears settings', async () => {
    const store = makeStore({ settings: [{ user_id: 2 }] });
    // First do a handshake to get into the connected state.
    await handshake.performHandshake(store, {
      userId: 2, webhookUrl: 'https://lb.example.com/h', webhookSecret: VALID_SECRET, logger: SILENT,
    });
    expect(store._rows[OUTBOX_TABLE]).toHaveLength(1);
    expect(store._rows[OUTBOX_TABLE][0].event_type).toBe('connection.connected');
    const settingBefore = store._rows[SETTINGS_TABLE][0];
    expect(settingBefore.lb_orchestration_webhook_url).toBeTruthy();
    const snappedWebhookUrl = settingBefore.lb_orchestration_webhook_url;
    const snappedSecretEnc = settingBefore.lb_orchestration_webhook_secret_enc;

    // Now disconnect.
    const r = await handshake.performDisconnect(store, {
      userId: 2, actor: 'user', reason: 'user_initiated', logger: SILENT,
    });
    expect(r.ok).toBe(true);
    expect(r.revoked_count).toBe(1);
    expect(r.event_id).toMatch(/^evt_connection_revoked_2_/);
    expect(r.event_enqueued).toBe(true);

    // connection.revoked outbox row should hold the SNAPSHOT of the webhook + secret.
    const revokedRow = store._rows[OUTBOX_TABLE].find((o) => o.event_type === 'connection.revoked');
    expect(revokedRow).toBeTruthy();
    expect(revokedRow.webhook_url).toBe(snappedWebhookUrl);
    expect(revokedRow.webhook_secret_enc).toBe(snappedSecretEnc);

    // After disconnect: settings cleared.
    const settingAfter = store._rows[SETTINGS_TABLE][0];
    expect(settingAfter.leadbridge_connected).toBe(false);
    expect(settingAfter.lb_orchestration_enabled_at).toBeNull();
    expect(settingAfter.lb_orchestration_webhook_url).toBeNull();
    expect(settingAfter.lb_orchestration_webhook_secret_enc).toBeNull();
    // Credential row revoked.
    expect(store._rows[CREDS_TABLE].every((c) => c.status === 'revoked')).toBe(true);
  });

  test('no webhook configured → no revoked event enqueued, but credentials still revoked', async () => {
    const store = makeStore({ settings: [{ user_id: 2 }] });
    await creds.mintCredential(store, { userId: 2 });
    const r = await handshake.performDisconnect(store, { userId: 2, logger: SILENT });
    expect(r.ok).toBe(true);
    expect(r.event_id).toBeNull();
    expect(r.revoked_count).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────
// webhook drainer
// ─────────────────────────────────────────────────────────────────
describe('webhook drainer', () => {
  test('happy path: delivers + marks sent', async () => {
    const store = makeStore({ settings: [{ user_id: 2 }] });
    await handshake.performHandshake(store, {
      userId: 2, webhookUrl: 'https://lb.example.com/h', webhookSecret: VALID_SECRET, logger: SILENT,
    });
    const deliveries = [];
    const fakeDeliver = async ({ url, headers, body }) => {
      deliveries.push({ url, headers, body });
      return { ok: true, status: 202 };
    };
    const d = drainer.startDrainer({ supabase: store, logger: SILENT, deliver: fakeDeliver, tickMs: 60_000 });
    const res = await d._tickForTest();
    d.stop();
    expect(res.swept).toBe(1);
    expect(res.succeeded).toBe(1);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].url).toBe('https://lb.example.com/h');
    expect(deliveries[0].headers['X-SF-Signature']).toMatch(/^[0-9a-f]{64}$/);
    expect(deliveries[0].headers['X-SF-Event-Type']).toBe('connection.connected');
    expect(deliveries[0].headers['X-SF-Tenant-Id']).toBe('2');
    // Option 1 contract: signature MUST recompute over `${X-SF-Timestamp}.${body}`,
    // not body-only. Decrypt the snapshotted secret + reproduce LB-side.
    const { decryptIntegrationSecret } = require('../services/lb-encryption');
    const { signWebhookCanonical } = require('../lib/lb-orchestration-outbound-delivery');
    const plaintextSecret = decryptIntegrationSecret(store._rows[OUTBOX_TABLE][0].webhook_secret_enc);
    const expectedSig = signWebhookCanonical(plaintextSecret, deliveries[0].headers['X-SF-Timestamp'], deliveries[0].body);
    expect(deliveries[0].headers['X-SF-Signature']).toBe(expectedSig);
    expect(store._rows[OUTBOX_TABLE][0].state).toBe('sent');
    expect(store._rows[OUTBOX_TABLE][0].sent_at).toBeTruthy();
  });

  test('transient failure → retry scheduled with jittered next_attempt_at', async () => {
    const store = makeStore({ settings: [{ user_id: 2 }] });
    await handshake.performHandshake(store, {
      userId: 2, webhookUrl: 'https://lb.example.com/h', webhookSecret: VALID_SECRET, logger: SILENT,
    });
    const failOnce = async () => ({ ok: false, status: 503, transient: true, response_body: 'oops' });
    const d = drainer.startDrainer({ supabase: store, logger: SILENT, deliver: failOnce, tickMs: 60_000, rng: () => 0.5 });
    const res = await d._tickForTest();
    d.stop();
    expect(res.failed).toBe(1);
    const row = store._rows[OUTBOX_TABLE][0];
    expect(row.state).toBe('pending');
    expect(row.attempts).toBe(1);
    expect(row.last_status_code).toBe(503);
    expect(Date.parse(row.next_attempt_at)).toBeGreaterThan(Date.now() + 40_000);   // ~1 minute scheduled
  });

  test('retry regression: attempt 2 produces FRESH X-SF-Timestamp + FRESH X-SF-Signature (not reused from attempt 1)', async () => {
    const store = makeStore({ settings: [{ user_id: 2 }] });
    await handshake.performHandshake(store, {
      userId: 2, webhookUrl: 'https://lb.example.com/h', webhookSecret: VALID_SECRET, logger: SILENT,
    });

    // Capture headers on every delivery attempt.
    const calls = [];
    const failTwice = async ({ headers, body }) => {
      calls.push({ ts: headers['X-SF-Timestamp'], sig: headers['X-SF-Signature'], body });
      return { ok: false, status: 503, transient: true, response_body: 'lb_down' };
    };
    const d = drainer.startDrainer({ supabase: store, logger: SILENT, deliver: failTwice, tickMs: 60_000, rng: () => 0.5 });

    // Tick 1 → attempt 1 fires, fails, retry scheduled at +1m.
    await d._tickForTest();
    expect(calls).toHaveLength(1);
    expect(store._rows[OUTBOX_TABLE][0].attempts).toBe(1);

    // Force the row due immediately so tick 2 picks it up without waiting 1min.
    store._rows[OUTBOX_TABLE][0].next_attempt_at = new Date(0).toISOString();
    // Sleep ≥1.1s so the epoch-second timestamp advances between attempts.
    // (X-SF-Timestamp is now Unix epoch SECONDS — two retries within the
    // same second legitimately produce the same ts, which would not be
    // a regression.)
    await new Promise((r) => setTimeout(r, 1100));

    // Tick 2 → attempt 2 fires with FRESH timestamp + FRESH signature.
    await d._tickForTest();
    d.stop();
    expect(calls).toHaveLength(2);

    // CRITICAL assertions — these are exactly the conditions LB observed
    // failing on in staging. If either is true again, LB rejects with
    // timestamp_drift / bad_signature.
    expect(calls[1].ts).not.toBe(calls[0].ts);   // X-SF-Timestamp regenerated
    expect(calls[1].sig).not.toBe(calls[0].sig);  // X-SF-Signature regenerated
    expect(calls[1].body).toBe(calls[0].body);    // body unchanged (same event)

    // X-SF-Timestamp must be epoch seconds (10-digit string), not ISO 8601.
    expect(calls[0].ts).toMatch(/^\d{10}$/);
    expect(calls[1].ts).toMatch(/^\d{10}$/);

    // Both timestamps must be within 5s of test wall clock (i.e. truly "now-ish").
    const nowSec = Math.floor(Date.now() / 1000);
    expect(Math.abs(nowSec - parseInt(calls[0].ts, 10))).toBeLessThan(5);
    expect(Math.abs(nowSec - parseInt(calls[1].ts, 10))).toBeLessThan(5);

    // Attempt 2's ts must be strictly LATER than attempt 1's (monotonic).
    expect(parseInt(calls[1].ts, 10)).toBeGreaterThan(parseInt(calls[0].ts, 10));
  });

  test('after MAX_ATTEMPTS failures → state=dlq', async () => {
    const store = makeStore({ settings: [{ user_id: 2 }] });
    await handshake.performHandshake(store, {
      userId: 2, webhookUrl: 'https://lb.example.com/h', webhookSecret: VALID_SECRET, logger: SILENT,
    });
    // Pre-set attempts so the next failure exceeds MAX_ATTEMPTS.
    store._rows[OUTBOX_TABLE][0].attempts = 6;   // one short of default max (7)
    store._rows[OUTBOX_TABLE][0].next_attempt_at = new Date(0).toISOString();  // due immediately
    const failer = async () => ({ ok: false, status: 500, transient: true });
    const d = drainer.startDrainer({ supabase: store, logger: SILENT, deliver: failer, tickMs: 60_000, rng: () => 0.5 });
    await d._tickForTest();
    d.stop();
    expect(store._rows[OUTBOX_TABLE][0].state).toBe('dlq');
    expect(store._rows[OUTBOX_TABLE][0].failed_at).toBeTruthy();
  });

  test('no pending rows → tick is no-op', async () => {
    const store = makeStore();
    const fake = async () => { throw new Error('should not be called'); };
    const d = drainer.startDrainer({ supabase: store, logger: SILENT, deliver: fake, tickMs: 60_000 });
    const res = await d._tickForTest();
    d.stop();
    expect(res.swept).toBe(0);
  });

  test('SF_SOURCE_INSTANCE unset → skips claim (fail-closed cross-env guard)', async () => {
    const store = makeStore({ settings: [{ user_id: 2 }] });
    await handshake.performHandshake(store, {
      userId: 2, webhookUrl: 'https://lb.example.com/h', webhookSecret: VALID_SECRET, logger: SILENT,
    });
    expect(store._rows[OUTBOX_TABLE]).toHaveLength(1);
    const saved = process.env.SF_SOURCE_INSTANCE;
    delete process.env.SF_SOURCE_INSTANCE;
    try {
      const fake = async () => { throw new Error('should not be called'); };
      const d = drainer.startDrainer({ supabase: store, logger: SILENT, deliver: fake, tickMs: 60_000 });
      const res = await d._tickForTest();
      d.stop();
      expect(res.swept).toBe(0);
      expect(res.skipped).toBe('source_instance_unset');
      // Row stays pending — not consumed by a misconfigured drainer.
      expect(store._rows[OUTBOX_TABLE][0].state).toBe('pending');
    } finally {
      process.env.SF_SOURCE_INSTANCE = saved;
    }
  });

  test('cross-env outbox row is NOT claimed (shared-Supabase guard)', async () => {
    // Two outbox rows with different source_instance values. Only the
    // one matching SF_SOURCE_INSTANCE (= sf-staging in this test env)
    // should be claimed and delivered.
    const store = makeStore({ settings: [{ user_id: 2 }] });
    await handshake.performHandshake(store, {
      userId: 2, webhookUrl: 'https://lb.example.com/h', webhookSecret: VALID_SECRET, logger: SILENT,
    });
    // Synthesize a prod-instance row directly (mirrors what prod env
    // would have written before this fix).
    store._rows[OUTBOX_TABLE].push({
      id: 999,
      user_id: 7,
      event_id: 'evt_prod_only_event_42',
      event_type: 'connection.connected',
      payload_json: {
        event_id: 'evt_prod_only_event_42',
        event_type: 'connection.connected',
        source_instance: 'sf-prod',
        data: {},
      },
      webhook_url: 'https://lb-prod.example.com/h',
      webhook_secret_enc: store._rows[OUTBOX_TABLE][0].webhook_secret_enc,
      subscription_id: null,
      state_ref: null,
      state: 'pending',
      attempts: 0,
      next_attempt_at: new Date(0).toISOString(),
    });

    const deliveries = [];
    const fakeDeliver = async ({ url }) => { deliveries.push(url); return { ok: true, status: 202 }; };
    const d = drainer.startDrainer({ supabase: store, logger: SILENT, deliver: fakeDeliver, tickMs: 60_000 });
    const res = await d._tickForTest();
    d.stop();

    // Only the sf-staging row delivered. The sf-prod row stays pending.
    expect(res.swept).toBe(1);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toBe('https://lb.example.com/h');
    const prodRow = store._rows[OUTBOX_TABLE].find((r) => r.event_id === 'evt_prod_only_event_42');
    expect(prodRow.state).toBe('pending');
  });

  test('event_id idempotency: re-enqueue is absorbed by UNIQUE index', async () => {
    const store = makeStore({ settings: [{ user_id: 2 }] });
    await handshake.performHandshake(store, {
      userId: 2, webhookUrl: 'https://lb.example.com/h', webhookSecret: VALID_SECRET, logger: SILENT,
    });
    const { enqueueOutbox } = handshake;
    const row = store._rows[OUTBOX_TABLE][0];
    const dup = await enqueueOutbox(store, {
      userId: 2,
      event: { event_id: row.event_id, event_type: row.event_type, sf_tenant_id: 2 },
      webhookUrl: 'https://lb.example.com/h',
      webhookSecretEnc: 'v1:enc',
    });
    expect(dup.ok).toBe(true);
    expect(dup.duplicate).toBe(true);
    expect(store._rows[OUTBOX_TABLE]).toHaveLength(1);   // still only one row
  });

  test('drainer does not log plaintext secret or token across delivery', async () => {
    const store = makeStore({ settings: [{ user_id: 2 }] });
    await handshake.performHandshake(store, {
      userId: 2, webhookUrl: 'https://lb.example.com/h', webhookSecret: VALID_SECRET, logger: SILENT,
    });
    const logs = [];
    const logger = {
      log:   (m) => logs.push(['log',   m]),
      warn:  (m) => logs.push(['warn',  m]),
      error: (m) => logs.push(['error', m]),
    };
    const fakeDeliver = async () => ({ ok: true, status: 200 });
    const d = drainer.startDrainer({ supabase: store, logger, deliver: fakeDeliver, tickMs: 60_000 });
    await d._tickForTest();
    d.stop();
    const allLogs = JSON.stringify(logs);
    expect(allLogs).not.toContain(VALID_SECRET);   // base64 secret never logged
  });
});
