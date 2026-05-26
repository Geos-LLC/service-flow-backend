'use strict';

// Production attribution-recovery orchestrator.
//
// Semantic model (post-refactor):
//   LeadBridge owns the ACQUISITION + CONVERSATION lifecycle.
//   ServiceFlow / Zenbooker owns the OPERATIONAL lifecycle (scheduling,
//   work, payment, payroll). The two domains are independent — connected
//   by an OPTIONAL attribution bridge, not a synchronized status machine.
//
// What this module does: discover the attribution bridge.
//   - Walks SF jobs that should have an LB linkage but don't, and stamps
//     it (Stage-1 "standard HIGH").
//   - Walks LB-completed leads that look like they map to a recurring SF
//     customer, and stamps the customer-level acquisition attribution +
//     the single acquisition job (Stage-3 "recurring HIGH").
//
// What this module does NOT do:
//   - Treat an LB-completed lead with no SF customer as a failure. That's
//     a normal unconverted / marketplace-only lead — see acquisition_review.
//   - Treat SF-job-without-LB-linkage as a failure. That's normal
//     operational work that never came through an LB lead.
//   - Compare LB status to SF status as if they share a lifecycle.
//
// Composes the existing classifier + apply helpers (which live in
// scripts/backfill-jobs-lb-linkage.js for historical reasons) into a
// single function the `/sync` endpoint can call. Provides the same
// safety guarantees the script's CLI provides:
//   - dry-run by default; apply requires explicit args.apply=true
//   - per-account scoping (businessId + platform)
//   - mode selection: 'standard' | 'recurring' | 'both' (default 'both')
//   - tenant-scoped on every query
//   - write-once + IS-NULL guards at SQL layer for idempotency
//   - selective stamping for recurring customers (1 acquisition job
//     per customer, never cascade to recurring children)
//
// Hard constraints honored by this module:
//   - never auto-applies MEDIUM, duplicate_phone_collision, weak_timing,
//     weak_identity, ambiguous, no_matching_customer, unrecoverable
//   - never writes identity rows (Stage 5 deferred)
//   - never enqueues outbound events (that's the lifecycle-reconcile phase)
//   - never replays queues, touches DLQ, or modifies lead/customer fields
//     outside the (lb_external_request_id, lb_channel, lb_business_id) +
//     (customers.acquisition_*) triples

const {
  classify,
  classifyPart2,
  mergeProposals,
  applyHigh,
  applyRecurringHigh,
  fetchUnlinkedJobs,
  fetchLeadsForCustomers,
  fetchIdentityGraph,
  fetchPart2Context,
} = require('../scripts/backfill-jobs-lb-linkage');
const {
  classifyRecurring,
  pickAcquisitionJob,
  last10,
} = require('./lb-recurring-classifier');

/**
 * Run a full attribution-recovery pass.
 *
 * @param {object} supabase  Supabase client
 * @param {object} args
 * @param {string|number} args.userId        Tenant scope (required)
 * @param {boolean} [args.apply=false]       Apply mode; default dry-run
 * @param {string}  [args.mode='both']       'standard' | 'recurring' | 'both'
 * @param {Array}   args.lbLeads             /v1/leads?scope=all output (already pulled)
 * @param {string}  [args.accountBusinessId] Restrict to one LB business
 * @param {string}  [args.accountPlatform]   Restrict to one platform (thumbtack|yelp)
 * @param {number}  [args.limit]             Cap on jobs scanned by Part 1
 * @param {object}  [args.logger]
 *
 * @returns {{
 *   summary: object,
 *   standard: { proposals, ambiguous, applied?, refused? },
 *   recurring: { proposals, applied_customers?, applied_jobs?, refused? }
 * }}
 */
