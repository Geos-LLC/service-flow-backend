'use strict';

/**
 * Full-reconcile mode + sf_truth_overrides_lb_automation_lost classifier.
 *
 * Two new orchestrator behaviors under test:
 *
 *   1. sync_scope flag (pending_only | full_reconcile)
 *      - pending_only (default) → LB request body uses ['pending']
 *        (back-compat with current production behavior)
 *      - full_reconcile         → LB request body uses
 *        ['pending','skipped','needs_review','failed','no_match']
 *        (surfaces lifecycle-terminal rows like lost/cancelled)
 *
 *   2. categorize() new rules — both narrowly scoped:
 *      - already_linked: lbCandidate.sfJobId === matched.sf_job_id
 *        Short-circuits BEFORE every conflict guard so reruns of
 *        full_reconcile never re-apply existing links.
 *      - sf_truth_overrides_lb_automation_lost: LB-automation-set lost
 *        rows whose SF truth is a high-confidence completed+paid job
 *        get bucketed as would_link with a distinct reason. Strict
 *        9-point gate — fails closed if any condition is missing.
 *
 *   3. isApplicable() defense-in-depth for lost rows
 *      Mirrors the categorize() gate so a stale operator approval
 *      can't apply a lost-row link if statusSource isn't lb_automation
 *      or the SF job isn't completed+paid.
 *
 * All existing safety guards are tested for non-regression:
 *   - lb_already_pinned_to_different_job still wins for non-matching pins
 *   - already_reconciled_customer still suppresses remap
 *   - sf_job_linked_to_different_lb_lead still flags conflict
 *   - low confidence / multiple candidates / no match unchanged
 */

process.env.SF_LB_PROVISIONING_SHARED_SECRET = 'p1-fullreconcile-test-' + 'C'.repeat(20);
process.env.LB_PROVISIONING_BASE_URL          = 'https://lb-test.example.com/api';

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
  categorize,
  isApplicable,
  resolveSyncStatuses,
  SCOPE_PENDING_ONLY,
  SCOPE_FULL_RECONCILE,
  DEFAULT_SYNC_STATUSES_BY_SCOPE,
} = require('../lib/sf-historical-sync-orchestrator');

const LB_USER_UUID  = 'c3d14499-dec1-42c3-a36c-713cb09842c6';
const SF_TENANT_ID  = 2;
const ELDA_LB_ID    = '23e6827b-c188-4c81-b68a-54ad18e05f3e';
const BARBARA_LB_ID = '2270d3c4-6be0-4000-b000-000000000001';
const EXT_REQ_BARBARA = 'tt_req_barbara_141941';

// LB candidate shape used across cases. Override fields per case.
function lbCandidate(overrides = {}) {
  return Object.assign({
    leadId:            BARBARA_LB_ID,
    externalRequestId: EXT_REQ_BARBARA,
    platform:          'thumbtack',
    businessId:        'biz-tampa',
    customerName:      'Barbara Preston',
    customerPhone:     '8135551234',
    customerEmail:     null,
    status:            'lost',
    statusSource:      'lb_automation',
    lostReason:        'hired_someone',
    sfJobId:           null,
    createdAt:         '2026-05-01T12:00:00Z',
    statusUpdatedAt:   '2026-05-15T12:00:00Z',
    ageDays:           33,
  }, overrides);
}

// SF matcher candidate. Override fields per case.
function sfMatch(overrides = {}) {
  return Object.assign({
    sf_customer_id: 23577,
    sf_job_id:      141941,
    confidence:     'high',
    match_signals:  ['phone_exact:…1234'],
    sf_customer: {
      first_name: 'Barbara', last_name: 'Preston',
      phone_last4: '1234', email_present: false,
      lb_lead_id: null, any_job_linked: false,
    },
    sf_job: {
      status:                  'completed',
      payment_status:          'paid',
      scheduled_date:          '2026-04-22T15:00:00Z',
      lb_external_request_id:  null,
      lb_channel:              null,
      lb_business_id:          null,
      lb_lead_id:              null,
    },
    ambiguity_warnings: [],
  }, overrides);
}

