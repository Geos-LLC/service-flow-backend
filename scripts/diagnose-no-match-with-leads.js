#!/usr/bin/env node
// READ-ONLY: extends diagnose-no-match.js to ALSO probe SF leads + pipeline
// tables. Required by the product question:
//
//   "no_match" should mean "no SF record exists at all" — not merely
//   "no SF customer/job found." SF has both a leads/pipeline surface and
//   a customers/jobs surface; the historical matcher only looks at the
//   latter.
//
// Per candidate, in addition to phone/email/name lookups on customers,
// also probe SF leads via 4 paths:
//   1. leads.lb_external_request_id = LB.externalRequestId   (strongest, O(1) via index)
//   2. leads.phone ilike '%last10%'
//   3. leads.email ilike LB.email  (skipped for Yelp proxy)
//   4. leads.first_name ilike + leads.last_name ilike (full name only)
//
// Each found lead is annotated with converted_customer_id and (if present)
// the pipeline_id + stage_id so we can tell "true lead-only" vs "converted-
// to-customer-but-matcher-missed".
//
// Output buckets per row:
//   sf_customer_job_match   — current matcher already found a customer
//   sf_lead_only_match      — SF lead exists, converted_customer_id IS NULL
//                             (true pipeline/opportunity state)
//   sf_lead_converted_match — SF lead exists, converted_customer_id IS NOT NULL
//                             (matcher should have found via the customer FK)
//   no_sf_record            — no lead, no customer, no job
//   ambiguous               — multiple SF leads + no disambiguator
//   test_noise              — LB platform=test
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

const PHONE_RE = /\D+/g;
const digitsOf = (s) => typeof s === 'string' ? s.replace(PHONE_RE, '') : '';
const last10   = (s) => { const d = digitsOf(s); return d.length >= 7 ? d.slice(-10) : null; };
const normEmail = (s) => (typeof s === 'string' && s.includes('@')) ? s.trim().toLowerCase() : null;
const isYelpProxy = (e) => typeof e === 'string' && /@messaging\.yelp\.com$/i.test(e.trim());

function classifyName(s) {
  if (typeof s !== 'string') return { kind: 'none', first: null, last: null };
  const t = s.trim();
  if (!t) return { kind: 'none', first: null, last: null };
  const parts = t.split(/\s+/);
  if (parts.length === 1) return { kind: 'first_only', first: parts[0], last: null };
  const lastRaw = parts[parts.length - 1];
  const last = lastRaw.replace(/\.$/, '');
  if (last.length === 1) return { kind: 'first_plus_initial', first: parts[0], last };
  return { kind: 'full', first: parts[0], last };
}

const LEAD_SELECT = 'id, first_name, last_name, email, phone, lb_external_request_id, lb_channel, lb_business_id, converted_customer_id, pipeline_id, stage_id, source, source_raw, created_at, updated_at, converted_at';

