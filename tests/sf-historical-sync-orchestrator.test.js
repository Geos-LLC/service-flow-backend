'use strict';

/**
 * SF-driven historical sync orchestrator — Phase 1 (DRY-RUN ONLY).
 *
 * Tests against LB's PRODUCTION contract:
 *   - candidates use camelCase fields (leadId, externalRequestId,
 *     platform, businessId, customerName, customerPhone, customerEmail,
 *     status, createdAt, statusUpdatedAt, ageDays)
 *   - request shape: { user_id, sync_statuses, limit }
 *   - response shape: { ok, user_id, count, candidates }
 *   - no cursor pagination; single batch + more_may_exist signal
 *
 * Covers:
 *   - LB user UUID lookup from communication_settings
 *   - dry_run FORCED true; orchestrator never invokes linkLeadsBulk
 *   - Erin Davis fixture (LB camelCase) lands in would_link
 *   - bucketing: would_link / would_review / would_skip
 *   - ambiguous + no-match + low-confidence + sf-job-linked-elsewhere
 *   - more_may_exist=true when count === limit
 *   - LB fetch error → ok:false with status passed through
 *   - LB user not connected → 409 lb_not_connected
 *   - missing leadbridge_user_id → 409 lb_user_id_missing
 *   - field mapping: lbLeadToMatcherInput reads camelCase
 */

process.env.SF_LB_PROVISIONING_SHARED_SECRET = 'p1-orch-test-' + 'B'.repeat(20);
process.env.LB_PROVISIONING_BASE_URL          = 'https://lb-test.example.com/api';

// Mock the LB client before requiring the orchestrator
const mockFetchCandidates = jest.fn();
const mockLinkLeadsBulk   = jest.fn();
jest.mock('../lib/lb-historical-sync-client', () => ({
  fetchCandidates: (...args) => mockFetchCandidates(...args),
  linkLeadsBulk:   (...args) => mockLinkLeadsBulk(...args),
  CANDIDATES_PATH: '/v1/integrations/sf/historical-sync/candidates',
  LINK_BULK_PATH:  '/v1/integrations/sf/link-leads-bulk',
}));

const {
  runHistoricalSync,
  resolveLbUserId,
  shouldAutoLink,
  categorize,
  lbLeadToMatcherInput,
  buildBucketEntry,
  MAX_LEADS_HARD_CAP,
  MAX_LEADS_DEFAULT,
} = require('../lib/sf-historical-sync-orchestrator');

// Tenant 2's actual production LB account UUID
const LB_USER_UUID = 'c3d14499-dec1-42c3-a36c-713cb09842c6';
const SF_TENANT_ID = 2;

// In-memory Supabase mock — supports communication_settings + customers + jobs.
// Refuses any insert/update on jobs/customers/audit/outbox (proves no writes).
function makeStore({ customers = [], jobs = [], commSettings = null } = {}) {
  const rows = {
    customers,
    jobs,
    communication_settings: commSettings === null
      ? [{ user_id: SF_TENANT_ID, leadbridge_user_id: LB_USER_UUID, leadbridge_connected: true }]
      : (Array.isArray(commSettings) ? commSettings : [commSettings]),
  };
  function applyFilters(rs, filters) {
    return rs.filter((r) => filters.every((f) => {
      if (f.type === 'eq')    return String(r[f.col]) === String(f.val);
      if (f.type === 'ilike') {
        const v = String(r[f.col] == null ? '' : r[f.col]);
        const pat = String(f.val);
        if (pat.startsWith('%') && pat.endsWith('%')) return v.toLowerCase().includes(pat.slice(1,-1).toLowerCase());
        return v.toLowerCase() === pat.toLowerCase();
      }
      if (f.type === 'in')    return f.vals.map(String).includes(String(r[f.col]));
      return true;
    }));
  }
  function makeBuilder(table) {
    const state = { table, op: null, filters: [], limit: null, order: null };
    const builder = {
      _state: state,
      insert() { throw new Error('Phase-1 must not insert (' + table + ')'); },
      update() { throw new Error('Phase-1 must not update (' + table + ')'); },
      select() { return builder; },
      eq(c, v)    { state.filters.push({ type: 'eq', col: c, val: v }); return builder; },
      ilike(c, v) { state.filters.push({ type: 'ilike', col: c, val: v }); return builder; },
      in(c, v)    { state.filters.push({ type: 'in', col: c, vals: v }); return builder; },
      limit(n)    { state.limit = n; return builder; },
      order()     { return builder; },
      maybeSingle() { return exec(state).then(maybeSingle); },
      single()      { return exec(state).then(single); },
      then(onF, onR){ return exec(state).then(onF, onR); },
    };
    return builder;
  }
  function exec(state) {
    return new Promise((resolve) => {
      const T = state.table;
      if (!rows[T]) rows[T] = [];
      let matched = applyFilters(rows[T], state.filters);
      if (state.limit != null) matched = matched.slice(0, state.limit);
      resolve({ data: matched.map((r) => ({ ...r })), error: null });
    });
  }
  function single({ data, error }) {
    if (error) return { data: null, error };
    if (Array.isArray(data)) return data.length ? { data: data[0], error: null } : { data: null, error: { code: 'PGRST116' } };
    return { data, error: null };
  }
  function maybeSingle({ data, error }) {
    if (error) return { data: null, error };
    if (Array.isArray(data)) return { data: data[0] || null, error: null };
    return { data: data || null, error: null };
  }
  return { _rows: rows, from(t) { return makeBuilder(t); } };
}

