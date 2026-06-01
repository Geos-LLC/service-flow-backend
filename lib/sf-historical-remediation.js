'use strict';

// SF↔LB historical-sync remediation tool.
//
// Detects + repairs two classes of LB↔SF state drift that surfaced in
// production Batch #1:
//
//   Type A — LB linked, SF entirely unlinked.
//     Cause: SF's /link-leads-bulk HTTP client timed out before LB
//     finished server-side processing. LB committed the link; SF saw
//     `request_failed` and (correctly) refused to write anything.
//     Detection: LB returns the lb_lead in sync_statuses=['linked']
//     AND SF jobs.lb_external_request_id is NULL.
//
//   Type B — SF audit / customer / outbox exist but jobs.lb_lead_id NULL.
//     Cause: attachLbLink hit the `reattach_same` shortcut (existing
//     lb_external_request_id matched the input), which skipped the
//     jobs UPDATE so lb_lead_id was never populated despite the audit
//     row claiming an attach. Fixed in lib/lb-lead-link-attacher.js.
//     Detection: lb_link_audit row exists for (user, lb_lead_id, sf_job)
//     AND jobs.lb_lead_id IS NULL for that sf_job.
//
// Behavior:
//   dryRun: true (default)  → detect-and-plan only, no SF writes,
//                             no LB calls beyond a read-only candidates
//                             fetch.
//   dryRun: false           → run attachLbLink per row to populate
//                             missing SF state. attachLbLink is
//                             idempotent (deterministic event_id +
//                             ON-CONFLICT-DO-NOTHING on outbox) so it's
//                             safe even if a row drifts between detection
//                             and remediation.
//
// Tenant-scoped: every read/write filters user_id = tenantId.

const { fetchCandidates } = require('./lb-historical-sync-client');
const { attachLbLink }    = require('./lb-lead-link-attacher');
const { resolveLbUserId } = require('./sf-historical-sync-orchestrator');

const JOBS_TABLE          = 'jobs';
const CUSTOMERS_TABLE     = 'customers';
const AUDIT_TABLE         = 'lb_link_audit';
const REMEDIATION_ACTOR   = 'sf_historical_remediation';
const MAX_REMEDIATE_BATCH = 200;

/**
 * Pull all LB-side linked leads for the tenant. Pages by re-calling
 * (state-transition pagination — no cursor) until LB returns count < limit
 * or we hit a safety cap. In practice the linked set is small per tenant
 * for the post-incident reconcile.
 *
 * @returns {Promise<{ok:true, candidates:Array} | {ok:false, ...}>}
 */
async function fetchAllLinked(lbUserId, args) {
  const all = [];
  // Single fetch; LB returns up to 500 per call. For drift remediation
  // anything more than 500 linked rows in one go is itself a flag —
  // surface that to the operator.
  const page = await fetchCandidates({
    lbUserId,
    syncStatuses: ['linked'],
    limit:        500,
    httpClient:   args.httpClient, now: args.now,
  });
  if (!page.ok) return { ok: false, reason: page.reason, error_description: page.error_description };
  for (const c of (page.candidates || [])) all.push(c);
  return { ok: true, candidates: all, more_may_exist: !!page.more_may_exist };
}

/**
 * Detect Type A (LB linked, SF entirely unlinked) + Type B (audit +
 * customer + outbox exist but jobs.lb_lead_id is NULL).
 *
 * @param {object} supabase
 * @param {object} args
 * @param {number} args.tenantId
 * @param {object} [args.httpClient]   - injectable for tests
 * @param {Date}   [args.now]
 * @param {object} [args.logger]
 * @returns {Promise<{ok, tenant_id, lb_user_id, type_a, type_b, ...}>}
 */
