'use strict';

/**
 * SF→LB historical-sync FEEDBACK apply tests.
 *
 * Covers the new Phase-3 path that posts per-candidate outcomes (no_match,
 * needs_review, low_confidence) to LB /link-leads-bulk so LB can transition
 * pending leads out of `syncStatus='pending'` even when SF could not produce
 * a high-confidence link.
 *
 * Pinned behaviours:
 *   - dryRun=true (default) never calls LB
 *   - dryRun=false posts a single batch to LB with one row per processed
 *     candidate (excluding would_link/already_linked + matcher_error +
 *     classes the operator did not select)
 *   - no SF state writes ever (attachLbLink not invoked; no jobs/customers
 *     update)
 *   - class filter (operator-selectable) gates which categorize() reasons
 *     are turned into wire rows
 *   - LB confidence/match_basis encoding matches LB's BulkLinkRow contract
 *     (none | low | medium | high | exact)
 *   - matcher_error → would_failed in summary, NOT posted to LB
 */

process.env.SF_LB_PROVISIONING_SHARED_SECRET = 'p3-fb-test-' + 'C'.repeat(20);
process.env.LB_PROVISIONING_BASE_URL          = 'https://lb-test.example.com/api';

const mockFetchCandidates = jest.fn();
const mockLinkLeadsBulk   = jest.fn();
jest.mock('../lib/lb-historical-sync-client', () => ({
  fetchCandidates: (...args) => mockFetchCandidates(...args),
  linkLeadsBulk:   (...args) => mockLinkLeadsBulk(...args),
  CANDIDATES_PATH: '/v1/integrations/sf/historical-sync/candidates',
  LINK_BULK_PATH:  '/v1/integrations/sf/link-leads-bulk',
}));

// Matcher mock — fully replaces the real matcher so tests can dictate
// per-candidate outcomes without standing up customers/jobs fixtures.
//
// PR C wired runHistoricalFeedbackApply onto findHistoricalMatchType
// (PR A's leads-aware decision tree). Tests that previously injected
// findMatchCandidates fixtures now inject findHistoricalMatchType
// fixtures. Both are mocked so backwards-compat surfaces are still
// covered when this file later imports findMatchCandidates directly.
const mockFindMatchCandidates    = jest.fn();
const mockFindHistoricalMatchType = jest.fn();
jest.mock('../lib/lb-lead-link-matcher', () => ({
  findMatchCandidates:       (...args) => mockFindMatchCandidates(...args),
  findHistoricalMatchType:   (...args) => mockFindHistoricalMatchType(...args),
  MATCH_TYPE: Object.freeze({ LEAD_ONLY:'lead_only', CUSTOMER_JOB:'customer_job', NEEDS_REVIEW:'needs_review', NO_MATCH:'no_match', TEST_NOISE:'test_noise' }),
  MATCH_BASIS: Object.freeze({ EXTERNAL_REQUEST_ID:'externalRequestId', LB_LEAD_ID:'lbLeadId', PHONE:'phone', EMAIL:'email', MANUAL:'manual', NONE:'none' }),
}));

// Convenience builders for findHistoricalMatchType fixtures
const mt = {
  noMatch:  () => ({ match_type: 'no_match',  confidence: 'none',  match_basis: 'none', step: 5, sf_lead_id: null, sf_lead_stage_name: null, sf_customer_id: null, sf_job_id: null, ambiguity_warnings: [], candidates: [], matched_sf_lead_ids: [], reason: 'no_sf_record_anywhere' }),
  leadOnly: ({ sf_lead_id, sf_lead_stage_name = null } = {}) => ({ match_type: 'lead_only', confidence: 'exact', match_basis: 'externalRequestId', step: 1, sf_lead_id, sf_lead_stage_name, sf_customer_id: null, sf_job_id: null, ambiguity_warnings: [], candidates: [], matched_sf_lead_ids: [], reason: null }),
  testNoise: () => ({ match_type: 'test_noise', confidence: 'none', match_basis: 'none', step: 0, sf_lead_id: null, sf_lead_stage_name: null, sf_customer_id: null, sf_job_id: null, ambiguity_warnings: [], candidates: [], matched_sf_lead_ids: [], reason: 'lb_test_channel' }),
  customerJobHigh: ({ sf_customer_id, sf_job_id }) => ({ match_type: 'customer_job', confidence: 'high', match_basis: 'phone', step: 2, sf_lead_id: null, sf_lead_stage_name: null, sf_customer_id, sf_job_id, ambiguity_warnings: [], candidates: [{ confidence: 'high', sf_job_id, sf_customer_id, match_signals: ['phone_exact:…3841'], sf_job: { lb_external_request_id: null }, ambiguity_warnings: [] }], matched_sf_lead_ids: [], reason: null }),
  multiCandidates: () => ({ match_type: 'needs_review', confidence: 'high', match_basis: 'phone', step: 2, sf_lead_id: null, sf_lead_stage_name: null, sf_customer_id: null, sf_job_id: null, ambiguity_warnings: ['multiple_customer_candidates'], candidates: [
    { confidence: 'high', sf_job_id: null, sf_customer_id: 23115, sf_job: null, ambiguity_warnings: ['multiple_high_confidence_candidates'], match_signals: ['phone_exact:…2681'] },
    { confidence: 'high', sf_job_id: null, sf_customer_id: 23116, sf_job: null, ambiguity_warnings: [], match_signals: ['phone_exact:…2681'] },
  ], matched_sf_lead_ids: [], reason: 'multiple_customer_candidates' }),
  lowConfidence: ({ sf_customer_id, sf_job_id, matcherConf = 'medium', signals = ['name_exact','date_within_14d'] } = {}) => ({ match_type: 'needs_review', confidence: matcherConf, match_basis: 'manual', step: 2, sf_lead_id: null, sf_lead_stage_name: null, sf_customer_id, sf_job_id, ambiguity_warnings: [], candidates: [{ confidence: matcherConf, sf_job_id, sf_customer_id, match_signals: signals, sf_job: { status: 'completed', payment_status: 'paid' }, ambiguity_warnings: [] }], matched_sf_lead_ids: [], reason: 'low_confidence_customer_match' }),
  alreadyReconciled: ({ sf_customer_id, sf_job_id } = {}) => ({ match_type: 'needs_review', confidence: 'low', match_basis: 'manual', step: 2, sf_lead_id: null, sf_lead_stage_name: null, sf_customer_id, sf_job_id, ambiguity_warnings: [], candidates: [{ confidence: 'low', sf_job_id, sf_customer_id, sf_job: null, sf_customer: { lb_lead_id: 'OTHER_LEAD', any_job_linked: true }, ambiguity_warnings: [], match_signals: ['name_exact'] }], matched_sf_lead_ids: [], reason: null }),
};

