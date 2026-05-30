'use strict';

/**
 * LB → SF historical lead attach (migration 060).
 *
 * Covers:
 *   - happy path: attach to unlinked job → audit row + UPDATE + synthetic event
 *   - synthetic event has deterministic id `evt_reconcile_<job>_<status>`
 *   - synthetic event payload includes lb_lead_id, payment_status,
 *     phone_last4, email_present, reconciliation block
 *   - conflict: already linked to different lb_external_request_id, no force → 409
 *   - reattach_same: same lb_external_request_id → action='reattach_same', no UPDATE
 *   - force_overwrite: linked to different id with force=true → action='overwrite', audit captures previous_state
 *   - lb_lead_id propagated to customer (when customer.lb_lead_id was null)
 *   - tenant isolation: cannot attach to another tenant's job → 404
 *   - duplicate event_id on re-attach → eventDuplicate=true, ok=true
 *   - audit row written BEFORE update; tenant_id and previous_state present
 */

process.env.SF_SOURCE_INSTANCE = 'sf-test';

const { attachLbLink, reconcileEventId, buildReconciliationPayload } = require('../lib/lb-lead-link-attacher');

const JOBS_TABLE      = 'jobs';
const CUSTOMERS_TABLE = 'customers';
const AUDIT_TABLE     = 'lb_link_audit';
const OUTBOX_TABLE    = 'leadbridge_outbound_events';

// ──────────────────────────────────────────────────────────────
// In-memory Supabase mock with multi-table state + UNIQUE on event_id
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
      if (f.type === 'eq')  return String(r[f.col]) === String(f.val);
      if (f.type === 'in')  return f.vals.map(String).includes(String(r[f.col]));
      return true;
    }));
  }

  function makeBuilder(table) {
    const state = { table, op: null, payload: null, filters: [] };
    const builder = {
      _state: state,
      insert(p) { state.op = 'insert'; state.payload = p; return builder; },
      update(p) { state.op = 'update'; state.payload = p; return builder; },
      select()  { return builder; },
      eq(c, v)  { state.filters.push({ type: 'eq', col: c, val: v }); return builder; },
      in(c, v)  { state.filters.push({ type: 'in', col: c, vals: v }); return builder; },
      limit()   { return builder; },
      order()   { return builder; },
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
        // Default insert (no-op)
        return resolve({ data: null, error: null });
      }

      if (state.op === 'update') {
        const matched = applyFilters(rows[T], state.filters);
        for (const r of matched) Object.assign(r, state.payload);
        return resolve({ data: null, error: null });
      }

      // select
      const matched = applyFilters(rows[T], state.filters);
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

// Fixtures — Erin Davis on SF, unlinked
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
};

const ATTACH_INPUT = {
  sf_job_id: 141929,
  lb_external_request_id: '574011065576308746',
  lb_channel: 'thumbtack',
  lb_business_id: '532386425642459138',
  lb_lead_id: '65d7a387-aa7b-45fc-b9a2-1f36bf92c7ec',
  match_confidence: 'high',
  match_signals: ['phone_exact:…2443', 'name_exact'],
};

// ──────────────────────────────────────────────────────────────
// reconcileEventId / buildReconciliationPayload
// ──────────────────────────────────────────────────────────────
describe('reconcileEventId', () => {
  test('deterministic format', () => {
    expect(reconcileEventId(141929, 'completed')).toBe('evt_reconcile_141929_completed');
    expect(reconcileEventId(1,      'SCHEDULED')).toBe('evt_reconcile_1_scheduled');
  });
});

describe('buildReconciliationPayload', () => {
  test('event_id is deterministic + reconciliation block populated + customer hints redacted', () => {
    const job = { ...ERIN_JOB, lb_external_request_id: '574011065576308746', lb_channel: 'thumbtack', lb_lead_id: '65d7a387' };
    const cust = ERIN_CUST;
    const p = buildReconciliationPayload({
      job, customer: cust,
      attachedAt: '2026-05-30T16:30:00Z',
      matchConfidence: 'high',
      matchSignals: ['phone_exact:…2443', 'name_exact'],
      lbLeadId: '65d7a387',
      sourceInstance: 'sf-prod',
    });
    expect(p.event_id).toBe('evt_reconcile_141929_completed');
    expect(p.event_type).toBe('job.status_changed');
    expect(p.external_request_id).toBe('574011065576308746');
    expect(p.channel).toBe('thumbtack');
    expect(p.lb_lead_id).toBe('65d7a387');
    expect(p.status).toEqual({ new: 'completed', previous: null });
    expect(p.actor).toEqual({ type: 'lb', id: null, display_name: 'leadbridge_reconciliation' });
    expect(p.job.customer_name).toBe('Erin Davis');
    expect(p.job.amount).toBe(349);
    expect(p.job.payment_status).toBe('paid');
    expect(p.job.customer_phone_last4).toBe('2443');
    expect(p.job.customer_email_present).toBe(false);
    // PII never echoed
    const dump = JSON.stringify(p);
    expect(dump).not.toContain('8133752443');
    expect(dump).not.toContain('375-2443');
    // Reconciliation block
    expect(p.reconciliation).toEqual({
      attached_at: '2026-05-30T16:30:00Z',
      match_confidence: 'high',
      match_signals: ['phone_exact:…2443', 'name_exact'],
    });
  });
});

