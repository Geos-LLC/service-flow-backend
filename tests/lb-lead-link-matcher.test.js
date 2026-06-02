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
  pickHistoricalRepresentativeJob,
  pickHistoricalRepresentativeJobPerCustomer,
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
// pickHistoricalRepresentativeJob — tiered status ordering
//
// Tier 1: earliest completed + paid
// Tier 2: earliest completed (any payment status)
// Tier 3: earliest scheduled / booked (only when no completed exists)
// Else  : null (customer has only cancelled/no_show → drop)
// ──────────────────────────────────────────────────────────────────────
describe('pickHistoricalRepresentativeJob — tiered status picker', () => {
  test('deep cleaning (completed+paid, early) then recurring (completed+paid, later) → picks deep cleaning', () => {
    // Realistic Spotless shape: customer's first SF job was a deep clean,
    // followed by months of recurring regular cleanings. The lead
    // converted on the deep clean, so that's the representative.
    const jobs = [
      { id: 100, status: 'completed', payment_status: 'paid', created_at: '2025-01-15', total_amount: 349 },  // deep
      { id: 200, status: 'completed', payment_status: 'paid', created_at: '2025-02-15', total_amount: 159 },  // recurring
      { id: 300, status: 'completed', payment_status: 'paid', created_at: '2025-03-15', total_amount: 159 },
      { id: 400, status: 'completed', payment_status: 'paid', created_at: '2025-04-15', total_amount: 159 },
    ];
    const picked = pickHistoricalRepresentativeJob(jobs);
    expect(picked.id).toBe(100);
    expect(picked.total_amount).toBe(349);
  });

  test('first regular completed, recurring later → picks the first regular', () => {
    const jobs = [
      { id: 10, status: 'completed', payment_status: 'paid', created_at: '2025-01-15', total_amount: 159 },
      { id: 20, status: 'completed', payment_status: 'paid', created_at: '2025-04-15', total_amount: 159 },
      { id: 30, status: 'completed', payment_status: 'paid', created_at: '2025-07-15', total_amount: 159 },
    ];
    expect(pickHistoricalRepresentativeJob(jobs).id).toBe(10);
  });

  test('cancelled first job, completed second → picks the completed second (skips the cancelled)', () => {
    const jobs = [
      { id: 50, status: 'cancelled', payment_status: null,   created_at: '2025-01-01' },
      { id: 60, status: 'completed', payment_status: 'paid', created_at: '2025-02-01' },
    ];
    expect(pickHistoricalRepresentativeJob(jobs).id).toBe(60);
  });

  test('only scheduled future job exists → picks earliest scheduled', () => {
    const jobs = [
      { id: 70, status: 'scheduled', payment_status: null, created_at: '2025-05-01', scheduled_date: '2026-06-01' },
      { id: 80, status: 'scheduled', payment_status: null, created_at: '2025-03-01', scheduled_date: '2026-04-01' },
    ];
    expect(pickHistoricalRepresentativeJob(jobs).id).toBe(80);
  });

  test('many recurring jobs → never picks the latest by default', () => {
    // 48 recurring jobs — the same shape as Sigrid Shelton in prod.
    const jobs = Array.from({ length: 48 }, (_, i) => ({
      id: 1000 + i, status: 'completed', payment_status: 'paid',
      created_at: `2024-${String((i % 12) + 1).padStart(2,'0')}-01`,
    }));
    // Sort plausible so the earliest by created_at is id=1000
    const picked = pickHistoricalRepresentativeJob(jobs);
    expect(picked.id).toBe(1000);   // never 1047 (the latest)
  });

  test('tier 1 fires even when later completed-paid would be the same status — earliest still wins', () => {
    const jobs = [
      { id: 9, status: 'completed', payment_status: 'paid', created_at: '2025-12-01' },
      { id: 3, status: 'completed', payment_status: 'paid', created_at: '2025-01-01' },
    ];
    expect(pickHistoricalRepresentativeJob(jobs).id).toBe(3);
  });

  test('tier 2 fires when there are completed jobs but none paid', () => {
    const jobs = [
      { id: 11, status: 'completed', payment_status: null,    created_at: '2025-03-01' },
      { id: 12, status: 'completed', payment_status: 'unpaid',created_at: '2025-01-01' },
    ];
    expect(pickHistoricalRepresentativeJob(jobs).id).toBe(12);
  });

  test('tier 3 fires only when there are no completed jobs', () => {
    const jobs = [
      { id: 21, status: 'scheduled', payment_status: null, created_at: '2025-04-01' },
      { id: 22, status: 'completed', payment_status: 'paid', created_at: '2025-08-01' },
    ];
    // Tier 1 wins even though the scheduled is earlier in time.
    expect(pickHistoricalRepresentativeJob(jobs).id).toBe(22);
  });

  test('booked is treated as scheduled (tier 3)', () => {
    const jobs = [
      { id: 31, status: 'booked',    payment_status: null, created_at: '2025-05-01' },
      { id: 32, status: 'scheduled', payment_status: null, created_at: '2025-03-01' },
    ];
    expect(pickHistoricalRepresentativeJob(jobs).id).toBe(32);
  });

  test('all cancelled → null (drop the candidate; no conversion to represent)', () => {
    const jobs = [
      { id: 41, status: 'cancelled', payment_status: null, created_at: '2025-01-01' },
      { id: 42, status: 'cancelled', payment_status: null, created_at: '2025-02-01' },
      { id: 43, status: 'cancelled', payment_status: null, created_at: '2025-03-01' },
    ];
    expect(pickHistoricalRepresentativeJob(jobs)).toBeNull();
  });

  test('no jobs → null', () => {
    expect(pickHistoricalRepresentativeJob([])).toBeNull();
    expect(pickHistoricalRepresentativeJob(null)).toBeNull();
  });

  test('ties on created_at broken by lower id (deterministic)', () => {
    const jobs = [
      { id: 9, status: 'completed', payment_status: 'paid', created_at: '2025-01-01' },
      { id: 2, status: 'completed', payment_status: 'paid', created_at: '2025-01-01' },
    ];
    expect(pickHistoricalRepresentativeJob(jobs).id).toBe(2);
  });

  test('case-insensitive on status + payment_status', () => {
    const jobs = [
      { id: 1, status: 'Completed', payment_status: 'PAID', created_at: '2025-01-01' },
      { id: 2, status: 'CANCELLED', payment_status: null,    created_at: '2024-12-01' },
    ];
    expect(pickHistoricalRepresentativeJob(jobs).id).toBe(1);
  });
});

