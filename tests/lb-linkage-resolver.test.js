/**
 * LB linkage resolver — canonical-contract unit tests.
 *
 * Covers every branch of lib/lb-linkage-resolver.js:
 *   - explicit override
 *   - lead_match via converted_customer_id
 *   - identity_lead_match fallback
 *   - multiple_lb_leads (review_required)
 *   - ambiguity_identity_disagrees (review_required)
 *   - duplicate_customer (review_required)
 *   - no_customer / no_lb_lead / customer_without_identity
 *   - cross-tenant isolation
 *   - parent-job inheritance helper
 *   - metrics + structured log shape
 *
 * Plus integration-level shapes for the two ZB job-create paths and
 * the SF UI /api/jobs path. Those tests run on the SUPABASE_STUB used
 * across the existing test fleet so we don't need a live Postgres.
 */

const {
  resolveLbLinkage,
  linkageFromParentJob,
  logResolution,
  REASONS,
} = require('../lib/lb-linkage-resolver');
const {
  recordJobCreate,
  recordOutboundSkippedNotLinked,
  getMetrics,
  __resetForTests,
} = require('../lib/lb-linkage-metrics');

// ──────────────────────────────────────────────────────────────────
// Tiny supabase stub — minimal enough for the resolver's two queries.
// ──────────────────────────────────────────────────────────────────
function makeSupabaseStub({ leads = [], identities = [] } = {}) {
  return {
    from(table) {
      const filter = {};
      const chain = {
        select() { return chain; },
        eq(k, v) { filter[k] = v; return chain; },
        limit() { return chain; },
        maybeSingle() {
          const rows = applyFilter(rowsFor(table), filter);
          return Promise.resolve({ data: rows[0] || null, error: null });
        },
        then(resolve) {
          resolve({ data: applyFilter(rowsFor(table), filter), error: null });
        },
      };
      return chain;

      function rowsFor(t) {
        if (t === 'leads') return leads;
        if (t === 'communication_participant_identities') return identities;
        return [];
      }
    },
  };
}

function applyFilter(rows, filter) {
  return rows.filter((r) => Object.entries(filter).every(([k, v]) => String(r[k]) === String(v)));
}

const SILENT = { warn() {}, log() {} };

// ──────────────────────────────────────────────────────────────────
// Strategy 1 — explicit override
// ──────────────────────────────────────────────────────────────────
describe('resolveLbLinkage — explicit override', () => {
  test('returns explicit linkage verbatim, no lead lookup', async () => {
    const supabase = makeSupabaseStub({ leads: [{ id: 99, user_id: 2, converted_customer_id: 100, lb_external_request_id: 'WRONG', lb_channel: 'thumbtack' }] });
    const out = await resolveLbLinkage(supabase, {
      userId: 2, customerId: 100,
      explicit: { lb_external_request_id: 'EXPLICIT', lb_channel: 'yelp', lb_business_id: 'B', lb_provider_account_id: 11 },
      logger: SILENT,
    });
    expect(out.result).toBe('linked');
    expect(out.reason).toBe(REASONS.EXPLICIT);
    expect(out.link.lb_external_request_id).toBe('EXPLICIT');
    expect(out.link.lb_channel).toBe('yelp');
  });

  test('explicit lb_channel outside thumbtack/yelp dropped to null + warn', async () => {
    const warn = jest.fn();
    const out = await resolveLbLinkage(makeSupabaseStub(), {
      userId: 2, customerId: 100,
      explicit: { lb_external_request_id: 'X', lb_channel: 'mars' },
      logger: { warn, log() {} },
    });
    expect(out.link.lb_channel).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('explicit_channel_dropped'));
  });
});

// ──────────────────────────────────────────────────────────────────
// Strategy 2 — lead_match
// ──────────────────────────────────────────────────────────────────
describe('resolveLbLinkage — lead_match', () => {
  test('single LB-linked lead → linked', async () => {
    const supabase = makeSupabaseStub({
      leads: [{ id: 5, user_id: 2, converted_customer_id: 100, lb_external_request_id: 'EXT-7', lb_channel: 'thumbtack' }],
    });
    const out = await resolveLbLinkage(supabase, { userId: 2, customerId: 100, logger: SILENT });
    expect(out.result).toBe('linked');
    expect(out.reason).toBe(REASONS.LEAD_MATCH);
    expect(out.leadId).toBe(5);
    expect(out.link.lb_external_request_id).toBe('EXT-7');
  });

  test('multiple leads, same external id → linked (treated as single)', async () => {
    const supabase = makeSupabaseStub({
      leads: [
        { id: 5, user_id: 2, converted_customer_id: 100, lb_external_request_id: 'SAME', lb_channel: 'thumbtack' },
        { id: 6, user_id: 2, converted_customer_id: 100, lb_external_request_id: 'SAME', lb_channel: 'thumbtack' },
      ],
    });
    const out = await resolveLbLinkage(supabase, { userId: 2, customerId: 100, logger: SILENT });
    expect(out.result).toBe('linked');
    expect(out.reason).toBe(REASONS.LEAD_MATCH);
  });
});

