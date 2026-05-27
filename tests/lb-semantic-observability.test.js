/**
 * lb-semantic-summary.js — Phase 1.5 observability unit tests.
 *
 * Covers the READ-ONLY semantic diagnostic helpers used by:
 *   GET /api/integrations/leadbridge/semantic-summary
 *   GET /api/integrations/leadbridge/entity/:type/:id/semantic-state
 *
 * Invariants asserted:
 *   - Zero DB mutations from either helper
 *   - Zero outbound events emitted
 *   - Classification taxonomy matches the two-domain model:
 *       LB lead with no SF customer is NORMAL (unconverted_lead)
 *       SF job without LB attribution is NORMAL (standalone_sf_work)
 *       SF scheduled + LB completed is not a failure (not_applicable_to_lb)
 *       ZB-paid jobs are recognized via transactions table
 *   - Attribution recovery remains idempotent (untouched by diagnostics)
 */

process.env.SF_INTEGRATION_ENC_KEY = Buffer.alloc(32, 7).toString('base64');

const { buildSemanticSummary, buildEntitySemanticState } = require('../lib/lb-semantic-summary');

// ──────────────────────────────────────────────────────────────────
// Supabase stub — counts via `count: 'exact', head: true` and
// `.maybeSingle()` reads. Records every operation for the mutation
// invariant: we must observe ZERO writes.
// ──────────────────────────────────────────────────────────────────
function makeStub({ jobs = [], leads = [], customers = [], transactions = [], stages = [], outbound = [] } = {}) {
  const ops = [];
  const writes = [];

  function makeChain(table) {
    const filter = {};
    let isCountHead = false;
    const chain = {
      _table: table,
      select(_cols, opts) {
        if (opts && opts.count === 'exact' && opts.head) isCountHead = true;
        return chain;
      },
      eq(k, v) { filter[k] = v; return chain; },
      is(k, v) { filter[`__is_${k}`] = v; return chain; },
      not(k, op, v) { filter[`__not_${k}`] = { op, v }; return chain; },
      in(k, vs) { filter[`__in_${k}`] = vs; return chain; },
      limit() { return chain; },
      // Write paths — should NEVER be called by these helpers
      update(patch) { writes.push({ table, op: 'update', filter: { ...filter }, patch }); return chain; },
      insert(row) { writes.push({ table, op: 'insert', row }); return chain; },
      delete() { writes.push({ table, op: 'delete', filter: { ...filter } }); return chain; },
      upsert(row) { writes.push({ table, op: 'upsert', row }); return chain; },
      async maybeSingle() {
        ops.push({ table, op: 'read', filter: { ...filter } });
        const source = pick(table);
        const row = source.find(r => match(r, filter));
        return { data: row || null, error: null };
      },
      then(resolve) {
        ops.push({ table, op: 'list', filter: { ...filter }, countHead: isCountHead });
        const source = pick(table);
        const matching = source.filter(r => match(r, filter));
        if (isCountHead) {
          resolve({ count: matching.length, error: null });
        } else {
          resolve({ data: matching, error: null });
        }
      },
    };
    return chain;
  }

  function pick(table) {
    switch (table) {
      case 'jobs': return jobs;
      case 'leads': return leads;
      case 'customers': return customers;
      case 'transactions': return transactions;
      case 'lead_stages': return stages;
      case 'leadbridge_outbound_events': return outbound;
      default: return [];
    }
  }

  function match(row, filter) {
    for (const [k, v] of Object.entries(filter)) {
      if (k.startsWith('__is_')) {
        const col = k.slice(5);
        // .is(col, null) matches rows where col is null
        if (v === null && row[col] != null) return false;
        if (v !== null && row[col] !== v) return false;
      } else if (k.startsWith('__not_')) {
        const col = k.slice(6);
        // .not(col, 'is', null) matches rows where col IS NOT NULL
        if (v.op === 'is' && v.v === null) {
          if (row[col] == null) return false;
        } else if (v.op === 'eq') {
          if (row[col] === v.v) return false;
        }
      } else if (k.startsWith('__in_')) {
        const col = k.slice(5);
        if (!v.map(String).includes(String(row[col]))) return false;
      } else {
        if (String(row[k]) !== String(v)) return false;
      }
    }
    return true;
  }

  return {
    _ops: ops,
    _writes: writes,
    from(table) { return makeChain(table); },
  };
}

