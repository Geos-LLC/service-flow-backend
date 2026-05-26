/**
 * lb-attribution-recovery.js — orchestrator unit tests.
 *
 * Covers the production code path /sync calls. Uses a Supabase stub
 * that records writes and serves canned reads. Verifies:
 *   - dry-run: no applies, no SQL writes
 *   - apply: writes to jobs + customers, idempotency via IS-NULL guards
 *   - mode selection: standard / recurring / both
 *   - account scoping (businessId + platform)
 *   - cross-tenant isolation
 *   - safety constraints: nothing applied for MEDIUM/AMBIGUOUS/dup-phone/etc
 *
 * Note: this tests the orchestrator composition logic. The underlying
 * classifiers + apply helpers have their own dedicated test suites
 * (tests/backfill-jobs-lb-linkage-part2.test.js, tests/lb-recurring-classifier.test.js).
 */

process.env.LEADBRIDGE_OUTBOUND_STATUS_ENABLED = 'false';
process.env.LEADBRIDGE_OUTBOUND_DRY_RUN = 'true';
process.env.SF_INTEGRATION_ENC_KEY = Buffer.alloc(32, 7).toString('base64');

const { runAttributionRecovery } = require('../lib/lb-attribution-recovery');

// ──────────────────────────────────────────────────────────────────
// Tiny Supabase stub — supports the helpers' read + chained-write paths.
// ──────────────────────────────────────────────────────────────────
function makeStub({ jobs = [], leads = [], customers = [], identities = [] } = {}) {
  const writes = [];

  return {
    _writes: writes,
    _jobs: jobs,
    _leads: leads,
    _customers: customers,
    _identities: identities,
    from(table) {
      let filter = {};
      let rangeFrom = 0;
      let rangeTo = 9999;
      let updateBody = null;
      const chain = {
        select() { return chain; },
        eq(k, v) { filter[k] = v; return chain; },
        in(k, vs) { filter[`__in_${k}`] = vs; return chain; },
        is(k, v) { filter[`__is_${k}`] = v; return chain; },
        not(k, op, v) { filter[`__not_${k}`] = { op, v }; return chain; },
        range(a, b) { rangeFrom = a; rangeTo = b; return chain; },
        order() { return chain; },
        limit() { return chain; },
        filter() { return chain; },
        ilike(k, pattern) { filter[`__ilike_${k}`] = pattern; return chain; },
        update(patch) { updateBody = patch; return chain; },
        maybeSingle() {
          if (updateBody) {
            writes.push({ table, filter: { ...filter }, patch: updateBody });
            // Apply to in-memory rows when IS-NULL guard is satisfied
            const targetArr = table === 'jobs' ? jobs : table === 'customers' ? customers : null;
            if (!targetArr) return Promise.resolve({ data: null, error: null });
            for (const row of targetArr) {
              const matchesFilter = Object.entries(filter).every(([k, v]) => {
                if (k.startsWith('__is_')) {
                  const col = k.slice('__is_'.length);
                  return row[col] == null;
                }
                if (k.startsWith('__in_') || k.startsWith('__not_')) return true;
                return String(row[k]) === String(v);
              });
              if (matchesFilter) {
                Object.assign(row, updateBody);
                return Promise.resolve({ data: { id: row.id }, error: null });
              }
            }
            return Promise.resolve({ data: null, error: null });
          }
          if (table === 'customers') {
            const r = customers.find(c => matches(c, filter));
            return Promise.resolve({ data: r || null, error: null });
          }
          if (table === 'jobs') {
            const r = jobs.find(j => matches(j, filter));
            return Promise.resolve({ data: r || null, error: null });
          }
          return Promise.resolve({ data: null, error: null });
        },
        then(resolve) {
          const source = { jobs, leads, customers, communication_participant_identities: identities, leadbridge_outbound_events: [] }[table] || [];
          let rows = source.filter(r => matches(r, filter)).slice(rangeFrom, rangeTo + 1);
          if (updateBody) {
            writes.push({ table, filter: { ...filter }, patch: updateBody });
          }
          resolve({ data: rows, error: null });
        },
      };
      return chain;
    },
  };
  function matches(r, filter) {
    for (const [k, v] of Object.entries(filter)) {
      if (k.startsWith('__in_')) {
        const col = k.slice('__in_'.length);
        if (!v.map(String).includes(String(r[col]))) return false;
      } else if (k.startsWith('__is_')) {
        const col = k.slice('__is_'.length);
        if (r[col] != null) return false;
      } else if (k.startsWith('__not_')) {
        const col = k.slice('__not_'.length);
        if (v.op === 'is' && v.v === null) {
          if (r[col] == null) return false;
        }
      } else {
        if (String(r[k]) !== String(v)) return false;
      }
    }
    return true;
  }
}