// Apply lock mock — feedback uses the same per-tenant lock as the apply
// path. Default to "always acquires"; individual tests override.
const mockTryAcquire = jest.fn();
const mockRelease    = jest.fn();
jest.mock('../lib/sf-historical-apply-lock', () => ({
  tryAcquire: (...args) => mockTryAcquire(...args),
  release:    (...args) => mockRelease(...args),
}));

const {
  runHistoricalFeedbackApply,
  buildFeedbackRow,
  FEEDBACK_DEFAULT_CLASSES,
  FEEDBACK_ALL_CLASSES,
  FEEDBACK_APPLY_REASON,
} = require('../lib/sf-historical-sync-orchestrator');

const LB_USER_UUID = 'c3d14499-dec1-42c3-a36c-713cb09842c6';
const SF_TENANT_ID = 2;

// ──────────────────────────────────────────────────────────────────────
// Lightweight supabase mock — communication_settings only (feedback path
// does not read jobs/customers directly; matcher mock returns those).
// ──────────────────────────────────────────────────────────────────────
function makeStore({ commSettings = null } = {}) {
  const rows = {
    communication_settings: commSettings === null
      ? [{ user_id: SF_TENANT_ID, leadbridge_user_id: LB_USER_UUID, leadbridge_connected: true }]
      : (Array.isArray(commSettings) ? commSettings : [commSettings]),
  };
  function exec(state) {
    let matched = (rows[state.table] || []).filter((r) => state.filters.every((f) =>
      f.type === 'eq' ? String(r[f.col]) === String(f.val) : true,
    ));
    return Promise.resolve({ data: matched.map((r) => ({ ...r })), error: null });
  }
  function makeBuilder(table) {
    const state = { table, filters: [] };
    const b = {
      insert() { throw new Error('feedback path must not insert (' + table + ')'); },
      update() { throw new Error('feedback path must not update (' + table + ')'); },
      delete() { throw new Error('feedback path must not delete (' + table + ')'); },
      select() { return b; },
      eq(c, v) { state.filters.push({ type: 'eq', col: c, val: v }); return b; },
      maybeSingle() { return exec(state).then(({ data, error }) => ({ data: data?.[0] || null, error })); },
      single()      { return exec(state).then(({ data, error }) => ({ data: data?.[0] || null, error })); },
      then(o, r)    { return exec(state).then(o, r); },
    };
    return b;
  }
  return { from(t) { return makeBuilder(t); } };
}

// LB candidate fixtures (LB's camelCase contract).
const candidate = (id, name, overrides = {}) => ({
  leadId:            id,
  externalRequestId: 'ext-' + id,
  platform:          'yelp',
  businessId:        'biz-fixture',
  customerName:      name,
  customerPhone:     null,
  customerEmail:     null,
  status:            'completed',
  createdAt:         '2026-04-01T13:07:34.000Z',
  statusUpdatedAt:   '2026-05-01T00:02:26.000Z',
  ageDays:           64,
  ...overrides,
});

const JILL = candidate('b5109475-396c-47a6-88de-c9d8270fe20a', 'Jill S.');
const LINKABLE = candidate('11111111-1111-1111-1111-111111111111', 'Antonya Cooper', {
  status:          'new',
  customerPhone:   '8005553841',
  createdAt:       '2026-06-03T17:26:29.000Z',
  statusUpdatedAt: null,
  ageDays:         1,
});
const AMBIG = candidate('22222222-2222-2222-2222-222222222222', 'Jon Daw');
const LOWCONF = candidate('33333333-3333-3333-3333-333333333333', 'Anne Luecke');

beforeEach(() => {
  mockFetchCandidates.mockReset();
  mockLinkLeadsBulk.mockReset();
  mockFindMatchCandidates.mockReset();
  mockFindHistoricalMatchType.mockReset();
  mockTryAcquire.mockReset();
  mockRelease.mockReset();
  mockTryAcquire.mockResolvedValue({ ok: true });
  mockRelease.mockResolvedValue(undefined);
});

