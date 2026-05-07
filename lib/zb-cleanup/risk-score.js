'use strict';

// Per-row risk score for SAFE_ARCHIVE candidates. Pure function. No DB hits.
//
// Range 0..100. HIGHER = SAFER to archive. Operators sort safe-archive.json
// ascending by risk_score to inspect borderline rows first.
//
// Score is informational only — it does NOT change which bucket a row lands
// in. Bucket assignment is the classifier's job (see classifier.js). The
// score expresses how borderline a row is *among rows that already passed
// every classifier predicate*.
//
// Deductions only fire on signals the BookingKoala importer is known NOT to
// set (per server.js bookingKoalaImportHandler) OR signals that introduce
// non-classifier-blocking ambiguity (window edges, money-without-payment,
// orphan customer). Anything that should outright disqualify the row lives
// in the classifier itself, not here.

const DAY_MS = 86_400_000;

function calculateRiskScore(job, ctx) {
  let score = 100;
  const deductions = [];

  // ─── Provenance quality ──────────────────────────────────────────────
  const tags = Array.isArray(job.tags) ? job.tags : [];
  if (!tags.includes('booking-koala')) {
    score -= 10;
    deductions.push('missing_bk_tag');
  }
  const hasExternalId =
    job.contact_info &&
    typeof job.contact_info === 'object' &&
    job.contact_info.external_id;
  if (!hasExternalId) {
    score -= 10;
    deductions.push('missing_external_id');
  }

  // ─── Window edge proximity ──────────────────────────────────────────
  if (ctx && ctx.windowStart && ctx.windowEnd) {
    const created = new Date(job.created_at).getTime();
    const start = new Date(ctx.windowStart).getTime();
    const end = new Date(ctx.windowEnd).getTime();
    if (Number.isFinite(created)) {
      if (created - start < DAY_MS) {
        score -= 10;
        deductions.push('within_24h_of_window_start');
      }
      if (end - created < DAY_MS) {
        score -= 10;
        deductions.push('within_24h_of_window_end');
      }
    }
  }

  // ─── Money signals (non-classifier-blocking) ────────────────────────
  // Job has a price or invoice amount but no payment_status — the
  // classifier already excluded paid/partial/refunded, but a non-zero
  // amount with no payment is mildly suspicious.
  if (Number(job.total_amount) > 0) {
    score -= 10;
    deductions.push('total_amount_gt_zero');
  }
  if (Number(job.invoice_amount) > 0) {
    score -= 10;
    deductions.push('invoice_amount_gt_zero');
  }

  // ─── Customer context ───────────────────────────────────────────────
  if (job.customer_id == null) {
    score -= 10;
    deductions.push('orphan_no_customer');
  } else if (ctx && typeof ctx.customerJobsTotal === 'number') {
    if (ctx.customerJobsTotal > 5) {
      score -= 5;
      deductions.push('customer_has_many_jobs');
    } else if (ctx.customerJobsTotal === 1) {
      score -= 5;
      deductions.push('customer_only_this_job');
    }
  }

  if (score < 0) score = 0;
  if (score > 100) score = 100;
  return { score, deductions };
}

function riskBand(score) {
  if (score >= 90) return 'high_confidence';
  if (score >= 70) return 'medium_confidence';
  return 'borderline';
}

module.exports = { calculateRiskScore, riskBand };
