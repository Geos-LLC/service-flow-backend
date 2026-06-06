#!/usr/bin/env node
// READ-ONLY: simulates the CORRECTED matcher (leads-first) against all
// LB pending candidates so we can report dry-run counts under the
// joint-design model BEFORE writing any code in lb-lead-link-matcher.js.
//
// Decision tree per candidate (mirrors the proposed matcher contract):
//
//   1. SF leads WHERE lb_external_request_id = LB.externalRequestId
//      → if FOUND:
//          if converted_customer_id IS NULL  → match_type = 'lead_only'
//          else                              → match_type = 'customer_job' (via leads.converted_customer_id)
//      → if NOT FOUND, continue
//
//   2. SF customers/jobs via existing matcher (phone/email/name)
//      → if matcher returns ≥1 candidate → match_type = 'customer_job'
//      → if multiple                     → would_review
//
//   3. SF jobs WHERE lb_external_request_id (additional fallback)
//      → if FOUND → match_type = 'customer_job'
//
//   4. Otherwise → match_type = 'no_match' (truly no SF record)
//
//   `platform='test'` always → match_type = 'test_noise' (filtered)
//
// No SF writes. No LB writes.

'use strict';

const fs = require('fs');
const path = require('path');

const envFile = path.join(process.env.USERPROFILE, '.sf-prod-env.json');
const env = JSON.parse(fs.readFileSync(envFile, 'utf8'));
process.env.SUPABASE_URL                      = env.SUPABASE_URL;
process.env.SUPABASE_SERVICE_ROLE_KEY         = env.SUPABASE_SERVICE_ROLE_KEY;
process.env.SF_LB_PROVISIONING_SHARED_SECRET  = env.SF_LB_PROVISIONING_SHARED_SECRET;
process.env.LB_PROVISIONING_BASE_URL          = 'https://thumbtack-bridge-production.up.railway.app/api';

const { createClient } = require('@supabase/supabase-js');
const { fetchCandidates } = require('../lib/lb-historical-sync-client');
const { findMatchCandidates } = require('../lib/lb-lead-link-matcher');

const TENANT_ID = 2;
const LB_USER_UUID = 'c3d14499-dec1-42c3-a36c-713cb09842c6';
const TARGET_JILL = 'b5109475-396c-47a6-88de-c9d8270fe20a';

const LEAD_SELECT = 'id, first_name, last_name, email, phone, lb_external_request_id, lb_channel, lb_business_id, converted_customer_id, pipeline_id, stage_id, source, created_at, converted_at';
const JOB_SELECT  = 'id, customer_id, status, payment_status, lb_external_request_id, lb_lead_id, created_at';