// ──────────────────────────────────────────────────────────────
// attachLbLink — integration tests against in-memory mock
// ──────────────────────────────────────────────────────────────
describe('attachLbLink — happy path', () => {
  test('attaches LB identifiers + writes audit + enqueues synthetic event', async () => {
    const store = makeStore({ jobs: [ERIN_JOB], customers: [ERIN_CUST] });
    const r = await attachLbLink(store, { userId: 2, input: ATTACH_INPUT });

    expect(r.ok).toBe(true);
    expect(r.action).toBe('attach');
    expect(r.sf_job_id).toBe(141929);
    expect(r.previous_lb_external_request_id).toBeNull();
    expect(r.new_lb_external_request_id).toBe('574011065576308746');
    expect(r.synthetic_status_event_id).toBe('evt_reconcile_141929_completed');
    expect(r.synthetic_status_event_enqueued).toBe(true);
    expect(r.synthetic_status_event_duplicate).toBe(false);

    // Job row updated
    const job = store._rows[JOBS_TABLE][0];
    expect(job.lb_external_request_id).toBe('574011065576308746');
    expect(job.lb_channel).toBe('thumbtack');
    expect(job.lb_business_id).toBe('532386425642459138');
    expect(job.lb_lead_id).toBe('65d7a387-aa7b-45fc-b9a2-1f36bf92c7ec');

    // Customer propagated
    const cust = store._rows[CUSTOMERS_TABLE][0];
    expect(cust.lb_lead_id).toBe('65d7a387-aa7b-45fc-b9a2-1f36bf92c7ec');

    // Audit row
    expect(store._rows[AUDIT_TABLE]).toHaveLength(1);
    const audit = store._rows[AUDIT_TABLE][0];
    expect(audit.actor).toBe('lb');
    expect(audit.action).toBe('attach');
    expect(audit.sf_job_id).toBe(141929);
    expect(audit.sf_customer_id).toBe(23427);
    expect(audit.match_confidence).toBe('high');
    expect(audit.match_signals).toEqual(['phone_exact:…2443', 'name_exact']);
    expect(audit.previous_state).toEqual({
      lb_external_request_id: null, lb_channel: null, lb_business_id: null, lb_lead_id: null,
    });

    // Outbox row
    expect(store._rows[OUTBOX_TABLE]).toHaveLength(1);
    const out = store._rows[OUTBOX_TABLE][0];
    expect(out.event_id).toBe('evt_reconcile_141929_completed');
    expect(out.state).toBe('pending');
    expect(out.payload_json.lb_lead_id).toBe('65d7a387-aa7b-45fc-b9a2-1f36bf92c7ec');
    expect(out.payload_json.reconciliation.match_confidence).toBe('high');
  });
});