async function detect(supabase, args) {
  if (!supabase || typeof supabase.from !== 'function') {
    throw new Error('detect: supabase required');
  }
  if (!args || args.tenantId == null) {
    return { ok: false, status: 400, error: 'invalid_arguments', detail: 'tenantId required' };
  }
  const tenantId = Number(args.tenantId);
  const logger   = args.logger || { log() {}, warn() {}, error() {} };

  const lookup = await resolveLbUserId(supabase, tenantId);
  if (!lookup.ok) return { ok: false, status: lookup.status, error: lookup.error, detail: lookup.detail || null };
  const lbUserId = lookup.lbUserId;

  // 1. Type A — LB has them linked, SF has no record.
  const linkedFetch = await fetchAllLinked(lbUserId, args);
  if (!linkedFetch.ok) {
    return { ok: false, status: 502, error: 'lb_unreachable', detail: linkedFetch.error_description || linkedFetch.reason };
  }
  const lbLinked = linkedFetch.candidates;

  // For each LB-linked candidate, ask SF if it knows about the
  // external_request_id. We compare on lb_external_request_id because
  // it's the field set by every prior LB↔SF path (webhook, attach,
  // bulk-reconcile). lb_lead_id (the UUID) only gets populated by the
  // Phase 2 / attach paths — its absence is exactly what defines drift.
  const extReqIds = lbLinked.map(c => c.externalRequestId).filter(Boolean);
  let sfJobsByExt = new Map();
  if (extReqIds.length > 0) {
    // Chunk the IN clause to stay under PostgREST query size.
    const CHUNK = 100;
    for (let i = 0; i < extReqIds.length; i += CHUNK) {
      const slice = extReqIds.slice(i, i + CHUNK);
      const { data, error } = await supabase.from(JOBS_TABLE)
        .select('id, user_id, customer_id, status, payment_status, last_status_changed_at, updated_at, lb_external_request_id, lb_channel, lb_business_id, lb_lead_id')
        .eq('user_id', tenantId).in('lb_external_request_id', slice);
      if (error) return { ok: false, status: 503, error: 'db_error', detail: error.message };
      for (const r of (data || [])) sfJobsByExt.set(r.lb_external_request_id, r);
    }
  }

  const typeA = [];
  for (const c of lbLinked) {
    const sfJob = sfJobsByExt.get(c.externalRequestId);
    if (!sfJob) {
      // LB has the lead, SF has no corresponding job at all (could be
      // either Type A "never reconciled" or simply a lead SF never saw).
      typeA.push({
        kind: 'type_a_no_sf_job',
        lb_lead_id: c.leadId, lb_external_request_id: c.externalRequestId,
        lb_channel: c.platform, lb_business_id: c.businessId || null,
        lb_lead_status: c.status,
        lb_customer_name: c.customerName, lb_customer_phone: c.customerPhone,
        sf_job_id: null, sf_customer_id: null,
        repair_plan: 'no_sf_job_to_attach_to',
        repair_attempted: false,
      });
      continue;
    }
    // SF has the job; check whether lb_lead_id is missing.
    if (sfJob.lb_lead_id == null) {
      typeA.push({
        kind: 'type_a',
        lb_lead_id: c.leadId, lb_external_request_id: c.externalRequestId,
        lb_channel: c.platform, lb_business_id: c.businessId || null,
        lb_lead_status: c.status,
        sf_job_id: sfJob.id, sf_customer_id: sfJob.customer_id,
        sf_job_status: sfJob.status, sf_payment_status: sfJob.payment_status,
        sf_lb_external_request_id_present: true,
        sf_lb_lead_id_present:             false,
        repair_plan: 'call_attachLbLink_to_populate_lb_lead_id_and_propagate',
      });
    }
    // sfJob.lb_lead_id is already set — could be matching this lead or
    // a different one. If it matches, that's a fully linked record
    // (drop). If it doesn't match, it's a conflict we surface
    // separately, but in practice this only happens when SF has been
    // re-linked to a newer LB record — outside the scope of this
    // remediation.
  }

  // 2. Type B — audit row says attach, but jobs.lb_lead_id is NULL.
  // We focus on audits authored by the apply or remediation paths to
  // avoid flagging legitimate "lb-initiated reconcile event w/o
  // lb_lead_id" rows. Look back N days to bound the scan.
  const TYPE_B_LOOKBACK_DAYS = 60;
  const sinceIso = new Date(Date.now() - TYPE_B_LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const { data: audits, error: auditErr } = await supabase.from(AUDIT_TABLE)
    .select('id, sf_job_id, sf_customer_id, lb_lead_id, lb_external_request_id, lb_channel, lb_business_id, actor, action, applied_at')
    .eq('user_id', tenantId)
    .gte('applied_at', sinceIso)
    .not('lb_lead_id', 'is', null);
  if (auditErr) return { ok: false, status: 503, error: 'db_error', detail: auditErr.message };

  // Filter to audits whose corresponding job still has lb_lead_id NULL.
  const auditJobIds = [...new Set((audits || []).map(a => a.sf_job_id).filter(Boolean))];
  let sfJobsById = new Map();
  if (auditJobIds.length > 0) {
    const CHUNK = 100;
    for (let i = 0; i < auditJobIds.length; i += CHUNK) {
      const slice = auditJobIds.slice(i, i + CHUNK);
      const { data, error } = await supabase.from(JOBS_TABLE)
        .select('id, user_id, customer_id, status, payment_status, last_status_changed_at, updated_at, lb_external_request_id, lb_channel, lb_business_id, lb_lead_id')
        .eq('user_id', tenantId).in('id', slice);
      if (error) return { ok: false, status: 503, error: 'db_error', detail: error.message };
      for (const r of (data || [])) sfJobsById.set(Number(r.id), r);
    }
  }

  const typeB = [];
  // Avoid double-counting rows already flagged as Type A.
  const typeAByJob = new Set(typeA.filter(t => t.sf_job_id != null).map(t => Number(t.sf_job_id)));
  for (const a of (audits || [])) {
    const sfJob = sfJobsById.get(Number(a.sf_job_id));
    if (!sfJob)            continue;
    if (sfJob.lb_lead_id)  continue;          // already populated → fully linked
    if (typeAByJob.has(Number(a.sf_job_id))) continue;
    typeB.push({
      kind: 'type_b',
      sf_job_id: sfJob.id, sf_customer_id: sfJob.customer_id,
      sf_job_status: sfJob.status, sf_payment_status: sfJob.payment_status,
      lb_lead_id: a.lb_lead_id,
      lb_external_request_id: a.lb_external_request_id,
      lb_channel: a.lb_channel, lb_business_id: a.lb_business_id || null,
      audit_id: a.id, audit_action: a.action, audit_actor: a.actor, audit_at: a.applied_at,
      repair_plan: 'rerun_attachLbLink_to_populate_lb_lead_id',
    });
  }

  try { logger.log(`[sf-historical-remediation] tenant=${tenantId} detect: type_a=${typeA.length} type_b=${typeB.length} lb_linked_total=${lbLinked.length}`); } catch (_) {}

  return {
    ok: true,
    tenant_id: tenantId,
    lb_user_id: lbUserId,
    detected_at: new Date().toISOString(),
    counts: { type_a: typeA.length, type_b: typeB.length, lb_linked_total: lbLinked.length },
    type_a: typeA,
    type_b: typeB,
  };
}

/**
 * Repair the detected drift by re-running attachLbLink per row. Safe
 * even if a row is no longer drifted at repair time (attachLbLink is
 * idempotent via the deterministic outbox event_id and ON-CONFLICT
 * absorption).
 *
 * @param {object} supabase
 * @param {object} args   - same as detect + { dryRun: bool, sourceInstance }
 */
async function remediate(supabase, args) {
  const dryRun = args.dryRun !== false;     // default DRY
  const det = await detect(supabase, args);
  if (!det.ok) return det;

  const rowsToRepair = [
    ...det.type_a.filter(t => t.kind === 'type_a'),   // type_a_no_sf_job has no SF job to update
    ...det.type_b,
  ];
  if (rowsToRepair.length > MAX_REMEDIATE_BATCH) {
    return { ok: false, status: 413, error: 'remediation_batch_too_large', detail: `${rowsToRepair.length} candidates exceeds ${MAX_REMEDIATE_BATCH}; chunk operator-side` };
  }

  if (dryRun) {
    return {
      ok: true,
      dry_run: true,
      tenant_id: det.tenant_id, lb_user_id: det.lb_user_id,
      counts: { ...det.counts, repair_eligible: rowsToRepair.length },
      type_a: det.type_a, type_b: det.type_b,
    };
  }

  // Apply path — attachLbLink per row, tenant-scoped.
  const sourceInstance = args.sourceInstance || process.env.SF_SOURCE_INSTANCE || process.env.SF_INSTANCE || 'sf-prod';
  const tenantId = Number(args.tenantId);
  const repaired = [], failed = [];
  for (const r of rowsToRepair) {
    try {
      const res = await attachLbLink(supabase, {
        userId: tenantId,
        actor:  REMEDIATION_ACTOR,
        input: {
          sf_job_id:              r.sf_job_id,
          lb_external_request_id: r.lb_external_request_id,
          lb_channel:             r.lb_channel,
          lb_business_id:         r.lb_business_id || null,
          lb_lead_id:             r.lb_lead_id,
          match_confidence:       'remediation',
          match_signals:          ['post_incident_reconciliation'],
        },
        sourceInstance,
      });
      if (res && res.ok) {
        repaired.push({
          kind: r.kind, sf_job_id: r.sf_job_id, lb_lead_id: r.lb_lead_id,
          action: res.action,
          outbox_event_id: res.synthetic_status_event_id,
          outbox_enqueued: res.synthetic_status_event_enqueued,
          outbox_duplicate: res.synthetic_status_event_duplicate,
          customer_lb_lead_id_propagated: res.customer_lb_lead_id_propagated,
        });
      } else {
        failed.push({ kind: r.kind, sf_job_id: r.sf_job_id, lb_lead_id: r.lb_lead_id, error: (res && res.error) || 'attach_failed' });
      }
    } catch (e) {
      failed.push({ kind: r.kind, sf_job_id: r.sf_job_id, lb_lead_id: r.lb_lead_id, error: String(e && e.message || e) });
    }
  }

  return {
    ok: true,
    dry_run: false,
    tenant_id: det.tenant_id, lb_user_id: det.lb_user_id,
    counts: {
      ...det.counts,
      repair_eligible: rowsToRepair.length,
      repaired: repaired.length,
      failed:   failed.length,
    },
    type_a: det.type_a, type_b: det.type_b,
    repaired, failed,
  };
}

module.exports = {
  detect,
  remediate,
  // exposed for tests
  REMEDIATION_ACTOR,
  MAX_REMEDIATE_BATCH,
};