async function probeOne(sb, lb) {
  const phone10  = last10(lb.customerPhone);
  const email    = normEmail(lb.customerEmail);
  const yelpProxy = isYelpProxy(lb.customerEmail);
  const name     = classifyName(lb.customerName);

  const probe = {
    leadId: lb.leadId,
    channel: lb.platform,
    name: lb.customerName,
    phone_raw: lb.customerPhone,
    email_raw: lb.customerEmail,
    externalRequestId: lb.externalRequestId,
    businessId: lb.businessId,
    lb_status: lb.status,
    ageDays: lb.ageDays,
    signals: {
      has_phone: !!phone10, has_real_email: !!email && !yelpProxy,
      has_proxy_email: yelpProxy, name_kind: name.kind, has_externalRequestId: !!lb.externalRequestId,
    },
  };

  // 1) matcher — same as before
  let matcher;
  try {
    const r = await findMatchCandidates(sb, { userId: TENANT_ID, input: {
      lb_lead_id: lb.leadId, lb_external_request_id: lb.externalRequestId,
      lb_channel: lb.platform, lb_business_id: lb.businessId,
      customer_phone: lb.customerPhone, customer_email: lb.customerEmail,
      customer_name: lb.customerName, lead_created_at: lb.createdAt,
    }});
    matcher = { count: r.candidates.length };
  } catch (e) { matcher = { error: String(e.message || e) }; }
  probe.matcher = matcher;

  // ── SF leads probes ──────────────────────────────────────────
  const found = new Map();   // dedupe by lead.id
  const note  = {};

  // 2) leads.lb_external_request_id — strongest signal
  if (lb.externalRequestId) {
    const { data, error } = await sb.from('leads').select(LEAD_SELECT)
      .eq('user_id', TENANT_ID).eq('lb_external_request_id', lb.externalRequestId).limit(5);
    if (!error) for (const r of (data || [])) { if (!found.has(r.id)) found.set(r.id, { ...r, _hit: 'externalRequestId' }); }
    note.lookup_lead_by_externalRequestId = (data || []).length;
  }

  // 3) leads.phone ilike '%last10%'
  if (phone10) {
    const { data, error } = await sb.from('leads').select(LEAD_SELECT)
      .eq('user_id', TENANT_ID).ilike('phone', `%${phone10}%`).limit(5);
    if (!error) for (const r of (data || [])) { if (!found.has(r.id)) found.set(r.id, { ...r, _hit: 'phone' }); }
    note.lookup_lead_by_phone = (data || []).length;
  }

  // 4) leads.email ilike (skip proxy)
  if (email && !yelpProxy) {
    const { data, error } = await sb.from('leads').select(LEAD_SELECT)
      .eq('user_id', TENANT_ID).ilike('email', email).limit(5);
    if (!error) for (const r of (data || [])) { if (!found.has(r.id)) found.set(r.id, { ...r, _hit: 'email' }); }
    note.lookup_lead_by_email = (data || []).length;
  }

  // 4b) Yelp proxy email is itself unique per inquiry — try exact match on it
  //     even though customers tables wouldn't carry it. Some flows write the
  //     proxy email onto the lead row.
  if (email && yelpProxy) {
    const { data, error } = await sb.from('leads').select(LEAD_SELECT)
      .eq('user_id', TENANT_ID).ilike('email', email).limit(5);
    if (!error) for (const r of (data || [])) { if (!found.has(r.id)) found.set(r.id, { ...r, _hit: 'yelp_proxy_email_on_lead' }); }
    note.lookup_lead_by_yelp_proxy_email = (data || []).length;
  }

  // 5) leads.first_name + last_name (full names only)
  if (name.kind === 'full' && name.first && name.last) {
    const { data, error } = await sb.from('leads').select(LEAD_SELECT)
      .eq('user_id', TENANT_ID).ilike('first_name', name.first).ilike('last_name', name.last).limit(5);
    if (!error) for (const r of (data || [])) { if (!found.has(r.id)) found.set(r.id, { ...r, _hit: 'first_last_name' }); }
    note.lookup_lead_by_full_name = (data || []).length;
  }

  const leads = Array.from(found.values());

  // Annotate: for any matched lead with a pipeline_id, fetch stage name
  // (one-shot, only for the strongest hit to avoid N+1).
  let pipelineSummary = null;
  if (leads.length > 0) {
    const top = leads.find(l => l._hit === 'externalRequestId') || leads[0];
    if (top.pipeline_id && top.stage_id) {
      const { data: stage } = await sb.from('lead_stages')
        .select('id, name, position').eq('id', top.stage_id).maybeSingle();
      pipelineSummary = { lead_id: top.id, pipeline_id: top.pipeline_id, stage_id: top.stage_id, stage_name: stage && stage.name };
    } else if (top.pipeline_id) {
      pipelineSummary = { lead_id: top.id, pipeline_id: top.pipeline_id, stage_id: null, stage_name: null };
    }
  }

  probe.sf_leads_found    = leads.length;
  probe.sf_lead_hit_paths = leads.map(l => l._hit);
  probe.sf_leads          = leads.map(l => ({
    id: l.id, first_name: l.first_name, last_name: l.last_name,
    phone: l.phone, email: l.email,
    lb_external_request_id: l.lb_external_request_id,
    lb_channel: l.lb_channel, lb_business_id: l.lb_business_id,
    converted_customer_id: l.converted_customer_id,
    pipeline_id: l.pipeline_id, stage_id: l.stage_id,
    source: l.source, source_raw: l.source_raw,
    created_at: l.created_at, converted_at: l.converted_at,
    _hit: l._hit,
  }));
  probe.lookup = note;
  probe.pipelineSummary = pipelineSummary;

  // Bucket
  let bucket;
  if (probe.channel === 'test')                                                                    bucket = 'test_noise';
  else if (matcher && !matcher.error && matcher.count > 0)                                         bucket = 'sf_customer_job_match';
  else if (leads.length === 0)                                                                      bucket = 'no_sf_record';
  else if (leads.length >= 2 && !leads.some(l => l._hit === 'externalRequestId'))                  bucket = 'ambiguous';
  else if (leads.some(l => l.converted_customer_id != null))                                       bucket = 'sf_lead_converted_match';   // matcher should have found via customer
  else                                                                                              bucket = 'sf_lead_only_match';
  probe.bucket = bucket;
  return probe;
}

