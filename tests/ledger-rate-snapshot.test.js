/**
 * P0.3 (Synchronization Constitution §3.5) — historical-rate snapshot tests.
 *
 * Pure tests for lib/ledger-snapshot.js plus a source-text scan asserting the
 * snapshot fields are written by every completion-derived insert in
 * createLedgerEntriesForCompletedJob.
 */

const fs = require('fs');
const path = require('path');

const {
  buildRateSnapshot,
  extractRateSnapshot,
  computeEarningFromSnapshot,
} = require('../lib/ledger-snapshot');

const SERVER_JS = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

describe('buildRateSnapshot', () => {
  test('produces canonical §3.5 field names', () => {
    const s = buildRateSnapshot({
      hourlyRate: 20,
      commissionPct: 10,
      memberCount: 2,
      revenue: 200,
      hours: 3,
      effectiveDate: '2026-04-01',
    });
    expect(s.hourly_rate_snapshot).toBe(20);
    expect(s.commission_pct_snapshot).toBe(10);
    expect(s.member_count_snapshot).toBe(2);
    expect(s.revenue_at_create).toBe(200);
    expect(s.hours_at_create).toBe(3);
    expect(s.effective_rate_date).toBe('2026-04-01');
  });

  test('keeps legacy aliases for back-compat with existing readers', () => {
    const s = buildRateSnapshot({
      hourlyRate: 15, commissionPct: 5, memberCount: 1, revenue: 100, hours: 2, effectiveDate: '2026-01-01',
    });
    expect(s.hourly_rate).toBe(15);
    expect(s.commission_pct).toBe(5);
    expect(s.member_count).toBe(1);
    expect(s.revenue).toBe(100);
    expect(s.hours).toBe(2);
  });

  test('coerces invalid inputs to safe defaults', () => {
    const s = buildRateSnapshot({
      hourlyRate: 'abc', commissionPct: null, memberCount: 0, revenue: undefined, hours: -1,
    });
    expect(s.hourly_rate_snapshot).toBe(0);
    expect(s.commission_pct_snapshot).toBe(0);
    expect(s.member_count_snapshot).toBe(1);   // clamped to >= 1
    expect(s.revenue_at_create).toBe(0);
    expect(s.hours_at_create).toBe(-1);        // hours can legitimately round near 0
    expect(s.effective_rate_date).toBe(null);
  });

  test('strips time component from effectiveDate', () => {
    const s = buildRateSnapshot({
      hourlyRate: 10, commissionPct: 0, memberCount: 1, revenue: 0, hours: 1,
      effectiveDate: '2026-05-13T14:30:00.000Z',
    });
    expect(s.effective_rate_date).toBe('2026-05-13');
  });
});

describe('extractRateSnapshot', () => {
  test('prefers canonical fields when present', () => {
    const md = {
      hourly_rate_snapshot: 25,
      commission_pct_snapshot: 7,
      member_count_snapshot: 3,
      revenue_at_create: 300,
      hours_at_create: 4,
      effective_rate_date: '2026-04-15',
      // Stale legacy keys (should be ignored when canonical is present)
      hourly_rate: 999,
    };
    const r = extractRateSnapshot(md);
    expect(r.hourlyRate).toBe(25);
    expect(r.commissionPct).toBe(7);
    expect(r.memberCount).toBe(3);
    expect(r.revenue).toBe(300);
    expect(r.hours).toBe(4);
    expect(r.effectiveDate).toBe('2026-04-15');
    expect(r.source).toBe('canonical');
  });

  test('falls back to legacy keys for pre-§3.5 rows', () => {
    const md = { hourly_rate: 18, commission_pct: 0, revenue: 90, hours: 5, member_count: 1 };
    const r = extractRateSnapshot(md);
    expect(r.hourlyRate).toBe(18);
    expect(r.revenue).toBe(90);
    expect(r.source).toBe('legacy');
  });

  test('returns null when no rate signal is present at all', () => {
    expect(extractRateSnapshot({})).toBe(null);
    expect(extractRateSnapshot(null)).toBe(null);
    expect(extractRateSnapshot({ unrelated: 'data' })).toBe(null);
  });

  test('round-trip: build → extract preserves values', () => {
    const built = buildRateSnapshot({
      hourlyRate: 22, commissionPct: 15, memberCount: 2, revenue: 250, hours: 3.5,
      effectiveDate: '2026-03-21',
    });
    const back = extractRateSnapshot(built);
    expect(back.hourlyRate).toBe(22);
    expect(back.commissionPct).toBe(15);
    expect(back.memberCount).toBe(2);
    expect(back.revenue).toBe(250);
    expect(back.hours).toBe(3.5);
    expect(back.effectiveDate).toBe('2026-03-21');
    expect(back.source).toBe('canonical');
  });
});

