'use strict';

// Pure classifier predicates for the ZB historical-cleanup project.
//
// classifyJob(job, lookups, opts) -> {
//   bucket: 'safe_archive' | 'safe_keep' | 'manual_review'
//         | 'untouched_outside_scope',
//   reasons: [string codes],
//   risk: { score, deductions, band } | null   // only on safe_archive
// }
//
// Predicate order is fixed:  safe_keep > manual_review > safe_archive.
// Anything that fails the safe_archive gate without hitting keep/review
// lands in 'untouched_outside_scope' for audit.
//
// Reason codes are stable strings — operators grep/group on them. Do not
// change wording without bumping CLASSIFIER_VERSION.

const { calculateRiskScore, riskBand } = require('./risk-score');

const CLASSIFIER_VERSION = 'v2.0.0';

// ─── helpers ─────────────────────────────────────────────────────────
function tagsHas(job, value) {
  if (!job.tags) return false;
  if (Array.isArray(job.tags)) return job.tags.includes(value);
  if (typeof job.tags === 'string') return job.tags.toLowerCase().includes(value);
  return false;
}

function hasImportSignature(job) {
  return Boolean(
    tagsHas(job, 'imported') ||
    tagsHas(job, 'booking-koala') ||
    (job.contact_info &&
      typeof job.contact_info === 'object' &&
      job.contact_info.external_id != null),
  );
}