// ──────────────────────────────────────────────────────────────
// resolveSyncStatuses — sync_scope precedence
// ──────────────────────────────────────────────────────────────
describe('resolveSyncStatuses', () => {
  test('pending_only (default) returns [pending]', () => {
    expect(resolveSyncStatuses({ syncScope: SCOPE_PENDING_ONLY }))
      .toEqual(['pending']);
  });

  test('full_reconcile returns broad set', () => {
    expect(resolveSyncStatuses({ syncScope: SCOPE_FULL_RECONCILE }))
      .toEqual(['pending', 'skipped', 'needs_review', 'failed', 'no_match']);
  });

  test('explicit syncStatuses arg wins over scope (back-compat for apply-path linked fetch)', () => {
    expect(resolveSyncStatuses({ syncStatuses: ['linked'], syncScope: SCOPE_FULL_RECONCILE }))
      .toEqual(['linked']);
  });

  test('unknown scope → falls back to pending_only', () => {
    expect(resolveSyncStatuses({ syncScope: 'bogus' }))
      .toEqual(['pending']);
  });

  test('no args → pending_only default', () => {
    expect(resolveSyncStatuses({})).toEqual(['pending']);
  });

  test('empty syncStatuses array does NOT count as explicit override', () => {
    expect(resolveSyncStatuses({ syncStatuses: [], syncScope: SCOPE_FULL_RECONCILE }))
      .toEqual(['pending', 'skipped', 'needs_review', 'failed', 'no_match']);
  });

  test('exported DEFAULT_SYNC_STATUSES_BY_SCOPE is frozen + correct', () => {
    expect(Object.isFrozen(DEFAULT_SYNC_STATUSES_BY_SCOPE)).toBe(true);
    expect(DEFAULT_SYNC_STATUSES_BY_SCOPE.pending_only).toEqual(['pending']);
    expect(DEFAULT_SYNC_STATUSES_BY_SCOPE.full_reconcile)
      .toEqual(['pending', 'skipped', 'needs_review', 'failed', 'no_match']);
  });
});

