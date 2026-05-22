'use strict';

/**
 * Retroactive-repair operational guards.
 *
 * Pure helpers used by:
 *   - identity-conflicts.js  POST /repair-lead-links endpoint
 *   - scripts/phase1-dryrun-repair.js
 *
 * These are temporary safeguards specifically for the retroactive repair
 * sweep. They do NOT apply to the live resolver / setter / projection
 * paths.
 *
 * Per operator correction (2026-05-21):
 *   "If BOTH lead.updated_at AND customer.updated_at are within a short
 *    active window (example 24h), THEN downgrade from HIGH → review_required."
 *
 * Reason: avoid reconciling records currently being actively manipulated
 * by operators during the cleanup window. The cleanup operator + the
 * concurrent edit operator could collide.
 *
 * Live resolver / projection paths do NOT use this. They have their own
 * concurrency guards (atomic guarded UPDATEs with NULL preconditions).
 */

/**
 * Decide whether a HIGH-confidence retroactive match should be downgraded
 * to review_required because both sides were recently active.
 *
 * @param {Object} opts
 *   leadUpdatedAt      — leads.updated_at (ISO string or Date or null)
 *   customerUpdatedAt  — customers.updated_at (ISO string or Date or null)
 *   activeWindowHours  — threshold (number). 0 disables the safeguard.
 *   now                — Date|number, default Date.now() — injectable for tests
 *
 * @returns {Object} { downgrade: boolean, reason?: string }
 *   downgrade=true means: caller should set confidence='review_required'
 *   and append `+active_window_<N>h` to the reason string.
 */
function shouldDowngradeForActiveWindow({ leadUpdatedAt, customerUpdatedAt, activeWindowHours, now }) {
  if (activeWindowHours == null || activeWindowHours <= 0) {
    return { downgrade: false };
  }
  const nowMs = now != null ? (now instanceof Date ? now.getTime() : Number(now)) : Date.now();
  const windowMs = Number(activeWindowHours) * 60 * 60 * 1000;
  if (!Number.isFinite(windowMs) || windowMs <= 0) return { downgrade: false };

  const leadMs = leadUpdatedAt ? new Date(leadUpdatedAt).getTime() : null;
  const custMs = customerUpdatedAt ? new Date(customerUpdatedAt).getTime() : null;

  // Both must be present and recent. If either is null/missing, skip the
  // downgrade (we have no signal — better to let the existing HIGH gate decide).
  if (!Number.isFinite(leadMs) || !Number.isFinite(custMs)) return { downgrade: false };

  const leadActive = (nowMs - leadMs) < windowMs && (nowMs - leadMs) >= 0;
  const custActive = (nowMs - custMs) < windowMs && (nowMs - custMs) >= 0;
  if (leadActive && custActive) {
    return { downgrade: true, reason: `active_window_${activeWindowHours}h` };
  }
  return { downgrade: false };
}

/**
 * Filter a list of conflict rows by an exclude list of conflict IDs.
 *
 * Used by /repair-lead-links to allow the operator to manually exclude
 * specific conflicts that look risky during visual UI review.
 *
 * Pure. Both inputs are arrays of plain objects / values; output is two
 * arrays (kept + excluded) — no mutation of inputs.
 *
 * Robustness:
 *   - excludeIds is normalized: null/undefined → [], values coerced to Number,
 *     non-finite values dropped (string '12' → 12; '' / 'foo' / NaN → dropped).
 *   - conflict.id is compared as Number on both sides so the operator can pass
 *     either ["12","13"] or [12,13].
 *   - Conflicts without a numeric id are kept (defensive).
 */
function filterByExclusion(conflicts, excludeIds) {
  const arr = Array.isArray(conflicts) ? conflicts : [];
  const raw = Array.isArray(excludeIds) ? excludeIds : [];
  const excludeSet = new Set();
  for (const v of raw) {
    const n = Number(v);
    if (Number.isFinite(n)) excludeSet.add(n);
  }
  if (excludeSet.size === 0) {
    return { kept: arr.slice(), excluded: [], excludedIds: [] };
  }
  const kept = [];
  const excluded = [];
  for (const c of arr) {
    const cid = Number(c?.id);
    if (Number.isFinite(cid) && excludeSet.has(cid)) {
      excluded.push(c);
    } else {
      kept.push(c);
    }
  }
  return {
    kept,
    excluded,
    excludedIds: excluded.map((c) => Number(c.id)),
  };
}

module.exports = {
  shouldDowngradeForActiveWindow,
  filterByExclusion,
};
