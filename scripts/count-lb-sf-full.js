#!/usr/bin/env node
// Fuller LB↔SF reconciliation. Pages through LB's skipped bucket via the
// `status` filter (lost / cancelled / no_show / archived) since LB's
// /candidates endpoint single-batches at limit=500 per call.
//
// Also pulls SF jobs.lb_lead_id and SF customers.lb_lead_id to count the
// historical linkage from PR #34-#41.
//
// READ-ONLY.

'use strict';

const fs = require('fs');
const path = require('path');
const env = JSON.parse(fs.readFileSync(path.join(process.env.USERPROFILE, '.sf-prod-env.json'), 'utf8'));
process.env.SUPABASE_URL                     = env.SUPABASE_URL;
process.env.SUPABASE_SERVICE_ROLE_KEY        = env.SUPABASE_SERVICE_ROLE_KEY;
process.env.SF_LB_PROVISIONING_SHARED_SECRET = env.SF_LB_PROVISIONING_SHARED_SECRET;
process.env.LB_PROVISIONING_BASE_URL         = 'https://thumbtack-bridge-production.up.railway.app/api';

const { createClient } = require('@supabase/supabase-js');
const { fetchCandidates } = require('../lib/lb-historical-sync-client');

const TENANT_ID = 2;
const LB_USER_UUID = 'c3d14499-dec1-42c3-a36c-713cb09842c6';

// Per LB's contract: skipped covers status IN {lost, cancelled, no_show, archived}.
// Page through each `status` filter to bypass the 500-cap on the syncStatus bucket.
const TERMINAL_STATUSES = ['lost', 'cancelled', 'no_show', 'archived'];

async function fetchAllLB() {
  const all = new Map();
  for (const ss of ['pending', 'linked', 'no_match', 'needs_review', 'failed']) {
    const r = await fetchCandidates({ lbUserId: LB_USER_UUID, syncStatuses: [ss], limit: 500 });
    if (!r.ok) continue;
    process.stderr.write(`  syncStatus=${ss.padEnd(13)} count=${r.candidates.length}${r.more_may_exist ? ' (CAP)' : ''}\n`);
    for (const c of r.candidates) {
      if (c.externalRequestId && !all.has(c.externalRequestId)) all.set(c.externalRequestId, { ...c, _syncStatus: ss });
    }
  }
  // Page skipped via status filter
  let skippedFromStatus = 0;
  for (const status of TERMINAL_STATUSES) {
    const r = await fetchCandidates({ lbUserId: LB_USER_UUID, syncStatuses: ['skipped'], status, limit: 500 });
    if (!r.ok) continue;
    process.stderr.write(`  syncStatus=skipped status=${status.padEnd(10)} count=${r.candidates.length}${r.more_may_exist ? ' (CAP)' : ''}\n`);
    for (const c of r.candidates) {
      if (c.externalRequestId && !all.has(c.externalRequestId)) {
        all.set(c.externalRequestId, { ...c, _syncStatus: 'skipped' });
        skippedFromStatus++;
      }
    }
  }
  process.stderr.write(`  skipped (paged via status filter): +${skippedFromStatus}\n`);
  return all;
}