// ──────────────────────────────────────────────────────────────────
// buildSemanticSummary
// ──────────────────────────────────────────────────────────────────
describe('buildSemanticSummary', () => {
  test('produces the documented shape with model + counts + classifications + requires_live_lb_pull', async () => {
    const supabase = makeStub({
      jobs: [
        { id: 1, user_id: 2, status: 'completed',  lb_external_request_id: 'A' },
        { id: 2, user_id: 2, status: 'scheduled',  lb_external_request_id: null },
        { id: 3, user_id: 2, status: 'completed',  lb_external_request_id: null },
      ],
      leads: [
        { id: 10, user_id: 2, lb_external_request_id: 'L1', converted_customer_id: 100 },
        { id: 11, user_id: 2, lb_external_request_id: 'L2', converted_customer_id: null },
        { id: 12, user_id: 2, lb_external_request_id: null, converted_customer_id: null },
      ],
      customers: [
        { id: 100, user_id: 2, acquisition_source: 'leadbridge', acquisition_external_request_id: 'A1' },
        { id: 101, user_id: 2, acquisition_source: null, acquisition_external_request_id: null },
      ],
      outbound: [
        { id: 'evt1', user_id: 2, state: 'sent' },
        { id: 'evt2', user_id: 2, state: 'dlq' },
      ],
    });
    const out = await buildSemanticSummary(supabase, 2);

    expect(out).toHaveProperty('model');
    expect(out).toHaveProperty('counts');
    expect(out).toHaveProperty('classifications');
    expect(out).toHaveProperty('requires_live_lb_pull');

    // counts
    expect(out.counts.sf_jobs_total).toBe(3);
    expect(out.counts.sf_jobs_lb_attributed).toBe(1);
    expect(out.counts.sf_jobs_standalone).toBe(2);
    expect(out.counts.sf_jobs_completed).toBe(2);

    expect(out.counts.sf_leads_total).toBe(3);
    expect(out.counts.sf_leads_lb_attributed).toBe(2);
    expect(out.counts.sf_leads_lb_unconverted).toBe(1);
    expect(out.counts.sf_leads_lb_converted).toBe(1);
    expect(out.counts.sf_leads_lb_only).toBe(1);

    expect(out.counts.customers_total).toBe(2);
    expect(out.counts.customers_lb_attributed).toBe(1);
    expect(out.counts.customers_any_acquisition).toBe(1);

    expect(out.counts.outbound_queue_dlq).toBe(1);
    expect(out.counts.outbound_queue_failed).toBe(0);

    // classifications (the reframed names)
    expect(out.classifications.standalone_sf_work).toBe(2);
    expect(out.classifications.lb_attributed_work).toBe(1);
    expect(out.classifications.lb_attributed_customers).toBe(1);
    expect(out.classifications.unconverted_lead).toBe(1);
    expect(out.classifications.sf_lead_only).toBe(1);
    expect(out.classifications.lb_lead_with_conversion).toBe(1);
    expect(out.classifications.true_error).toBe(1);  // 1 dlq + 0 failed

    // cross-domain counts are deferred
    expect(out.requires_live_lb_pull.cross_domain_difference).toBeNull();
    expect(out.requires_live_lb_pull.not_applicable_to_lb).toBeNull();
    expect(out.requires_live_lb_pull.marketplace_only_lead).toBeNull();
  });

  test('READ-ONLY: never issues any write op', async () => {
    const supabase = makeStub({ jobs: [], leads: [], customers: [] });
    await buildSemanticSummary(supabase, 2);
    expect(supabase._writes).toHaveLength(0);
  });

  test('every query is tenant-scoped by user_id', async () => {
    const supabase = makeStub();
    await buildSemanticSummary(supabase, 2);
    for (const op of supabase._ops) {
      // Outbound events filtered by user_id always
      expect(op.filter.user_id).toBe(2);
    }
  });

  test('throws when userId is missing', async () => {
    await expect(buildSemanticSummary(makeStub(), null)).rejects.toThrow(/userId/);
  });
});

