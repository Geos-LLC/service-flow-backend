'use strict';

/**
 * Identity Linker — scoring fallback (migration bridge) tests.
 *
 * Covers attemptScoringFallback() — the temporary auto-link path that
 * runs ONLY when the identity graph could not produce a projection.
 * On success it hydrates the identity graph so future events use the
 * graph path directly.
 *
 * Safety gates verified:
 *   - IDENTITY_SCORING_FALLBACK_ENABLED + tenant opt-out
 *   - IDENTITY_PROJECTION_FREEZE blocks fallback
 *   - customer already linked → skip
 *   - open ambiguity row for phone → block
 *   - exactly-one-HIGH requirement (multi-HIGH → block)
 *   - active-window guard (recent lead+customer updates → block)
 *   - same-tenant scope
 *
 * Identity hydration verified:
 *   - identityId provided + identity has NULL slots → both filled
 *   - identityId provided + identity already has sf_lead_id → preserved
 *   - identityId null → no identity write; link still happens (legacy mode)
 *
 * Log modes verified:
 *   - mode=fallback_projection_bridge on success
 *   - mode=ambiguity_block on multi-HIGH / open ambiguity / active-window
 *   - mode=no_match on no-candidates / low-confidence / freeze / disabled
 */

const { attemptScoringFallback } = require('../lib/identity-linker');
const { FLAGS, _resetFlags } = require('../lib/feature-flags');

// ── Lightweight mock supabase ─────────────────────────────────────

function makeSupabase({
  leads = [],
  customers = [],
  identities = [],
  ambiguityCount = 0,
  blockLeadUpdate = false,
} = {}) {
  const captured = {
    leadUpdates: [],
    identityUpdates: [],
    auditInserts: [],
    rpcCalls: [],
  };

  return {
    captured,
    from: (table) => {
      if (table === 'leads') {
        const t = {
          _filters: {},
          select: jest.fn(function () { return t; }),
          eq: jest.fn(function (col, val) { t._filters[col] = val; return t; }),
          is: jest.fn(function (col, val) { t._filters[col + '_is'] = val; return t; }),
          not: jest.fn(function () { return t; }),
          limit: jest.fn(function () { return t; }),
          then: (onFulfilled) => {
            // "customer already linked?" probe
            if (t._filters.converted_customer_id != null) {
              const linked = leads.filter(l =>
                l.user_id === t._filters.user_id &&
                l.converted_customer_id === t._filters.converted_customer_id
              );
              return Promise.resolve({ data: linked.slice(0, 1), error: null }).then(onFulfilled);
            }
            // findCandidateLeads — terminal array
            const candidates = leads.filter(l =>
              l.user_id === t._filters.user_id &&
              l.converted_customer_id == null
            );
            return Promise.resolve({ data: candidates, error: null }).then(onFulfilled);
          },
          update: jest.fn((patch) => {
            captured.leadUpdates.push({ patch });
            let updateLeadId = null;
            const result = {
              eq: function (col, val) {
                if (col === 'id') updateLeadId = val;
                return result;
              },
              is: function () { return result; },
              select: function () {
                return {
                  then: (onFulfilled) => {
                    if (blockLeadUpdate) {
                      return Promise.resolve({ data: [], error: null }).then(onFulfilled);
                    }
                    // Simulate guarded UPDATE writing the row.
                    return Promise.resolve({ data: [{ id: updateLeadId }], error: null }).then(onFulfilled);
                  },
                };
              },
            };
            return result;
          }),
        };
        return t;
      }

      if (table === 'communication_identity_ambiguities') {
        const t = {
          _filters: {},
          select: jest.fn(function () { return t; }),
          eq: jest.fn(function () { return t; }),
          then: (onFulfilled) => Promise.resolve({ count: ambiguityCount }).then(onFulfilled),
        };
        return t;
      }

      if (table === 'customers') {
        const t = {
          _filters: {},
          select: jest.fn(function () { return t; }),
          eq: jest.fn(function (col, val) { t._filters[col] = val; return t; }),
          maybeSingle: jest.fn(async () => {
            const c = customers.find(c => c.id === t._filters.id && c.user_id === t._filters.user_id);
            return { data: c || null, error: null };
          }),
        };
        return t;
      }

      if (table === 'communication_participant_identities') {
        const t = {
          _filters: {},
          select: jest.fn(function () { return t; }),
          eq: jest.fn(function (col, val) { t._filters[col] = val; return t; }),
          maybeSingle: jest.fn(async () => {
            const id = identities.find(i => i.id === t._filters.id && i.user_id === t._filters.user_id);
            return { data: id || null, error: null };
          }),
          update: jest.fn((patch) => {
            captured.identityUpdates.push({ patch });
            return {
              eq: function () { return this; },
              then: (onFulfilled) => Promise.resolve({ data: null, error: null }).then(onFulfilled),
            };
          }),
        };
        return t;
      }

      if (table === 'identity_link_audit') {
        return {
          insert: jest.fn(async (row) => {
            captured.auditInserts.push(row);
            return { data: null, error: null };
          }),
        };
      }

      throw new Error(`unmocked table: ${table}`);
    },
    rpc: jest.fn(async (name, args) => {
      captured.rpcCalls.push({ name, args });
      return { data: null, error: null };
    }),
  };
}

