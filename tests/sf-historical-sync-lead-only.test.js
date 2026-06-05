'use strict';

/**
 * Orchestrator integration tests for the PR A lead_only_match bucket.
 *
 * runHistoricalSync now consumes findHistoricalMatchType and routes
 * match_type='lead_only' into a NEW top-level array `lead_only_match`
 * and a new summary counter `would_lead_link`. Existing buckets
 * (would_link / would_review / already_linked / would_skip) keep their
 * pre-PR-A semantics for backwards compat.
 *
 * Tests pin:
 *   - LB pending candidate with SF lead match → lead_only_match
 *   - summary.would_lead_link counter increments per row
 *   - lead_only_match entries surface sf_lead_id + sf_lead_stage_name
 *   - test_noise → would_skip (not lead_only_match)
 *   - The PR A path is dry-run; no LB linkLeadsBulk call ever
 */

process.env.SF_LB_PROVISIONING_SHARED_SECRET = 'pra-orch-test-' + 'Y'.repeat(20);
process.env.LB_PROVISIONING_BASE_URL          = 'https://lb-test.example.com/api';

const mockFetchCandidates = jest.fn();
const mockLinkLeadsBulk   = jest.fn();
jest.mock('../lib/lb-historical-sync-client', () => ({
  fetchCandidates: (...a) => mockFetchCandidates(...a),
  linkLeadsBulk:   (...a) => mockLinkLeadsBulk(...a),
  CANDIDATES_PATH: '/v1/integrations/sf/historical-sync/candidates',
  LINK_BULK_PATH:  '/v1/integrations/sf/link-leads-bulk',
}));

const {
  runHistoricalSync,
  categorizeByMatchType,
} = require('../lib/sf-historical-sync-orchestrator');
const { MATCH_TYPE, MATCH_BASIS } = require('../lib/lb-lead-link-matcher');

const LB_USER_UUID = 'c3d14499-dec1-42c3-a36c-713cb09842c6';
const SF_TENANT_ID = 2;

// Lightweight store stub — supports the matcher's leads/customers/jobs/
// lead_stages queries plus communication_settings for tenant lookup.
function makeStore({ leads = [], customers = [], jobs = [], lead_stages = [], commSettings = null } = {}) {
  const rows = {
    leads, customers, jobs, lead_stages,
    communication_settings: commSettings === null
      ? [{ user_id: SF_TENANT_ID, leadbridge_user_id: LB_USER_UUID, leadbridge_connected: true }]
      : (Array.isArray(commSettings) ? commSettings : [commSettings]),
  };
  function applyFilters(data, filters) {
    return data.filter(r => filters.every(f => {
      if (f.type === 'eq')    return String(r[f.col]) === String(f.val);
      if (f.type === 'ilike') {
        const v = String(r[f.col] == null ? '' : r[f.col]).toLowerCase();
        const pat = String(f.val).toLowerCase();
        if (pat.startsWith('%') && pat.endsWith('%')) return v.includes(pat.slice(1, -1));
        return v === pat;
      }
      if (f.type === 'in')    return f.vals.map(String).includes(String(r[f.col]));
      return true;
    }));
  }
  function makeBuilder(table) {
    const state = { table, filters: [], limit: null };
    const b = {
      insert() { throw new Error(`Phase-1 must not insert (${table})`); },
      update() { throw new Error(`Phase-1 must not update (${table})`); },
      delete() { throw new Error(`Phase-1 must not delete (${table})`); },
      select() { return b; },
      eq(c, v) { state.filters.push({ type: 'eq', col: c, val: v }); return b; },
      ilike(c, v) { state.filters.push({ type: 'ilike', col: c, val: v }); return b; },
      in(c, v) { state.filters.push({ type: 'in', col: c, vals: v }); return b; },
      order() { return b; },
      not() { return b; },
      limit(n) { state.limit = n; return b; },
      maybeSingle() { return exec(state).then(r => ({ data: r.data?.[0] || null, error: null })); },
      single()      { return exec(state).then(r => ({ data: r.data?.[0] || null, error: null })); },
      then(o, r)    { return exec(state).then(o, r); },
    };
    return b;
  }
  function exec(state) {
    return new Promise((resolve) => {
      let data = applyFilters(rows[state.table] || [], state.filters);
      if (state.limit != null) data = data.slice(0, state.limit);
      resolve({ data: data.map(r => ({ ...r })), error: null });
    });
  }
  return { from(t) { return makeBuilder(t); } };
}

// Helper: build LB candidate (camelCase)
function lbCandidate({ leadId, externalRequestId, customerName, customerPhone, customerEmail, platform = 'yelp', status = 'completed', ageDays = 30, statusUpdatedAt = null, businessId = 'biz-test' } = {}) {
  return {
    leadId, externalRequestId, platform, businessId,
    customerName: customerName ?? null,
    customerPhone: customerPhone ?? null,
    customerEmail: customerEmail ?? null,
    status,
    createdAt: '2026-04-01T13:07:34.000Z',
    statusUpdatedAt,
    ageDays,
  };
}

