'use strict';

/**
 * SF-driven historical sync — Phase 2 APPLY mode.
 *
 * Order of operations under test (LB consents to each row BEFORE SF
 * persists anything):
 *
 *   per-tenant lock → resolve LB user → fetch fresh LB candidates →
 *   re-match → isApplicable gate → drift check → pre-LB SF-state
 *   already-linked check → POST LB /link-leads-bulk → attachLbLink only
 *   for rows in LB's applied[].
 *
 * Covers (per the implementation plan, §12):
 *   1.  Erin Davis happy path: LB confirms; attachLbLink runs; audit
 *       row written; deterministic outbox event enqueued.
 *   2.  LB rejects row → no SF writes for that row.
 *   3.  Already-linked row → skipped before LB call.
 *   4.  Low/medium confidence → skipped_drift, no LB call for row.
 *   5.  Ambiguity warnings → skipped_drift, no LB call for row.
 *   6.  Partial success: 2 applied + 1 rejected.
 *   7.  Drift halt (require_no_drift=true): 409, zero LB calls.
 *   8.  Drift skip-and-continue (require_no_drift=false).
 *   9.  LB 5xx halt → 502, zero SF writes.
 *  10.  Concurrent apply lock → 409 apply_in_progress.
 *  11.  Apply without expected_matches → 400 apply_matches_required.
 *  12.  occurred_at uses jobs.last_status_changed_at (NEVER now()).
 *  13.  match_basis + sf_status field names land in LB payload verbatim.
 *  14.  Cross-tenant: orchestrator scopes every write WHERE user_id=tenantId.
 *
 * Notes:
 *   - findMatchCandidates is mocked so each test pins the per-lead
 *     matcher result (confidence, ambiguity, sf_job_id).
 *   - linkLeadsBulk is mocked so we drive LB's response per test.
 *   - The store fixture allows writes but RECORDS them, so we can
 *     assert exactly what landed on jobs / customers / lb_link_audit /
 *     leadbridge_outbound_events.
 */

process.env.SF_LB_PROVISIONING_SHARED_SECRET = 'p2-apply-test-' + 'C'.repeat(20);
process.env.LB_PROVISIONING_BASE_URL          = 'https://lb-test.example.com/api';
process.env.SF_SOURCE_INSTANCE                = 'sf-test';

// ── mocks ──
const mockFetchCandidates = jest.fn();
const mockLinkLeadsBulk   = jest.fn();
jest.mock('../lib/lb-historical-sync-client', () => ({
  fetchCandidates: (...args) => mockFetchCandidates(...args),
  linkLeadsBulk:   (...args) => mockLinkLeadsBulk(...args),
  CANDIDATES_PATH: '/v1/integrations/sf/historical-sync/candidates',
  LINK_BULK_PATH:  '/v1/integrations/sf/link-leads-bulk',
}));

const mockFindMatchCandidates = jest.fn();
jest.mock('../lib/lb-lead-link-matcher', () => ({
  findMatchCandidates: (...args) => mockFindMatchCandidates(...args),
}));

const {
  runHistoricalSyncApply,
  isApplicable,
  buildLbApplyMatch,
  APPLY_ACTOR,
  APPLY_REASON,
  MAX_APPLY_BATCH,
} = require('../lib/sf-historical-sync-orchestrator');

const LB_USER_UUID = 'c3d14499-dec1-42c3-a36c-713cb09842c6';
const SF_TENANT    = 2;

