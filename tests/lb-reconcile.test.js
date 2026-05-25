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
    const out = await classifyJob(makeJobsClassifyStub(), job, new Map(), SILENT);
    expect(out.action).toBe('skipped');
    expect(out.reason).toBe('lb_lead_not_in_pull');
  });

  test('sf_status_not_mappable when SF status is unknown', async () => {
    const job = { id: 1, status: 'frobnicated', lb_external_request_id: 'EXT', lb_channel: 'thumbtack' };
    const map = new Map([['EXT', { status: 'scheduled' }]]);
    const out = await classifyJob(makeJobsClassifyStub(), job, map, SILENT);
    expect(out.action).toBe('skipped');
    expect(out.reason).toBe('sf_status_not_mappable');
  });

  test('already_in_sync when LB matches', async () => {
    // SF 'pending' canonicalizes to LB 'scheduled' — same as LB current → no-op.
    const job = { id: 1, status: 'pending', lb_external_request_id: 'EXT', lb_channel: 'thumbtack' };
    const map = new Map([['EXT', { status: 'scheduled' }]]);
    const out = await classifyJob(makeJobsClassifyStub(), job, map, SILENT);
    expect(out.action).toBe('noop');
    expect(out.reason).toBe('already_in_sync');
  });

  test('lb_hard_terminal blocks push when LB is archived', async () => {
    const job = { id: 1, status: 'cancelled', lb_external_request_id: 'EXT', lb_channel: 'thumbtack' };
    const map = new Map([['EXT', { status: 'archived' }]]);
    const out = await classifyJob(makeJobsClassifyStub(), job, map, SILENT);
    expect(out.action).toBe('skipped');
    expect(out.reason).toBe('lb_hard_terminal');
  });

  test('pipeline_regression blocks push when SF would move LB backwards', async () => {
    // LB at completed, SF says in-progress → regression.
    const job = { id: 1, status: 'in-progress', lb_external_request_id: 'EXT', lb_channel: 'thumbtack' };
    const map = new Map([['EXT', { status: 'completed' }]]);
    const out = await classifyJob(makeJobsClassifyStub(), job, map, SILENT);
    expect(out.action).toBe('skipped');
    expect(out.reason).toBe('pipeline_regression');
  });

  test('cancelled SF → cancelled LB push allowed even from completed (not a regression)', async () => {
    const job = { id: 1, status: 'cancelled', lb_external_request_id: 'EXT', lb_channel: 'thumbtack' };
    const map = new Map([['EXT', { status: 'completed' }]]);
    const out = await classifyJob(makeJobsClassifyStub(), job, map, SILENT);
    expect(out.action).toBe('queue');
    expect(out.reason).toBe('lifecycle_drift');
    expect(out.sf_canonical).toBe('cancelled');
  });

  test('queue when SF advances LB forward (scheduled → in_progress)', async () => {
    const job = { id: 1, status: 'started', lb_external_request_id: 'EXT', lb_channel: 'thumbtack' };
    const map = new Map([['EXT', { status: 'scheduled' }]]);
    const out = await classifyJob(makeJobsClassifyStub(), job, map, SILENT);
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
    const out = await classifyJob(supabase, job, map, SILENT);
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
    const out = await classifyJob(supabase, job, map, SILENT);
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
      let rangeFrom = 0;
      let rangeTo = 9999;
      const chain = {
        select() { return chain; },
        eq(k, v) { filter[k] = v; return chain; },
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
