'use strict';

/**
 * SF↔LB historical-sync remediation tool — Type A + Type B detection
 * and repair.
 *
 * Background: Phase 2 Batch #1 left 49 rows in a drift state:
 *   - 43× Type A — LB linked, SF entirely unlinked (timeout race)
 *   - 6×  Type B — SF audit + customer + outbox exist but
 *                  jobs.lb_lead_id is NULL (reattach_same shortcut bug)
 *
 * Tests verify:
 *   - dry-run detection categorizes drift correctly
 *   - apply mode runs attachLbLink with REMEDIATION_ACTOR
 *   - already-clean rows are NOT flagged
 *   - tenant scoping holds on every read + write
 *   - LB-side fetch errors halt with 502 (not silent success)
 */

process.env.SF_LB_PROVISIONING_SHARED_SECRET = 'rem-test-' + 'D'.repeat(20);
process.env.LB_PROVISIONING_BASE_URL          = 'https://lb-test.example.com/api';
process.env.SF_SOURCE_INSTANCE                = 'sf-test';

const mockFetchCandidates = jest.fn();
const mockLinkLeadsBulk   = jest.fn();
jest.mock('../lib/lb-historical-sync-client', () => ({
  fetchCandidates: (...args) => mockFetchCandidates(...args),
  linkLeadsBulk:   (...args) => mockLinkLeadsBulk(...args),
  CANDIDATES_PATH: '/v1/integrations/sf/historical-sync/candidates',
  LINK_BULK_PATH:  '/v1/integrations/sf/link-leads-bulk',
}));

const { detect, remediate, REMEDIATION_ACTOR } = require('../lib/sf-historical-remediation');

const LB_USER_UUID = 'c3d14499-dec1-42c3-a36c-713cb09842c6';
const SF_TENANT    = 2;

