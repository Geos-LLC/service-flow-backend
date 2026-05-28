'use strict';

/**
 * S4 primitives: clients + OAuth codes + outbound delivery + event builders + provisioning payload.
 *
 * Unit-level coverage. Handshake + drainer + HTTP routes tested in
 * separate files.
 */

process.env.SF_ORCH_SIGNING_KEY     = Buffer.alloc(32, 0xAB).toString('base64');
process.env.SF_ORCH_SIGNING_KEY_KID = 'sf_orch_test_kid';

const crypto = require('crypto');

const clients = require('../lib/lb-orchestration-clients');
const codes   = require('../lib/lb-orchestration-oauth-codes');
const delivery= require('../lib/lb-orchestration-outbound-delivery');
const events  = require('../lib/lb-orchestration-event-builders');
const payload = require('../lib/lb-orchestration-provisioning-payload');

// ─────────────────────────────────────────────────────────────────
// In-memory supabase stub for clients/codes
// ─────────────────────────────────────────────────────────────────
function makeStore({ clients: clientRows = [], codes: codeRows = [] } = {}) {
  return {
    _clients: clientRows,
    _codes:   codeRows,
    from(table) {
      const filters = [];
      let updatePayload = null;
      let isOp = null; // 'update' | 'insert' | null
      let insertRow = null;
      let selectCols = null;
      const chain = {
        select(cols) { selectCols = cols; return chain; },
        eq(c, v) { filters.push({ col: c, val: v, type: 'eq' }); return chain; },
        is(c, v) { filters.push({ col: c, val: v, type: 'is' }); return chain; },
        update(p) { isOp = 'update'; updatePayload = p; return chain; },
        insert(r) { isOp = 'insert'; insertRow = r; return chain; },
        maybeSingle() { return doExec(true); },
        single()      { return doExec(false); },
        then(onF, onR) { return doExec(true).then(onF, onR); },
      };
      function applyFilters(rows) {
        return rows.filter((r) => filters.every((f) => {
          if (f.type === 'eq') return String(r[f.col]) === String(f.val);
          if (f.type === 'is') {
            // .is(col, null) means "column IS NULL" in PostgREST.
            // Treat undefined as null for the purposes of this stub.
            const v = r[f.col];
            if (f.val === null) return v === null || v === undefined;
            return v === f.val;
          }
          return true;
        }));
      }
      function doExec(maybeSingle) {
        if (table === 'lb_oauth_clients') {
          if (isOp === null || isOp === 'select') {
            const matches = applyFilters(clientRows);
            return Promise.resolve({ data: matches[0] || null, error: null });
          }
        }
        if (table === 'lb_oauth_codes') {
          if (isOp === 'insert') {
            codeRows.push(insertRow);
            return Promise.resolve({ data: null, error: null });
          }
          if (isOp === 'update') {
            const matches = applyFilters(codeRows);
            for (const r of matches) Object.assign(r, updatePayload);
            return Promise.resolve({ data: matches[0] || null, error: null });
          }
          // select
          const matches = applyFilters(codeRows);
          return Promise.resolve({ data: matches[0] || null, error: null });
        }
        return Promise.resolve({ data: null, error: null });
      }
      return chain;
    },
  };
}