// ──────────────────────────────────────────────────────────────────────
// Test store — supports writes + tracks every insert/update.
// Cross-tenant writes (missing WHERE user_id=tenantId) are detected by
// the orchestrator code itself (it always passes .eq('user_id',
// tenantId)). The store doesn't auto-enforce — we add an explicit test
// that inspects the filter chain on each update.
// ──────────────────────────────────────────────────────────────────────
function makeStore(initial = {}) {
  // Deep-clone the seed so module-level fixtures (ERIN_JOB, ERIN_CUST)
  // are NOT mutated when attachLbLink runs UPDATE on them across tests.
  const clone = (obj) => JSON.parse(JSON.stringify(obj));
  const seed = clone(initial);
  const rows = {
    customers:                   [],
    jobs:                        [],
    communication_settings:      [{ user_id: SF_TENANT, leadbridge_user_id: LB_USER_UUID, leadbridge_connected: true }],
    lb_link_audit:               [],
    leadbridge_outbound_events:  [],
    sf_historical_apply_locks:   [],
    ...seed,
  };
  // mutation log
  const log = { inserts: [], updates: [], rpcCalls: [] };

  function rowsCopy(r) { return r.map(x => ({ ...x })); }

  function applyFilters(rs, filters) {
    return rs.filter((r) => filters.every((f) => {
      if (f.type === 'eq')   return String(r[f.col]) === String(f.val);
      if (f.type === 'in')   return f.vals.map(String).includes(String(r[f.col]));
      if (f.type === 'not_is' && f.val === null) return r[f.col] != null;
      return true;
    }));
  }

  function makeBuilder(table) {
    const state = { table, op: null, filters: [], payload: null, returning: false };
    const builder = {
      _state: state,
      select() { return builder; },
      eq(c, v)    { state.filters.push({ type: 'eq', col: c, val: v }); return builder; },
      in(c, v)    { state.filters.push({ type: 'in', col: c, vals: v }); return builder; },
      not(c, op, v) { state.filters.push({ type: op === 'is' ? 'not_is' : op, col: c, val: v }); return builder; },
      limit()     { return builder; },
      order()     { return builder; },

      insert(payload) {
        state.op = 'insert'; state.payload = payload;
        log.inserts.push({ table, payload: Array.isArray(payload) ? payload.map(p => ({...p})) : { ...payload }, filters: [...state.filters] });
        return {
          select() { return this; },
          single()      { return execInsert(state).then(single); },
          then(onF, onR){ return execInsert(state).then(onF, onR); },
        };
      },
      update(payload) {
        state.op = 'update'; state.payload = payload;
        const u = { table, payload: { ...payload }, filters: [...state.filters] };
        log.updates.push(u);
        return {
          eq(c, v)    { u.filters.push({ type: 'eq', col: c, val: v }); state.filters.push({ type: 'eq', col: c, val: v }); return this; },
          select() { return this; },
          single()      { return execUpdate(state).then(single); },
          then(onF, onR){ return execUpdate(state).then(onF, onR); },
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
      const T = state.table;
      if (!rows[T]) rows[T] = [];
      let matched = applyFilters(rows[T], state.filters);
      resolve({ data: rowsCopy(matched), error: null });
    });
  }
  function execInsert(state) {
    return new Promise((resolve) => {
      const T = state.table;
      if (!rows[T]) rows[T] = [];
      const recs = Array.isArray(state.payload) ? state.payload : [state.payload];
      // Outbox UNIQUE(event_id) — simulate 23505 on dup.
      if (T === 'leadbridge_outbound_events') {
        for (const r of recs) {
          if (rows[T].some(x => x.event_id === r.event_id)) {
            return resolve({ data: null, error: { code: '23505', message: 'duplicate event_id' } });
          }
          rows[T].push({ id: rows[T].length + 1, ...r });
        }
      } else {
        for (const r of recs) rows[T].push({ id: rows[T].length + 1, ...r });
      }
      resolve({ data: rowsCopy(recs), error: null });
    });
  }
  function execUpdate(state) {
    return new Promise((resolve) => {
      const T = state.table;
      if (!rows[T]) rows[T] = [];
      const matched = applyFilters(rows[T], state.filters);
      for (const r of matched) Object.assign(r, state.payload);
      resolve({ data: rowsCopy(matched), error: null });
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

  // RPC for the apply lock — uses the rows.sf_historical_apply_locks
  // table for fidelity to the migration logic.
  async function rpc(fn, params) {
    log.rpcCalls.push({ fn, params });
    if (fn === 'sf_historical_apply_try_acquire') {
      const t = Number(params.p_tenant_id);
      const existing = rows.sf_historical_apply_locks.find(r => r.tenant_id === t);
      if (!existing) {
        rows.sf_historical_apply_locks.push({ tenant_id: t, acquired_at: new Date().toISOString(), holder_note: params.p_holder_note || null });
        return { data: true, error: null };
      }
      return { data: false, error: null };
    }
    if (fn === 'sf_historical_apply_release') {
      const t = Number(params.p_tenant_id);
      rows.sf_historical_apply_locks = rows.sf_historical_apply_locks.filter(r => r.tenant_id !== t);
      return { data: true, error: null };
    }
    return { data: null, error: { message: 'unknown RPC ' + fn } };
  }

  return { _rows: rows, _log: log, from(t) { return makeBuilder(t); }, rpc };
}

// ── fixtures ──
const ERIN_CUST = {
  id: 23427, user_id: SF_TENANT,
  first_name: 'Erin', last_name: 'Davis',
  phone: '8133752443', email: null, lb_lead_id: null,
};
const ERIN_JOB = {
  id: 141929, user_id: SF_TENANT, customer_id: 23427,
  status: 'completed', payment_status: 'paid',
  scheduled_date: '2026-05-05T15:00:00Z',
  total_amount: 349, invoice_amount: null,
  lb_external_request_id: null, lb_channel: null, lb_business_id: null, lb_lead_id: null,
  last_status_changed_at: '2026-05-05T22:44:31Z',
  updated_at: '2026-05-05T22:44:31Z',
};
const ERIN_LB_CANDIDATE = {
  leadId:            '65d7a387-aa7b-45fc-b9a2-1f36bf92c7ec',
  externalRequestId: '574011065576308746',
  platform:          'thumbtack',
  businessId:        '532386425642459138',
  customerName:      'Erin Davis',
  customerPhone:     '8133752443',
  status:            'scheduled',
  createdAt:         '2026-03-10T15:31:00Z',
  statusUpdatedAt:   '2026-03-15T15:45:51Z',
  ageDays:           82,
};
// Matcher output shape for Erin (a "high confidence" perfect match)
const ERIN_MATCH = {
  sf_customer_id:    23427,
  sf_job_id:         141929,
  confidence:        'high',
  match_signals:     ['phone_exact:…2443', 'name_exact'],
  ambiguity_warnings: [],
  sf_job: { status: 'completed', payment_status: 'paid', last_status_changed_at: '2026-05-05T22:44:31Z' },
};

function lbCandidate(overrides = {}) {
  return { ...ERIN_LB_CANDIDATE, ...overrides };
}
function lbApplied(lbLeadId, extra = {}) {
  return { lb_lead_id: lbLeadId, sf_managed: true, ...extra };
}

beforeEach(() => {
  mockFetchCandidates.mockReset();
  mockLinkLeadsBulk.mockReset();
  mockFindMatchCandidates.mockReset();
});

// ──────────────────────────────────────────────────────────────────────
// isApplicable unit tests
// ──────────────────────────────────────────────────────────────────────
describe('isApplicable — Phase-2 apply gate', () => {
  test('happy path: high + single + no warnings + sf_job_id → ok', () => {
    const r = isApplicable({ lbCandidate: ERIN_LB_CANDIDATE, matched: [ERIN_MATCH] });
    expect(r.ok).toBe(true);
    expect(r.candidate.sf_job_id).toBe(141929);
  });
  test('exact confidence → ok', () => {
    const r = isApplicable({ lbCandidate: ERIN_LB_CANDIDATE, matched: [{ ...ERIN_MATCH, confidence: 'exact' }] });
    expect(r.ok).toBe(true);
  });
  test('medium → rejected', () => {
    const r = isApplicable({ lbCandidate: ERIN_LB_CANDIDATE, matched: [{ ...ERIN_MATCH, confidence: 'medium' }] });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('confidence_below_threshold');
  });
  test('low → rejected', () => {
    const r = isApplicable({ lbCandidate: ERIN_LB_CANDIDATE, matched: [{ ...ERIN_MATCH, confidence: 'low' }] });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('confidence_below_threshold');
  });
  test('ambiguity warnings present → rejected', () => {
    const r = isApplicable({ lbCandidate: ERIN_LB_CANDIDATE, matched: [{ ...ERIN_MATCH, ambiguity_warnings: ['multiple_high_confidence_candidates'] }] });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('ambiguity_warnings_present');
  });
  test('multiple candidates → rejected', () => {
    const r = isApplicable({ lbCandidate: ERIN_LB_CANDIDATE, matched: [ERIN_MATCH, ERIN_MATCH] });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('multiple_candidates');
  });
  test('zero candidates → no_match', () => {
    const r = isApplicable({ lbCandidate: ERIN_LB_CANDIDATE, matched: [] });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('no_match');
  });
  test('missing lb_lead_id → rejected', () => {
    const r = isApplicable({ lbCandidate: { ...ERIN_LB_CANDIDATE, leadId: null }, matched: [ERIN_MATCH] });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('lb_lead_id_missing');
  });
  test('sf_job_id null → rejected', () => {
    const r = isApplicable({ lbCandidate: ERIN_LB_CANDIDATE, matched: [{ ...ERIN_MATCH, sf_job_id: null }] });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('sf_job_id_missing');
  });

  // ────────────────────────────────────────────────────────────────
  // already_reconciled_customer guard — defense-in-depth at apply time.
  // Catches stale would_link approvals queued before the matcher
  // patch deployed, so the operator can't slip a remap through.
  // ────────────────────────────────────────────────────────────────
  test('matched customer has lb_lead_id set on customer row → rejected as already_reconciled_customer', () => {
    const m = { ...ERIN_MATCH, sf_customer: { lb_lead_id: 'lb-uuid-prior', any_job_linked: true } };
    const r = isApplicable({ lbCandidate: ERIN_LB_CANDIDATE, matched: [m] });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('already_reconciled_customer');
  });
  test('matched customer has any_job_linked=true (no customer.lb_lead_id) → rejected as already_reconciled_customer', () => {
    const m = { ...ERIN_MATCH, sf_customer: { lb_lead_id: null, any_job_linked: true } };
    const r = isApplicable({ lbCandidate: ERIN_LB_CANDIDATE, matched: [m] });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('already_reconciled_customer');
  });
  test('matched customer has no prior link → still ok (negative case)', () => {
    const m = { ...ERIN_MATCH, sf_customer: { lb_lead_id: null, any_job_linked: false } };
    const r = isApplicable({ lbCandidate: ERIN_LB_CANDIDATE, matched: [m] });
    expect(r.ok).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────
// buildLbApplyMatch — LB payload field names
// ──────────────────────────────────────────────────────────────────────
describe('buildLbApplyMatch — LB production field names', () => {
  test('uses match_basis (not match_signals) and sf_status (not sf_job_status)', () => {
    const m = buildLbApplyMatch({
      lbCandidate: ERIN_LB_CANDIDATE,
      matchedCandidate: ERIN_MATCH,
      sfJob: { status: 'completed', payment_status: 'paid', last_status_changed_at: '2026-05-05T22:44:31Z' },
    });
    expect(m).toEqual({
      lb_lead_id:        '65d7a387-aa7b-45fc-b9a2-1f36bf92c7ec',
      sf_job_id:         141929,
      sf_customer_id:    23427,
      confidence:        'high',
      match_basis:       ['phone_exact:…2443', 'name_exact'],
      sf_status:         'completed',
      sf_payment_status: 'paid',
      occurred_at:       '2026-05-05T22:44:31Z',
      reason:            APPLY_REASON,
    });
  });
  test('occurred_at falls back to updated_at when last_status_changed_at is null', () => {
    const m = buildLbApplyMatch({
      lbCandidate: ERIN_LB_CANDIDATE,
      matchedCandidate: ERIN_MATCH,
      sfJob: { status: 'completed', payment_status: 'paid', last_status_changed_at: null, updated_at: '2026-04-30T00:00:00Z' },
    });
    expect(m.occurred_at).toBe('2026-04-30T00:00:00Z');
  });
  test('NEVER uses now() — null when no historical timestamp available', () => {
    const m = buildLbApplyMatch({
      lbCandidate: ERIN_LB_CANDIDATE,
      matchedCandidate: ERIN_MATCH,
      sfJob: { status: 'completed', payment_status: 'paid', last_status_changed_at: null, updated_at: null },
    });
    expect(m.occurred_at).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────────
// runHistoricalSyncApply — Erin Davis happy path
// ──────────────────────────────────────────────────────────────────────
describe('runHistoricalSyncApply — Erin Davis happy path', () => {
  test('LB confirms → attachLbLink runs, audit row written, deterministic outbox event enqueued', async () => {
    const store = makeStore({ customers: [ERIN_CUST], jobs: [ERIN_JOB] });
    mockFetchCandidates.mockResolvedValueOnce({ ok: true, user_id: LB_USER_UUID, count: 1, candidates: [ERIN_LB_CANDIDATE], more_may_exist: false });
    mockFindMatchCandidates.mockResolvedValueOnce({ candidates: [ERIN_MATCH] });
    mockLinkLeadsBulk.mockResolvedValueOnce({ ok: true, status: 200, applied: [lbApplied(ERIN_LB_CANDIDATE.leadId)], rejected: [], summary: { total: 1 } });

    const out = await runHistoricalSyncApply(store, {
      tenantId: SF_TENANT,
      expectedMatches: [{ lb_lead_id: ERIN_LB_CANDIDATE.leadId, sf_job_id: 141929 }],
    });

    expect(out.ok).toBe(true);
    expect(out.phase).toBe('phase_2_apply');
    expect(out.summary.applied).toBe(1);
    expect(out.summary.rejected).toBe(0);
    expect(out.summary.skipped_drift).toBe(0);
    expect(out.summary.skipped_already_linked).toBe(0);
    expect(out.applied).toHaveLength(1);
    expect(out.applied[0].sf_managed).toBe(true);
    expect(out.applied[0].outbox_event_id).toBe('evt_reconcile_141929_completed');

    // Mutation surfaces
    const auditInserts  = store._log.inserts.filter(i => i.table === 'lb_link_audit');
    const outboxInserts = store._log.inserts.filter(i => i.table === 'leadbridge_outbound_events');
    const jobUpdates    = store._log.updates.filter(u => u.table === 'jobs');
    const custUpdates   = store._log.updates.filter(u => u.table === 'customers');

    expect(auditInserts).toHaveLength(1);
    expect(auditInserts[0].payload.actor).toBe(APPLY_ACTOR);
    expect(auditInserts[0].payload.action).toBe('attach');
    expect(auditInserts[0].payload.user_id).toBe(SF_TENANT);
    expect(auditInserts[0].payload.match_confidence).toBe('high');

    expect(outboxInserts).toHaveLength(1);
    expect(outboxInserts[0].payload.event_id).toBe('evt_reconcile_141929_completed');
    expect(outboxInserts[0].payload.user_id).toBe(SF_TENANT);

    expect(jobUpdates).toHaveLength(1);
    expect(jobUpdates[0].payload.lb_lead_id).toBe(ERIN_LB_CANDIDATE.leadId);
    expect(jobUpdates[0].payload.lb_external_request_id).toBe('574011065576308746');
    // tenant-scoped
    expect(jobUpdates[0].filters).toEqual(expect.arrayContaining([
      { type: 'eq', col: 'user_id', val: SF_TENANT },
    ]));

    expect(custUpdates).toHaveLength(1);
    expect(custUpdates[0].payload.lb_lead_id).toBe(ERIN_LB_CANDIDATE.leadId);
  });

  test('reattach_same fix: jobs.lb_lead_id is populated even when lb_external_request_id was pre-set (Batch-1 Issue #2)', async () => {
    // Pre-seed: job has lb_external_request_id set (e.g. from earlier
    // LB webhook), but lb_lead_id is still NULL. With the OLD code the
    // action='reattach_same' branch skipped the UPDATE entirely, leaving
    // lb_lead_id null. The fix runs the UPDATE when any incoming
    // linkage field is missing on the SF side.
    const seededJob = { ...ERIN_JOB, lb_external_request_id: '574011065576308746', lb_channel: 'thumbtack', lb_lead_id: null };
    const store = makeStore({ customers: [ERIN_CUST], jobs: [seededJob] });
    mockFetchCandidates.mockResolvedValueOnce({ ok: true, user_id: LB_USER_UUID, count: 1, candidates: [ERIN_LB_CANDIDATE], more_may_exist: false });
    mockFindMatchCandidates.mockResolvedValueOnce({ candidates: [ERIN_MATCH] });
    mockLinkLeadsBulk.mockResolvedValueOnce({ ok: true, applied: [lbApplied(ERIN_LB_CANDIDATE.leadId)], rejected: [], summary: {} });

    await runHistoricalSyncApply(store, {
      tenantId: SF_TENANT,
      expectedMatches: [{ lb_lead_id: ERIN_LB_CANDIDATE.leadId, sf_job_id: 141929 }],
    });

    // Audit row was written with action='reattach_same' (because
    // lb_external_request_id matched), AND the jobs UPDATE still ran
    // to populate lb_lead_id.
    const auditInserts = store._log.inserts.filter(i => i.table === 'lb_link_audit');
    expect(auditInserts).toHaveLength(1);
    expect(auditInserts[0].payload.action).toBe('reattach_same');

    const jobUpdates = store._log.updates.filter(u => u.table === 'jobs');
    expect(jobUpdates).toHaveLength(1);
    expect(jobUpdates[0].payload.lb_lead_id).toBe(ERIN_LB_CANDIDATE.leadId);

    // Final state: the in-memory store reflects lb_lead_id populated.
    const erinJobNow = store._rows.jobs.find(j => Number(j.id) === 141929);
    expect(erinJobNow.lb_lead_id).toBe(ERIN_LB_CANDIDATE.leadId);
  });

  test('LB payload uses match_basis + sf_status field names (LB production contract)', async () => {
    const store = makeStore({ customers: [ERIN_CUST], jobs: [ERIN_JOB] });
    mockFetchCandidates.mockResolvedValueOnce({ ok: true, user_id: LB_USER_UUID, count: 1, candidates: [ERIN_LB_CANDIDATE], more_may_exist: false });
    mockFindMatchCandidates.mockResolvedValueOnce({ candidates: [ERIN_MATCH] });
    mockLinkLeadsBulk.mockResolvedValueOnce({ ok: true, applied: [lbApplied(ERIN_LB_CANDIDATE.leadId)], rejected: [], summary: {} });
    await runHistoricalSyncApply(store, { tenantId: SF_TENANT, expectedMatches: [{ lb_lead_id: ERIN_LB_CANDIDATE.leadId, sf_job_id: 141929 }] });
    const lbCallArgs = mockLinkLeadsBulk.mock.calls[0][0];
    expect(lbCallArgs.matches[0]).toEqual({
      lb_lead_id:        ERIN_LB_CANDIDATE.leadId,
      sf_job_id:         141929,
      sf_customer_id:    23427,
      confidence:        'high',
      match_basis:       ['phone_exact:…2443','name_exact'],
      sf_status:         'completed',
      sf_payment_status: 'paid',
      occurred_at:       '2026-05-05T22:44:31Z',
      reason:            APPLY_REASON,
    });
    expect(lbCallArgs.matches[0]).not.toHaveProperty('match_signals');
    expect(lbCallArgs.matches[0]).not.toHaveProperty('sf_job_status');
  });
});

// ──────────────────────────────────────────────────────────────────────
// Already-linked row
// ──────────────────────────────────────────────────────────────────────
describe('runHistoricalSyncApply — already-linked rows', () => {
  test('jobs.lb_lead_id already set → skipped_already_linked, no LB call for this row', async () => {
    const linkedJob = { ...ERIN_JOB, lb_lead_id: ERIN_LB_CANDIDATE.leadId, lb_external_request_id: ERIN_LB_CANDIDATE.externalRequestId };
    const store = makeStore({ customers: [{ ...ERIN_CUST, lb_lead_id: ERIN_LB_CANDIDATE.leadId }], jobs: [linkedJob] });
    mockFetchCandidates.mockResolvedValueOnce({ ok: true, user_id: LB_USER_UUID, count: 1, candidates: [ERIN_LB_CANDIDATE], more_may_exist: false });
    mockFindMatchCandidates.mockResolvedValueOnce({ candidates: [ERIN_MATCH] });

    const out = await runHistoricalSyncApply(store, {
      tenantId: SF_TENANT,
      expectedMatches: [{ lb_lead_id: ERIN_LB_CANDIDATE.leadId, sf_job_id: 141929 }],
    });
    expect(out.ok).toBe(true);
    expect(out.summary.applied).toBe(0);
    expect(out.summary.skipped_already_linked).toBe(1);
    expect(out.skipped_already_linked[0].existing_lb_lead_id).toBe(ERIN_LB_CANDIDATE.leadId);
    expect(mockLinkLeadsBulk).not.toHaveBeenCalled();
    expect(store._log.inserts.filter(i => i.table === 'lb_link_audit')).toHaveLength(0);
    expect(store._log.inserts.filter(i => i.table === 'leadbridge_outbound_events')).toHaveLength(0);
  });
});

// ──────────────────────────────────────────────────────────────────────
// LB rejects row
// ──────────────────────────────────────────────────────────────────────
describe('runHistoricalSyncApply — LB rejects row', () => {
  test('LB returns rejected[] → no SF writes for that row', async () => {
    const store = makeStore({ customers: [ERIN_CUST], jobs: [ERIN_JOB] });
    mockFetchCandidates.mockResolvedValueOnce({ ok: true, user_id: LB_USER_UUID, count: 1, candidates: [ERIN_LB_CANDIDATE], more_may_exist: false });
    mockFindMatchCandidates.mockResolvedValueOnce({ candidates: [ERIN_MATCH] });
    mockLinkLeadsBulk.mockResolvedValueOnce({
      ok: true, status: 200,
      applied: [], rejected: [{ lb_lead_id: ERIN_LB_CANDIDATE.leadId, reason: 'already_linked' }], summary: {},
    });

    const out = await runHistoricalSyncApply(store, {
      tenantId: SF_TENANT,
      expectedMatches: [{ lb_lead_id: ERIN_LB_CANDIDATE.leadId, sf_job_id: 141929 }],
    });

    expect(out.ok).toBe(true);
    expect(out.summary.applied).toBe(0);
    expect(out.summary.rejected).toBe(1);
    expect(out.rejected[0].reason).toBe('already_linked');

    expect(store._log.inserts.filter(i => i.table === 'lb_link_audit')).toHaveLength(0);
    expect(store._log.inserts.filter(i => i.table === 'leadbridge_outbound_events')).toHaveLength(0);
    expect(store._log.updates.filter(u => u.table === 'jobs')).toHaveLength(0);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Drift behaviour
// ──────────────────────────────────────────────────────────────────────
describe('runHistoricalSyncApply — drift', () => {
  test('require_no_drift=true + drift seen → 409, zero LB calls, zero writes', async () => {
    const store = makeStore({ customers: [ERIN_CUST], jobs: [ERIN_JOB] });
    mockFetchCandidates.mockResolvedValueOnce({ ok: true, user_id: LB_USER_UUID, count: 1, candidates: [ERIN_LB_CANDIDATE], more_may_exist: false });
    // Operator approved sf_job_id=141929, fresh matcher returns 99999 → drift
    mockFindMatchCandidates.mockResolvedValueOnce({ candidates: [{ ...ERIN_MATCH, sf_job_id: 99999 }] });

    const out = await runHistoricalSyncApply(store, {
      tenantId: SF_TENANT,
      expectedMatches: [{ lb_lead_id: ERIN_LB_CANDIDATE.leadId, sf_job_id: 141929 }],
      requireNoDrift: true,
    });

    expect(out.ok).toBe(false);
    expect(out.status).toBe(409);
    expect(out.error).toBe('plan_drift_detected');
    expect(mockLinkLeadsBulk).not.toHaveBeenCalled();
    expect(store._log.updates.filter(u => u.table === 'jobs')).toHaveLength(0);
  });

  test('require_no_drift=false → drift rows go to skipped_drift; non-drift rows still applied', async () => {
    const OTHER_LEAD = lbCandidate({ leadId: 'lead-other', externalRequestId: 'req-other', customerPhone: '5550009999', customerName: 'Other Person' });
    const otherCust = { ...ERIN_CUST, id: 200, first_name: 'Other', last_name: 'Person', phone: '5550009999' };
    const otherJob  = { ...ERIN_JOB, id: 300, customer_id: 200 };
    const store = makeStore({ customers: [ERIN_CUST, otherCust], jobs: [ERIN_JOB, otherJob] });

    mockFetchCandidates.mockResolvedValueOnce({ ok: true, user_id: LB_USER_UUID, count: 2, candidates: [ERIN_LB_CANDIDATE, OTHER_LEAD], more_may_exist: false });
    // Erin drift (different sf_job_id), Other matches as approved.
    mockFindMatchCandidates
      .mockResolvedValueOnce({ candidates: [{ ...ERIN_MATCH, sf_job_id: 99999 }] })   // drift
      .mockResolvedValueOnce({ candidates: [{ ...ERIN_MATCH, sf_customer_id: 200, sf_job_id: 300 }] });
    mockLinkLeadsBulk.mockResolvedValueOnce({ ok: true, applied: [lbApplied('lead-other')], rejected: [], summary: {} });

    const out = await runHistoricalSyncApply(store, {
      tenantId: SF_TENANT,
      expectedMatches: [
        { lb_lead_id: ERIN_LB_CANDIDATE.leadId, sf_job_id: 141929 },
        { lb_lead_id: 'lead-other',             sf_job_id: 300 },
      ],
      requireNoDrift: false,
    });

    expect(out.ok).toBe(true);
    expect(out.summary.applied).toBe(1);
    expect(out.summary.skipped_drift).toBe(1);
    expect(out.applied[0].lb_lead_id).toBe('lead-other');
    expect(out.skipped_drift[0].lb_lead_id).toBe(ERIN_LB_CANDIDATE.leadId);
    expect(out.skipped_drift[0].reason).toBe('plan_drift_different_sf_job');

    // LB called once, with ONLY the eligible row
    expect(mockLinkLeadsBulk).toHaveBeenCalledTimes(1);
    expect(mockLinkLeadsBulk.mock.calls[0][0].matches).toHaveLength(1);
    expect(mockLinkLeadsBulk.mock.calls[0][0].matches[0].lb_lead_id).toBe('lead-other');
  });

  test('plan_drift_lower_confidence when fresh matcher now returns medium', async () => {
    const store = makeStore({ customers: [ERIN_CUST], jobs: [ERIN_JOB] });
    mockFetchCandidates.mockResolvedValueOnce({ ok: true, user_id: LB_USER_UUID, count: 1, candidates: [ERIN_LB_CANDIDATE], more_may_exist: false });
    mockFindMatchCandidates.mockResolvedValueOnce({ candidates: [{ ...ERIN_MATCH, confidence: 'medium' }] });

    const out = await runHistoricalSyncApply(store, {
      tenantId: SF_TENANT,
      expectedMatches: [{ lb_lead_id: ERIN_LB_CANDIDATE.leadId, sf_job_id: 141929 }],
      requireNoDrift: false,
    });
    expect(out.summary.skipped_drift).toBe(1);
    expect(out.skipped_drift[0].reason).toBe('plan_drift_confidence_below_threshold');
    expect(mockLinkLeadsBulk).not.toHaveBeenCalled();
  });

  test('plan_drift_ambiguity when fresh matcher now has warnings', async () => {
    const store = makeStore({ customers: [ERIN_CUST], jobs: [ERIN_JOB] });
    mockFetchCandidates.mockResolvedValueOnce({ ok: true, user_id: LB_USER_UUID, count: 1, candidates: [ERIN_LB_CANDIDATE], more_may_exist: false });
    mockFindMatchCandidates.mockResolvedValueOnce({ candidates: [{ ...ERIN_MATCH, ambiguity_warnings: ['multiple_high_confidence_candidates'] }] });

    const out = await runHistoricalSyncApply(store, {
      tenantId: SF_TENANT,
      expectedMatches: [{ lb_lead_id: ERIN_LB_CANDIDATE.leadId, sf_job_id: 141929 }],
      requireNoDrift: false,
    });
    expect(out.summary.skipped_drift).toBe(1);
    expect(out.skipped_drift[0].reason).toBe('plan_drift_ambiguity_warnings_present');
    expect(mockLinkLeadsBulk).not.toHaveBeenCalled();
  });

  test('plan_drift_no_longer_pending when LB does not include the lead in fresh fetch', async () => {
    const store = makeStore({ customers: [ERIN_CUST], jobs: [ERIN_JOB] });
    mockFetchCandidates.mockResolvedValueOnce({ ok: true, user_id: LB_USER_UUID, count: 0, candidates: [], more_may_exist: false });

    const out = await runHistoricalSyncApply(store, {
      tenantId: SF_TENANT,
      expectedMatches: [{ lb_lead_id: ERIN_LB_CANDIDATE.leadId, sf_job_id: 141929 }],
      requireNoDrift: false,
    });
    expect(out.summary.skipped_drift).toBe(1);
    expect(out.skipped_drift[0].reason).toBe('plan_drift_no_longer_pending');
    expect(mockLinkLeadsBulk).not.toHaveBeenCalled();
  });
});

// ──────────────────────────────────────────────────────────────────────
// Partial success
// ──────────────────────────────────────────────────────────────────────
describe('runHistoricalSyncApply — partial success', () => {
  test('LB applies 2 + rejects 1 → SF writes only for 2; rejection is surfaced', async () => {
    const c1 = lbCandidate({ leadId: 'l-A', externalRequestId: 'r-A', customerPhone: '1111111111', customerName: 'A' });
    const c2 = lbCandidate({ leadId: 'l-B', externalRequestId: 'r-B', customerPhone: '2222222222', customerName: 'B' });
    const c3 = lbCandidate({ leadId: 'l-C', externalRequestId: 'r-C', customerPhone: '3333333333', customerName: 'C' });
    const cust = (id, phone) => ({ ...ERIN_CUST, id, phone, first_name: 'X', last_name: 'Y' });
    const job  = (id, cid)   => ({ ...ERIN_JOB, id, customer_id: cid });
    const store = makeStore({
      customers: [cust(101,'1111111111'), cust(102,'2222222222'), cust(103,'3333333333')],
      jobs:      [job(11,101), job(12,102), job(13,103)],
    });
    mockFetchCandidates.mockResolvedValueOnce({ ok: true, user_id: LB_USER_UUID, count: 3, candidates: [c1, c2, c3], more_may_exist: false });
    mockFindMatchCandidates
      .mockResolvedValueOnce({ candidates: [{ ...ERIN_MATCH, sf_customer_id: 101, sf_job_id: 11 }] })
      .mockResolvedValueOnce({ candidates: [{ ...ERIN_MATCH, sf_customer_id: 102, sf_job_id: 12 }] })
      .mockResolvedValueOnce({ candidates: [{ ...ERIN_MATCH, sf_customer_id: 103, sf_job_id: 13 }] });
    mockLinkLeadsBulk.mockResolvedValueOnce({
      ok: true, applied: [lbApplied('l-A'), lbApplied('l-B')], rejected: [{ lb_lead_id: 'l-C', reason: 'lb_internal_conflict' }], summary: {},
    });

    const out = await runHistoricalSyncApply(store, {
      tenantId: SF_TENANT,
      expectedMatches: [
        { lb_lead_id: 'l-A', sf_job_id: 11 },
        { lb_lead_id: 'l-B', sf_job_id: 12 },
        { lb_lead_id: 'l-C', sf_job_id: 13 },
      ],
    });
    expect(out.ok).toBe(true);
    expect(out.summary.applied).toBe(2);
    expect(out.summary.rejected).toBe(1);
    expect(out.rejected[0]).toEqual(expect.objectContaining({ lb_lead_id: 'l-C', reason: 'lb_internal_conflict' }));

    // Only 2 audit rows + 2 outbox events + 2 job updates
    expect(store._log.inserts.filter(i => i.table === 'lb_link_audit')).toHaveLength(2);
    expect(store._log.inserts.filter(i => i.table === 'leadbridge_outbound_events')).toHaveLength(2);
    expect(store._log.updates.filter(u => u.table === 'jobs')).toHaveLength(2);
  });
});

// ──────────────────────────────────────────────────────────────────────
// LB 5xx halts (no SF writes)
// ──────────────────────────────────────────────────────────────────────
describe('runHistoricalSyncApply — LB infra failure', () => {
  test('LB 503 → 502 lb_apply_failed, zero SF writes', async () => {
    const store = makeStore({ customers: [ERIN_CUST], jobs: [ERIN_JOB] });
    mockFetchCandidates.mockResolvedValueOnce({ ok: true, user_id: LB_USER_UUID, count: 1, candidates: [ERIN_LB_CANDIDATE], more_may_exist: false });
    mockFindMatchCandidates.mockResolvedValueOnce({ candidates: [ERIN_MATCH] });
    mockLinkLeadsBulk.mockResolvedValueOnce({ ok: false, status: 503, reason: 'lb_link_bulk_503' });

    const out = await runHistoricalSyncApply(store, {
      tenantId: SF_TENANT,
      expectedMatches: [{ lb_lead_id: ERIN_LB_CANDIDATE.leadId, sf_job_id: 141929 }],
    });
    expect(out.ok).toBe(false);
    expect(out.status).toBe(502);
    expect(out.error).toBe('lb_apply_failed');
    expect(store._log.inserts.filter(i => i.table === 'lb_link_audit')).toHaveLength(0);
    expect(store._log.inserts.filter(i => i.table === 'leadbridge_outbound_events')).toHaveLength(0);
    expect(store._log.updates.filter(u => u.table === 'jobs')).toHaveLength(0);
  });

  test('LB unreachable → 502 lb_unreachable, zero SF writes', async () => {
    const store = makeStore({ customers: [ERIN_CUST], jobs: [ERIN_JOB] });
    mockFetchCandidates.mockResolvedValueOnce({ ok: true, user_id: LB_USER_UUID, count: 1, candidates: [ERIN_LB_CANDIDATE], more_may_exist: false });
    mockFindMatchCandidates.mockResolvedValueOnce({ candidates: [ERIN_MATCH] });
    mockLinkLeadsBulk.mockResolvedValueOnce({ ok: false, reason: 'lb_unreachable' });

    const out = await runHistoricalSyncApply(store, {
      tenantId: SF_TENANT,
      expectedMatches: [{ lb_lead_id: ERIN_LB_CANDIDATE.leadId, sf_job_id: 141929 }],
    });
    expect(out.ok).toBe(false);
    expect(out.error).toBe('lb_unreachable');
    expect(store._log.inserts.filter(i => i.table === 'leadbridge_outbound_events')).toHaveLength(0);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Post-timeout reconcile (Task 1 stabilization)
// Regression for prod Batch #1: LB committed the rows server-side after
// SF's HTTP client timed out at 30s. The orchestrator must NOT write SF
// state until it confirms LB's actual state by re-fetching
// sync_statuses=['linked'] and cross-referencing.
// ──────────────────────────────────────────────────────────────────────
describe('runHistoricalSyncApply — post-timeout reconcile', () => {
  test('linkLeadsBulk request_timeout + LB linked-fetch confirms row → attach runs (NO data loss)', async () => {
    const store = makeStore({ customers: [ERIN_CUST], jobs: [ERIN_JOB] });
    mockFetchCandidates
      .mockResolvedValueOnce({ ok: true, user_id: LB_USER_UUID, count: 1, candidates: [ERIN_LB_CANDIDATE], more_may_exist: false })  // initial pending fetch
      .mockResolvedValueOnce({ ok: true, user_id: LB_USER_UUID, count: 1, candidates: [ERIN_LB_CANDIDATE], more_may_exist: false }); // post-timeout linked fetch
    mockFindMatchCandidates.mockResolvedValueOnce({ candidates: [ERIN_MATCH] });
    // LB call times out (client returns request_timeout)
    mockLinkLeadsBulk.mockResolvedValueOnce({ ok: false, reason: 'request_timeout', timeout: true, request_id: 'sf-test123', error_description: 'request_timeout' });

    const out = await runHistoricalSyncApply(store, {
      tenantId: SF_TENANT,
      expectedMatches: [{ lb_lead_id: ERIN_LB_CANDIDATE.leadId, sf_job_id: 141929 }],
    });

    expect(out.ok).toBe(true);
    expect(out.post_timeout_reconciled).toBe(true);
    expect(out.summary.applied).toBe(1);
    expect(out.summary.uncertain).toBe(0);
    expect(out.applied).toHaveLength(1);
    expect(out.applied[0].lb_lead_id).toBe(ERIN_LB_CANDIDATE.leadId);
    expect(out.request_id).toBe('sf-test123');
    // attachLbLink ran → audit + outbox written exactly once
    expect(store._log.inserts.filter(i => i.table === 'lb_link_audit')).toHaveLength(1);
    expect(store._log.inserts.filter(i => i.table === 'leadbridge_outbound_events')).toHaveLength(1);
  });

  test('linkLeadsBulk request_timeout + LB linked-fetch shows row NOT linked → uncertain, NO SF writes', async () => {
    const store = makeStore({ customers: [ERIN_CUST], jobs: [ERIN_JOB] });
    mockFetchCandidates
      .mockResolvedValueOnce({ ok: true, user_id: LB_USER_UUID, count: 1, candidates: [ERIN_LB_CANDIDATE], more_may_exist: false })
      .mockResolvedValueOnce({ ok: true, user_id: LB_USER_UUID, count: 0, candidates: [], more_may_exist: false });  // LB didn't actually link
    mockFindMatchCandidates.mockResolvedValueOnce({ candidates: [ERIN_MATCH] });
    mockLinkLeadsBulk.mockResolvedValueOnce({ ok: false, reason: 'request_timeout', timeout: true, request_id: 'sf-uncertain1' });

    const out = await runHistoricalSyncApply(store, {
      tenantId: SF_TENANT,
      expectedMatches: [{ lb_lead_id: ERIN_LB_CANDIDATE.leadId, sf_job_id: 141929 }],
    });

    expect(out.ok).toBe(true);
    expect(out.post_timeout_reconciled).toBe(true);
    expect(out.summary.applied).toBe(0);
    expect(out.summary.uncertain).toBe(1);
    expect(out.uncertain).toHaveLength(1);
    expect(out.uncertain[0].reason).toBe('lb_state_uncertain');
    // NO writes for uncertain rows — operator must use /remediate
    expect(store._log.inserts.filter(i => i.table === 'lb_link_audit')).toHaveLength(0);
    expect(store._log.inserts.filter(i => i.table === 'leadbridge_outbound_events')).toHaveLength(0);
  });

  test('partial reconcile: 2 confirmed linked, 1 uncertain', async () => {
    const c1 = { ...ERIN_LB_CANDIDATE, leadId: 'l-A', externalRequestId: 'r-A' };
    const c2 = { ...ERIN_LB_CANDIDATE, leadId: 'l-B', externalRequestId: 'r-B' };
    const c3 = { ...ERIN_LB_CANDIDATE, leadId: 'l-C', externalRequestId: 'r-C' };
    const cust = (id) => ({ ...ERIN_CUST, id });
    const job  = (id, cid) => ({ ...ERIN_JOB, id, customer_id: cid, lb_external_request_id: null });
    const store = makeStore({
      customers: [cust(101), cust(102), cust(103)],
      jobs:      [job(11,101), job(12,102), job(13,103)],
    });
    mockFetchCandidates
      .mockResolvedValueOnce({ ok: true, user_id: LB_USER_UUID, count: 3, candidates: [c1, c2, c3], more_may_exist: false })
      // post-timeout: LB linked l-A + l-C; l-B is uncertain
      .mockResolvedValueOnce({ ok: true, user_id: LB_USER_UUID, count: 2, candidates: [c1, c3], more_may_exist: false });
    mockFindMatchCandidates
      .mockResolvedValueOnce({ candidates: [{ ...ERIN_MATCH, sf_customer_id: 101, sf_job_id: 11 }] })
      .mockResolvedValueOnce({ candidates: [{ ...ERIN_MATCH, sf_customer_id: 102, sf_job_id: 12 }] })
      .mockResolvedValueOnce({ candidates: [{ ...ERIN_MATCH, sf_customer_id: 103, sf_job_id: 13 }] });
    mockLinkLeadsBulk.mockResolvedValueOnce({ ok: false, reason: 'request_timeout', timeout: true });

    const out = await runHistoricalSyncApply(store, {
      tenantId: SF_TENANT,
      expectedMatches: [
        { lb_lead_id: 'l-A', sf_job_id: 11 },
        { lb_lead_id: 'l-B', sf_job_id: 12 },
        { lb_lead_id: 'l-C', sf_job_id: 13 },
      ],
    });
    expect(out.ok).toBe(true);
    expect(out.summary.applied).toBe(2);
    expect(out.summary.uncertain).toBe(1);
    expect(out.uncertain[0].lb_lead_id).toBe('l-B');
    // exactly 2 audit + 2 outbox writes (NOT 3)
    expect(store._log.inserts.filter(i => i.table === 'lb_link_audit')).toHaveLength(2);
    expect(store._log.inserts.filter(i => i.table === 'leadbridge_outbound_events')).toHaveLength(2);
  });

  test('linkLeadsBulk request_timeout + post-timeout fetch ALSO fails → 502 lb_state_uncertain, NO writes', async () => {
    const store = makeStore({ customers: [ERIN_CUST], jobs: [ERIN_JOB] });
    mockFetchCandidates
      .mockResolvedValueOnce({ ok: true, user_id: LB_USER_UUID, count: 1, candidates: [ERIN_LB_CANDIDATE], more_may_exist: false })
      .mockResolvedValueOnce({ ok: false, reason: 'lb_unreachable' });  // post-timeout fetch also fails
    mockFindMatchCandidates.mockResolvedValueOnce({ candidates: [ERIN_MATCH] });
    mockLinkLeadsBulk.mockResolvedValueOnce({ ok: false, reason: 'request_timeout', timeout: true });

    const out = await runHistoricalSyncApply(store, {
      tenantId: SF_TENANT,
      expectedMatches: [{ lb_lead_id: ERIN_LB_CANDIDATE.leadId, sf_job_id: 141929 }],
    });
    expect(out.ok).toBe(false);
    expect(out.status).toBe(502);
    expect(out.error).toBe('lb_state_uncertain');
    expect(store._log.inserts).toHaveLength(0);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Concurrent apply lock
// ──────────────────────────────────────────────────────────────────────
describe('runHistoricalSyncApply — per-tenant lock', () => {
  test('concurrent apply → second call returns 409 apply_in_progress', async () => {
    const store = makeStore({ customers: [ERIN_CUST], jobs: [ERIN_JOB] });
    // Pre-populate the lock as if another call already holds it.
    store._rows.sf_historical_apply_locks.push({ tenant_id: SF_TENANT, acquired_at: new Date().toISOString() });

    const out = await runHistoricalSyncApply(store, {
      tenantId: SF_TENANT,
      expectedMatches: [{ lb_lead_id: ERIN_LB_CANDIDATE.leadId, sf_job_id: 141929 }],
    });
    expect(out.ok).toBe(false);
    expect(out.status).toBe(409);
    expect(out.error).toBe('apply_in_progress');
    expect(mockFetchCandidates).not.toHaveBeenCalled();
    expect(mockLinkLeadsBulk).not.toHaveBeenCalled();
    expect(store._log.updates).toHaveLength(0);
    expect(store._log.inserts).toHaveLength(0);
  });

  test('lock released after success (next apply can proceed)', async () => {
    const store = makeStore({ customers: [ERIN_CUST], jobs: [ERIN_JOB] });
    mockFetchCandidates.mockResolvedValueOnce({ ok: true, user_id: LB_USER_UUID, count: 1, candidates: [ERIN_LB_CANDIDATE], more_may_exist: false });
    mockFindMatchCandidates.mockResolvedValueOnce({ candidates: [ERIN_MATCH] });
    mockLinkLeadsBulk.mockResolvedValueOnce({ ok: true, applied: [lbApplied(ERIN_LB_CANDIDATE.leadId)], rejected: [], summary: {} });

    const out1 = await runHistoricalSyncApply(store, {
      tenantId: SF_TENANT,
      expectedMatches: [{ lb_lead_id: ERIN_LB_CANDIDATE.leadId, sf_job_id: 141929 }],
    });
    expect(out1.ok).toBe(true);
    expect(store._rows.sf_historical_apply_locks).toHaveLength(0);  // released
  });

  test('lock released after error (LB infra failure)', async () => {
    const store = makeStore({ customers: [ERIN_CUST], jobs: [ERIN_JOB] });
    mockFetchCandidates.mockResolvedValueOnce({ ok: true, user_id: LB_USER_UUID, count: 1, candidates: [ERIN_LB_CANDIDATE], more_may_exist: false });
    mockFindMatchCandidates.mockResolvedValueOnce({ candidates: [ERIN_MATCH] });
    mockLinkLeadsBulk.mockResolvedValueOnce({ ok: false, status: 503, reason: 'lb_link_bulk_503' });

    const out = await runHistoricalSyncApply(store, {
      tenantId: SF_TENANT,
      expectedMatches: [{ lb_lead_id: ERIN_LB_CANDIDATE.leadId, sf_job_id: 141929 }],
    });
    expect(out.ok).toBe(false);
    expect(store._rows.sf_historical_apply_locks).toHaveLength(0);  // released even on error
  });
});

// ──────────────────────────────────────────────────────────────────────
// Argument validation
// ──────────────────────────────────────────────────────────────────────
describe('runHistoricalSyncApply — argument validation', () => {
  test('missing expectedMatches → 400 apply_matches_required', async () => {
    const store = makeStore();
    const out = await runHistoricalSyncApply(store, { tenantId: SF_TENANT });
    expect(out.ok).toBe(false);
    expect(out.status).toBe(400);
    expect(out.error).toBe('apply_matches_required');
    expect(mockFetchCandidates).not.toHaveBeenCalled();
  });
  test('empty expectedMatches → 400 apply_matches_required', async () => {
    const store = makeStore();
    const out = await runHistoricalSyncApply(store, { tenantId: SF_TENANT, expectedMatches: [] });
    expect(out.ok).toBe(false);
    expect(out.error).toBe('apply_matches_required');
  });
  test('expectedMatches missing sf_job_id → 400', async () => {
    const store = makeStore();
    const out = await runHistoricalSyncApply(store, { tenantId: SF_TENANT, expectedMatches: [{ lb_lead_id: 'x' }] });
    expect(out.ok).toBe(false);
    expect(out.status).toBe(400);
  });
  test('expectedMatches exceeding MAX_APPLY_BATCH → 400', async () => {
    const store = makeStore();
    const big = Array.from({ length: MAX_APPLY_BATCH + 1 }, (_, i) => ({ lb_lead_id: 'l' + i, sf_job_id: i + 1 }));
    const out = await runHistoricalSyncApply(store, { tenantId: SF_TENANT, expectedMatches: big });
    expect(out.ok).toBe(false);
    expect(out.error).toBe('apply_batch_too_large');
  });
});

// ──────────────────────────────────────────────────────────────────────
// Tenant scoping (no cross-tenant writes)
// ──────────────────────────────────────────────────────────────────────
describe('runHistoricalSyncApply — tenant scoping', () => {
  test('all writes scoped to tenant_id (every jobs/customers update has user_id filter)', async () => {
    const store = makeStore({ customers: [ERIN_CUST], jobs: [ERIN_JOB] });
    mockFetchCandidates.mockResolvedValueOnce({ ok: true, user_id: LB_USER_UUID, count: 1, candidates: [ERIN_LB_CANDIDATE], more_may_exist: false });
    mockFindMatchCandidates.mockResolvedValueOnce({ candidates: [ERIN_MATCH] });
    mockLinkLeadsBulk.mockResolvedValueOnce({ ok: true, applied: [lbApplied(ERIN_LB_CANDIDATE.leadId)], rejected: [], summary: {} });
    await runHistoricalSyncApply(store, {
      tenantId: SF_TENANT,
      expectedMatches: [{ lb_lead_id: ERIN_LB_CANDIDATE.leadId, sf_job_id: 141929 }],
    });

    for (const u of store._log.updates) {
      if (u.table === 'jobs' || u.table === 'customers') {
        const hasTenantFilter = u.filters.some(f => f.type === 'eq' && f.col === 'user_id' && Number(f.val) === SF_TENANT);
        expect(hasTenantFilter).toBe(true);
      }
    }
    for (const i of store._log.inserts) {
      if (i.table === 'lb_link_audit' || i.table === 'leadbridge_outbound_events') {
        expect(i.payload.user_id).toBe(SF_TENANT);
      }
    }
  });
});

// ──────────────────────────────────────────────────────────────────────
// Idempotency (duplicate apply)
// ──────────────────────────────────────────────────────────────────────
describe('runHistoricalSyncApply — duplicate apply idempotency', () => {
  test('second apply with same matches is harmless (job already linked → skipped_already_linked)', async () => {
    const store = makeStore({ customers: [ERIN_CUST], jobs: [ERIN_JOB] });

    // First apply: full success
    mockFetchCandidates.mockResolvedValueOnce({ ok: true, user_id: LB_USER_UUID, count: 1, candidates: [ERIN_LB_CANDIDATE], more_may_exist: false });
    mockFindMatchCandidates.mockResolvedValueOnce({ candidates: [ERIN_MATCH] });
    mockLinkLeadsBulk.mockResolvedValueOnce({ ok: true, applied: [lbApplied(ERIN_LB_CANDIDATE.leadId)], rejected: [], summary: {} });
    const out1 = await runHistoricalSyncApply(store, { tenantId: SF_TENANT, expectedMatches: [{ lb_lead_id: ERIN_LB_CANDIDATE.leadId, sf_job_id: 141929 }] });
    expect(out1.summary.applied).toBe(1);

    // Second apply: same matches. fetchCandidates still returns Erin (test fixture isn't bound to LB state).
    // Matcher still returns the same Erin match. Orchestrator should detect jobs.lb_lead_id is set now and
    // skip BEFORE calling LB.
    mockFetchCandidates.mockResolvedValueOnce({ ok: true, user_id: LB_USER_UUID, count: 1, candidates: [ERIN_LB_CANDIDATE], more_may_exist: false });
    mockFindMatchCandidates.mockResolvedValueOnce({ candidates: [ERIN_MATCH] });

    const out2 = await runHistoricalSyncApply(store, { tenantId: SF_TENANT, expectedMatches: [{ lb_lead_id: ERIN_LB_CANDIDATE.leadId, sf_job_id: 141929 }] });
    expect(out2.ok).toBe(true);
    expect(out2.summary.applied).toBe(0);
    expect(out2.summary.skipped_already_linked).toBe(1);
    // No additional LB call beyond the first apply
    expect(mockLinkLeadsBulk).toHaveBeenCalledTimes(1);
    // No additional audit rows or outbox events
    expect(store._log.inserts.filter(i => i.table === 'lb_link_audit')).toHaveLength(1);
    expect(store._log.inserts.filter(i => i.table === 'leadbridge_outbound_events')).toHaveLength(1);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Synthetic event timing (only after LB confirms)
// ──────────────────────────────────────────────────────────────────────
describe('runHistoricalSyncApply — synthetic event timing', () => {
  test('zero outbox events when LB rejects everything', async () => {
    const store = makeStore({ customers: [ERIN_CUST], jobs: [ERIN_JOB] });
    mockFetchCandidates.mockResolvedValueOnce({ ok: true, user_id: LB_USER_UUID, count: 1, candidates: [ERIN_LB_CANDIDATE], more_may_exist: false });
    mockFindMatchCandidates.mockResolvedValueOnce({ candidates: [ERIN_MATCH] });
    mockLinkLeadsBulk.mockResolvedValueOnce({ ok: true, applied: [], rejected: [{ lb_lead_id: ERIN_LB_CANDIDATE.leadId, reason: 'nope' }], summary: {} });

    await runHistoricalSyncApply(store, {
      tenantId: SF_TENANT,
      expectedMatches: [{ lb_lead_id: ERIN_LB_CANDIDATE.leadId, sf_job_id: 141929 }],
    });
    expect(store._log.inserts.filter(i => i.table === 'leadbridge_outbound_events')).toHaveLength(0);
  });

  test('outbox event has sf_managed=true reconciliation block', async () => {
    const store = makeStore({ customers: [ERIN_CUST], jobs: [ERIN_JOB] });
    mockFetchCandidates.mockResolvedValueOnce({ ok: true, user_id: LB_USER_UUID, count: 1, candidates: [ERIN_LB_CANDIDATE], more_may_exist: false });
    mockFindMatchCandidates.mockResolvedValueOnce({ candidates: [ERIN_MATCH] });
    mockLinkLeadsBulk.mockResolvedValueOnce({ ok: true, applied: [lbApplied(ERIN_LB_CANDIDATE.leadId)], rejected: [], summary: {} });

    await runHistoricalSyncApply(store, {
      tenantId: SF_TENANT,
      expectedMatches: [{ lb_lead_id: ERIN_LB_CANDIDATE.leadId, sf_job_id: 141929 }],
    });
    const outboxRow = store._log.inserts.find(i => i.table === 'leadbridge_outbound_events');
    expect(outboxRow.payload.event_type).toBe('job.status_changed');
    expect(outboxRow.payload.payload_json.reconciliation).toBeDefined();
    expect(outboxRow.payload.payload_json.reconciliation.match_confidence).toBe('high');
  });
});