// ──────────────────────────────────────────────────────────────
// Erin Davis fixtures using LB's PRODUCTION shape (camelCase)
// ──────────────────────────────────────────────────────────────
const ERIN_CUST = {
  id: 23427, user_id: SF_TENANT_ID,
  first_name: 'Erin', last_name: 'Davis',
  phone: '8133752443', email: null,
  lb_lead_id: null,
  created_at: '2026-04-16T14:01:00Z',
};
const ERIN_JOB = {
  id: 141929, user_id: SF_TENANT_ID, customer_id: 23427,
  status: 'completed', payment_status: 'paid', payment_date: null,
  scheduled_date: '2026-05-05T15:00:00Z',
  invoice_amount: null, total_amount: 349,
  lb_external_request_id: null, lb_channel: null, lb_business_id: null, lb_lead_id: null,
  last_status_changed_at: '2026-05-05T22:44:31Z',
  created_at: '2026-04-16T15:43:15Z',
};
// LB's actual candidate shape per the production contract
const ERIN_LB_CANDIDATE = {
  leadId:            '65d7a387-aa7b-45fc-b9a2-1f36bf92c7ec',
  externalRequestId: '574011065576308746',
  platform:          'thumbtack',
  businessId:        '532386425642459138',
  customerName:      'Erin Davis',
  customerPhone:     '8133752443',
  customerEmail:     null,
  status:            'scheduled',
  createdAt:         '2026-03-10T15:31:00Z',
  statusUpdatedAt:   '2026-03-15T15:45:51Z',
  ageDays:           82,
};

beforeEach(() => {
  mockFetchCandidates.mockReset();
  mockLinkLeadsBulk.mockReset();
});

// ──────────────────────────────────────────────────────────────
// Field mapping
// ──────────────────────────────────────────────────────────────
describe('lbLeadToMatcherInput', () => {
  test('maps LB camelCase candidate → matcher input', () => {
    expect(lbLeadToMatcherInput(ERIN_LB_CANDIDATE)).toEqual({
      lb_lead_id:             '65d7a387-aa7b-45fc-b9a2-1f36bf92c7ec',
      lb_external_request_id: '574011065576308746',
      lb_channel:             'thumbtack',
      lb_business_id:         '532386425642459138',
      customer_phone:         '8133752443',
      customer_email:         null,
      customer_name:          'Erin Davis',
      lead_created_at:        '2026-03-10T15:31:00Z',
    });
  });
  test('returns all-null for non-object input', () => {
    expect(lbLeadToMatcherInput(null).lb_lead_id).toBeNull();
    expect(lbLeadToMatcherInput(undefined).lb_lead_id).toBeNull();
  });
});