async function runAttributionRecovery(supabase, args) {
  const userId = args.userId;
  const apply = !!args.apply;
  const mode = args.mode || 'both';
  const allLbLeads = args.lbLeads || [];
  const accountBusinessId = args.accountBusinessId || null;
  const accountPlatform = args.accountPlatform || null;
  const limit = args.limit || null;
  const logger = args.logger || console;

  if (userId == null) throw new Error('runAttributionRecovery: args.userId is required');

  // ── PART 1 — job-side walk ─────────────────────────────────────────
  const jobs = await fetchUnlinkedJobs(supabase, userId, limit);
  const customerIds = [...new Set(jobs.map((j) => j.customer_id).filter((v) => v != null).map(String))];
  const leadsByCustomer = await fetchLeadsForCustomers(supabase, userId, customerIds);
  const identityByCustomer = await fetchIdentityGraph(supabase, userId, customerIds);

  const part1Tally = { HIGH: 0, MEDIUM: 0, MANUAL_REVIEW: 0, AMBIGUOUS: 0, MISSING: 0 };
  const part1Candidates = [];
  for (const job of jobs) {
    const leads = leadsByCustomer.get(String(job.customer_id)) || [];
    const identity = identityByCustomer.get(String(job.customer_id)) || null;
    const c = classify(job, leads, identity);
    if (accountBusinessId && c.link && c.link.lb_business_id && c.link.lb_business_id !== accountBusinessId) continue;
    if (accountPlatform && c.link && c.link.lb_channel && c.link.lb_channel !== accountPlatform) continue;
    part1Candidates.push({ job, ...c });
    part1Tally[c.tier] = (part1Tally[c.tier] || 0) + 1;
  }

  // ── PART 2 — lead-side walk (Stage-1 HIGH) ─────────────────────────
  let scoped = allLbLeads;
  if (accountBusinessId) scoped = scoped.filter(l => l.businessId === accountBusinessId);
  if (accountPlatform)  scoped = scoped.filter(l => l.platform === accountPlatform);

  const completed = scoped.filter(l => l.status === 'completed');
  const completedExts = completed.map(l => l.externalRequestId).filter(Boolean);
  const linkedExtSet = new Set();
  if (completedExts.length > 0) {
    for (let i = 0; i < completedExts.length; i += 200) {
      const slice = completedExts.slice(i, i + 200);
      const { data, error } = await supabase
        .from('jobs')
        .select('lb_external_request_id')
        .eq('user_id', userId)
        .in('lb_external_request_id', slice);
      if (!error) for (const r of (data || [])) linkedExtSet.add(r.lb_external_request_id);
    }
  }
  const gap = completed.filter(l => !linkedExtSet.has(l.externalRequestId));

  const phone10s = [...new Set(gap.map(l => last10(l.customerPhone)).filter(Boolean))];
  const ctx = await fetchPart2Context(supabase, userId, phone10s);

  // Phone-collision map across the FULL pull (not just the gap)
  const phoneCollisionMap = new Map();
  for (const l of allLbLeads) {
    const p = last10(l.customerPhone);
    if (!p) continue;
    if (!phoneCollisionMap.has(p)) phoneCollisionMap.set(p, []);
    phoneCollisionMap.get(p).push(l.externalRequestId);
  }

  const part2Tally = { HIGH: 0, MEDIUM: 0, LOW: 0, AMBIGUOUS: 0, no_matching_customer: 0, already_linked: 0 };
  const part2Proposals = [];
  const recurringTally = {
    recurring_customer_high_confidence: 0,
    true_multi_candidate_ambiguity: 0,
    weak_identity: 0,
    weak_timing: 0,
    duplicate_phone_collision: 0,
    conflicting_acquisition_source: 0,
  };
  const recurringProposals = [];
  const recurringEnabled = mode === 'recurring' || mode === 'both';

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
        userId,
        link: cls.link,
        reason: cls.reason,
        cust_id: cls.cust_id,
      });
    } else if (recurringEnabled && (cls.tier === 'MEDIUM' || cls.tier === 'LOW')) {
      const cust = (custMatches || [])[0] || null;
      const jobsForCust = cust ? (ctx.jobsByCust.get(String(cust.id)) || []) : [];
      const identities = cust ? (ctx.identitiesByCust.get(String(cust.id)) || []) : [];
      const collisionExts = p10 ? (phoneCollisionMap.get(p10) || []) : [];
      const rec = classifyRecurring({
        lbLead: lb,
        custMatch: cust,
        peers: custMatches,
        jobs: jobsForCust,
        identities,
        phoneCollisionExts: collisionExts,
      });
      recurringTally[rec.subtier] = (recurringTally[rec.subtier] || 0) + 1;
      // Only propose customers with no prior acquisition (write-once)
      if (rec.subtier === 'recurring_customer_high_confidence' && cust && !cust.acquisition_external_request_id) {
        const acqJob = pickAcquisitionJob(lb.createdAt, jobsForCust);
        recurringProposals.push({
          ext: lb.externalRequestId,
          lb_name: lb.customerName,
          lb_phone10: p10,
          userId,
          cust_id: cust.id,
          acquisitionJobId: acqJob?.id || null,
          acquired_at: lb.createdAt,
          link: {
            lb_external_request_id: lb.externalRequestId,
            lb_channel: lb.platform,
            lb_business_id: lb.businessId || null,
          },
          reason: rec.reason,
          jobs_total: rec.jobs_total,
        });
      }
    }
  }

  // ── MERGE — Part-1 + Part-2 dedup ──────────────────────────────────
  const part1HighOnly = part1Candidates.filter(c => c.tier === 'HIGH');
  const standardEnabled = mode === 'standard' || mode === 'both';
  const merge = standardEnabled
    ? mergeProposals(part1HighOnly, part2Proposals)
    : { proposals: [], ambiguous: [] };

  // ── REPORT ────────────────────────────────────────────────────────
  const summary = {
    mode: apply ? 'APPLY' : 'DRY-RUN',
    backfill_mode: mode,
    user_id: userId,
    account_business_id: accountBusinessId,
    account_platform: accountPlatform,
    part1_tally: part1Tally,
    part2_tally: part2Tally,
    standard_high_proposals: merge.proposals.length,
    standard_ambiguous: merge.ambiguous.length,
    recurring_enabled: recurringEnabled,
    recurring_tally: recurringEnabled ? recurringTally : null,
    recurring_high_proposals: recurringEnabled ? recurringProposals.length : 0,
    // Final disposition the operator should see:
    safe_to_apply: {
      standard_high: merge.proposals.length,
      recurring_customers: recurringEnabled ? recurringProposals.length : 0,
      recurring_acquisition_jobs: recurringEnabled
        ? recurringProposals.filter(r => r.acquisitionJobId != null).length
        : 0,
    },
    skipped: {
      ambiguous: (merge.ambiguous.length || 0) + (recurringEnabled ? (recurringTally.true_multi_candidate_ambiguity || 0) : 0),
      duplicate_phone_collision: recurringEnabled ? (recurringTally.duplicate_phone_collision || 0) : 0,
      weak_timing: recurringEnabled ? (recurringTally.weak_timing || 0) : 0,
      weak_identity: recurringEnabled ? (recurringTally.weak_identity || 0) : 0,
      conflicting_acquisition_source: recurringEnabled ? (recurringTally.conflicting_acquisition_source || 0) : 0,
      no_matching_customer: part2Tally.no_matching_customer || 0,
      already_linked: part2Tally.already_linked || 0,
    },
  };

  // ── ACQUISITION-DOMAIN VIEW (additive, semantic refactor) ─────────
  // LB lifecycle = acquisition + conversation. SF/ZB lifecycle = operational
  // work + payment + payroll. They are two domains connected by an OPTIONAL
  // attribution bridge — not a single status machine. This view re-presents
  // the counters above under names that reflect that model:
  //   - "no_matching_customer" → unconverted_or_marketplace_only_lead.
  //     An LB-completed lead with no SF customer is NORMAL — it's a lead
  //     that didn't convert into operational business, not a sync error.
  //   - "weak signals skipped" rolls up weak_identity + weak_timing +
  //     duplicate_phone_collision — operator-review queue, not failure.
  //   - "ambiguous_skipped" rolls up cross-classifier conflicts +
  //     multi-candidate ambiguity.
  //   - Attribution proposals are the *real* output of this phase:
  //     attribution is intelligence-sync, not status-sync.
  //
  // Legacy keys above (`skipped`, `part2_tally`, etc.) are preserved for
  // backwards compatibility with any consumer reading the previous shape.
  summary.acquisition_review = {
    high_confidence_attribution_proposed: merge.proposals.length,
    recurring_attribution_proposed: recurringEnabled ? recurringProposals.length : 0,
    unconverted_or_marketplace_only_lead: part2Tally.no_matching_customer || 0,
    ambiguous_skipped: (merge.ambiguous.length || 0)
      + (recurringEnabled ? (recurringTally.true_multi_candidate_ambiguity || 0) : 0),
    weak_signals_skipped: recurringEnabled
      ? (recurringTally.weak_identity || 0)
        + (recurringTally.weak_timing || 0)
        + (recurringTally.duplicate_phone_collision || 0)
      : 0,
    conflicting_acquisition_source: recurringEnabled ? (recurringTally.conflicting_acquisition_source || 0) : 0,
    already_linked: part2Tally.already_linked || 0,
  };

  if (!apply) {
    logger.log(`[LB Attribution] phase=dry_run user=${userId} standard_high=${summary.safe_to_apply.standard_high} recurring_customers=${summary.safe_to_apply.recurring_customers}`);
    return {
      summary,
      standard: { proposals: merge.proposals, ambiguous: merge.ambiguous },
      recurring: { proposals: recurringProposals },
    };
  }

  // ── APPLY ────────────────────────────────────────────────────────
  logger.log(`[LB Attribution] phase=apply_standard user=${userId} count=${merge.proposals.length}`);
  let stdApplied = 0, stdRefused = 0;
  const stdRefusals = [];
  for (const p of merge.proposals) {
    const res = await applyHigh(supabase, p, logger);
    if (res.ok) stdApplied++;
    else { stdRefused++; stdRefusals.push({ jobId: p.jobId, reason: res.reason }); }
  }

  let recCustApplied = 0, recJobApplied = 0, recRefused = 0;
  const recRefusals = [];
  if (recurringEnabled && recurringProposals.length > 0) {
    logger.log(`[LB Attribution] phase=apply_recurring user=${userId} count=${recurringProposals.length}`);
    for (const r of recurringProposals) {
      const res = await applyRecurringHigh(supabase, r, logger);
      if (!res.ok) {
        recRefused++;
        recRefusals.push({ cust_id: r.cust_id, ext: r.ext, reason: res.refused, error: res.error });
        continue;
      }
      if (res.customerWrote) recCustApplied++;
      if (res.jobWrote) recJobApplied++;
    }
  }

  summary.applied = {
    standard_high: stdApplied,
    standard_refused: stdRefused,
    recurring_customers: recCustApplied,
    recurring_acquisition_jobs: recJobApplied,
    recurring_refused: recRefused,
  };

  logger.log(
    `[LB Attribution] phase=apply_done user=${userId} ` +
    `standard_applied=${stdApplied} standard_refused=${stdRefused} ` +
    `recurring_customer_stamps=${recCustApplied} recurring_job_stamps=${recJobApplied} recurring_refused=${recRefused}`
  );

  return {
    summary,
    standard: {
      proposals: merge.proposals,
      ambiguous: merge.ambiguous,
      applied: stdApplied,
      refused: stdRefused,
      refusals: stdRefusals,
    },
    recurring: {
      proposals: recurringProposals,
      applied_customers: recCustApplied,
      applied_jobs: recJobApplied,
      refused: recRefused,
      refusals: recRefusals,
    },
  };
}

module.exports = { runAttributionRecovery };