async function pageAll(query, pageSize = 1000) {
  const all = [];
  let from = 0;
  while (true) {
    const { data, error } = await query(from, from + pageSize - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return all;
}

(async () => {
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  process.stderr.write('LB:\n');
  const lbByExtId = await fetchAllLB();
  process.stderr.write(`  LB total (unique by externalRequestId): ${lbByExtId.size}\n`);

  process.stderr.write('SF: leads with lb_external_request_id…\n');
  const sfLeads = await pageAll((from, to) => sb.from('leads')
    .select('id, lb_external_request_id, lb_channel, converted_customer_id, created_at')
    .eq('user_id', TENANT_ID).not('lb_external_request_id', 'is', null).range(from, to));
  process.stderr.write(`  SF leads with LB stamp: ${sfLeads.length}\n`);

  process.stderr.write('SF: customers (count)…\n');
  const { count: totalCustomers } = await sb.from('customers')
    .select('id', { count: 'exact', head: true }).eq('user_id', TENANT_ID);
  process.stderr.write(`  SF total customers: ${totalCustomers}\n`);

  process.stderr.write('SF: customers.lb_lead_id IS NOT NULL (historical linkage from PR #34-#41)…\n');
  const { count: customersWithLb } = await sb.from('customers')
    .select('id', { count: 'exact', head: true }).eq('user_id', TENANT_ID)
    .not('lb_lead_id', 'is', null);
  process.stderr.write(`  SF customers with lb_lead_id: ${customersWithLb}\n`);

  process.stderr.write('SF: jobs.lb_lead_id IS NOT NULL…\n');
  const { count: jobsWithLb } = await sb.from('jobs')
    .select('id', { count: 'exact', head: true }).eq('user_id', TENANT_ID)
    .not('lb_lead_id', 'is', null);
  process.stderr.write(`  SF jobs with lb_lead_id: ${jobsWithLb}\n`);

  process.stderr.write('SF: jobs.lb_external_request_id IS NOT NULL…\n');
  const { count: jobsWithExtId } = await sb.from('jobs')
    .select('id', { count: 'exact', head: true }).eq('user_id', TENANT_ID)
    .not('lb_external_request_id', 'is', null);
  process.stderr.write(`  SF jobs with lb_external_request_id: ${jobsWithExtId}\n`);

  // Reconciliation buckets
  const sfByExtId = new Map();
  for (const l of sfLeads) sfByExtId.set(l.lb_external_request_id, l);

  const buckets = {
    state_1_lb_only_no_sf_lead: 0,
    state_2_sf_lead_only_not_converted: 0,
    state_3_sf_lead_converted: 0,
  };
  for (const [extId, lb] of lbByExtId.entries()) {
    const sf = sfByExtId.get(extId);
    if (!sf) buckets.state_1_lb_only_no_sf_lead++;
    else if (sf.converted_customer_id == null) buckets.state_2_sf_lead_only_not_converted++;
    else buckets.state_3_sf_lead_converted++;
  }
  const orphanSf = sfLeads.filter(l => !lbByExtId.has(l.lb_external_request_id));

  // Also compute LB syncStatus distribution
  const lbStatusDist = {};
  for (const c of lbByExtId.values()) lbStatusDist[c._syncStatus] = (lbStatusDist[c._syncStatus] || 0) + 1;

  const out = {
    tenant: TENANT_ID,
    headline_counts: {
      lb_total_unique:                      lbByExtId.size,
      sf_leads_with_lb_stamp:                sfLeads.length,
      sf_customers_with_lb_lead_id:          customersWithLb,
      sf_customers_total:                    totalCustomers,
      sf_jobs_with_lb_lead_id:               jobsWithLb,
      sf_jobs_with_lb_external_request_id:   jobsWithExtId,
      sf_distinct_converted_from_leads:      new Set(sfLeads.filter(l => l.converted_customer_id != null).map(l => l.converted_customer_id)).size,
    },
    lb_syncStatus_distribution: lbStatusDist,
    reconciliation_via_leads_only: {
      lhs_lb_total:                                 lbByExtId.size,
      state_1_lb_only_no_sf_lead:                   buckets.state_1_lb_only_no_sf_lead,
      state_2_sf_lead_only_not_converted:           buckets.state_2_sf_lead_only_not_converted,
      state_3_sf_lead_converted:                    buckets.state_3_sf_lead_converted,
      rhs_sum:                                      buckets.state_1_lb_only_no_sf_lead + buckets.state_2_sf_lead_only_not_converted + buckets.state_3_sf_lead_converted,
      identity_holds:                               lbByExtId.size === (buckets.state_1_lb_only_no_sf_lead + buckets.state_2_sf_lead_only_not_converted + buckets.state_3_sf_lead_converted),
    },
    drift: {
      lb_without_sf_lead:           buckets.state_1_lb_only_no_sf_lead,
      sf_lead_without_lb_visible:   orphanSf.length,
    },
  };
  console.log(JSON.stringify(out, null, 2));
})().catch(e => { console.error(e); process.exit(1); });
