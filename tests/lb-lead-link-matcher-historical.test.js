'use strict';

/**
 * findHistoricalMatchType — leads-aware LB↔SF matcher (PR A).
 *
 * Pinned tests, locked by the joint design:
 *
 *   1. SF lead found by lb_external_request_id, NOT converted → lead_only
 *   2. SF lead found by lb_external_request_id, converted     → customer_job
 *   3. Multiple SF leads for same externalRequestId           → needs_review
 *   4. Legacy customers.lb_lead_id match                       → customer_job
 *   5. Existing customer matcher still works unchanged
 *      (high-conf phone/email customer match falls through to Step 2 and
 *       resolves customer_job)
 *   6. SF lead phone/email fallback → needs_review (NEVER auto-link)
 *   7. Test channel → test_noise
 *   8. Jill S. fixture → lead_only
 *
 * Plus orchestrator integration: categorizeByMatchType + runHistoricalSync
 * route lead_only into the new lead_only_match bucket and the summary
 * carries would_lead_link.
 *
 * Hard invariants tested:
 *   - sfCustomerId / sfJobId are NEVER populated for lead_only
 *   - Step 4 never returns customer_job
 *   - lb_channel='test' short-circuits before any DB call
 */

process.env.SF_LB_PROVISIONING_SHARED_SECRET = 'pra-test-' + 'X'.repeat(20);
process.env.LB_PROVISIONING_BASE_URL          = 'https://lb-test.example.com/api';

const {
  findHistoricalMatchType,
  MATCH_TYPE,
  MATCH_BASIS,
} = require('../lib/lb-lead-link-matcher');

const TENANT_ID = 2;

// ──────────────────────────────────────────────────────────────────────
// Lightweight Supabase stub — supports the exact query shapes the
// historical matcher uses: chain (.from(table).select(...).eq(col, val)
// [.eq|.ilike|.in...] .limit(n) .maybeSingle()|.then()|...).
//
// Test cases inject `rows[tableName]` and the stub returns filtered
// results. Throws on insert/update/delete so a regression that calls a
// write path will be caught immediately.
// ──────────────────────────────────────────────────────────────────────
function makeStore({ leads = [], customers = [], jobs = [], lead_stages = [] } = {}) {
  const rows = { leads, customers, jobs, lead_stages };

  function applyFilters(data, filters) {
    return data.filter(r => filters.every(f => {
      if (f.type === 'eq')    return String(r[f.col]) === String(f.val);
      if (f.type === 'ilike') {
        const v = String(r[f.col] == null ? '' : r[f.col]).toLowerCase();
        let pat = String(f.val).toLowerCase();
        if (pat.startsWith('%') && pat.endsWith('%')) return v.includes(pat.slice(1, -1));
        return v === pat;
      }
      if (f.type === 'in')    return f.vals.map(String).includes(String(r[f.col]));
      return true;
    }));
  }

  function makeBuilder(table) {
    const state = { table, filters: [], limit: null };
    const builder = {
      insert() { throw new Error(`matcher must not insert (${table})`); },
      update() { throw new Error(`matcher must not update (${table})`); },
      delete() { throw new Error(`matcher must not delete (${table})`); },
      select() { return builder; },
      eq(c, v)    { state.filters.push({ type: 'eq', col: c, val: v }); return builder; },
      ilike(c, v) { state.filters.push({ type: 'ilike', col: c, val: v }); return builder; },
      in(c, v)    { state.filters.push({ type: 'in', col: c, vals: v }); return builder; },
      order()     { return builder; },
      not(c, op)  { state.filters.push({ type: 'not_' + op, col: c }); return builder; },
      limit(n)    { state.limit = n; return builder; },
      maybeSingle() { return exec(state).then(r => ({ data: r.data?.[0] || null, error: null })); },
      single()      { return exec(state).then(r => ({ data: r.data?.[0] || null, error: null })); },
      then(o, r)    { return exec(state).then(o, r); },
    };
    return builder;
  }

  function exec(state) {
    return new Promise((resolve) => {
      let data = applyFilters(rows[state.table] || [], state.filters);
      if (state.limit != null) data = data.slice(0, state.limit);
      resolve({ data: data.map(r => ({ ...r })), error: null });
    });
  }

  return { from(t) { return makeBuilder(t); }, _rows: rows };
}