// ──────────────────────────────────────────────────────────────────────
// buildFeedbackRow — encodes LB wire contract precisely
// ──────────────────────────────────────────────────────────────────────
describe('buildFeedbackRow', () => {
  test('no_match → confidence=none, no sf_job_id, match_type=customer_job', () => {
    const row = buildFeedbackRow({
      lbCandidate: JILL,
      categorized: { bucket: 'would_skip', reason: 'no_match', matched: [] },
    });
    expect(row).toEqual({
      lb_lead_id:        JILL.leadId,
      match_type:        'customer_job',
      sf_job_id:         null,
      sf_customer_id:    null,
      confidence:        'none',
      match_basis:       'none',
      sf_status:         null,
      sf_payment_status: null,
      occurred_at:       null,
      reason:            FEEDBACK_APPLY_REASON + ':no_match',
    });
  });

  test('lead_only_match → match_type=lead_only with sf_lead_id + stage; sf_customer_id/sf_job_id null', () => {
    const row = buildFeedbackRow({
      lbCandidate: JILL,
      categorized: {
        bucket: 'lead_only_match',
        reason: null,
        matched: [],
        extra: { sf_lead_id: 107, sf_lead_stage_name: 'Contacted', wire_match_basis: 'externalRequestId', matcher_step: 1 },
      },
    });
    expect(row).toEqual({
      lb_lead_id:         JILL.leadId,
      match_type:         'lead_only',
      sf_lead_id:         107,
      sf_lead_stage_name: 'Contacted',
      sf_customer_id:     null,
      sf_job_id:          null,
      confidence:         'exact',
      match_basis:        'externalRequestId',
      sf_status:          null,
      sf_payment_status:  null,
      occurred_at:        null,
      reason:             FEEDBACK_APPLY_REASON + ':sf_lead_only:externalRequestId',
    });
  });

  test('lead_only_match without sf_lead_id in extra → null (defensive)', () => {
    const row = buildFeedbackRow({
      lbCandidate: JILL,
      categorized: { bucket: 'lead_only_match', reason: null, matched: [], extra: { sf_lead_id: null } },
    });
    expect(row).toBeNull();
  });

  test('low_confidence (matcher returned medium) → confidence=medium with sf_job_id surfaced', () => {
    const row = buildFeedbackRow({
      lbCandidate: LOWCONF,
      categorized: {
        bucket:  'would_skip',
        reason:  'low_confidence',
        matched: [{
          confidence: 'medium',
          sf_job_id: 139832, sf_customer_id: 23393,
          match_signals: ['name_exact','date_within_14d'],
          sf_job: { status: 'completed', payment_status: 'paid' },
        }],
      },
    });
    expect(row.confidence).toBe('medium');
    expect(row.sf_job_id).toBe(139832);
    expect(row.sf_customer_id).toBe(23393);
    expect(row.match_basis).toBe('name_platform');
  });

  // Pin both branches of the low_confidence → LB confidence rule to prevent
  // accidental drift. Rule: passthrough matcher's medium; everything else
  // (low / unknown / null) → low.
  test('low_confidence (matcher returned low) → confidence=low', () => {
    const row = buildFeedbackRow({
      lbCandidate: LOWCONF,
      categorized: {
        bucket:  'would_skip',
        reason:  'low_confidence',
        matched: [{
          confidence: 'low',
          sf_job_id: 139832, sf_customer_id: 23393,
          match_signals: ['name_exact'],
          sf_job: { status: 'completed' },
        }],
      },
    });
    expect(row.confidence).toBe('low');
    expect(row.sf_job_id).toBe(139832);
  });

  test('multiple_candidates → confidence=medium', () => {
    const row = buildFeedbackRow({
      lbCandidate: AMBIG,
      categorized: {
        bucket:  'would_review',
        reason:  'multiple_candidates',
        matched: [{
          confidence: 'high',
          sf_job_id: null, sf_customer_id: 23115,
          match_signals: ['phone_exact:…2681'],
          sf_job: null,
        }],
      },
    });
    expect(row.confidence).toBe('medium');
    expect(row.match_basis).toBe('phone');
  });

  test('would_link → null (apply path handles linking, feedback skips)', () => {
    const row = buildFeedbackRow({
      lbCandidate: LINKABLE,
      categorized: {
        bucket:  'would_link',
        reason:  null,
        matched: [{ confidence: 'high', sf_job_id: 142307, sf_customer_id: 23487, sf_job: {} }],
      },
    });
    expect(row).toBeNull();
  });

  test('already_linked → null (no transition needed)', () => {
    const row = buildFeedbackRow({
      lbCandidate: JILL,
      categorized: { bucket: 'already_linked', reason: 'already_linked', matched: [] },
    });
    expect(row).toBeNull();
  });

  test('unknown reason → null (fail closed)', () => {
    const row = buildFeedbackRow({
      lbCandidate: JILL,
      categorized: { bucket: 'would_review', reason: 'something_brand_new', matched: [] },
    });
    expect(row).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────────
// runHistoricalFeedbackApply — dry-run defaults
// ──────────────────────────────────────────────────────────────────────
describe('runHistoricalFeedbackApply — dryRun defaults TRUE', () => {
  test('dryRun is true when omitted; LB linkLeadsBulk NEVER called', async () => {
    mockFetchCandidates.mockResolvedValue({ ok: true, candidates: [JILL], count: 1, more_may_exist: false });
    mockFindHistoricalMatchType.mockResolvedValue(mt.noMatch());

    const store = makeStore();
    const out = await runHistoricalFeedbackApply(store, { tenantId: SF_TENANT_ID });

    expect(out.ok).toBe(true);
    expect(out.phase).toBe('phase_3_feedback_dry_run');
    expect(out.summary.dry_run).toBe(true);
    expect(out.summary.would_no_match).toBe(1);
    expect(out.proposed_rows).toHaveLength(1);
    expect(out.proposed_rows[0]).toEqual(expect.objectContaining({
      lb_lead_id: JILL.leadId, confidence: 'none', match_basis: 'none',
    }));
    expect(mockLinkLeadsBulk).not.toHaveBeenCalled();
    // dry-run must NOT acquire the apply lock
    expect(mockTryAcquire).not.toHaveBeenCalled();
  });

  test('explicit dryRun:true behaves the same as default', async () => {
    mockFetchCandidates.mockResolvedValue({ ok: true, candidates: [JILL], count: 1, more_may_exist: false });
    mockFindHistoricalMatchType.mockResolvedValue(mt.noMatch());

    const out = await runHistoricalFeedbackApply(makeStore(), { tenantId: SF_TENANT_ID, dryRun: true });
    expect(out.summary.dry_run).toBe(true);
    expect(mockLinkLeadsBulk).not.toHaveBeenCalled();
  });

  test('mixed batch — counts every category correctly', async () => {
    mockFetchCandidates.mockResolvedValue({
      ok: true, count: 4, more_may_exist: false,
      candidates: [LINKABLE, AMBIG, LOWCONF, JILL],
    });
    // LINKABLE → customer_job high → would_link (skip)
    // AMBIG    → needs_review multi-candidate
    // LOWCONF  → needs_review low_confidence
    // JILL     → no_match
    mockFindHistoricalMatchType.mockImplementation((_db, args) => {
      const id = args.input.lb_lead_id;
      if (id === LINKABLE.leadId) return Promise.resolve(mt.customerJobHigh({ sf_customer_id: 23487, sf_job_id: 142307 }));
      if (id === AMBIG.leadId)    return Promise.resolve(mt.multiCandidates());
      if (id === LOWCONF.leadId)  return Promise.resolve(mt.lowConfidence({ sf_customer_id: 23393, sf_job_id: 139832, matcherConf: 'medium' }));
      return Promise.resolve(mt.noMatch());
    });

    const out = await runHistoricalFeedbackApply(makeStore(), { tenantId: SF_TENANT_ID });
    expect(out.ok).toBe(true);
    expect(out.summary.processed).toBe(4);
    expect(out.summary.would_link).toBe(1);            // LINKABLE — feedback skips
    expect(out.summary.would_review).toBe(2);          // AMBIG + LOWCONF (low_conf→needs_review)
    expect(out.summary.would_no_match).toBe(1);        // JILL
    expect(out.summary.would_failed).toBe(0);
    expect(out.proposed_rows).toHaveLength(3);         // 3 rows = AMBIG + LOWCONF + JILL
    // confirm Jill is in the proposed batch as no_match
    const jillRow = out.proposed_rows.find(r => r.lb_lead_id === JILL.leadId);
    expect(jillRow.confidence).toBe('none');
    expect(jillRow.match_type).toBe('customer_job');
  });

  test('lead_only candidate → match_type=lead_only emitted to wire shape', async () => {
    mockFetchCandidates.mockResolvedValue({ ok: true, candidates: [JILL], count: 1, more_may_exist: false });
    mockFindHistoricalMatchType.mockResolvedValue(mt.leadOnly({ sf_lead_id: 107, sf_lead_stage_name: 'Contacted' }));
    const out = await runHistoricalFeedbackApply(makeStore(), { tenantId: SF_TENANT_ID });
    expect(out.summary.would_lead_link).toBe(1);
    expect(out.summary.would_no_match).toBe(0);
    expect(out.proposed_rows).toHaveLength(1);
    expect(out.proposed_rows[0]).toEqual(expect.objectContaining({
      lb_lead_id:         JILL.leadId,
      match_type:         'lead_only',
      sf_lead_id:         107,
      sf_lead_stage_name: 'Contacted',
      sf_customer_id:     null,
      sf_job_id:          null,
      confidence:         'exact',
      match_basis:        'externalRequestId',
    }));
  });

  test('matcher throw → would_failed++ and row NOT in proposed_rows', async () => {
    mockFetchCandidates.mockResolvedValue({ ok: true, candidates: [JILL], count: 1, more_may_exist: false });
    mockFindHistoricalMatchType.mockRejectedValue(new Error('db is on fire'));

    const out = await runHistoricalFeedbackApply(makeStore(), { tenantId: SF_TENANT_ID });
    expect(out.summary.would_failed).toBe(1);
    expect(out.summary.would_no_match).toBe(0);
    expect(out.proposed_rows).toHaveLength(0);
    expect(out.per_lead[0]).toEqual(expect.objectContaining({ bucket: 'matcher_error', action: 'skip_retry_next_batch' }));
  });
});

// ──────────────────────────────────────────────────────────────────────
// runHistoricalFeedbackApply — live apply path (dryRun:false)
// ──────────────────────────────────────────────────────────────────────
describe('runHistoricalFeedbackApply — dryRun:false posts to LB once', () => {
  test('posts ONE batch with all eligible rows; lock acquired and released', async () => {
    mockFetchCandidates.mockResolvedValue({ ok: true, candidates: [JILL, AMBIG], count: 2, more_may_exist: false });
    mockFindHistoricalMatchType.mockImplementation((_db, args) => {
      if (args.input.lb_lead_id === JILL.leadId)  return Promise.resolve(mt.noMatch());
      if (args.input.lb_lead_id === AMBIG.leadId) return Promise.resolve(mt.multiCandidates());
      return Promise.resolve(mt.noMatch());
    });
    mockLinkLeadsBulk.mockResolvedValue({
      ok: true, status: 200,
      applied:  [
        { lb_lead_id: JILL.leadId, lb_result: 'no_match', lb_sync_status: 'no_match', sf_managed: true },
        { lb_lead_id: AMBIG.leadId, lb_result: 'needs_review', lb_sync_status: 'needs_review', sf_managed: true },
      ],
      rejected: [],
      summary:  { total: 2, linked: 0, needs_review: 1, no_match: 1, conflict: 0, not_found: 0, failed: 0, status_updates_applied: 0 },
      request_id: 'sf-abc123',
    });

    const out = await runHistoricalFeedbackApply(makeStore(), { tenantId: SF_TENANT_ID, dryRun: false });

    expect(out.ok).toBe(true);
    expect(out.phase).toBe('phase_3_feedback_apply');
    expect(out.applied).toHaveLength(2);
    expect(out.rejected).toHaveLength(0);
    expect(mockLinkLeadsBulk).toHaveBeenCalledTimes(1);
    expect(mockTryAcquire).toHaveBeenCalledTimes(1);
    expect(mockRelease).toHaveBeenCalledTimes(1);
    // Wire contract pin: confidence=none for no_match, medium for ambiguous
    const sentRows = mockLinkLeadsBulk.mock.calls[0][0].matches;
    expect(sentRows).toHaveLength(2);
    const jillSent = sentRows.find(r => r.lb_lead_id === JILL.leadId);
    expect(jillSent.confidence).toBe('none');
    expect(jillSent.sf_job_id).toBeNull();
    const ambigSent = sentRows.find(r => r.lb_lead_id === AMBIG.leadId);
    expect(ambigSent.confidence).toBe('medium');
  });

  test('lock held by another caller → 409 apply_in_progress, no LB call', async () => {
    mockTryAcquire.mockResolvedValue({ ok: false, reason: 'apply_in_progress' });

    const out = await runHistoricalFeedbackApply(makeStore(), { tenantId: SF_TENANT_ID, dryRun: false });
    expect(out.ok).toBe(false);
    expect(out.status).toBe(409);
    expect(out.error).toBe('apply_in_progress');
    expect(mockLinkLeadsBulk).not.toHaveBeenCalled();
    expect(mockRelease).not.toHaveBeenCalled();
  });

  test('zero eligible rows → no LB call, ok response', async () => {
    mockFetchCandidates.mockResolvedValue({ ok: true, candidates: [LINKABLE], count: 1, more_may_exist: false });
    // LINKABLE → would_link → feedback skips, nothing to post.
    mockFindHistoricalMatchType.mockResolvedValue(mt.customerJobHigh({ sf_customer_id: 23487, sf_job_id: 142307 }));

    const out = await runHistoricalFeedbackApply(makeStore(), { tenantId: SF_TENANT_ID, dryRun: false });
    expect(out.ok).toBe(true);
    expect(out.applied).toEqual([]);
    expect(mockLinkLeadsBulk).not.toHaveBeenCalled();
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  test('LB call fails → status passed through, lock released', async () => {
    mockFetchCandidates.mockResolvedValue({ ok: true, candidates: [JILL], count: 1, more_may_exist: false });
    mockFindHistoricalMatchType.mockResolvedValue(mt.noMatch());
    mockLinkLeadsBulk.mockResolvedValue({ ok: false, status: 503, reason: 'lb_unreachable', error_description: 'connection refused', request_id: 'sf-zzz' });

    const out = await runHistoricalFeedbackApply(makeStore(), { tenantId: SF_TENANT_ID, dryRun: false });
    expect(out.ok).toBe(false);
    expect(out.status).toBe(503);
    expect(out.error).toBe('lb_unreachable');
    expect(out.request_id).toBe('sf-zzz');
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Post-timeout reconcile — fired when LB times out at SF's 120s mark
// while still committing rows server-side. The reconcile re-fetches LB
// state and synthesises applied / uncertain from authoritative
// syncStatus, so the orchestrator can return ok:true with accurate
// per-row outcomes instead of 502 lb_request_timeout + applied=[].
// ──────────────────────────────────────────────────────────────────────
const { expectedLbSyncStatusFor } = require('../lib/sf-historical-sync-orchestrator');

describe('expectedLbSyncStatusFor — match_type → expected LB syncStatus', () => {
  test('lead_only → lead_linked', () => {
    expect(expectedLbSyncStatusFor({ match_type: 'lead_only', confidence: 'exact' })).toBe('lead_linked');
  });
  test('customer_job exact|high → linked', () => {
    expect(expectedLbSyncStatusFor({ match_type: 'customer_job', confidence: 'exact' })).toBe('linked');
    expect(expectedLbSyncStatusFor({ match_type: 'customer_job', confidence: 'high' })).toBe('linked');
  });
  test('customer_job medium|low → needs_review', () => {
    expect(expectedLbSyncStatusFor({ match_type: 'customer_job', confidence: 'medium' })).toBe('needs_review');
    expect(expectedLbSyncStatusFor({ match_type: 'customer_job', confidence: 'low' })).toBe('needs_review');
  });
  test('confidence=none → no_match', () => {
    expect(expectedLbSyncStatusFor({ match_type: 'customer_job', confidence: 'none' })).toBe('no_match');
  });
  test('unknown/missing shape → null', () => {
    expect(expectedLbSyncStatusFor(null)).toBeNull();
    expect(expectedLbSyncStatusFor({})).toBeNull();
    expect(expectedLbSyncStatusFor({ match_type: 'customer_job' })).toBeNull();
  });
});

describe('runHistoricalFeedbackApply — post-timeout reconcile', () => {
  // Reusable fixture for the live-apply path so each test can swap the
  // LB linkLeadsBulk response without re-declaring matcher/store setup.
  //
  // fetchCandidates is called TWICE in the reconcile path:
  //   1. initial candidates pull (start of runHistoricalFeedbackApply)
  //   2. reconcile pull (only when linkLeadsBulk returns request_timeout)
  // We queue the initial response via mockResolvedValueOnce here so each
  // test can append its own mockResolvedValueOnce for the reconcile call.
  function setupBatch(candidates, matcherImpl) {
    mockFetchCandidates.mockResolvedValueOnce({ ok: true, count: candidates.length, candidates, more_may_exist: false });
    mockFindHistoricalMatchType.mockImplementation((_db, args) => matcherImpl(args.input.lb_lead_id));
  }

  test('LB timeout but ALL rows later committed → reconcile applied + ok:true + reconciled_after_timeout=true', async () => {
    // Two leads sent: Jill (lead_only) + AMBIG (needs_review). LB times out
    // at SF's 120s mark; reconcile fetch reveals both rows landed under
    // their expected syncStatuses (lead_linked + needs_review). Expected:
    // synthetic applied set with both rows; uncertain stays empty.
    setupBatch([JILL, AMBIG], id => {
      if (id === JILL.leadId)  return Promise.resolve(mt.leadOnly({ sf_lead_id: 107, sf_lead_stage_name: 'Contacted' }));
      if (id === AMBIG.leadId) return Promise.resolve(mt.multiCandidates());
      return Promise.resolve(mt.noMatch());
    });
    // First call (the actual POST) times out.
    mockLinkLeadsBulk.mockResolvedValueOnce({ ok: false, reason: 'request_timeout', request_id: 'sf-timeout-001', timeout: true });
    // Reconcile fetch — both rows show as fully committed.
    mockFetchCandidates.mockResolvedValueOnce({ ok: true, count: 2, candidates: [
      { ...JILL,  syncStatus: 'lead_linked',  sfLeadId: '107', sfLeadStageName: 'Contacted', sfJobId: null, sfCustomerId: null },
      { ...AMBIG, syncStatus: 'needs_review', sfLeadId: null,  sfJobId: null,                sfCustomerId: null },
    ], more_may_exist: false });

    const out = await runHistoricalFeedbackApply(makeStore(), { tenantId: SF_TENANT_ID, dryRun: false });

    expect(out.ok).toBe(true);
    expect(out.reconciled_after_timeout).toBe(true);
    expect(out.applied).toHaveLength(2);
    expect(out.uncertain).toEqual([]);
    expect(out.rejected).toEqual([]);
    const jillApplied = out.applied.find(r => r.lb_lead_id === JILL.leadId);
    expect(jillApplied.lb_sync_status).toBe('lead_linked');
    expect(jillApplied.lb_detail).toBe('reconciled_from_post_timeout_fetch');
    const ambigApplied = out.applied.find(r => r.lb_lead_id === AMBIG.leadId);
    expect(ambigApplied.lb_sync_status).toBe('needs_review');
  });

  test('LB timeout and NO rows committed → all uncertain[] + applied[] empty', async () => {
    setupBatch([JILL], id => (id === JILL.leadId ? Promise.resolve(mt.leadOnly({ sf_lead_id: 107, sf_lead_stage_name: 'Contacted' })) : Promise.resolve(mt.noMatch())));
    mockLinkLeadsBulk.mockResolvedValueOnce({ ok: false, reason: 'request_timeout', request_id: 'sf-timeout-002', timeout: true });
    // Reconcile fetch returns zero candidates in any of the landing statuses —
    // LB never wrote any of the rows we sent.
    mockFetchCandidates.mockResolvedValueOnce({ ok: true, count: 0, candidates: [], more_may_exist: false });

    const out = await runHistoricalFeedbackApply(makeStore(), { tenantId: SF_TENANT_ID, dryRun: false });

    expect(out.ok).toBe(true);
    expect(out.reconciled_after_timeout).toBe(true);
    expect(out.applied).toEqual([]);
    expect(out.uncertain).toHaveLength(1);
    expect(out.uncertain[0]).toEqual(expect.objectContaining({
      lb_lead_id: JILL.leadId,
      match_type: 'lead_only',
      expected_sync_status: 'lead_linked',
      actual_sync_status: null,
      reason: 'lb_state_uncertain',
    }));
  });

  test('partial commit → some applied, others uncertain', async () => {
    // Two rows sent; LB committed Jill (lead_linked) but not Antonya (customer_job).
    const ANTONYA_HIGH = candidate('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Antonya Cooper', { platform: 'thumbtack', customerPhone: '8005553841' });
    // setupBatch only returns lead_only by default — we need both candidates.
    // Sent: Jill → lead_only, Antonya → customer_job. But customer_job rows
    // currently route to the apply path (not feedback) when confidence=high.
    // We use a medium-confidence customer_job so the row goes through feedback
    // and would land as needs_review on the LB side.
    setupBatch([JILL, ANTONYA_HIGH], id => {
      if (id === JILL.leadId)         return Promise.resolve(mt.leadOnly({ sf_lead_id: 107, sf_lead_stage_name: 'Contacted' }));
      if (id === ANTONYA_HIGH.leadId) return Promise.resolve(mt.lowConfidence({ sf_customer_id: 23487, sf_job_id: 142307, matcherConf: 'medium' }));
      return Promise.resolve(mt.noMatch());
    });
    mockLinkLeadsBulk.mockResolvedValueOnce({ ok: false, reason: 'request_timeout', request_id: 'sf-timeout-003', timeout: true });
    // Reconcile: Jill landed at lead_linked; Antonya nowhere.
    mockFetchCandidates.mockResolvedValueOnce({ ok: true, count: 1, candidates: [
      { ...JILL, syncStatus: 'lead_linked', sfLeadId: '107', sfLeadStageName: 'Contacted', sfJobId: null, sfCustomerId: null },
    ], more_may_exist: false });

    const out = await runHistoricalFeedbackApply(makeStore(), { tenantId: SF_TENANT_ID, dryRun: false });

    expect(out.ok).toBe(true);
    expect(out.reconciled_after_timeout).toBe(true);
    expect(out.applied).toHaveLength(1);
    expect(out.applied[0].lb_lead_id).toBe(JILL.leadId);
    expect(out.uncertain).toHaveLength(1);
    expect(out.uncertain[0].lb_lead_id).toBe(ANTONYA_HIGH.leadId);
    expect(out.uncertain[0].match_type).toBe('customer_job');
  });

  test('LB returns wrong syncStatus for our row → uncertain (lb_state_mismatch), not applied', async () => {
    // We sent lead_only for Jill but LB shows her at syncStatus='pending'
    // somehow (race / partial rollback / unrelated state). Must NOT be
    // counted as applied — must land in uncertain with lb_state_mismatch.
    setupBatch([JILL], id => Promise.resolve(mt.leadOnly({ sf_lead_id: 107, sf_lead_stage_name: 'Contacted' })));
    mockLinkLeadsBulk.mockResolvedValueOnce({ ok: false, reason: 'request_timeout', request_id: 'sf-timeout-004', timeout: true });
    mockFetchCandidates.mockResolvedValueOnce({ ok: true, count: 1, candidates: [
      // Wrong state — looks like LB didn't actually apply our feedback row
      { ...JILL, syncStatus: 'pending', sfLeadId: null, sfLeadStageName: null, sfJobId: null, sfCustomerId: null },
    ], more_may_exist: false });

    const out = await runHistoricalFeedbackApply(makeStore(), { tenantId: SF_TENANT_ID, dryRun: false });

    expect(out.ok).toBe(true);
    expect(out.reconciled_after_timeout).toBe(true);
    expect(out.applied).toEqual([]);
    expect(out.uncertain).toHaveLength(1);
    expect(out.uncertain[0]).toEqual(expect.objectContaining({
      reason: 'lb_state_mismatch',
      expected_sync_status: 'lead_linked',
      actual_sync_status: 'pending',
    }));
  });

  test('reconcile fetch itself fails → 502 lb_state_uncertain (operator must inspect)', async () => {
    setupBatch([JILL], id => Promise.resolve(mt.leadOnly({ sf_lead_id: 107, sf_lead_stage_name: 'Contacted' })));
    mockLinkLeadsBulk.mockResolvedValueOnce({ ok: false, reason: 'request_timeout', request_id: 'sf-timeout-005', timeout: true });
    // Reconcile fetch returns ok:false — LB is unreachable for the
    // reconcile pass too. The orchestrator can no longer determine
    // state authoritatively; it must surface that explicitly.
    mockFetchCandidates.mockResolvedValueOnce({ ok: false, reason: 'lb_unreachable', error_description: 'still down' });

    const out = await runHistoricalFeedbackApply(makeStore(), { tenantId: SF_TENANT_ID, dryRun: false });

    expect(out.ok).toBe(false);
    expect(out.status).toBe(502);
    expect(out.error).toBe('lb_state_uncertain');
    expect(out.request_id).toBe('sf-timeout-005');
  });

  test('attachLbLink is NEVER called from the feedback path — even after reconcile confirms applied rows', async () => {
    // Hard structural invariant — `runHistoricalFeedbackApply` does not
    // and must not own SF-side state writes; that's the apply path's job
    // (runHistoricalSyncApply). Even with a successful reconcile, no
    // SF customer / job / outbox write happens.
    //
    // The store mock would throw on any insert/update/delete, so a
    // structural regression that adds an attach call from this path
    // would fail the test loudly. We assert no LB-call-side-effect
    // beyond the two expected calls (linkLeadsBulk + reconcile fetch),
    // and trust the mock store to enforce the rest.
    setupBatch([JILL], id => Promise.resolve(mt.leadOnly({ sf_lead_id: 107, sf_lead_stage_name: 'Contacted' })));
    mockLinkLeadsBulk.mockResolvedValueOnce({ ok: false, reason: 'request_timeout', request_id: 'sf-timeout-006', timeout: true });
    mockFetchCandidates.mockResolvedValueOnce({ ok: true, count: 1, candidates: [
      { ...JILL, syncStatus: 'lead_linked', sfLeadId: '107', sfLeadStageName: 'Contacted', sfJobId: null, sfCustomerId: null },
    ], more_may_exist: false });

    const out = await runHistoricalFeedbackApply(makeStore(), { tenantId: SF_TENANT_ID, dryRun: false });

    // Sanity: the row appears in applied (reconciled).
    expect(out.applied).toHaveLength(1);
    expect(out.applied[0].lb_lead_id).toBe(JILL.leadId);

    // No additional LB calls. Specifically, no second linkLeadsBulk
    // (which is how a hypothetical attach-style retry would manifest).
    expect(mockLinkLeadsBulk).toHaveBeenCalledTimes(1);
    // The two fetchCandidates calls: 1 initial fetch + 1 reconcile.
    expect(mockFetchCandidates).toHaveBeenCalledTimes(2);
  });

  test('non-timeout LB error (e.g. 503 lb_unreachable) does NOT trigger reconcile', async () => {
    // The reconcile branch is gated on reason === 'request_timeout'.
    // Other failure modes pass through to the existing error path
    // unchanged — orchestrator returns ok:false with the LB status.
    setupBatch([JILL], id => Promise.resolve(mt.leadOnly({ sf_lead_id: 107, sf_lead_stage_name: 'Contacted' })));
    mockLinkLeadsBulk.mockResolvedValueOnce({ ok: false, reason: 'lb_unreachable', status: 503, error_description: 'down', request_id: 'sf-not-timeout' });

    const out = await runHistoricalFeedbackApply(makeStore(), { tenantId: SF_TENANT_ID, dryRun: false });

    expect(out.ok).toBe(false);
    expect(out.status).toBe(503);
    expect(out.error).toBe('lb_unreachable');
    // Exactly 1 fetch (the initial candidates pull) — no reconcile fetch.
    expect(mockFetchCandidates).toHaveBeenCalledTimes(1);
  });

  test('successful (non-timeout) apply path is unchanged — no reconciled_after_timeout flag', async () => {
    // Regression guard: a normal happy-path apply must still work and
    // the new reconciled_after_timeout flag must be false.
    setupBatch([JILL], id => Promise.resolve(mt.leadOnly({ sf_lead_id: 107, sf_lead_stage_name: 'Contacted' })));
    mockLinkLeadsBulk.mockResolvedValueOnce({
      ok: true, status: 200,
      applied:  [{ lb_lead_id: JILL.leadId, lb_result: 'lead_linked', lb_sync_status: 'lead_linked', sf_managed: true }],
      rejected: [],
      summary:  { total: 1, lead_linked: 1, linked: 0, needs_review: 0, no_match: 0, conflict: 0, not_found: 0, failed: 0, status_updates_applied: 0 },
      request_id: 'sf-happy',
    });

    const out = await runHistoricalFeedbackApply(makeStore(), { tenantId: SF_TENANT_ID, dryRun: false });

    expect(out.ok).toBe(true);
    expect(out.applied).toHaveLength(1);
    expect(out.reconciled_after_timeout).toBe(false);
    expect(out.uncertain).toEqual([]);
    // No reconcile fetch.
    expect(mockFetchCandidates).toHaveBeenCalledTimes(1);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Class filter — operator-selectable
// ──────────────────────────────────────────────────────────────────────
describe('runHistoricalFeedbackApply — class filter', () => {
  test('default classes excludes already_reconciled_customer', () => {
    expect(FEEDBACK_DEFAULT_CLASSES).toContain('no_match');
    expect(FEEDBACK_DEFAULT_CLASSES).not.toContain('already_reconciled_customer');
    expect(FEEDBACK_ALL_CLASSES).toContain('already_reconciled_customer');
  });

  test('classes:[no_match] only sends no_match rows', async () => {
    mockFetchCandidates.mockResolvedValue({ ok: true, candidates: [JILL, LOWCONF], count: 2, more_may_exist: false });
    mockFindHistoricalMatchType.mockImplementation((_db, args) => {
      if (args.input.lb_lead_id === JILL.leadId) return Promise.resolve(mt.noMatch());
      return Promise.resolve(mt.lowConfidence({ sf_customer_id: 23393, sf_job_id: 139832, matcherConf: 'medium' }));
    });
    const out = await runHistoricalFeedbackApply(makeStore(), { tenantId: SF_TENANT_ID, classes: ['no_match'] });
    expect(out.summary.would_no_match).toBe(1);
    expect(out.summary.would_review).toBe(0);                      // LOWCONF excluded by class filter
    expect(out.summary.would_skipped_not_processed).toBe(1);
    expect(out.proposed_rows).toHaveLength(1);
    expect(out.proposed_rows[0].lb_lead_id).toBe(JILL.leadId);
  });

  test('classes:[invalid_class] → 400 invalid_classes', async () => {
    const out = await runHistoricalFeedbackApply(makeStore(), { tenantId: SF_TENANT_ID, classes: ['no_match','garbage'] });
    expect(out.ok).toBe(false);
    expect(out.status).toBe(400);
    expect(out.error).toBe('invalid_classes');
  });

  test('already_reconciled_customer omitted by default — not in proposed_rows, not in LB POST', async () => {
    mockFetchCandidates.mockResolvedValue({ ok: true, candidates: [JILL], count: 1, more_may_exist: false });
    mockFindHistoricalMatchType.mockResolvedValue(mt.alreadyReconciled({ sf_customer_id: 23274, sf_job_id: 140075 }));
    // Default classes: feedback should classify this row as
    // already_reconciled_customer and NOT include it in the proposed batch.
    const out = await runHistoricalFeedbackApply(makeStore(), { tenantId: SF_TENANT_ID });
    expect(out.summary.would_no_match).toBe(0);
    expect(out.summary.would_review).toBe(0);
    expect(out.summary.would_skipped_not_processed).toBe(1);
    expect(out.proposed_rows).toEqual([]);
    expect(out.per_lead[0]).toEqual(expect.objectContaining({
      reason: 'already_reconciled_customer',
      action: 'skip_class_not_selected',
    }));
  });

  test('classes including already_reconciled_customer opts in', async () => {
    mockFetchCandidates.mockResolvedValue({ ok: true, candidates: [JILL], count: 1, more_may_exist: false });
    mockFindHistoricalMatchType.mockResolvedValue(mt.alreadyReconciled({ sf_customer_id: 23274, sf_job_id: 140075 }));
    const out = await runHistoricalFeedbackApply(makeStore(), {
      tenantId: SF_TENANT_ID,
      classes: ['no_match','already_reconciled_customer'],
    });
    expect(out.summary.would_no_match).toBe(1);
    expect(out.proposed_rows[0].confidence).toBe('none');
  });

  test('lead_only included in default classes; classes:[no_match] excludes it', async () => {
    expect(FEEDBACK_DEFAULT_CLASSES).toContain('lead_only');

    // Run with classes:[no_match] → lead_only row is filtered out
    mockFetchCandidates.mockResolvedValue({ ok: true, candidates: [JILL], count: 1, more_may_exist: false });
    mockFindHistoricalMatchType.mockResolvedValue(mt.leadOnly({ sf_lead_id: 107, sf_lead_stage_name: 'Contacted' }));
    const out = await runHistoricalFeedbackApply(makeStore(), {
      tenantId: SF_TENANT_ID,
      classes: ['no_match'],
    });
    expect(out.summary.would_lead_link).toBe(0);
    expect(out.summary.would_skipped_not_processed).toBe(1);
    expect(out.proposed_rows).toEqual([]);
  });
});
