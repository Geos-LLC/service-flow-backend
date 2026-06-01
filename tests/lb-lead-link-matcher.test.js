'use strict';

/**
 * LB → SF historical lead match (migration 060).
 *
 * Covers:
 *   - phone exact match → confidence 'high'
 *   - email exact match → confidence 'high'
 *   - both phone + email exact → 'exact'
 *   - lb_lead_id already linked on SF row → 'exact'
 *   - name only → 'low'
 *   - name + scheduled date within 14d → 'medium'
 *   - tenant isolation (no cross-tenant rows leaked)
 *   - PII redaction (only phone_last4 + email_present)
 *   - ambiguity warning when >1 high-confidence candidates
 *   - no input signals → empty result
 *   - 180-day window cap UNLESS phone exact
 */

const {
  findMatchCandidates,
  normPhoneLast10,
  normEmail,
  splitName,
  phoneLast4,
  scoreCandidate,
  pickOriginatorOrEarliestPerCustomer,
} = require('../lib/lb-lead-link-matcher');

// ──────────────────────────────────────────────────────────────
// In-memory Supabase mock (subset)
// ──────────────────────────────────────────────────────────────
function makeStore({ customers = [], jobs = [] } = {}) {
  function applyFilters(rs, filters) {
    return rs.filter((r) => filters.every((f) => {
      if (f.type === 'eq')    return String(r[f.col]) === String(f.val);
      if (f.type === 'ilike') {
        const v = String(r[f.col] == null ? '' : r[f.col]);
        // %X% means contains X; ilike with exact value is case-insensitive equals
        const pat = String(f.val);
        if (pat.startsWith('%') && pat.endsWith('%')) {
          const needle = pat.slice(1, -1);
          return v.toLowerCase().includes(needle.toLowerCase());
        }
        return v.toLowerCase() === pat.toLowerCase();
      }
      if (f.type === 'in')    return f.vals.map(String).includes(String(r[f.col]));
      return true;
    }));
  }

  function makeBuilder(rows) {
    const state = { filters: [], limit: null, order: null };
    const builder = {
      _state: state,
      select() { return builder; },
      eq(c, v)    { state.filters.push({ type: 'eq', col: c, val: v }); return builder; },
      ilike(c, v) { state.filters.push({ type: 'ilike', col: c, val: v }); return builder; },
      in(c, v)    { state.filters.push({ type: 'in', col: c, vals: v }); return builder; },
      limit(n)    { state.limit = n; return builder; },
      order(c, o) { state.order = { col: c, asc: !(o && o.ascending === false) }; return builder; },
      maybeSingle() { return exec().then(maybeSingle); },
      single()      { return exec().then(single); },
      then(onF, onR){ return exec().then(onF, onR); },
    };
    function exec() {
      return new Promise((resolve) => {
        let matched = applyFilters(rows, state.filters);
        if (state.order) {
          const o = state.order;
          matched = [...matched].sort((a, b) => {
            const av = a[o.col]; const bv = b[o.col];
            if (av === bv) return 0;
            if (av == null) return 1;
            if (bv == null) return -1;
            return o.asc ? (av < bv ? -1 : 1) : (av < bv ? 1 : -1);
          });
        }
        if (state.limit != null) matched = matched.slice(0, state.limit);
        resolve({ data: matched, error: null });
      });
    }
    return builder;
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

  return {
    from(t) {
      if (t === 'customers') return makeBuilder(customers);
      if (t === 'jobs')      return makeBuilder(jobs);
      return makeBuilder([]);
    },
  };
}

// ──────────────────────────────────────────────────────────────
// Pure normalizer tests
// ──────────────────────────────────────────────────────────────
describe('normalizers', () => {
  test('normPhoneLast10 strips formatting + takes last 10', () => {
    expect(normPhoneLast10('(813) 375-2443')).toBe('8133752443');
    expect(normPhoneLast10('+1 813 375 2443')).toBe('8133752443');
    expect(normPhoneLast10('18133752443')).toBe('8133752443');
    expect(normPhoneLast10('375-2443')).toBe('3752443');           // 7 digits OK
    expect(normPhoneLast10('123')).toBe(null);                      // too short
    expect(normPhoneLast10(null)).toBe(null);
    expect(normPhoneLast10('')).toBe(null);
  });
  test('normEmail lowercases + trims', () => {
    expect(normEmail('  Erin@Davis.COM  ')).toBe('erin@davis.com');
    expect(normEmail('')).toBe(null);
    expect(normEmail(null)).toBe(null);
  });
  test('splitName splits first/last', () => {
    expect(splitName('Erin Davis')).toEqual({ first: 'Erin', last: 'Davis' });
    expect(splitName('Erin  Marie  Davis')).toEqual({ first: 'Erin', last: 'Davis' });
    expect(splitName('Cher')).toEqual({ first: 'Cher', last: null });
    expect(splitName('')).toEqual({ first: null, last: null });
  });
  test('phoneLast4 returns last 4 digits', () => {
    expect(phoneLast4('(813) 375-2443')).toBe('2443');
    expect(phoneLast4(null)).toBe(null);
  });
});

// ──────────────────────────────────────────────────────────────
// scoreCandidate — confidence bucketing
// ──────────────────────────────────────────────────────────────
describe('scoreCandidate', () => {
  test('phone exact + email exact → exact', () => {
    const r = scoreCandidate({
      input: { customer_phone: '8133752443', customer_email: 'erin@x.com', customer_name: 'Erin Davis' },
      customer: { phone: '+1-813-375-2443', email: 'ERIN@X.com', first_name: 'Erin', last_name: 'Davis' },
      pickedJob: null,
    });
    expect(r.confidence).toBe('exact');
    expect(r.signals).toEqual(expect.arrayContaining(['phone_exact:…2443', 'email_exact', 'name_exact']));
  });
  test('phone exact only → high', () => {
    const r = scoreCandidate({
      input: { customer_phone: '8133752443', customer_name: 'Erin Davis' },
      customer: { phone: '(813) 375-2443', email: 'other@y.com', first_name: 'Erin', last_name: 'Davis' },
      pickedJob: null,
    });
    expect(r.confidence).toBe('high');
    expect(r.signals).toContain('phone_exact:…2443');
  });
  test('email exact only → high', () => {
    const r = scoreCandidate({
      input: { customer_email: 'erin@x.com', customer_name: 'Erin Davis' },
      customer: { phone: null, email: 'erin@x.com', first_name: 'Other', last_name: 'Name' },
      pickedJob: null,
    });
    expect(r.confidence).toBe('high');
    expect(r.signals).toContain('email_exact');
  });
  test('name + date proximity → medium', () => {
    const r = scoreCandidate({
      input: { customer_name: 'Erin Davis', lead_created_at: '2026-03-10T00:00:00Z' },
      customer: { phone: null, email: null, first_name: 'Erin', last_name: 'Davis' },
      pickedJob: { scheduled_date: '2026-03-18T00:00:00Z' },
    });
    expect(r.confidence).toBe('medium');
    expect(r.signals).toEqual(expect.arrayContaining(['name_exact', 'date_within_14d']));
  });
  test('name only (no date) → low', () => {
    const r = scoreCandidate({
      input: { customer_name: 'Erin Davis' },
      customer: { phone: null, email: null, first_name: 'Erin', last_name: 'Davis' },
      pickedJob: null,
    });
    expect(r.confidence).toBe('low');
  });
  test('no signals → null (drop)', () => {
    const r = scoreCandidate({
      input: { customer_name: 'Erin Davis' },
      customer: { phone: null, email: null, first_name: 'Other', last_name: 'Name' },
      pickedJob: null,
    });
    expect(r.confidence).toBeNull();
  });
  test('lb_lead_id already linked → exact', () => {
    const r = scoreCandidate({
      input: { lb_lead_id: 'lb-uuid-1', customer_name: 'Other Name' },
      customer: { phone: null, email: null, first_name: 'Other', last_name: 'Name', lb_lead_id: 'lb-uuid-1' },
      pickedJob: null,
    });
    expect(r.confidence).toBe('exact');
    expect(r.signals).toContain('lb_lead_id_already_linked');
  });
});

// ──────────────────────────────────────────────────────────────
// findMatchCandidates — integration with mock store
// ──────────────────────────────────────────────────────────────
describe('findMatchCandidates', () => {
  const ERIN = {
    id: 23427, user_id: 2,
    first_name: 'Erin', last_name: 'Davis',
    phone: '8133752443', email: null,
    lb_lead_id: null,
    created_at: '2026-04-16T14:01:00Z',
  };
  const ERIN_JOB = {
    id: 141929, user_id: 2, customer_id: 23427,
    status: 'completed', payment_status: 'paid',
    scheduled_date: '2026-05-05T15:00:00Z',
    invoice_amount: null, total_amount: 349,
    lb_external_request_id: null, lb_channel: null, lb_business_id: null, lb_lead_id: null,
    last_status_changed_at: '2026-05-05T22:44:31Z',
    created_at: '2026-04-16T15:43:15Z',
  };

  test('Erin Davis: phone match returns the candidate at high confidence', async () => {
    const store = makeStore({ customers: [ERIN], jobs: [ERIN_JOB] });
    const out = await findMatchCandidates(store, {
      userId: 2,
      input: {
        lb_lead_id: '65d7a387-…',
        lb_external_request_id: '574011065576308746',
        customer_phone: '813-375-2443',
        customer_name: 'Erin Davis',
        lead_created_at: '2026-03-10T15:31:00Z',
      },
    });
    expect(out.match_count).toBe(1);
    const c = out.candidates[0];
    expect(c.sf_customer_id).toBe(23427);
    expect(c.sf_job_id).toBe(141929);
    expect(c.confidence).toBe('high');
    expect(c.match_signals).toEqual(expect.arrayContaining(['phone_exact:…2443', 'name_exact']));
    // PII redaction
    expect(c.sf_customer).toEqual(expect.objectContaining({
      first_name: 'Erin', last_name: 'Davis',
      phone_last4: '2443',
      email_present: false,
    }));
    expect(c.sf_customer).not.toHaveProperty('phone');
    expect(c.sf_customer).not.toHaveProperty('email');
    expect(c.sf_job).toEqual(expect.objectContaining({
      status: 'completed', payment_status: 'paid', amount: 349,
    }));
  });

  test('tenant isolation: same name on different user_id is excluded', async () => {
    const store = makeStore({
      customers: [
        ERIN,
        { id: 9999, user_id: 99, first_name: 'Erin', last_name: 'Davis', phone: '8133752443', email: null, created_at: '2026-04-16T14:01:00Z' },
      ],
      jobs: [ERIN_JOB],
    });
    const out = await findMatchCandidates(store, {
      userId: 2,
      input: { customer_phone: '8133752443', customer_name: 'Erin Davis' },
    });
    expect(out.match_count).toBe(1);
    expect(out.candidates[0].sf_customer_id).toBe(23427);   // only tenant 2's row
  });

  test('ambiguity: 2 high-confidence candidates get multiple_high_confidence_candidates flag', async () => {
    const a = { ...ERIN, id: 1, phone: '8133752443' };
    const b = { ...ERIN, id: 2, phone: '8133752443', first_name: 'Different' };
    const store = makeStore({
      customers: [a, b],
      jobs: [{ ...ERIN_JOB, id: 11, customer_id: 1 }, { ...ERIN_JOB, id: 12, customer_id: 2 }],
    });
    const out = await findMatchCandidates(store, {
      userId: 2,
      input: { customer_phone: '8133752443', customer_name: 'Erin Davis' },
    });
    expect(out.match_count).toBe(2);
    for (const c of out.candidates) {
      expect(c.ambiguity_warnings).toContain('multiple_high_confidence_candidates');
    }
  });

  test('no input signals → empty', async () => {
    const store = makeStore({ customers: [ERIN], jobs: [ERIN_JOB] });
    const out = await findMatchCandidates(store, { userId: 2, input: {} });
    expect(out.match_count).toBe(0);
    expect(out.candidates).toEqual([]);
  });

  test('no phone match + name out of 180d window → dropped', async () => {
    const oldCust  = { ...ERIN, id: 99, created_at: '2024-01-01T00:00:00Z' };
    const oldJob   = { ...ERIN_JOB, id: 991, customer_id: 99, scheduled_date: null, created_at: '2024-01-01T00:00:00Z' };
    const store = makeStore({ customers: [oldCust], jobs: [oldJob] });
    const out = await findMatchCandidates(store, {
      userId: 2,
      input: { customer_name: 'Erin Davis', lead_created_at: '2026-03-10T00:00:00Z' },
    });
    expect(out.match_count).toBe(0);
  });

  test('phone exact bypasses 180d window cap', async () => {
    const oldCust  = { ...ERIN, id: 99, created_at: '2024-01-01T00:00:00Z' };
    const oldJob   = { ...ERIN_JOB, id: 991, customer_id: 99, scheduled_date: null, created_at: '2024-01-01T00:00:00Z' };
    const store = makeStore({ customers: [oldCust], jobs: [oldJob] });
    const out = await findMatchCandidates(store, {
      userId: 2,
      input: { customer_phone: '8133752443', customer_name: 'Erin Davis', lead_created_at: '2026-03-10T00:00:00Z' },
    });
    expect(out.match_count).toBe(1);
    expect(out.candidates[0].confidence).toBe('high');
  });
});

// ──────────────────────────────────────────────────────────────────────
// Originator/earliest job picker (post-Batch-5 audit fix)
// ──────────────────────────────────────────────────────────────────────
describe('pickOriginatorOrEarliestPerCustomer', () => {
  test('prefers the originator job (matching lb_external_request_id) over later jobs', () => {
    const jobs = [
      { id: 5, customer_id: 10, lb_external_request_id: null,    created_at: '2026-04-01T00:00:00Z' },
      { id: 2, customer_id: 10, lb_external_request_id: 'EXT-A', created_at: '2025-01-01T00:00:00Z' },
      { id: 7, customer_id: 10, lb_external_request_id: null,    created_at: '2026-06-01T00:00:00Z' },
    ];
    const picked = pickOriginatorOrEarliestPerCustomer(jobs, 'EXT-A').get(10);
    expect(picked.id).toBe(2);
    expect(picked.lb_external_request_id).toBe('EXT-A');
  });

  test('falls back to earliest job when no originator match', () => {
    const jobs = [
      { id: 5, customer_id: 10, lb_external_request_id: null, created_at: '2026-04-01T00:00:00Z' },
      { id: 2, customer_id: 10, lb_external_request_id: null, created_at: '2025-01-01T00:00:00Z' },
      { id: 7, customer_id: 10, lb_external_request_id: null, created_at: '2026-06-01T00:00:00Z' },
    ];
    const picked = pickOriginatorOrEarliestPerCustomer(jobs, 'EXT-A').get(10);
    expect(picked.id).toBe(2);     // earliest by created_at
  });

  test('null input externalRequestId → earliest fallback even if jobs have ext_reqs', () => {
    const jobs = [
      { id: 5, customer_id: 10, lb_external_request_id: 'EXT-X', created_at: '2026-04-01T00:00:00Z' },
      { id: 2, customer_id: 10, lb_external_request_id: 'EXT-Y', created_at: '2025-01-01T00:00:00Z' },
    ];
    const picked = pickOriginatorOrEarliestPerCustomer(jobs, null).get(10);
    expect(picked.id).toBe(2);
  });

  test('ties on created_at broken by lower id', () => {
    const jobs = [
      { id: 5, customer_id: 10, lb_external_request_id: null, created_at: '2025-01-01T00:00:00Z' },
      { id: 2, customer_id: 10, lb_external_request_id: null, created_at: '2025-01-01T00:00:00Z' },
    ];
    const picked = pickOriginatorOrEarliestPerCustomer(jobs, null).get(10);
    expect(picked.id).toBe(2);
  });

  test('per-customer isolation: originator vs earliest applied independently', () => {
    const jobs = [
      { id: 1, customer_id: 10, lb_external_request_id: 'EXT-A', created_at: '2025-01-01T00:00:00Z' },
      { id: 9, customer_id: 10, lb_external_request_id: null,    created_at: '2026-06-01T00:00:00Z' },
      { id: 2, customer_id: 20, lb_external_request_id: null,    created_at: '2024-12-01T00:00:00Z' },
      { id: 8, customer_id: 20, lb_external_request_id: null,    created_at: '2026-03-01T00:00:00Z' },
    ];
    const out = pickOriginatorOrEarliestPerCustomer(jobs, 'EXT-A');
    expect(out.get(10).id).toBe(1);  // originator match
    expect(out.get(20).id).toBe(2);  // no ext_req match → earliest
  });

  test('jobs without created_at sort to the end (defensive)', () => {
    const jobs = [
      { id: 5, customer_id: 10, lb_external_request_id: null, created_at: '2025-01-01T00:00:00Z' },
      { id: 9, customer_id: 10, lb_external_request_id: null, created_at: null },
    ];
    const picked = pickOriginatorOrEarliestPerCustomer(jobs, null).get(10);
    expect(picked.id).toBe(5);
  });

  test('empty jobsRows → empty map', () => {
    expect(pickOriginatorOrEarliestPerCustomer([], 'EXT-A').size).toBe(0);
    expect(pickOriginatorOrEarliestPerCustomer(null, null).size).toBe(0);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Regression: recurring-customer scenario from the Batch-5 audit
//
// Scenario: customer has 3 SF jobs:
//   - 100 (originator, ext_req=EXT-A, created 2025-01-01)
//   - 200 (recurring, created 2025-06-01)
//   - 300 (recurring, created 2025-12-01, sched 2026-04-15)
// LB sends a lead with externalRequestId=EXT-A. The OLD matcher
// returned sf_job=300 (most-recent), which then conflicted on LB's
// /link-leads-bulk because LB had pinned to job 100. The NEW matcher
// must return sf_job=100 — the originator.
// ──────────────────────────────────────────────────────────────────────
describe('findMatchCandidates — recurring customer originator fix', () => {
  test('recurring customer with matching ext_req → returns originator (earliest) sf_job', async () => {
    const cust = { id: 50, user_id: 2, first_name: 'Recurring', last_name: 'Service',
      phone: '5550000000', email: 'r@example.com', lb_lead_id: null, created_at: '2025-01-01T00:00:00Z' };
    const jobs = [
      { id: 300, user_id: 2, customer_id: 50, status: 'completed', payment_status: 'paid',
        lb_external_request_id: null, scheduled_date: '2026-04-15T00:00:00Z', created_at: '2025-12-01T00:00:00Z' },
      { id: 200, user_id: 2, customer_id: 50, status: 'completed', payment_status: 'paid',
        lb_external_request_id: null, scheduled_date: '2025-08-01T00:00:00Z', created_at: '2025-06-01T00:00:00Z' },
      { id: 100, user_id: 2, customer_id: 50, status: 'completed', payment_status: 'paid',
        lb_external_request_id: 'EXT-A', scheduled_date: '2025-02-01T00:00:00Z', created_at: '2025-01-01T00:00:00Z' },
    ];
    const store = makeStore({ customers: [cust], jobs });
    const out = await findMatchCandidates(store, {
      userId: 2,
      input: {
        lb_external_request_id: 'EXT-A',
        customer_phone: '5550000000',
        customer_name:  'Recurring Service',
        lead_created_at: '2025-01-05T00:00:00Z',
      },
    });
    expect(out.match_count).toBe(1);
    expect(out.candidates[0].sf_job_id).toBe(100);   // originator, NOT 300 (the most-recent)
    expect(out.candidates[0].sf_job.lb_external_request_id).toBe('EXT-A');
  });

  test('recurring customer with NO matching ext_req → returns EARLIEST sf_job (not most-recent)', async () => {
    const cust = { id: 60, user_id: 2, first_name: 'Walk', last_name: 'In',
      phone: '5550001111', email: null, lb_lead_id: null, created_at: '2025-01-01T00:00:00Z' };
    const jobs = [
      { id: 600, user_id: 2, customer_id: 60, status: 'completed', payment_status: 'paid',
        lb_external_request_id: null, scheduled_date: '2026-04-15T00:00:00Z', created_at: '2025-12-01T00:00:00Z' },
      { id: 500, user_id: 2, customer_id: 60, status: 'completed', payment_status: 'paid',
        lb_external_request_id: null, scheduled_date: '2025-02-01T00:00:00Z', created_at: '2025-01-01T00:00:00Z' },
    ];
    const store = makeStore({ customers: [cust], jobs });
    const out = await findMatchCandidates(store, {
      userId: 2,
      input: {
        lb_external_request_id: null,            // LB lead has no ext_req on file (or doesn't match)
        customer_phone: '5550001111',
        lead_created_at: '2025-01-05T00:00:00Z',
      },
    });
    expect(out.match_count).toBe(1);
    expect(out.candidates[0].sf_job_id).toBe(500);   // earliest (NOT 600 most-recent)
  });
});