// ──────────────────────────────────────────────────────────────────
// buildEntitySemanticState — JOB
// ──────────────────────────────────────────────────────────────────
describe('buildEntitySemanticState — job', () => {
  test('LB-attributed job with valid LB mapping → lb_attributed_work, should_sync_to_lb=true', async () => {
    const supabase = makeStub({
      jobs: [{ id: 100, user_id: 2, status: 'completed', customer_id: 50, lb_external_request_id: 'EXT', lb_channel: 'thumbtack', lb_business_id: 'BIZ', zenbooker_id: 'zb-100' }],
      transactions: [{ id: 1, user_id: 2, job_id: 100, status: 'completed', amount: '199.00', payment_method: 'stripe', created_at: '2025-06-10', zenbooker_id: 'zbtx-1' }],
      customers: [{ id: 50, user_id: 2, acquisition_source: 'leadbridge', acquisition_external_request_id: 'EXT', acquisition_channel: 'thumbtack' }],
    });
    const out = await buildEntitySemanticState(supabase, 2, 'job', 100);
    expect(out.found).toBe(true);
    expect(out.classification).toBe('lb_attributed_work');
    expect(out.lb_attribution.has_attribution).toBe(true);
    expect(out.acquisition_attribution.is_lb_acquired).toBe(true);
    expect(out.zb_state).toMatchObject({ has_zb_transaction: true, zb_paid: true, zb_amount: '199.00' });
    expect(out.should_sync_to_lb).toBe(true);
  });

  test('SF/ZB-only completed job (no LB) → standalone_sf_work, should_sync_to_lb=false', async () => {
    const supabase = makeStub({
      jobs: [{ id: 200, user_id: 2, status: 'completed', customer_id: 60, lb_external_request_id: null, zenbooker_id: 'zb-200' }],
      transactions: [{ id: 2, user_id: 2, job_id: 200, status: 'completed', amount: '99.00', payment_method: 'venmo' }],
      customers: [{ id: 60, user_id: 2, acquisition_source: null, acquisition_external_request_id: null }],
    });
    const out = await buildEntitySemanticState(supabase, 2, 'job', 200);
    expect(out.classification).toBe('standalone_sf_work');
    expect(out.zb_state.zb_paid).toBe(true);
    expect(out.should_sync_to_lb).toBe(false);
    expect(out.sync_reason).toMatch(/standalone_sf_work/);
  });

  test('LB-linked scheduled job (future) → lb_attributed_work + not_applicable_to_lb', async () => {
    // SF jobs in status='scheduled' have no LB canonical equivalent, so
    // they're correctly reported as lb_attributed_work (the attribution
    // chain is intact) but should_sync_to_lb=false (no push possible).
    // This is NOT a failure — it's the not_applicable_to_lb bucket from
    // the cross-domain model.
    const supabase = makeStub({
      jobs: [{ id: 300, user_id: 2, status: 'scheduled', customer_id: 70, lb_external_request_id: 'EXT-FUT', lb_channel: 'thumbtack' }],
    });
    const out = await buildEntitySemanticState(supabase, 2, 'job', 300);
    expect(out.classification).toBe('lb_attributed_work');
    expect(out.should_sync_to_lb).toBe(false);
    expect(out.sync_reason).toMatch(/not_applicable_to_lb/);
  });

  test('LB-linked cancelled job → lb_attributed_work + sync mapping exists', async () => {
    const supabase = makeStub({
      jobs: [{ id: 301, user_id: 2, status: 'cancelled', customer_id: 71, lb_external_request_id: 'EXT-C', lb_channel: 'thumbtack' }],
    });
    const out = await buildEntitySemanticState(supabase, 2, 'job', 301);
    expect(out.classification).toBe('lb_attributed_work');
    expect(out.should_sync_to_lb).toBe(true);  // 'cancelled' has a canonical mapping
  });

  test('job not found → found:false', async () => {
    const supabase = makeStub({ jobs: [] });
    const out = await buildEntitySemanticState(supabase, 2, 'job', 999);
    expect(out.found).toBe(false);
  });

  test('cross-tenant: a job owned by user 9 is invisible to user 2', async () => {
    const supabase = makeStub({
      jobs: [{ id: 400, user_id: 9, status: 'completed', lb_external_request_id: 'EXT-9' }],
    });
    const out = await buildEntitySemanticState(supabase, 2, 'job', 400);
    expect(out.found).toBe(false);
  });

  test('READ-ONLY: zero writes for any job lookup', async () => {
    const supabase = makeStub({
      jobs: [{ id: 1, user_id: 2, status: 'completed', lb_external_request_id: 'X', customer_id: 5 }],
      customers: [{ id: 5, user_id: 2 }],
    });
    await buildEntitySemanticState(supabase, 2, 'job', 1);
    expect(supabase._writes).toHaveLength(0);
  });
});

