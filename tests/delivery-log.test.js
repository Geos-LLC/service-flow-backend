/**
 * P1.6 (Synchronization Constitution §0 P2 + §9 P1.6) — unified delivery log.
 *
 * Three test layers:
 *   1. Unit tests for lib/delivery-log.js — enum validation, never-throws,
 *      hashing, terminal-status auto-resolved_at, structured log emission.
 *   2. Source-text scan asserting the 3 wired surfaces actually call
 *      logDelivery in P1.6 (notification-email.service.js, LB outbound
 *      drainer, ZB webhook handler) and that the 2 operator endpoints exist.
 *   3. Migration shape check — the table + indexes are correctly declared.
 */

const fs = require('fs');
const path = require('path');

const {
  logDelivery,
  VALID_SYSTEMS,
  VALID_CHANNELS,
  VALID_DIRECTIONS,
  VALID_STATUSES,
  TERMINAL_STATUSES,
  computePayloadHash,
  classifyErrorClass,
} = require('../lib/delivery-log');

const REPO = path.join(__dirname, '..');
const NOTIFICATION_EMAIL = fs.readFileSync(path.join(REPO, 'notification-email.service.js'), 'utf8');
const LB_DRAINER = fs.readFileSync(path.join(REPO, 'workers', 'leadbridge-outbound-drainer.js'), 'utf8');
const ZB_SYNC = fs.readFileSync(path.join(REPO, 'zenbooker-sync.js'), 'utf8');
const SERVER_JS = fs.readFileSync(path.join(REPO, 'server.js'), 'utf8');
const MIGRATION = fs.readFileSync(path.join(REPO, 'migrations', '042_delivery_log.sql'), 'utf8');

// ─── Mock supabase (insert-only chain) ──────────────────────────────

function makeSupabase({ insertError = null } = {}) {
  const inserts = [];
  function chain() {
    let payload = null;
    const builder = {
      insert(p) { payload = p; return builder; },
      select() { return builder; },
      single() {
        inserts.push(payload);
        if (insertError) return Promise.resolve({ data: null, error: insertError });
        return Promise.resolve({ data: { id: inserts.length }, error: null });
      },
    };
    return builder;
  }
  return { from: jest.fn(chain), _inserts: inserts };
}

function makeLogger() {
  const lines = [];
  return {
    lines,
    log: (m) => lines.push(['log', m]),
    warn: (m) => lines.push(['warn', m]),
    error: (m) => lines.push(['error', m]),
  };
}

// ─── Unit: validation ────────────────────────────────────────────────

describe('logDelivery — input validation', () => {
  const validArgs = () => ({
    userId: 2,
    sourceSystem: 'service_flow',
    destinationSystem: 'sendgrid',
    channel: 'email',
    eventType: 'email.invoice',
    deliveryDirection: 'outbound',
    status: 'sent',
  });

  test('happy path inserts one row', async () => {
    const supabase = makeSupabase();
    const r = await logDelivery(supabase, validArgs(), makeLogger());
    expect(r.ok).toBe(true);
    expect(supabase._inserts).toHaveLength(1);
    expect(supabase._inserts[0].user_id).toBe(2);
    expect(supabase._inserts[0].event_type).toBe('email.invoice');
    expect(supabase._inserts[0].status).toBe('sent');
  });

  test('rejects unknown sourceSystem', async () => {
    const r = await logDelivery(makeSupabase(), { ...validArgs(), sourceSystem: 'made_up' }, makeLogger());
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/sourceSystem/);
  });

  test('rejects unknown destinationSystem', async () => {
    const r = await logDelivery(makeSupabase(), { ...validArgs(), destinationSystem: 'unknown' }, makeLogger());
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/destinationSystem/);
  });

  test('rejects unknown channel', async () => {
    const r = await logDelivery(makeSupabase(), { ...validArgs(), channel: 'made_up' }, makeLogger());
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/channel/);
  });

  test('null channel is allowed (for non-channel-shaped events)', async () => {
    const supabase = makeSupabase();
    const r = await logDelivery(supabase, { ...validArgs(), channel: null }, makeLogger());
    expect(r.ok).toBe(true);
    expect(supabase._inserts[0].channel).toBe(null);
  });

  test('rejects unknown direction', async () => {
    const r = await logDelivery(makeSupabase(), { ...validArgs(), deliveryDirection: 'sideways' }, makeLogger());
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/deliveryDirection/);
  });

  test('rejects unknown status', async () => {
    const r = await logDelivery(makeSupabase(), { ...validArgs(), status: 'pending_review' }, makeLogger());
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/status/);
  });

  test('rejects missing eventType', async () => {
    const args = validArgs(); delete args.eventType;
    const r = await logDelivery(makeSupabase(), args, makeLogger());
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/eventType/);
  });
});

