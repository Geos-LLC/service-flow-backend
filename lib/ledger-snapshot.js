'use strict';

/**
 * P0.3 — Historical-rate snapshots for cleaner_ledger.metadata.
 *
 * Constitution §3.5: every completion-derived ledger row MUST embed a stable
 * snapshot of the rate inputs used to compute its amount. Rebuilds compare the
 * snapshot against current computation to detect drift on settled rows.
 *
 * Canonical field names (do not rename — they're the §3.5 contract):
 *   - hourly_rate_snapshot     (number, $ per hour at create time)
 *   - commission_pct_snapshot  (number, 0-100 percentage at create time)
 *   - member_count_snapshot    (integer, splitting denominator at create time)
 *   - revenue_at_create        (number, jobRevenue used at create time)
 *   - hours_at_create          (number, hoursWorked used at create time)
 *   - effective_rate_date      (string YYYY-MM-DD, date used to look up the rate)
 *
 * Legacy field names (`hours`, `hourly_rate`, `commission_pct`, `revenue`,
 * `member_count`) are kept in parallel for back-compat with existing reads
 * (payroll page, paystubs) until those callers are migrated.
 */

/**
 * Build the canonical snapshot object from compute-time inputs.
 *
 * @param {Object} input
 * @param {number} input.hourlyRate
 * @param {number} input.commissionPct
 * @param {number} input.memberCount
 * @param {number} input.revenue
 * @param {number} input.hours
 * @param {string} input.effectiveDate  YYYY-MM-DD
 * @returns {Object} metadata-shaped object (canonical + legacy keys merged)
 */
function buildRateSnapshot({ hourlyRate, commissionPct, memberCount, revenue, hours, effectiveDate }) {
  const hr = Number.isFinite(+hourlyRate) ? Number(+hourlyRate) : 0;
  const cp = Number.isFinite(+commissionPct) ? Number(+commissionPct) : 0;
  const mc = Number.isFinite(+memberCount) && +memberCount > 0 ? Math.max(1, Math.floor(+memberCount)) : 1;
  const rev = Number.isFinite(+revenue) ? Number(+revenue) : 0;
  const hrs = Number.isFinite(+hours) ? Number(+hours) : 0;
  const date = typeof effectiveDate === 'string' && effectiveDate
    ? String(effectiveDate).split('T')[0].split(' ')[0]
    : null;

  return {
    // Canonical (constitution §3.5) — these are the stable contract.
    hourly_rate_snapshot: hr,
    commission_pct_snapshot: cp,
    member_count_snapshot: mc,
    revenue_at_create: rev,
    hours_at_create: hrs,
    effective_rate_date: date,
    // Legacy aliases (kept in lockstep so existing readers continue to work).
    hourly_rate: hr,
    commission_pct: cp,
    member_count: mc,
    revenue: rev,
    hours: hrs,
  };
}

/**
 * Extract the snapshot from an existing row's metadata.
 *
 * Three-tier fallback (Constitution §3.5):
 *
 *   1. `source: 'canonical'` — row has explicit §3.5 fields. This is the only
 *      tier that supplies `effective_rate_date`; rebuild drift detection can
 *      trust the row was computed against the rate in effect on that date.
 *
 *   2. `source: 'legacy'` — row predates §3.5 but carries the old metadata
 *      keys (`hourly_rate`, `commission_pct`, `revenue`, `hours`,
 *      `member_count`). `effective_rate_date` is null. Drift detection can
 *      still run via `computeEarningFromSnapshot`, but the caller cannot
 *      verify the rate was historically-correct — only that the row's stored
 *      amount matches the math against its own embedded inputs.
 *
 *   3. `null` — no snapshot signal at all. Today's tip/incentive/cash_collected
 *      rows that were inserted before P0 fall here (the old code didn't
 *      attach metadata to those types). Callers MUST NOT use this row's
 *      metadata to recompute; the rebuild's dry-run path reads current job
 *      state (job.tip_amount, member_count, transactions) which is the
 *      correct fallback for those types anyway — they don't depend on rates.
 *
 * @param {Object|null|undefined} metadata
 * @returns {Object|null} { hourlyRate, commissionPct, memberCount, revenue, hours, effectiveDate, source }
 */
function extractRateSnapshot(metadata) {
  if (!metadata || typeof metadata !== 'object') return null;

  const has = (k) => metadata[k] !== undefined && metadata[k] !== null;

  // Canonical fields take precedence.
  if (has('hourly_rate_snapshot') || has('commission_pct_snapshot') || has('revenue_at_create')) {
    return {
      hourlyRate: Number(metadata.hourly_rate_snapshot) || 0,
      commissionPct: Number(metadata.commission_pct_snapshot) || 0,
      memberCount: Math.max(1, Math.floor(Number(metadata.member_count_snapshot) || 1)),
      revenue: Number(metadata.revenue_at_create) || 0,
      hours: Number(metadata.hours_at_create) || 0,
      effectiveDate: metadata.effective_rate_date || null,
      source: 'canonical',
    };
  }

  // Legacy fallback — old rows written before snapshot fields existed.
  if (has('hourly_rate') || has('commission_pct') || has('revenue') || has('hours')) {
    return {
      hourlyRate: Number(metadata.hourly_rate) || 0,
      commissionPct: Number(metadata.commission_pct) || 0,
      memberCount: Math.max(1, Math.floor(Number(metadata.member_count) || 1)),
      revenue: Number(metadata.revenue) || 0,
      hours: Number(metadata.hours) || 0,
      effectiveDate: null,
      source: 'legacy',
    };
  }

  return null;
}

/**
 * Re-derive what amount the snapshot would have produced. Used for drift
 * detection — compare snapshot-derived amount against a row's stored amount.
 *
 * Encodes the same formula as createLedgerEntriesForCompletedJob for the
 * 'earning' type. Tip/incentive/cash_collected don't use rate math so they
 * don't get a recomputed amount.
 *
 * @param {Object} snapshot  output of extractRateSnapshot()
 * @returns {number|null}    computed amount, or null when inputs are degenerate
 */
function computeEarningFromSnapshot(snapshot) {
  if (!snapshot) return null;
  const { hourlyRate, commissionPct, memberCount, revenue, hours } = snapshot;
  const mc = Math.max(1, memberCount);
  let amount = 0;
  if (hourlyRate > 0 && commissionPct > 0) {
    amount = hours * hourlyRate + (revenue / mc) * (commissionPct / 100);
  } else if (commissionPct > 0) {
    amount = (revenue / mc) * (commissionPct / 100);
  } else if (hourlyRate > 0) {
    amount = hours * hourlyRate;
  } else {
    return null;
  }
  return Number(amount.toFixed(2));
}

module.exports = {
  buildRateSnapshot,
  extractRateSnapshot,
  computeEarningFromSnapshot,
};