// ──────────────────────────────────────────────────────────────────
// buildEntitySemanticState — LEAD
// ──────────────────────────────────────────────────────────────────
describe('buildEntitySemanticState — lead', () => {
  test('LB lead never converted → unconverted_lead (NORMAL, not a failure)', async () => {
    const supabase = makeStub({
      leads: [{ id: 1, user_id: 2, lb_external_request_id: 'L1', converted_customer_id: null, stage_id: 8 }],
      stages: [{ id: 8, name: 'New Lead' }],
    });
    const out = await buildEntitySemanticState(supabase, 2, 'lead', 1);
    expect(out.classification).toBe('unconverted_lead');
    expect(out.reason).toMatch(/Normal — not every lead converts/);
    expect(out.should_sync_to_lb).toBe(false);
  });

  test('SF lead with no LB linkage → sf_lead_only', async () => {
    const supabase = makeStub({
      leads: [{ id: 2, user_id: 2, lb_external_request_id: null, converted_customer_id: null, stage_id: 9 }],
      stages: [{ id: 9, name: 'Contacted' }],
    });
    const out = await buildEntitySemanticState(supabase, 2, 'lead', 2);
    expect(out.classification).toBe('sf_lead_only');
  });

  test('LB lead that converted → lb_attributed_work', async () => {
    const supabase = makeStub({
      leads: [{ id: 3, user_id: 2, lb_external_request_id: 'L3', converted_customer_id: 200, stage_id: 13 }],
      stages: [{ id: 13, name: 'Won' }],
    });
    const out = await buildEntitySemanticState(supabase, 2, 'lead', 3);
    expect(out.classification).toBe('lb_attributed_work');
    expect(out.operational_link.has_operational_job).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────
// buildEntitySemanticState — CUSTOMER
// ──────────────────────────────────────────────────────────────────
describe('buildEntitySemanticState — customer', () => {
  test('LB-acquired customer with multiple jobs → recurring_customer_attribution', async () => {
    const supabase = makeStub({
      customers: [{ id: 1, user_id: 2, acquisition_source: 'leadbridge', acquisition_external_request_id: 'EXT-A' }],
      jobs: [
        { id: 10, user_id: 2, customer_id: 1, lb_external_request_id: 'EXT-A' },
        { id: 11, user_id: 2, customer_id: 1, lb_external_request_id: null },
        { id: 12, user_id: 2, customer_id: 1, lb_external_request_id: null },
      ],
    });
    const out = await buildEntitySemanticState(supabase, 2, 'customer', 1);
    expect(out.classification).toBe('recurring_customer_attribution');
    expect(out.job_rollup.total_jobs).toBe(3);
    expect(out.job_rollup.lb_attributed_jobs).toBe(1);
    expect(out.job_rollup.is_recurring).toBe(true);
    expect(out.acquisition_attribution.is_lb_acquired).toBe(true);
  });

  test('LB-acquired customer with one job → lb_attributed_work (single-touch)', async () => {
    const supabase = makeStub({
      customers: [{ id: 2, user_id: 2, acquisition_source: 'leadbridge', acquisition_external_request_id: 'EXT-B' }],
      jobs: [{ id: 20, user_id: 2, customer_id: 2, lb_external_request_id: 'EXT-B' }],
    });
    const out = await buildEntitySemanticState(supabase, 2, 'customer', 2);
    expect(out.classification).toBe('lb_attributed_work');
    expect(out.job_rollup.is_recurring).toBe(false);
  });

  test('Customer with no acquisition → standalone_sf_work', async () => {
    const supabase = makeStub({
      customers: [{ id: 3, user_id: 2, acquisition_source: null, acquisition_external_request_id: null }],
      jobs: [{ id: 30, user_id: 2, customer_id: 3 }],
    });
    const out = await buildEntitySemanticState(supabase, 2, 'customer', 3);
    expect(out.classification).toBe('standalone_sf_work');
  });
});

// ──────────────────────────────────────────────────────────────────
// Cross-cutting safety
// ──────────────────────────────────────────────────────────────────
describe('Phase 1.5 diagnostics — safety invariants', () => {
  test('all three entity types: zero writes across a full read pass', async () => {
    const supabase = makeStub({
      jobs: [{ id: 1, user_id: 2, status: 'completed', lb_external_request_id: 'X', customer_id: 10 }],
      leads: [{ id: 2, user_id: 2, lb_external_request_id: 'Y', converted_customer_id: null, stage_id: 8 }],
      customers: [{ id: 10, user_id: 2, acquisition_source: 'leadbridge', acquisition_external_request_id: 'X' }],
      stages: [{ id: 8, name: 'New Lead' }],
    });
    await buildEntitySemanticState(supabase, 2, 'job', 1);
    await buildEntitySemanticState(supabase, 2, 'lead', 2);
    await buildEntitySemanticState(supabase, 2, 'customer', 10);
    expect(supabase._writes).toHaveLength(0);
  });

  test('LB lead without SF customer is NORMAL — never reports as failure', async () => {
    const supabase = makeStub({
      leads: [{ id: 100, user_id: 2, lb_external_request_id: 'EXT', converted_customer_id: null, stage_id: 8 }],
      stages: [{ id: 8, name: 'New Lead' }],
    });
    const out = await buildEntitySemanticState(supabase, 2, 'lead', 100);
    expect(out.classification).not.toBe('true_error');
    expect(out.classification).toBe('unconverted_lead');
  });

  test('SF job without LB attribution is NORMAL — never reports as failure', async () => {
    const supabase = makeStub({
      jobs: [{ id: 1, user_id: 2, status: 'completed', lb_external_request_id: null }],
    });
    const out = await buildEntitySemanticState(supabase, 2, 'job', 1);
    expect(out.classification).toBe('standalone_sf_work');
    expect(out.classification).not.toBe('true_error');
  });

  test('invalid type → throws', async () => {
    await expect(buildEntitySemanticState(makeStub(), 2, 'invalid', 1))
      .rejects.toThrow(/must be one of/);
  });
});
