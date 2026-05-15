/**
 * P1.5 (Synchronization Constitution §1.6 / §7.2 #9) — sgMail single-writer.
 *
 * The constitution forbids inline `sgMail.send()` calls outside
 * `notification-email.service.js`. This test is the enforcement mechanism:
 * once it ships, any new PR that adds an inline send fails CI.
 *
 * Allowed call sites:
 *   - notification-email.service.js (the canonical service)
 *
 * Out of scope (kept dormant per memory; not mounted in server.js):
 *   - email-service.js — legacy Communications-Hub email; descoped April 2026.
 */

const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');

// Files to scan
const SCAN_GLOB = [
  'server.js',
  'zenbooker-sync.js',
  'leadbridge-service.js',
  'whatsapp-service.js',
  'job-expense-service.js',
  'paystub-service.js',
  'job-notifications.service.js',
];

const ALLOWED_FILES = new Set([
  'notification-email.service.js',
  // email-service.js is dormant (not mounted); allow but don't introduce new
  // sends. Listed here so a regex match doesn't fail the build.
  'email-service.js',
]);

function readFileIfExists(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}

describe('P1.5 — no inline sgMail.send() outside notification-email.service.js', () => {
  test('server.js has zero sgMail.send() calls', () => {
    const src = readFileIfExists(path.join(REPO, 'server.js'));
    expect(src).not.toBeNull();
    // Match `sgMail.send(` (the actual call, not the substring inside comments).
    // A comment match is allowed; assert only on lines that don't start with `//` or `*`.
    const lines = src.split('\n');
    const offending = [];
    lines.forEach((line, idx) => {
      const trimmed = line.trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('*')) return;
      if (/\bsgMail\.send\s*\(/.test(line)) {
        offending.push(`server.js:${idx + 1}: ${line.trim()}`);
      }
    });
    if (offending.length > 0) {
      throw new Error(
        `Inline sgMail.send() forbidden in server.js (Constitution §1.6). Use notificationEmail.sendCustomerEmail / sendInternalEmail / sendAdminTestEmail instead.\n`
        + offending.join('\n')
      );
    }
  });

  test('server.js does not require @sendgrid/mail directly', () => {
    const src = readFileIfExists(path.join(REPO, 'server.js'));
    const lines = src.split('\n');
    const offending = [];
    lines.forEach((line, idx) => {
      const trimmed = line.trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('*')) return;
      if (/require\(\s*['"]@sendgrid\/mail['"]\s*\)/.test(line)) {
        offending.push(`server.js:${idx + 1}: ${line.trim()}`);
      }
    });
    if (offending.length > 0) {
      throw new Error(
        `Direct @sendgrid/mail require forbidden in server.js. Route through notification-email.service.js.\n`
        + offending.join('\n')
      );
    }
  });

  test('no other modules (besides allowed) call sgMail.send()', () => {
    const offending = [];
    for (const fname of SCAN_GLOB) {
      if (ALLOWED_FILES.has(fname)) continue;
      const src = readFileIfExists(path.join(REPO, fname));
      if (!src) continue;
      const lines = src.split('\n');
      lines.forEach((line, idx) => {
        const trimmed = line.trim();
        if (trimmed.startsWith('//') || trimmed.startsWith('*')) return;
        if (/\bsgMail\.send\s*\(/.test(line)) {
          offending.push(`${fname}:${idx + 1}: ${trimmed}`);
        }
      });
    }
    if (offending.length > 0) {
      throw new Error(
        `Inline sgMail.send() found outside notification-email.service.js (Constitution §1.6):\n`
        + offending.join('\n')
      );
    }
  });

  test('notification-email.service.js still exports the canonical methods', () => {
    const src = readFileIfExists(path.join(REPO, 'notification-email.service.js'));
    expect(src).not.toBeNull();
    expect(src).toMatch(/router\.sendCustomerEmail\s*=\s*sendCustomerEmail/);
    expect(src).toMatch(/router\.sendInternalEmail\s*=\s*sendInternalEmail/);
    expect(src).toMatch(/router\.sendTestEmail\s*=\s*sendTestEmail/);
    expect(src).toMatch(/router\.sendAdminTestEmail\s*=\s*sendAdminTestEmail/);
  });

  test('sendInternalEmail accepts bypassToggle option for security emails', () => {
    const src = readFileIfExists(path.join(REPO, 'notification-email.service.js'));
    // The parameter must be in the destructured opts.
    expect(src).toMatch(/sendInternalEmail\([\s\S]{0,200}bypassToggle/);
    // And the toggle check honors it.
    expect(src).toMatch(/!bypassToggle\s*&&\s*settings\s*&&\s*!settings\.use_for_internal_notifications/);
  });

  test('sendAdminTestEmail is defined and uses platform_settings', () => {
    const src = readFileIfExists(path.join(REPO, 'notification-email.service.js'));
    expect(src).toMatch(/async function sendAdminTestEmail\s*\(\s*testEmail\s*\)/);
    expect(src).toMatch(/getPlatformSetting\(\s*['"]sendgrid_api_key['"]/);
  });
});

describe('P1.5 — migrated call sites carry emailType + userId', () => {
  // Every notificationEmail.sendCustomerEmail / sendInternalEmail call in
  // server.js must include emailType (REQUIRED per service contract) and pass
  // a userId as the first arg.
  const SERVER_JS = readFileIfExists(path.join(REPO, 'server.js'));

  // Windowed scan instead of regex-matching the full call body — template
  // literals with ${...} expansions defeat balanced-brace regex.
  function findCallSites(needle) {
    const sites = [];
    let i = 0;
    while (true) {
      const idx = SERVER_JS.indexOf(needle, i);
      if (idx === -1) break;
      sites.push(idx);
      i = idx + needle.length;
    }
    return sites;
  }

  test('every notificationEmail.sendCustomerEmail call carries emailType + userId first arg', () => {
    const sites = findCallSites('notificationEmail.sendCustomerEmail(');
    expect(sites.length).toBeGreaterThanOrEqual(5);
    for (const idx of sites) {
      const window = SERVER_JS.slice(idx, idx + 2500); // generous window for big HTML bodies
      const firstParen = window.indexOf('(');
      const firstComma = window.indexOf(',', firstParen);
      const userIdArg = window.slice(firstParen + 1, firstComma).trim();
      if (!userIdArg) {
        throw new Error(`sendCustomerEmail call missing userId at offset ${idx}`);
      }
      if (!/emailType\s*:/.test(window)) {
        throw new Error(`sendCustomerEmail call missing emailType at offset ${idx}:\n${window.slice(0, 400)}`);
      }
    }
  });

  test('every notificationEmail.sendInternalEmail call carries emailType', () => {
    const sites = findCallSites('notificationEmail.sendInternalEmail(');
    expect(sites.length).toBeGreaterThanOrEqual(2);
    for (const idx of sites) {
      const window = SERVER_JS.slice(idx, idx + 2500);
      if (!/emailType\s*:/.test(window)) {
        throw new Error(`sendInternalEmail call missing emailType at offset ${idx}:\n${window.slice(0, 400)}`);
      }
    }
  });

  test('password reset paths use bypassToggle:true (security email)', () => {
    // The team-member reset endpoint + sendResetEmail both send security
    // emails that must deliver even if the tenant disabled internal email.
    expect(SERVER_JS).toMatch(/bypassToggle:\s*true/);
  });

  test('admin test-sendgrid endpoint routes through sendAdminTestEmail', () => {
    const idx = SERVER_JS.indexOf("/api/admin/test-sendgrid");
    expect(idx).toBeGreaterThan(0);
    const block = SERVER_JS.slice(idx, idx + 1500);
    expect(block).toMatch(/notificationEmail\.sendAdminTestEmail/);
    // And does NOT raw-send.
    expect(block).not.toMatch(/sgMail\.send\(/);
  });
});

// ─── Unit-level coverage of the new service options ───────────────────

describe('notification-email.service.js — sendAdminTestEmail unit', () => {
  // Stub @sendgrid/mail so we can verify the service composes the right
  // message and propagates errors without hitting the network.
  let lastSent = null;
  let mockReject = null;
  jest.doMock('@sendgrid/mail', () => ({
    setApiKey: () => {},
    send: async (msg) => {
      lastSent = msg;
      if (mockReject) throw mockReject;
      return [{ headers: { 'x-message-id': 'test-msg-id-1' } }];
    },
  }));
  // Re-require after the mock is in place.
  const buildService = require('../notification-email.service.js');

  // Minimal supabase mock that returns platform_settings rows.
  function makeSupabase(platformSettings = {}) {
    return {
      from(table) {
        const filters = [];
        const builder = {
          select() { return builder; },
          eq(col, val) { filters.push({ col, val }); return builder; },
          maybeSingle() {
            const filter = filters.find(f => f.col === 'key');
            const val = filter && platformSettings[filter.val];
            return Promise.resolve({ data: val ? { value: val } : null, error: null });
          },
        };
        return builder;
      },
    };
  }

  const makeLogger = () => ({ log: jest.fn(), warn: jest.fn(), error: jest.fn() });

  beforeEach(() => { lastSent = null; mockReject = null; });

  test('sends with platform from + DB-stored api key', async () => {
    const supabase = makeSupabase({
      sendgrid_api_key: 'SG.test_key',
      sendgrid_from_email: 'alerts@service-flow.pro',
    });
    const router = buildService(supabase, makeLogger());
    const r = await router.sendAdminTestEmail('owner@example.com');
    expect(r.status).toBe('sent');
    expect(r.messageId).toBe('test-msg-id-1');
    expect(r.fromEmail).toBe('alerts@service-flow.pro');
    expect(lastSent.to).toBe('owner@example.com');
    expect(lastSent.from).toBe('alerts@service-flow.pro');
    expect(lastSent.subject).toMatch(/SendGrid Test/);
  });

  test('rejects when no testEmail', async () => {
    const supabase = makeSupabase({ sendgrid_api_key: 'k' });
    const router = buildService(supabase, makeLogger());
    await expect(router.sendAdminTestEmail()).rejects.toThrow(/Test email address/);
  });

  test('rejects when no API key in platform_settings or env', async () => {
    const supabase = makeSupabase({}); // empty platform_settings
    const orig = process.env.SENDGRID_API_KEY;
    delete process.env.SENDGRID_API_KEY;
    const router = buildService(supabase, makeLogger());
    await expect(router.sendAdminTestEmail('x@y.com')).rejects.toThrow(/SendGrid API key not configured/);
    if (orig !== undefined) process.env.SENDGRID_API_KEY = orig;
  });

  test('propagates send errors (no silent swallow)', async () => {
    mockReject = new Error('SendGrid 401 unauthorized');
    const supabase = makeSupabase({ sendgrid_api_key: 'SG.bad' });
    const logger = makeLogger();
    const router = buildService(supabase, logger);
    await expect(router.sendAdminTestEmail('x@y.com')).rejects.toThrow(/SendGrid 401/);
    expect(logger.error).toHaveBeenCalled();
  });
});
