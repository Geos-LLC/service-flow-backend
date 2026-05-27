'use strict';

// LeadBridge semantic observability (Phase 1.5).
//
// Model recap:
//   ServiceFlow / Zenbooker = OPERATIONAL truth (jobs, work, payment, payroll)
//   LeadBridge              = ACQUISITION + CONVERSATION source (Thumbtack/Yelp leads)
//   Attribution bridge      = OPTIONAL (lb_external_request_id, acquisition_*)
//
// This module produces READ-ONLY diagnostic views over SF state so operators
// and the UI can see attribution, operational lifecycle, and LB conversation
// as separate concepts. NO mutations. NO outbound events. NO LB API calls
// from these helpers — they only consult what SF already knows.
//
// Two helpers:
//
//   buildSemanticSummary(supabase, userId)
//     → tenant-wide counts across the four domains:
//        sf operational, lb attribution, customer acquisition, outbound errors.
//     Cross-domain comparison counts (cross_domain_difference,
//     not_applicable_to_lb, marketplace_only_lead, unconverted_lb_lead)
//     require a live LB pull — these are surfaced via /sync?mode=dryRun,
//     not here, and that source-of-truth note is included in the response.
//
//   buildEntitySemanticState(supabase, userId, type, id)
//     → per-entity diagnostic for a single job / lead / customer.
//     Returns the classification + reason + whether it should sync to LB.
//
// Classification taxonomy (single-entity):
//   standalone_sf_work               — SF/ZB-owned, no LB attribution
//   lb_attributed_work               — has LB linkage
//   lb_lead_only                     — LB lead in SF leads, no SF customer/job yet
//   sf_lead_only                     — SF lead with no LB linkage
//   unconverted_lead                 — LB lead never reached "Won" stage
//   recurring_customer_attribution   — customer with LB acquisition + multiple jobs
//   not_applicable_to_lb             — SF state has no LB equivalent (e.g. future scheduled)
//   true_error                       — outbound event in dlq/failed
//
// The cross_domain_difference and marketplace_only_lead classifications
// require pairing an entity with a live LB lead status; they're emitted by
// the /sync flow, not by these single-entity diagnostics.

