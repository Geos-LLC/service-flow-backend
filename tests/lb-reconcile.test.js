/**
 * LB Reconcile — Phase 2/3 unit tests.
 *
 * Covers every classify-rule branch + the end-to-end orchestrator with
 * a minimal Supabase stub. The outbound-pipeline call is mocked so the
 * tests don't depend on the real lb-outbound-delivery → outbox INSERT.
 */

process.env.LEADBRIDGE_OUTBOUND_STATUS_ENABLED = 'true';
process.env.LEADBRIDGE_OUTBOUND_DRY_RUN = 'true';
process.env.SF_INTEGRATION_ENC_KEY = Buffer.alloc(32, 7).toString('base64');

const {
  mapSfToLbCanonical,
  isPipelineRegression,
  isHardTerminal,
} = require('../lib/lb-sf-canonical-map');

const {
  reconcileTenantWithLb,
  classifyJob,
  indexLbLeadsByExternalRequestId,
  reconcileEventId,
  isShadowRecurringCancellation,
  ACTIVE_LIFECYCLE_STATUSES,
} = require('../lib/lb-reconcile');

const SILENT = { log() {}, warn() {}, error() {} };

// ──────────────────────────────────────────────────────────────────
// Pure-function tests — SF → LB canonical map
// ──────────────────────────────────────────────────────────────────
describe('mapSfToLbCanonical', () => {
  test('pending / confirmed / rescheduled → scheduled', () => {
    expect(mapSfToLbCanonical('pending')).toBe('scheduled');
    expect(mapSfToLbCanonical('confirmed')).toBe('scheduled');
    expect(mapSfToLbCanonical('rescheduled')).toBe('scheduled');
  });
  test('in-progress / en-route / started → in_progress', () => {
    expect(mapSfToLbCanonical('in-progress')).toBe('in_progress');
    expect(mapSfToLbCanonical('in_progress')).toBe('in_progress');
    expect(mapSfToLbCanonical('en-route')).toBe('in_progress');
    expect(mapSfToLbCanonical('started')).toBe('in_progress');
  });
  test('completed / complete / paid / done → completed', () => {
    expect(mapSfToLbCanonical('completed')).toBe('completed');
    expect(mapSfToLbCanonical('done')).toBe('completed');
    expect(mapSfToLbCanonical('paid')).toBe('completed');
  });
  test('cancelled / canceled → cancelled', () => {
    expect(mapSfToLbCanonical('cancelled')).toBe('cancelled');
    expect(mapSfToLbCanonical('canceled')).toBe('cancelled');
  });
  test('no-show / no_show → no_show', () => {
    expect(mapSfToLbCanonical('no-show')).toBe('no_show');
    expect(mapSfToLbCanonical('no_show')).toBe('no_show');
  });
  test('null / unknown → null', () => {
    expect(mapSfToLbCanonical(null)).toBeNull();
    expect(mapSfToLbCanonical('')).toBeNull();
    expect(mapSfToLbCanonical('weird_status')).toBeNull();
  });
  test('case insensitive + trims whitespace', () => {
    expect(mapSfToLbCanonical('  CANCELLED ')).toBe('cancelled');
    expect(mapSfToLbCanonical('In-Progress')).toBe('in_progress');
  });
});

describe('isPipelineRegression', () => {
  test('strict regression on pipeline → true', () => {
    expect(isPipelineRegression('in_progress', 'scheduled')).toBe(true);
    expect(isPipelineRegression('completed', 'in_progress')).toBe(true);
  });
  test('forward or equal → false', () => {
    expect(isPipelineRegression('scheduled', 'in_progress')).toBe(false);
    expect(isPipelineRegression('scheduled', 'scheduled')).toBe(false);
  });
  test('transitions into off-pipeline terminals are not regressions', () => {
    expect(isPipelineRegression('scheduled', 'cancelled')).toBe(false);
    expect(isPipelineRegression('completed', 'lost')).toBe(false);
    expect(isPipelineRegression('in_progress', 'no_show')).toBe(false);
  });
  test('off-pipeline → on-pipeline yields false (not a regression by definition)', () => {
    expect(isPipelineRegression('cancelled', 'scheduled')).toBe(false);
  });
});

describe('isHardTerminal', () => {
  test('archived blocks all writes', () => {
    expect(isHardTerminal('archived')).toBe(true);
  });
  test('other terminals are not hard', () => {
    expect(isHardTerminal('cancelled')).toBe(false);
    expect(isHardTerminal('lost')).toBe(false);
    expect(isHardTerminal('completed')).toBe(false);
  });
});

describe('reconcileEventId', () => {
  test('deterministic format', () => {
    expect(reconcileEventId(142288, 'cancelled')).toBe('evt_reconcile_142288_cancelled');
  });
  test('same input yields same id (idempotency primitive)', () => {
    expect(reconcileEventId(1, 'scheduled')).toBe(reconcileEventId(1, 'scheduled'));
  });
});