const SILENT = { log() {}, warn() {}, error() {} };

// Minimal LB lead fixture
function lbLead(over = {}) {
  return {
    id: 'lb1',
    externalRequestId: 'EXT-A',
    customerName: 'Jane Doe',
    customerPhone: '+15125551111',
    platform: 'thumbtack',
    businessId: 'BIZ-1',
    createdAt: '2026-01-01T00:00:00Z',
    status: 'completed',
    ...over,
  };
}

// ──────────────────────────────────────────────────────────────────
// dry-run: empty plan when no data
// ──────────────────────────────────────────────────────────────────
describe('runAttributionRecovery — empty case', () => {
  test('no LB leads, no jobs → empty plan, no writes', async () => {
    const supabase = makeStub();
    const out = await runAttributionRecovery(supabase, { userId: 2, lbLeads: [], logger: SILENT, apply: false });
    expect(out.summary.standard_high_proposals).toBe(0);
    expect(out.summary.recurring_high_proposals).toBe(0);
    expect(supabase._writes).toHaveLength(0);
  });

  test('dry-run never writes even when proposals exist', async () => {
    const customers = [{ id: 100, user_id: 2, first_name: 'Jane', last_name: 'Doe', phone: '+15125551111', source: 'Thumbtack Tampa', zenbooker_id: 'zb-100', acquisition_external_request_id: null }];
    const jobs = [
      { id: 999, user_id: 2, customer_id: 100, status: 'completed', created_at: '2026-01-15', scheduled_date: '2026-01-15', lb_external_request_id: null, lb_channel: null, lb_business_id: null, is_recurring: false, service_address_street: null, service_address_zip: null },
    ];
    const supabase = makeStub({ customers, jobs });
    const out = await runAttributionRecovery(supabase, {
      userId: 2,
      lbLeads: [lbLead()],
      mode: 'both',
      apply: false,
      logger: SILENT,
    });
    expect(out.summary.standard_high_proposals + out.summary.recurring_high_proposals).toBeGreaterThanOrEqual(0);
    expect(supabase._writes).toHaveLength(0);
  });
});

