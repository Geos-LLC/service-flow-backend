#!/usr/bin/env node
// READ-ONLY: count SF leads by source for tenant 2 and check whether any
// of the ~72 "truly-orphaned" LB leads (no lb_external_request_id match
// on SF leads, no lb_lead_id match on SF customers) actually exist as
// OpenPhone-originated SF leads (matched via phone or email).
//
// Hypothesis: some LB leads may have called/texted Spotless directly via
// OpenPhone, creating an SF lead with source='openphone' (or similar) and
// no lb_external_request_id. The matcher should reach those via the
// existing phone/email path on leads, just like it would on customers.

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

const TERMINAL_STATUSES = ['lost', 'cancelled', 'no_show', 'archived'];
const PHONE_RE = /\D+/g;
const digitsOf = (s) => typeof s === 'string' ? s.replace(PHONE_RE, '') : '';
const last10  = (s) => { const d = digitsOf(s); return d.length >= 7 ? d.slice(-10) : null; };

async function fetchAllLB() {
  const all = new Map();
  for (const ss of ['pending', 'linked', 'no_match', 'needs_review', 'failed']) {
    const r = await fetchCandidates({ lbUserId: LB_USER_UUID, syncStatuses: [ss], limit: 500 });
    if (!r.ok) continue;
    for (const c of r.candidates) if (c.externalRequestId && !all.has(c.externalRequestId)) all.set(c.externalRequestId, { ...c, _syncStatus: ss });
  }
  for (const status of TERMINAL_STATUSES) {
    const r = await fetchCandidates({ lbUserId: LB_USER_UUID, syncStatuses: ['skipped'], status, limit: 500 });
    if (!r.ok) continue;
    for (const c of r.candidates) if (c.externalRequestId && !all.has(c.externalRequestId)) all.set(c.externalRequestId, { ...c, _syncStatus: 'skipped' });
  }
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

  // 1. SF lead source distribution
  process.stderr.write('SF leads — distinct source distribution…\n');
  const allLeads = await pageAll((from, to) => sb.from('leads')
    .select('id, source, source_raw, lb_external_request_id, lb_channel, phone, email, first_name, last_name, converted_customer_id, created_at')
    .eq('user_id', TENANT_ID).range(from, to), 1000);
  const totalSfLeads = allLeads.length;
  process.stderr.write(`  total SF leads: ${totalSfLeads}\n`);

  const sourceDist = {};
  const sourceLbStampDist = {};
  for (const l of allLeads) {
    const k = (l.source || '<null>');
    sourceDist[k] = (sourceDist[k] || 0) + 1;
    if (l.lb_external_request_id) sourceLbStampDist[k] = (sourceLbStampDist[k] || 0) + 1;
  }

  // 2. LB pending + try to match the ~72 truly-orphaned ones via phone/email
  process.stderr.write('LB: fetching all leads…\n');
  const lbAll = await fetchAllLB();
  process.stderr.write(`  LB visible: ${lbAll.size}\n`);

  // Build SF lead lookup indexes for fallback matching
  const sfByLbExtId = new Map();
  for (const l of allLeads) if (l.lb_external_request_id) sfByLbExtId.set(l.lb_external_request_id, l);
  const sfByPhone10 = new Map(); // last10 -> [leads]
  const sfByEmail = new Map();
  for (const l of allLeads) {
    const p = last10(l.phone);
    if (p) {
      if (!sfByPhone10.has(p)) sfByPhone10.set(p, []);
      sfByPhone10.get(p).push(l);
    }
    if (l.email) {
      const e = l.email.trim().toLowerCase();
      if (!sfByEmail.has(e)) sfByEmail.set(e, []);
      sfByEmail.get(e).push(l);
    }
  }

  // 3. Also need SF customers by lb_lead_id for state-3b
  process.stderr.write('SF customers with lb_lead_id…\n');
  const customers = await pageAll((from, to) => sb.from('customers')
    .select('id, lb_lead_id, first_name, last_name')
    .eq('user_id', TENANT_ID).not('lb_lead_id', 'is', null).range(from, to), 1000);
  const sfCustomersByLbLeadId = new Map();
  for (const c of customers) if (c.lb_lead_id) sfCustomersByLbLeadId.set(c.lb_lead_id, c);

  // Classify LB leads
  const buckets = {
    state2_sf_lead_only:               0,    // SF lead via lb_external_request_id, no convert
    state3a_sf_lead_converted:         0,    // SF lead via lb_external_request_id, converted
    state3b_sf_customer_only:          0,    // SF customer via lb_lead_id, no SF lead row
    state3c_sf_lead_via_phone:         0,    // NEW — SF lead found via phone (no lb_external_request_id), source != lb
    state3d_sf_lead_via_email:         0,    // NEW — SF lead found via email
    truly_no_record:                   0,    // no SF representation anywhere
  };
  const orphanFromOpenPhone = [];
  const trulyOrphan = [];

  for (const [extId, lb] of lbAll.entries()) {
    const sfL = sfByLbExtId.get(extId);
    if (sfL) {
      if (sfL.converted_customer_id != null) buckets.state3a_sf_lead_converted++;
      else                                    buckets.state2_sf_lead_only++;
      continue;
    }
    const sfC = sfCustomersByLbLeadId.get(lb.leadId);
    if (sfC) { buckets.state3b_sf_customer_only++; continue; }

    // Try phone match on SF leads (any source)
    const p10 = last10(lb.customerPhone);
    if (p10 && sfByPhone10.has(p10)) {
      const sfLeads = sfByPhone10.get(p10);
      buckets.state3c_sf_lead_via_phone++;
      orphanFromOpenPhone.push({
        leadId: lb.leadId, name: lb.customerName, channel: lb.platform, phone: lb.customerPhone,
        sfLeads: sfLeads.map(s => ({ id: s.id, name: (s.first_name||'')+' '+(s.last_name||''), source: s.source, source_raw: s.source_raw, lb_external_request_id: s.lb_external_request_id })),
      });
      continue;
    }
    // Try email match (skip Yelp proxy)
    const em = (lb.customerEmail && !/@messaging\.yelp\.com$/i.test(lb.customerEmail)) ? lb.customerEmail.trim().toLowerCase() : null;
    if (em && sfByEmail.has(em)) {
      const sfLeads = sfByEmail.get(em);
      buckets.state3d_sf_lead_via_email++;
      orphanFromOpenPhone.push({
        leadId: lb.leadId, name: lb.customerName, channel: lb.platform, email: lb.customerEmail,
        sfLeads: sfLeads.map(s => ({ id: s.id, name: (s.first_name||'')+' '+(s.last_name||''), source: s.source, source_raw: s.source_raw, lb_external_request_id: s.lb_external_request_id })),
      });
      continue;
    }

    buckets.truly_no_record++;
    trulyOrphan.push({ leadId: lb.leadId, name: lb.customerName, channel: lb.platform, phone: lb.customerPhone, email: lb.customerEmail, lbSyncStatus: lb._syncStatus });
  }

  const out = {
    tenant: TENANT_ID,
    sf_total_leads: totalSfLeads,
    sf_leads_source_distribution: sourceDist,
    sf_leads_source_distribution_with_lb_stamp: sourceLbStampDist,
    lb_visible_total: lbAll.size,
    classified_buckets: buckets,
    sum_check: Object.values(buckets).reduce((a,b)=>a+b,0),
    orphan_recovered_via_openphone_or_other_source: {
      via_phone: buckets.state3c_sf_lead_via_phone,
      via_email: buckets.state3d_sf_lead_via_email,
      samples: orphanFromOpenPhone.slice(0, 8),
    },
    truly_no_sf_record: {
      count: buckets.truly_no_record,
      samples: trulyOrphan.slice(0, 12),
    },
  };
  console.log(JSON.stringify(out, null, 2));
})().catch(e => { console.error(e); process.exit(1); });
