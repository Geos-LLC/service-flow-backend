/**
 * P1.4 (Synchronization Constitution §0 P3 / §6.10) — tenant-scoped
 * WhatsApp status change.
 *
 * Two test layers:
 *   1. Unit tests against lib/whatsapp-status-tenant-resolver.js pinning every
 *      resolution path + every reject path.
 *   2. Source-text scan against server.js asserting:
 *        - the old global-scan pattern is gone
 *        - the new resolver is wired
 *        - verifiedUserId is plumbed from outer webhook → handler
 *        - structured audit logs fire on every drop outcome
 */

const fs = require('fs');
const path = require('path');

const { resolveWhatsAppStatusTenant } = require('../lib/whatsapp-status-tenant-resolver');

const SERVER_JS = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

// ─── Minimal supabase chain that supports SELECT with eq+limit+maybeSingle ──

function makeSupabase({ rows = [] } = {}) {
  // rows: array of plain objects representing communication_settings.
  function chain() {
    const filters = [];
    let limit = null;
    const builder = {
      select() { return builder; },
      eq(col, val) { filters.push({ col, val }); return builder; },
      limit(n) { limit = n; return builder; },
      maybeSingle() {
        const matched = rows.filter(r => filters.every(f => r[f.col] === f.val));
        return Promise.resolve({ data: matched[0] || null, error: null });
      },
      then(resolve) {
        const matched = rows.filter(r => filters.every(f => r[f.col] === f.val));
        const sliced = limit ? matched.slice(0, limit) : matched;
        return resolve({ data: sliced, error: null });
      },
    };
    return builder;
  }
  return { from: jest.fn(chain) };
}

// ─── Layer 1: pure resolver unit tests ───────────────────────────────

describe('resolveWhatsAppStatusTenant — HMAC path (Step 1)', () => {
  test('HMAC userId alone (no phone) → ok with hmac path', async () => {
    const supabase = makeSupabase();
    const r = await resolveWhatsAppStatusTenant(supabase, {
      verifiedUserId: 42, phoneNumber: null,
    });
    expect(r).toEqual({ ok: true, userId: 42, resolutionPath: 'hmac' });
  });

  test('HMAC userId + matching phone-claim → ok', async () => {
    const supabase = makeSupabase({
      rows: [{ user_id: 42, whatsapp_phone_number: '+15555550100' }],
    });
    const r = await resolveWhatsAppStatusTenant(supabase, {
      verifiedUserId: 42, phoneNumber: '+15555550100',
    });
    expect(r.ok).toBe(true);
    expect(r.userId).toBe(42);
  });

  test('HMAC userId mismatch with phone-claim → cross_tenant_mismatch', async () => {
    const supabase = makeSupabase({
      rows: [{ user_id: 99, whatsapp_phone_number: '+15555550100' }],
    });
    const r = await resolveWhatsAppStatusTenant(supabase, {
      verifiedUserId: 42, phoneNumber: '+15555550100',
    });
    expect(r.ok).toBe(false);
    expect(r.outcome).toBe('drop_cross_tenant_mismatch');
    expect(r.hmac_user_id).toBe(42);
    expect(r.phone_owner_user_id).toBe(99);
  });

  test('HMAC userId + phone unclaimed by anyone → ok (initial connect)', async () => {
    const supabase = makeSupabase({ rows: [] });
    const r = await resolveWhatsAppStatusTenant(supabase, {
      verifiedUserId: 42, phoneNumber: '+15555550100',
    });
    expect(r.ok).toBe(true);
    expect(r.userId).toBe(42);
    expect(r.resolutionPath).toBe('hmac');
  });
});