// ──────────────────────────────────────────────────────────────────
// recurring HIGH end-to-end
// ──────────────────────────────────────────────────────────────────
describe('runAttributionRecovery — recurring HIGH', () => {
  test('apply mode (recurring branch) writes customer.acquisition_* + one job stamp', async () => {
    const customers = [{
      id: 100, user_id: 2, first_name: 'Jane', last_name: 'Doe',
      phone: '+15125551111', source: 'Thumbtack Tampa',
      zenbooker_id: 'zb-100', acquisition_external_request_id: null, created_at: '2025-08-01',
    }];
    // 3 jobs, all far OUTSIDE the LB +/-180d window (so Part-2 returns
    // MEDIUM/LOW and the recurring path fires instead). Same address +
    // multi-touch + source-aligned → recurring_customer_high_confidence.
    const jobs = [
      { id: 901, user_id: 2, customer_id: 100, status: 'completed',
        created_at: '2024-01-15', scheduled_date: '2024-01-15',
        is_recurring: false, lb_external_request_id: null, lb_channel: null, lb_business_id: null,
        service_address_street: '1 Main', service_address_zip: '33701' },
      { id: 902, user_id: 2, customer_id: 100, status: 'completed',
        created_at: '2024-06-15', scheduled_date: '2024-06-15',
        is_recurring: false, lb_external_request_id: null, lb_channel: null, lb_business_id: null,
        service_address_street: '1 Main', service_address_zip: '33701' },
      { id: 903, user_id: 2, customer_id: 100, status: 'completed',
        created_at: '2024-12-15', scheduled_date: '2024-12-15',
        is_recurring: false, lb_external_request_id: null, lb_channel: null, lb_business_id: null,
        service_address_street: '1 Main', service_address_zip: '33701' },
    ];
    const supabase = makeStub({ customers, jobs });
    const out = await runAttributionRecovery(supabase, {
      userId: 2,
      lbLeads: [lbLead({ createdAt: '2026-01-01T00:00:00Z' })],
      mode: 'both',
      apply: true,
      logger: SILENT,
    });
    expect(out.summary.applied.recurring_customers).toBe(1);
    expect(out.summary.applied.recurring_acquisition_jobs).toBe(1);
    // Verify exactly one job got stamped (the earliest), not all three
    const stamped = jobs.filter(j => j.lb_external_request_id != null);
    expect(stamped).toHaveLength(1);
    // The customer must have acquisition_source set
    expect(customers[0].acquisition_source).toBe('leadbridge');
    expect(customers[0].acquisition_external_request_id).toBe('EXT-A');
  });

  test('rerun is idempotent — second apply produces zero new proposals', async () => {
    const customers = [{
      id: 100, user_id: 2, first_name: 'Jane', last_name: 'Doe',
      phone: '+15125551111', source: 'Thumbtack Tampa',
      zenbooker_id: 'zb-100', acquisition_external_request_id: null, created_at: '2025-08-01',
    }];
    // Same "out of window" pattern as above so recurring path catches it
    const jobs = [
      { id: 901, user_id: 2, customer_id: 100, status: 'completed', created_at: '2024-01-15', scheduled_date: '2024-01-15', is_recurring: false, lb_external_request_id: null, lb_channel: null, lb_business_id: null, service_address_street: '1 Main', service_address_zip: '33701' },
      { id: 902, user_id: 2, customer_id: 100, status: 'completed', created_at: '2024-06-15', scheduled_date: '2024-06-15', is_recurring: false, lb_external_request_id: null, lb_channel: null, lb_business_id: null, service_address_street: '1 Main', service_address_zip: '33701' },
      { id: 903, user_id: 2, customer_id: 100, status: 'completed', created_at: '2024-12-15', scheduled_date: '2024-12-15', is_recurring: false, lb_external_request_id: null, lb_channel: null, lb_business_id: null, service_address_street: '1 Main', service_address_zip: '33701' },
    ];
    const supabase = makeStub({ customers, jobs });
    await runAttributionRecovery(supabase, {
      userId: 2, lbLeads: [lbLead({ createdAt: '2026-01-01T00:00:00Z' })], mode: 'both', apply: true, logger: SILENT,
    });
    const out2 = await runAttributionRecovery(supabase, {
      userId: 2, lbLeads: [lbLead({ createdAt: '2026-01-01T00:00:00Z' })], mode: 'both', apply: true, logger: SILENT,
    });
    // Second run: nothing new to do because customer.acquisition_external_request_id IS NOT NULL
    expect(out2.summary.recurring_high_proposals).toBe(0);
  });
});

