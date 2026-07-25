#!/usr/bin/env node
// READ-ONLY: for each LB pending candidate, run the matcher AND a set of
// fallback SF queries to see whether SF has the data and the matcher
// simply missed it. Produces pattern-group counts + Jill-S trace.
//
// Probes per candidate:
//   1. matcher result (uses current findMatchCandidates)
//   2. SF customers ilike phone last10 — same query the matcher uses
//   3. SF customers WHERE digits-only(phone) = digits-only(LB.phone) — broader
//      (catches SF rows where phone is stored as +14155551234 vs "415 555 1234")
//   4. SF customers ilike email — same as matcher
//   5. SF jobs WHERE lb_external_request_id = LB.externalRequestId — NEW path
//      the matcher does NOT use today
//   6. SF jobs WHERE lb_business_id = LB.businessId AND ageDays-window — NEW
//   7. SF customers ilike first_name only (when LB last is initial / missing)
//   8. SF customers full_text on name fragment (substring)
//
// Each row is classified into ONE pattern bucket (priority order: strongest
// recoverable signal first).
//
// No SF writes. No LB writes (just the read-only candidates fetch).

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
const last10  = (s) => { const d = digitsOf(s); return d.length >= 7 ? d.slice(-10) : null; };
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

async function probeOne(sb, lb) {
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
  };

  const phone10 = last10(lb.customerPhone);
  const email   = normEmail(lb.customerEmail);
  const yelpProxy = isYelpProxy(lb.customerEmail);
  const name = classifyName(lb.customerName);
  probe.signals = {
    has_phone:           !!phone10,
    has_email:           !!email,
    has_real_email:      !!email && !yelpProxy,
    has_proxy_email:     yelpProxy,
    name_kind:           name.kind,
    has_full_name:       name.kind === 'full',
    has_externalRequestId: !!lb.externalRequestId,
    has_businessId:      !!lb.businessId,
  };

  // 1) Current matcher result
  let matcher;
  try {
    const r = await findMatchCandidates(sb, { userId: TENANT_ID, input: {
      lb_lead_id: lb.leadId, lb_external_request_id: lb.externalRequestId,
      lb_channel: lb.platform, lb_business_id: lb.businessId,
      customer_phone: lb.customerPhone, customer_email: lb.customerEmail,
      customer_name: lb.customerName, lead_created_at: lb.createdAt,
    }});
    matcher = { count: r.candidates.length, confidences: r.candidates.map(c => c.confidence) };
  } catch (e) { matcher = { error: String(e.message || e) }; }
  probe.matcher = matcher;

  // 2) SF customers matching phone last10 substring (mirror of matcher)
  let phoneIlike = { count: 0 };
  if (phone10) {
    const { data } = await sb.from('customers')
      .select('id, first_name, last_name, phone, email, lb_lead_id, created_at')
      .eq('user_id', TENANT_ID).ilike('phone', `%${phone10}%`).limit(5);
    phoneIlike = { count: (data || []).length, rows: data || [] };
  }
  probe.lookup_phone_ilike = phoneIlike;

  // 3) BROADER phone match: strip non-digits from SF phone and compare last 10
  //    Cannot do this in SQL portably without a function; instead, query by
  //    each segment of last10 and compare in JS. Cheaper alternative: query
  //    by trigrams. We approximate by also trying split formats.
  let phoneFormatted = { count: 0 };
  if (phone10) {
    const p = phone10;
    const pretty = `(${p.slice(0,3)}) ${p.slice(3,6)}-${p.slice(6)}`;
    const dashed = `${p.slice(0,3)}-${p.slice(3,6)}-${p.slice(6)}`;
    const e164   = `+1${p}`;
    const spaced = `${p.slice(0,3)} ${p.slice(3,6)} ${p.slice(6)}`;
    const candidates = [pretty, dashed, e164, spaced];
    const seen = new Map();
    for (const c of candidates) {
      const { data } = await sb.from('customers')
        .select('id, first_name, last_name, phone').eq('user_id', TENANT_ID).ilike('phone', `%${c}%`).limit(3);
      for (const r of (data || [])) if (!seen.has(r.id)) seen.set(r.id, r);
    }
    phoneFormatted = { count: seen.size, rows: Array.from(seen.values()) };
  }
  probe.lookup_phone_formatted = phoneFormatted;

  // 4) Email ilike (mirror of matcher)
  let emailIlike = { count: 0 };
  if (email && !yelpProxy) {
    const { data } = await sb.from('customers')
      .select('id, first_name, last_name, email').eq('user_id', TENANT_ID).ilike('email', email).limit(5);
    emailIlike = { count: (data || []).length, rows: data || [] };
  }
  probe.lookup_email_ilike = emailIlike;

  // 5) jobs.lb_external_request_id — the matcher does NOT use this today
  let jobByExtId = { count: 0 };
  if (lb.externalRequestId) {
    const { data } = await sb.from('jobs')
      .select('id, customer_id, status, payment_status, scheduled_date, lb_external_request_id, lb_lead_id, lb_business_id, lb_channel, created_at')
      .eq('user_id', TENANT_ID).eq('lb_external_request_id', lb.externalRequestId).limit(5);
    jobByExtId = { count: (data || []).length, rows: data || [] };
  }
  probe.lookup_job_by_externalRequestId = jobByExtId;

  // 6) jobs.lb_business_id within ±30d of lead.createdAt — also unused today
  let jobByBiz = { count: 0 };
  if (lb.businessId && lb.createdAt) {
    const t = new Date(lb.createdAt).getTime();
    const lo = new Date(t - 30 * 86400_000).toISOString();
    const hi = new Date(t + 30 * 86400_000).toISOString();
    const { data } = await sb.from('jobs')
      .select('id, customer_id, status, lb_business_id, lb_channel, lb_lead_id, lb_external_request_id, created_at, scheduled_date')
      .eq('user_id', TENANT_ID).eq('lb_business_id', lb.businessId)
      .gte('created_at', lo).lte('created_at', hi).limit(5);
    jobByBiz = { count: (data || []).length };
  }
  probe.lookup_job_by_businessId = jobByBiz;

  // 7) first_name only (for first+initial / first_only LB names)
  let firstNameOnly = { count: 0 };
  if (name.first && (name.kind === 'first_only' || name.kind === 'first_plus_initial')) {
    const { data } = await sb.from('customers')
      .select('id, first_name, last_name, phone, email').eq('user_id', TENANT_ID).ilike('first_name', name.first).limit(20);
    firstNameOnly = { count: (data || []).length };
  }
  probe.lookup_first_name_only = firstNameOnly;

  // ── Pattern bucketing — priority order, first match wins
  let pattern;
  if (probe.channel === 'test')                                                              pattern = 'test_noise_row';
  else if (matcher && matcher.count > 0)                                                     pattern = 'matcher_actually_matched';   // shouldn't happen for no_match set
  else if (jobByExtId.count > 0)                                                             pattern = 'job_has_externalRequestId_matcher_blind';
  else if (jobByBiz.count > 0 && (name.kind === 'first_plus_initial' || !phone10))           pattern = 'job_in_biz_window_no_other_signal';
  else if (phoneIlike.count > 0)                                                             pattern = 'phone_matched_but_matcher_did_not_score';
  else if (phoneFormatted.count > 0)                                                         pattern = 'phone_normalization_miss';
  else if (emailIlike.count > 0)                                                             pattern = 'email_matched_but_matcher_did_not_score';
  else if (firstNameOnly.count > 0 && name.kind === 'first_plus_initial')                    pattern = 'first_plus_initial_recoverable_via_first_only';
  else if (phone10 && phoneFormatted.count === 0 && phoneIlike.count === 0 && emailIlike.count === 0) pattern = 'true_no_sf_customer_strong_signal_present';
  else if (yelpProxy && !phone10)                                                            pattern = 'yelp_proxy_email_only_unmatchable';
  else if (name.kind === 'first_plus_initial' && !phone10 && !email)                         pattern = 'yelp_display_name_only_unmatchable';
  else if (name.kind === 'first_only' && !phone10 && !email)                                 pattern = 'first_name_only_unmatchable';
  else                                                                                       pattern = 'true_no_sf_customer';
  probe.pattern = pattern;

  return probe;
}