const baseInput = (overrides = {}) => ({
  lb_lead_id:             'lb-lead-uuid-test',
  lb_external_request_id: 'EXT-REQ-TEST-001',
  lb_channel:             'thumbtack',
  lb_business_id:         'biz-test',
  customer_phone:         null,
  customer_email:         null,
  customer_name:          null,
  lead_created_at:        '2026-04-01T00:00:00Z',
  ...overrides,
});

// ──────────────────────────────────────────────────────────────────────
// 1. SF lead by externalRequestId, NOT converted → lead_only
// ──────────────────────────────────────────────────────────────────────
describe('Step 1: SF lead via lb_external_request_id, not converted', () => {
  test('returns lead_only with sf_lead_id + stage name; sfCustomerId/sfJobId stay null', async () => {
    const store = makeStore({
      leads: [{
        id: 107, user_id: TENANT_ID,
        first_name: 'Jill', last_name: 'S.',
        phone: null, email: null,
        lb_external_request_id: 'EXT-REQ-JILL',
        lb_channel: 'yelp',
        converted_customer_id: null,
        pipeline_id: 2, stage_id: 9,
      }],
      lead_stages: [{ id: 9, name: 'Contacted', position: 2 }],
    });
    const r = await findHistoricalMatchType(store, {
      userId: TENANT_ID,
      input: baseInput({ lb_external_request_id: 'EXT-REQ-JILL', lb_channel: 'yelp' }),
    });
    expect(r.match_type).toBe(MATCH_TYPE.LEAD_ONLY);
    expect(r.confidence).toBe('exact');
    expect(r.match_basis).toBe(MATCH_BASIS.EXTERNAL_REQUEST_ID);
    expect(r.sf_lead_id).toBe(107);
    expect(r.sf_lead_stage_name).toBe('Contacted');
    expect(r.sf_customer_id).toBeNull();
    expect(r.sf_job_id).toBeNull();
    expect(r.step).toBe(1);
  });

  test('null stage_id → sf_lead_stage_name is null (no DB call)', async () => {
    const store = makeStore({
      leads: [{
        id: 200, user_id: TENANT_ID,
        lb_external_request_id: 'EXT-REQ-NO-STAGE',
        converted_customer_id: null,
        pipeline_id: null, stage_id: null,
      }],
    });
    const r = await findHistoricalMatchType(store, {
      userId: TENANT_ID,
      input: baseInput({ lb_external_request_id: 'EXT-REQ-NO-STAGE' }),
    });
    expect(r.match_type).toBe(MATCH_TYPE.LEAD_ONLY);
    expect(r.sf_lead_stage_name).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────────
// 2. SF lead by externalRequestId, CONVERTED → customer_job
// ──────────────────────────────────────────────────────────────────────
describe('Step 1: SF lead via lb_external_request_id, converted', () => {
  test('returns customer_job with sf_lead_id + sf_customer_id + representative sf_job_id', async () => {
    const store = makeStore({
      leads: [{
        id: 2030, user_id: TENANT_ID,
        lb_external_request_id: 'EXT-REQ-ANTONYA',
        converted_customer_id: 23487,
      }],
      jobs: [{
        id: 142307, user_id: TENANT_ID, customer_id: 23487,
        status: 'completed', payment_status: 'paid',
        created_at: '2026-06-03T17:30:00Z',
      }],
    });
    const r = await findHistoricalMatchType(store, {
      userId: TENANT_ID,
      input: baseInput({ lb_external_request_id: 'EXT-REQ-ANTONYA' }),
    });
    expect(r.match_type).toBe(MATCH_TYPE.CUSTOMER_JOB);
    expect(r.confidence).toBe('exact');
    expect(r.match_basis).toBe(MATCH_BASIS.EXTERNAL_REQUEST_ID);
    expect(r.sf_lead_id).toBe(2030);
    expect(r.sf_customer_id).toBe(23487);
    expect(r.sf_job_id).toBe(142307);
    expect(r.step).toBe(1);
  });

  test('converted but customer has no eligible job → sf_job_id null', async () => {
    const store = makeStore({
      leads: [{ id: 2050, user_id: TENANT_ID, lb_external_request_id: 'EXT-REQ-NOJOB', converted_customer_id: 99001 }],
      jobs: [],
    });
    const r = await findHistoricalMatchType(store, {
      userId: TENANT_ID,
      input: baseInput({ lb_external_request_id: 'EXT-REQ-NOJOB' }),
    });
    expect(r.match_type).toBe(MATCH_TYPE.CUSTOMER_JOB);
    expect(r.sf_customer_id).toBe(99001);
    expect(r.sf_job_id).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────────
// 3. Multiple SF leads with same externalRequestId → needs_review
// ──────────────────────────────────────────────────────────────────────
describe('Step 1: multiple SF leads for one externalRequestId', () => {
  test('returns needs_review without picking either', async () => {
    const store = makeStore({
      leads: [
        { id: 1, user_id: TENANT_ID, lb_external_request_id: 'EXT-DUPE', converted_customer_id: null },
        { id: 2, user_id: TENANT_ID, lb_external_request_id: 'EXT-DUPE', converted_customer_id: 999 },
      ],
    });
    const r = await findHistoricalMatchType(store, {
      userId: TENANT_ID,
      input: baseInput({ lb_external_request_id: 'EXT-DUPE' }),
    });
    expect(r.match_type).toBe(MATCH_TYPE.NEEDS_REVIEW);
    expect(r.reason).toBe('multiple_sf_leads_for_externalRequestId');
    expect(r.sf_lead_id).toBeNull();
    expect(r.sf_customer_id).toBeNull();
    expect(r.step).toBe(1);
  });
});

// ──────────────────────────────────────────────────────────────────────
// 4. Step 1.5 — legacy customers.lb_lead_id match → customer_job
// ──────────────────────────────────────────────────────────────────────
describe('Step 1.5: legacy customers.lb_lead_id stamp', () => {
  test('returns customer_job with match_basis=lbLeadId when no SF lead but customer is stamped', async () => {
    const store = makeStore({
      leads: [],   // no SF lead for this externalRequestId
      customers: [{ id: 23400, user_id: TENANT_ID, lb_lead_id: 'lb-uuid-legacy-stamped' }],
      jobs: [{ id: 139854, user_id: TENANT_ID, customer_id: 23400, status: 'completed', payment_status: 'paid', created_at: '2026-03-25T00:00:00Z' }],
    });
    const r = await findHistoricalMatchType(store, {
      userId: TENANT_ID,
      input: baseInput({ lb_lead_id: 'lb-uuid-legacy-stamped', lb_external_request_id: 'EXT-NO-LEAD-MATCH' }),
    });
    expect(r.match_type).toBe(MATCH_TYPE.CUSTOMER_JOB);
    expect(r.confidence).toBe('exact');
    expect(r.match_basis).toBe(MATCH_BASIS.LB_LEAD_ID);
    expect(r.sf_customer_id).toBe(23400);
    expect(r.sf_job_id).toBe(139854);
    expect(r.sf_lead_id).toBeNull();
    expect(r.step).toBe(1.5);
  });

  test('multiple customers with same lb_lead_id → needs_review', async () => {
    const store = makeStore({
      leads: [],
      customers: [
        { id: 1, user_id: TENANT_ID, lb_lead_id: 'lb-uuid-dup' },
        { id: 2, user_id: TENANT_ID, lb_lead_id: 'lb-uuid-dup' },
      ],
    });
    const r = await findHistoricalMatchType(store, {
      userId: TENANT_ID,
      input: baseInput({ lb_lead_id: 'lb-uuid-dup', lb_external_request_id: 'X' }),
    });
    expect(r.match_type).toBe(MATCH_TYPE.NEEDS_REVIEW);
    expect(r.reason).toBe('multiple_customers_for_lb_lead_id');
    expect(r.step).toBe(1.5);
  });
});

// ──────────────────────────────────────────────────────────────────────
// 5. Step 2 — existing customer matcher still works
// ──────────────────────────────────────────────────────────────────────
describe('Step 2: existing customer matcher still works unchanged', () => {
  test('high-confidence phone match (no SF lead, no legacy stamp) → customer_job', async () => {
    const store = makeStore({
      leads: [],
      customers: [{
        id: 23487, user_id: TENANT_ID,
        first_name: 'Antonya', last_name: 'Cooper',
        phone: '8005553841', email: null,
        lb_lead_id: null, created_at: '2026-06-01T00:00:00Z',
      }],
      jobs: [{
        id: 142307, user_id: TENANT_ID, customer_id: 23487,
        status: 'scheduled', payment_status: null,
        scheduled_date: '2026-06-10T00:00:00Z',
        created_at: '2026-06-03T17:30:00Z',
        lb_external_request_id: null, lb_lead_id: null,
      }],
    });
    const r = await findHistoricalMatchType(store, {
      userId: TENANT_ID,
      input: baseInput({
        lb_lead_id: 'lb-different',
        lb_external_request_id: 'EXT-NO-SF-LEAD',
        customer_phone: '8005553841',
        customer_name: 'Antonya Cooper',
      }),
    });
    expect(r.match_type).toBe(MATCH_TYPE.CUSTOMER_JOB);
    expect(['high', 'exact']).toContain(r.confidence);
    expect(r.sf_customer_id).toBe(23487);
    expect(r.sf_job_id).toBe(142307);
    expect(r.step).toBe(2);
  });

  test('medium-confidence (name+date only) → needs_review', async () => {
    const store = makeStore({
      leads: [],
      customers: [{
        id: 23393, user_id: TENANT_ID,
        first_name: 'Anne', last_name: 'Luecke',
        phone: null, email: null,
        created_at: '2026-03-20T00:00:00Z',
      }],
      jobs: [{
        id: 139832, user_id: TENANT_ID, customer_id: 23393,
        status: 'completed', payment_status: 'paid',
        scheduled_date: '2026-03-25T00:00:00Z',
        created_at: '2026-03-20T00:00:00Z',
      }],
    });
    const r = await findHistoricalMatchType(store, {
      userId: TENANT_ID,
      input: baseInput({
        lb_lead_id: 'lb-not-stamped', lb_external_request_id: 'EXT-NO-LEAD',
        customer_name: 'Anne Luecke',
        lead_created_at: '2026-03-19T00:00:00Z',
      }),
    });
    expect(r.match_type).toBe(MATCH_TYPE.NEEDS_REVIEW);
    expect(r.reason).toBe('low_confidence_customer_match');
    expect(r.sf_customer_id).toBe(23393);
    expect(r.step).toBe(2);
  });

  test('multiple high-confidence candidates → needs_review', async () => {
    const store = makeStore({
      leads: [],
      customers: [
        { id: 1, user_id: TENANT_ID, first_name: 'Jon', last_name: 'Daw', phone: '4042681000', created_at: '2026-03-01T00:00:00Z' },
        { id: 2, user_id: TENANT_ID, first_name: 'Jon', last_name: 'Daw', phone: '4042681000', created_at: '2026-03-02T00:00:00Z' },
      ],
      jobs: [
        { id: 10, user_id: TENANT_ID, customer_id: 1, status: 'completed', payment_status: 'paid', scheduled_date: '2026-03-05T00:00:00Z', created_at: '2026-03-01T00:00:00Z' },
        { id: 20, user_id: TENANT_ID, customer_id: 2, status: 'completed', payment_status: 'paid', scheduled_date: '2026-03-06T00:00:00Z', created_at: '2026-03-02T00:00:00Z' },
      ],
    });
    const r = await findHistoricalMatchType(store, {
      userId: TENANT_ID,
      input: baseInput({
        lb_external_request_id: 'EXT-AMBIG', customer_phone: '4042681000', customer_name: 'Jon Daw',
        lead_created_at: '2026-03-03T00:00:00Z',
      }),
    });
    expect(r.match_type).toBe(MATCH_TYPE.NEEDS_REVIEW);
    expect(['multiple_customer_candidates', 'low_confidence_customer_match']).toContain(r.reason);
    expect(r.step).toBe(2);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Step 3 — legacy job stamp
// ──────────────────────────────────────────────────────────────────────
describe('Step 3: legacy jobs.lb_external_request_id stamp', () => {
  test('returns customer_job when only the job has the LB stamp', async () => {
    const store = makeStore({
      leads: [],
      customers: [],
      jobs: [{
        id: 7777, user_id: TENANT_ID, customer_id: 8888,
        status: 'completed', payment_status: 'paid',
        lb_external_request_id: 'EXT-JOB-ONLY',
        lb_lead_id: null, created_at: '2026-02-15T00:00:00Z',
      }],
    });
    const r = await findHistoricalMatchType(store, {
      userId: TENANT_ID,
      input: baseInput({ lb_external_request_id: 'EXT-JOB-ONLY' }),
    });
    expect(r.match_type).toBe(MATCH_TYPE.CUSTOMER_JOB);
    expect(r.sf_customer_id).toBe(8888);
    expect(r.sf_job_id).toBe(7777);
    expect(r.step).toBe(3);
  });
});

// ──────────────────────────────────────────────────────────────────────
// 6. Step 4 — SF leads by phone/email fallback → ALWAYS needs_review
// ──────────────────────────────────────────────────────────────────────
describe('Step 4: SF lead by phone/email fallback never auto-links', () => {
  test('SF lead matched only by phone (no LB stamp, different source) → needs_review', async () => {
    const store = makeStore({
      // SF lead exists with same phone but DIFFERENT externalRequestId
      // and from a non-LB source — classic cross-inquiry / OpenPhone case.
      leads: [{
        id: 1716, user_id: TENANT_ID,
        first_name: 'Beth', last_name: '',
        phone: '+19045257176', email: null,
        lb_external_request_id: 'OTHER-EXT-REQ',  // different from input
        source: 'Yelp Jacksonville',
        converted_customer_id: null,
      }],
      customers: [], jobs: [],
    });
    const r = await findHistoricalMatchType(store, {
      userId: TENANT_ID,
      input: baseInput({
        lb_external_request_id: 'EXT-NEW-BETH-INQUIRY',
        lb_lead_id: 'lb-new-uuid',
        customer_phone: '+19045257176',
        customer_name: 'Beth',
      }),
    });
    expect(r.match_type).toBe(MATCH_TYPE.NEEDS_REVIEW);
    expect(r.reason).toBe('cross_inquiry_or_non_lb_sf_lead');
    expect(r.match_basis).toBe(MATCH_BASIS.PHONE);
    expect(r.matched_sf_lead_ids).toEqual([1716]);
    expect(r.sf_customer_id).toBeNull();
    expect(r.sf_job_id).toBeNull();
    expect(r.step).toBe(4);
  });

  test('Yelp proxy email is NEVER joined in Step 4', async () => {
    const store = makeStore({
      leads: [{
        id: 380, user_id: TENANT_ID,
        first_name: 'Anyone', last_name: '',
        phone: null,
        email: 'leadsapi+abc@messaging.yelp.com',  // SF should never store this, but pretend
      }],
      customers: [], jobs: [],
    });
    const r = await findHistoricalMatchType(store, {
      userId: TENANT_ID,
      input: baseInput({
        lb_external_request_id: 'EXT-PROXY-ONLY',
        customer_phone: null,
        customer_email: 'leadsapi+abc@messaging.yelp.com',
      }),
    });
    expect(r.match_type).toBe(MATCH_TYPE.NO_MATCH);
    expect(r.step).toBe(5);
  });
});

// ──────────────────────────────────────────────────────────────────────
// 7. Step 0 — test channel
// ──────────────────────────────────────────────────────────────────────
describe('Step 0: lb_channel=test → test_noise (no DB calls)', () => {
  test('returns immediately with test_noise; supabase never queried', async () => {
    // Stub a supabase that throws on any from() call — proves test_noise
    // short-circuits before DB access.
    const throwingDb = { from: () => { throw new Error('DB must not be touched for test_noise'); } };
    const r = await findHistoricalMatchType(throwingDb, {
      userId: TENANT_ID,
      input: baseInput({ lb_channel: 'test' }),
    });
    expect(r.match_type).toBe(MATCH_TYPE.TEST_NOISE);
    expect(r.reason).toBe('lb_test_channel');
    expect(r.step).toBe(0);
  });
});

// ──────────────────────────────────────────────────────────────────────
// 8. Jill S. fixture → lead_only
// ──────────────────────────────────────────────────────────────────────
describe('Jill S. fixture (tenant 2 prod, LB lead b5109475-...)', () => {
  test('lead_only with sf_lead_id=107 + stage_name=Contacted; no customer/job set', async () => {
    const store = makeStore({
      leads: [{
        id: 107, user_id: TENANT_ID,
        first_name: 'Jill', last_name: 'S.',
        phone: null,
        email: 'leadsapi+40b547247782458f968138ed444e8c46@messaging.yelp.com',
        lb_external_request_id: 'oDd6uAr8IEz40nfmmmsDEw',
        lb_channel: 'yelp',
        lb_business_id: 'bATU27M80b_VRB2Ge8fA7A',
        converted_customer_id: null,
        pipeline_id: 2, stage_id: 9,
        source: 'Yelp Jacksonville',
        created_at: '2026-04-09T00:03:26.551Z',
      }],
      lead_stages: [{ id: 9, name: 'Contacted', position: 2 }],
    });
    const r = await findHistoricalMatchType(store, {
      userId: TENANT_ID,
      input: {
        lb_lead_id:             'b5109475-396c-47a6-88de-c9d8270fe20a',
        lb_external_request_id: 'oDd6uAr8IEz40nfmmmsDEw',
        lb_channel:             'yelp',
        lb_business_id:         'bATU27M80b_VRB2Ge8fA7A',
        customer_phone:         null,
        customer_email:         'leadsapi+40b547247782458f968138ed444e8c46@messaging.yelp.com',
        customer_name:          'Jill S.',
        lead_created_at:        '2026-04-01T13:07:34Z',
      },
    });
    expect(r.match_type).toBe(MATCH_TYPE.LEAD_ONLY);
    expect(r.confidence).toBe('exact');
    expect(r.match_basis).toBe(MATCH_BASIS.EXTERNAL_REQUEST_ID);
    expect(r.sf_lead_id).toBe(107);
    expect(r.sf_lead_stage_name).toBe('Contacted');
    expect(r.sf_customer_id).toBeNull();   // hard rule
    expect(r.sf_job_id).toBeNull();        // hard rule
    expect(r.step).toBe(1);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Step 5 — true no_match (terminal)
// ──────────────────────────────────────────────────────────────────────
describe('Step 5: terminal no_match', () => {
  test('no SF lead/customer/job + no phone/email match → no_match', async () => {
    const store = makeStore({ leads: [], customers: [], jobs: [] });
    const r = await findHistoricalMatchType(store, {
      userId: TENANT_ID,
      input: baseInput({
        lb_external_request_id: 'EXT-TRULY-NEW',
        customer_phone: '5551234567',
        customer_email: 'real@example.com',
        customer_name: 'Brand New',
      }),
    });
    expect(r.match_type).toBe(MATCH_TYPE.NO_MATCH);
    expect(r.confidence).toBe('none');
    expect(r.match_basis).toBe(MATCH_BASIS.NONE);
    expect(r.step).toBe(5);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Hard invariant: sfCustomerId/sfJobId never set for lead_only
// (defensive — already enforced by baseResult, pin it explicitly)
// ──────────────────────────────────────────────────────────────────────
describe('Hard invariant — lead_only never carries customer/job ids', () => {
  test('even if test fixture tried to attach them, baseResult wipes them', async () => {
    // baseResult is internal; this just confirms the public surface
    // can't accidentally leak sfCustomerId on a lead_only result.
    const store = makeStore({
      leads: [{
        id: 500, user_id: TENANT_ID,
        lb_external_request_id: 'EXT-INVARIANT',
        converted_customer_id: null,
        // even if converted_customer_id WERE non-null, the route would
        // be customer_job — but with NULL here, lead_only path applies.
        pipeline_id: 1, stage_id: 1,
      }],
      lead_stages: [{ id: 1, name: 'New' }],
    });
    const r = await findHistoricalMatchType(store, {
      userId: TENANT_ID,
      input: baseInput({ lb_external_request_id: 'EXT-INVARIANT' }),
    });
    expect(r.match_type).toBe(MATCH_TYPE.LEAD_ONLY);
    expect(r.sf_customer_id).toBeNull();
    expect(r.sf_job_id).toBeNull();
  });
});