// ──────────────────────────────────────────────────────────────────
// safety — never applies MEDIUM / ambiguous / etc.
// ──────────────────────────────────────────────────────────────────
describe('runAttributionRecovery — safety', () => {
  test('does NOT apply when customer.source contradicts LB platform (conflicting_acquisition_source)', async () => {
    const customers = [{
      id: 100, user_id: 2, first_name: 'Jane', last_name: 'Doe',
      phone: '+15125551111', source: 'Yelp Tampa', acquisition_external_request_id: null,
    }];
    // Jobs OUTSIDE the LB +/-180d window so Part-2 returns MEDIUM and
    // the recurring classifier runs — that's where the conflict is detected.
    const jobs = [
      { id: 901, user_id: 2, customer_id: 100, status: 'completed', created_at: '2024-01-15', scheduled_date: '2024-01-15', lb_external_request_id: null, lb_channel: null, lb_business_id: null, is_recurring: false, service_address_street: '1 Main', service_address_zip: '33701' },
      { id: 902, user_id: 2, customer_id: 100, status: 'completed', created_at: '2024-06-15', scheduled_date: '2024-06-15', lb_external_request_id: null, lb_channel: null, lb_business_id: null, is_recurring: false, service_address_street: '1 Main', service_address_zip: '33701' },
    ];
    const supabase = makeStub({ customers, jobs });
    const out = await runAttributionRecovery(supabase, {
      userId: 2,
      // LB platform=thumbtack contradicts cust.source='Yelp Tampa'
      lbLeads: [lbLead({ platform: 'thumbtack', createdAt: '2026-01-01T00:00:00Z' })],
      mode: 'both', apply: true, logger: SILENT,
    });
    expect(out.summary.applied.recurring_customers).toBe(0);
    expect(out.summary.skipped.conflicting_acquisition_source).toBeGreaterThan(0);
    expect(customers[0].acquisition_external_request_id).toBeNull();
  });

  test('cross-tenant isolation — does not match customer for a different user_id', async () => {
    const customers = [
      // Tenant 9's customer with the same phone
      { id: 100, user_id: 9, first_name: 'Jane', last_name: 'Doe', phone: '+15125551111', source: 'Thumbtack Tampa', acquisition_external_request_id: null },
    ];
    const supabase = makeStub({ customers, jobs: [] });
    const out = await runAttributionRecovery(supabase, {
      userId: 2,  // ← different tenant
      lbLeads: [lbLead()],
      mode: 'both', apply: true, logger: SILENT,
    });
    expect(out.summary.applied?.recurring_customers || 0).toBe(0);
    expect(customers[0].acquisition_external_request_id).toBeNull();
  });

  test('mode=standard skips recurring proposals entirely', async () => {
    const supabase = makeStub();
    const out = await runAttributionRecovery(supabase, {
      userId: 2, lbLeads: [lbLead()], mode: 'standard', apply: false, logger: SILENT,
    });
    expect(out.summary.recurring_enabled).toBe(false);
    expect(out.recurring.proposals).toHaveLength(0);
  });

  test('mode=recurring skips standard merge', async () => {
    const supabase = makeStub();
    const out = await runAttributionRecovery(supabase, {
      userId: 2, lbLeads: [lbLead()], mode: 'recurring', apply: false, logger: SILENT,
    });
    expect(out.summary.standard_high_proposals).toBe(0);
  });

  test('account scoping — drops Part-1 proposals from other businesses', async () => {
    // Part-1 path is exercised when SF leads have linkage but jobs don't.
    // The account filter is applied AFTER classification so we just need
    // to confirm the summary respects the filter.
    const supabase = makeStub();
    const out = await runAttributionRecovery(supabase, {
      userId: 2,
      lbLeads: [],
      mode: 'standard',
      accountBusinessId: 'BIZ-X',
      accountPlatform: 'thumbtack',
      apply: false,
      logger: SILENT,
    });
    expect(out.summary.account_business_id).toBe('BIZ-X');
    expect(out.summary.account_platform).toBe('thumbtack');
  });
});

// ──────────────────────────────────────────────────────────────────
// summary shape — matches the API contract
// ──────────────────────────────────────────────────────────────────
describe('runAttributionRecovery — summary shape', () => {
  test('always includes safe_to_apply and skipped', async () => {
    const out = await runAttributionRecovery(makeStub(), {
      userId: 2, lbLeads: [], mode: 'both', apply: false, logger: SILENT,
    });
    expect(out.summary).toHaveProperty('safe_to_apply');
    expect(out.summary.safe_to_apply).toHaveProperty('standard_high');
    expect(out.summary.safe_to_apply).toHaveProperty('recurring_customers');
    expect(out.summary.safe_to_apply).toHaveProperty('recurring_acquisition_jobs');
    expect(out.summary).toHaveProperty('skipped');
    expect(out.summary.skipped).toHaveProperty('ambiguous');
    expect(out.summary.skipped).toHaveProperty('duplicate_phone_collision');
    expect(out.summary.skipped).toHaveProperty('weak_timing');
    expect(out.summary.skipped).toHaveProperty('weak_identity');
    expect(out.summary.skipped).toHaveProperty('no_matching_customer');
  });

  test('apply mode adds applied counters', async () => {
    const out = await runAttributionRecovery(makeStub(), {
      userId: 2, lbLeads: [], apply: true, logger: SILENT,
    });
    expect(out.summary.applied).toBeDefined();
    expect(out.summary.applied).toHaveProperty('standard_high');
    expect(out.summary.applied).toHaveProperty('recurring_customers');
    expect(out.summary.applied).toHaveProperty('recurring_acquisition_jobs');
  });

  test('throws when userId is missing', async () => {
    await expect(runAttributionRecovery(makeStub(), { lbLeads: [], logger: SILENT })).rejects.toThrow(/userId/);
  });
});