function inWindow(job, windowStart, windowEnd) {
  if (!job.created_at) return false;
  const t = new Date(job.created_at).getTime();
  return t >= new Date(windowStart).getTime() && t < new Date(windowEnd).getTime();
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// updated_at - created_at within `thresholdMs` (default 1h).
function withinDriftThreshold(job, thresholdMs) {
  if (!job.created_at || !job.updated_at) return true; // null updated_at == not advanced
  const c = new Date(job.created_at).getTime();
  const u = new Date(job.updated_at).getTime();
  if (!Number.isFinite(c) || !Number.isFinite(u)) return false;
  return u - c <= thresholdMs;
}

// ─── SAFE_KEEP — return non-empty array if any rule fires ────────────
function checkSafeKeep(job, lookups) {
  const reasons = [];

  if (job.is_recurring === true) reasons.push('is_recurring_parent');
  if (
    job.customer_id != null &&
    lookups.recurringParentByCustomer &&
    lookups.recurringParentByCustomer.has(job.customer_id) &&
    // exclude self (job IS its own recurring parent)
    !(job.is_recurring === true)
  ) {
    reasons.push('customer_has_active_recurring_chain');
  }

  if (
    job.customer_id != null &&
    lookups.futureJobsByCustomer &&
    lookups.futureJobsByCustomer.has(job.customer_id)
  ) {
    reasons.push('customer_has_future_appointment');
  }

  if (
    ['paid', 'partial', 'refunded'].includes((job.payment_status || '').toLowerCase())
  ) {
    reasons.push('payment_status_paid_or_partial');
  }
  if (['paid', 'invoiced'].includes((job.invoice_status || '').toLowerCase())) {
    reasons.push('invoice_status_paid_or_invoiced');
  }
  if (lookups.txJobIds && lookups.txJobIds.has(job.id)) {
    reasons.push('has_transactions');
  }

  if (job.lb_external_request_id != null && job.lb_channel != null) {
    reasons.push('lb_linked');
  }
  if (lookups.lbOutboxJobIds && lookups.lbOutboxJobIds.has(job.id)) {
    reasons.push('lb_outbound_outbox_present');
  }

  if (job.last_status_source != null) {
    reasons.push('operationally_touched_status_source');
  }

  if (
    !tagsHas(job, 'imported') &&
    !tagsHas(job, 'booking-koala') &&
    !(job.contact_info && job.contact_info.external_id)
  ) {
    reasons.push('not_an_import_artifact');
  }

  if (
    job.customer_id != null &&
    lookups.convsByCustomer &&
    lookups.convsByCustomer.has(job.customer_id)
  ) {
    reasons.push('customer_has_conversations');
  }

  if (lookups.batchedLedgerJobIds && lookups.batchedLedgerJobIds.has(job.id)) {
    reasons.push('finalized_payout_ledger_exposure');
  }

  if (job.cancellation_fee != null) reasons.push('has_cancellation_fee');
  if (
    lookups.cancellationExpenseJobIds &&
    lookups.cancellationExpenseJobIds.has(job.id)
  ) {
    reasons.push('has_cancellation_expense');
  }

  return reasons;
}

// ─── MANUAL_REVIEW — anomaly codes for human triage ──────────────────
function checkManualReview(job, lookups, opts) {
  const reasons = [];

  if (job.status === 'completed' && job.cancelled_at != null) {
    reasons.push('completed_with_cancelled_at');
  }
  if (num(job.total_amount) > 0 && (job.service_price == null || num(job.service_price) === 0)) {
    reasons.push('total_without_service_price');
  }
  if (job.scheduled_date == null) reasons.push('null_scheduled_date');

  // Imported but created outside the auto-detected window — back-dated retry?
  if (hasImportSignature(job) && opts && !inWindow(job, opts.windowStart, opts.windowEnd)) {
    reasons.push('imported_outside_window');
  }

  // Orphan ledger: unbatched ledger row exists but no transactions / payment
  if (
    lookups.unbatchedLedgerJobIds &&
    lookups.unbatchedLedgerJobIds.has(job.id) &&
    !(lookups.txJobIds && lookups.txJobIds.has(job.id))
  ) {
    reasons.push('orphan_ledger');
  }

  // XOR partial LB linkage
  const reqIdSet = job.lb_external_request_id != null;
  const channelSet = job.lb_channel != null;
  if (reqIdSet !== channelSet) reasons.push('partial_lb_linkage');

  if (
    reqIdSet && channelSet && job.last_status_source == null
  ) {
    reasons.push('lb_linked_but_status_source_null');
  }

  // Recurring=true completed with no chain children = stranded recurring
  if (job.is_recurring === true && job.status === 'completed') {
    const customerHasOthers =
      job.customer_id != null &&
      lookups.customerJobsTotal &&
      (lookups.customerJobsTotal.get(job.customer_id) || 0) > 1;
    if (!customerHasOthers) reasons.push('recurring_completed_no_chain');
  }

  return reasons;
}

// ─── SAFE_ARCHIVE — return array of BLOCKERS (empty = safe) ──────────
function checkSafeArchive(job, lookups, opts) {
  const blockers = [];

  // Provenance gate
  if (!hasImportSignature(job)) blockers.push('no_import_signature');
  if (!inWindow(job, opts.windowStart, opts.windowEnd)) {
    blockers.push('outside_import_window');
  }

  // Status gate
  if (job.status !== 'completed') blockers.push('status_not_completed');

  // §1.2 four-part "never operationally touched" gate
  if (job.last_status_source != null) blockers.push('last_status_source_set');
  if (job.last_status_changed_at != null) blockers.push('last_status_changed_at_set');
  if (!withinDriftThreshold(job, opts.driftThresholdMs)) {
    blockers.push('updated_at_drift_exceeded');
  }
  if (job.start_time != null) blockers.push('start_time_set');
  if (job.end_time != null) blockers.push('end_time_set');
  if (job.hours_worked != null) blockers.push('hours_worked_set');
  if (num(job.tip_amount) !== 0) blockers.push('tip_amount_nonzero');
  if (num(job.incentive_amount) !== 0) blockers.push('incentive_amount_nonzero');
  if (job.cancelled_at != null) blockers.push('cancelled_at_set');

  if (lookups.statusHistJobIds && lookups.statusHistJobIds.has(job.id)) {
    blockers.push('has_job_status_history');
  }
  if (lookups.payrollEditJobIds && lookups.payrollEditJobIds.has(job.id)) {
    blockers.push('has_payroll_edits');
  }
  if (lookups.ledgerJobIds && lookups.ledgerJobIds.has(job.id)) {
    blockers.push('has_cleaner_ledger');
  }

  // Money gate
  if (
    ['paid', 'partial', 'refunded'].includes((job.payment_status || '').toLowerCase())
  ) {
    blockers.push('payment_status_blocking');
  }
  if (['paid', 'invoiced'].includes((job.invoice_status || '').toLowerCase())) {
    blockers.push('invoice_status_blocking');
  }
  if (lookups.txJobIds && lookups.txJobIds.has(job.id)) {
    blockers.push('has_transactions');
  }

  // LB gate (defense in depth — duplicates SAFE_KEEP rules)
  if (job.lb_external_request_id != null) blockers.push('lb_external_request_id_set');
  if (lookups.lbOutboxJobIds && lookups.lbOutboxJobIds.has(job.id)) {
    blockers.push('lb_outbound_outbox_present');
  }

  // Recurring schedule gate
  if (job.is_recurring === true) blockers.push('is_recurring_self');
  if (
    job.customer_id != null &&
    lookups.recurringParentByCustomer &&
    lookups.recurringParentByCustomer.has(job.customer_id)
  ) {
    blockers.push('customer_has_active_recurring_chain');
  }

  // Future appointment gate
  if (
    job.customer_id != null &&
    lookups.futureJobsByCustomer &&
    lookups.futureJobsByCustomer.has(job.customer_id)
  ) {
    blockers.push('customer_has_future_appointment');
  }

  // Customer comm gate
  if (
    job.customer_id != null &&
    lookups.convsByCustomer &&
    lookups.convsByCustomer.has(job.customer_id)
  ) {
    blockers.push('customer_has_conversations');
  }

  // Cancellation accounting gate
  if (job.cancellation_fee != null) blockers.push('has_cancellation_fee');
  if (
    lookups.cancellationExpenseJobIds &&
    lookups.cancellationExpenseJobIds.has(job.id)
  ) {
    blockers.push('has_cancellation_expense');
  }

  return blockers;
}

// ─── public entry point ──────────────────────────────────────────────
function classifyJob(job, lookups, opts) {
  if (!opts || !opts.windowStart || !opts.windowEnd) {
    throw new Error('classifyJob: opts.windowStart and opts.windowEnd required');
  }
  const driftThresholdMs = opts.driftThresholdMs != null ? opts.driftThresholdMs : 60 * 60 * 1000;
  const localOpts = {
    windowStart: opts.windowStart,
    windowEnd: opts.windowEnd,
    driftThresholdMs,
  };

  const keepReasons = checkSafeKeep(job, lookups || {});
  if (keepReasons.length) {
    return { bucket: 'safe_keep', reasons: keepReasons, risk: null };
  }

  const reviewReasons = checkManualReview(job, lookups || {}, localOpts);
  if (reviewReasons.length) {
    return { bucket: 'manual_review', reasons: reviewReasons, risk: null };
  }

  const blockers = checkSafeArchive(job, lookups || {}, localOpts);
  if (blockers.length === 0) {
    const customerCtx = {
      windowStart: localOpts.windowStart,
      windowEnd: localOpts.windowEnd,
      customerJobsTotal:
        job.customer_id != null && lookups && lookups.customerJobsTotal
          ? lookups.customerJobsTotal.get(job.customer_id) || 0
          : 0,
    };
    const risk = calculateRiskScore(job, customerCtx);
    return {
      bucket: 'safe_archive',
      reasons: ['all_predicates_pass'],
      risk: { ...risk, band: riskBand(risk.score) },
    };
  }
  return { bucket: 'untouched_outside_scope', reasons: blockers, risk: null };
}

module.exports = {
  CLASSIFIER_VERSION,
  classifyJob,
  // exported for tests:
  checkSafeKeep,
  checkManualReview,
  checkSafeArchive,
  hasImportSignature,
  withinDriftThreshold,
};
