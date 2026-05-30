'use strict';

// Bulk historical reconciliation — match a batch of LB leads against
// SF and auto-attach the unambiguous high-confidence ones.
//
// Called by POST /api/integrations/leadbridge/orchestration/bulk-reconcile.
//
// Per-lead pipeline:
//   1. Run matcher (lib/lb-lead-link-matcher.js).
//   2. If exactly one candidate at confidence ≥ 'high' AND no ambiguity
//      warnings AND the candidate's SF job is either unlinked OR
//      already linked to the SAME lb_external_request_id → AUTO-ATTACH
//      via lib/lb-lead-link-attacher.js. Writes audit row + UPDATE +
//      enqueues synthetic job.status_changed event (deterministic
//      event_id; outbox UNIQUE absorbs duplicates).
//   3. Otherwise → emit `needs_review` with the candidate list (LB
//      drives manual attach via /attach-lb-link).
//   4. If matcher returns zero candidates → emit `no_match`.
//
// Hard rules:
//   - tenant-scoped: every call uses the userId from the orchestration
//     bearer; no cross-tenant access possible
//   - batch cap: max 50 leads per call (returns 400 over the cap)
//   - dry-run mode: when args.dryRun=true, runs the matcher only;
//     never writes audit rows, never UPDATEs jobs, never enqueues
//     events. Returns what WOULD happen with each auto_attached
//     becoming auto_attach_preview.
//   - failure isolation: an error on one lead doesn't abort the
//     batch; that lead gets outcome=error with the reason
//   - no PII in logs: per-lead log uses lb_lead_id + outcome only
//   - synthetic events flow back to LB via the existing outbox/drainer
//     (no new SF→LB call); LB "receives the bulk" as a stream of
//     per-event `job.status_changed` deliveries with the
//     `reconciliation` block populated

const { findMatchCandidates } = require('./lb-lead-link-matcher');
const { attachLbLink } = require('./lb-lead-link-attacher');

const MAX_BATCH_SIZE = 50;

const CONF_RANK = { exact: 4, high: 3, medium: 2, low: 1 };

function shouldAutoAttach(candidates) {
  if (!Array.isArray(candidates) || candidates.length !== 1) return false;
  const c = candidates[0];
  if ((CONF_RANK[c.confidence] || 0) < CONF_RANK.high) return false;
  if (Array.isArray(c.ambiguity_warnings) && c.ambiguity_warnings.length > 0) return false;
  return true;
}

/**
 * Run reconciliation across a batch of LB leads.
 *
 * @param {object} supabase
 * @param {object} args
 * @param {number} args.userId
 * @param {Array<object>} args.leads  Each: { lb_lead_id, lb_external_request_id, lb_channel, lb_business_id, customer_phone, customer_email, customer_name, lead_created_at }
 * @param {boolean} [args.dryRun=false]
 * @param {object} [args.logger]
 * @returns {Promise<{ok, summary, results}>}
 */