async function classifyOne(sb, lb) {
  if (lb.platform === 'test') return { bucket: 'test_noise', match_type: 'test_noise', reason: 'lb_test_channel' };

  // STEP 1: leads.lb_external_request_id direct match
  if (lb.externalRequestId) {
    const { data: leads } = await sb.from('leads').select(LEAD_SELECT)
      .eq('user_id', TENANT_ID).eq('lb_external_request_id', lb.externalRequestId).limit(5);
    if (leads && leads.length > 0) {
      if (leads.length > 1) {
        return { bucket: 'ambiguous_lead', match_type: 'ambiguous', reason: 'multiple_sf_leads_for_externalRequestId', sf_leads: leads };
      }
      const lead = leads[0];
      if (lead.converted_customer_id != null) {
        // Customer/job match — get one representative job for the customer
        const { data: jobs } = await sb.from('jobs').select(JOB_SELECT)
          .eq('user_id', TENANT_ID).eq('customer_id', lead.converted_customer_id).order('created_at', { ascending: true }).limit(20);
        const repJob = pickRepresentativeJob(jobs || []);
        // If any other job for this customer already pins to a DIFFERENT lb_lead_id, surface as needs_review
        const otherLink = (jobs || []).find(j => j.lb_lead_id && j.lb_lead_id !== lb.leadId);
        if (otherLink) {
          return { bucket: 'needs_review', match_type: 'customer_job', reason: 'customer_already_linked_to_different_lb_lead',
                   sf_lead: lead, sf_customer_id: lead.converted_customer_id, sf_job_id: repJob ? repJob.id : null };
        }
        return { bucket: 'customer_job_match', match_type: 'customer_job', reason: 'sf_lead_converted',
                 sf_lead: lead, sf_customer_id: lead.converted_customer_id, sf_job_id: repJob ? repJob.id : null };
      }
      // Lead exists, not converted → lead_only
      return { bucket: 'lead_only_match', match_type: 'lead_only', reason: 'sf_lead_via_externalRequestId',
               sf_lead: lead };
    }
  }

  // STEP 2: fall back to existing matcher (customer/job phone/email/name)
  let matched = [];
  try {
    const r = await findMatchCandidates(sb, { userId: TENANT_ID, input: {
      lb_lead_id: lb.leadId, lb_external_request_id: lb.externalRequestId,
      lb_channel: lb.platform, lb_business_id: lb.businessId,
      customer_phone: lb.customerPhone, customer_email: lb.customerEmail,
      customer_name: lb.customerName, lead_created_at: lb.createdAt,
    }});
    matched = r.candidates || [];
  } catch (e) { return { bucket: 'failed', match_type: 'failed', reason: 'matcher_error', error: String(e.message || e) }; }
  if (matched.length === 1) {
    const c = matched[0];
    return { bucket: 'customer_job_match', match_type: 'customer_job', reason: 'phone_or_email_or_name',
             sf_customer_id: c.sf_customer_id, sf_job_id: c.sf_job_id, confidence: c.confidence };
  }
  if (matched.length > 1) {
    return { bucket: 'needs_review', match_type: 'customer_job', reason: 'multiple_candidates' };
  }

  // STEP 3: jobs.lb_external_request_id (additional fallback)
  if (lb.externalRequestId) {
    const { data: jobs } = await sb.from('jobs').select(JOB_SELECT)
      .eq('user_id', TENANT_ID).eq('lb_external_request_id', lb.externalRequestId).limit(5);
    if (jobs && jobs.length === 1) {
      return { bucket: 'customer_job_match', match_type: 'customer_job', reason: 'job_externalRequestId',
               sf_customer_id: jobs[0].customer_id, sf_job_id: jobs[0].id };
    }
    if (jobs && jobs.length > 1) return { bucket: 'needs_review', match_type: 'customer_job', reason: 'multiple_jobs_for_externalRequestId' };
  }

  // No SF record at all
  return { bucket: 'no_sf_record', match_type: 'no_match', reason: 'no_sf_record_anywhere' };
}

function pickRepresentativeJob(jobs) {
  if (jobs.length === 0) return null;
  // Prefer earliest completed+paid, then earliest completed, then scheduled/booked, then earliest
  const completedPaid = jobs.filter(j => j.status === 'completed' && j.payment_status === 'paid');
  if (completedPaid.length > 0) return completedPaid[0];
  const completed = jobs.filter(j => j.status === 'completed');
  if (completed.length > 0) return completed[0];
  const lifecycle = jobs.filter(j => ['scheduled','booked','in_progress'].includes(j.status));
  if (lifecycle.length > 0) return lifecycle[0];
  return null;
}

(async () => {
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  process.stderr.write('Fetching LB pending candidates…\n');
  const r = await fetchCandidates({ lbUserId: LB_USER_UUID, syncStatuses: ['pending'], limit: 500 });
  if (!r.ok) { process.stderr.write('LB fetch failed\n'); process.exit(2); }
  const all = r.candidates || [];
  process.stderr.write(`Fetched ${all.length}. Running corrected matcher…\n`);

  const out = [];
  let jillTrace = null;
  let i = 0;
  for (const lb of all) {
    i++;
    if (i % 50 === 0) process.stderr.write(`  ${i}/${all.length}\n`);
    const res = await classifyOne(sb, lb);
    res.leadId = lb.leadId;
    res.lb_customer_name = lb.customerName;
    res.lb_channel = lb.platform;
    res.lb_externalRequestId = lb.externalRequestId;
    res.lb_status = lb.status;
    res.lb_ageDays = lb.ageDays;
    out.push(res);
    if (lb.leadId === TARGET_JILL) jillTrace = res;
  }
  process.stderr.write('Done.\n');

  const counts = {};
  for (const r of out) counts[r.bucket] = (counts[r.bucket] || 0) + 1;
  const channelXbucket = {};
  for (const r of out) {
    const k = (r.lb_channel || '<null>') + '__' + r.bucket;
    channelXbucket[k] = (channelXbucket[k] || 0) + 1;
  }
  const samples = Object.fromEntries(
    Object.keys(counts).map(b => [b, out.filter(r => r.bucket === b).slice(0, 3)])
  );

  console.log(JSON.stringify({
    fetched: all.length,
    bucket_counts: counts,
    channel_x_bucket: channelXbucket,
    samples,
    jill_trace: jillTrace,
  }, null, 2));
})().catch(e => { console.error(e); process.exit(1); });