describe('indexLbLeadsByExternalRequestId', () => {
  test('keys by externalRequestId', () => {
    const m = indexLbLeadsByExternalRequestId([
      { id: 'lb1', externalRequestId: 'EXT1', status: 'scheduled', platform: 'thumbtack' },
      { id: 'lb2', externalRequestId: 'EXT2', status: 'lost', platform: 'yelp' },
    ]);
    expect(m.size).toBe(2);
    expect(m.get('EXT1').status).toBe('scheduled');
    expect(m.get('EXT2').platform).toBe('yelp');
  });
  test('drops leads without externalRequestId', () => {
    const m = indexLbLeadsByExternalRequestId([
      { id: 'lb1' },
      { id: 'lb2', externalRequestId: null },
      { id: 'lb3', externalRequestId: 'EXT', status: 'scheduled' },
    ]);
    expect(m.size).toBe(1);
  });
  test('coerces id to string', () => {
    const m = indexLbLeadsByExternalRequestId([{ id: 'lb1', externalRequestId: 12345, status: 'scheduled' }]);
    expect(m.has('12345')).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────
// classifyJob — single-job decision branches
// ──────────────────────────────────────────────────────────────────
function makeJobsClassifyStub({ outbox = [] } = {}) {
  return {
    from(table) {
      const filter = {};
      const chain = {
        select() { return chain; },
        eq(k, v) { filter[k] = v; return chain; },
        maybeSingle() {
          if (table !== 'leadbridge_outbound_events') return Promise.resolve({ data: null, error: null });
          const row = outbox.find((r) => Object.entries(filter).every(([k, v]) => String(r[k]) === String(v)));
          return Promise.resolve({ data: row || null, error: null });
        },
      };
      return chain;
    },
  };
}

describe('classifyJob', () => {
  test('lb_lead_not_in_pull when LB index lacks the externalRequestId', async () => {
    const job = { id: 1, status: 'completed', lb_external_request_id: 'MISSING', lb_channel: 'thumbtack' };
    const out = await classifyJob(makeJobsClassifyStub(), job, new Map(), new Map(), SILENT);
    expect(out.action).toBe('skipped');
    expect(out.reason).toBe('lb_lead_not_in_pull');
  });

  test('sf_status_not_mappable when SF status is unknown', async () => {
    const job = { id: 1, status: 'frobnicated', lb_external_request_id: 'EXT', lb_channel: 'thumbtack' };
    const map = new Map([['EXT', { status: 'scheduled' }]]);
    const out = await classifyJob(makeJobsClassifyStub(), job, map, new Map(), SILENT);
    expect(out.action).toBe('skipped');
    expect(out.reason).toBe('sf_status_not_mappable');
  });

  test('already_in_sync when LB matches', async () => {
    // SF 'pending' canonicalizes to LB 'scheduled' — same as LB current → no-op.
    const job = { id: 1, status: 'pending', lb_external_request_id: 'EXT', lb_channel: 'thumbtack' };
    const map = new Map([['EXT', { status: 'scheduled' }]]);
    const out = await classifyJob(makeJobsClassifyStub(), job, map, new Map(), SILENT);
    expect(out.action).toBe('noop');
    expect(out.reason).toBe('already_in_sync');
  });

  test('lb_hard_terminal blocks push when LB is archived', async () => {
    const job = { id: 1, status: 'cancelled', lb_external_request_id: 'EXT', lb_channel: 'thumbtack' };
    const map = new Map([['EXT', { status: 'archived' }]]);
    const out = await classifyJob(makeJobsClassifyStub(), job, map, new Map(), SILENT);
    expect(out.action).toBe('skipped');
    expect(out.reason).toBe('lb_hard_terminal');
  });

  test('pipeline_regression blocks push when SF would move LB backwards', async () => {
    // LB at completed, SF says in-progress → regression.
    const job = { id: 1, status: 'in-progress', lb_external_request_id: 'EXT', lb_channel: 'thumbtack' };
    const map = new Map([['EXT', { status: 'completed' }]]);
    const out = await classifyJob(makeJobsClassifyStub(), job, map, new Map(), SILENT);
    expect(out.action).toBe('skipped');
    expect(out.reason).toBe('pipeline_regression');
  });

  test('cancelled SF → cancelled LB push allowed even from completed (not a regression)', async () => {
    const job = { id: 1, status: 'cancelled', lb_external_request_id: 'EXT', lb_channel: 'thumbtack' };
    const map = new Map([['EXT', { status: 'completed' }]]);
    const out = await classifyJob(makeJobsClassifyStub(), job, map, new Map(), SILENT);
    expect(out.action).toBe('queue');
    expect(out.reason).toBe('lifecycle_drift');
    expect(out.sf_canonical).toBe('cancelled');
  });

  test('queue when SF advances LB forward (scheduled → in_progress)', async () => {
    const job = { id: 1, status: 'started', lb_external_request_id: 'EXT', lb_channel: 'thumbtack' };
    const map = new Map([['EXT', { status: 'scheduled' }]]);
    const out = await classifyJob(makeJobsClassifyStub(), job, map, new Map(), SILENT);
    expect(out.action).toBe('queue');
    expect(out.sf_canonical).toBe('in_progress');
    expect(out.event_id).toBe('evt_reconcile_1_in_progress');
  });

  test('idempotent: prior outbox row for same (job, canonical) → noop', async () => {
    const job = { id: 1, status: 'cancelled', lb_external_request_id: 'EXT', lb_channel: 'thumbtack' };
    const map = new Map([['EXT', { status: 'scheduled' }]]);
    const supabase = makeJobsClassifyStub({
      outbox: [{ event_id: 'evt_reconcile_1_cancelled', state: 'sent', result: 'applied', terminal_at: '2026-05-25' }],
    });
    const out = await classifyJob(supabase, job, map, new Map(), SILENT);
    expect(out.action).toBe('noop');
    expect(out.reason).toBe('outbound_already_queued_or_sent');
    expect(out.existing_event_id).toBe('evt_reconcile_1_cancelled');
  });

  test('previous attempt in dlq → skipped (operator must address)', async () => {
    const job = { id: 1, status: 'cancelled', lb_external_request_id: 'EXT', lb_channel: 'thumbtack' };
    const map = new Map([['EXT', { status: 'scheduled' }]]);
    const supabase = makeJobsClassifyStub({
      outbox: [{ event_id: 'evt_reconcile_1_cancelled', state: 'dlq', result: null, terminal_at: '2026-05-25' }],
    });
    const out = await classifyJob(supabase, job, map, new Map(), SILENT);
    expect(out.action).toBe('skipped');
    expect(out.reason).toBe('previous_attempt_in_dlq');
  });
});

// ──────────────────────────────────────────────────────────────────
// End-to-end orchestrator — reconcileTenantWithLb
// ──────────────────────────────────────────────────────────────────
function makeFullStub({ jobs = [], outbox = [] } = {}) {
  const recorded = []; // captures recordOutboundIfApplicable-style writes
  return {
    recorded,
    from(table) {
      let filter = {};
      let inFilters = []; // [{col, vals}] — for .in() support
      let rangeFrom = 0;
      let rangeTo = 9999;
      const chain = {
        select() { return chain; },
        eq(k, v) { filter[k] = v; return chain; },
        in(k, vals) {
          // Used by fetchPeerJobsByCustomer's .in('customer_id', [...])
          inFilters.push({ col: k, vals: vals.map((v) => String(v)) });
          return chain;
        },
        not(k, op, v) {
          // Used for `.not('lb_external_request_id', 'is', null)`
          filter[`__not_${k}`] = { op, v };
          return chain;
        },
        range(a, b) { rangeFrom = a; rangeTo = b; return chain; },
        maybeSingle() {
          if (table === 'leadbridge_outbound_events') {
            const row = outbox.find((r) => Object.entries(filter)
              .filter(([k]) => !k.startsWith('__'))
              .every(([k, v]) => String(r[k]) === String(v)));
            return Promise.resolve({ data: row || null, error: null });
          }
          return Promise.resolve({ data: null, error: null });
        },
        then(resolve) {
          if (table === 'jobs') {
            const rows = jobs.filter((r) => {
              for (const [k, v] of Object.entries(filter)) {
                if (k.startsWith('__not_')) {
                  const col = k.slice('__not_'.length);
                  if (r[col] == null) return false;
                  continue;
                }
                if (String(r[k]) !== String(v)) return false;
              }
              for (const f of inFilters) {
                if (!f.vals.includes(String(r[f.col]))) return false;
              }
              return true;
            }).slice(rangeFrom, rangeTo + 1);
            resolve({ data: rows, error: null });
            return;
          }
          resolve({ data: [], error: null });
        },
      };
      return chain;
    },
  };
}

describe('reconcileTenantWithLb — orchestrator', () => {
  test('empty pull + no linked jobs → empty summary', async () => {
    const supabase = makeFullStub();
    const out = await reconcileTenantWithLb(supabase, 2, [], { dryRun: true, logger: SILENT });
    expect(out.summary.jobs_evaluated).toBe(0);
    expect(out.summary.statuses_pushed).toBe(0);
    expect(out.plan).toHaveLength(0);
  });

  test('dryRun=true does NOT call recordOutboundIfApplicable but still plans', async () => {
    const supabase = makeFullStub({
      jobs: [
        { id: 1, user_id: 2, status: 'cancelled', lb_external_request_id: 'EXT', lb_channel: 'thumbtack' },
      ],
    });
    const lbLeads = [{ id: 'lb1', externalRequestId: 'EXT', status: 'scheduled' }];
    const out = await reconcileTenantWithLb(supabase, 2, lbLeads, { dryRun: true, logger: SILENT });
    expect(out.summary.jobs_evaluated).toBe(1);
    expect(out.summary.lifecycle_drift).toBe(1);
    expect(out.summary.statuses_pushed).toBe(0);
    expect(out.plan[0].action).toBe('queue');
  });

  test('idempotency: prior outbox row for same (job, canonical) collapses to noop', async () => {
    const supabase = makeFullStub({
      jobs: [
        { id: 1, user_id: 2, status: 'cancelled', lb_external_request_id: 'EXT', lb_channel: 'thumbtack' },
      ],
      outbox: [{ event_id: 'evt_reconcile_1_cancelled', state: 'sent', result: 'applied' }],
    });
    const lbLeads = [{ id: 'lb1', externalRequestId: 'EXT', status: 'scheduled' }];
    const out = await reconcileTenantWithLb(supabase, 2, lbLeads, { dryRun: true, logger: SILENT });
    expect(out.summary.already_in_sync).toBe(1);
    expect(out.summary.lifecycle_drift).toBe(0);
    expect(out.plan[0].action).toBe('noop');
  });

  test('cross-tenant: jobs query filters by user_id (other tenants never leak)', async () => {
    const supabase = makeFullStub({
      jobs: [
        { id: 1, user_id: 2, status: 'cancelled', lb_external_request_id: 'EXT', lb_channel: 'thumbtack' },
        { id: 2, user_id: 9, status: 'cancelled', lb_external_request_id: 'EXT', lb_channel: 'thumbtack' },
      ],
    });
    const lbLeads = [{ id: 'lb1', externalRequestId: 'EXT', status: 'scheduled' }];
    const out = await reconcileTenantWithLb(supabase, 2, lbLeads, { dryRun: true, logger: SILENT });
    expect(out.summary.jobs_evaluated).toBe(1);  // job 2 (user 9) is excluded
    expect(out.plan[0].job_id).toBe(1);
  });

  test('all status transitions: scheduled → cancelled / completed / in_progress queues; same-state no-ops', async () => {
    const supabase = makeFullStub({
      jobs: [
        { id: 1, user_id: 2, status: 'cancelled',   lb_external_request_id: 'A', lb_channel: 'thumbtack' },
        { id: 2, user_id: 2, status: 'completed',   lb_external_request_id: 'B', lb_channel: 'thumbtack' },
        { id: 3, user_id: 2, status: 'in-progress', lb_external_request_id: 'C', lb_channel: 'yelp' },
        { id: 4, user_id: 2, status: 'pending',     lb_external_request_id: 'D', lb_channel: 'yelp' },
      ],
    });
    const lbLeads = [
      { id: 'lbA', externalRequestId: 'A', status: 'scheduled' },
      { id: 'lbB', externalRequestId: 'B', status: 'in_progress' },
      { id: 'lbC', externalRequestId: 'C', status: 'scheduled' },
      { id: 'lbD', externalRequestId: 'D', status: 'scheduled' },     // SF pending → scheduled, already in sync
    ];
    const out = await reconcileTenantWithLb(supabase, 2, lbLeads, { dryRun: true, logger: SILENT });
    expect(out.summary.jobs_evaluated).toBe(4);
    expect(out.summary.lifecycle_drift).toBe(3);
    expect(out.summary.already_in_sync).toBe(1);
    const byJob = Object.fromEntries(out.plan.map((p) => [p.job_id, p]));
    expect(byJob[1].sf_canonical).toBe('cancelled');
    expect(byJob[2].sf_canonical).toBe('completed');
    expect(byJob[3].sf_canonical).toBe('in_progress');
    expect(byJob[4].action).toBe('noop');
  });

  test('hard terminal + regression branches counted separately', async () => {
    const supabase = makeFullStub({
      jobs: [
        { id: 1, user_id: 2, status: 'cancelled',   lb_external_request_id: 'A', lb_channel: 'thumbtack' },  // LB archived → blocked
        { id: 2, user_id: 2, status: 'in-progress', lb_external_request_id: 'B', lb_channel: 'thumbtack' },  // LB completed → regression
      ],
    });
    const lbLeads = [
      { id: 'lbA', externalRequestId: 'A', status: 'archived' },
      { id: 'lbB', externalRequestId: 'B', status: 'completed' },
    ];
    const out = await reconcileTenantWithLb(supabase, 2, lbLeads, { dryRun: true, logger: SILENT });
    expect(out.summary.skipped_hard_terminal).toBe(1);
    expect(out.summary.skipped_regression).toBe(1);
    expect(out.summary.statuses_pushed).toBe(0);
    expect(out.summary.lifecycle_drift).toBe(0);
  });

  test('lb_lead_not_in_pull when SF job references an ext id absent from the pull', async () => {
    const supabase = makeFullStub({
      jobs: [
        { id: 1, user_id: 2, status: 'cancelled', lb_external_request_id: 'EXT-MISSING', lb_channel: 'thumbtack' },
      ],
    });
    const out = await reconcileTenantWithLb(supabase, 2, [], { dryRun: true, logger: SILENT });
    expect(out.summary.skipped_no_lb_lead).toBe(1);
  });
});

// ──────────────────────────────────────────────────────────────────
// Cross-domain semantic view (post-refactor model).
// LB acquisition lifecycle and SF/ZB operational lifecycle are
// independent. Differences between them are NOT synchronization
// failures — they're cross-domain differences. The reconcile summary
// now exposes that under additive keys.
// ──────────────────────────────────────────────────────────────────
describe('reconcileTenantWithLb — cross-domain semantics', () => {
  test('summary exposes cross_domain_difference + not_applicable_to_lb (additive keys)', async () => {
    const supabase = makeFullStub();
    const out = await reconcileTenantWithLb(supabase, 2, [], { dryRun: true, logger: SILENT });
    expect(out.summary).toHaveProperty('cross_domain_difference');
    expect(out.summary).toHaveProperty('not_applicable_to_lb');
    expect(typeof out.summary.cross_domain_difference).toBe('number');
    expect(typeof out.summary.not_applicable_to_lb).toBe('number');
  });

  test('SF.cancelled vs LB.scheduled → counted under cross_domain_difference, NOT a failure', async () => {
    // SF cancelled the job; LB still thinks the lead is scheduled.
    // Legitimate cross-domain difference (SF ahead), pushed forward.
    const supabase = makeFullStub({
      jobs: [
        { id: 1, user_id: 2, status: 'cancelled', lb_external_request_id: 'EXT', lb_channel: 'thumbtack' },
      ],
    });
    const lbLeads = [{ id: 'lb1', externalRequestId: 'EXT', status: 'scheduled' }];
    const out = await reconcileTenantWithLb(supabase, 2, lbLeads, { dryRun: true, logger: SILENT });
    expect(out.summary.cross_domain_difference).toBe(1);
    expect(out.summary.failures).toBe(0);
    // Legacy key preserved for backwards compat
    expect(out.summary.lifecycle_drift).toBe(1);
  });

  test('SF.scheduled vs LB.completed → cross_domain_difference, not failure (LB ahead of SF)', async () => {
    // The "marketplace-only completed" case: LB marked the lead completed
    // (Thumbtack auto-close, prior pro outbound, or marketplace
    // operations) but the SF operational job is still scheduled. This
    // must NOT be reported as drift or failure — both states are valid
    // in their own domains.
    const supabase = makeFullStub({
      jobs: [
        { id: 5, user_id: 2, status: 'pending', lb_external_request_id: 'EXT-FUTURE', lb_channel: 'thumbtack' },
      ],
    });
    // SF 'pending' maps to canonical 'scheduled'. LB says 'completed' (LB ahead).
    const lbLeads = [{ id: 'lbF', externalRequestId: 'EXT-FUTURE', status: 'completed' }];
    const out = await reconcileTenantWithLb(supabase, 2, lbLeads, { dryRun: true, logger: SILENT });
    expect(out.summary.failures).toBe(0);
    expect(out.summary.cross_domain_difference).toBeGreaterThanOrEqual(1);
    // Internally this is a pipeline_regression (SF would push backwards);
    // the legacy key is preserved.
    expect(out.summary.skipped_regression).toBe(1);
    expect(out.plan[0].action).toBe('skipped');
  });

  test('cross_domain_difference equals legacy lifecycle_drift + skipped_regression', async () => {
    // Mix: 1 SF-ahead (lifecycle_drift) + 1 LB-ahead (pipeline_regression).
    const supabase = makeFullStub({
      jobs: [
        { id: 1, user_id: 2, status: 'cancelled',   lb_external_request_id: 'A', lb_channel: 'thumbtack' },
        { id: 2, user_id: 2, status: 'in-progress', lb_external_request_id: 'B', lb_channel: 'thumbtack' },
      ],
    });
    const lbLeads = [
      { id: 'lbA', externalRequestId: 'A', status: 'scheduled' },   // SF-ahead → lifecycle_drift
      { id: 'lbB', externalRequestId: 'B', status: 'completed' },   // LB-ahead → pipeline_regression
    ];
    const out = await reconcileTenantWithLb(supabase, 2, lbLeads, { dryRun: true, logger: SILENT });
    expect(out.summary.cross_domain_difference).toBe(
      (out.summary.lifecycle_drift || 0) + (out.summary.skipped_regression || 0)
    );
    expect(out.summary.cross_domain_difference).toBe(2);
    expect(out.summary.failures).toBe(0);
  });

  test('not_applicable_to_lb is the renamed skipped_unsupported (additive)', async () => {
    // SF status with no LB canonical mapping. Counted under both names.
    const supabase = makeFullStub({
      jobs: [
        { id: 1, user_id: 2, status: 'weird_unknown_status', lb_external_request_id: 'EXT', lb_channel: 'thumbtack' },
      ],
    });
    const lbLeads = [{ id: 'lb1', externalRequestId: 'EXT', status: 'scheduled' }];
    const out = await reconcileTenantWithLb(supabase, 2, lbLeads, { dryRun: true, logger: SILENT });
    expect(out.summary.not_applicable_to_lb).toBe(1);
    expect(out.summary.skipped_unsupported).toBe(1);
    expect(out.summary.failures).toBe(0);
  });
});

// ──────────────────────────────────────────────────────────────────
// Shadow-recurring-cancellation guard.
//
// Root cause being fixed: lib/lb-reconcile.js previously classified each
// LB-stamped job independently. A cancelled recurring/future-appointment
// could push `cancelled` to LB even when the same customer already had a
// completed job, downgrading a converted lead from `completed` to
// `cancelled` on the LB side.
//
// The guard suppresses such pushes via two tiers:
//   Tier 1 (strong): any completed peer on the same customer
//   Tier 2 (medium): an active peer scheduled AFTER this cancellation
//
// Cancelled-only customers continue to push as before.
// ──────────────────────────────────────────────────────────────────

describe('isShadowRecurringCancellation — predicate (pure)', () => {
  test('non-cancelled job → never suppressed', () => {
    const job = { id: 1, status: 'completed', customer_id: 10 };
    const peers = [{ id: 2, status: 'cancelled' }];
    expect(isShadowRecurringCancellation(job, peers).suppress).toBe(false);
  });

  test('empty peers → never suppressed', () => {
    const job = { id: 1, status: 'cancelled', customer_id: 10 };
    expect(isShadowRecurringCancellation(job, []).suppress).toBe(false);
    expect(isShadowRecurringCancellation(job, null).suppress).toBe(false);
  });

  test('Tier 1 fires when any completed peer exists', () => {
    const job = { id: 1, status: 'cancelled', customer_id: 10 };
    const peers = [
      { id: 2, status: 'cancelled' },
      { id: 3, status: 'completed' },
    ];
    const r = isShadowRecurringCancellation(job, peers);
    expect(r.suppress).toBe(true);
    expect(r.tier).toBe('strong_has_completed_peer');
    expect(r.peer_job_ids).toEqual([3]);
  });

  test('Tier 1 fires regardless of date ordering', () => {
    // Completed peer scheduled BEFORE the cancellation — still suppresses.
    const job = { id: 1, status: 'cancelled', customer_id: 10,
      last_status_changed_at: '2026-05-26T20:00:00Z' };
    const peers = [{ id: 2, status: 'completed', scheduled_date: '2026-02-01' }];
    expect(isShadowRecurringCancellation(job, peers).tier).toBe('strong_has_completed_peer');
  });

  test('Tier 2 fires when active peer is scheduled AFTER cancellation', () => {
    const job = { id: 1, status: 'cancelled', customer_id: 10,
      last_status_changed_at: '2026-05-26T20:00:00Z' };
    const peers = [
      { id: 2, status: 'cancelled' },
      { id: 3, status: 'scheduled', scheduled_date: '2026-08-01T10:00:00Z' },
    ];
    const r = isShadowRecurringCancellation(job, peers);
    expect(r.suppress).toBe(true);
    expect(r.tier).toBe('medium_has_newer_active_peer');
    expect(r.peer_job_ids).toEqual([3]);
  });

  test('Tier 2 does NOT fire when active peer is scheduled BEFORE cancellation', () => {
    const job = { id: 1, status: 'cancelled', customer_id: 10,
      last_status_changed_at: '2026-05-26T20:00:00Z' };
    const peers = [
      { id: 2, status: 'cancelled' },
      { id: 3, status: 'scheduled', scheduled_date: '2026-03-01' },  // before
    ];
    expect(isShadowRecurringCancellation(job, peers).suppress).toBe(false);
  });

  test('Tier 2 honors all active statuses (booked / in_progress / confirmed)', () => {
    const base = { id: 1, status: 'cancelled', customer_id: 10,
      last_status_changed_at: '2026-01-01T00:00:00Z' };
    for (const peerStatus of [...ACTIVE_LIFECYCLE_STATUSES]) {
      const peers = [{ id: 2, status: peerStatus, scheduled_date: '2026-06-01' }];
      const r = isShadowRecurringCancellation(base, peers);
      expect(r.suppress).toBe(true);
      expect(r.tier).toBe('medium_has_newer_active_peer');
    }
  });

  test('cancelled-only customer (no completed/active peers) → NOT suppressed', () => {
    const job = { id: 1, status: 'cancelled', customer_id: 10,
      last_status_changed_at: '2026-05-26T20:00:00Z' };
    const peers = [{ id: 2, status: 'cancelled' }];
    expect(isShadowRecurringCancellation(job, peers).suppress).toBe(false);
  });

  test('Tier 1 takes precedence over Tier 2 (completed is stronger)', () => {
    const job = { id: 1, status: 'cancelled', customer_id: 10,
      last_status_changed_at: '2026-05-26T20:00:00Z' };
    const peers = [
      { id: 2, status: 'completed' },
      { id: 3, status: 'scheduled', scheduled_date: '2026-08-01' },
    ];
    const r = isShadowRecurringCancellation(job, peers);
    expect(r.tier).toBe('strong_has_completed_peer');
    expect(r.peer_job_ids).toEqual([2]);
  });

  test('falls back to created_at when last_status_changed_at is missing', () => {
    const job = { id: 1, status: 'cancelled', customer_id: 10,
      last_status_changed_at: null, created_at: '2026-05-01' };
    const peers = [{ id: 2, status: 'scheduled', scheduled_date: '2026-08-01' }];
    expect(isShadowRecurringCancellation(job, peers).tier).toBe('medium_has_newer_active_peer');
  });

  test('no comparable reference timestamp → returns false (defensive)', () => {
    const job = { id: 1, status: 'cancelled', customer_id: 10,
      last_status_changed_at: null, created_at: null };
    const peers = [{ id: 2, status: 'scheduled', scheduled_date: '2026-08-01' }];
    expect(isShadowRecurringCancellation(job, peers).suppress).toBe(false);
  });

  test('peer with null scheduled_date is ignored in Tier 2', () => {
    const job = { id: 1, status: 'cancelled', customer_id: 10,
      last_status_changed_at: '2026-05-26' };
    const peers = [{ id: 2, status: 'scheduled', scheduled_date: null }];
    expect(isShadowRecurringCancellation(job, peers).suppress).toBe(false);
  });
});

describe('classifyJob — shadow_recurring_cancellation integration', () => {
  // Required: the 6 specified scenarios + a coverage case for telemetry shape.
  // Each test builds its own peerJobsByCust map directly and passes it in.

  const lbScheduledMap = new Map([['EXT', { lb_id: 'lb1', status: 'scheduled' }]]);
  const lbCompletedMap = new Map([['EXT', { lb_id: 'lb1', status: 'completed' }]]);

  test('(1) cancelled job + completed peer → skipped, tier=strong_has_completed_peer', async () => {
    const job = { id: 100, status: 'cancelled', customer_id: 50,
      lb_external_request_id: 'EXT', lb_channel: 'thumbtack',
      last_status_changed_at: '2026-05-26T20:00:00Z' };
    const peers = new Map([[50, [
      { id: 100, status: 'cancelled' },
      { id: 101, status: 'completed', payment_status: 'paid' },
    ]]]);
    const out = await classifyJob(makeJobsClassifyStub(), job, lbScheduledMap, peers, SILENT);
    expect(out.action).toBe('skipped');
    expect(out.reason).toBe('shadow_recurring_cancellation');
    expect(out.suppression_tier).toBe('strong_has_completed_peer');
    expect(out.peer_job_ids).toEqual([101]);
    // Telemetry fields all present
    expect(out.customer_id).toBe(50);
    expect(out.lb_lead_id).toBe('lb1');
    expect(out.lb_external_request_id).toBe('EXT');
  });

  test('(2) cancelled job + active peer scheduled AFTER cancellation → skipped, tier=medium_has_newer_active_peer', async () => {
    const job = { id: 200, status: 'cancelled', customer_id: 60,
      lb_external_request_id: 'EXT', lb_channel: 'thumbtack',
      last_status_changed_at: '2026-05-26T20:00:00Z' };
    const peers = new Map([[60, [
      { id: 200, status: 'cancelled' },
      { id: 201, status: 'scheduled', scheduled_date: '2026-08-01' },
    ]]]);
    const out = await classifyJob(makeJobsClassifyStub(), job, lbScheduledMap, peers, SILENT);
    expect(out.action).toBe('skipped');
    expect(out.reason).toBe('shadow_recurring_cancellation');
    expect(out.suppression_tier).toBe('medium_has_newer_active_peer');
    expect(out.peer_job_ids).toEqual([201]);
  });

  test('(3) cancelled job + active peer scheduled BEFORE cancellation → NOT skipped by new guard', async () => {
    const job = { id: 300, status: 'cancelled', customer_id: 70,
      lb_external_request_id: 'EXT', lb_channel: 'thumbtack',
      last_status_changed_at: '2026-05-26T20:00:00Z' };
    const peers = new Map([[70, [
      { id: 300, status: 'cancelled' },
      { id: 301, status: 'scheduled', scheduled_date: '2026-03-01' },  // before
    ]]]);
    const out = await classifyJob(makeJobsClassifyStub(), job, lbScheduledMap, peers, SILENT);
    // Existing path: SF cancelled vs LB scheduled → queue/lifecycle_drift
    expect(out.reason).not.toBe('shadow_recurring_cancellation');
    expect(out.action).toBe('queue');
  });

  test('(4) cancelled job + only cancelled peers → NOT skipped by new guard', async () => {
    const job = { id: 400, status: 'cancelled', customer_id: 80,
      lb_external_request_id: 'EXT', lb_channel: 'thumbtack',
      last_status_changed_at: '2026-05-26T20:00:00Z' };
    const peers = new Map([[80, [
      { id: 400, status: 'cancelled' },
      { id: 401, status: 'cancelled' },
    ]]]);
    const out = await classifyJob(makeJobsClassifyStub(), job, lbScheduledMap, peers, SILENT);
    expect(out.reason).not.toBe('shadow_recurring_cancellation');
    expect(out.action).toBe('queue');
  });

  test('(5) completed job path is unchanged — guard never inspects non-cancelled jobs', async () => {
    const job = { id: 500, status: 'completed', customer_id: 90,
      lb_external_request_id: 'EXT', lb_channel: 'thumbtack',
      last_status_changed_at: '2026-05-26T20:00:00Z' };
    // Even with a "shadowing" peer, completed jobs always push
    const peers = new Map([[90, [
      { id: 500, status: 'completed' },
      { id: 501, status: 'completed' },
    ]]]);
    const out = await classifyJob(makeJobsClassifyStub(), job, lbScheduledMap, peers, SILENT);
    expect(out.action).toBe('queue');
    expect(out.sf_canonical).toBe('completed');
    expect(out.reason).toBe('lifecycle_drift');
  });

  test('(6) historical 8-conflict shape (Julia Planck) → skipped, tier=strong_has_completed_peer', async () => {
    // Reproduces the exact shape of the 8 production conflicts:
    //   sf_job 139558: cancelled, future-scheduled, lb_external_request_id set,
    //                  last status change on 2026-05-11
    //   sf_job 139806: completed+paid, lb_external_request_id NULL (pre-Strategy-4)
    // Without the fix, the 2026-05-26 LB Reconcile pushed cancelled and
    // downgraded LB.status from completed → cancelled.
    const job = {
      id: 139558, status: 'cancelled', customer_id: 23362,
      lb_external_request_id: '573157186885943325', lb_channel: 'thumbtack',
      scheduled_date: '2026-07-03',
      last_status_changed_at: '2026-05-11T19:58:56Z',
    };
    const peers = new Map([[23362, [
      { id: 139558, status: 'cancelled', scheduled_date: '2026-07-03' },
      { id: 139806, status: 'completed', payment_status: 'paid',
        scheduled_date: '2026-04-03' },
      // The other recurring jobs that exist for this customer; doesn't matter
      { id: 139999, status: 'completed', payment_status: 'paid' },
    ]]]);
    const lbCompletedThenCancelled = new Map([
      ['573157186885943325', { lb_id: '06acf8c8-a6f8-4beb-aa2d-5bb25c0c5edf', status: 'completed' }],
    ]);
    const out = await classifyJob(makeJobsClassifyStub(), job, lbCompletedThenCancelled, peers, SILENT);
    expect(out.action).toBe('skipped');
    expect(out.reason).toBe('shadow_recurring_cancellation');
    expect(out.suppression_tier).toBe('strong_has_completed_peer');
    expect(out.peer_job_ids).toEqual(expect.arrayContaining([139806, 139999]));
    expect(out.lb_lead_id).toBe('06acf8c8-a6f8-4beb-aa2d-5bb25c0c5edf');
    expect(out.lb_external_request_id).toBe('573157186885943325');
    expect(out.customer_id).toBe(23362);
  });

  test('coverage: missing peerJobsByCust map → guard is inert, no false suppression', async () => {
    // Defensive: if peer-load failed and the map is empty, the guard
    // must not fire and the existing classification path takes over.
    const job = { id: 600, status: 'cancelled', customer_id: 95,
      lb_external_request_id: 'EXT', lb_channel: 'thumbtack' };
    const out = await classifyJob(makeJobsClassifyStub(), job, lbScheduledMap, new Map(), SILENT);
    expect(out.reason).not.toBe('shadow_recurring_cancellation');
    expect(out.action).toBe('queue');
  });
});

describe('reconcileTenantWithLb — shadow_recurring_cancellation orchestration', () => {
  test('end-to-end: cancelled + completed peer → skipped, summary counter increments', async () => {
    const supabase = makeFullStub({
      jobs: [
        // The cancelled stamped job (would have been pushed pre-fix)
        { id: 100, user_id: 2, customer_id: 50, status: 'cancelled',
          lb_external_request_id: 'EXT', lb_channel: 'thumbtack',
          last_status_changed_at: '2026-05-26T20:00:00Z' },
        // The completed peer (not stamped — that's the bug pattern)
        { id: 101, user_id: 2, customer_id: 50, status: 'completed',
          payment_status: 'paid', lb_external_request_id: null,
          scheduled_date: '2026-04-01' },
      ],
    });
    const lbLeads = [{ id: 'lb1', externalRequestId: 'EXT', status: 'completed' }];
    const out = await reconcileTenantWithLb(supabase, 2, lbLeads, { dryRun: true, logger: SILENT });

    expect(out.summary.jobs_evaluated).toBe(1);                     // only stamped jobs land in linkedJobs
    expect(out.summary.skipped_shadow_recurring_cancellation).toBe(1);
    expect(out.summary.statuses_pushed).toBe(0);
    expect(out.summary.lifecycle_drift).toBe(0);
    expect(out.plan[0].action).toBe('skipped');
    expect(out.plan[0].reason).toBe('shadow_recurring_cancellation');
    expect(out.plan[0].suppression_tier).toBe('strong_has_completed_peer');
    expect(out.plan[0].peer_job_ids).toEqual([101]);
  });

  test('end-to-end: only cancelled stamped, no completed peer → still pushes (cancelled-only customer)', async () => {
    const supabase = makeFullStub({
      jobs: [
        { id: 700, user_id: 2, customer_id: 55, status: 'cancelled',
          lb_external_request_id: 'EXT', lb_channel: 'thumbtack' },
      ],
    });
    const lbLeads = [{ id: 'lb1', externalRequestId: 'EXT', status: 'scheduled' }];
    const out = await reconcileTenantWithLb(supabase, 2, lbLeads, { dryRun: true, logger: SILENT });
    expect(out.summary.skipped_shadow_recurring_cancellation).toBe(0);
    expect(out.summary.lifecycle_drift).toBe(1);
    expect(out.plan[0].action).toBe('queue');
  });

  test('end-to-end: log telemetry for suppressions includes customer + peer + lb identifiers', async () => {
    const messages = [];
    const captureLogger = { log: (m) => messages.push(m), warn() {}, error() {} };
    const supabase = makeFullStub({
      jobs: [
        { id: 800, user_id: 2, customer_id: 60, status: 'cancelled',
          lb_external_request_id: 'EXT-T', lb_channel: 'thumbtack',
          last_status_changed_at: '2026-05-26T20:00:00Z' },
        { id: 801, user_id: 2, customer_id: 60, status: 'completed',
          payment_status: 'paid', scheduled_date: '2026-04-01' },
      ],
    });
    const lbLeads = [{ id: 'lb-t', externalRequestId: 'EXT-T', status: 'completed' }];
    await reconcileTenantWithLb(supabase, 2, lbLeads, { dryRun: true, logger: captureLogger });
    const tel = messages.find((m) => m.includes('reason=shadow_recurring_cancellation'));
    expect(tel).toBeDefined();
    expect(tel).toContain('tier=strong_has_completed_peer');
    expect(tel).toContain('job=800');
    expect(tel).toContain('customer=60');
    expect(tel).toContain('lb_lead=lb-t');
    expect(tel).toContain('ext_req=EXT-T');
    expect(tel).toContain('peer_jobs=[801]');
  });
});