function makeLogger() {
  return {
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
}

function envCleanup() {
  delete process.env.IDENTITY_PROJECTION_FREEZE;
  delete process.env.IDENTITY_SCORING_FALLBACK_ENABLED;
  delete process.env.IDENTITY_SCORING_FALLBACK_TENANTS;
}

// Enable fallback for a tenant via the strict opt-in pattern:
//   IDENTITY_SCORING_FALLBACK_ENABLED=true  (capability flag)
//   IDENTITY_SCORING_FALLBACK_TENANTS=<csv> (tenant must be in list)
// Both required.
function optInFallbackFor(...userIds) {
  process.env.IDENTITY_SCORING_FALLBACK_ENABLED = 'true';
  process.env.IDENTITY_SCORING_FALLBACK_TENANTS = userIds.map(String).join(',');
}

beforeEach(() => envCleanup());
afterEach(() => envCleanup());

// ── 1. Default ON — successful HIGH match links + hydrates identity ──

describe('attemptScoringFallback — success path (graph hydration)', () => {
  test('HIGH single-match links lead → customer AND hydrates identity (sf_lead_id + sf_customer_id)', async () => {
    optInFallbackFor(2);
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const supabase = makeSupabase({
      leads: [{ id: 100, user_id: 2, phone: '5559998888', first_name: 'Linda', last_name: 'Mau', source: 'Thumbtack Tampa', converted_customer_id: null, updated_at: oneHourAgo }],
      customers: [{ id: 500, user_id: 2, phone: '5559998888', first_name: 'Linda', last_name: 'Mau', source: 'Thumbtack Tampa', updated_at: oneHourAgo }],
      identities: [{ id: 42, user_id: 2, sf_lead_id: null, sf_customer_id: null }],
      ambiguityCount: 0,
    });
    const logger = makeLogger();

    // Active-window check needs a wider window than 1h since both rows are 1h old.
    const result = await attemptScoringFallback(supabase, logger, {
      userId: 2, customerId: 500,
      customerPhone: '+15559998888',
      customerName: 'Linda Mau',
      customerSource: 'Thumbtack Tampa',
      identityId: 42,
      activeWindowHours: 0,  // disable for this test
      source: 'zenbooker',
    });

    expect(result.mode).toBe('fallback_projection_bridge');
    expect(result.outcome).toBe('success');
    expect(result.lead_id).toBe(100);
    expect(result.customer_id).toBe(500);
    expect(result.identity_id).toBe(42);
    expect(result.confidence).toBe('high');

    // Lead-update issued
    expect(supabase.captured.leadUpdates.length).toBe(1);
    // Identity hydrated — both fields written (both were NULL)
    expect(supabase.captured.identityUpdates.length).toBe(1);
    const hydrate = supabase.captured.identityUpdates[0].patch;
    expect(hydrate.sf_lead_id).toBe(100);
    expect(hydrate.sf_customer_id).toBe(500);
    expect(hydrate.status).toBe('resolved_both');
    // Audit row written with resolved_by=fallback_projection_bridge
    expect(supabase.captured.auditInserts.length).toBe(1);
    expect(supabase.captured.auditInserts[0].resolved_by).toBe('fallback_projection_bridge');
    expect(supabase.captured.auditInserts[0].identity_id).toBe(42);
    // Registry archive RPC called
    expect(supabase.captured.rpcCalls.find(c => c.name === 'pir_archive_entity')).toBeTruthy();
    // mode=fallback_projection_bridge emitted
    const modeLog = logger.log.mock.calls.find(c => /\[IdentityLink\] mode=fallback_projection_bridge/.test(c[0]));
    expect(modeLog).toBeTruthy();
  });

  test('legacy mode — identityId=null still links lead → customer (no identity write)', async () => {
    optInFallbackFor(2);
    const supabase = makeSupabase({
      leads: [{ id: 101, user_id: 2, phone: '5557776666', first_name: 'Jane', last_name: 'Doe', source: null, converted_customer_id: null }],
      customers: [{ id: 501, user_id: 2, phone: '5557776666', first_name: 'Jane', last_name: 'Doe' }],
      identities: [],
    });
    const logger = makeLogger();

    const result = await attemptScoringFallback(supabase, logger, {
      userId: 2, customerId: 501,
      customerPhone: '+15557776666',
      customerName: 'Jane Doe',
      identityId: null,
      activeWindowHours: 0,
    });

    expect(result.mode).toBe('fallback_projection_bridge');
    expect(result.outcome).toBe('success');
    expect(result.identity_id).toBeNull();
    expect(supabase.captured.identityUpdates.length).toBe(0);  // no identity to hydrate
    expect(supabase.captured.leadUpdates.length).toBe(1);
    expect(supabase.captured.auditInserts.length).toBe(1);
    expect(supabase.captured.auditInserts[0].identity_id).toBeNull();
  });

  test('identity already has sf_lead_id — fallback preserves it, only fills NULL sf_customer_id', async () => {
    optInFallbackFor(2);
    const supabase = makeSupabase({
      leads: [{ id: 102, user_id: 2, phone: '5556665555', first_name: 'Bob', last_name: 'Smith', source: 'Yelp Tampa', converted_customer_id: null }],
      customers: [{ id: 502, user_id: 2, phone: '5556665555', first_name: 'Bob', last_name: 'Smith', source: 'Yelp Tampa' }],
      identities: [{ id: 43, user_id: 2, sf_lead_id: 999, sf_customer_id: null }],  // sf_lead_id pre-set
    });
    const logger = makeLogger();

    const result = await attemptScoringFallback(supabase, logger, {
      userId: 2, customerId: 502,
      customerPhone: '+15556665555',
      customerName: 'Bob Smith',
      customerSource: 'Yelp Tampa',
      identityId: 43,
      activeWindowHours: 0,
    });

    expect(result.outcome).toBe('success');
    const hydrate = supabase.captured.identityUpdates[0].patch;
    expect(hydrate.sf_lead_id).toBeUndefined();   // NOT overwritten
    expect(hydrate.sf_customer_id).toBe(502);     // filled (was NULL)
    expect(hydrate.status).toBe('resolved_both'); // both now populated
  });
});

// ── 2. Ambiguity blocks ─────────────────────────────────────────

describe('attemptScoringFallback — ambiguity blocks', () => {
  test('open ambiguity row for phone → mode=ambiguity_block, NO writes', async () => {
    optInFallbackFor(2);
    const supabase = makeSupabase({
      leads: [{ id: 200, user_id: 2, phone: '5551112222', first_name: 'Anna', last_name: 'Smith', converted_customer_id: null }],
      ambiguityCount: 1,  // resolver flagged this phone as risky
    });
    const logger = makeLogger();

    const result = await attemptScoringFallback(supabase, logger, {
      userId: 2, customerId: 600, customerPhone: '+15551112222', customerName: 'Anna Smith', identityId: 50, activeWindowHours: 0,
    });

    expect(result.mode).toBe('ambiguity_block');
    expect(result.outcome).toBe('open_ambiguity_row');
    expect(supabase.captured.leadUpdates.length).toBe(0);
    expect(supabase.captured.identityUpdates.length).toBe(0);
    expect(supabase.captured.auditInserts.length).toBe(0);
    expect(logger.log.mock.calls.find(c => /mode=ambiguity_block/.test(c[0]))).toBeTruthy();
  });

  test('multiple HIGH candidates → mode=ambiguity_block', async () => {
    optInFallbackFor(2);
    const supabase = makeSupabase({
      leads: [
        { id: 300, user_id: 2, phone: '5553334444', first_name: 'Jane', last_name: 'Doe', source: 'Thumbtack', converted_customer_id: null },
        { id: 301, user_id: 2, phone: '5553334444', first_name: 'Jane', last_name: 'Doe', source: 'Thumbtack', converted_customer_id: null },
      ],
    });
    const logger = makeLogger();

    const result = await attemptScoringFallback(supabase, logger, {
      userId: 2, customerId: 700, customerPhone: '+15553334444', customerName: 'Jane Doe', customerSource: 'Thumbtack',
      identityId: 60, activeWindowHours: 0,
    });

    expect(result.mode).toBe('ambiguity_block');
    expect(result.outcome).toBe('multiple_high_candidates');
    expect(result.candidates.length).toBe(2);
    expect(supabase.captured.leadUpdates.length).toBe(0);
  });

  test('active-window guard — both updated within window → mode=ambiguity_block', async () => {
    optInFallbackFor(2);
    const justNow = new Date(Date.now() - 5 * 60 * 1000).toISOString();  // 5 minutes ago
    const supabase = makeSupabase({
      leads: [{ id: 400, user_id: 2, phone: '5554443333', first_name: 'Bob', last_name: 'Smith', source: 'Yelp', converted_customer_id: null, updated_at: justNow }],
      customers: [{ id: 800, user_id: 2, phone: '5554443333', first_name: 'Bob', last_name: 'Smith', source: 'Yelp', updated_at: justNow }],
    });
    const logger = makeLogger();

    const result = await attemptScoringFallback(supabase, logger, {
      userId: 2, customerId: 800, customerPhone: '+15554443333', customerName: 'Bob Smith', customerSource: 'Yelp',
      identityId: 70, activeWindowHours: 24,  // 24h guard, both rows < 5min old → downgrade
    });

    expect(result.mode).toBe('ambiguity_block');
    expect(result.outcome).toBe('active_window_downgrade');
    expect(supabase.captured.leadUpdates.length).toBe(0);
  });
});

// ── 3. No-match outcomes ──────────────────────────────────────

describe('attemptScoringFallback — no_match outcomes', () => {
  test('no candidates → mode=no_match reason=no_candidates', async () => {
    optInFallbackFor(2);
    const supabase = makeSupabase({ leads: [] });
    const logger = makeLogger();

    const result = await attemptScoringFallback(supabase, logger, {
      userId: 2, customerId: 900, customerPhone: '+15550000000', customerName: 'New Customer',
      identityId: 80, activeWindowHours: 0,
    });

    expect(result.mode).toBe('no_match');
    expect(result.outcome).toBe('no_candidates');
    expect(supabase.captured.leadUpdates.length).toBe(0);
  });

  test('only LOW-confidence candidate (phone mismatch) → mode=no_match', async () => {
    optInFallbackFor(2);
    const supabase = makeSupabase({
      leads: [{ id: 500, user_id: 2, phone: '5559999999', first_name: 'Different', last_name: 'Person', converted_customer_id: null }],
    });
    const logger = makeLogger();

    const result = await attemptScoringFallback(supabase, logger, {
      userId: 2, customerId: 1000, customerPhone: '+15551111111',  // different phone
      customerName: 'Some Name', identityId: 90, activeWindowHours: 0,
    });

    expect(result.mode).toBe('no_match');
    expect(supabase.captured.leadUpdates.length).toBe(0);
  });

  test('customer already linked → mode=no_match reason=customer_already_linked', async () => {
    optInFallbackFor(2);
    const supabase = makeSupabase({
      leads: [{ id: 600, user_id: 2, phone: '5558888888', converted_customer_id: 1100 }],  // already linked
    });
    const logger = makeLogger();

    const result = await attemptScoringFallback(supabase, logger, {
      userId: 2, customerId: 1100, customerPhone: '+15558888888', customerName: 'Linked', identityId: 100, activeWindowHours: 0,
    });

    expect(result.mode).toBe('no_match');
    expect(result.outcome).toBe('customer_already_linked');
    expect(supabase.captured.leadUpdates.length).toBe(0);  // no new write
  });

  test('IDENTITY_PROJECTION_FREEZE=true → mode=no_match reason=freeze', async () => {
    optInFallbackFor(2);
    process.env.IDENTITY_PROJECTION_FREEZE = 'true';
    const supabase = makeSupabase({
      leads: [{ id: 700, user_id: 2, phone: '5557777777', first_name: 'A', last_name: 'B', converted_customer_id: null }],
    });
    const logger = makeLogger();

    const result = await attemptScoringFallback(supabase, logger, {
      userId: 2, customerId: 1200, customerPhone: '+15557777777', customerName: 'A B', identityId: 110, activeWindowHours: 0,
    });

    expect(result.mode).toBe('no_match');
    expect(result.outcome).toBe('freeze');
    expect(supabase.captured.leadUpdates.length).toBe(0);
  });

  test('capability flag OFF (default) → fallback_disabled, no writes', async () => {
    // Neither env var set → fallback off by default (strict opt-in).
    const supabase = makeSupabase({
      leads: [{ id: 800, user_id: 2, phone: '5556666666', first_name: 'Cee', last_name: 'Dee', source: 'Thumbtack', converted_customer_id: null }],
    });
    const logger = makeLogger();

    const result = await attemptScoringFallback(supabase, logger, {
      userId: 2, customerId: 1300, customerPhone: '+15556666666', customerName: 'Cee Dee', customerSource: 'Thumbtack',
      identityId: 120, activeWindowHours: 0,
    });

    expect(result.mode).toBe('no_match');
    expect(result.outcome).toBe('fallback_disabled');
    expect(supabase.captured.leadUpdates.length).toBe(0);
  });

  test('capability flag ON but tenant NOT in opt-in list → fallback_disabled', async () => {
    process.env.IDENTITY_SCORING_FALLBACK_ENABLED = 'true';
    // No IDENTITY_SCORING_FALLBACK_TENANTS set → tenant 2 not opted in.
    const supabase = makeSupabase({
      leads: [{ id: 801, user_id: 2, phone: '5557777777', first_name: 'E', last_name: 'F', source: 'Thumbtack', converted_customer_id: null }],
    });
    const logger = makeLogger();

    const result = await attemptScoringFallback(supabase, logger, {
      userId: 2, customerId: 1301, customerPhone: '+15557777777', customerName: 'Eric Fox', customerSource: 'Thumbtack',
      identityId: 121, activeWindowHours: 0,
    });

    expect(result.outcome).toBe('fallback_disabled');
    expect(supabase.captured.leadUpdates.length).toBe(0);
  });

  test('tenant in opt-in list but capability flag OFF → fallback_disabled', async () => {
    // IDENTITY_SCORING_FALLBACK_ENABLED explicitly false; tenants list ignored.
    process.env.IDENTITY_SCORING_FALLBACK_ENABLED = 'false';
    process.env.IDENTITY_SCORING_FALLBACK_TENANTS = '2';
    const supabase = makeSupabase({
      leads: [{ id: 802, user_id: 2, phone: '5558888888', first_name: 'Eric', last_name: 'Fox', source: 'Thumbtack', converted_customer_id: null }],
    });
    const logger = makeLogger();

    const result = await attemptScoringFallback(supabase, logger, {
      userId: 2, customerId: 1302, customerPhone: '+15558888888', customerName: 'Eric Fox', customerSource: 'Thumbtack',
      identityId: 122, activeWindowHours: 0,
    });

    expect(result.outcome).toBe('fallback_disabled');
  });

  test('opt-in works: capability=true AND tenant in list → fallback runs and succeeds on HIGH match', async () => {
    optInFallbackFor(2);
    const supabase = makeSupabase({
      leads: [{ id: 803, user_id: 2, phone: '5559999999', first_name: 'Eric', last_name: 'Fox', source: 'Thumbtack', converted_customer_id: null }],
    });
    const logger = makeLogger();

    const result = await attemptScoringFallback(supabase, logger, {
      userId: 2, customerId: 1303, customerPhone: '+15559999999', customerName: 'Eric Fox', customerSource: 'Thumbtack',
      identityId: null, activeWindowHours: 0,
    });

    expect(result.outcome).toBe('success');
  });

  test('per-tenant isolation: opt-in for tenant 2 does NOT enable for tenant 9', async () => {
    optInFallbackFor(2);  // only tenant 2 opted in
    const supabase = makeSupabase({
      leads: [{ id: 900, user_id: 9, phone: '5555555555', first_name: 'Eric', last_name: 'Fox', source: 'Thumbtack', converted_customer_id: null }],
    });
    const result = await attemptScoringFallback(supabase, makeLogger(), {
      userId: 9, customerId: 1400, customerPhone: '+15555555555', customerName: 'Eric Fox', customerSource: 'Thumbtack',
      identityId: null, activeWindowHours: 0,
    });
    expect(result.outcome).toBe('fallback_disabled');
  });

  test('invalid input (missing userId / customerId / phone) → no_match invalid_input', async () => {
    const supabase = makeSupabase();
    const logger = makeLogger();
    const r1 = await attemptScoringFallback(supabase, logger, { customerId: 1, customerPhone: '+1555' });
    expect(r1.outcome).toBe('invalid_input');
    const r2 = await attemptScoringFallback(supabase, logger, { userId: 2, customerPhone: '+1555' });
    expect(r2.outcome).toBe('invalid_input');
    const r3 = await attemptScoringFallback(supabase, logger, { userId: 2, customerId: 1 });
    expect(r3.outcome).toBe('invalid_input');
  });
});

// ── 4. Tenant scope guard ─────────────────────────────────────

describe('attemptScoringFallback — tenant scope', () => {
  test('lead with different user_id is NOT returned by findCandidateLeads (mock honours scope)', async () => {
    optInFallbackFor(2);
    const supabase = makeSupabase({
      // Lead belongs to user 99, fallback called for user 2 — must NOT match.
      leads: [{ id: 1000, user_id: 99, phone: '5552222222', first_name: 'Foreign', last_name: 'Tenant', converted_customer_id: null }],
    });
    const logger = makeLogger();

    const result = await attemptScoringFallback(supabase, logger, {
      userId: 2, customerId: 1500, customerPhone: '+15552222222', customerName: 'Foreign Tenant', identityId: 140, activeWindowHours: 0,
    });

    expect(result.mode).toBe('no_match');
    expect(result.outcome).toBe('no_candidates');
    expect(supabase.captured.leadUpdates.length).toBe(0);
  });
});

// ── 5. Hydration provenance (last_hydrated_by) ────────────────────

describe('attemptScoringFallback — last_hydrated_by provenance', () => {
  test('successful fallback writes last_hydrated_by=fallback_projection_bridge on identity', async () => {
    optInFallbackFor(2);
    const supabase = makeSupabase({
      leads: [{ id: 100, user_id: 2, phone: '5559998888', first_name: 'Linda', last_name: 'Mau', source: 'Thumbtack', converted_customer_id: null }],
      customers: [{ id: 500, user_id: 2, phone: '5559998888', first_name: 'Linda', last_name: 'Mau', source: 'Thumbtack' }],
      identities: [{ id: 42, user_id: 2, sf_lead_id: null, sf_customer_id: null }],
    });

    const result = await attemptScoringFallback(supabase, makeLogger(), {
      userId: 2, customerId: 500, customerPhone: '+15559998888',
      customerName: 'Linda Mau', customerSource: 'Thumbtack',
      identityId: 42, activeWindowHours: 0,
    });

    expect(result.outcome).toBe('success');
    expect(supabase.captured.identityUpdates.length).toBe(1);
    expect(supabase.captured.identityUpdates[0].patch.last_hydrated_by).toBe('fallback_projection_bridge');
  });

  test('successful fallback writes resolved_by=fallback_projection_bridge into audit row', async () => {
    optInFallbackFor(2);
    const supabase = makeSupabase({
      leads: [{ id: 101, user_id: 2, phone: '5556669999', first_name: 'Jane', last_name: 'Doe', source: 'Yelp', converted_customer_id: null }],
      identities: [{ id: 43, user_id: 2, sf_lead_id: null, sf_customer_id: null }],
    });

    await attemptScoringFallback(supabase, makeLogger(), {
      userId: 2, customerId: 501, customerPhone: '+15556669999',
      customerName: 'Jane Doe', customerSource: 'Yelp',
      identityId: 43, activeWindowHours: 0,
    });

    expect(supabase.captured.auditInserts.length).toBe(1);
    expect(supabase.captured.auditInserts[0].resolved_by).toBe('fallback_projection_bridge');
  });

  test('legacy mode (identityId=null) writes audit row but no identity provenance', async () => {
    optInFallbackFor(2);
    const supabase = makeSupabase({
      leads: [{ id: 102, user_id: 2, phone: '5555556666', first_name: 'B', last_name: 'C', source: 'Thumbtack', converted_customer_id: null }],
    });

    const result = await attemptScoringFallback(supabase, makeLogger(), {
      userId: 2, customerId: 502, customerPhone: '+15555556666', customerName: 'Bob Carter', customerSource: 'Thumbtack',
      identityId: null, activeWindowHours: 0,
    });

    expect(result.outcome).toBe('success');
    expect(supabase.captured.identityUpdates.length).toBe(0);
    expect(supabase.captured.auditInserts.length).toBe(1);
    expect(supabase.captured.auditInserts[0].identity_id).toBeNull();
    expect(supabase.captured.auditInserts[0].resolved_by).toBe('fallback_projection_bridge');
  });
});

// ── 6. Metric emission ────────────────────────────────────────────

describe('attemptScoringFallback — metric=<name> emission', () => {
  test('success emits metric=fallback_projection_bridge_success', async () => {
    optInFallbackFor(2);
    const supabase = makeSupabase({
      leads: [{ id: 200, user_id: 2, phone: '5552222222', first_name: 'M', last_name: 'X', source: 'Yelp', converted_customer_id: null }],
    });
    const logger = makeLogger();

    await attemptScoringFallback(supabase, logger, {
      userId: 2, customerId: 600, customerPhone: '+15552222222', customerName: 'Maria Xi', customerSource: 'Yelp',
      identityId: null, activeWindowHours: 0,
    });

    const successLog = logger.log.mock.calls.find(c => /metric=fallback_projection_bridge_success/.test(c[0]));
    expect(successLog).toBeTruthy();
  });

  test('open ambiguity row emits metric=fallback_projection_bridge_ambiguous', async () => {
    optInFallbackFor(2);
    const supabase = makeSupabase({
      leads: [{ id: 201, user_id: 2, phone: '5553333333', first_name: 'A', last_name: 'B', converted_customer_id: null }],
      ambiguityCount: 1,
    });
    const logger = makeLogger();

    await attemptScoringFallback(supabase, logger, {
      userId: 2, customerId: 601, customerPhone: '+15553333333', customerName: 'Anna Beech',
      identityId: 50, activeWindowHours: 0,
    });

    expect(logger.log.mock.calls.find(c => /metric=fallback_projection_bridge_ambiguous/.test(c[0]))).toBeTruthy();
  });

  test('no candidates emits metric=fallback_projection_bridge_no_match', async () => {
    optInFallbackFor(2);
    const supabase = makeSupabase({ leads: [] });
    const logger = makeLogger();

    await attemptScoringFallback(supabase, logger, {
      userId: 2, customerId: 602, customerPhone: '+15554444444', customerName: 'X', identityId: null, activeWindowHours: 0,
    });

    expect(logger.log.mock.calls.find(c => /metric=fallback_projection_bridge_no_match/.test(c[0]))).toBeTruthy();
  });

  test('fallback_disabled emits metric=fallback_projection_bridge_no_match (reason=fallback_disabled)', async () => {
    // No opt-in.
    const supabase = makeSupabase({
      leads: [{ id: 202, user_id: 2, phone: '5555550000', first_name: 'A', last_name: 'B', converted_customer_id: null }],
    });
    const logger = makeLogger();

    await attemptScoringFallback(supabase, logger, {
      userId: 2, customerId: 603, customerPhone: '+15555550000', customerName: 'X', identityId: null, activeWindowHours: 0,
    });

    const line = logger.log.mock.calls.find(c => /metric=fallback_projection_bridge_no_match/.test(c[0]));
    expect(line).toBeTruthy();
    expect(line[0]).toMatch(/reason=fallback_disabled/);
  });
});