describe('legacy-row fallback contract (Constitution §3.5 tier 2)', () => {
  // These tests pin the behavior on rows that pre-date P0. The staging census
  // run on 2026-05-13 found ~2,854 earning rows with legacy keys and ~220
  // tip/incentive/cash_collected rows with no metadata at all. The rebuild
  // path must degrade safely on every shape we observed.

  test('earning shape — full legacy keys present, no canonical', () => {
    const md = {
      hourly_rate: 20, commission_pct: 10, member_count: 2, revenue: 200, hours: 3,
    };
    const r = extractRateSnapshot(md);
    expect(r.source).toBe('legacy');
    expect(r.hourlyRate).toBe(20);
    expect(r.commissionPct).toBe(10);
    expect(r.memberCount).toBe(2);
    expect(r.revenue).toBe(200);
    expect(r.hours).toBe(3);
    expect(r.effectiveDate).toBe(null); // legacy tier never reconstructs the rate date
  });

  test('earning shape — override metadata (cleaner_salary_override) still classifies as legacy', () => {
    const md = { override_total: 250, member_count: 2, source: 'cleaner_salary_override' };
    // No rate/commission/revenue/hours keys → returns null (correct: override rows
    // don't use rates so rebuild compares amounts directly).
    expect(extractRateSnapshot(md)).toBe(null);
  });

  test('tip / incentive / cash_collected shape — pre-P0 rows have NO metadata at all → null', () => {
    expect(extractRateSnapshot(null)).toBe(null);
    expect(extractRateSnapshot(undefined)).toBe(null);
    expect(extractRateSnapshot({})).toBe(null);
  });

  test('partial-legacy — only hours present', () => {
    const r = extractRateSnapshot({ hours: 4 });
    expect(r.source).toBe('legacy');
    expect(r.hours).toBe(4);
    expect(r.hourlyRate).toBe(0);
    expect(r.commissionPct).toBe(0);
  });

  test('partial-legacy — only commission_pct present (rate-only commission worker)', () => {
    const r = extractRateSnapshot({ commission_pct: 15, revenue: 500 });
    expect(r.source).toBe('legacy');
    expect(r.commissionPct).toBe(15);
    expect(r.revenue).toBe(500);
    expect(r.hourlyRate).toBe(0);
  });

  test('mixed canonical + legacy — canonical wins', () => {
    // A future scenario: a row inserted post-P0 has canonical, but a faulty
    // backfill script accidentally added the legacy alias with a different
    // value. The extractor MUST prefer canonical.
    const md = {
      hourly_rate_snapshot: 25,
      hourly_rate: 999,             // stale/wrong legacy alias
      commission_pct_snapshot: 5,
      commission_pct: 0,            // stale
      member_count_snapshot: 1,
      revenue_at_create: 100,
      hours_at_create: 4,
      effective_rate_date: '2026-04-01',
    };
    const r = extractRateSnapshot(md);
    expect(r.source).toBe('canonical');
    expect(r.hourlyRate).toBe(25);
    expect(r.commissionPct).toBe(5);
  });

  test('manager-salary metadata (scheduled_hours + is_manager_salary) → null', () => {
    // Manager daily salary rows use a different metadata shape entirely.
    // extractRateSnapshot returns null so the rebuild's drift detection
    // falls through to the direct-amount comparison.
    const md = { scheduled_hours: 8, hourly_rate: 30, is_manager_salary: true };
    const r = extractRateSnapshot(md);
    // hourly_rate key IS present, so this falls into legacy tier:
    expect(r.source).toBe('legacy');
    expect(r.hourlyRate).toBe(30);
    // scheduled_hours doesn't map to hours_at_create — rebuild treats this
    // as a degenerate snapshot and compares amounts directly. Documented.
  });

  test('manager-commission metadata (day_revenue + is_manager_commission)', () => {
    const md = { commission_pct: 10, day_revenue: 500, is_manager_commission: true };
    const r = extractRateSnapshot(md);
    expect(r.source).toBe('legacy');
    expect(r.commissionPct).toBe(10);
    // day_revenue doesn't map to revenue field — drift detection on these
    // rows relies on direct amount compare against the dry-run computation.
  });
});