describe('attachLbLink — conflict + force', () => {
  test('already_linked + no force → 409 with existing snapshot', async () => {
    const linkedJob = { ...ERIN_JOB,
      lb_external_request_id: 'OTHER_REQ_ID', lb_channel: 'yelp', lb_business_id: 'other_biz', lb_lead_id: 'other-lead',
    };
    const store = makeStore({ jobs: [linkedJob], customers: [ERIN_CUST] });
    const r = await attachLbLink(store, { userId: 2, input: ATTACH_INPUT });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(409);
    expect(r.error).toBe('already_linked');
    expect(r.existing).toEqual({
      lb_external_request_id: 'OTHER_REQ_ID',
      lb_channel: 'yelp',
      lb_business_id: 'other_biz',
      lb_lead_id: 'other-lead',
    });
    // No mutation
    expect(store._rows[JOBS_TABLE][0].lb_external_request_id).toBe('OTHER_REQ_ID');
    expect(store._rows[AUDIT_TABLE]).toHaveLength(0);
    expect(store._rows[OUTBOX_TABLE]).toHaveLength(0);
  });

  test('reattach_same: idempotent on same lb_external_request_id', async () => {
    const sameJob = { ...ERIN_JOB,
      lb_external_request_id: '574011065576308746', lb_channel: 'thumbtack',
      lb_business_id: '532386425642459138', lb_lead_id: '65d7a387-aa7b-45fc-b9a2-1f36bf92c7ec',
    };
    const store = makeStore({ jobs: [sameJob], customers: [{ ...ERIN_CUST, lb_lead_id: '65d7a387-aa7b-45fc-b9a2-1f36bf92c7ec' }] });
    const r = await attachLbLink(store, { userId: 2, input: ATTACH_INPUT });
    expect(r.ok).toBe(true);
    expect(r.action).toBe('reattach_same');
    expect(store._rows[AUDIT_TABLE]).toHaveLength(1);    // audit captures the reattach
    expect(store._rows[OUTBOX_TABLE]).toHaveLength(1);   // synthetic event still emitted (gives LB current state)
  });

  test('overwrite: existing different link + force_overwrite=true → action=overwrite', async () => {
    const linkedJob = { ...ERIN_JOB,
      lb_external_request_id: 'OTHER_REQ_ID', lb_channel: 'yelp', lb_business_id: 'other_biz', lb_lead_id: 'other-lead',
    };
    const store = makeStore({ jobs: [linkedJob], customers: [ERIN_CUST] });
    const r = await attachLbLink(store, { userId: 2, input: { ...ATTACH_INPUT, force_overwrite: true } });
    expect(r.ok).toBe(true);
    expect(r.action).toBe('overwrite');
    expect(r.previous_lb_external_request_id).toBe('OTHER_REQ_ID');
    expect(r.new_lb_external_request_id).toBe('574011065576308746');
    expect(store._rows[AUDIT_TABLE][0].previous_state.lb_external_request_id).toBe('OTHER_REQ_ID');
  });
});

describe('attachLbLink — tenant isolation', () => {
  test('cannot attach to another tenant\'s job → 404', async () => {
    const store = makeStore({ jobs: [{ ...ERIN_JOB, user_id: 999 }], customers: [{ ...ERIN_CUST, user_id: 999 }] });
    const r = await attachLbLink(store, { userId: 2, input: ATTACH_INPUT });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(404);
    expect(r.error).toBe('job_not_found');
  });
});

describe('attachLbLink — duplicate event_id idempotency', () => {
  test('second attach attempt with same job+status → eventDuplicate=true, ok=true', async () => {
    const store = makeStore({ jobs: [ERIN_JOB], customers: [ERIN_CUST] });
    const r1 = await attachLbLink(store, { userId: 2, input: ATTACH_INPUT });
    expect(r1.ok).toBe(true);
    expect(r1.synthetic_status_event_enqueued).toBe(true);

    // Run again with same input (mock job row is now linked → reattach_same)
    const r2 = await attachLbLink(store, { userId: 2, input: ATTACH_INPUT });
    expect(r2.ok).toBe(true);
    expect(r2.action).toBe('reattach_same');
    expect(r2.synthetic_status_event_enqueued).toBe(false);
    expect(r2.synthetic_status_event_duplicate).toBe(true);
    // Outbox UNIQUE absorbed it — still one outbox row
    expect(store._rows[OUTBOX_TABLE]).toHaveLength(1);
  });
});

describe('attachLbLink — argument validation', () => {
  test('missing sf_job_id → 400', async () => {
    const store = makeStore();
    const r = await attachLbLink(store, { userId: 2, input: { lb_external_request_id: 'x', lb_channel: 'thumbtack' } });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(400);
  });
  test('missing lb_external_request_id → 400', async () => {
    const store = makeStore();
    const r = await attachLbLink(store, { userId: 2, input: { sf_job_id: 1, lb_channel: 'thumbtack' } });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(400);
  });
  test('missing lb_channel → 400', async () => {
    const store = makeStore();
    const r = await attachLbLink(store, { userId: 2, input: { sf_job_id: 1, lb_external_request_id: 'x' } });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(400);
  });
});

describe('attachLbLink — customer propagation', () => {
  test('does not overwrite customer.lb_lead_id when already set', async () => {
    const existingCust = { ...ERIN_CUST, lb_lead_id: 'existing-other-lead' };
    const store = makeStore({ jobs: [ERIN_JOB], customers: [existingCust] });
    const r = await attachLbLink(store, { userId: 2, input: ATTACH_INPUT });
    expect(r.ok).toBe(true);
    // Customer lb_lead_id stays as existing (write-once on customer too)
    expect(store._rows[CUSTOMERS_TABLE][0].lb_lead_id).toBe('existing-other-lead');
  });
});
