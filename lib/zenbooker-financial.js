/**
 * Pure ZB→SF financial-field mapper.
 *
 * Centralizes all invoice/duration normalization so every sync path
 * (handleJobEvent, handlePaymentEvent, runPaymentReconcile,
 *  POST /reconcile-job/:jobId, manual /sync entity=reconcile) writes the
 * same set of fields with the same rules.
 *
 * Pure: no I/O, no DB, no logging. Returns a plain object suitable for
 * `supabase.from('jobs').update(...)`. Caller decides which subset to write.
 */

'use strict';

function num(v, fallback = 0) {
  if (v == null) return fallback;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}

function mapAdjustments(adjustments) {
  if (!Array.isArray(adjustments) || adjustments.length === 0) return null;
  return adjustments.map((a) => ({
    name: a.name || null,
    type: a.adjustment_type || 'fee',
    amount: num(a.adjustment_amount),
    rate: a.value != null ? num(a.value, null) : null,
    rate_type: a.value_type || null,
    zb_id: a.id || null,
  }));
}

/**
 * Resolve tip_amount per the SF rule:
 *   1. If ZB invoice has an explicit tip > 0 → that value is authoritative.
 *   2. Else, if SF already has a non-zero manual tip → preserve SF (omit
 *      tip_amount from the returned update object).
 *   3. Else, if amount_paid exceeds (subtotal + taxes + adjustment_total),
 *      the overage is an implicit tip → use computed value.
 *   4. Else → tip = 0 (write 0 only when SF currently has 0/null too).
 *
 * The function returns:
 *   - resolvedTip: number | null   (null = "do not write tip_amount")
 *   - tipSource:   one of 'explicit_zb' | 'preserve_sf' | 'computed_implicit'
 *                  | 'no_tip'
 */
function resolveTip({ explicitZbTip, existingSfTipAmount, amountPaid, subtotal, taxes, adjustmentTotal }) {
  const explicit = num(explicitZbTip);
  if (explicit > 0) {
    return { resolvedTip: explicit, tipSource: 'explicit_zb' };
  }
  const sfTip = num(existingSfTipAmount);
  if (sfTip > 0) {
    return { resolvedTip: null, tipSource: 'preserve_sf' };
  }
  const overage = num(amountPaid) - num(subtotal) - num(taxes) - num(adjustmentTotal);
  if (overage > 0.0049) {
    return { resolvedTip: Math.round(overage * 100) / 100, tipSource: 'computed_implicit' };
  }
  return { resolvedTip: 0, tipSource: 'no_tip' };
}

/**
 * Map a ZB job (as returned by GET /jobs/:id) to the SF financial-field
 * subset of a `jobs` table UPDATE.
 *
 * @param {object} zbJob — full ZB job payload (must include `invoice` and
 *                         `estimated_duration_seconds` if they are to be mapped)
 * @param {object} [options]
 * @param {number|string|null} [options.existingSfTipAmount] — current SF
 *        `jobs.tip_amount` for this job, used to apply the preserve-SF rule
 *        when ZB has no explicit tip and no implicit overage.
 * @returns {object} update — keys ready to spread into `.update({...})`.
 *          Includes `_tip_source` (string) for diagnostic logging; the
 *          caller should strip it before passing to Supabase.
 *          When `tip_amount` should be preserved, the key is *omitted*
 *          (not set to null/undefined) so it can be safely spread.
 */
function mapJobFinancials(zbJob, options = {}) {
  const inv = (zbJob && zbJob.invoice) || {};
  const subtotal = num(inv.subtotal);
  const total = num(inv.total);
  const amountPaid = num(inv.amount_paid);
  const taxes = num(inv.tax_amount != null ? inv.tax_amount : inv.total_tax_amount);
  const adjustmentTotal = num(inv.adjustment_total);
  const discount = num(inv.discount_amount);
  const explicitZbTip = num(inv.tip != null ? inv.tip : inv.tip_amount);
  const durationSeconds = zbJob && zbJob.estimated_duration_seconds;

  const tip = resolveTip({
    explicitZbTip,
    existingSfTipAmount: options.existingSfTipAmount,
    amountPaid,
    subtotal,
    taxes,
    adjustmentTotal,
  });

  // Adjustment fields (processing fees, etc.) only live on /invoices/:id —
  // /jobs/:id returns the invoice without `adjustment_total` and
  // `adjustments_applied`. So when those keys are absent (undefined), we
  // can't tell whether the job has zero fees or whether the source just
  // didn't include them — omit the fields so an existing SF value isn't
  // overwritten to 0/null. When the keys ARE present (even as 0/[]),
  // they're authoritative and we write them.
  const hasAdjustmentSignal = inv.adjustment_total !== undefined || inv.adjustments_applied !== undefined;

  const update = {
    taxes,
    discount,
    _tip_source: tip.tipSource,
  };
  if (hasAdjustmentSignal) {
    update.additional_fees = adjustmentTotal;
    update.fees_breakdown = mapAdjustments(inv.adjustments_applied);
  }

  // Subtotal/price/total are written when the ZB invoice has them. If the
  // invoice is empty (e.g. job not yet invoiced), we leave SF prices alone.
  if (subtotal > 0) {
    update.service_price = subtotal;
    update.price = subtotal;
  }
  if (total > 0) {
    update.total = total;
    update.total_amount = total;
  }
  if (durationSeconds != null && durationSeconds > 0) {
    update.duration = Math.round(durationSeconds / 60);
  }
  if (tip.resolvedTip !== null) {
    update.tip_amount = tip.resolvedTip;
  }
  return update;
}

/**
 * Helper: strip the `_tip_source` diagnostic field before sending to DB.
 */
function stripDiagnostics(update) {
  if (!update || typeof update !== 'object') return update;
  const { _tip_source, ...rest } = update;
  return rest;
}

module.exports = {
  mapJobFinancials,
  mapAdjustments,
  resolveTip,
  stripDiagnostics,
};