describe('resolveWhatsAppStatusTenant — routing fallback (Step 2)', () => {
  test('no HMAC, route resolves to userId → ok with route:<step>', async () => {
    const supabase = makeSupabase({ rows: [] });
    const resolveEndpointRoute = jest.fn(async ({ phoneNumber }) => ({
      routed: true, userId: 77, step: 'D',
    }));
    const r = await resolveWhatsAppStatusTenant(supabase, {
      verifiedUserId: null, phoneNumber: '+15555550101', resolveEndpointRoute,
    });
    expect(r.ok).toBe(true);
    expect(r.userId).toBe(77);
    expect(r.resolutionPath).toBe('route:D');
    expect(resolveEndpointRoute).toHaveBeenCalledWith({
      provider: 'whatsapp',
      phoneNumber: '+15555550101',
      channel: 'whatsapp',
      endpointId: 'wa_+15555550101',
    });
  });

  test('no HMAC, route fails → fall through to phone-claim', async () => {
    const supabase = makeSupabase({
      rows: [{ user_id: 77, whatsapp_phone_number: '+15555550102' }],
    });
    const resolveEndpointRoute = jest.fn(async () => ({ routed: false }));
    const r = await resolveWhatsAppStatusTenant(supabase, {
      verifiedUserId: null, phoneNumber: '+15555550102', resolveEndpointRoute,
    });
    expect(r.ok).toBe(true);
    expect(r.resolutionPath).toBe('phone_claim');
    expect(r.userId).toBe(77);
  });

  test('no resolveEndpointRoute function provided → skip step 2 cleanly', async () => {
    const supabase = makeSupabase({
      rows: [{ user_id: 77, whatsapp_phone_number: '+15555550103' }],
    });
    const r = await resolveWhatsAppStatusTenant(supabase, {
      verifiedUserId: null, phoneNumber: '+15555550103',
    });
    expect(r.ok).toBe(true);
    expect(r.resolutionPath).toBe('phone_claim');
  });
});

describe('resolveWhatsAppStatusTenant — phone-claim fallback (Step 3)', () => {
  test('exactly one tenant claims the phone → ok with phone_claim', async () => {
    const supabase = makeSupabase({
      rows: [{ user_id: 5, whatsapp_phone_number: '+15555550200' }],
    });
    const r = await resolveWhatsAppStatusTenant(supabase, {
      verifiedUserId: null, phoneNumber: '+15555550200',
    });
    expect(r.ok).toBe(true);
    expect(r.userId).toBe(5);
    expect(r.resolutionPath).toBe('phone_claim');
  });

  test('same phone in two tenants → drop_phone_claim_ambiguous', async () => {
    const supabase = makeSupabase({
      rows: [
        { user_id: 5, whatsapp_phone_number: '+15555550201' },
        { user_id: 6, whatsapp_phone_number: '+15555550201' },
      ],
    });
    const r = await resolveWhatsAppStatusTenant(supabase, {
      verifiedUserId: null, phoneNumber: '+15555550201',
    });
    expect(r.ok).toBe(false);
    expect(r.outcome).toBe('drop_phone_claim_ambiguous');
    expect(r.matched_count).toBe(2);
  });

  test('phone unclaimed and no HMAC and no route → drop_no_tenant', async () => {
    const supabase = makeSupabase({ rows: [] });
    const resolveEndpointRoute = jest.fn(async () => ({ routed: false }));
    const r = await resolveWhatsAppStatusTenant(supabase, {
      verifiedUserId: null, phoneNumber: '+15555550202', resolveEndpointRoute,
    });
    expect(r.ok).toBe(false);
    expect(r.outcome).toBe('drop_no_tenant');
    expect(r.reason).toBe('phone_not_claimed_and_unrouted');
  });

  test('no phone AND no HMAC → drop_no_tenant', async () => {
    const supabase = makeSupabase();
    const r = await resolveWhatsAppStatusTenant(supabase, {
      verifiedUserId: null, phoneNumber: null,
    });
    expect(r.ok).toBe(false);
    expect(r.outcome).toBe('drop_no_tenant');
    expect(r.reason).toBe('no_phone_and_no_hmac');
  });
});

