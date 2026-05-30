'use strict';

/**
 * Bulk historical reconciliation (migration 060 continued).
 *
 * Covers:
 *   - Erin Davis fixture auto-attaches without manual intervention
 *   - dry-run preview emits auto_attach_preview, no writes
 *   - multi-candidate ambiguity surfaces as needs_review
 *   - SF job already linked to a different lb_external_request_id surfaces as conflict needs_review
 *   - no match → no_match outcome
 *   - batch cap (51 → 400 batch_too_large)
 *   - empty batch → ok:true, no work
 *   - failure isolation: one lead error doesn't abort the batch
 *   - synthetic event ids deterministic + outbox UNIQUE absorbs replays
 *   - tenant-scoped: a different tenant's job in the store is not matched
 */

process.env.SF_ORCH_SIGNING_KEY     = Buffer.alloc(32, 0xAB).toString('base64');
process.env.SF_ORCH_SIGNING_KEY_KID = 'sf_orch_test_kid';
process.env.SF_INTEGRATION_ENC_KEY  = Buffer.alloc(32, 0xCD).toString('base64');
process.env.SF_SOURCE_INSTANCE      = 'sf-test';

const { reconcileBatch, shouldAutoAttach, MAX_BATCH_SIZE } = require('../lib/lb-lead-link-bulk');

const JOBS_TABLE      = 'jobs';
const CUSTOMERS_TABLE = 'customers';
const AUDIT_TABLE     = 'lb_link_audit';
const OUTBOX_TABLE    = 'leadbridge_outbound_events';