describe('buildBucketEntry — surfaces LB camelCase fields', () => {
  test('includes lb_status_updated_at, lb_age_days, lb_customer_name', () => {
    const entry = buildBucketEntry(ERIN_LB_CANDIDATE, [{
      sf_customer_id: 23427, sf_job_id: 141929,
      confidence: 'high',
      match_signals: ['phone_exact:…2443','name_exact'],
      sf_job: { status: 'completed', payment_status: 'paid' },
      ambiguity_warnings: [],
    }], null);
    expect(entry).toEqual(expect.objectContaining({
      lb_lead_id:             '65d7a387-aa7b-45fc-b9a2-1f36bf92c7ec',
      lb_external_request_id: '574011065576308746',
      lb_channel:             'thumbtack',
      lb_business_id:         '532386425642459138',
      lb_lead_status:         'scheduled',
      lb_lead_created_at:     '2026-03-10T15:31:00Z',
      lb_status_updated_at:   '2026-03-15T15:45:51Z',
      lb_age_days:            82,
      lb_customer_name:       'Erin Davis',
      sf_customer_id:         23427,
      sf_job_id:              141929,
      sf_job_status:          'completed',
      sf_payment_status:      'paid',
      confidence:             'high',
      match_basis:            ['phone_exact:…2443','name_exact'],
      reason:                 null,
      candidate_count:        1,
    }));
  });
});

// ──────────────────────────────────────────────────────────────
// resolveLbUserId
// ──────────────────────────────────────────────────────────────
describe('resolveLbUserId', () => {
  test('returns lbUserId from communication_settings', async () => {
    const store = makeStore();
    const r = await resolveLbUserId(store, SF_TENANT_ID);
    expect(r.ok).toBe(true);
    expect(r.lbUserId).toBe(LB_USER_UUID);
  });
  test('no comm_settings row → 404', async () => {
    const store = makeStore({ commSettings: [] });
    const r = await resolveLbUserId(store, 999);
    expect(r.ok).toBe(false);
    expect(r.status).toBe(404);
    expect(r.error).toBe('communication_settings_not_found');
  });
  test('leadbridge_connected=false → 409 lb_not_connected', async () => {
    const store = makeStore({ commSettings: [{ user_id: SF_TENANT_ID, leadbridge_user_id: LB_USER_UUID, leadbridge_connected: false }] });
    const r = await resolveLbUserId(store, SF_TENANT_ID);
    expect(r.ok).toBe(false);
    expect(r.status).toBe(409);
    expect(r.error).toBe('lb_not_connected');
  });
  test('leadbridge_user_id null → 409 lb_user_id_missing', async () => {
    const store = makeStore({ commSettings: [{ user_id: SF_TENANT_ID, leadbridge_user_id: null, leadbridge_connected: true }] });
    const r = await resolveLbUserId(store, SF_TENANT_ID);
    expect(r.ok).toBe(false);
    expect(r.status).toBe(409);
    expect(r.error).toBe('lb_user_id_missing');
  });
});