describe('resolveWhatsAppStatusTenant — resolution priority', () => {
  test('HMAC wins over phone-claim when they agree', async () => {
    const supabase = makeSupabase({
      rows: [{ user_id: 42, whatsapp_phone_number: '+15555550300' }],
    });
    const r = await resolveWhatsAppStatusTenant(supabase, {
      verifiedUserId: 42, phoneNumber: '+15555550300',
    });
    expect(r.resolutionPath).toBe('hmac'); // not 'phone_claim'
  });

  test('HMAC + ambiguous phone-claim — HMAC still wins (mismatch detection runs maybeSingle, which returns null when >1 rows)', async () => {
    // When the cross-tenant maybeSingle() finds multiple rows it returns null
    // → resolver treats it as "no claim disagreement" and trusts HMAC.
    const supabase = makeSupabase({
      rows: [
        { user_id: 5, whatsapp_phone_number: '+15555550301' },
        { user_id: 6, whatsapp_phone_number: '+15555550301' },
      ],
    });
    // Override maybeSingle to simulate Supabase's "ambiguous returns null" semantics
    const orig = supabase.from;
    supabase.from = jest.fn((t) => {
      const b = orig(t);
      const origMaybeSingle = b.maybeSingle.bind(b);
      b.maybeSingle = async () => {
        const r = await origMaybeSingle();
        // Real Supabase: maybeSingle with multiple rows → error, data: null
        return r.data && Array.isArray(r.data) ? { data: null, error: { code: 'PGRST116' } } : { data: null, error: null };
      };
      return b;
    });
    const r = await resolveWhatsAppStatusTenant(supabase, {
      verifiedUserId: 42, phoneNumber: '+15555550301',
    });
    // The maybeSingle returned null → no cross-tenant signal → HMAC honored.
    expect(r.ok).toBe(true);
    expect(r.resolutionPath).toBe('hmac');
  });
});

// ─── Layer 2: source-text scan ───────────────────────────────────────

describe('server.js — WhatsApp status handler (P1.4 contract)', () => {
  test('imports resolveWhatsAppStatusTenant helper', () => {
    expect(SERVER_JS).toMatch(/require\(['"]\.\/lib\/whatsapp-status-tenant-resolver['"]\)/);
    expect(SERVER_JS).toMatch(/\bresolveWhatsAppStatusTenant\b/);
  });

  test('handler signature accepts verifiedUserId as third arg', () => {
    expect(SERVER_JS).toMatch(/async function handleWhatsAppWebhook\(event,\s*payload,\s*verifiedUserId/);
  });

  test('outer Sigcore webhook handler forwards verifiedUserId to the WA handler', () => {
    expect(SERVER_JS).toMatch(/handleWhatsAppWebhook\(event,\s*payload,\s*verifiedUserId\)/);
  });

  test('the pre-P1.4 global scan pattern is gone', () => {
    // The smoking-gun anti-pattern was:
    //   .or('whatsapp_connected.eq.true,whatsapp_phone_number.neq.null')
    //   .limit(1).maybeSingle();
    // inside the status.change branch. Asserting removed:
    expect(SERVER_JS).not.toMatch(/whatsapp_connected\.eq\.true,whatsapp_phone_number\.neq\.null/);
  });

  test('status.change branch contains structured [WhatsApp-status] audit log', () => {
    const start = SERVER_JS.indexOf("event === 'whatsapp.status.change'");
    expect(start).toBeGreaterThan(0);
    const block = SERVER_JS.slice(start, start + 3500);
    expect(block).toMatch(/\[WhatsApp-status\]/);
    expect(block).toMatch(/outcome=/);
  });

  test('status.change branch returns on drop outcomes (no global update fallback)', () => {
    const start = SERVER_JS.indexOf("event === 'whatsapp.status.change'");
    const block = SERVER_JS.slice(start, start + 3500);
    // Drop path must `return` immediately, not fall through to an UPDATE.
    expect(block).toMatch(/if\s*\(\s*!r\.ok\s*\)/);
    expect(block).toMatch(/audit\(r\.outcome[\s\S]{0,80}return/);
  });

  test('status.change UPDATE is keyed on r.userId (tenant-scoped)', () => {
    const start = SERVER_JS.indexOf("event === 'whatsapp.status.change'");
    const block = SERVER_JS.slice(start, start + 3500);
    expect(block).toMatch(/\.eq\(['"]user_id['"],\s*r\.userId\)/);
  });

  test('every reject path emits an audit log line before returning', () => {
    const start = SERVER_JS.indexOf("event === 'whatsapp.status.change'");
    const block = SERVER_JS.slice(start, start + 3500);
    // audit(...) call must appear before the return on the drop path.
    const dropPath = block.match(/if\s*\(\s*!r\.ok\s*\)\s*\{([\s\S]{0,200})\}/);
    expect(dropPath).not.toBeNull();
    expect(dropPath[1]).toMatch(/audit\(/);
    expect(dropPath[1]).toMatch(/return/);
  });
});
