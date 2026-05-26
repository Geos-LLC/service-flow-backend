'use strict';

// backfill-jobs-lb-linkage.js
//
// Historical attribution recovery tool — dry-run by default, gated apply.
// Repairs `jobs.lb_external_request_id`, `jobs.lb_channel`, and
// `jobs.lb_business_id` on rows that should carry LB linkage but don't.
//
// Two classifier paths run in the same invocation and are merged
// before apply:
//
//   Part 1 — job-side walk (existing logic, kept intact):
//     For each unlinked SF job, walk customer → lead via
//     converted_customer_id and use Part-1 classify() to find a
//     matching LB-linked lead. HIGH when exactly one match + identity
//     graph agrees or absent.
//
//   Part 2 — lead-side walk (new, gated on LB pull data):
//     For each LB lead returned by /v1/leads?scope=all that has no
//     SF job linked to its externalRequestId, find a matching SF
//     customer by phone last-10 and pick the candidate SF job. HIGH
//     when customers.source already attributes LB + (single-job OR
//     first-job-in-window). MEDIUM otherwise.
//
// Both paths are deterministic and emit single (job_id → linkage)
// proposals. Merge rules:
//   - same job_id proposed by both paths with matching linkage → HIGH
//   - same job_id proposed by both paths with different linkage  → AMBIGUOUS, skip
//   - different LB ext_ids proposing the same job_id              → AMBIGUOUS, skip
// The apply phase only acts on HIGH proposals that survive merge.
//
// Defaults: DRY-RUN. Pass --apply --confirm-apply to mutate. Per-account
// filters (--account / --platform) narrow the scope.
//
// Usage:
//   # tenant-wide dry-run:
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
//     node scripts/backfill-jobs-lb-linkage.js --user 2
//
//   # single account dry-run (St Pete TT):
//   LB_LEADS_FILE=/path/to/lb-leads.json \
//     node scripts/backfill-jobs-lb-linkage.js --user 2 \
//       --account 555516820016889865 --platform thumbtack
//
//   # apply (gated):
//   node scripts/backfill-jobs-lb-linkage.js --user 2 \
//     --account 555516820016889865 --platform thumbtack \
//     --apply --confirm-apply
//
// Hard constraints — does NOT:
//   - mutate leads, customers, identities
//   - touch outbound queue, send SF→LB events, or replay anything
//   - alter status, ledger, or any column other than
//     (lb_external_request_id, lb_channel, lb_business_id)
//   - run when --apply is set without --confirm-apply
//   - cross-tenant scan (user_id filter applies to every query)
//   - link the same job to two different LB ext ids
//   - re-link an already-linked job (SQL-level `IS NULL` guard)