// ──────────────────────────────────────────────────────────────
// Bucketing
// ──────────────────────────────────────────────────────────────
describe('categorize — reads externalRequestId from LB candidate', () => {
  test('single high-confidence + target SF job unlinked → would_link', () => {
    const cat = categorize({
      lbCandidate: ERIN_LB_CANDIDATE,
      matched: [{
        sf_customer_id: 23427, sf_job_id: 141929,
        confidence: 'high',
        match_signals: ['phone_exact:…2443','name_exact'],
        sf_job: { lb_external_request_id: null },
        ambiguity_warnings: [],
      }],
    });
    expect(cat.bucket).toBe('would_link');
  });
  test('target SF job linked to different externalRequestId → would_review', () => {
    const cat = categorize({
      lbCandidate: ERIN_LB_CANDIDATE,
      matched: [{
        sf_customer_id: 23427, sf_job_id: 141929,
        confidence: 'high',
        match_signals: ['phone_exact:…2443'],
        sf_job: { lb_external_request_id: 'OTHER_REQ' },
        ambiguity_warnings: [],
      }],
    });
    expect(cat.bucket).toBe('would_review');
    expect(cat.reason).toBe('sf_job_linked_to_different_lb_lead');
  });
  test('zero candidates → would_skip reason=no_match', () => {
    const cat = categorize({ lbCandidate: ERIN_LB_CANDIDATE, matched: [] });
    expect(cat.bucket).toBe('would_skip');
    expect(cat.reason).toBe('no_match');
  });

  // ────────────────────────────────────────────────────────────────
  // already_reconciled_customer guard. Prevents resurfacing rows for
  // customers already linked in earlier batches (the 44-row scenario
  // exposed when PR #39's tiered picker moved to an earlier unlinked
  // job for recurring customers whose later jobs hold the LB lead
  // from Batches #1–#5).
  //
  // Position rule: this check runs BEFORE the conflict check
  // (sf_job_linked_to_different_lb_lead), because already-reconciled
  // is a stronger signal — operator action is "leave it alone".
  // ────────────────────────────────────────────────────────────────
  test('single high match + sf_customer.lb_lead_id set → would_skip reason=already_reconciled_customer', () => {
    const cat = categorize({
      lbCandidate: ERIN_LB_CANDIDATE,
      matched: [{
        sf_customer_id: 23427, sf_job_id: 141929,
        confidence: 'high',
        match_signals: ['phone_exact:…2443', 'name_exact'],
        sf_customer: { lb_lead_id: 'lb-uuid-prior-batch', any_job_linked: true },
        sf_job: { lb_external_request_id: null },
        ambiguity_warnings: [],
      }],
    });
    expect(cat.bucket).toBe('would_skip');
    expect(cat.reason).toBe('already_reconciled_customer');
  });
  test('single high match + sf_customer.any_job_linked=true (customer.lb_lead_id null) → would_skip already_reconciled_customer', () => {
    const cat = categorize({
      lbCandidate: ERIN_LB_CANDIDATE,
      matched: [{
        sf_customer_id: 23427, sf_job_id: 141929,
        confidence: 'high',
        match_signals: ['phone_exact:…2443'],
        sf_customer: { lb_lead_id: null, any_job_linked: true },
        sf_job: { lb_external_request_id: null },
        ambiguity_warnings: [],
      }],
    });
    expect(cat.bucket).toBe('would_skip');
    expect(cat.reason).toBe('already_reconciled_customer');
  });
  test('single high match + no prior link on customer → still would_link (negative case)', () => {
    const cat = categorize({
      lbCandidate: ERIN_LB_CANDIDATE,
      matched: [{
        sf_customer_id: 23427, sf_job_id: 141929,
        confidence: 'high',
        match_signals: ['phone_exact:…2443'],
        sf_customer: { lb_lead_id: null, any_job_linked: false },
        sf_job: { lb_external_request_id: null },
        ambiguity_warnings: [],
      }],
    });
    expect(cat.bucket).toBe('would_link');
    expect(cat.reason).toBeNull();
  });
  test('already_reconciled_customer takes precedence over sf_job_linked_to_different_lb_lead conflict', () => {
    // Customer is already reconciled AND the picked sf_job is also
    // linked to a different lb_external_request_id. The guard wins:
    // surface as already_reconciled_customer, not as a conflict.
    const cat = categorize({
      lbCandidate: ERIN_LB_CANDIDATE,
      matched: [{
        sf_customer_id: 23427, sf_job_id: 141929,
        confidence: 'high',
        match_signals: ['phone_exact:…2443'],
        sf_customer: { lb_lead_id: 'lb-uuid-prior-batch', any_job_linked: true },
        sf_job: { lb_external_request_id: 'OTHER_REQ' },
        ambiguity_warnings: [],
      }],
    });
    expect(cat.bucket).toBe('would_skip');
    expect(cat.reason).toBe('already_reconciled_customer');
  });
});

