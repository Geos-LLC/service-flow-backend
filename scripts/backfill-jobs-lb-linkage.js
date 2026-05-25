'use strict';

// backfill-jobs-lb-linkage.js
//
// Dry-run + apply tool that repairs `jobs.lb_external_request_id` /
// `jobs.lb_channel` on existing rows by tracing customer → lead linkage.
//
// Defaults to DRY-RUN. Pass --apply only after the report is reviewed and
// approved. Per the task spec, apply is HIGH-confidence only.
//
// Usage:
//   node scripts/backfill-jobs-lb-linkage.js [--user 2] [--apply] [--limit N] [--json]
//
// Read paths (always):
//   1. jobs WHERE lb_external_request_id IS NULL (within user scope)
//   2. customers via jobs.customer_id (rejects jobs without a customer)
//   3. leads WHERE converted_customer_id = customer_id
//      → must yield exactly ONE LB-linked lead; ambiguity = skip
//   4. identity-graph cross-check (best-effort): identity.sf_customer_id
//      links to the same customer AND identity.sf_lead_id links to that
//      lead, raising the confidence to HIGH. If the identity-graph
//      disagrees, the candidate is downgraded to MANUAL_REVIEW.
//
// Confidence tiers:
//   HIGH          — exactly one LB-linked lead AND identity-graph agrees
//                    (or identity has no record either way). Safe to apply.
//   MEDIUM        — exactly one LB-linked lead but identity-graph absent.
//                    Skipped by --apply; ship via separate operator review.
//   AMBIGUOUS     — multiple LB-linked leads with different external ids.
//                    NEVER auto-applied. Report-only.
//   MISSING       — no lead or lead has no LB linkage. Nothing to do.
//
// Hard constraints — does NOT:
//   - mutate leads, customers, identities
//   - touch outbound queue, send SF→LB events, or replay anything
//   - alter status, ledger, or any non-(lb_external_request_id, lb_channel) column
//   - run when --apply is set without explicit confirmation flag in env or argv

const { createClient } = require('@supabase/supabase-js');

function parseArgs(argv) {
  const out = { userId: null, apply: false, limit: null, json: false, confirm: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') out.apply = true;
    else if (a === '--json') out.json = true;
    else if (a === '--confirm-apply') out.confirm = true;
    else if (a === '--user' || a === '-u') out.userId = argv[++i];
    else if (a === '--limit' || a === '-l') out.limit = parseInt(argv[++i], 10);
    else if (a === '--help' || a === '-h') {
      console.log('Usage: node scripts/backfill-jobs-lb-linkage.js [--user 2] [--apply --confirm-apply] [--limit N] [--json]');
      process.exit(0);
    }
  }
  return out;
}