const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const out = {
    userId: null,
    accountBusinessId: null,
    accountPlatform: null,
    apply: false,
    limit: null,
    json: false,
    confirm: false,
    lbLeadsFile: process.env.LB_LEADS_FILE || null,
    lbToken: process.env.LB_INTEGRATION_TOKEN || null,
    skipPart2: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') out.apply = true;
    else if (a === '--dry-run') out.apply = false;
    else if (a === '--json') out.json = true;
    else if (a === '--confirm-apply') out.confirm = true;
    else if (a === '--skip-part2') out.skipPart2 = true;
    else if (a === '--user' || a === '-u') out.userId = argv[++i];
    else if (a === '--account') out.accountBusinessId = argv[++i];
    else if (a === '--platform') out.accountPlatform = argv[++i];
    else if (a === '--lb-cache') out.lbLeadsFile = argv[++i];
    else if (a === '--limit' || a === '-l') out.limit = parseInt(argv[++i], 10);
    else if (a === '--help' || a === '-h') {
      console.log(`Usage:
  node scripts/backfill-jobs-lb-linkage.js --user <id>
    [--account <businessId>] [--platform thumbtack|yelp]
    [--lb-cache <path>]
    [--limit <N>] [--json]
    [--dry-run] (default)
    [--apply --confirm-apply]
    [--skip-part2]

Env:
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (required for apply)
  LB_LEADS_FILE  (optional; cached /v1/leads?scope=all JSON for Part-2)
  LB_INTEGRATION_TOKEN  (optional; if set without LB_LEADS_FILE, the
                        script fetches LB live)`);
      process.exit(0);
    }
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────
// Part 1 — job-side classifier (existing logic, preserved verbatim).
// ──────────────────────────────────────────────────────────────────
async function fetchUnlinkedJobs(supabase, userId, limit) {
  let q = supabase
    .from('jobs')
    .select('id, user_id, customer_id, status, created_at, last_status_source, lb_external_request_id, lb_channel, lb_business_id')
    .is('lb_external_request_id', null);
  if (userId != null) q = q.eq('user_id', userId);
  q = q.order('created_at', { ascending: false });
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
  const map = new Map();
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
  const map = new Map();
  for (let i = 0; i < customerIds.length; i += 200) {
    const slice = customerIds.slice(i, i + 200);
    const { data, error } = await supabase
      .from('communication_participant_identities')
      .select('id, user_id, sf_customer_id, sf_lead_id')
      .eq('user_id', userId)
      .in('sf_customer_id', slice);
    if (error) {
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

// Existing Part-1 classifier (no behavior change).
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
        candidates: linked.map((l) => ({ lead_id: l.id, external_request_id: l.lb_external_request_id, channel: l.lb_channel })),
      };
    }
  }
  const winner = linked[0];
  const link = {
    lb_external_request_id: winner.lb_external_request_id,
    lb_channel: winner.lb_channel,
    lb_business_id: winner.lb_business_id || null,
  };
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

// ──────────────────────────────────────────────────────────────────
// Part 2 — lead-side classifier (new).
// ──────────────────────────────────────────────────────────────────

function last10(p) {
  if (!p) return null;
  const d = String(p).replace(/[^0-9]/g, '');
  return d.length >= 10 ? d.slice(-10) : null;
}
function nameMatch(a, b) {
  if (!a || !b) return false;
  const norm = (s) => s.toLowerCase().replace(/[^a-z]/g, '').slice(0, 10);
  return norm(a) === norm(b) || (norm(a).length >= 4 && (norm(a).startsWith(norm(b).slice(0,4)) || norm(b).startsWith(norm(a).slice(0,4))));
}

// Classify a single LB-completed lead that has no SF job linked to its
// externalRequestId. Inputs:
//   lbLead    — { externalRequestId, customerName, customerPhone, status, createdAt, platform, businessId }
//   custMatch — array of SF customers matched by phone last-10
//   jobsByCust — Map<sf_customer_id, jobs[]>
//   identitiesByCust — Map<sf_customer_id, identities[]>
function classifyPart2(lbLead, custMatches, jobsByCust, identitiesByCust) {
  if (!custMatches || custMatches.length === 0) {
    return { tier: 'no_matching_customer', reason: 'no_phone_match' };
  }
  if (custMatches.length > 1) {
    // multiple customers share the phone — ambiguous, skip
    return { tier: 'AMBIGUOUS', reason: 'multiple_customers_for_phone', candidates: custMatches.map(c => c.id) };
  }
  const cust = custMatches[0];
  const jobs = jobsByCust.get(String(cust.id)) || [];
  const identities = identitiesByCust.get(String(cust.id)) || [];
  const sourceLooksLB = (cust.source || '').match(/thumbtack|yelp|leadbridge/i);
  const lbIdentityCount = identities.filter(i => i.source_channel === 'leadbridge').length;
  const isNameMatch = nameMatch(lbLead.customerName, `${cust.first_name||''} ${cust.last_name||''}`.trim());

  // Pick candidate job:
  //   - if customer has exactly 1 job, that's the candidate
  //   - else find the first job within [lb_created - 7d, lb_created + 180d]
  const lbCreated = new Date(lbLead.createdAt);
  const windowStart = new Date(lbCreated.getTime() - 7*86400000);
  const windowEnd   = new Date(lbCreated.getTime() + 180*86400000);
  const inWindow = jobs.filter(j => {
    const t = new Date(j.created_at);
    return t >= windowStart && t <= windowEnd;
  }).sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

  let candidateJob = null;
  let pickReason = null;
  if (jobs.length === 1) {
    candidateJob = jobs[0];
    pickReason = 'single_job_customer';
  } else if (inWindow.length >= 1) {
    candidateJob = inWindow[0];
    pickReason = 'first_job_in_window';
  }

  // The candidate job MUST currently be unlinked. If it already has a
  // different ext_id, we cannot reuse it.
  if (candidateJob && candidateJob.lb_external_request_id != null) {
    if (candidateJob.lb_external_request_id === lbLead.externalRequestId) {
      // idempotent — already linked to this exact ext id
      return { tier: 'already_linked', reason: 'job_already_has_this_ext', candidateJobId: candidateJob.id };
    }
    return { tier: 'AMBIGUOUS', reason: 'candidate_job_already_has_different_ext', candidateJobId: candidateJob.id, existing: candidateJob.lb_external_request_id };
  }

  if (!candidateJob) {
    // Customer exists but no candidate job in window and not single-job →
    // we can't pick a job deterministically. MEDIUM (operator review).
    return { tier: 'MEDIUM', reason: 'no_deterministic_candidate_job', cust_id: cust.id, total_jobs: jobs.length, source: cust.source };
  }

  // Tier decision
  const hasJobInWindow = pickReason === 'first_job_in_window' || pickReason === 'single_job_customer';
  if (sourceLooksLB && (lbIdentityCount > 0 || hasJobInWindow || jobs.length === 1)) {
    return {
      tier: 'HIGH',
      reason: 'source_attribution_plus_' + pickReason,
      candidateJobId: candidateJob.id,
      cust_id: cust.id,
      total_jobs: jobs.length,
      lb_identity_count: lbIdentityCount,
      link: {
        lb_external_request_id: lbLead.externalRequestId,
        lb_channel: lbLead.platform,
        lb_business_id: lbLead.businessId || null,
      },
    };
  }
  if (jobs.length === 1 && isNameMatch) {
    return {
      tier: 'HIGH',
      reason: 'single_job_plus_name_match',
      candidateJobId: candidateJob.id,
      cust_id: cust.id,
      total_jobs: 1,
      link: {
        lb_external_request_id: lbLead.externalRequestId,
        lb_channel: lbLead.platform,
        lb_business_id: lbLead.businessId || null,
      },
    };
  }
  if (sourceLooksLB || lbIdentityCount > 0 || isNameMatch) {
    return {
      tier: 'MEDIUM',
      reason: 'phone_match_partial_signals',
      candidateJobId: candidateJob.id,
      cust_id: cust.id,
      total_jobs: jobs.length,
    };
  }
  return {
    tier: 'LOW',
    reason: 'phone_match_only',
    candidateJobId: candidateJob.id,
    cust_id: cust.id,
    total_jobs: jobs.length,
  };
}

// Fetch LB leads from a local cache file or live LB API.
async function fetchLbLeadsForPart2(args) {
  if (args.lbLeadsFile) {
    try {
      const doc = JSON.parse(fs.readFileSync(args.lbLeadsFile, 'utf8'));
      // Accept both raw array and { leads: [...] } shapes (matches LB API).
      const leads = Array.isArray(doc) ? doc : (doc.leads || []);
      return leads;
    } catch (e) {
      console.warn(`[backfill] LB cache read failed (${args.lbLeadsFile}): ${e.message}`);
      return null;
    }
  }
  if (!args.lbToken) {
    return null;
  }
  const url = (process.env.LEADBRIDGE_URL || 'https://thumbtack-bridge-production.up.railway.app/api') + '/v1/leads?scope=all';
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${args.lbToken}`, 'Content-Type': 'application/json' },
  });
  if (!res.ok) {
    console.warn(`[backfill] LB pull failed: ${res.status} ${await res.text()}`);
    return null;
  }
  const doc = await res.json();
  return doc.leads || [];
}

// Fetch SF customers + their jobs + identities for the set of phone last-10
// values from the LB completed-gap set. Tenant-scoped on every query.
async function fetchPart2Context(supabase, userId, phone10s) {
  const customersByPhone = new Map();
  const jobsByCust = new Map();
  const identitiesByCust = new Map();
  if (phone10s.length === 0) return { customersByPhone, jobsByCust, identitiesByCust };

  // Customers — fetch ALL for the user, filter by phone last-10 in-process.
  // (Supabase has no easy regex IN filter; tenant-scope keeps it bounded.)
  let from = 0;
  const pageSize = 1000;
  const phoneSet = new Set(phone10s);
  while (true) {
    const { data, error } = await supabase
      .from('customers')
      .select('id, user_id, first_name, last_name, phone, email, source, zenbooker_id, created_at')
      .eq('user_id', userId)
      .range(from, from + pageSize - 1);
    if (error) throw new Error(`customers query failed: ${error.message}`);
    if (!data || data.length === 0) break;
    for (const c of data) {
      const p = last10(c.phone);
      if (p && phoneSet.has(p)) {
        if (!customersByPhone.has(p)) customersByPhone.set(p, []);
        customersByPhone.get(p).push(c);
      }
    }
    if (data.length < pageSize) break;
    from += pageSize;
  }

  // Jobs for those customers.
  const custIds = [...new Set([...customersByPhone.values()].flat().map(c => c.id))];
  for (let i = 0; i < custIds.length; i += 200) {
    const slice = custIds.slice(i, i + 200);
    const { data, error } = await supabase
      .from('jobs')
      .select('id, user_id, customer_id, created_at, status, lb_external_request_id, lb_channel, lb_business_id')
      .eq('user_id', userId)
      .in('customer_id', slice);
    if (error) throw new Error(`jobs-for-cust query failed: ${error.message}`);
    for (const j of data || []) {
      const k = String(j.customer_id);
      if (!jobsByCust.has(k)) jobsByCust.set(k, []);
      jobsByCust.get(k).push(j);
    }
  }

  // Identities for those customers.
  for (let i = 0; i < custIds.length; i += 200) {
    const slice = custIds.slice(i, i + 200);
    const { data, error } = await supabase
      .from('communication_participant_identities')
      .select('id, user_id, sf_customer_id, sf_lead_id, source_channel, normalized_phone')
      .eq('user_id', userId)
      .in('sf_customer_id', slice);
    if (error) { console.warn(`[backfill] identity-Part2 lookup failed: ${error.message}`); break; }
    for (const i2 of data || []) {
      const k = String(i2.sf_customer_id);
      if (!identitiesByCust.has(k)) identitiesByCust.set(k, []);
      identitiesByCust.get(k).push(i2);
    }
  }
  return { customersByPhone, jobsByCust, identitiesByCust };
}

// ──────────────────────────────────────────────────────────────────
// Apply — writes 3 columns, double-guarded by IS NULL.
// ──────────────────────────────────────────────────────────────────
async function applyHigh(supabase, candidate, logger) {
  const { data: current, error: readErr } = await supabase
    .from('jobs')
    .select('id, user_id, customer_id, lb_external_request_id, lb_channel, lb_business_id')
    .eq('id', candidate.jobId)
    .eq('user_id', candidate.userId)
    .maybeSingle();
  if (readErr || !current) {
    return { ok: false, reason: `reread_failed:${readErr?.message || 'not_found'}` };
  }
  if (current.lb_external_request_id != null) {
    return { ok: false, reason: 'already_linked' };
  }
  const update = {
    lb_external_request_id: candidate.link.lb_external_request_id,
    lb_channel: candidate.link.lb_channel,
  };
  // Only set lb_business_id if the candidate has it AND the row currently
  // has a NULL there. Avoids surprise overwrites in the (improbable) case
  // someone set business_id without ext_id.
  if (candidate.link.lb_business_id != null && current.lb_business_id == null) {
    update.lb_business_id = candidate.link.lb_business_id;
  }
  const { error: updErr } = await supabase
    .from('jobs')
    .update(update)
    .eq('id', candidate.jobId)
    .eq('user_id', candidate.userId)
    .is('lb_external_request_id', null);
  if (updErr) return { ok: false, reason: `update_failed:${updErr.message}` };
  logger.log(
    `[backfill] linked job=${candidate.jobId} user=${candidate.userId} ` +
    `ext=${candidate.link.lb_external_request_id} channel=${candidate.link.lb_channel} ` +
    `business=${candidate.link.lb_business_id || 'null'} ` +
    `source=${candidate.source}`
  );
  return { ok: true };
}

// ──────────────────────────────────────────────────────────────────
// Merge — combine Part-1 + Part-2 proposals into 1:1 (job_id → linkage).
//
// Returns: { proposals: [{ jobId, userId, link, source, reasons }], ambiguous: [...] }
// ──────────────────────────────────────────────────────────────────
function mergeProposals(part1HighCandidates, part2HighProposals) {
  const byJobId = new Map(); // jobId → { from: 'part1'|'part2'|'both', link, reasons, refs }
  for (const c of part1HighCandidates) {
    byJobId.set(String(c.job.id), {
      jobId: c.job.id,
      userId: c.job.user_id,
      link: c.link,
      source: 'part1',
      reasons: [c.reason],
    });
  }
  const ambiguous = [];
  for (const p of part2HighProposals) {
    const k = String(p.candidateJobId);
    if (byJobId.has(k)) {
      const exist = byJobId.get(k);
      // Both classifiers proposed the same job. Linkage must agree.
      if (exist.link.lb_external_request_id === p.link.lb_external_request_id &&
          (exist.link.lb_channel || '') === (p.link.lb_channel || '')) {
        exist.source = 'both';
        exist.reasons.push('part2:' + p.reason);
        // Prefer part-2's lb_business_id if part-1 was missing it.
        if (!exist.link.lb_business_id && p.link.lb_business_id) {
          exist.link.lb_business_id = p.link.lb_business_id;
        }
      } else {
        ambiguous.push({
          jobId: k,
          reason: 'cross_classifier_conflict',
          part1: exist.link,
          part2: p.link,
        });
        byJobId.delete(k);
      }
    } else {
      byJobId.set(k, {
        jobId: p.candidateJobId,
        userId: p.userId,
        link: p.link,
        source: 'part2',
        reasons: ['part2:' + p.reason],
      });
    }
  }
  // Now check for ext_id collisions: same ext_id mapping to multiple jobs?
  const byExt = new Map();
  for (const e of byJobId.values()) {
    const ext = e.link.lb_external_request_id;
    if (!byExt.has(ext)) byExt.set(ext, []);
    byExt.get(ext).push(e);
  }
  for (const [ext, arr] of byExt) {
    if (arr.length > 1) {
      for (const e of arr) {
        ambiguous.push({
          jobId: e.jobId,
          reason: 'duplicate_ext_target',
          ext,
          all_jobs: arr.map(x => x.jobId),
        });
        byJobId.delete(String(e.jobId));
      }
    }
  }
  return { proposals: [...byJobId.values()], ambiguous };
}

// ──────────────────────────────────────────────────────────────────
// Main.
// ──────────────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv);

  // Lazy-require so unit tests can require this module without
  // pulling in the supabase-js dep transitively when only the classifier
  // helpers are needed.
  const { createClient } = require('@supabase/supabase-js');
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
  if (args.userId == null) {
    console.error('--user <id> is required (cross-tenant runs are not supported)');
    process.exit(3);
  }

  console.log(`[backfill] mode=${args.apply ? 'APPLY' : 'DRY-RUN'} user=${args.userId} account=${args.accountBusinessId || '*'} platform=${args.accountPlatform || '*'}`);

  // ── PART 1 ──────────────────────────────────────────────────────
  const jobs = await fetchUnlinkedJobs(supabase, args.userId, args.limit);
  console.log(`[backfill] part1: fetched ${jobs.length} unlinked jobs`);
  const customerIds = [...new Set(jobs.map((j) => j.customer_id).filter((v) => v != null).map(String))];
  const leadsByCustomer = await fetchLeadsForCustomers(supabase, args.userId, customerIds);
  const identityByCustomer = await fetchIdentityGraph(supabase, args.userId, customerIds);

  let part1Candidates = [];
  for (const job of jobs) {
    const leads = leadsByCustomer.get(String(job.customer_id)) || [];
    const identity = identityByCustomer.get(String(job.customer_id)) || null;
    const c = classify(job, leads, identity);
    // Account filter — drop part-1 candidates whose proposed linkage is
    // outside the requested account scope.
    if (args.accountBusinessId && c.link && c.link.lb_business_id && c.link.lb_business_id !== args.accountBusinessId) continue;
    if (args.accountPlatform && c.link && c.link.lb_channel && c.link.lb_channel !== args.accountPlatform) continue;
    part1Candidates.push({ job, ...c });
  }
  const part1Tally = { HIGH: 0, MEDIUM: 0, MANUAL_REVIEW: 0, AMBIGUOUS: 0, MISSING: 0 };
  for (const c of part1Candidates) part1Tally[c.tier] = (part1Tally[c.tier] || 0) + 1;

  // ── PART 2 ──────────────────────────────────────────────────────
  let part2Proposals = [];
  let part2Tally = { HIGH: 0, MEDIUM: 0, LOW: 0, AMBIGUOUS: 0, no_matching_customer: 0, already_linked: 0 };
  let part2Available = false;

  if (!args.skipPart2) {
    const lbLeads = await fetchLbLeadsForPart2(args);
    if (!lbLeads) {
      console.log('[backfill] part2: skipped — no LB cache file (LB_LEADS_FILE) and no LB_INTEGRATION_TOKEN set');
    } else {
      part2Available = true;
      // Filter LB pull to account scope.
      let scoped = lbLeads;
      if (args.accountBusinessId) scoped = scoped.filter(l => l.businessId === args.accountBusinessId);
      if (args.accountPlatform)  scoped = scoped.filter(l => l.platform === args.accountPlatform);

      // Only consider LB-completed leads whose externalRequestId has no
      // matching SF job already. Idempotency baseline.
      const completed = scoped.filter(l => l.status === 'completed');
      const completedExts = completed.map(l => l.externalRequestId).filter(Boolean);
      const linkedExtSet = new Set();
      if (completedExts.length > 0) {
        for (let i = 0; i < completedExts.length; i += 200) {
          const slice = completedExts.slice(i, i + 200);
          const { data, error } = await supabase
            .from('jobs')
            .select('lb_external_request_id')
            .eq('user_id', args.userId)
            .in('lb_external_request_id', slice);
          if (error) break;
          for (const r of data || []) linkedExtSet.add(r.lb_external_request_id);
        }
      }
      const gap = completed.filter(l => !linkedExtSet.has(l.externalRequestId));
      console.log(`[backfill] part2: scope ${scoped.length} LB leads, ${completed.length} completed, ${gap.length} completed without SF job`);

      // Fetch SF context.
      const phone10s = [...new Set(gap.map(l => last10(l.customerPhone)).filter(Boolean))];
      const ctx = await fetchPart2Context(supabase, args.userId, phone10s);

      for (const lb of gap) {
        const p10 = last10(lb.customerPhone);
        const custMatches = p10 ? (ctx.customersByPhone.get(p10) || []) : [];
        const cls = classifyPart2(lb, custMatches, ctx.jobsByCust, ctx.identitiesByCust);
        part2Tally[cls.tier] = (part2Tally[cls.tier] || 0) + 1;
        if (cls.tier === 'HIGH') {
          part2Proposals.push({
            ext: lb.externalRequestId,
            lb_name: lb.customerName,
            lb_phone10: p10,
            candidateJobId: cls.candidateJobId,
            userId: args.userId,
            link: cls.link,
            reason: cls.reason,
            cust_id: cls.cust_id,
          });
        }
      }
    }
  } else {
    console.log('[backfill] part2: skipped — --skip-part2');
  }

  // ── MERGE ────────────────────────────────────────────────────────
  const part1HighOnly = part1Candidates.filter(c => c.tier === 'HIGH');
  const merge = mergeProposals(part1HighOnly, part2Proposals);

  // ── REPORT ──────────────────────────────────────────────────────
  const summary = {
    mode: args.apply ? 'APPLY' : 'DRY-RUN',
    user_id: args.userId,
    account_business_id: args.accountBusinessId,
    account_platform: args.accountPlatform,
    part1: part1Tally,
    part2: part2Tally,
    part2_available: part2Available,
    proposals_total: merge.proposals.length,
    proposals_by_source: {
      part1_only: merge.proposals.filter(p => p.source === 'part1').length,
      part2_only: merge.proposals.filter(p => p.source === 'part2').length,
      both:       merge.proposals.filter(p => p.source === 'both').length,
    },
    ambiguous_after_merge: merge.ambiguous.length,
  };

  if (args.json) {
    console.log(JSON.stringify({
      summary,
      proposals: merge.proposals.slice(0, 200),
      ambiguous: merge.ambiguous.slice(0, 100),
      part1_sample: part1Candidates.slice(0, 30).map(c => ({ tier: c.tier, reason: c.reason, job_id: c.job.id, leadId: c.leadId, link: c.link })),
    }, null, 2));
  } else {
    console.log('────────────────────── SUMMARY ──────────────────────');
    console.log(`mode:                  ${summary.mode}`);
    console.log(`user_id:               ${summary.user_id}`);
    console.log(`account:               ${summary.account_business_id || '*'}/${summary.account_platform || '*'}`);
    console.log(`Part-1 tiers:          ${JSON.stringify(summary.part1)}`);
    console.log(`Part-2 tiers:          ${JSON.stringify(summary.part2)}`);
    console.log(`merged HIGH proposals: ${summary.proposals_total}  (part1_only=${summary.proposals_by_source.part1_only}, part2_only=${summary.proposals_by_source.part2_only}, both=${summary.proposals_by_source.both})`);
    console.log(`ambiguous after merge: ${summary.ambiguous_after_merge}`);
    console.log('──────────────────────────────────────────────────────');
    console.log(`First 20 proposals:`);
    for (const p of merge.proposals.slice(0, 20)) {
      console.log(`  job=${p.jobId} user=${p.userId} ext=${p.link.lb_external_request_id} chan=${p.link.lb_channel} biz=${p.link.lb_business_id||'null'} src=${p.source} reasons=${p.reasons.join('|')}`);
    }
    if (merge.ambiguous.length > 0) {
      console.log(`\nAmbiguous (will NOT auto-apply, first 10):`);
      for (const a of merge.ambiguous.slice(0, 10)) {
        console.log(`  ${JSON.stringify(a)}`);
      }
    }
  }

  if (!args.apply) {
    console.log('[backfill] DRY-RUN complete — no rows mutated.');
    return;
  }

  // ── APPLY ────────────────────────────────────────────────────────
  console.log(`[backfill] APPLY phase — ${merge.proposals.length} proposals`);
  let applied = 0, refused = 0;
  const refusals = [];
  for (const p of merge.proposals) {
    const res = await applyHigh(supabase, p, console);
    if (res.ok) applied++;
    else {
      refused++;
      refusals.push({ jobId: p.jobId, reason: res.reason });
      console.warn(`[backfill] refused job=${p.jobId} reason=${res.reason}`);
    }
  }
  console.log(`[backfill] applied=${applied} refused=${refused} total=${merge.proposals.length}`);
  if (args.json && refusals.length > 0) {
    console.log(JSON.stringify({ refusals }, null, 2));
  }
}

if (require.main === module) {
  main().catch((e) => { console.error('[backfill] fatal:', e); process.exit(1); });
}

module.exports = {
  classify,
  classifyPart2,
  mergeProposals,
  fetchUnlinkedJobs,
  fetchLeadsForCustomers,
  fetchIdentityGraph,
  fetchPart2Context,
  last10,
  nameMatch,
};
