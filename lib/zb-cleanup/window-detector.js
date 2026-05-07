'use strict';

// IMPORT_WINDOW auto-detection.
//
// Strategy: pull (date-bucketed) row counts for jobs carrying any import
// signature scoped to the resolved tenant, then identify the contiguous
// burst:  ≥ MIN_BURST_DAY_ROWS for ≥ MIN_BURST_LENGTH consecutive days,
// surrounded by < EDGE_QUIET_THRESHOLD rows/day on either side.
//
// Returns null when:
//   - zero candidate rows (nothing to clean)
//   - multiple disjoint bursts (operator must specify --window-* flags)
// Caller is responsible for error-out behavior; this module never throws.

const MIN_BURST_DAY_ROWS = 50;
const MIN_BURST_LENGTH = 2;
const EDGE_QUIET_THRESHOLD = 5;

// rows: [{ created_at: '2026-03-04...' }] — just need the date prefix.
// Returns Map<YYYY-MM-DD, count>
function bucketByDay(rows) {
  const m = new Map();
  for (const r of rows) {
    if (!r.created_at) continue;
    const day = String(r.created_at).slice(0, 10);
    m.set(day, (m.get(day) || 0) + 1);
  }
  return m;
}

function detectBursts(buckets) {
  const days = [...buckets.keys()].sort();
  if (days.length === 0) return [];
  const bursts = [];
  let cur = null;
  let prevDay = null;
  for (const day of days) {
    const n = buckets.get(day) || 0;
    // Day gap closes the current burst even if next day has high density.
    if (cur && prevDay && daysBetween(prevDay, day) > 1) {
      bursts.push(cur);
      cur = null;
    }
    if (n >= MIN_BURST_DAY_ROWS) {
      if (!cur) cur = { startDay: day, endDay: day, totalRows: 0, maxDay: 0 };
      cur.endDay = day;
      cur.totalRows += n;
      if (n > cur.maxDay) cur.maxDay = n;
    } else if (cur) {
      bursts.push(cur);
      cur = null;
    }
    prevDay = day;
  }
  if (cur) bursts.push(cur);
  return bursts.filter(
    (b) =>
      daysBetween(b.startDay, b.endDay) + 1 >= MIN_BURST_LENGTH,
  );
}

function daysBetween(a, b) {
  return Math.round(
    (new Date(b + 'T00:00:00Z').getTime() - new Date(a + 'T00:00:00Z').getTime()) /
      86_400_000,
  );
}

function dayPlus(day, n) {
  const d = new Date(day + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Returns:
//   { ok: true, start, end, autoDetected: true, burstDensityMaxPerDay, burstTotalRows }
//   { ok: false, reason: string, candidateBurstCount, buckets }
function detectWindow(rows) {
  const buckets = bucketByDay(rows);
  if (buckets.size === 0) {
    return { ok: false, reason: 'no_candidate_rows', candidateBurstCount: 0, buckets };
  }
  const bursts = detectBursts(buckets);
  if (bursts.length === 0) {
    return {
      ok: false,
      reason: 'no_burst_meeting_density_threshold',
      candidateBurstCount: 0,
      buckets,
    };
  }
  if (bursts.length > 1) {
    return {
      ok: false,
      reason: 'multiple_disjoint_bursts',
      candidateBurstCount: bursts.length,
      buckets,
    };
  }
  const burst = bursts[0];
  // Window: [startDay 00:00 UTC, endDay+1 00:00 UTC) — half-open, matches
  // the classifier predicate `created_at >= START AND < END`.
  return {
    ok: true,
    start: burst.startDay + 'T00:00:00Z',
    end: dayPlus(burst.endDay, 1) + 'T00:00:00Z',
    autoDetected: true,
    burstDensityMaxPerDay: burst.maxDay,
    burstTotalRows: burst.totalRows,
  };
}

module.exports = {
  detectWindow,
  bucketByDay,
  detectBursts,
  // exported for tests/tuning:
  MIN_BURST_DAY_ROWS,
  MIN_BURST_LENGTH,
  EDGE_QUIET_THRESHOLD,
};