const JILL_LB = lbCandidate({
  leadId: 'b5109475-396c-47a6-88de-c9d8270fe20a',
  externalRequestId: 'oDd6uAr8IEz40nfmmmsDEw',
  customerName: 'Jill S.',
  customerEmail: 'leadsapi+40b547247782458f968138ed444e8c46@messaging.yelp.com',
  platform: 'yelp',
  businessId: 'bATU27M80b_VRB2Ge8fA7A',
});
const JILL_SF_LEAD = {
  id: 107, user_id: SF_TENANT_ID,
  first_name: 'Jill', last_name: 'S.',
  phone: null,
  email: 'leadsapi+40b547247782458f968138ed444e8c46@messaging.yelp.com',
  lb_external_request_id: 'oDd6uAr8IEz40nfmmmsDEw',
  lb_channel: 'yelp',
  converted_customer_id: null,
  pipeline_id: 2, stage_id: 9,
};

beforeEach(() => {
  mockFetchCandidates.mockReset();
  mockLinkLeadsBulk.mockReset();
});

// ──────────────────────────────────────────────────────────────────────
// categorizeByMatchType — unit tests on the translator alone
// ──────────────────────────────────────────────────────────────────────
describe('categorizeByMatchType — match_type → orchestrator bucket', () => {
  test('lead_only → lead_only_match bucket; extra surfaces sf_lead_id + stage', () => {
    const cat = categorizeByMatchType({
      lbCandidate: JILL_LB,
      matchTypeResult: {
        match_type: MATCH_TYPE.LEAD_ONLY, confidence: 'exact',
        match_basis: MATCH_BASIS.EXTERNAL_REQUEST_ID,
        sf_lead_id: 107, sf_lead_stage_name: 'Contacted',
        sf_customer_id: null, sf_job_id: null,
        candidates: [], ambiguity_warnings: [], matched_sf_lead_ids: [],
        reason: null, step: 1,
      },
    });
    expect(cat.bucket).toBe('lead_only_match');
    expect(cat.extra.sf_lead_id).toBe(107);
    expect(cat.extra.sf_lead_stage_name).toBe('Contacted');
    expect(cat.extra.matcher_step).toBe(1);
  });

  test('test_noise → would_skip with reason=test_noise', () => {
    const cat = categorizeByMatchType({
      lbCandidate: lbCandidate({ leadId: 't', externalRequestId: 't-ext', platform: 'test' }),
      matchTypeResult: {
        match_type: MATCH_TYPE.TEST_NOISE, confidence: 'none', match_basis: 'none',
        reason: 'lb_test_channel', step: 0,
        sf_lead_id: null, sf_customer_id: null, sf_job_id: null,
        candidates: [], ambiguity_warnings: [], matched_sf_lead_ids: [],
      },
    });
    expect(cat.bucket).toBe('would_skip');
    expect(cat.reason).toBe('test_noise');
  });

  test('no_match → would_skip with reason=no_match', () => {
    const cat = categorizeByMatchType({
      lbCandidate: JILL_LB,
      matchTypeResult: {
        match_type: MATCH_TYPE.NO_MATCH, confidence: 'none', match_basis: 'none',
        step: 5, sf_lead_id: null, sf_customer_id: null, sf_job_id: null,
        candidates: [], ambiguity_warnings: [], matched_sf_lead_ids: [],
      },
    });
    expect(cat.bucket).toBe('would_skip');
    expect(cat.reason).toBe('no_match');
  });

  test('needs_review without candidates → would_review preserving reason', () => {
    const cat = categorizeByMatchType({
      lbCandidate: JILL_LB,
      matchTypeResult: {
        match_type: MATCH_TYPE.NEEDS_REVIEW,
        reason: 'multiple_sf_leads_for_externalRequestId',
        match_basis: MATCH_BASIS.EXTERNAL_REQUEST_ID,
        step: 1, sf_lead_id: null, sf_customer_id: null, sf_job_id: null,
        candidates: [], ambiguity_warnings: [], matched_sf_lead_ids: [],
      },
    });
    expect(cat.bucket).toBe('would_review');
    expect(cat.reason).toBe('multiple_sf_leads_for_externalRequestId');
    expect(cat.extra.wire_match_basis).toBe(MATCH_BASIS.EXTERNAL_REQUEST_ID);
  });

  test('Step-4 cross_inquiry result → would_review, matched_sf_lead_ids surfaced', () => {
    const cat = categorizeByMatchType({
      lbCandidate: JILL_LB,
      matchTypeResult: {
        match_type: MATCH_TYPE.NEEDS_REVIEW,
        reason: 'cross_inquiry_or_non_lb_sf_lead',
        match_basis: MATCH_BASIS.PHONE,
        matched_sf_lead_ids: [1716, 1717],
        step: 4, sf_lead_id: null, sf_customer_id: null, sf_job_id: null,
        candidates: [], ambiguity_warnings: [],
      },
    });
    expect(cat.bucket).toBe('would_review');
    expect(cat.extra.matched_sf_lead_ids).toEqual([1716, 1717]);
  });
});