(async () => {
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  process.stderr.write('Fetching LB pending candidates...\n');
  const r = await fetchCandidates({ lbUserId: LB_USER_UUID, syncStatuses: ['pending'], limit: 500 });
  if (!r.ok) { process.stderr.write('LB fetch failed\n'); process.exit(2); }
  const all = r.candidates || [];
  process.stderr.write(`Fetched ${all.length}. Probing each against SF...\n`);

  const results = [];
  let jillTrace = null;
  let i = 0;
  for (const lb of all) {
    i++;
    if (i % 25 === 0) process.stderr.write(`  ${i}/${all.length}\n`);
    const probe = await probeOne(sb, lb);
    results.push(probe);
    if (lb.leadId === TARGET_JILL) jillTrace = probe;
  }
  process.stderr.write(`Done. ${results.length} probes.\n`);

  // Aggregate
  const patternCounts = {};
  for (const p of results) patternCounts[p.pattern] = (patternCounts[p.pattern] || 0) + 1;

  // Also: count no_match-only rows (filter matcher.count===0)
  const noMatchOnly = results.filter(p => !p.matcher || p.matcher.error || p.matcher.count === 0);
  const noMatchPatternCounts = {};
  for (const p of noMatchOnly) noMatchPatternCounts[p.pattern] = (noMatchPatternCounts[p.pattern] || 0) + 1;

  // Channel × pattern crosstab on no_match rows
  const crosstab = {};
  for (const p of noMatchOnly) {
    const k = (p.channel || '<null>') + '__' + p.pattern;
    crosstab[k] = (crosstab[k] || 0) + 1;
  }

  // Signal availability among no_match rows
  const sig = { has_phone: 0, has_real_email: 0, has_proxy_email: 0, has_full_name: 0, has_externalRequestId: 0 };
  for (const p of noMatchOnly) {
    for (const k of Object.keys(sig)) if (p.signals[k]) sig[k]++;
  }

  const out = {
    fetched: all.length,
    no_match_count: noMatchOnly.length,
    matcher_match_count: results.length - noMatchOnly.length,
    overall_pattern_counts: patternCounts,
    no_match_pattern_counts: noMatchPatternCounts,
    no_match_channel_x_pattern: crosstab,
    no_match_signal_availability: sig,
    jill_trace: jillTrace,
    sample_per_pattern: Object.fromEntries(
      Object.keys(noMatchPatternCounts).map(k => [
        k,
        noMatchOnly.filter(p => p.pattern === k).slice(0, 3).map(p => ({
          leadId: p.leadId, name: p.name, channel: p.channel, phone: p.phone_raw, email: p.email_raw,
          externalRequestId: p.externalRequestId, businessId: p.businessId, ageDays: p.ageDays,
          lookup_phone_ilike: p.lookup_phone_ilike.count,
          lookup_phone_formatted: p.lookup_phone_formatted.count,
          lookup_email_ilike: p.lookup_email_ilike.count,
          lookup_job_by_externalRequestId: p.lookup_job_by_externalRequestId.count,
          lookup_job_by_businessId: p.lookup_job_by_businessId.count,
          lookup_first_name_only: p.lookup_first_name_only.count,
        })),
      ])
    ),
  };

  console.log(JSON.stringify(out, null, 2));
})().catch(e => { console.error(e); process.exit(1); });