// ──────────────────────────────────────────────────────────────────
// Tenant-wide summary
// ──────────────────────────────────────────────────────────────────
async function buildSemanticSummary(supabase, userId) {
  if (userId == null) throw new Error('buildSemanticSummary: userId required');

  // Aggregate counts. Each .select with head:true count:'exact' returns a
  // count without the rows — cheap on prod-sized tables.
  const counts = {};
  const errors = [];

  async function safeCount(label, queryBuilder) {
    try {
      const { count, error } = await queryBuilder;
      if (error) { errors.push({ label, message: error.message }); counts[label] = null; return; }
      counts[label] = count ?? 0;
    } catch (e) {
      errors.push({ label, message: e?.message || String(e) });
      counts[label] = null;
    }
  }

  // ── SF operational ──
  await safeCount('sf_jobs_total',
    supabase.from('jobs').select('*', { count: 'exact', head: true }).eq('user_id', userId));
  await safeCount('sf_jobs_lb_attributed',
    supabase.from('jobs').select('*', { count: 'exact', head: true }).eq('user_id', userId).not('lb_external_request_id', 'is', null));
  await safeCount('sf_jobs_completed',
    supabase.from('jobs').select('*', { count: 'exact', head: true }).eq('user_id', userId).eq('status', 'completed'));

  counts.sf_jobs_standalone = counts.sf_jobs_total != null && counts.sf_jobs_lb_attributed != null
    ? counts.sf_jobs_total - counts.sf_jobs_lb_attributed
    : null;

  // ── SF leads ──
  await safeCount('sf_leads_total',
    supabase.from('leads').select('*', { count: 'exact', head: true }).eq('user_id', userId));
  await safeCount('sf_leads_lb_attributed',
    supabase.from('leads').select('*', { count: 'exact', head: true }).eq('user_id', userId).not('lb_external_request_id', 'is', null));
  await safeCount('sf_leads_lb_unconverted',
    supabase.from('leads').select('*', { count: 'exact', head: true }).eq('user_id', userId).not('lb_external_request_id', 'is', null).is('converted_customer_id', null));
  await safeCount('sf_leads_lb_converted',
    supabase.from('leads').select('*', { count: 'exact', head: true }).eq('user_id', userId).not('lb_external_request_id', 'is', null).not('converted_customer_id', 'is', null));

  counts.sf_leads_lb_only = counts.sf_leads_total != null && counts.sf_leads_lb_attributed != null
    ? counts.sf_leads_total - counts.sf_leads_lb_attributed
    : null;

  // ── Customer acquisition ──
  await safeCount('customers_total',
    supabase.from('customers').select('*', { count: 'exact', head: true }).eq('user_id', userId));
  await safeCount('customers_lb_attributed',
    supabase.from('customers').select('*', { count: 'exact', head: true }).eq('user_id', userId).not('acquisition_external_request_id', 'is', null).eq('acquisition_source', 'leadbridge'));
  await safeCount('customers_any_acquisition',
    supabase.from('customers').select('*', { count: 'exact', head: true }).eq('user_id', userId).not('acquisition_external_request_id', 'is', null));

  // ── Outbound errors (true failures) ──
  await safeCount('outbound_queue_total',
    supabase.from('leadbridge_outbound_events').select('*', { count: 'exact', head: true }).eq('user_id', userId));
  await safeCount('outbound_queue_dlq',
    supabase.from('leadbridge_outbound_events').select('*', { count: 'exact', head: true }).eq('user_id', userId).eq('state', 'dlq'));
  await safeCount('outbound_queue_failed',
    supabase.from('leadbridge_outbound_events').select('*', { count: 'exact', head: true }).eq('user_id', userId).eq('state', 'failed'));

  // ── Recurring-customer attribution: customers with LB acquisition AND
  // ≥2 jobs in SF. Computed via a separate count of jobs grouped by
  // customer, but Supabase doesn't expose group-by; we approximate by
  // counting customers with acquisition + the per-customer-job lookup is
  // skipped at the summary level to keep this query cheap. Operators can
  // get exact recurring counts from the attribution-recovery report.
  counts.customers_lb_attributed_recurring = null; // surfaced in per-entity view

  // ── Final reframed view (the additive semantic taxonomy) ──
  const classifications = {
    standalone_sf_work: counts.sf_jobs_standalone,
    lb_attributed_work: counts.sf_jobs_lb_attributed,
    lb_attributed_customers: counts.customers_lb_attributed,
    unconverted_lead: counts.sf_leads_lb_unconverted,
    sf_lead_only: counts.sf_leads_lb_only,
    lb_lead_with_conversion: counts.sf_leads_lb_converted,
    true_error: (counts.outbound_queue_dlq || 0) + (counts.outbound_queue_failed || 0),
  };

  // ── Cross-domain counts deferred to /sync ──
  const requires_live_lb_pull = {
    cross_domain_difference: null,
    not_applicable_to_lb: null,
    marketplace_only_lead: null,
    high_confidence_attribution_proposed: null,
    recurring_attribution_proposed: null,
    note: 'Run POST /api/integrations/leadbridge/sync?mode=dryRun to compute these counts; they require a live LB API pull and a comparison pass.',
  };

  return {
    model: {
      service_flow_owns: 'operational lifecycle (jobs, work, payment, payroll)',
      leadbridge_owns: 'acquisition + conversation lifecycle (Thumbtack/Yelp leads)',
      attribution_bridge: 'optional — lb_external_request_id, acquisition_*',
    },
    counts,
    classifications,
    requires_live_lb_pull,
    user_id: userId,
    errors: errors.length > 0 ? errors : undefined,
  };
}

// ──────────────────────────────────────────────────────────────────
// Per-entity diagnostic
// ──────────────────────────────────────────────────────────────────
async function buildEntitySemanticState(supabase, userId, type, id) {
  if (userId == null) throw new Error('buildEntitySemanticState: userId required');
  if (!['job', 'lead', 'customer'].includes(type)) {
    throw new Error(`buildEntitySemanticState: type must be one of job|lead|customer, got '${type}'`);
  }
  if (id == null) throw new Error('buildEntitySemanticState: id required');

  if (type === 'job') return buildJobSemanticState(supabase, userId, id);
  if (type === 'lead') return buildLeadSemanticState(supabase, userId, id);
  return buildCustomerSemanticState(supabase, userId, id);
}

