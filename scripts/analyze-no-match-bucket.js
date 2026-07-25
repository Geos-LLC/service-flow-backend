#!/usr/bin/env node
// READ-ONLY analysis: pull LB's pending candidates with full PII fields
// (phone/email/name) so we can root-cause the no_match bucket without
// going through the SF response — which strips PII after matching.
//
// Hits LB's existing /v1/integrations/sf/historical-sync/candidates
// endpoint with the SF provisioning HMAC. Same read SF already does on
// every dry-run, just bypassing the SF response stripper.
//
// Reads nothing from Supabase. Writes nothing.
//
// Usage:
//   SF_LB_PROVISIONING_SHARED_SECRET=... LB_USER_UUID=... node scripts/analyze-no-match-bucket.js > analysis.json

'use strict';

process.env.SF_LB_PROVISIONING_SHARED_SECRET = process.env.SF_LB_PROVISIONING_SHARED_SECRET || '';
process.env.LB_PROVISIONING_BASE_URL          = process.env.LB_PROVISIONING_BASE_URL || 'https://thumbtack-bridge-production.up.railway.app/api';

const { fetchCandidates } = require('../lib/lb-historical-sync-client');

const PHONE_DIGITS = /\D+/g;
const normPhoneLast10 = (s) => {
  if (typeof s !== 'string') return null;
  const d = s.replace(PHONE_DIGITS, '');
  return d.length >= 7 ? d.slice(-10) : null;
};
const normEmail = (s) => (typeof s === 'string' && s.includes('@')) ? s.trim().toLowerCase() : null;

function classifyName(s) {
  if (typeof s !== 'string') return 'none';
  const t = s.trim();
  if (!t) return 'none';
  const parts = t.split(/\s+/);
  if (parts.length === 1) return 'first_only';
  // Yelp displays "Jill S." — last token is one letter + optional period
  const last = parts[parts.length - 1].replace(/\.$/, '');
  if (last.length === 1) return 'first_plus_initial';
  return 'full';
}

(async () => {
  const lbUserId = process.env.LB_USER_UUID;
  if (!lbUserId) { console.error('LB_USER_UUID required'); process.exit(2); }
  if (!process.env.SF_LB_PROVISIONING_SHARED_SECRET) { console.error('SF_LB_PROVISIONING_SHARED_SECRET required'); process.exit(2); }

  const r = await fetchCandidates({ lbUserId, syncStatuses: ['pending'], limit: 500 });
  if (!r.ok) { console.error('fetch failed:', r); process.exit(3); }

  const candidates = r.candidates || [];

  const stat = {
    fetched: candidates.length,
    has_phone:           0,
    has_email:           0,
    has_phone_or_email:  0,
    name_classification: { full: 0, first_only: 0, first_plus_initial: 0, none: 0 },
    by_channel:          {},
    by_lb_status:        {},
    age_bands:           { lt_30d: 0, '30_to_90d': 0, '90_to_180d': 0, gt_180d: 0 },
    test_channel_rows:   0,
  };

  // Root-cause categorisation — exclusive bucket per row, ordered by
  // strongest matching signal availability.
  const rootCause = {
    has_strong_signals_phone_or_email_present:  0,    // phone OR email present — matcher SHOULD have found something
    full_name_only_no_phone_no_email:           0,    // matcher needs name + date proximity — possible with improvement
    first_plus_initial_no_phone_no_email:       0,    // Yelp display name, irrecoverable from LB data
    first_name_only_no_phone_no_email:          0,    // first name only — irrecoverable
    no_name_at_all_no_phone_no_email:           0,    // total information void
    test_channel:                                0,   // LB cross-channel test rows — never real
  };

  const samples = { first_plus_initial: [], full_name_only: [], has_strong_signals: [] };

  for (const c of candidates) {
    const phone = normPhoneLast10(c.customerPhone);
    const email = normEmail(c.customerEmail);
    const nameClass = classifyName(c.customerName);

    if (phone) stat.has_phone++;
    if (email) stat.has_email++;
    if (phone || email) stat.has_phone_or_email++;
    stat.name_classification[nameClass]++;
    stat.by_channel[c.platform || '<null>'] = (stat.by_channel[c.platform || '<null>'] || 0) + 1;
    stat.by_lb_status[c.status || '<null>'] = (stat.by_lb_status[c.status || '<null>'] || 0) + 1;

    const age = Number.isFinite(c.ageDays) ? c.ageDays : null;
    if (age != null) {
      if (age < 30) stat.age_bands.lt_30d++;
      else if (age < 90) stat.age_bands['30_to_90d']++;
      else if (age < 180) stat.age_bands['90_to_180d']++;
      else stat.age_bands.gt_180d++;
    }

    if (c.platform === 'test') { stat.test_channel_rows++; rootCause.test_channel++; continue; }
    if (phone || email)       { rootCause.has_strong_signals_phone_or_email_present++;
                                if (samples.has_strong_signals.length < 3) samples.has_strong_signals.push({leadId:c.leadId, name:c.customerName, phone:c.customerPhone, email:c.customerEmail, channel:c.platform, status:c.status, ageDays:age});
                                continue; }
    if (nameClass === 'full')               { rootCause.full_name_only_no_phone_no_email++;
                                              if (samples.full_name_only.length < 3) samples.full_name_only.push({leadId:c.leadId, name:c.customerName, channel:c.platform, status:c.status, ageDays:age});
                                              continue; }
    if (nameClass === 'first_plus_initial') { rootCause.first_plus_initial_no_phone_no_email++;
                                              if (samples.first_plus_initial.length < 3) samples.first_plus_initial.push({leadId:c.leadId, name:c.customerName, channel:c.platform, status:c.status, ageDays:age});
                                              continue; }
    if (nameClass === 'first_only')         { rootCause.first_name_only_no_phone_no_email++; continue; }
    rootCause.no_name_at_all_no_phone_no_email++;
  }

  // Calculate percentages over the total no_match-likely set (everything
  // that lands in no_match because matcher can't return a candidate). We
  // estimate no_match-likely as: fetched - has_phone_or_email - (where
  // strong signals exist matcher might still classify as low_conf or no_match
  // — see classification).
  //
  // Better: rely on the staging dry-run we already ran, which counted
  // exact bucket per row (242 no_match). We surface that count for the
  // reader's benefit and provide percentages over fetched.
  const out = {
    lb_user_id: lbUserId,
    fetched_pending: stat.fetched,
    stats: stat,
    root_cause_no_match_likely: rootCause,
    samples,
    pct_of_fetched: Object.fromEntries(Object.entries(rootCause).map(([k,v]) => [k, +(100*v/stat.fetched).toFixed(1)])),
  };

  console.log(JSON.stringify(out, null, 2));
})();