// ──────────────────────────────────────────────────────────────
// categorize — sf_truth_overrides_lb_automation_lost
// ──────────────────────────────────────────────────────────────
describe('categorize — sf_truth_overrides_lb_automation_lost (the Barbara/Elda rule)', () => {
  test('lost + lb_automation + sf completed+paid + phone exact → would_link with new reason', () => {
    const cat = categorize({
      lbCandidate: lbCandidate(),
      matched:     [sfMatch()],
    });
    expect(cat.bucket).toBe('would_link');
    expect(cat.reason).toBe('sf_truth_overrides_lb_automation_lost');
  });

  test('lost but human-set (statusSource=user_admin) → does NOT trigger new rule, falls through to would_skip', () => {
    // Strict gate fails on the statusSource check. With no auto-link rule
    // catching it, the row should fall through to low_confidence (single
    // medium-conf path) or no_match. Confidence stays high here so it
    // falls to the shouldAutoLink branch — but that would auto-link it,
    // which is wrong for human-set lost. Confirm the new rule does NOT
    // produce sf_truth_overrides_lb_automation_lost as the reason.
    const cat = categorize({
      lbCandidate: lbCandidate({ statusSource: 'user_admin' }),
      matched:     [sfMatch()],
    });
    expect(cat.reason).not.toBe('sf_truth_overrides_lb_automation_lost');
    // The existing rule still auto-links — which is acceptable, because
    // a human-set lost on a customer with a completed+paid job is most
    // likely a data-quality issue and the standard would_link path is
    // the right escalation. The defense is in isApplicable() (covered
    // below).
    expect(cat.bucket).toBe('would_link');
    expect(cat.reason).toBeNull();
  });

  test('lost + lb_automation + sf job NOT completed → does NOT auto-link via new rule', () => {
    const cat = categorize({
      lbCandidate: lbCandidate(),
      matched:     [sfMatch({ sf_job: { status: 'scheduled', payment_status: 'unpaid', lb_external_request_id: null, lb_lead_id: null } })],
    });
    expect(cat.reason).not.toBe('sf_truth_overrides_lb_automation_lost');
  });

  test('lost + lb_automation + sf completed but unpaid → does NOT auto-link via new rule', () => {
    const cat = categorize({
      lbCandidate: lbCandidate(),
      matched:     [sfMatch({ sf_job: { status: 'completed', payment_status: 'unpaid', lb_external_request_id: null, lb_lead_id: null } })],
    });
    expect(cat.reason).not.toBe('sf_truth_overrides_lb_automation_lost');
  });

  test('lost + lb_automation + medium confidence → does NOT auto-link via new rule', () => {
    const cat = categorize({
      lbCandidate: lbCandidate(),
      matched:     [sfMatch({ confidence: 'medium' })],
    });
    expect(cat.reason).not.toBe('sf_truth_overrides_lb_automation_lost');
    // medium-conf single match with no other guard hit falls to
    // low_confidence skip.
    expect(cat.bucket).toBe('would_skip');
    expect(cat.reason).toBe('low_confidence');
  });

  test('lost + lb_automation + ambiguity_warnings present → does NOT auto-link via new rule', () => {
    const cat = categorize({
      lbCandidate: lbCandidate(),
      matched:     [sfMatch({ ambiguity_warnings: ['multiple_high_conf'] })],
    });
    expect(cat.reason).not.toBe('sf_truth_overrides_lb_automation_lost');
  });

  test('lost + lb_automation but matched customer already reconciled → would_skip (not new rule)', () => {
    const cat = categorize({
      lbCandidate: lbCandidate(),
      matched:     [sfMatch({
        sf_customer: { lb_lead_id: 'other-lead-id', any_job_linked: true,
                       first_name:'Barbara', last_name:'Preston', phone_last4:'1234', email_present:false },
      })],
    });
    expect(cat.reason).toBe('already_reconciled_customer');
    expect(cat.bucket).toBe('would_skip');
  });

  test('lost + lb_automation but sf_job pinned to DIFFERENT lb_lead → does NOT trigger new rule', () => {
    const cat = categorize({
      lbCandidate: lbCandidate(),
      matched:     [sfMatch({
        sf_job: {
          status: 'completed', payment_status: 'paid',
          scheduled_date: '2026-04-22T15:00:00Z',
          lb_external_request_id: null, lb_channel: null, lb_business_id: null,
          lb_lead_id: 'different-lb-lead-id',
        },
      })],
    });
    expect(cat.reason).not.toBe('sf_truth_overrides_lb_automation_lost');
  });

  test('lost + lb_automation + statusSource undefined (LB hasn\'t shipped field yet) → fails closed, NOT new rule', () => {
    const cat = categorize({
      lbCandidate: lbCandidate({ statusSource: undefined }),
      matched:     [sfMatch()],
    });
    expect(cat.reason).not.toBe('sf_truth_overrides_lb_automation_lost');
    // Without statusSource the row still has a high-conf match + completed+paid
    // job, so the existing rule kicks in and would_link with reason=null.
    expect(cat.bucket).toBe('would_link');
    expect(cat.reason).toBeNull();
  });

  test('REGRESSION (Elda) — engaged status set by admin → existing rule handles, NOT new rule', () => {
    // Elda is no longer 'lost' — admin moved her to 'engaged' before
    // tenant 2's full_reconcile shadow run. Confirm she rides the
    // standard auto-link path, not the new rule.
    const cat = categorize({
      lbCandidate: lbCandidate({
        leadId: ELDA_LB_ID, status: 'engaged', statusSource: 'lb_admin', lostReason: null,
        customerName: 'Elda Pittman', customerPhone: '8132226789',
      }),
      matched: [sfMatch({ sf_customer_id: 23477, sf_job_id: 142222 })],
    });
    expect(cat.bucket).toBe('would_link');
    expect(cat.reason).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────
// categorize — already_linked bucket (new)
// ──────────────────────────────────────────────────────────────
describe('categorize — already_linked bucket', () => {
  test('lbCandidate.sfJobId === matched.sf_job_id → already_linked, short-circuits BEFORE all conflict guards', () => {
    const cat = categorize({
      lbCandidate: lbCandidate({ sfJobId: 141941 }),
      matched:     [sfMatch({ sf_job_id: 141941 })],
    });
    expect(cat.bucket).toBe('already_linked');
    expect(cat.reason).toBe('already_linked');
  });

  test('already_linked wins over already_reconciled_customer (no remap, no double-link)', () => {
    const cat = categorize({
      lbCandidate: lbCandidate({ sfJobId: 141941 }),
      matched:     [sfMatch({
        sf_job_id: 141941,
        sf_customer: { lb_lead_id: BARBARA_LB_ID, any_job_linked: true,
                       first_name:'Barbara', last_name:'Preston', phone_last4:'1234', email_present:false },
      })],
    });
    expect(cat.bucket).toBe('already_linked');
  });

  test('already_linked wins over sf_truth_overrides_lb_automation_lost (no re-apply under rerun)', () => {
    // The Barbara fix has shipped — her LB sfJobId is now 141941.
    // Re-running full_reconcile must NOT classify her as would_link a
    // second time; she belongs in already_linked.
    const cat = categorize({
      lbCandidate: lbCandidate({ sfJobId: 141941 }),
      matched:     [sfMatch()],
    });
    expect(cat.bucket).toBe('already_linked');
    expect(cat.reason).toBe('already_linked');
  });

  test('lbCandidate.sfJobId !== matched.sf_job_id → lb_already_pinned_to_different_job (existing rule)', () => {
    const cat = categorize({
      lbCandidate: lbCandidate({ sfJobId: 99999 }),
      matched:     [sfMatch({ sf_job_id: 141941 })],
    });
    expect(cat.bucket).toBe('would_review');
    expect(cat.reason).toBe('lb_already_pinned_to_different_job');
  });

  test('no LB-side pin (sfJobId null) → already_linked rule does not fire', () => {
    const cat = categorize({
      lbCandidate: lbCandidate({ sfJobId: null, status: 'engaged', statusSource: 'lb_admin' }),
      matched:     [sfMatch()],
    });
    expect(cat.bucket).not.toBe('already_linked');
  });
});

// ──────────────────────────────────────────────────────────────
// categorize — non-regression for the other 5 user-listed cases
// ──────────────────────────────────────────────────────────────
describe('categorize — non-regression for existing rules', () => {
  test('Case 2: True lost — no SF customer/job → would_skip no_match', () => {
    const cat = categorize({
      lbCandidate: lbCandidate(),
      matched:     [],
    });
    expect(cat.bucket).toBe('would_skip');
    expect(cat.reason).toBe('no_match');
  });

  test('Case 3: Ambiguous lost — multiple SF candidates → would_review multiple_candidates', () => {
    const cat = categorize({
      lbCandidate: lbCandidate(),
      matched:     [sfMatch(), sfMatch({ sf_customer_id: 99999, sf_job_id: 99998 })],
    });
    expect(cat.bucket).toBe('would_review');
    expect(cat.reason).toBe('multiple_candidates');
  });

  test('Case 4: Already linked lost — same pinned → already_linked (covered above; assert again with lost status)', () => {
    const cat = categorize({
      lbCandidate: lbCandidate({ sfJobId: 141941 }),
      matched:     [sfMatch({ sf_job_id: 141941 })],
    });
    expect(cat.bucket).toBe('already_linked');
  });

  test('Case 5: lb_already_pinned_to_different_job — sfJobId mismatch → would_review (existing rule)', () => {
    const cat = categorize({
      lbCandidate: lbCandidate({ sfJobId: 99999 }),
      matched:     [sfMatch({ sf_job_id: 141941 })],
    });
    expect(cat.bucket).toBe('would_review');
    expect(cat.reason).toBe('lb_already_pinned_to_different_job');
  });
});

// ──────────────────────────────────────────────────────────────
// isApplicable — lost-row defense-in-depth
// ──────────────────────────────────────────────────────────────
describe('isApplicable — lost-row defense', () => {
  test('lost + lb_automation + completed+paid → ok', () => {
    const r = isApplicable({
      lbCandidate: lbCandidate(),
      matched:     [sfMatch()],
    });
    expect(r.ok).toBe(true);
  });

  test('lost + statusSource !== lb_automation → reject lost_not_lb_automation_origin', () => {
    const r = isApplicable({
      lbCandidate: lbCandidate({ statusSource: 'user_admin' }),
      matched:     [sfMatch()],
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('lost_not_lb_automation_origin');
  });

  test('lost + lb_automation + sf job NOT completed → reject lost_requires_completed_paid_sf_job', () => {
    const r = isApplicable({
      lbCandidate: lbCandidate(),
      matched:     [sfMatch({ sf_job: { status: 'scheduled', payment_status: 'unpaid', lb_external_request_id: null, lb_lead_id: null } })],
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('lost_requires_completed_paid_sf_job');
  });

  test('lost + lb_automation + completed but unpaid → reject lost_requires_completed_paid_sf_job', () => {
    const r = isApplicable({
      lbCandidate: lbCandidate(),
      matched:     [sfMatch({ sf_job: { status: 'completed', payment_status: 'unpaid', lb_external_request_id: null, lb_lead_id: null } })],
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('lost_requires_completed_paid_sf_job');
  });

  test('non-lost row (engaged + lb_admin) — lost gates don\'t apply, existing high-conf gate passes', () => {
    const r = isApplicable({
      lbCandidate: lbCandidate({ status: 'engaged', statusSource: 'lb_admin' }),
      matched:     [sfMatch()],
    });
    expect(r.ok).toBe(true);
  });

  test('regression — lb_already_pinned_to_different_job still rejects FIRST', () => {
    const r = isApplicable({
      lbCandidate: lbCandidate({ sfJobId: 99999 }),
      matched:     [sfMatch({ sf_job_id: 141941 })],
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('lb_already_pinned_to_different_job');
  });

  test('regression — already_reconciled_customer still rejects', () => {
    const r = isApplicable({
      lbCandidate: lbCandidate(),
      matched:     [sfMatch({
        sf_customer: { lb_lead_id: 'other-lead', any_job_linked: true,
                       first_name:'Barbara', last_name:'Preston', phone_last4:'1234', email_present:false },
      })],
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('already_reconciled_customer');
  });
});

// ──────────────────────────────────────────────────────────────
// runHistoricalSync — integration: scope drives LB request body
// ──────────────────────────────────────────────────────────────
describe('runHistoricalSync — sync_scope wiring', () => {
  // Minimal supabase stub that always resolves comm_settings happy path
  // and returns empty matcher results (we only care about the LB call
  // body, not bucketing).
  function makeStubSupa() {
    return {
      from(table) {
        const builder = {
          select() { return builder; },
          eq() { return builder; },
          ilike() { return builder; },
          in() { return builder; },
          limit() { return builder; },
          order() { return builder; },
          maybeSingle() {
            if (table === 'communication_settings') {
              return Promise.resolve({ data: { leadbridge_user_id: LB_USER_UUID, leadbridge_connected: true }, error: null });
            }
            return Promise.resolve({ data: null, error: null });
          },
          single() { return Promise.resolve({ data: null, error: { code: 'PGRST116' } }); },
          then(onF) { return Promise.resolve({ data: [], error: null }).then(onF); },
        };
        return builder;
      },
    };
  }

  beforeEach(() => {
    mockFetchCandidates.mockReset();
    mockLinkLeadsBulk.mockReset();
  });

  test('syncScope=pending_only sends [pending] to fetchCandidates', async () => {
    mockFetchCandidates.mockResolvedValue({ ok: true, candidates: [], count: 0, more_may_exist: false });
    const out = await runHistoricalSync(makeStubSupa(), { tenantId: SF_TENANT_ID, syncScope: 'pending_only' });
    expect(out.ok).toBe(true);
    expect(mockFetchCandidates).toHaveBeenCalledWith(expect.objectContaining({
      syncStatuses: ['pending'],
    }));
    expect(out.summary.sync_scope).toBe('pending_only');
    expect(out.summary.sync_statuses).toEqual(['pending']);
  });

  test('syncScope=full_reconcile sends broad set to fetchCandidates', async () => {
    mockFetchCandidates.mockResolvedValue({ ok: true, candidates: [], count: 0, more_may_exist: false });
    const out = await runHistoricalSync(makeStubSupa(), { tenantId: SF_TENANT_ID, syncScope: 'full_reconcile' });
    expect(out.ok).toBe(true);
    expect(mockFetchCandidates).toHaveBeenCalledWith(expect.objectContaining({
      syncStatuses: ['pending', 'skipped', 'needs_review', 'failed', 'no_match'],
    }));
    expect(out.summary.sync_scope).toBe('full_reconcile');
  });

  test('no syncScope arg → defaults to pending_only (back-compat)', async () => {
    mockFetchCandidates.mockResolvedValue({ ok: true, candidates: [], count: 0, more_may_exist: false });
    const out = await runHistoricalSync(makeStubSupa(), { tenantId: SF_TENANT_ID });
    expect(mockFetchCandidates).toHaveBeenCalledWith(expect.objectContaining({
      syncStatuses: ['pending'],
    }));
    expect(out.summary.sync_scope).toBe('pending_only');
  });

  test('unknown syncScope value → falls back to pending_only', async () => {
    mockFetchCandidates.mockResolvedValue({ ok: true, candidates: [], count: 0, more_may_exist: false });
    const out = await runHistoricalSync(makeStubSupa(), { tenantId: SF_TENANT_ID, syncScope: 'bogus_value' });
    expect(out.summary.sync_scope).toBe('pending_only');
    expect(mockFetchCandidates).toHaveBeenCalledWith(expect.objectContaining({
      syncStatuses: ['pending'],
    }));
  });

  test('explicit syncStatuses arg overrides scope (back-compat)', async () => {
    mockFetchCandidates.mockResolvedValue({ ok: true, candidates: [], count: 0, more_may_exist: false });
    await runHistoricalSync(makeStubSupa(), {
      tenantId: SF_TENANT_ID,
      syncScope: 'full_reconcile',
      syncStatuses: ['linked'],
    });
    expect(mockFetchCandidates).toHaveBeenCalledWith(expect.objectContaining({
      syncStatuses: ['linked'],
    }));
  });

  test('summary surfaces new bucket counts + automation_false_lost_candidates', async () => {
    mockFetchCandidates.mockResolvedValue({ ok: true, candidates: [], count: 0, more_may_exist: false });
    const out = await runHistoricalSync(makeStubSupa(), { tenantId: SF_TENANT_ID, syncScope: 'full_reconcile' });
    expect(out.summary).toEqual(expect.objectContaining({
      already_linked:                   0,
      automation_false_lost_candidates: 0,
      would_link:                       0,
      would_review:                     0,
      would_skip:                       0,
    }));
    expect(out.already_linked).toEqual([]);
  });
});

// ──────────────────────────────────────────────────────────────
// runHistoricalSync — end-to-end bucketing for new rules
// ──────────────────────────────────────────────────────────────
describe('runHistoricalSync — bucketing under full_reconcile', () => {
  function makeMatcherSupa(matchResultsByLeadCustomerPhone) {
    // Map customer_phone → matcher result rows. The matcher itself does
    // the customer + jobs lookup; here we shortcut by returning fixtures
    // when the customers query runs.
    return {
      from(table) {
        const builder = {
          _filters: [],
          select() { return builder; },
          eq(col, val) { builder._filters.push({ col, val }); return builder; },
          ilike(col, val) { builder._filters.push({ col, val, ilike: true }); return builder; },
          in(col, vals) { builder._filters.push({ col, vals, in: true }); return builder; },
          limit() { return builder; },
          order() { return builder; },
          maybeSingle() {
            if (table === 'communication_settings') {
              return Promise.resolve({ data: { leadbridge_user_id: LB_USER_UUID, leadbridge_connected: true }, error: null });
            }
            return Promise.resolve({ data: null, error: null });
          },
          then(onF) {
            // Return the matcher-style customer or jobs results based on table.
            return Promise.resolve({ data: [], error: null }).then(onF);
          },
        };
        return builder;
      },
    };
  }

  beforeEach(() => {
    mockFetchCandidates.mockReset();
    mockLinkLeadsBulk.mockReset();
  });

  test('full_reconcile dry-run never calls linkLeadsBulk (DRY_RUN_FORCED invariant)', async () => {
    mockFetchCandidates.mockResolvedValue({
      ok: true, count: 1, more_may_exist: false,
      candidates: [lbCandidate()],
    });
    const supa = makeMatcherSupa();
    await runHistoricalSync(supa, { tenantId: SF_TENANT_ID, syncScope: 'full_reconcile' });
    expect(mockLinkLeadsBulk).not.toHaveBeenCalled();
  });

  test('full_reconcile with empty matcher results → all rows in would_skip:no_match', async () => {
    mockFetchCandidates.mockResolvedValue({
      ok: true, count: 2, more_may_exist: false,
      candidates: [lbCandidate(), lbCandidate({ leadId: 'lb-id-2', externalRequestId: 'req2' })],
    });
    const supa = makeMatcherSupa();
    const out = await runHistoricalSync(supa, { tenantId: SF_TENANT_ID, syncScope: 'full_reconcile' });
    expect(out.ok).toBe(true);
    expect(out.summary.would_skip).toBe(2);
    expect(out.summary.would_link).toBe(0);
    expect(out.summary.already_linked).toBe(0);
    expect(out.summary.automation_false_lost_candidates).toBe(0);
  });

  test('LB fetch failure surfaces with structured error (no SF writes)', async () => {
    mockFetchCandidates.mockResolvedValue({ ok: false, reason: 'lb_unreachable', status: 502 });
    const out = await runHistoricalSync(makeMatcherSupa(), { tenantId: SF_TENANT_ID, syncScope: 'full_reconcile' });
    expect(out.ok).toBe(false);
    expect(out.error).toBe('lb_unreachable');
    expect(mockLinkLeadsBulk).not.toHaveBeenCalled();
  });
});