(async () => {
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  process.stderr.write('Fetching LB pending candidates…\n');
  const r = await fetchCandidates({ lbUserId: LB_USER_UUID, syncStatuses: ['pending'], limit: 500 });
  if (!r.ok) { process.stderr.write('LB fetch failed\n'); process.exit(2); }
  const all = r.candidates || [];
  process.stderr.write(`Fetched ${all.length}. Probing each against SF customers + leads…\n`);

  const results = [];
  let jillTrace = null;
  let i = 0;
  for (const lb of all) {
    i++;
    if (i % 25 === 0) process.stderr.write(`  ${i}/${all.length}\n`);
    const p = await probeOne(sb, lb);
    results.push(p);
    if (lb.leadId === TARGET_JILL) jillTrace = p;
  }
  process.stderr.write('Done.\n');

  const bucketCounts = {};
  for (const r of results) bucketCounts[r.bucket] = (bucketCounts[r.bucket] || 0) + 1;
  const noCustomerSet = results.filter(r => r.bucket !== 'sf_customer_job_match' && r.bucket !== 'test_noise');
  const channelCross = {};
  for (const r of noCustomerSet) {
    const k = (r.channel || '<null>') + '__' + r.bucket;
    channelCross[k] = (channelCross[k] || 0) + 1;
  }

  // Top sample per bucket
  const samples = Object.fromEntries(
    Object.keys(bucketCounts).map(b => [b,
      results.filter(r => r.bucket === b).slice(0, 3).map(r => ({
        leadId: r.leadId, name: r.name, channel: r.channel, phone: r.phone_raw, email: r.email_raw,
        externalRequestId: r.externalRequestId, ageDays: r.ageDays,
        matcher_count: r.matcher && r.matcher.count,
        sf_leads_found: r.sf_leads_found, hits: r.sf_lead_hit_paths,
        sf_leads_summary: r.sf_leads.map(l => ({
          id: l.id, name: (l.first_name || '') + ' ' + (l.last_name || ''),
          phone: l.phone, email: l.email,
          converted_customer_id: l.converted_customer_id,
          stage_id: l.stage_id, source: l.source, hit: l._hit,
        })),
      }))
    ])
  );

  const out = {
    fetched: all.length,
    bucket_counts: bucketCounts,
    channel_x_bucket_excl_customer_and_test: channelCross,
    samples,
    jill_trace: jillTrace,
  };
  console.log(JSON.stringify(out, null, 2));
})().catch(e => { console.error(e); process.exit(1); });