// ──────────────────────────────────────────────────────────────
// Mock supabase store — same shape as the attacher tests so the
// matcher + attacher both work end-to-end against it
// ──────────────────────────────────────────────────────────────
function makeStore({ jobs = [], customers = [] } = {}) {
  const rows = {
    [JOBS_TABLE]:      jobs.map((r) => ({ ...r })),
    [CUSTOMERS_TABLE]: customers.map((r) => ({ ...r })),
    [AUDIT_TABLE]:     [],
    [OUTBOX_TABLE]:    [],
  };
  let nextAuditId = 1;
  let nextOutboxId = 1;

  function applyFilters(rs, filters) {
    return rs.filter((r) => filters.every((f) => {
      if (f.type === 'eq')    return String(r[f.col]) === String(f.val);
      if (f.type === 'in')    return f.vals.map(String).includes(String(r[f.col]));
      if (f.type === 'ilike') {
        const v = String(r[f.col] == null ? '' : r[f.col]);
        const pat = String(f.val);
        if (pat.startsWith('%') && pat.endsWith('%')) {
          return v.toLowerCase().includes(pat.slice(1, -1).toLowerCase());
        }
        return v.toLowerCase() === pat.toLowerCase();
      }
      return true;
    }));
  }

  function makeBuilder(table) {
    const state = { table, op: null, payload: null, filters: [], limit: null, order: null };
    const builder = {
      _state: state,
      insert(p) { state.op = 'insert'; state.payload = p; return builder; },
      update(p) { state.op = 'update'; state.payload = p; return builder; },
      select()  { return builder; },
      eq(c, v)    { state.filters.push({ type: 'eq', col: c, val: v }); return builder; },
      ilike(c, v) { state.filters.push({ type: 'ilike', col: c, val: v }); return builder; },
      in(c, v)    { state.filters.push({ type: 'in', col: c, vals: v }); return builder; },
      limit(n)    { state.limit = n; return builder; },
      order(c, o) { state.order = { col: c, asc: !(o && o.ascending === false) }; return builder; },
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

      if (state.op === 'insert') {
        if (T === OUTBOX_TABLE) {
          const dup = rows[T].find((r) => r.event_id === state.payload.event_id);
          if (dup) return resolve({ data: null, error: { code: '23505', message: 'duplicate event_id' } });
          const newRow = { id: nextOutboxId++, ...state.payload };
          rows[T].push(newRow);
          return resolve({ data: newRow, error: null });
        }
        if (T === AUDIT_TABLE) {
          const newRow = { id: nextAuditId++, ...state.payload };
          rows[T].push(newRow);
          return resolve({ data: newRow, error: null });
        }
        return resolve({ data: null, error: null });
      }

      if (state.op === 'update') {
        const matched = applyFilters(rows[T], state.filters);
        for (const r of matched) Object.assign(r, state.payload);
        return resolve({ data: null, error: null });
      }

      // select
      let matched = applyFilters(rows[T], state.filters);
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
      return resolve({ data: matched.map((r) => ({ ...r })), error: null });
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

// Erin Davis fixtures (the actual prod tenant 2 case)
const ERIN_CUST = {
  id: 23427, user_id: 2,
  first_name: 'Erin', last_name: 'Davis',
  phone: '8133752443', email: null,
  lb_lead_id: null,
  created_at: '2026-04-16T14:01:00Z',
};
const ERIN_JOB = {
  id: 141929, user_id: 2, customer_id: 23427,
  status: 'completed', payment_status: 'paid', payment_date: null,
  scheduled_date: '2026-05-05T15:00:00Z',
  invoice_amount: null, total_amount: 349,
  lb_external_request_id: null, lb_channel: null, lb_business_id: null, lb_lead_id: null,
  last_status_changed_at: '2026-05-05T22:44:31Z',
  created_at: '2026-04-16T15:43:15Z',
};
const ERIN_LB_LEAD = {
  lb_lead_id:             '65d7a387-aa7b-45fc-b9a2-1f36bf92c7ec',
  lb_external_request_id: '574011065576308746',
  lb_channel:             'thumbtack',
  lb_business_id:         '532386425642459138',
  customer_phone:         '8133752443',
  customer_email:         null,
  customer_name:          'Erin Davis',
  lead_created_at:        '2026-03-10T15:31:00Z',
};

// ──────────────────────────────────────────────────────────────
// shouldAutoAttach (pure function)
// ──────────────────────────────────────────────────────────────
describe('shouldAutoAttach', () => {
  test('single high-confidence candidate with no ambiguity → true', () => {
    expect(shouldAutoAttach([{ confidence: 'high', ambiguity_warnings: [] }])).toBe(true);
  });
  test('single exact-confidence candidate → true', () => {
    expect(shouldAutoAttach([{ confidence: 'exact', ambiguity_warnings: [] }])).toBe(true);
  });
  test('medium confidence → false', () => {
    expect(shouldAutoAttach([{ confidence: 'medium', ambiguity_warnings: [] }])).toBe(false);
  });
  test('low confidence → false', () => {
    expect(shouldAutoAttach([{ confidence: 'low', ambiguity_warnings: [] }])).toBe(false);
  });
  test('multiple candidates → false', () => {
    expect(shouldAutoAttach([
      { confidence: 'high', ambiguity_warnings: [] },
      { confidence: 'high', ambiguity_warnings: [] },
    ])).toBe(false);
  });
  test('high but ambiguity_warnings non-empty → false', () => {
    expect(shouldAutoAttach([{ confidence: 'high', ambiguity_warnings: ['multiple_high_confidence_candidates'] }])).toBe(false);
  });
  test('empty array → false', () => {
    expect(shouldAutoAttach([])).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────
// reconcileBatch — validation
// ──────────────────────────────────────────────────────────────
describe('reconcileBatch — validation', () => {
  test('missing userId → 400', async () => {
    const store = makeStore();
    const out = await reconcileBatch(store, { leads: [] });
    expect(out.ok).toBe(false);
    expect(out.status).toBe(400);
  });
  test('missing leads array → 400', async () => {
    const store = makeStore();
    const out = await reconcileBatch(store, { userId: 2 });
    expect(out.ok).toBe(false);
    expect(out.status).toBe(400);
  });
  test('empty leads array → ok with zero counts', async () => {
    const store = makeStore();
    const out = await reconcileBatch(store, { userId: 2, leads: [] });
    expect(out.ok).toBe(true);
    expect(out.summary).toEqual({ total: 0, auto_attached: 0, needs_review: 0, no_match: 0, error: 0 });
    expect(out.results).toEqual([]);
  });
  test('batch over MAX_BATCH_SIZE → 400', async () => {
    const store = makeStore();
    const leads = Array.from({ length: MAX_BATCH_SIZE + 1 }, (_, i) => ({ lb_lead_id: 'l-' + i }));
    const out = await reconcileBatch(store, { userId: 2, leads });
    expect(out.ok).toBe(false);
    expect(out.error).toBe('batch_too_large');
  });
});

// ──────────────────────────────────────────────────────────────
// THE Erin Davis case
// ──────────────────────────────────────────────────────────────
describe('reconcileBatch — Erin Davis automatic match', () => {
  test('auto-attaches without manual intervention', async () => {
    const store = makeStore({ jobs: [ERIN_JOB], customers: [ERIN_CUST] });
    const out = await reconcileBatch(store, { userId: 2, leads: [ERIN_LB_LEAD] });

    expect(out.ok).toBe(true);
    expect(out.dry_run).toBe(false);
    expect(out.summary).toEqual(expect.objectContaining({
      total: 1, auto_attached: 1, needs_review: 0, no_match: 0, error: 0,
    }));
    const r = out.results[0];
    expect(r.outcome).toBe('auto_attached');
    expect(r.lb_lead_id).toBe('65d7a387-aa7b-45fc-b9a2-1f36bf92c7ec');
    expect(r.sf_job_id).toBe(141929);
    expect(r.sf_customer_id).toBe(23427);
    expect(r.confidence).toBe('high');
    expect(r.match_signals).toEqual(expect.arrayContaining(['phone_exact:…2443', 'name_exact']));
    expect(r.sf_job_status).toBe('completed');
    expect(r.sf_job_payment_status).toBe('paid');
    expect(r.synthetic_status_event_id).toBe('evt_reconcile_141929_completed');
    expect(r.synthetic_status_event_enqueued).toBe(true);
    expect(r.action).toBe('attach');

    // Verify side effects on the store
    const job = store._rows[JOBS_TABLE][0];
    expect(job.lb_external_request_id).toBe('574011065576308746');
    expect(job.lb_channel).toBe('thumbtack');
    expect(job.lb_business_id).toBe('532386425642459138');
    expect(job.lb_lead_id).toBe('65d7a387-aa7b-45fc-b9a2-1f36bf92c7ec');

    const cust = store._rows[CUSTOMERS_TABLE][0];
    expect(cust.lb_lead_id).toBe('65d7a387-aa7b-45fc-b9a2-1f36bf92c7ec');

    expect(store._rows[AUDIT_TABLE]).toHaveLength(1);
    expect(store._rows[AUDIT_TABLE][0].action).toBe('attach');

    expect(store._rows[OUTBOX_TABLE]).toHaveLength(1);
    expect(store._rows[OUTBOX_TABLE][0].event_id).toBe('evt_reconcile_141929_completed');
  });

  test('dry-run: previews without any DB writes', async () => {
    const store = makeStore({ jobs: [ERIN_JOB], customers: [ERIN_CUST] });
    const out = await reconcileBatch(store, { userId: 2, leads: [ERIN_LB_LEAD], dryRun: true });

    expect(out.ok).toBe(true);
    expect(out.dry_run).toBe(true);
    expect(out.summary.auto_attach_preview).toBe(1);
    expect(out.summary.auto_attached).toBe(0);

    const r = out.results[0];
    expect(r.outcome).toBe('auto_attach_preview');
    expect(r.sf_job_id).toBe(141929);
    expect(r.confidence).toBe('high');

    // Zero writes
    expect(store._rows[JOBS_TABLE][0].lb_external_request_id).toBeNull();
    expect(store._rows[AUDIT_TABLE]).toHaveLength(0);
    expect(store._rows[OUTBOX_TABLE]).toHaveLength(0);
  });

  test('idempotency: re-running the same batch is safe (synthetic event_id collides → duplicate)', async () => {
    const store = makeStore({ jobs: [ERIN_JOB], customers: [ERIN_CUST] });
    const out1 = await reconcileBatch(store, { userId: 2, leads: [ERIN_LB_LEAD] });
    expect(out1.results[0].synthetic_status_event_enqueued).toBe(true);

    // Second call against the now-linked job → reattach_same
    const out2 = await reconcileBatch(store, { userId: 2, leads: [ERIN_LB_LEAD] });
    expect(out2.ok).toBe(true);
    expect(out2.results[0].outcome).toBe('auto_attached');
    expect(out2.results[0].action).toBe('reattach_same');
    expect(out2.results[0].synthetic_status_event_duplicate).toBe(true);

    // Still only one outbox row
    expect(store._rows[OUTBOX_TABLE]).toHaveLength(1);
  });
});

// ──────────────────────────────────────────────────────────────
// Non-auto outcomes
// ──────────────────────────────────────────────────────────────
describe('reconcileBatch — needs_review / no_match', () => {
  test('multiple high-confidence candidates → needs_review reason=multiple_candidates', async () => {
    const dup1 = { ...ERIN_CUST, id: 1 };
    const dup2 = { ...ERIN_CUST, id: 2, first_name: 'Different' };
    const dup3 = { ...ERIN_CUST, id: 3, first_name: 'Different', last_name: 'Lastname' };  // same phone, different name
    const jobs = [
      { ...ERIN_JOB, id: 11, customer_id: 1 },
      { ...ERIN_JOB, id: 12, customer_id: 2 },
      { ...ERIN_JOB, id: 13, customer_id: 3 },
    ];
    const store = makeStore({ customers: [dup1, dup2, dup3], jobs });
    const out = await reconcileBatch(store, { userId: 2, leads: [ERIN_LB_LEAD] });
    expect(out.summary.needs_review).toBe(1);
    expect(out.summary.auto_attached).toBe(0);
    expect(out.results[0].outcome).toBe('needs_review');
    expect(out.results[0].reason).toBe('multiple_candidates');
    expect(out.results[0].candidates.length).toBeGreaterThanOrEqual(2);
    // Each candidate carries the ambiguity warning
    for (const c of out.results[0].candidates) {
      expect(c.ambiguity_warnings).toContain('multiple_high_confidence_candidates');
    }
  });

  test('SF job already linked to a different lb_external_request_id → needs_review reason=conflict', async () => {
    const linkedJob = { ...ERIN_JOB,
      lb_external_request_id: 'OTHER_REQ_ID', lb_channel: 'yelp',
    };
    const store = makeStore({ jobs: [linkedJob], customers: [ERIN_CUST] });
    const out = await reconcileBatch(store, { userId: 2, leads: [ERIN_LB_LEAD] });
    expect(out.summary.needs_review).toBe(1);
    expect(out.results[0].reason).toBe('sf_job_linked_to_different_lb_lead');
    // No mutations performed (still linked to OTHER)
    expect(store._rows[JOBS_TABLE][0].lb_external_request_id).toBe('OTHER_REQ_ID');
    expect(store._rows[AUDIT_TABLE]).toHaveLength(0);
    expect(store._rows[OUTBOX_TABLE]).toHaveLength(0);
  });

  test('no match → outcome=no_match', async () => {
    const store = makeStore({ customers: [], jobs: [] });
    const out = await reconcileBatch(store, { userId: 2, leads: [ERIN_LB_LEAD] });
    expect(out.summary.no_match).toBe(1);
    expect(out.results[0].outcome).toBe('no_match');
  });

  test('low-confidence (name only, no phone/email) → needs_review reason=low_confidence', async () => {
    const cust = { ...ERIN_CUST, phone: null, email: null };   // no phone match possible
    const store = makeStore({ customers: [cust], jobs: [{ ...ERIN_JOB, scheduled_date: null }] });
    const out = await reconcileBatch(store, {
      userId: 2,
      leads: [{ ...ERIN_LB_LEAD, customer_phone: null, lead_created_at: null }],
    });
    expect(out.summary.needs_review).toBe(1);
    expect(out.results[0].reason).toBe('low_confidence');
    expect(out.results[0].candidates[0].confidence).toBe('low');
  });
});

// ──────────────────────────────────────────────────────────────
// Tenant isolation
// ──────────────────────────────────────────────────────────────
describe('reconcileBatch — tenant isolation', () => {
  test('another tenant\'s same-phone customer is not matched', async () => {
    const otherTenantCust = { ...ERIN_CUST, user_id: 999 };
    const otherTenantJob  = { ...ERIN_JOB, user_id: 999 };
    const store = makeStore({ customers: [otherTenantCust], jobs: [otherTenantJob] });
    const out = await reconcileBatch(store, { userId: 2, leads: [ERIN_LB_LEAD] });
    expect(out.summary.no_match).toBe(1);
    expect(out.results[0].outcome).toBe('no_match');
  });
});

// ──────────────────────────────────────────────────────────────
// Failure isolation
// ──────────────────────────────────────────────────────────────
describe('reconcileBatch — failure isolation', () => {
  test('one lead with no input signals returns no_match while another lead auto-attaches', async () => {
    const store = makeStore({ jobs: [ERIN_JOB], customers: [ERIN_CUST] });
    const out = await reconcileBatch(store, {
      userId: 2,
      leads: [
        ERIN_LB_LEAD,                                        // matches
        { lb_lead_id: 'empty-1' },                           // no signals → no_match
        { lb_lead_id: 'empty-2', customer_phone: null },     // also no signals
      ],
    });
    expect(out.summary.total).toBe(3);
    expect(out.summary.auto_attached).toBe(1);
    expect(out.summary.no_match).toBe(2);
    expect(out.results[0].outcome).toBe('auto_attached');
    expect(out.results[1].outcome).toBe('no_match');
    expect(out.results[2].outcome).toBe('no_match');
  });
});

// ──────────────────────────────────────────────────────────────
// Mixed batch — comprehensive
// ──────────────────────────────────────────────────────────────
describe('reconcileBatch — mixed batch produces correct roll-up', () => {
  test('batch with auto + needs_review + no_match', async () => {
    // Customer 1 = Erin (auto-attach), Customer 2 = name-only (low-confidence needs_review)
    const erinCust = { ...ERIN_CUST };
    const lowCust  = { id: 999, user_id: 2, first_name: 'Other', last_name: 'Person', phone: null, email: null, lb_lead_id: null, created_at: '2026-04-01T00:00:00Z' };
    const erinJob  = { ...ERIN_JOB };
    const store = makeStore({ jobs: [erinJob], customers: [erinCust, lowCust] });
    const out = await reconcileBatch(store, {
      userId: 2,
      leads: [
        ERIN_LB_LEAD,
        { lb_lead_id: 'lb-low',    customer_name: 'Other Person',  customer_phone: null },
        { lb_lead_id: 'lb-nomatch', customer_phone: '0000000000',  customer_name: 'Nobody Here' },
      ],
    });
    expect(out.summary.total).toBe(3);
    expect(out.summary.auto_attached).toBe(1);
    expect(out.summary.needs_review).toBe(1);
    expect(out.summary.no_match).toBe(1);
  });
});