async function fetchUnlinkedJobs(supabase, userId, limit) {
  let q = supabase
    .from('jobs')
    .select('id, user_id, customer_id, status, created_at, last_status_source, lb_external_request_id, lb_channel')
    .is('lb_external_request_id', null);
  if (userId != null) q = q.eq('user_id', userId);
  q = q.order('created_at', { ascending: false });
  // Supabase default limit is 1000 — paginate manually if no --limit.
  const pageSize = Math.min(limit || 1000, 1000);
  const out = [];
  let from = 0;
  while (true) {
    const { data, error } = await q.range(from, from + pageSize - 1);
    if (error) throw new Error(`jobs query failed: ${error.message}`);
    if (!data || data.length === 0) break;
    out.push(...data);
    if (limit && out.length >= limit) return out.slice(0, limit);
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return out;
}

async function fetchLeadsForCustomers(supabase, userId, customerIds) {
  if (customerIds.length === 0) return new Map();
  // Batch in 200s to keep the IN list small.
  const map = new Map(); // customer_id → leads[]
  for (let i = 0; i < customerIds.length; i += 200) {
    const slice = customerIds.slice(i, i + 200);
    const { data, error } = await supabase
      .from('leads')
      .select('id, user_id, converted_customer_id, lb_external_request_id, lb_channel, lb_business_id, lb_provider_account_id')
      .eq('user_id', userId)
      .in('converted_customer_id', slice);
    if (error) throw new Error(`leads query failed: ${error.message}`);
    for (const lead of data || []) {
      const k = String(lead.converted_customer_id);
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(lead);
    }
  }
  return map;
}

async function fetchIdentityGraph(supabase, userId, customerIds) {
  if (customerIds.length === 0) return new Map();
  const map = new Map(); // customer_id → { sf_lead_id, sf_customer_id }
  for (let i = 0; i < customerIds.length; i += 200) {
    const slice = customerIds.slice(i, i + 200);
    const { data, error } = await supabase
      .from('communication_participant_identities')
      .select('id, user_id, sf_customer_id, sf_lead_id')
      .eq('user_id', userId)
      .in('sf_customer_id', slice);
    if (error) {
      // Identity graph cross-check is best-effort — log and continue.
      console.warn(`[backfill] identity lookup failed: ${error.message}`);
      return map;
    }
    for (const id of data || []) {
      const k = String(id.sf_customer_id);
      if (!map.has(k)) map.set(k, id);
    }
  }
  return map;
}

function classify(job, leads, identity) {
  if (job.customer_id == null) {
    return { tier: 'MISSING', reason: 'no_customer', leadId: null, link: null };
  }
  if (!leads || leads.length === 0) {
    return { tier: 'MISSING', reason: 'no_lead', leadId: null, link: null };
  }
  const linked = leads.filter((l) => l.lb_external_request_id != null);
  if (linked.length === 0) {
    return { tier: 'MISSING', reason: 'lead_unlinked', leadId: leads[0].id, link: null };
  }
  if (linked.length > 1) {
    const distinct = new Set(linked.map((l) => `${l.lb_external_request_id}|${l.lb_channel || ''}`));
    if (distinct.size > 1) {
      return {
        tier: 'AMBIGUOUS',
        reason: 'multiple_distinct_lb_leads',
        leadId: null,
        link: null,
        candidates: linked.map((l) => ({
          lead_id: l.id,
          external_request_id: l.lb_external_request_id,
          channel: l.lb_channel,
        })),
      };
    }
    // Multiple leads agree — treat as single match.
  }
  const winner = linked[0];
  const link = {
    lb_external_request_id: winner.lb_external_request_id,
    lb_channel: winner.lb_channel,
    lb_business_id: winner.lb_business_id || null,
    lb_provider_account_id: winner.lb_provider_account_id ?? null,
  };
  // Identity-graph cross-check.
  if (identity) {
    const sfLead = identity.sf_lead_id != null ? String(identity.sf_lead_id) : null;
    const expected = String(winner.id);
    if (sfLead != null && sfLead !== expected) {
      return { tier: 'MANUAL_REVIEW', reason: 'identity_disagrees', leadId: winner.id, link, identitySfLeadId: identity.sf_lead_id };
    }
    return { tier: 'HIGH', reason: 'lead_match_identity_agrees', leadId: winner.id, link };
  }
  return { tier: 'MEDIUM', reason: 'lead_match_no_identity', leadId: winner.id, link };
}

async function applyHigh(supabase, candidate, logger) {
  // Defense-in-depth: re-read the job, refuse if it gained a linkage in
  // the meantime or its customer_id changed.
  const { data: current, error: readErr } = await supabase
    .from('jobs')
    .select('id, user_id, customer_id, lb_external_request_id, lb_channel')
    .eq('id', candidate.job.id)
    .eq('user_id', candidate.job.user_id)
    .maybeSingle();
  if (readErr || !current) {
    return { ok: false, reason: `reread_failed:${readErr?.message || 'not_found'}` };
  }
  if (current.lb_external_request_id != null) {
    return { ok: false, reason: 'already_linked' };
  }
  if (String(current.customer_id) !== String(candidate.job.customer_id)) {
    return { ok: false, reason: 'customer_id_changed' };
  }
  const { error: updErr } = await supabase
    .from('jobs')
    .update({
      lb_external_request_id: candidate.link.lb_external_request_id,
      lb_channel: candidate.link.lb_channel,
    })
    .eq('id', candidate.job.id)
    .is('lb_external_request_id', null); // double-guard at SQL level
  if (updErr) return { ok: false, reason: `update_failed:${updErr.message}` };
  logger.log(
    `[backfill] linked job=${candidate.job.id} user=${candidate.job.user_id} ` +
    `external_request_id=${candidate.link.lb_external_request_id} channel=${candidate.link.lb_channel} ` +
    `lead=${candidate.leadId}`
  );
  return { ok: true };
}

async function main() {
  const args = parseArgs(process.argv);
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_SERVICE_KEY) are required');
    process.exit(1);
  }
  const supabase = createClient(url, key, { auth: { persistSession: false } });

  if (args.apply && !args.confirm) {
    console.error('--apply requires --confirm-apply (safety guard). Re-run with both to mutate jobs.');
    process.exit(2);
  }

  console.log(`[backfill] mode=${args.apply ? 'APPLY' : 'DRY-RUN'} user=${args.userId || 'all'} limit=${args.limit || 'none'}`);

  const jobs = await fetchUnlinkedJobs(supabase, args.userId, args.limit);
  console.log(`[backfill] fetched ${jobs.length} unlinked jobs`);

  const customerIds = [...new Set(jobs.map((j) => j.customer_id).filter((v) => v != null).map(String))];
  console.log(`[backfill] distinct customers with unlinked jobs: ${customerIds.length}`);

  if (args.userId == null) {
    console.error('--user is required for now (cross-tenant batching not implemented in this version)');
    process.exit(3);
  }

  const leadsByCustomer = await fetchLeadsForCustomers(supabase, args.userId, customerIds);
  const identityByCustomer = await fetchIdentityGraph(supabase, args.userId, customerIds);

  const candidates = [];
  const tally = { HIGH: 0, MEDIUM: 0, MANUAL_REVIEW: 0, AMBIGUOUS: 0, MISSING: 0 };
  for (const job of jobs) {
    const leads = leadsByCustomer.get(String(job.customer_id)) || [];
    const identity = identityByCustomer.get(String(job.customer_id)) || null;
    const c = classify(job, leads, identity);
    tally[c.tier] = (tally[c.tier] || 0) + 1;
    candidates.push({ job, ...c });
  }

  // Pretty report.
  const summary = {
    mode: args.apply ? 'APPLY' : 'DRY-RUN',
    user_id: args.userId,
    fetched_jobs: jobs.length,
    distinct_customers: customerIds.length,
    classification: tally,
    would_link_high: tally.HIGH,
    would_link_medium_pending_review: tally.MEDIUM,
    ambiguous: tally.AMBIGUOUS,
    manual_review: tally.MANUAL_REVIEW,
    missing: tally.MISSING,
  };

  if (args.json) {
    const sample = candidates.slice(0, 50).map((c) => ({
      tier: c.tier,
      reason: c.reason,
      job_id: c.job.id,
      customer_id: c.job.customer_id,
      status: c.job.status,
      created_at: c.job.created_at,
      lead_id: c.leadId,
      lb_external_request_id: c.link?.lb_external_request_id,
      lb_channel: c.link?.lb_channel,
      candidates: c.candidates,
      identity_sf_lead_id: c.identitySfLeadId,
    }));
    console.log(JSON.stringify({ summary, sample }, null, 2));
  } else {
    console.log('────────────────────── SUMMARY ──────────────────────');
    console.log(`mode:               ${summary.mode}`);
    console.log(`user_id:            ${summary.user_id}`);
    console.log(`unlinked jobs:      ${summary.fetched_jobs}`);
    console.log(`distinct customers: ${summary.distinct_customers}`);
    console.log(`HIGH (safe apply):  ${summary.would_link_high}`);
    console.log(`MEDIUM (review):    ${summary.would_link_medium_pending_review}`);
    console.log(`MANUAL_REVIEW:      ${summary.manual_review}`);
    console.log(`AMBIGUOUS:          ${summary.ambiguous}`);
    console.log(`MISSING:            ${summary.missing}`);
    console.log('──────────────────────────────────────────────────────');
    console.log('First 20 HIGH-confidence candidates:');
    for (const c of candidates.filter((x) => x.tier === 'HIGH').slice(0, 20)) {
      console.log(
        ` job=${c.job.id} status=${c.job.status} created=${c.job.created_at} ` +
        `→ lead=${c.leadId} external=${c.link.lb_external_request_id} channel=${c.link.lb_channel}`
      );
    }
    if (tally.AMBIGUOUS > 0) {
      console.log('First 10 AMBIGUOUS candidates (will NOT auto-apply):');
      for (const c of candidates.filter((x) => x.tier === 'AMBIGUOUS').slice(0, 10)) {
        console.log(` job=${c.job.id} customer=${c.job.customer_id} candidates=${JSON.stringify(c.candidates)}`);
      }
    }
  }

  if (!args.apply) {
    console.log('[backfill] DRY-RUN complete — no rows mutated.');
    return;
  }

  // Apply path — HIGH only.
  console.log('[backfill] APPLY phase — HIGH-confidence only');
  let applied = 0, refused = 0;
  for (const c of candidates) {
    if (c.tier !== 'HIGH') continue;
    const res = await applyHigh(supabase, c, console);
    if (res.ok) applied++;
    else {
      refused++;
      console.warn(`[backfill] refused job=${c.job.id} reason=${res.reason}`);
    }
  }
  console.log(`[backfill] applied=${applied} refused=${refused} total_high=${tally.HIGH}`);
}

if (require.main === module) {
  main().catch((e) => { console.error('[backfill] fatal:', e); process.exit(1); });
}

module.exports = { classify, fetchUnlinkedJobs, fetchLeadsForCustomers, fetchIdentityGraph };