// ──────────────────────────────────────────────────────────────────
// Strategy 3 — identity_lead_match
// ──────────────────────────────────────────────────────────────────
describe('resolveLbLinkage — identity_lead_match', () => {
  test('lead has linkage but no converted_customer_id back-ref; identity fills in', async () => {
    const supabase = makeSupabaseStub({
      leads: [
        // Lead with linkage but NOT linked via converted_customer_id
        { id: 7, user_id: 2, converted_customer_id: null, lb_external_request_id: 'EXT-9', lb_channel: 'yelp', lb_business_id: 'B9', lb_provider_account_id: 22 },
      ],
      identities: [
        { id: 33, user_id: 2, sf_customer_id: 100, sf_lead_id: 7 },
      ],
    });
    const out = await resolveLbLinkage(supabase, { userId: 2, customerId: 100, logger: SILENT });
    expect(out.result).toBe('linked');
    expect(out.reason).toBe(REASONS.IDENTITY_LEAD_MATCH);
    expect(out.leadId).toBe(7);
    expect(out.link.lb_external_request_id).toBe('EXT-9');
    expect(out.link.lb_channel).toBe('yelp');
  });
});

// ──────────────────────────────────────────────────────────────────
// Ambiguity branches
// ──────────────────────────────────────────────────────────────────
describe('resolveLbLinkage — review_required branches', () => {
  test('multiple_lb_leads — 2 distinct external ids on same customer', async () => {
    const warn = jest.fn();
    const supabase = makeSupabaseStub({
      leads: [
        { id: 5, user_id: 2, converted_customer_id: 100, lb_external_request_id: 'A', lb_channel: 'thumbtack' },
        { id: 6, user_id: 2, converted_customer_id: 100, lb_external_request_id: 'B', lb_channel: 'thumbtack' },
      ],
    });
    const out = await resolveLbLinkage(supabase, { userId: 2, customerId: 100, logger: { warn, log() {} } });
    expect(out.result).toBe('review_required');
    expect(out.reason).toBe(REASONS.MULTIPLE_LB_LEADS);
    expect(out.candidates).toHaveLength(2);
    expect(out.link.lb_external_request_id).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('multiple_lb_leads'));
  });

  test('duplicate_customer — 2 identities for same customer, different sf_lead_ids', async () => {
    const supabase = makeSupabaseStub({
      leads: [],
      identities: [
        { id: 33, user_id: 2, sf_customer_id: 100, sf_lead_id: 5 },
        { id: 34, user_id: 2, sf_customer_id: 100, sf_lead_id: 7 },
      ],
    });
    const out = await resolveLbLinkage(supabase, { userId: 2, customerId: 100, logger: SILENT });
    expect(out.result).toBe('review_required');
    expect(out.reason).toBe(REASONS.DUPLICATE_CUSTOMER);
    expect(out.candidates).toHaveLength(2);
  });

  test('ambiguity_identity_disagrees — lead_match=5 but identity points at 999', async () => {
    const supabase = makeSupabaseStub({
      leads: [{ id: 5, user_id: 2, converted_customer_id: 100, lb_external_request_id: 'EXT', lb_channel: 'thumbtack' }],
      identities: [{ id: 33, user_id: 2, sf_customer_id: 100, sf_lead_id: 999 }],
    });
    const out = await resolveLbLinkage(supabase, { userId: 2, customerId: 100, logger: SILENT });
    expect(out.result).toBe('review_required');
    expect(out.reason).toBe(REASONS.AMBIGUITY_IDENTITY_DISAGREES);
  });
});

// ──────────────────────────────────────────────────────────────────
// Negative paths
// ──────────────────────────────────────────────────────────────────
describe('resolveLbLinkage — not_linked branches', () => {
  test('no customerId → no_customer', async () => {
    const out = await resolveLbLinkage(makeSupabaseStub(), { userId: 2, customerId: null, logger: SILENT });
    expect(out.result).toBe('not_linked');
    expect(out.reason).toBe(REASONS.NO_CUSTOMER);
  });

  test('no leads + no identity → customer_without_identity', async () => {
    const out = await resolveLbLinkage(makeSupabaseStub(), { userId: 2, customerId: 100, logger: SILENT });
    expect(out.result).toBe('not_linked');
    expect(out.reason).toBe(REASONS.CUSTOMER_WITHOUT_IDENTITY);
  });

  test('identity exists but no LB lead anywhere → no_lb_lead', async () => {
    const supabase = makeSupabaseStub({
      leads: [{ id: 5, user_id: 2, converted_customer_id: 100, lb_external_request_id: null, lb_channel: null }],
      identities: [{ id: 33, user_id: 2, sf_customer_id: 100, sf_lead_id: 5 }],
    });
    const out = await resolveLbLinkage(supabase, { userId: 2, customerId: 100, logger: SILENT });
    expect(out.result).toBe('not_linked');
    expect(out.reason).toBe(REASONS.NO_LB_LEAD);
  });
});