async function buildJobSemanticState(supabase, userId, id) {
  const { data: job, error: jobErr } = await supabase
    .from('jobs')
    .select('id, user_id, status, last_status_source, last_status_changed_at, scheduled_date, customer_id, team_member_id, zenbooker_id, lb_external_request_id, lb_channel, lb_business_id, invoice_status, is_recurring')
    .eq('id', id)
    .eq('user_id', userId)
    .maybeSingle();
  if (jobErr) throw new Error(`job lookup failed: ${jobErr.message}`);
  if (!job) return { type: 'job', id, found: false };

  // ZB linkage + paid transaction (operational truth)
  let zb_state = null;
  if (job.zenbooker_id) {
    const { data: tx } = await supabase
      .from('transactions')
      .select('id, status, amount, payment_method, zenbooker_id, created_at')
      .eq('user_id', userId).eq('job_id', id).eq('status', 'completed')
      .maybeSingle();
    zb_state = {
      zenbooker_id: job.zenbooker_id,
      has_zb_transaction: !!tx,
      zb_paid: !!tx,
      zb_amount: tx?.amount ?? null,
      zb_payment_method: tx?.payment_method ?? null,
      zb_paid_at: tx?.created_at ?? null,
    };
  }

  // Customer acquisition rollup
  let acquisition_attribution = null;
  if (job.customer_id != null) {
    const { data: cust } = await supabase
      .from('customers')
      .select('id, acquisition_source, acquisition_channel, acquisition_business_id, acquisition_external_request_id, acquisition_at')
      .eq('id', job.customer_id).eq('user_id', userId).maybeSingle();
    if (cust) {
      acquisition_attribution = {
        customer_id: cust.id,
        acquisition_source: cust.acquisition_source,
        acquisition_channel: cust.acquisition_channel,
        acquisition_business_id: cust.acquisition_business_id,
        acquisition_external_request_id: cust.acquisition_external_request_id,
        acquisition_at: cust.acquisition_at,
        is_lb_acquired: cust.acquisition_source === 'leadbridge' && cust.acquisition_external_request_id != null,
      };
    }
  }

  const lb_attribution = {
    lb_external_request_id: job.lb_external_request_id,
    lb_channel: job.lb_channel,
    lb_business_id: job.lb_business_id,
    has_attribution: job.lb_external_request_id != null,
  };

  // Classification
  let classification, reason;
  if (!lb_attribution.has_attribution) {
    classification = 'standalone_sf_work';
    reason = 'No lb_external_request_id on the job — SF/ZB-owned operational work.';
  } else {
    classification = 'lb_attributed_work';
    reason = 'lb_external_request_id is set; this job carries acquisition linkage to an LB lead.';
  }

  // Should-sync rule (read-only; describes intent, does not enqueue).
  // A job that has LB linkage AND a status that maps to an LB canonical
  // value MAY produce an outbound event when the reconciler runs. A job
  // with a status that has no LB mapping is `not_applicable_to_lb`.
  let should_sync_to_lb = null;
  let sync_reason = null;
  if (!lb_attribution.has_attribution) {
    should_sync_to_lb = false;
    sync_reason = 'standalone_sf_work — no LB linkage';
  } else {
    try {
      const { mapSfToLbCanonical } = require('./lb-sf-canonical-map');
      const canonical = mapSfToLbCanonical(job.status);
      if (canonical == null) {
        should_sync_to_lb = false;
        sync_reason = `not_applicable_to_lb — sf_status='${job.status}' has no LB canonical mapping`;
      } else {
        should_sync_to_lb = true;
        sync_reason = `lb_attributed_work — sf_status='${job.status}' canonicalizes to '${canonical}'; reconcile decides whether to push on next sync`;
      }
    } catch (_) {
      should_sync_to_lb = null;
      sync_reason = 'mapping module unavailable';
    }
  }

  return {
    type: 'job',
    id: job.id,
    found: true,
    sf_state: {
      status: job.status,
      last_status_source: job.last_status_source,
      last_status_changed_at: job.last_status_changed_at,
      scheduled_date: job.scheduled_date,
      customer_id: job.customer_id,
      team_member_id: job.team_member_id,
      invoice_status: job.invoice_status,
      is_recurring: job.is_recurring,
    },
    zb_state,
    lb_attribution,
    acquisition_attribution,
    classification,
    reason,
    operational_link: {
      has_operational_job: true,
      operational_state: job.status,
    },
    should_sync_to_lb,
    sync_reason,
  };
}