// ──────────────────────────────────────────────────────────────────────
// runHistoricalSync integration — lead_only_match flows end-to-end
// ──────────────────────────────────────────────────────────────────────
describe('runHistoricalSync — lead_only_match bucket end-to-end', () => {
  test('Jill S. candidate → lead_only_match array; summary.would_lead_link increments', async () => {
    mockFetchCandidates.mockResolvedValue({
      ok: true, count: 1, candidates: [JILL_LB], more_may_exist: false,
    });
    const store = makeStore({
      leads: [JILL_SF_LEAD],
      lead_stages: [{ id: 9, name: 'Contacted' }],
    });
    const out = await runHistoricalSync(store, { tenantId: SF_TENANT_ID });
    expect(out.ok).toBe(true);
    expect(out.summary.fetched_from_lb).toBe(1);
    expect(out.summary.would_lead_link).toBe(1);
    expect(out.summary.would_link).toBe(0);
    expect(out.summary.would_review).toBe(0);
    expect(out.summary.would_skip).toBe(0);
    expect(out.lead_only_match).toHaveLength(1);
    expect(out.lead_only_match[0]).toEqual(expect.objectContaining({
      lb_lead_id:         'b5109475-396c-47a6-88de-c9d8270fe20a',
      sf_lead_id:         107,
      sf_lead_stage_name: 'Contacted',
    }));
    expect(mockLinkLeadsBulk).not.toHaveBeenCalled();
  });

  test('mixed batch (lead_only + customer_job + no_match) → counters split correctly', async () => {
    // ── candidates ──
    const ANTONYA = lbCandidate({
      leadId: 'lb-antonya', externalRequestId: 'EXT-ANTONYA',
      customerName: 'Antonya Cooper', customerPhone: '8005553841', platform: 'thumbtack',
    });
    const NO_REC = lbCandidate({
      leadId: 'lb-no-rec', externalRequestId: 'EXT-NO-REC',
      customerName: 'Brand New', customerPhone: '5559999999', platform: 'thumbtack',
    });
    mockFetchCandidates.mockResolvedValue({
      ok: true, count: 3, candidates: [JILL_LB, ANTONYA, NO_REC], more_may_exist: false,
    });
    const store = makeStore({
      leads: [
        JILL_SF_LEAD,
        // Antonya — SF lead via lb_external_request_id, CONVERTED
        {
          id: 2030, user_id: SF_TENANT_ID,
          lb_external_request_id: 'EXT-ANTONYA',
          converted_customer_id: 23487,
        },
      ],
      lead_stages: [{ id: 9, name: 'Contacted' }],
      jobs: [{ id: 142307, user_id: SF_TENANT_ID, customer_id: 23487, status: 'completed', payment_status: 'paid', created_at: '2026-06-03T00:00:00Z' }],
      customers: [],
    });
    const out = await runHistoricalSync(store, { tenantId: SF_TENANT_ID });
    expect(out.summary.fetched_from_lb).toBe(3);
    expect(out.summary.would_lead_link).toBe(1);   // Jill
    expect(out.summary.would_link + out.summary.would_review + out.summary.already_linked).toBeGreaterThanOrEqual(1); // Antonya
    expect(out.summary.would_skip).toBe(1);        // NO_REC → no_match
    expect(out.lead_only_match).toHaveLength(1);
    expect(out.lead_only_match[0].lb_lead_id).toBe('b5109475-396c-47a6-88de-c9d8270fe20a');
  });

  test('test_noise → would_skip (NOT lead_only_match)', async () => {
    const TEST_ROW = lbCandidate({
      leadId: 'lb-test', externalRequestId: 'cc-test-abc',
      customerName: 'Jon Daw', platform: 'test', businessId: 'fake',
    });
    mockFetchCandidates.mockResolvedValue({ ok: true, count: 1, candidates: [TEST_ROW], more_may_exist: false });
    const out = await runHistoricalSync(makeStore({}), { tenantId: SF_TENANT_ID });
    expect(out.summary.would_skip).toBe(1);
    expect(out.summary.would_lead_link).toBe(0);
    expect(out.lead_only_match).toEqual([]);
    expect(out.would_skip[0].reason).toBe('test_noise');
  });

  test('dry-run only — linkLeadsBulk NEVER invoked across mixed batch', async () => {
    mockFetchCandidates.mockResolvedValue({ ok: true, count: 1, candidates: [JILL_LB], more_may_exist: false });
    await runHistoricalSync(makeStore({ leads: [JILL_SF_LEAD], lead_stages: [{ id: 9, name: 'Contacted' }] }), { tenantId: SF_TENANT_ID });
    expect(mockLinkLeadsBulk).not.toHaveBeenCalled();
  });
});