describe('computeEarningFromSnapshot — legacy-row drift detection', () => {
  test('legacy snapshot still produces a computed amount', () => {
    const r = extractRateSnapshot({ hourly_rate: 20, commission_pct: 0, hours: 4, revenue: 0, member_count: 1 });
    expect(computeEarningFromSnapshot(r)).toBeCloseTo(80, 2);
  });

  test('null snapshot (tip/incentive/cash row with no metadata) → null', () => {
    expect(computeEarningFromSnapshot(extractRateSnapshot({}))).toBe(null);
    expect(computeEarningFromSnapshot(extractRateSnapshot(null))).toBe(null);
  });

  test('legacy snapshot with zero rates returns null (degenerate)', () => {
    const r = extractRateSnapshot({ hourly_rate: 0, commission_pct: 0, revenue: 0, hours: 0 });
    expect(r).not.toBe(null);          // signal is present (legacy tier)
    expect(computeEarningFromSnapshot(r)).toBe(null);  // but math is degenerate
  });
});

describe('computeEarningFromSnapshot', () => {
  test('hourly + commission hybrid', () => {
    // 3h × $20 + ($200 / 2 × 10%) = $60 + $10 = $70
    const r = computeEarningFromSnapshot({
      hourlyRate: 20, commissionPct: 10, memberCount: 2, revenue: 200, hours: 3,
    });
    expect(r).toBeCloseTo(70, 2);
  });

  test('commission-only', () => {
    const r = computeEarningFromSnapshot({
      hourlyRate: 0, commissionPct: 20, memberCount: 1, revenue: 500, hours: 0,
    });
    expect(r).toBeCloseTo(100, 2);
  });

  test('hourly-only', () => {
    const r = computeEarningFromSnapshot({
      hourlyRate: 25, commissionPct: 0, memberCount: 1, revenue: 0, hours: 4,
    });
    expect(r).toBeCloseTo(100, 2);
  });

  test('returns null for degenerate inputs', () => {
    expect(computeEarningFromSnapshot(null)).toBe(null);
    expect(computeEarningFromSnapshot({ hourlyRate: 0, commissionPct: 0, memberCount: 1, revenue: 0, hours: 0 })).toBe(null);
  });
});

describe('createLedgerEntriesForCompletedJob — source-text scan for §3.5', () => {
  // Locate the function body.
  const start = SERVER_JS.indexOf('async function createLedgerEntriesForCompletedJob(');
  expect(start).toBeGreaterThan(0);
  const end = SERVER_JS.indexOf('async function rebuildJobLedger(', start);
  const fnBody = SERVER_JS.slice(start, end);

  test('imports buildRateSnapshot helper', () => {
    expect(SERVER_JS).toMatch(/require\('\.\/lib\/ledger-snapshot'\)/);
  });

  test('earning rows include rate snapshot in metadata', () => {
    // Look for either { ...rateSnapshot, ...} or metadata: buildRateSnapshot(...)
    expect(fnBody).toMatch(/rateSnapshot/);
  });

  test('tip rows now include metadata (was missing before §3.5)', () => {
    // Find the tip push block.
    const tipIdx = fnBody.indexOf("type: 'tip'");
    expect(tipIdx).toBeGreaterThan(0);
    const tipBlock = fnBody.slice(tipIdx, tipIdx + 500);
    expect(tipBlock).toMatch(/metadata:/);
  });

  test('incentive rows now include metadata', () => {
    const incIdx = fnBody.indexOf("type: 'incentive'");
    expect(incIdx).toBeGreaterThan(0);
    const block = fnBody.slice(incIdx, incIdx + 500);
    expect(block).toMatch(/metadata:/);
  });

  test('cash_collected rows now include metadata', () => {
    const cashIdx = fnBody.indexOf("type: 'cash_collected'");
    expect(cashIdx).toBeGreaterThan(0);
    const block = fnBody.slice(cashIdx, cashIdx + 600);
    expect(block).toMatch(/metadata:/);
  });

  test('race-check now filters on payout_batch_id IS NULL (post-§3.1)', () => {
    // The race check must filter unbatched so a rebuild can re-insert unbatched
    // rows alongside surviving batched siblings.
    expect(fnBody).toMatch(/Unbatched entries already exist|payout_batch_id.*null/);
  });

  test('dryRun option short-circuits before insert', () => {
    expect(fnBody).toMatch(/if \(dryRun\)/);
    expect(fnBody).toMatch(/return ledgerEntries/);
  });

  test('skipMemberTypePairs option filters per-(member, type) pair', () => {
    expect(fnBody).toMatch(/skipMemberTypePairs/);
    expect(fnBody).toMatch(/shouldSkip\(/);
  });
});