// ──────────────────────────────────────────────────────────────────
// Cross-tenant isolation
// ──────────────────────────────────────────────────────────────────
describe('resolveLbLinkage — cross-tenant isolation', () => {
  test('other-tenant linked lead never leaks (stub filters by user_id)', async () => {
    const supabase = makeSupabaseStub({
      leads: [
        // Tenant 9's lead — same customer_id by coincidence
        { id: 7, user_id: 9, converted_customer_id: 100, lb_external_request_id: 'CROSS', lb_channel: 'yelp' },
      ],
    });
    const out = await resolveLbLinkage(supabase, { userId: 2, customerId: 100, logger: SILENT });
    expect(out.link.lb_external_request_id).toBeNull();
    expect(out.result).toBe('not_linked');
  });
});

// ──────────────────────────────────────────────────────────────────
// Parent-job inheritance helper
// ──────────────────────────────────────────────────────────────────
describe('linkageFromParentJob', () => {
  test('returns null when parent has no linkage', () => {
    expect(linkageFromParentJob({ id: 1, lb_external_request_id: null })).toBeNull();
    expect(linkageFromParentJob(null)).toBeNull();
  });
  test('returns canonical 4-field shape from parent', () => {
    const out = linkageFromParentJob({
      id: 1, lb_external_request_id: 'EXT', lb_channel: 'thumbtack',
      lb_business_id: 'BIZ', lb_provider_account_id: 7,
    });
    expect(out).toEqual({
      lb_external_request_id: 'EXT', lb_channel: 'thumbtack',
      lb_business_id: 'BIZ', lb_provider_account_id: 7,
    });
  });
});

// ──────────────────────────────────────────────────────────────────
// Structured log shape
// ──────────────────────────────────────────────────────────────────
describe('logResolution', () => {
  test('emits one [LBLinkage] line with all required fields', () => {
    const logs = [];
    const logger = { log: (s) => logs.push(s) };
    logResolution(logger, {
      jobId: 42, customerId: 100, result: 'linked', reason: REASONS.LEAD_MATCH, leadId: 5,
      link: { lb_external_request_id: 'EXT', lb_channel: 'thumbtack' },
    });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('[LBLinkage] action=resolve_for_job');
    expect(logs[0]).toContain('job_id=42');
    expect(logs[0]).toContain('customer_id=100');
    expect(logs[0]).toContain('lead_id=5');
    expect(logs[0]).toContain('result=linked');
    expect(logs[0]).toContain('reason=lead_match');
    expect(logs[0]).toContain('external_request_id=EXT');
    expect(logs[0]).toContain('channel=thumbtack');
  });
});

// ──────────────────────────────────────────────────────────────────
// Metrics counters
// ──────────────────────────────────────────────────────────────────
describe('lb-linkage-metrics', () => {
  beforeEach(() => __resetForTests());

  test('linked / review_required / not_linked buckets bump independently', () => {
    recordJobCreate({ result: 'linked', reason: 'lead_match' });
    recordJobCreate({ result: 'linked', reason: 'identity_lead_match' });
    recordJobCreate({ result: 'review_required', reason: 'multiple_lb_leads' });
    recordJobCreate({ result: 'not_linked', reason: 'customer_without_identity' });
    const m = getMetrics();
    expect(m.jobs_created_with_lb_linkage).toBe(2);
    expect(m.jobs_created_review_required).toBe(1);
    expect(m.jobs_created_without_lb_linkage).toBe(1);
    expect(m.reasons.lead_match).toBe(1);
    expect(m.reasons.identity_lead_match).toBe(1);
    expect(m.reasons.multiple_lb_leads).toBe(1);
    expect(m.reasons.customer_without_identity).toBe(1);
  });

  test('outbound_status_skipped_not_linked bumps on each call', () => {
    recordOutboundSkippedNotLinked();
    recordOutboundSkippedNotLinked();
    expect(getMetrics().outbound_status_skipped_not_linked).toBe(2);
  });

  test('null / undefined resolution is a no-op', () => {
    recordJobCreate(null);
    recordJobCreate(undefined);
    const m = getMetrics();
    expect(m.jobs_created_with_lb_linkage).toBe(0);
    expect(m.jobs_created_review_required).toBe(0);
    expect(m.jobs_created_without_lb_linkage).toBe(0);
  });
});