async function reconcileBatch(supabase, args) {
  if (!supabase || typeof supabase.from !== 'function') {
    throw new Error('reconcileBatch: supabase required');
  }
  if (args == null || args.userId == null) {
    return { ok: false, status: 400, error: 'invalid_arguments', detail: 'userId required' };
  }
  if (!Array.isArray(args.leads)) {
    return { ok: false, status: 400, error: 'invalid_arguments', detail: 'leads array required' };
  }
  if (args.leads.length === 0) {
    return { ok: true, summary: { total: 0, auto_attached: 0, needs_review: 0, no_match: 0, error: 0 }, results: [] };
  }
  if (args.leads.length > MAX_BATCH_SIZE) {
    return { ok: false, status: 400, error: 'batch_too_large', detail: `max ${MAX_BATCH_SIZE} leads per call (got ${args.leads.length})` };
  }
  const logger = args.logger || { log() {}, warn() {}, error() {} };
  const dryRun = args.dryRun === true;

  const results = [];
  const summary = {
    total: args.leads.length,
    auto_attached: 0,
    auto_attach_preview: 0,
    needs_review: 0,
    no_match: 0,
    error: 0,
  };

  // Process leads sequentially so per-lead writes don't race on the
  // same SF job row (rare but possible if LB sends duplicate-target
  // leads in one batch). Bound work — 50 max — keeps total latency
  // under a few seconds for typical batches.
  for (const lead of args.leads) {
    const lbLeadId = lead && lead.lb_lead_id;
    try {
      // 1. Match
      const { candidates } = await findMatchCandidates(supabase, {
        userId: args.userId,
        input: {
          lb_lead_id:             lead.lb_lead_id             || null,
          lb_external_request_id: lead.lb_external_request_id || null,
          lb_channel:             lead.lb_channel             || null,
          lb_business_id:         lead.lb_business_id         || null,
          customer_phone:         lead.customer_phone         || null,
          customer_email:         lead.customer_email         || null,
          customer_name:          lead.customer_name          || null,
          lead_created_at:        lead.lead_created_at        || null,
        },
      });

      if (!candidates || candidates.length === 0) {
        summary.no_match++;
        results.push({
          lb_lead_id:             lbLeadId,
          lb_external_request_id: lead.lb_external_request_id || null,
          outcome:                'no_match',
        });
        try { logger.log(`[lb-bulk-reconcile] lead=${lbLeadId || '-'} outcome=no_match`); } catch (_) {}
        continue;
      }

      const auto = shouldAutoAttach(candidates);

      // 2a. Eligible for auto-attach — but check SF job linkage state.
      //     If the SF job is already linked to a DIFFERENT
      //     lb_external_request_id, we cannot auto-attach (would
      //     overwrite existing data without explicit consent). Surface
      //     for review with the conflict signal instead.
      if (auto) {
        const c = candidates[0];
        const existing = c.sf_job && c.sf_job.lb_external_request_id;
        const incoming = lead.lb_external_request_id;
        if (existing && incoming && existing !== incoming) {
          summary.needs_review++;
          results.push({
            lb_lead_id:             lbLeadId,
            lb_external_request_id: incoming,
            outcome:                'needs_review',
            reason:                 'sf_job_linked_to_different_lb_lead',
            candidates,
          });
          try { logger.log(`[lb-bulk-reconcile] lead=${lbLeadId || '-'} outcome=needs_review reason=conflict`); } catch (_) {}
          continue;
        }

        // 2b. Dry-run: preview only, no writes
        if (dryRun) {
          summary.auto_attach_preview++;
          results.push({
            lb_lead_id:             lbLeadId,
            lb_external_request_id: lead.lb_external_request_id || null,
            outcome:                'auto_attach_preview',
            confidence:             c.confidence,
            match_signals:          c.match_signals,
            sf_customer_id:         c.sf_customer_id,
            sf_job_id:              c.sf_job_id,
            sf_job_status:          c.sf_job ? c.sf_job.status : null,
            sf_job_payment_status:  c.sf_job ? c.sf_job.payment_status : null,
          });
          try { logger.log(`[lb-bulk-reconcile] lead=${lbLeadId || '-'} outcome=auto_attach_preview sf_job=${c.sf_job_id || '-'} conf=${c.confidence}`); } catch (_) {}
          continue;
        }

        // 2c. Apply: call the attacher (writes audit + UPDATE + enqueues synthetic event)
        if (!c.sf_job_id) {
          // High-confidence customer match but no SF job → can't auto-attach
          // at the job level. Surface as needs_review so LB can decide
          // whether to call /attach-lb-link with sf_customer_id instead
          // (future enhancement; current attach is job-only).
          summary.needs_review++;
          results.push({
            lb_lead_id:             lbLeadId,
            lb_external_request_id: lead.lb_external_request_id || null,
            outcome:                'needs_review',
            reason:                 'customer_match_no_job',
            candidates,
          });
          try { logger.log(`[lb-bulk-reconcile] lead=${lbLeadId || '-'} outcome=needs_review reason=customer_no_job`); } catch (_) {}
          continue;
        }

        const attach = await attachLbLink(supabase, {
          userId: args.userId,
          input: {
            sf_job_id:              c.sf_job_id,
            lb_external_request_id: lead.lb_external_request_id,
            lb_channel:             lead.lb_channel,
            lb_business_id:         lead.lb_business_id || null,
            lb_lead_id:             lead.lb_lead_id || null,
            match_confidence:       c.confidence,
            match_signals:          c.match_signals,
            force_overwrite:        false,
          },
        });

        if (!attach.ok) {
          summary.error++;
          results.push({
            lb_lead_id:             lbLeadId,
            lb_external_request_id: lead.lb_external_request_id || null,
            outcome:                'error',
            error:                  attach.error,
            status:                 attach.status || null,
            detail:                 attach.detail || null,
          });
          try { logger.warn(`[lb-bulk-reconcile] lead=${lbLeadId || '-'} outcome=error attach_error=${attach.error} status=${attach.status}`); } catch (_) {}
          continue;
        }

        summary.auto_attached++;
        results.push({
          lb_lead_id:                       lbLeadId,
          lb_external_request_id:           lead.lb_external_request_id,
          outcome:                          'auto_attached',
          action:                           attach.action,
          confidence:                       c.confidence,
          match_signals:                    c.match_signals,
          sf_customer_id:                   c.sf_customer_id,
          sf_job_id:                        attach.sf_job_id,
          sf_job_status:                    c.sf_job ? c.sf_job.status : null,
          sf_job_payment_status:            c.sf_job ? c.sf_job.payment_status : null,
          synthetic_status_event_id:        attach.synthetic_status_event_id,
          synthetic_status_event_enqueued:  attach.synthetic_status_event_enqueued,
          synthetic_status_event_duplicate: attach.synthetic_status_event_duplicate,
        });
        try { logger.log(`[lb-bulk-reconcile] lead=${lbLeadId || '-'} outcome=auto_attached sf_job=${attach.sf_job_id} conf=${c.confidence} event=${attach.synthetic_status_event_id}`); } catch (_) {}
        continue;
      }

      // 3. Not eligible for auto-attach — surface candidates for review.
      summary.needs_review++;
      results.push({
        lb_lead_id:             lbLeadId,
        lb_external_request_id: lead.lb_external_request_id || null,
        outcome:                'needs_review',
        reason:                 candidates.length > 1 ? 'multiple_candidates' : 'low_confidence',
        candidates,
      });
      try { logger.log(`[lb-bulk-reconcile] lead=${lbLeadId || '-'} outcome=needs_review reason=${candidates.length > 1 ? 'multiple' : 'low'} count=${candidates.length}`); } catch (_) {}
    } catch (e) {
      summary.error++;
      results.push({
        lb_lead_id:             lbLeadId,
        lb_external_request_id: lead.lb_external_request_id || null,
        outcome:                'error',
        error:                  'unexpected',
        detail:                 String(e && e.message || e),
      });
      try { logger.error(`[lb-bulk-reconcile] lead=${lbLeadId || '-'} outcome=error msg=${e && e.message}`); } catch (_) {}
    }
  }

  return { ok: true, dry_run: dryRun, summary, results };
}

module.exports = {
  reconcileBatch,
  shouldAutoAttach,
  MAX_BATCH_SIZE,
};