// ─────────────────────────────────────────────────────────────────
// 1. clients
// ─────────────────────────────────────────────────────────────────
describe('lb-orchestration-clients', () => {
  const clientRow = {
    client_id: 'leadbridge_staging',
    client_secret_hash: crypto.createHash('sha256').update('test-secret', 'utf8').digest('hex'),
    display_name: 'LeadBridge Staging',
    redirect_uris: ['https://lb-staging.up.railway.app/integrations/sf/callback'],
    redirect_host_suffixes: ['.up.railway.app', '.vercel.app'],
    scopes_allowed: ['lb_orchestration'],
    disabled_at: null,
  };

  test('lookupClient returns row for active client_id', async () => {
    const store = makeStore({ clients: [clientRow] });
    const r = await clients.lookupClient(store, 'leadbridge_staging');
    expect(r).not.toBeNull();
    expect(r.client_id).toBe('leadbridge_staging');
  });

  test('lookupClient returns null for unknown client_id', async () => {
    const store = makeStore({ clients: [clientRow] });
    const r = await clients.lookupClient(store, 'unknown');
    expect(r).toBeNull();
  });

  test('lookupClient returns null when disabled_at set', async () => {
    const disabled = { ...clientRow, disabled_at: new Date().toISOString() };
    const store = makeStore({ clients: [disabled] });
    const r = await clients.lookupClient(store, 'leadbridge_staging');
    expect(r).toBeNull();
  });

  test('verifyClientSecret matches correct secret', () => {
    expect(clients.verifyClientSecret(clientRow, 'test-secret')).toBe(true);
  });
  test('verifyClientSecret rejects wrong secret', () => {
    expect(clients.verifyClientSecret(clientRow, 'wrong')).toBe(false);
  });
  test('verifyClientSecret handles missing inputs', () => {
    expect(clients.verifyClientSecret(null, 'x')).toBe(false);
    expect(clients.verifyClientSecret(clientRow, null)).toBe(false);
    expect(clients.verifyClientSecret(clientRow, '')).toBe(false);
  });

  test('verifyRedirectUri exact-match only', () => {
    expect(clients.verifyRedirectUri(clientRow, clientRow.redirect_uris[0])).toBe(true);
    expect(clients.verifyRedirectUri(clientRow, clientRow.redirect_uris[0] + '/')).toBe(false);
    expect(clients.verifyRedirectUri(clientRow, 'https://evil.example.com/cb')).toBe(false);
  });

  test('verifyWebhookUrl: https + host-suffix match', () => {
    expect(clients.verifyWebhookUrl(clientRow, 'https://lb-staging.up.railway.app/h').ok).toBe(true);
    expect(clients.verifyWebhookUrl(clientRow, 'https://lb.vercel.app/h').ok).toBe(true);
  });

  test('verifyWebhookUrl: rejects non-https', () => {
    const r = clients.verifyWebhookUrl(clientRow, 'http://lb-staging.up.railway.app/h');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('webhook_url_not_https');
  });

  test('verifyWebhookUrl: rejects unparseable url', () => {
    const r = clients.verifyWebhookUrl(clientRow, 'not-a-url');
    expect(r.ok).toBe(false);
  });

  test('verifyWebhookUrl: rejects host outside suffix list', () => {
    const r = clients.verifyWebhookUrl(clientRow, 'https://attacker.com/cb');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('webhook_host_not_allowed');
  });

  test('verifyWebhookSecret: ≥32 base64 bytes', () => {
    const good = Buffer.alloc(32, 0xAA).toString('base64');
    expect(clients.verifyWebhookSecret(good).ok).toBe(true);
    const tooShort = Buffer.alloc(16, 0xAA).toString('base64');
    const r = clients.verifyWebhookSecret(tooShort);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('webhook_secret_too_short');
  });

  test('verifyWebhookSecret: rejects missing or huge', () => {
    expect(clients.verifyWebhookSecret('').ok).toBe(false);
    expect(clients.verifyWebhookSecret(null).ok).toBe(false);
    const huge = Buffer.alloc(96, 0xAA).toString('base64');
    expect(clients.verifyWebhookSecret(huge).ok).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────
// 2. OAuth codes
// ─────────────────────────────────────────────────────────────────
describe('lb-orchestration-oauth-codes', () => {
  test('issueCode + consumeCode round-trip', async () => {
    const store = makeStore({ codes: [] });
    const issued = await codes.issueCode(store, {
      clientId: 'leadbridge_staging',
      redirectUri: 'https://lb.example.com/cb',
      userId: 2, scope: 'lb_orchestration', state: 'csrf-xyz',
    });
    expect(issued.ok).toBe(true);
    expect(issued.code).toMatch(/^sfauth_v1\./);

    const consumed = await codes.consumeCode(store, {
      code: issued.code, clientId: 'leadbridge_staging', redirectUri: 'https://lb.example.com/cb',
    });
    expect(consumed.ok).toBe(true);
    expect(consumed.row.user_id).toBe(2);
    expect(store._codes[0].consumed_at).toBeTruthy();
  });

  test('replay consumeCode → code_already_used', async () => {
    const store = makeStore({ codes: [] });
    const issued = await codes.issueCode(store, {
      clientId: 'c', redirectUri: 'https://lb.example.com/cb', userId: 2,
    });
    await codes.consumeCode(store, { code: issued.code, clientId: 'c', redirectUri: 'https://lb.example.com/cb' });
    const replay = await codes.consumeCode(store, { code: issued.code, clientId: 'c', redirectUri: 'https://lb.example.com/cb' });
    expect(replay.ok).toBe(false);
    expect(replay.reason).toBe('code_already_used');
  });

  test('expired code → code_expired', async () => {
    const store = makeStore({ codes: [{
      code: 'sfauth_v1.AAA', client_id: 'c', redirect_uri: 'r', user_id: 2,
      scope: 'lb_orchestration', state: 'x',
      issued_at: new Date(Date.now() - 600000).toISOString(),
      expires_at: new Date(Date.now() - 60000).toISOString(),
      consumed_at: null,
    }] });
    const consumed = await codes.consumeCode(store, { code: 'sfauth_v1.AAA', clientId: 'c', redirectUri: 'r' });
    expect(consumed.ok).toBe(false);
    expect(consumed.reason).toBe('code_expired');
  });

  test('mismatched client → invalid_client_for_code', async () => {
    const store = makeStore();
    const issued = await codes.issueCode(store, { clientId: 'A', redirectUri: 'r', userId: 2 });
    const consumed = await codes.consumeCode(store, { code: issued.code, clientId: 'B', redirectUri: 'r' });
    expect(consumed.ok).toBe(false);
    expect(consumed.reason).toBe('invalid_client_for_code');
  });

  test('mismatched redirect_uri → redirect_uri_mismatch', async () => {
    const store = makeStore();
    const issued = await codes.issueCode(store, { clientId: 'A', redirectUri: 'r1', userId: 2 });
    const consumed = await codes.consumeCode(store, { code: issued.code, clientId: 'A', redirectUri: 'r2' });
    expect(consumed.ok).toBe(false);
    expect(consumed.reason).toBe('redirect_uri_mismatch');
  });

  test('unknown code → unknown_code', async () => {
    const store = makeStore();
    const r = await codes.consumeCode(store, { code: 'sfauth_v1.NEVER', clientId: 'c', redirectUri: 'r' });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('unknown_code');
  });

  test('attachCredentialToCode updates issued_credential_id', async () => {
    const store = makeStore();
    const issued = await codes.issueCode(store, { clientId: 'A', redirectUri: 'r', userId: 2 });
    await codes.consumeCode(store, { code: issued.code, clientId: 'A', redirectUri: 'r' });
    await codes.attachCredentialToCode(store, issued.code, 173);
    expect(store._codes[0].issued_credential_id).toBe(173);
  });
});

// ─────────────────────────────────────────────────────────────────
// 3. Outbound delivery (signing, jitter, headers)
// ─────────────────────────────────────────────────────────────────
describe('outbound delivery — signing (Option 1: timestamp.body)', () => {
  test('buildCanonicalSigningString concatenates with literal dot', () => {
    const s = delivery.buildCanonicalSigningString('2026-05-28T12:00:00.000Z', '{"x":1}');
    expect(s).toBe('2026-05-28T12:00:00.000Z.{"x":1}');
  });

  test('buildCanonicalSigningString rejects missing timestamp', () => {
    expect(() => delivery.buildCanonicalSigningString('', '{}')).toThrow(/timestamp/);
  });

  test('signWebhookCanonical is deterministic + HMAC-SHA256 hex', () => {
    const a = delivery.signWebhookCanonical('secret', '2026-05-28T12:00:00.000Z', '{"x":1}');
    const b = delivery.signWebhookCanonical('secret', '2026-05-28T12:00:00.000Z', '{"x":1}');
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  test('signWebhookCanonical: timestamp change → different signature (binds timestamp into sig)', () => {
    const a = delivery.signWebhookCanonical('secret', '2026-05-28T12:00:00.000Z', '{"x":1}');
    const b = delivery.signWebhookCanonical('secret', '2026-05-28T12:00:01.000Z', '{"x":1}');
    expect(a).not.toBe(b);
  });

  test('signWebhookCanonical: body change → different signature', () => {
    const a = delivery.signWebhookCanonical('secret', '2026-05-28T12:00:00.000Z', '{"x":1}');
    const b = delivery.signWebhookCanonical('secret', '2026-05-28T12:00:00.000Z', '{"x":2}');
    expect(a).not.toBe(b);
  });

  test('signWebhookCanonical: secret change → different signature', () => {
    const a = delivery.signWebhookCanonical('s1', '2026-05-28T12:00:00.000Z', '{"x":1}');
    const b = delivery.signWebhookCanonical('s2', '2026-05-28T12:00:00.000Z', '{"x":1}');
    expect(a).not.toBe(b);
  });

  test('signWebhookCanonical matches the manual HMAC over `${ts}.${body}`', () => {
    const crypto = require('crypto');
    const ts = '2026-05-28T12:00:00.000Z';
    const body = '{"event_id":"x"}';
    const expected = crypto.createHmac('sha256', 'secret').update(`${ts}.${body}`, 'utf8').digest('hex');
    expect(delivery.signWebhookCanonical('secret', ts, body)).toBe(expected);
  });

  test('buildOutboundHeaders signs `${X-SF-Timestamp}.${body}` (verifies LB-side regen reproduces)', () => {
    const body = '{"event_id":"x"}';
    const h = delivery.buildOutboundHeaders({
      secret:    'shh',
      body,
      eventId:   'x',
      eventType: 'connection.connected',
      tenantId:  42,
      kid:       'k1',
      subscriptionId: 'sub1',
      stateRef:  'sr1',
      now:       new Date('2026-05-28T12:00:00Z'),
    });
    expect(h['X-SF-Signature']).toMatch(/^[0-9a-f]{64}$/);
    expect(h['X-SF-Timestamp']).toBe('2026-05-28T12:00:00.000Z');
    // LB-side reconstruction: take the headers + body verbatim, recompute.
    const expectedSig = delivery.signWebhookCanonical('shh', h['X-SF-Timestamp'], body);
    expect(h['X-SF-Signature']).toBe(expectedSig);
    // Other headers
    expect(h['X-SF-Event-Id']).toBe('x');
    expect(h['X-SF-Event-Type']).toBe('connection.connected');
    expect(h['X-SF-Tenant-Id']).toBe('42');
    expect(h['X-SF-Kid']).toBe('k1');
    expect(h['X-LB-Subscription-Id']).toBe('sub1');
    expect(h['X-LB-State-Ref']).toBe('sr1');
  });

  test('buildOutboundHeaders REJECTS missing args.now (defensive: prevents stale-timestamp regression)', () => {
    const baseArgs = {
      secret: 'shh', body: '{}', eventId: 'x',
      eventType: 'connection.connected', tenantId: 42,
    };
    // No `now` provided — should throw.
    expect(() => delivery.buildOutboundHeaders(baseArgs)).toThrow(/now/);
    // `now` not a Date — should throw.
    expect(() => delivery.buildOutboundHeaders({ ...baseArgs, now: '2026-05-28T12:00:00Z' })).toThrow(/now/);
    // Invalid Date — should throw.
    expect(() => delivery.buildOutboundHeaders({ ...baseArgs, now: new Date('not-a-date') })).toThrow(/now/);
  });

  test('two successive buildOutboundHeaders calls with DIFFERENT `now` produce DIFFERENT timestamp AND DIFFERENT signature', () => {
    const baseArgs = {
      secret: 'shh', body: '{"event_id":"x"}', eventId: 'x',
      eventType: 'connection.connected', tenantId: 42, kid: 'k1',
    };
    const h1 = delivery.buildOutboundHeaders({ ...baseArgs, now: new Date('2026-05-28T12:00:00Z') });
    const h2 = delivery.buildOutboundHeaders({ ...baseArgs, now: new Date('2026-05-28T12:01:00Z') });
    expect(h1['X-SF-Timestamp']).not.toBe(h2['X-SF-Timestamp']);
    expect(h1['X-SF-Signature']).not.toBe(h2['X-SF-Signature']);
    // Each signature still self-reproduces with its own timestamp.
    expect(h1['X-SF-Signature']).toBe(delivery.signWebhookCanonical(baseArgs.secret, h1['X-SF-Timestamp'], baseArgs.body));
    expect(h2['X-SF-Signature']).toBe(delivery.signWebhookCanonical(baseArgs.secret, h2['X-SF-Timestamp'], baseArgs.body));
  });

  test('legacy signWebhookBody export still functional (body-only HMAC, not used by header builder)', () => {
    // Kept until all in-process callers migrate. Asserts the legacy
    // and canonical paths are DIFFERENT — proves header builder uses
    // the new one.
    const body = '{"x":1}';
    const ts = '2026-05-28T12:00:00.000Z';
    const legacy = delivery.signWebhookBody('secret', body);
    const canonical = delivery.signWebhookCanonical('secret', ts, body);
    expect(legacy).not.toBe(canonical);
  });

  test('nextAttemptDelayMs follows base schedule with ±15% jitter (using fixed rng)', () => {
    // rng() returns 0.5 → middle of jitter range → no jitter
    const noJitter = delivery.nextAttemptDelayMs(1, () => 0.5);
    expect(noJitter).toBe(60_000);   // 1 minute exactly
    // rng() returns 0 → -15% jitter
    const low = delivery.nextAttemptDelayMs(1, () => 0);
    expect(low).toBe(60_000 * 0.85);
    // rng() returns 1 → +15% jitter (Math.random returns < 1, but our jitter formula uses random()*2-1)
    const high = delivery.nextAttemptDelayMs(1, () => 0.999999);
    expect(Math.round(high / 1000)).toBeCloseTo(60_000 * 1.15 / 1000, -2);
  });

  test('nextAttemptDelayMs uses correct base for each attempt index', () => {
    // attempts=2 → BASE[1] = 5 min
    expect(delivery.nextAttemptDelayMs(2, () => 0.5)).toBe(5 * 60_000);
    // attempts=3 → BASE[2] = 30 min
    expect(delivery.nextAttemptDelayMs(3, () => 0.5)).toBe(30 * 60_000);
    // Beyond schedule → caps to last
    expect(delivery.nextAttemptDelayMs(99, () => 0.5)).toBe(1440 * 60_000);
  });
});

// ─────────────────────────────────────────────────────────────────
// 4. Event builders
// ─────────────────────────────────────────────────────────────────
describe('event builders', () => {
  test('connection.connected envelope', () => {
    const e = events.buildConnectionConnectedEvent({
      tenantId: 2,
      credential: { credentialId: 173, tokenPrefix: 'sfo_v1.eyJ', kid: 'k1', expiresAt: '2026-08-26T00:00:00Z' },
      connectedAt: '2026-05-28T12:00:00Z',
      webhookSetAt: '2026-05-28T12:00:00Z',
    });
    expect(e.event_id).toBe('evt_connection_connected_2_173');
    expect(e.event_type).toBe('connection.connected');
    expect(e.sf_tenant_id).toBe(2);
    expect(e.source).toBe('service_flow_orchestration');
    expect(e.integration_mode).toBe('orchestration');
    expect(e.data.credential.cred_id).toBe(173);
    expect(e.data.credential.token_prefix).toBe('sfo_v1.eyJ');
  });

  test('credential.rotated envelope', () => {
    const e = events.buildCredentialRotatedEvent({
      tenantId: 2,
      previousCredentialId: 173,
      previousGraceExpiresAt: '2026-05-28T12:05:00Z',
      newCredential: { credentialId: 174, tokenPrefix: 'sfo_v1.eyK', expiresAt: '2026-08-26T00:00:00Z' },
      reason: 'scheduled',
    });
    expect(e.event_id).toBe('evt_credential_rotated_2_174');
    expect(e.event_type).toBe('credential.rotated');
    expect(e.data.previous_cred_id).toBe(173);
    expect(e.data.new_credential.cred_id).toBe(174);
    expect(e.data.reason).toBe('scheduled');
  });

  test('connection.revoked envelope', () => {
    const e = events.buildConnectionRevokedEvent({
      tenantId: 2, actor: 'user', reason: 'user_initiated',
      revokedAtMs: 1748000000000,
    });
    expect(e.event_id).toBe('evt_connection_revoked_2_1748000000');
    expect(e.event_type).toBe('connection.revoked');
    expect(e.data.actor).toBe('user');
    expect(e.data.reason).toBe('user_initiated');
  });

  test('source_instance reads from env when set', () => {
    process.env.SF_SOURCE_INSTANCE = 'sf-staging-test';
    expect(events.sourceInstance()).toBe('sf-staging-test');
    delete process.env.SF_SOURCE_INSTANCE;
  });
});

// ─────────────────────────────────────────────────────────────────
// 5. Provisioning payload
// ─────────────────────────────────────────────────────────────────
describe('provisioning payload', () => {
  test('shape includes all required v1 blocks (refinement 4) + Option 1 signing metadata', () => {
    process.env.SF_SOURCE_INSTANCE = 'sf-test';
    process.env.SF_API_REGION = 'us-east-1';
    const p = payload.buildProvisioningPayload({
      tenant:    { sf_tenant_id: 2, sf_tenant_name: 'Test', sf_workspace_id: 2 },
      credential:{ token: 'sfo_v1.aaa.bbb', token_prefix: 'sfo_v1.aaa', kid: 'k1', scope: 'lb_orchestration', issued_at: 'i', expires_at: 'e' },
      webhook:   { url: 'https://lb/h', set_at: 's', subscription_id: 'sub', state_ref: 'ref' },
      sfBaseUrl: 'https://sf.test',
    });
    expect(p.version).toBe('1');
    expect(p.tenant.sf_tenant_id).toBe(2);
    expect(p.tenant.source_instance).toBe('sf-test');
    expect(p.tenant.api_region).toBe('us-east-1');
    expect(p.tenant.sf_base_url).toBe('https://sf.test');
    expect(p.credential.token).toBe('sfo_v1.aaa.bbb');
    expect(p.credential.scope).toBe('lb_orchestration');
    expect(Array.isArray(p.event_types)).toBe(true);
    expect(p.event_types).toContain('connection.connected');
    expect(p.event_types).toContain('credential.rotated');
    expect(p.event_types).toContain('connection.revoked');
    expect(p.signature_metadata.algorithm).toBe('hmac-sha256-hex');
    // Option 1 signing — timestamp bound into signature
    expect(p.signature_metadata.signed_string_format).toBe('${X-SF-Timestamp}.${raw_body}');
    expect(p.signature_metadata.body_canonical_form).toBe('timestamp_dot_raw_utf8_request_body');
    expect(p.signature_metadata.max_clock_skew_seconds).toBe(300);
    expect(p.webhook.url).toBe('https://lb/h');
    expect(p.webhook.secret_set).toBe(true);
    delete process.env.SF_SOURCE_INSTANCE;
    delete process.env.SF_API_REGION;
  });

  test('never includes plaintext webhook secret value in payload (only secret_set flag)', () => {
    const sentinel = 'SENTINEL_SECRET_DO_NOT_LEAK_ME';
    const p = payload.buildProvisioningPayload({
      tenant:    { sf_tenant_id: 2 },
      credential:{ token: 't', token_prefix: 'tp', kid: 'k', scope: 's', issued_at: 'i', expires_at: 'e' },
      webhook:   { url: 'u', set_at: 's', plaintext_secret_for_test: sentinel },
    });
    const body = JSON.stringify(p);
    // The sentinel (a stand-in for a real secret) must never appear.
    expect(body).not.toContain(sentinel);
    // The only "secret"-named field allowed is the boolean flag.
    expect(body).toMatch(/"secret_set":true/);
    // No other field in the webhook block exposes a value matching the sentinel-shape.
    expect(p.webhook).not.toHaveProperty('secret');
    expect(p.webhook).not.toHaveProperty('plaintext_secret_for_test');
  });
});