// ──────────────────────────────────────────────────────────────
// runHistoricalSync — Phase 1 invariants
// ──────────────────────────────────────────────────────────────
describe('runHistoricalSync — Phase 1 invariants', () => {
  test('dry_run is forced TRUE; explicit dryRun:false ignored', async () => {
    const store = makeStore();
    mockFetchCandidates.mockResolvedValueOnce({ ok: true, user_id: LB_USER_UUID, count: 0, candidates: [], more_may_exist: false });
    const out = await runHistoricalSync(store, { tenantId: SF_TENANT_ID, dryRun: false });
    expect(out.dry_run).toBe(true);
    expect(out.phase).toBe('phase_1_dry_run_only');
  });

  test('NEVER calls linkLeadsBulk', async () => {
    const store = makeStore({ customers: [ERIN_CUST], jobs: [ERIN_JOB] });
    mockFetchCandidates.mockResolvedValueOnce({ ok: true, user_id: LB_USER_UUID, count: 1, candidates: [ERIN_LB_CANDIDATE], more_may_exist: false });
    await runHistoricalSync(store, { tenantId: SF_TENANT_ID });
    expect(mockLinkLeadsBulk).not.toHaveBeenCalled();
  });

  test('NEVER attempts to write to jobs/customers (mock throws on insert/update)', async () => {
    const store = makeStore({ customers: [ERIN_CUST], jobs: [ERIN_JOB] });
    mockFetchCandidates.mockResolvedValueOnce({ ok: true, user_id: LB_USER_UUID, count: 1, candidates: [ERIN_LB_CANDIDATE], more_may_exist: false });
    const out = await runHistoricalSync(store, { tenantId: SF_TENANT_ID });
    expect(out.summary.errors).toBe(0);
  });

  test('passes user_id (LB UUID) — NOT sf_tenant_id — to fetchCandidates', async () => {
    const store = makeStore();
    mockFetchCandidates.mockResolvedValueOnce({ ok: true, user_id: LB_USER_UUID, count: 0, candidates: [], more_may_exist: false });
    await runHistoricalSync(store, { tenantId: SF_TENANT_ID });
    expect(mockFetchCandidates).toHaveBeenCalledTimes(1);
    const args = mockFetchCandidates.mock.calls[0][0];
    expect(args.lbUserId).toBe(LB_USER_UUID);
    expect(args.syncStatuses).toEqual(['pending']);
    expect(args).not.toHaveProperty('tenantId');
    expect(args).not.toHaveProperty('cursor');
    expect(args).not.toHaveProperty('onlyUnlinked');
  });

  test('NO cursor loop — single fetchCandidates call', async () => {
    const store = makeStore();
    mockFetchCandidates.mockResolvedValueOnce({ ok: true, user_id: LB_USER_UUID, count: 500, candidates: Array.from({length:500},(_,i)=>({leadId:'l'+i})), more_may_exist: true });
    await runHistoricalSync(store, { tenantId: SF_TENANT_ID, maxLeads: 500 });
    expect(mockFetchCandidates).toHaveBeenCalledTimes(1);
  });

  test('forwards optional LB `status` filter when provided', async () => {
    const store = makeStore();
    mockFetchCandidates.mockResolvedValueOnce({ ok: true, user_id: LB_USER_UUID, count: 0, candidates: [], more_may_exist: false });
    const out = await runHistoricalSync(store, { tenantId: SF_TENANT_ID, status: 'scheduled' });
    expect(mockFetchCandidates.mock.calls[0][0].status).toBe('scheduled');
    expect(out.summary.status_filter).toBe('scheduled');
  });

  test('omits LB `status` filter when not provided (status_filter=null)', async () => {
    const store = makeStore();
    mockFetchCandidates.mockResolvedValueOnce({ ok: true, user_id: LB_USER_UUID, count: 0, candidates: [], more_may_exist: false });
    const out = await runHistoricalSync(store, { tenantId: SF_TENANT_ID });
    expect(mockFetchCandidates.mock.calls[0][0].status).toBeUndefined();
    expect(out.summary.status_filter).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────
// Erin Davis fixture — the headline case
// ──────────────────────────────────────────────────────────────
describe('runHistoricalSync — Erin Davis (LB production shape)', () => {
  test('lands in would_link with confidence=high + full operator context', async () => {
    const store = makeStore({ customers: [ERIN_CUST], jobs: [ERIN_JOB] });
    mockFetchCandidates.mockResolvedValueOnce({
      ok: true, user_id: LB_USER_UUID, count: 1,
      candidates: [ERIN_LB_CANDIDATE], more_may_exist: false,
    });

    const out = await runHistoricalSync(store, { tenantId: SF_TENANT_ID });

    expect(out.ok).toBe(true);
    expect(out.dry_run).toBe(true);
    expect(out.phase).toBe('phase_1_dry_run_only');
    expect(out.summary).toEqual(expect.objectContaining({
      lb_user_id:      LB_USER_UUID,
      fetched_from_lb: 1,
      would_link:      1,
      would_review:    0,
      would_skip:      0,
      errors:          0,
      more_may_exist:  false,
    }));
    expect(out.would_link).toHaveLength(1);

    const e = out.would_link[0];
    // LB fields
    expect(e.lb_lead_id).toBe('65d7a387-aa7b-45fc-b9a2-1f36bf92c7ec');
    expect(e.lb_external_request_id).toBe('574011065576308746');
    expect(e.lb_channel).toBe('thumbtack');
    expect(e.lb_business_id).toBe('532386425642459138');
    expect(e.lb_lead_status).toBe('scheduled');
    expect(e.lb_lead_created_at).toBe('2026-03-10T15:31:00Z');
    expect(e.lb_status_updated_at).toBe('2026-03-15T15:45:51Z');
    expect(e.lb_age_days).toBe(82);
    expect(e.lb_customer_name).toBe('Erin Davis');
    // SF fields
    expect(e.sf_customer_id).toBe(23427);
    expect(e.sf_job_id).toBe(141929);
    expect(e.sf_job_status).toBe('completed');
    expect(e.sf_payment_status).toBe('paid');
    // Match
    expect(e.confidence).toBe('high');
    expect(e.match_basis).toEqual(expect.arrayContaining(['phone_exact:…2443','name_exact']));
    expect(e.reason).toBeNull();
    expect(e.ambiguity_warnings).toEqual([]);
  });
});

// ──────────────────────────────────────────────────────────────
// more_may_exist semantics
// ──────────────────────────────────────────────────────────────
describe('runHistoricalSync — more_may_exist', () => {
  test('summary.more_may_exist=true when LB returns count === limit', async () => {
    const store = makeStore();
    mockFetchCandidates.mockResolvedValueOnce({
      ok: true, user_id: LB_USER_UUID, count: 500,
      candidates: Array.from({length:500},(_,i)=>({leadId:'l'+i})),
      more_may_exist: true,
    });
    const out = await runHistoricalSync(store, { tenantId: SF_TENANT_ID, maxLeads: 500 });
    expect(out.summary.more_may_exist).toBe(true);
  });
  test('summary.more_may_exist=false when count < limit', async () => {
    const store = makeStore();
    mockFetchCandidates.mockResolvedValueOnce({
      ok: true, user_id: LB_USER_UUID, count: 18,
      candidates: Array.from({length:18},(_,i)=>({leadId:'l'+i})),
      more_may_exist: false,
    });
    const out = await runHistoricalSync(store, { tenantId: SF_TENANT_ID });
    expect(out.summary.more_may_exist).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────
// LB user lookup failures (endpoint-facing)
// ──────────────────────────────────────────────────────────────
describe('runHistoricalSync — LB user lookup failures', () => {
  test('lb_not_connected → 409, no LB call', async () => {
    const store = makeStore({ commSettings: [{ user_id: SF_TENANT_ID, leadbridge_user_id: LB_USER_UUID, leadbridge_connected: false }] });
    const out = await runHistoricalSync(store, { tenantId: SF_TENANT_ID });
    expect(out.ok).toBe(false);
    expect(out.status).toBe(409);
    expect(out.error).toBe('lb_not_connected');
    expect(mockFetchCandidates).not.toHaveBeenCalled();
  });
  test('lb_user_id_missing → 409, no LB call', async () => {
    const store = makeStore({ commSettings: [{ user_id: SF_TENANT_ID, leadbridge_user_id: null, leadbridge_connected: true }] });
    const out = await runHistoricalSync(store, { tenantId: SF_TENANT_ID });
    expect(out.ok).toBe(false);
    expect(out.error).toBe('lb_user_id_missing');
    expect(mockFetchCandidates).not.toHaveBeenCalled();
  });
});

// ──────────────────────────────────────────────────────────────
// Bucket behaviors with new candidate shape
// ──────────────────────────────────────────────────────────────
describe('runHistoricalSync — bucket behaviors', () => {
  test('two high-confidence candidates → would_review reason=multiple_candidates', async () => {
    const dupA = { ...ERIN_CUST, id: 1 };
    const dupB = { ...ERIN_CUST, id: 2, first_name: 'Different' };
    const jobs = [{ ...ERIN_JOB, id: 11, customer_id: 1 }, { ...ERIN_JOB, id: 12, customer_id: 2 }];
    const store = makeStore({ customers: [dupA, dupB], jobs });
    mockFetchCandidates.mockResolvedValueOnce({ ok: true, user_id: LB_USER_UUID, count: 1, candidates: [ERIN_LB_CANDIDATE], more_may_exist: false });
    const out = await runHistoricalSync(store, { tenantId: SF_TENANT_ID });
    expect(out.summary.would_review).toBe(1);
    expect(out.summary.would_link).toBe(0);
    expect(out.would_review[0].reason).toBe('multiple_candidates');
  });

  test('no match → would_skip reason=no_match', async () => {
    const store = makeStore({ customers: [], jobs: [] });
    mockFetchCandidates.mockResolvedValueOnce({ ok: true, user_id: LB_USER_UUID, count: 1, candidates: [ERIN_LB_CANDIDATE], more_may_exist: false });
    const out = await runHistoricalSync(store, { tenantId: SF_TENANT_ID });
    expect(out.summary.would_skip).toBe(1);
    expect(out.would_skip[0].reason).toBe('no_match');
  });

  test('mixed batch: link + review + skip all populated', async () => {
    const erinCust = ERIN_CUST;
    const otherCust = { id: 999, user_id: SF_TENANT_ID, first_name: 'Other', last_name: 'Person', phone: null, email: null, lb_lead_id: null, created_at: '2026-04-01T00:00:00Z' };
    const store = makeStore({ customers: [erinCust, otherCust], jobs: [ERIN_JOB] });
    mockFetchCandidates.mockResolvedValueOnce({
      ok: true, user_id: LB_USER_UUID, count: 3,
      candidates: [
        ERIN_LB_CANDIDATE,
        { leadId: 'lb-low', customerName: 'Other Person', customerPhone: null, platform: 'thumbtack', status: 'new', createdAt: '2026-05-01T00:00:00Z' },
        { leadId: 'lb-nomatch', customerPhone: '0000000000', customerName: 'Nobody Here', platform: 'yelp', status: 'new', createdAt: '2026-05-01T00:00:00Z' },
      ],
      more_may_exist: false,
    });
    const out = await runHistoricalSync(store, { tenantId: SF_TENANT_ID });
    expect(out.summary.would_link).toBe(1);
    expect(out.summary.would_skip).toBe(2);
  });
});

// ──────────────────────────────────────────────────────────────
// LB error pass-through
// ──────────────────────────────────────────────────────────────
describe('runHistoricalSync — LB error', () => {
  test('fetch error → ok:false with status passed through', async () => {
    const store = makeStore();
    mockFetchCandidates.mockResolvedValueOnce({ ok: false, status: 502, reason: 'bad_gateway', error_description: 'lb down' });
    const out = await runHistoricalSync(store, { tenantId: SF_TENANT_ID });
    expect(out.ok).toBe(false);
    expect(out.status).toBe(502);
    expect(out.error).toBe('bad_gateway');
  });
});

// ──────────────────────────────────────────────────────────────
// Constants
// ──────────────────────────────────────────────────────────────
describe('constants', () => {
  test('MAX_LEADS_HARD_CAP = 500 (LB caps batch)', () => {
    expect(MAX_LEADS_HARD_CAP).toBe(500);
    expect(MAX_LEADS_DEFAULT).toBe(500);
  });
});