async function buildLeadSemanticState(supabase, userId, id) {
  const { data: lead, error } = await supabase
    .from('leads')
    .select('id, user_id, pipeline_id, stage_id, converted_customer_id, converted_at, lb_external_request_id, lb_channel, lb_business_id, source, source_raw, created_at')
    .eq('id', id).eq('user_id', userId).maybeSingle();
  if (error) throw new Error(`lead lookup failed: ${error.message}`);
  if (!lead) return { type: 'lead', id, found: false };

  let stage_name = null;
  if (lead.stage_id != null) {
    const { data: stage } = await supabase
      .from('lead_stages').select('name').eq('id', lead.stage_id).maybeSingle();
    stage_name = stage?.name ?? null;
  }

  const has_lb_attribution = lead.lb_external_request_id != null;
  const is_converted = lead.converted_customer_id != null;

  let classification, reason;
  if (!has_lb_attribution && !is_converted) {
    classification = 'sf_lead_only';
    reason = 'No LB linkage; never converted to a customer.';
  } else if (!has_lb_attribution && is_converted) {
    classification = 'sf_lead_only';
    reason = 'No LB linkage; converted to a customer via SF/ZB-only path.';
  } else if (has_lb_attribution && !is_converted) {
    classification = 'unconverted_lead';
    reason = `LB lead at stage='${stage_name || 'unknown'}'; never reached "Won". Normal — not every lead converts.`;
  } else {
    classification = 'lb_attributed_work';
    reason = 'LB lead converted into an SF customer; attribution chain complete.';
  }

  return {
    type: 'lead',
    id: lead.id,
    found: true,
    sf_state: {
      pipeline_id: lead.pipeline_id,
      stage_id: lead.stage_id,
      stage_name,
      source: lead.source,
      source_raw: lead.source_raw,
      converted_customer_id: lead.converted_customer_id,
      converted_at: lead.converted_at,
      created_at: lead.created_at,
    },
    lb_attribution: {
      lb_external_request_id: lead.lb_external_request_id,
      lb_channel: lead.lb_channel,
      lb_business_id: lead.lb_business_id,
      has_attribution: has_lb_attribution,
    },
    classification,
    reason,
    operational_link: {
      has_operational_job: is_converted, // proxy: converted customer = potential job(s)
      operational_state: stage_name || null,
    },
    should_sync_to_lb: false,
    sync_reason: 'Leads do not directly drive SF→LB outbound; only jobs do.',
  };
}

async function buildCustomerSemanticState(supabase, userId, id) {
  const { data: cust, error } = await supabase
    .from('customers')
    .select('id, user_id, first_name, last_name, phone, email, source, zenbooker_id, acquisition_source, acquisition_channel, acquisition_business_id, acquisition_external_request_id, acquisition_at, created_at')
    .eq('id', id).eq('user_id', userId).maybeSingle();
  if (error) throw new Error(`customer lookup failed: ${error.message}`);
  if (!cust) return { type: 'customer', id, found: false };

  // Count jobs to detect recurring relationship + LB-attribution depth
  const { count: total_jobs } = await supabase
    .from('jobs').select('*', { count: 'exact', head: true })
    .eq('user_id', userId).eq('customer_id', id);
  const { count: lb_attributed_jobs } = await supabase
    .from('jobs').select('*', { count: 'exact', head: true })
    .eq('user_id', userId).eq('customer_id', id).not('lb_external_request_id', 'is', null);

  const is_lb_acquired = cust.acquisition_source === 'leadbridge'
    && cust.acquisition_external_request_id != null;
  const is_recurring = (total_jobs || 0) >= 2;

  let classification, reason;
  if (is_lb_acquired && is_recurring) {
    classification = 'recurring_customer_attribution';
    reason = `LB-acquired customer with ${total_jobs} jobs — stable recurring relationship.`;
  } else if (is_lb_acquired) {
    classification = 'lb_attributed_work';
    reason = `LB-acquired customer with ${total_jobs || 0} job(s) — single-touch acquisition.`;
  } else if (cust.acquisition_source != null) {
    classification = 'standalone_sf_work';
    reason = `Acquisition via '${cust.acquisition_source}' (not LeadBridge).`;
  } else {
    classification = 'standalone_sf_work';
    reason = 'No acquisition attribution recorded; customer originated outside LB.';
  }

  return {
    type: 'customer',
    id: cust.id,
    found: true,
    sf_state: {
      first_name: cust.first_name,
      last_name: cust.last_name,
      phone: cust.phone,
      email: cust.email,
      source: cust.source,
      zenbooker_id: cust.zenbooker_id,
      created_at: cust.created_at,
    },
    acquisition_attribution: {
      acquisition_source: cust.acquisition_source,
      acquisition_channel: cust.acquisition_channel,
      acquisition_business_id: cust.acquisition_business_id,
      acquisition_external_request_id: cust.acquisition_external_request_id,
      acquisition_at: cust.acquisition_at,
      is_lb_acquired,
    },
    job_rollup: {
      total_jobs: total_jobs || 0,
      lb_attributed_jobs: lb_attributed_jobs || 0,
      is_recurring,
    },
    classification,
    reason,
    operational_link: {
      has_operational_job: (total_jobs || 0) > 0,
      operational_state: null,
    },
    should_sync_to_lb: false,
    sync_reason: 'Customers do not directly drive SF→LB outbound; only the acquisition job does.',
  };
}

module.exports = {
  buildSemanticSummary,
  buildEntitySemanticState,
};