// ─── Unit: derived fields ───────────────────────────────────────────

describe('logDelivery — derived fields', () => {
  test('payload_hash auto-computed from payload', async () => {
    const supabase = makeSupabase();
    await logDelivery(supabase, {
      userId: 2, sourceSystem: 'service_flow', destinationSystem: 'leadbridge',
      channel: 'webhook', eventType: 'lb_outbound.x', deliveryDirection: 'outbound',
      status: 'sent', payload: { hello: 'world' },
    }, makeLogger());
    expect(supabase._inserts[0].payload_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test('explicit payloadHash beats payload', async () => {
    const supabase = makeSupabase();
    await logDelivery(supabase, {
      userId: 2, sourceSystem: 'service_flow', destinationSystem: 'leadbridge',
      channel: 'webhook', eventType: 'lb_outbound.x', deliveryDirection: 'outbound',
      status: 'sent', payloadHash: 'explicit-hash', payload: { hello: 'world' },
    }, makeLogger());
    expect(supabase._inserts[0].payload_hash).toBe('explicit-hash');
  });

  test('terminal status auto-fills resolved_at', async () => {
    const supabase = makeSupabase();
    await logDelivery(supabase, {
      userId: 2, sourceSystem: 'service_flow', destinationSystem: 'sendgrid',
      channel: 'email', eventType: 'email.invoice', deliveryDirection: 'outbound',
      status: 'sent',
    }, makeLogger());
    expect(supabase._inserts[0].resolved_at).toBeTruthy();
  });

  test('non-terminal status (queued) does NOT auto-fill resolved_at', async () => {
    const supabase = makeSupabase();
    await logDelivery(supabase, {
      userId: 2, sourceSystem: 'service_flow', destinationSystem: 'leadbridge',
      channel: 'webhook', eventType: 'lb_outbound.x', deliveryDirection: 'outbound',
      status: 'queued',
    }, makeLogger());
    expect(supabase._inserts[0].resolved_at).toBe(null);
  });

  test('error object → error_message + error_class extracted', async () => {
    const supabase = makeSupabase();
    const err = new TypeError('bad fields');
    err.code = 'PGRST116';
    await logDelivery(supabase, {
      userId: 2, sourceSystem: 'service_flow', destinationSystem: 'sendgrid',
      channel: 'email', eventType: 'email.invoice', deliveryDirection: 'outbound',
      status: 'failed', error: err,
    }, makeLogger());
    expect(supabase._inserts[0].error_message).toBe('bad fields');
    expect(supabase._inserts[0].error_class).toBe('PGRST116');
  });

  test('error_message + error_class explicit overrides override the Error fields', async () => {
    const supabase = makeSupabase();
    await logDelivery(supabase, {
      userId: 2, sourceSystem: 'service_flow', destinationSystem: 'sendgrid',
      channel: 'email', eventType: 'email.invoice', deliveryDirection: 'outbound',
      status: 'failed', error: new Error('original'),
      errorMessage: 'overridden', errorClass: 'CustomErrorClass',
    }, makeLogger());
    expect(supabase._inserts[0].error_message).toBe('overridden');
    expect(supabase._inserts[0].error_class).toBe('CustomErrorClass');
  });

  test('error_message is truncated to 1000 chars', async () => {
    const supabase = makeSupabase();
    await logDelivery(supabase, {
      userId: 2, sourceSystem: 'service_flow', destinationSystem: 'sendgrid',
      channel: 'email', eventType: 'email.invoice', deliveryDirection: 'outbound',
      status: 'failed', errorMessage: 'x'.repeat(5000),
    }, makeLogger());
    expect(supabase._inserts[0].error_message).toHaveLength(1000);
  });
});

// ─── Unit: never throws ──────────────────────────────────────────────

describe('logDelivery — observability resilience', () => {
  test('returns ok:false when DB insert fails (no throw)', async () => {
    const supabase = makeSupabase({ insertError: { code: 'PGRST500', message: 'boom' } });
    const logger = makeLogger();
    const r = await logDelivery(supabase, {
      userId: 2, sourceSystem: 'service_flow', destinationSystem: 'sendgrid',
      channel: 'email', eventType: 'email.invoice', deliveryDirection: 'outbound',
      status: 'sent',
    }, logger);
    expect(r.ok).toBe(false);
    expect(r.error).toBe('boom');
    // The Loki anchor still fired BEFORE the DB write.
    expect(logger.lines.find(([_, msg]) => msg.includes('[DeliveryLog]'))).toBeDefined();
  });

  test('survives total supabase crash', async () => {
    const supabase = { from: () => { throw new Error('connection lost'); } };
    const logger = makeLogger();
    const r = await logDelivery(supabase, {
      userId: 2, sourceSystem: 'service_flow', destinationSystem: 'sendgrid',
      channel: 'email', eventType: 'email.invoice', deliveryDirection: 'outbound',
      status: 'sent',
    }, logger);
    expect(r.ok).toBe(false);
    expect(r.error).toBe('connection lost');
    expect(logger.lines.find(([lvl]) => lvl === 'error')).toBeDefined();
  });
});

// ─── Unit: structured log shape ──────────────────────────────────────

describe('logDelivery — [DeliveryLog] Loki anchor', () => {
  test('emits structured line with required fields', async () => {
    const logger = makeLogger();
    await logDelivery(makeSupabase(), {
      userId: 42, sourceSystem: 'service_flow', destinationSystem: 'leadbridge',
      channel: 'webhook', eventType: 'lb_outbound.job.status_changed',
      correlationId: 'evt_123', deliveryDirection: 'outbound',
      status: 'sent', responseCode: 200, latencyMs: 42, retryCount: 1,
    }, logger);
    const line = logger.lines.find(([_, msg]) => msg.includes('[DeliveryLog]'));
    expect(line).toBeDefined();
    const msg = line[1];
    expect(msg).toMatch(/user_id=42/);
    expect(msg).toMatch(/source=service_flow/);
    expect(msg).toMatch(/dest=leadbridge/);
    expect(msg).toMatch(/dir=outbound/);
    expect(msg).toMatch(/channel=webhook/);
    expect(msg).toMatch(/event=lb_outbound\.job\.status_changed/);
    expect(msg).toMatch(/status=sent/);
    expect(msg).toMatch(/code=200/);
    expect(msg).toMatch(/corr=evt_123/);
    expect(msg).toMatch(/latency_ms=42/);
    expect(msg).toMatch(/retry=1/);
  });

  test('failed/rejected/timeout statuses log at warn level', async () => {
    const logger = makeLogger();
    await logDelivery(makeSupabase(), {
      userId: 42, sourceSystem: 'service_flow', destinationSystem: 'leadbridge',
      channel: 'webhook', eventType: 'lb_outbound.x', deliveryDirection: 'outbound',
      status: 'failed',
    }, logger);
    const line = logger.lines.find(([_, msg]) => msg.includes('[DeliveryLog]'));
    expect(line[0]).toBe('warn');
  });

  test('successful statuses log at log level', async () => {
    const logger = makeLogger();
    await logDelivery(makeSupabase(), {
      userId: 42, sourceSystem: 'service_flow', destinationSystem: 'sendgrid',
      channel: 'email', eventType: 'email.invoice', deliveryDirection: 'outbound',
      status: 'sent',
    }, logger);
    const line = logger.lines.find(([_, msg]) => msg.includes('[DeliveryLog]'));
    expect(line[0]).toBe('log');
  });
});

// ─── Unit: helper functions ──────────────────────────────────────────

describe('computePayloadHash', () => {
  test('deterministic across calls', () => {
    expect(computePayloadHash({ a: 1, b: 'x' })).toEqual(computePayloadHash({ a: 1, b: 'x' }));
  });
  test('null → null', () => {
    expect(computePayloadHash(null)).toBe(null);
    expect(computePayloadHash(undefined)).toBe(null);
  });
  test('strings hash directly', () => {
    expect(computePayloadHash('hello')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('classifyErrorClass', () => {
  test('PG error code wins', () => {
    expect(classifyErrorClass({ code: 'PGRST116', message: 'x' })).toBe('PGRST116');
  });
  test('error.name when not Error', () => {
    expect(classifyErrorClass(new TypeError('x'))).toBe('TypeError');
  });
  test('plain Error → "Error"', () => {
    expect(classifyErrorClass(new Error('x'))).toBe('Error');
  });
  test('null → null', () => {
    expect(classifyErrorClass(null)).toBe(null);
  });
});

// ─── Layer 2: source-text scan — wired surfaces ──────────────────────

describe('P1.6 — surfaces wired in this round', () => {
  test('notification-email.service.js imports + calls logDelivery in logSend()', () => {
    expect(NOTIFICATION_EMAIL).toMatch(/require\(['"]\.\/lib\/delivery-log['"]\)/);
    const logSendStart = NOTIFICATION_EMAIL.indexOf('async function logSend');
    expect(logSendStart).toBeGreaterThan(0);
    const block = NOTIFICATION_EMAIL.slice(logSendStart, logSendStart + 3000);
    expect(block).toMatch(/logDelivery\(supabase,/);
    // emailType must be carried through.
    expect(block).toMatch(/eventType:\s*`email\./);
    // direction is outbound (we send email).
    expect(block).toMatch(/deliveryDirection:\s*['"]outbound['"]/);
  });

  test('LB outbound drainer logs every terminal transition', () => {
    expect(LB_DRAINER).toMatch(/require\(['"]\.\.\/lib\/delivery-log['"]\)/);
    expect(LB_DRAINER).toMatch(/function logLine\(supabase,\s*logger,/);
    // logLine body emits logDelivery
    const sigIdx = LB_DRAINER.indexOf('function logLine(supabase, logger,');
    expect(sigIdx).toBeGreaterThan(0);
    const block = LB_DRAINER.slice(sigIdx, sigIdx + 2000);
    expect(block).toMatch(/logDelivery\(supabase,/);
    expect(block).toMatch(/sourceSystem:\s*['"]service_flow['"]/);
    expect(block).toMatch(/destinationSystem:\s*['"]leadbridge['"]/);
    expect(block).toMatch(/deliveryDirection:\s*['"]outbound['"]/);
  });

  test('ZB webhook handler logs inbound deliveries (success + auth-rejected)', () => {
    expect(ZB_SYNC).toMatch(/require\(['"]\.\/lib\/delivery-log['"]\)/);
    const whIdx = ZB_SYNC.indexOf("router.post('/webhook'");
    expect(whIdx).toBeGreaterThan(0);
    const block = ZB_SYNC.slice(whIdx, whIdx + 6000);
    // Auth-rejected path logs
    expect(block).toMatch(/zb_inbound\.auth_rejected/);
    // Per-user processing logs
    expect(block).toMatch(/zb_inbound\.\$\{event\}|zb_inbound\.`/);
    expect(block).toMatch(/sourceSystem:\s*['"]zenbooker['"]/);
    expect(block).toMatch(/destinationSystem:\s*['"]service_flow['"]/);
    expect(block).toMatch(/deliveryDirection:\s*['"]inbound['"]/);
  });
});

// ─── Layer 2: operator endpoints ─────────────────────────────────────

describe('P1.6 — operator endpoints', () => {
  test('admin endpoint declared with authenticateAdmin', () => {
    expect(SERVER_JS).toMatch(/app\.get\(['"]\/api\/admin\/delivery-log['"]\s*,\s*authenticateAdmin/);
  });

  test('tenant endpoint declared with authenticateToken', () => {
    expect(SERVER_JS).toMatch(/app\.get\(['"]\/api\/delivery-log['"]\s*,\s*authenticateToken/);
  });

  test('tenant endpoint forces user_id = req.user.userId (no cross-tenant leak)', () => {
    const idx = SERVER_JS.indexOf("app.get('/api/delivery-log',");
    expect(idx).toBeGreaterThan(0);
    const block = SERVER_JS.slice(idx, idx + 2500);
    expect(block).toMatch(/\.eq\(\s*['"]user_id['"]\s*,\s*userId\s*\)/);
    // And must NOT take a user_id from the query string (the admin endpoint does, this one doesn't).
    const queryUserIdSetSite = block.match(/req\.query\.user_id/);
    expect(queryUserIdSetSite).toBeNull();
  });

  test('both endpoints support correlation_id filter', () => {
    const adminIdx = SERVER_JS.indexOf("app.get('/api/admin/delivery-log',");
    const tenantIdx = SERVER_JS.indexOf("app.get('/api/delivery-log',");
    const adminBlock = SERVER_JS.slice(adminIdx, adminIdx + 2500);
    const tenantBlock = SERVER_JS.slice(tenantIdx, tenantIdx + 2500);
    expect(adminBlock).toMatch(/correlation_id/);
    expect(tenantBlock).toMatch(/correlation_id/);
  });

  test('admin endpoint exposes user_id filter (cross-tenant by design)', () => {
    const idx = SERVER_JS.indexOf("app.get('/api/admin/delivery-log',");
    const block = SERVER_JS.slice(idx, idx + 2500);
    expect(block).toMatch(/req\.query\.user_id/);
  });
});

// ─── Layer 3: migration shape ────────────────────────────────────────

describe('migration 042 — delivery_log schema', () => {
  test('table declares the required columns', () => {
    const REQUIRED = [
      'id', 'user_id', 'source_system', 'destination_system', 'channel',
      'event_type', 'correlation_id', 'request_id', 'payload_hash',
      'delivery_direction', 'status', 'response_code', 'latency_ms',
      'retry_count', 'provider', 'provider_message_id', 'error_message',
      'error_class', 'created_at', 'resolved_at', 'context',
    ];
    for (const col of REQUIRED) {
      if (!new RegExp(`\\b${col}\\b`).test(MIGRATION)) {
        throw new Error(`Migration 042 is missing required column: ${col}`);
      }
    }
  });

  test('partial indexes for tenant + correlation + failure filter', () => {
    expect(MIGRATION).toMatch(/idx_delivery_log_tenant/);
    expect(MIGRATION).toMatch(/idx_delivery_log_correlation[\s\S]{0,200}WHERE correlation_id IS NOT NULL/);
    expect(MIGRATION).toMatch(/idx_delivery_log_failure[\s\S]{0,200}WHERE status IN/);
    expect(MIGRATION).toMatch(/idx_delivery_log_edge/);
    expect(MIGRATION).toMatch(/idx_delivery_log_direction_channel/);
  });
});

// ─── Vocabulary tests ────────────────────────────────────────────────

describe('valid enums are stable + non-empty', () => {
  test('source/destination systems', () => {
    expect(VALID_SYSTEMS).toContain('service_flow');
    expect(VALID_SYSTEMS).toContain('leadbridge');
    expect(VALID_SYSTEMS).toContain('sigcore');
    expect(VALID_SYSTEMS).toContain('zenbooker');
    expect(VALID_SYSTEMS).toContain('sendgrid');
  });

  test('channels', () => {
    expect(VALID_CHANNELS).toContain('email');
    expect(VALID_CHANNELS).toContain('webhook');
    expect(VALID_CHANNELS).toContain('sms');
  });

  test('directions', () => {
    expect(VALID_DIRECTIONS).toEqual(['outbound', 'inbound']);
  });

  test('statuses include all expected terminal + interim values', () => {
    for (const s of ['queued', 'sent', 'delivered', 'failed', 'rejected', 'rate_limited', 'duplicate', 'timeout']) {
      expect(VALID_STATUSES).toContain(s);
    }
  });

  test('terminal statuses are a subset of valid statuses', () => {
    for (const s of TERMINAL_STATUSES) {
      expect(VALID_STATUSES).toContain(s);
    }
    // 'queued' is NOT terminal
    expect(TERMINAL_STATUSES.has('queued')).toBe(false);
  });
});