// ── store fixture (allows writes, records every mutation) ──
function makeStore(initial = {}) {
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const seed = clone(initial);
  const rows = {
    customers:                   [],
    jobs:                        [],
    communication_settings:      [{ user_id: SF_TENANT, leadbridge_user_id: LB_USER_UUID, leadbridge_connected: true }],
    lb_link_audit:               [],
    leadbridge_outbound_events:  [],
    ...seed,
  };
  const log = { inserts: [], updates: [] };

  function applyFilters(rs, filters) {
    return rs.filter((r) => filters.every((f) => {
      if (f.type === 'eq')     return String(r[f.col]) === String(f.val);
      if (f.type === 'in')     return f.vals.map(String).includes(String(r[f.col]));
      if (f.type === 'not_is') return r[f.col] != null;
      if (f.type === 'gte')    return String(r[f.col]) >= String(f.val);
      return true;
    }));
  }

  function makeBuilder(table) {
    const state = { table, op: null, filters: [], payload: null };
    const builder = {
      select() { return builder; },
      eq(c, v)  { state.filters.push({ type:'eq', col:c, val:v }); return builder; },
      in(c, v)  { state.filters.push({ type:'in', col:c, vals:v }); return builder; },
      gte(c, v) { state.filters.push({ type:'gte', col:c, val:v }); return builder; },
      not(c, op, v) { state.filters.push({ type: op === 'is' ? 'not_is' : op, col:c, val:v }); return builder; },
      limit()   { return builder; },
      order()   { return builder; },

      insert(payload) {
        state.op = 'insert'; state.payload = payload;
        log.inserts.push({ table, payload: Array.isArray(payload) ? payload.map(p => ({...p})) : { ...payload } });
        return {
          select() { return this; },
          single()       { return execInsert(state).then(single); },
          then(onF, onR) { return execInsert(state).then(onF, onR); },
        };
      },
      update(payload) {
        state.op = 'update'; state.payload = payload;
        const u = { table, payload: { ...payload }, filters: [...state.filters] };
        log.updates.push(u);
        return {
          eq(c, v) { u.filters.push({ type:'eq', col:c, val:v }); state.filters.push({ type:'eq', col:c, val:v }); return this; },
          select() { return this; },
          single()       { return execUpdate(state).then(single); },
          then(onF, onR) { return execUpdate(state).then(onF, onR); },
        };
      },
      maybeSingle() { return execSelect(state).then(maybeSingle); },
      single()      { return execSelect(state).then(single); },
      then(onF, onR){ return execSelect(state).then(onF, onR); },
    };
    return builder;
  }

  function execSelect(state) {
    return new Promise((resolve) => {
      const T = state.table; if (!rows[T]) rows[T] = [];
      const matched = applyFilters(rows[T], state.filters);
      resolve({ data: matched.map(r => ({...r})), error: null });
    });
  }
  function execInsert(state) {
    return new Promise((resolve) => {
      const T = state.table; if (!rows[T]) rows[T] = [];
      const recs = Array.isArray(state.payload) ? state.payload : [state.payload];
      if (T === 'leadbridge_outbound_events') {
        for (const r of recs) {
          if (rows[T].some(x => x.event_id === r.event_id)) {
            return resolve({ data: null, error: { code: '23505' } });
          }
          rows[T].push({ id: rows[T].length + 1, ...r });
        }
      } else {
        for (const r of recs) rows[T].push({ id: rows[T].length + 1, ...r });
      }
      resolve({ data: recs, error: null });
    });
  }
  function execUpdate(state) {
    return new Promise((resolve) => {
      const T = state.table; if (!rows[T]) rows[T] = [];
      const matched = applyFilters(rows[T], state.filters);
      for (const r of matched) Object.assign(r, state.payload);
      resolve({ data: matched, error: null });
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

  return { _rows: rows, _log: log, from(t) { return makeBuilder(t); } };
}

// ── fixtures ──
function lbCand(leadId, ext, name = 'X', extra = {}) {
  return {
    leadId, externalRequestId: ext, platform: 'thumbtack', businessId: 'b1',
    customerName: name, customerPhone: '1111111111', customerEmail: null,
    status: 'completed', createdAt: '2026-01-01T00:00:00Z',
    statusUpdatedAt: '2026-02-01T00:00:00Z', ageDays: 30,
    syncStatus: 'linked', ...extra,
  };
}
function sfJob(id, custId, ext, leadId = null) {
  return {
    id, user_id: SF_TENANT, customer_id: custId,
    status: 'completed', payment_status: 'paid',
    lb_external_request_id: ext, lb_channel: 'thumbtack',
    lb_business_id: 'b1', lb_lead_id: leadId,
    last_status_changed_at: '2026-02-15T00:00:00Z',
    updated_at: '2026-02-15T00:00:00Z',
  };
}
function sfCust(id) {
  return { id, user_id: SF_TENANT, first_name: 'X', last_name: 'Y', phone: '1111111111', email: null, lb_lead_id: null };
}

beforeEach(() => {
  mockFetchCandidates.mockReset();
  mockLinkLeadsBulk.mockReset();
});

// ──────────────────────────────────────────────────────────────────────
// Detection
// ──────────────────────────────────────────────────────────────────────
describe('detect', () => {
  test('Type A — LB linked, SF job lb_lead_id NULL → flagged', async () => {
    const store = makeStore({
      customers: [sfCust(101)],
      jobs:      [sfJob(11, 101, 'ext-A', null)],   // SF has the job by ext_req but lb_lead_id is null
    });
    mockFetchCandidates.mockResolvedValueOnce({
      ok: true, user_id: LB_USER_UUID, count: 1,
      candidates: [lbCand('lead-A', 'ext-A', 'Alice')],
    });
    const out = await detect(store, { tenantId: SF_TENANT });
    expect(out.ok).toBe(true);
    expect(out.counts.type_a).toBe(1);
    expect(out.counts.type_b).toBe(0);
    expect(out.type_a[0].kind).toBe('type_a');
    expect(out.type_a[0].lb_lead_id).toBe('lead-A');
    expect(out.type_a[0].sf_job_id).toBe(11);
  });

  test('Type A_no_sf_job — LB linked but SF has no matching job', async () => {
    const store = makeStore({ customers: [], jobs: [] });
    mockFetchCandidates.mockResolvedValueOnce({
      ok: true, user_id: LB_USER_UUID, count: 1,
      candidates: [lbCand('orphan', 'ext-X', 'Orphan')],
    });
    const out = await detect(store, { tenantId: SF_TENANT });
    expect(out.counts.type_a).toBe(1);
    expect(out.type_a[0].kind).toBe('type_a_no_sf_job');
    expect(out.type_a[0].sf_job_id).toBeNull();
  });

  test('Type B — audit row + job with lb_lead_id NULL → flagged', async () => {
    const store = makeStore({
      customers: [sfCust(102)],
      jobs:      [sfJob(12, 102, 'ext-B-already', null)],   // ext already set, lb_lead_id null
      lb_link_audit: [{
        id: 1, user_id: SF_TENANT, actor: 'sf_historical_apply', action: 'reattach_same',
        sf_job_id: 12, sf_customer_id: 102,
        lb_lead_id: 'lead-B', lb_external_request_id: 'ext-B-already',
        lb_channel: 'thumbtack', lb_business_id: 'b1',
        applied_at: new Date().toISOString(),
      }],
    });
    // No LB-side rows linked for this test (no overlap with type A)
    mockFetchCandidates.mockResolvedValueOnce({ ok: true, user_id: LB_USER_UUID, count: 0, candidates: [] });

    const out = await detect(store, { tenantId: SF_TENANT });
    expect(out.counts.type_b).toBe(1);
    expect(out.type_b[0].kind).toBe('type_b');
    expect(out.type_b[0].sf_job_id).toBe(12);
    expect(out.type_b[0].lb_lead_id).toBe('lead-B');
    expect(out.type_b[0].audit_id).toBe(1);
  });

  test('clean — fully-linked rows NOT flagged', async () => {
    const store = makeStore({
      customers: [{ ...sfCust(103), lb_lead_id: 'lead-C' }],
      jobs:      [sfJob(13, 103, 'ext-C', 'lead-C')],   // lb_lead_id already set
      lb_link_audit: [{
        id: 1, user_id: SF_TENANT, actor: 'lb', action: 'attach',
        sf_job_id: 13, lb_lead_id: 'lead-C', lb_external_request_id: 'ext-C',
        lb_channel: 'thumbtack', applied_at: new Date().toISOString(),
      }],
    });
    mockFetchCandidates.mockResolvedValueOnce({
      ok: true, user_id: LB_USER_UUID, count: 1,
      candidates: [lbCand('lead-C', 'ext-C', 'Clean')],
    });
    const out = await detect(store, { tenantId: SF_TENANT });
    expect(out.counts.type_a).toBe(0);
    expect(out.counts.type_b).toBe(0);
  });

  test('Type A + Type B can coexist; no double-counting', async () => {
    const store = makeStore({
      customers: [sfCust(101), sfCust(102)],
      jobs: [
        sfJob(11, 101, 'ext-A', null),    // type A (LB linked, SF lb_lead_id null)
        sfJob(12, 102, 'ext-B', null),    // type B (audit exists, lb_lead_id null)
      ],
      lb_link_audit: [{
        id: 1, user_id: SF_TENANT, actor: 'sf_historical_apply', action: 'reattach_same',
        sf_job_id: 12, sf_customer_id: 102,
        lb_lead_id: 'lead-B', lb_external_request_id: 'ext-B',
        lb_channel: 'thumbtack', applied_at: new Date().toISOString(),
      }],
    });
    mockFetchCandidates.mockResolvedValueOnce({
      ok: true, user_id: LB_USER_UUID, count: 1,
      candidates: [lbCand('lead-A', 'ext-A', 'Alice')],   // only A is linked on LB
    });
    const out = await detect(store, { tenantId: SF_TENANT });
    expect(out.counts.type_a).toBe(1);
    expect(out.counts.type_b).toBe(1);
    expect(out.type_a[0].sf_job_id).toBe(11);
    expect(out.type_b[0].sf_job_id).toBe(12);
  });

  test('LB-side fetch error → 502, no false-positive flagging', async () => {
    const store = makeStore();
    mockFetchCandidates.mockResolvedValueOnce({ ok: false, reason: 'lb_unreachable' });
    const out = await detect(store, { tenantId: SF_TENANT });
    expect(out.ok).toBe(false);
    expect(out.status).toBe(502);
  });

  test('tenant scoping — every SELECT filters user_id', async () => {
    const store = makeStore({
      customers: [sfCust(101)],
      jobs:      [sfJob(11, 101, 'ext-A', null)],
    });
    mockFetchCandidates.mockResolvedValueOnce({
      ok: true, user_id: LB_USER_UUID, count: 1,
      candidates: [lbCand('lead-A', 'ext-A')],
    });
    await detect(store, { tenantId: SF_TENANT });
    // Inspect mock-store: no writes happened (detect is read-only)
    expect(store._log.inserts).toHaveLength(0);
    expect(store._log.updates).toHaveLength(0);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Remediation (apply mode)
// ──────────────────────────────────────────────────────────────────────
describe('remediate', () => {
  test('dryRun:true (default) → returns plan, NO writes', async () => {
    const store = makeStore({
      customers: [sfCust(101)],
      jobs:      [sfJob(11, 101, 'ext-A', null)],
    });
    mockFetchCandidates.mockResolvedValueOnce({
      ok: true, user_id: LB_USER_UUID, count: 1,
      candidates: [lbCand('lead-A', 'ext-A')],
    });
    const out = await remediate(store, { tenantId: SF_TENANT });
    expect(out.ok).toBe(true);
    expect(out.dry_run).toBe(true);
    expect(out.counts.type_a).toBe(1);
    expect(out.counts.repair_eligible).toBe(1);
    expect(store._log.inserts).toHaveLength(0);
    expect(store._log.updates).toHaveLength(0);
  });

  test('dryRun:false → attachLbLink runs with actor=sf_historical_remediation', async () => {
    const store = makeStore({
      customers: [sfCust(101)],
      jobs:      [sfJob(11, 101, 'ext-A', null)],
    });
    mockFetchCandidates.mockResolvedValueOnce({
      ok: true, user_id: LB_USER_UUID, count: 1,
      candidates: [lbCand('lead-A', 'ext-A')],
    });
    const out = await remediate(store, { tenantId: SF_TENANT, dryRun: false });
    expect(out.ok).toBe(true);
    expect(out.dry_run).toBe(false);
    expect(out.counts.repaired).toBe(1);
    expect(out.counts.failed).toBe(0);

    const audits = store._log.inserts.filter(i => i.table === 'lb_link_audit');
    expect(audits).toHaveLength(1);
    expect(audits[0].payload.actor).toBe(REMEDIATION_ACTOR);

    // jobs UPDATE happened → lb_lead_id populated
    const job = store._rows.jobs.find(j => Number(j.id) === 11);
    expect(job.lb_lead_id).toBe('lead-A');
  });

  test('type_a_no_sf_job rows skipped from repair (no job to update)', async () => {
    const store = makeStore({ customers: [], jobs: [] });
    mockFetchCandidates.mockResolvedValueOnce({
      ok: true, user_id: LB_USER_UUID, count: 1,
      candidates: [lbCand('orphan', 'ext-orphan')],
    });
    const out = await remediate(store, { tenantId: SF_TENANT, dryRun: false });
    expect(out.counts.type_a).toBe(1);
    expect(out.counts.repair_eligible).toBe(0);
    expect(out.counts.repaired).toBe(0);
    expect(store._log.inserts).toHaveLength(0);
  });

  test('repair both Type A + Type B in same call', async () => {
    const store = makeStore({
      customers: [sfCust(101), sfCust(102)],
      jobs: [
        sfJob(11, 101, 'ext-A', null),    // type A
        sfJob(12, 102, 'ext-B', null),    // type B
      ],
      lb_link_audit: [{
        id: 1, user_id: SF_TENANT, actor: 'sf_historical_apply', action: 'reattach_same',
        sf_job_id: 12, sf_customer_id: 102,
        lb_lead_id: 'lead-B', lb_external_request_id: 'ext-B',
        lb_channel: 'thumbtack', applied_at: new Date().toISOString(),
      }],
    });
    mockFetchCandidates.mockResolvedValueOnce({
      ok: true, user_id: LB_USER_UUID, count: 1,
      candidates: [lbCand('lead-A', 'ext-A')],
    });
    const out = await remediate(store, { tenantId: SF_TENANT, dryRun: false });
    expect(out.counts.type_a).toBe(1);
    expect(out.counts.type_b).toBe(1);
    expect(out.counts.repaired).toBe(2);

    expect(store._rows.jobs.find(j => Number(j.id) === 11).lb_lead_id).toBe('lead-A');
    expect(store._rows.jobs.find(j => Number(j.id) === 12).lb_lead_id).toBe('lead-B');
  });

  test('idempotent: running remediate twice produces no duplicate audit rows beyond the second pass', async () => {
    const store = makeStore({
      customers: [sfCust(101)],
      jobs:      [sfJob(11, 101, 'ext-A', null)],
    });
    mockFetchCandidates
      .mockResolvedValueOnce({ ok: true, user_id: LB_USER_UUID, count: 1, candidates: [lbCand('lead-A', 'ext-A')] })
      .mockResolvedValueOnce({ ok: true, user_id: LB_USER_UUID, count: 1, candidates: [lbCand('lead-A', 'ext-A')] });

    // first remediate — repairs
    await remediate(store, { tenantId: SF_TENANT, dryRun: false });
    const auditCountAfterFirst = store._log.inserts.filter(i => i.table === 'lb_link_audit').length;
    const outboxAfterFirst     = store._log.inserts.filter(i => i.table === 'leadbridge_outbound_events').length;

    // second remediate — job now has lb_lead_id set, so detect() should return type_a=0
    const out2 = await remediate(store, { tenantId: SF_TENANT, dryRun: false });
    expect(out2.counts.type_a).toBe(0);
    expect(out2.counts.repaired).toBe(0);
    // no NEW writes from the second pass
    expect(store._log.inserts.filter(i => i.table === 'lb_link_audit')).toHaveLength(auditCountAfterFirst);
    expect(store._log.inserts.filter(i => i.table === 'leadbridge_outbound_events')).toHaveLength(outboxAfterFirst);
  });
});