describe('pickHistoricalRepresentativeJobPerCustomer', () => {
  test('per-customer isolation; cancelled-only customer dropped from map', () => {
    const jobs = [
      // customer 10: mixed
      { id: 1, customer_id: 10, status: 'cancelled', payment_status: null,   created_at: '2025-01-01' },
      { id: 2, customer_id: 10, status: 'completed', payment_status: 'paid', created_at: '2025-02-01' },
      // customer 20: only cancelled
      { id: 3, customer_id: 20, status: 'cancelled', payment_status: null,   created_at: '2025-01-01' },
      // customer 30: only scheduled
      { id: 4, customer_id: 30, status: 'scheduled', payment_status: null,   created_at: '2025-05-01' },
    ];
    const out = pickHistoricalRepresentativeJobPerCustomer(jobs);
    expect(out.get(10).id).toBe(2);
    expect(out.has(20)).toBe(false);   // cancelled-only → dropped
    expect(out.get(30).id).toBe(4);
  });

  test('empty input → empty map', () => {
    expect(pickHistoricalRepresentativeJobPerCustomer([]).size).toBe(0);
    expect(pickHistoricalRepresentativeJobPerCustomer(null).size).toBe(0);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Regression: recurring-customer scenarios from production
// ──────────────────────────────────────────────────────────────────────
describe('findMatchCandidates — recurring customer historical-representative fix', () => {
  test('Alicia Daub shape: 14 completed+paid jobs → picks the EARLIEST (sf_job 139784), not the manifest 141937', async () => {
    const cust = { id: 22855, user_id: 2, first_name: 'Alicia', last_name: 'Daub',
      phone: '5555550001', email: null, lb_lead_id: null, created_at: '2026-03-26T00:00:00Z' };
    // Mirrors the actual prod data: all 14 are completed+paid; primary
    // is id=139784, also has matching ext_req.
    const jobs = [
      { id: 139784, user_id: 2, customer_id: 22855, status: 'completed', payment_status: 'paid', lb_external_request_id: 'EXT-ALICIA', scheduled_date: '2026-04-08', created_at: '2026-03-26T00:00:00Z' },
      { id: 140217, user_id: 2, customer_id: 22855, status: 'completed', payment_status: 'paid', lb_external_request_id: null,        scheduled_date: '2026-01-31', created_at: '2026-03-26T00:00:00Z' },
      { id: 141889, user_id: 2, customer_id: 22855, status: 'completed', payment_status: 'paid', lb_external_request_id: null,        scheduled_date: '2026-04-08', created_at: '2026-04-05T00:00:00Z' },
      { id: 141937, user_id: 2, customer_id: 22855, status: 'completed', payment_status: 'paid', lb_external_request_id: null,        scheduled_date: '2026-04-28', created_at: '2026-04-20T00:00:00Z' },
    ];
    const store = makeStore({ customers: [cust], jobs });
    const out = await findMatchCandidates(store, {
      userId: 2,
      input: {
        lb_external_request_id: 'EXT-ALICIA',
        customer_phone: '5555550001',
        lead_created_at: '2026-03-26T00:00:00Z',
      },
    });
    expect(out.match_count).toBe(1);
    expect(out.candidates[0].sf_job_id).toBe(139784);   // earliest completed+paid, NOT 141937
  });

  test('Renee Teeter shape: 2 completed+paid jobs → picks the lower-id 141731, not the manifest 141732', async () => {
    const cust = { id: 22847, user_id: 2, first_name: 'Renee', last_name: 'Teeter',
      phone: '5555550002', email: null, lb_lead_id: null, created_at: '2026-03-26T00:00:00Z' };
    const jobs = [
      { id: 141731, user_id: 2, customer_id: 22847, status: 'completed', payment_status: 'paid', lb_external_request_id: 'EXT-RENEE', scheduled_date: '2025-03-06', created_at: '2026-03-26T00:00:00Z' },
      { id: 141732, user_id: 2, customer_id: 22847, status: 'completed', payment_status: 'paid', lb_external_request_id: null,        scheduled_date: '2025-03-06', created_at: '2026-03-26T00:00:00Z' },
    ];
    const store = makeStore({ customers: [cust], jobs });
    const out = await findMatchCandidates(store, {
      userId: 2,
      input: {
        lb_external_request_id: 'EXT-RENEE',
        customer_phone: '5555550002',
        lead_created_at: '2026-03-26T00:00:00Z',
      },
    });
    expect(out.match_count).toBe(1);
    expect(out.candidates[0].sf_job_id).toBe(141731);   // tied created_at; lower id wins
  });

  test('Cancelled-only customer (Julia-Planck shape) → candidate is dropped from match results', async () => {
    // 7 jobs, all cancelled (the actual Julia Planck case has 5 cancelled
    // + 2 completed+paid; this is a stricter all-cancelled shape to test
    // the explicit drop behavior).
    const cust = { id: 23362, user_id: 2, first_name: 'Cancel', last_name: 'Only',
      phone: '5555550003', email: null, lb_lead_id: null, created_at: '2026-03-26T00:00:00Z' };
    const jobs = Array.from({ length: 7 }, (_, i) => ({
      id: 100 + i, user_id: 2, customer_id: 23362,
      status: 'cancelled', payment_status: null,
      lb_external_request_id: i === 0 ? 'EXT-CANCEL' : null,
      scheduled_date: `2026-0${i + 1}-01`,
      created_at: `2026-0${i + 1}-01T00:00:00Z`,
    }));
    const store = makeStore({ customers: [cust], jobs });
    const out = await findMatchCandidates(store, {
      userId: 2,
      input: {
        lb_external_request_id: 'EXT-CANCEL',
        customer_phone: '5555550003',
        lead_created_at: '2026-03-01T00:00:00Z',
      },
    });
    // The customer still matches by phone, but sf_job_id is null because
    // the picker dropped — `isApplicable` (in the orchestrator) then
    // rejects with reason=sf_job_id_missing. That's intentional: a lead
    // who never converted shouldn't drag SF state along.
    expect(out.candidates[0].sf_job_id).toBeNull();
  });

  test('Mix of cancelled + completed (real Julia Planck shape) → picks earliest completed+paid', async () => {
    const cust = { id: 90, user_id: 2, first_name: 'Mix', last_name: 'Customer',
      phone: '5555550009', email: null, lb_lead_id: null, created_at: '2026-03-26T00:00:00Z' };
    const jobs = [
      { id: 139558, user_id: 2, customer_id: 90, status: 'cancelled', payment_status: null,   lb_external_request_id: 'EXT-MIX', created_at: '2026-03-01' },
      { id: 139587, user_id: 2, customer_id: 90, status: 'cancelled', payment_status: null,   created_at: '2026-03-02' },
      { id: 139806, user_id: 2, customer_id: 90, status: 'completed', payment_status: 'paid', created_at: '2026-03-03' },
      { id: 139999, user_id: 2, customer_id: 90, status: 'completed', payment_status: 'paid', created_at: '2026-03-04' },
      { id: 142086, user_id: 2, customer_id: 90, status: 'cancelled', payment_status: null,   created_at: '2026-03-05' },
    ];
    const store = makeStore({ customers: [cust], jobs });
    const out = await findMatchCandidates(store, {
      userId: 2,
      input: {
        lb_external_request_id: 'EXT-MIX',
        customer_phone: '5555550009',
        lead_created_at: '2026-03-01T00:00:00Z',
      },
    });
    expect(out.match_count).toBe(1);
    expect(out.candidates[0].sf_job_id).toBe(139806);   // earliest completed+paid, NOT the cancelled originator
  });
});

// ──────────────────────────────────────────────────────────────────────
// Live/new-conversion flow remains unaffected
//
// findMatchCandidates is invoked only by historical/reconcile paths:
//   - lib/lb-lead-link-bulk.js     (bulk-reconcile, PR #32)
//   - lib/sf-historical-sync-orchestrator.js (Phase 2 apply)
// The live conversion flow attaches an LB lead to a freshly created SF
// job inline via /orchestration/attach-lb-link with explicit ids and
// does NOT call findMatchCandidates — so the picker change cannot
// affect new-booking attachment.
// ──────────────────────────────────────────────────────────────────────
describe('live/new-conversion flow unaffected', () => {
  test('attachLbLink (live path) does not import or invoke findMatchCandidates or the picker', () => {
    const attacherSrc = require('fs').readFileSync(
      require('path').resolve(__dirname, '..', 'lib', 'lb-lead-link-attacher.js'),
      'utf8',
    );
    expect(attacherSrc).not.toMatch(/findMatchCandidates/);
    expect(attacherSrc).not.toMatch(/pickHistoricalRepresentativeJob/);
  });
});
