#!/usr/bin/env node
// READ-ONLY: full tenant-2 reconciliation count between LB leads and SF
// leads/customers.
//
// Expected identity:
//
//   count(LB leads)
//     == count(SF leads linked from LB, not converted)         ← syncStatus state 2
//      + count(SF customers linked from LB, via converted leads) ← state 3 customer
//      + count(LB leads not represented in SF at all)             ← drift
//
// Where:
//   "SF lead linked from LB"     = SF leads WHERE lb_external_request_id IS NOT NULL
//                                  AND user_id = TENANT_ID
//   "SF customer linked from LB" = SF customers reachable via SF leads with
//                                  converted_customer_id IS NOT NULL (distinct
//                                  customer ids)
//   "LB lead not represented"    = LB leads whose externalRequestId is not
//                                  on any SF lead row
//
// LB side: pulls ALL leads for the tenant via the admin candidates endpoint
// (uses every syncStatus, with pagination if needed).
//
// SF side: counts via Supabase service role.
//
// No writes anywhere.

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

const ALL_SYNC_STATUSES = ['pending', 'linked', 'no_match', 'needs_review', 'failed', 'skipped'];

async function fetchAllLB() {
  // The LB /candidates endpoint is single-batch (no cursor). It returns at
  // most `limit` rows per call. To get the full picture across all
  // syncStatuses, we fire one call per status with limit=500 (LB's max).
  // Per the LB receiver code, count===limit signals more_may_exist.
  const all = [];
  for (const st of ALL_SYNC_STATUSES) {
    const r = await fetchCandidates({ lbUserId: LB_USER_UUID, syncStatuses: [st], limit: 500 });
    if (!r.ok) { process.stderr.write(`LB fetch failed for status=${st}: ${r.reason}\n`); continue; }
    process.stderr.write(`  syncStatus=${st.padEnd(13)} count=${r.candidates.length}${r.more_may_exist ? ' (CAPPED — more exist)' : ''}\n`);
    for (const c of r.candidates) all.push({ ...c, _syncStatus: st });
  }
  return all;
}

async function countSfLeadsLinkedFromLB(sb) {
  // Paginate through all SF leads with lb_external_request_id IS NOT NULL
  const all = [];
  let from = 0;
  const PAGE = 1000;
  while (true) {
    const { data, error } = await sb.from('leads')
      .select('id, lb_external_request_id, lb_channel, converted_customer_id', { count: 'exact' })
      .eq('user_id', TENANT_ID)
      .not('lb_external_request_id', 'is', null)
      .range(from, from + PAGE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return all;
}

(async () => {
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  process.stderr.write('Fetching LB leads (all syncStatuses)…\n');
  const lbAll = await fetchAllLB();
  const lbByExtId = new Map();
  for (const c of lbAll) {
    if (c.externalRequestId) {
      // Dedupe: same externalRequestId can appear if LB returned the same row twice
      if (!lbByExtId.has(c.externalRequestId)) lbByExtId.set(c.externalRequestId, c);
    }
  }
  process.stderr.write(`  LB total leads (unique by externalRequestId): ${lbByExtId.size}\n`);

  process.stderr.write('Fetching SF leads with lb_external_request_id…\n');
  const sfLeads = await countSfLeadsLinkedFromLB(sb);
  process.stderr.write(`  SF leads with LB stamp: ${sfLeads.length}\n`);

  // Reconciliation
  const sfByExtId = new Map();   // SF lead by externalRequestId
  const sfConvertedCustomerIds = new Set();
  for (const l of sfLeads) {
    if (!sfByExtId.has(l.lb_external_request_id)) sfByExtId.set(l.lb_external_request_id, l);
    if (l.converted_customer_id != null) sfConvertedCustomerIds.add(l.converted_customer_id);
  }

  const stateBuckets = {
    state_1_lb_only_no_sf_record:        0,
    state_2_sf_lead_only_not_converted:  0,
    state_3_sf_lead_converted_to_customer: 0,
  };
  const lbWithoutSf = [];
  const sfWithoutLb = [];
  for (const [extId, lb] of lbByExtId.entries()) {
    const sf = sfByExtId.get(extId);
    if (!sf) {
      stateBuckets.state_1_lb_only_no_sf_record++;
      lbWithoutSf.push({ leadId: lb.leadId, externalRequestId: extId, channel: lb.platform, name: lb.customerName, lbSyncStatus: lb._syncStatus });
    } else if (sf.converted_customer_id == null) {
      stateBuckets.state_2_sf_lead_only_not_converted++;
    } else {
      stateBuckets.state_3_sf_lead_converted_to_customer++;
    }
  }
  for (const [extId, sf] of sfByExtId.entries()) {
    if (!lbByExtId.has(extId)) {
      sfWithoutLb.push({ sfLeadId: sf.id, externalRequestId: extId, channel: sf.lb_channel, converted_customer_id: sf.converted_customer_id });
    }
  }

  // LB syncStatus distribution (audit signal)
  const lbStatusDist = {};
  for (const c of lbAll) lbStatusDist[c._syncStatus] = (lbStatusDist[c._syncStatus] || 0) + 1;

  const out = {
    tenant: TENANT_ID,
    lb_user_id: LB_USER_UUID,
    lb_total_leads_unique_by_external_request_id: lbByExtId.size,
    lb_total_leads_raw_including_duplicates: lbAll.length,
    lb_syncStatus_distribution: lbStatusDist,
    sf_leads_with_lb_external_request_id: sfLeads.length,
    sf_distinct_converted_customers_from_lb: sfConvertedCustomerIds.size,
    reconciliation_state_buckets: stateBuckets,
    reconciliation_equation: {
      lhs_lb_total: lbByExtId.size,
      rhs_state1_no_sf: stateBuckets.state_1_lb_only_no_sf_record,
      rhs_state2_sf_lead_only: stateBuckets.state_2_sf_lead_only_not_converted,
      rhs_state3_sf_customer: stateBuckets.state_3_sf_lead_converted_to_customer,
      rhs_sum: stateBuckets.state_1_lb_only_no_sf_record + stateBuckets.state_2_sf_lead_only_not_converted + stateBuckets.state_3_sf_lead_converted_to_customer,
      identity_holds: lbByExtId.size === (stateBuckets.state_1_lb_only_no_sf_record + stateBuckets.state_2_sf_lead_only_not_converted + stateBuckets.state_3_sf_lead_converted_to_customer),
    },
    drift: {
      lb_leads_without_sf_record_count: lbWithoutSf.length,
      lb_leads_without_sf_record_samples: lbWithoutSf.slice(0, 10),
      sf_leads_without_lb_origin_count: sfWithoutLb.length,
      sf_leads_without_lb_origin_samples: sfWithoutLb.slice(0, 10),
    },
  };
  console.log(JSON.stringify(out, null, 2));
})().catch(e => { console.error(e); process.exit(1); });
