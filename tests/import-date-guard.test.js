/**
 * Pure tests for validateScheduledDate (writer-side Layer 1 date guard).
 *
 * Job 142078 (scheduled_date = "+045930-01-01") is the canonical regression
 * fixture: that exact value must be rejected after this guard is wired in.
 */

const { validateScheduledDate, MIN_YEAR, MAX_YEAR } = require('../lib/import-date-guard');

describe('validateScheduledDate — corrupted / malformed', () => {
  test('142078 fixture: "+045930-01-01" rejected (out of range prefix)', () => {
    const r = validateScheduledDate('+045930-01-01');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/does_not_match_YYYY-MM-DD_prefix/);
  });

  test('JS toISOString far-future "+045930-01-01T00:00:00.000Z" rejected', () => {
    const r = validateScheduledDate('+045930-01-01T00:00:00.000Z');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/does_not_match_YYYY-MM-DD_prefix/);
  });

  test('BC date "-000001-01-01" rejected', () => {
    const r = validateScheduledDate('-000001-01-01');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/does_not_match_YYYY-MM-DD_prefix/);
  });

  test('MM/DD/YYYY format rejected (not pre-normalized)', () => {
    const r = validateScheduledDate('12/15/2025');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/does_not_match_YYYY-MM-DD_prefix/);
  });

  test('partial fallback "01/01 09:00:00" rejected', () => {
    // This is what buildScheduledDate can emit when the input had only DD/MM.
    const r = validateScheduledDate('01/01 09:00:00');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/does_not_match_YYYY-MM-DD_prefix/);
  });

  test('Feb 30 rejected (invalid calendar date)', () => {
    const r = validateScheduledDate('2026-02-30');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/invalid_calendar_date/);
  });

  test('month 13 rejected', () => {
    const r = validateScheduledDate('2026-13-01');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/month_out_of_range/);
  });

  test('null / undefined / empty rejected with reason "empty"', () => {
    expect(validateScheduledDate(null)).toEqual({ ok: false, reason: 'empty' });
    expect(validateScheduledDate(undefined)).toEqual({ ok: false, reason: 'empty' });
    expect(validateScheduledDate('')).toEqual({ ok: false, reason: 'empty' });
    expect(validateScheduledDate('   ')).toEqual({ ok: false, reason: 'empty' });
  });
});

describe('validateScheduledDate — year-range edges', () => {
  test('year 1999 rejected', () => {
    const r = validateScheduledDate('1999-12-31');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/year_out_of_range \(1999/);
  });

  test('year 2000-01-01 accepted (lower bound inclusive)', () => {
    const r = validateScheduledDate('2000-01-01');
    expect(r.ok).toBe(true);
    expect(r.year).toBe(2000);
    expect(r.normalized_prefix).toBe('2000-01-01');
  });

  test('year 2100-12-31 accepted (upper bound inclusive)', () => {
    const r = validateScheduledDate('2100-12-31');
    expect(r.ok).toBe(true);
    expect(r.year).toBe(2100);
  });

  test('year 2101 rejected', () => {
    const r = validateScheduledDate('2101-01-01');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/year_out_of_range \(2101/);
  });

  test('exposed MIN_YEAR/MAX_YEAR constants', () => {
    expect(MIN_YEAR).toBe(2000);
    expect(MAX_YEAR).toBe(2100);
  });
});

describe('validateScheduledDate — happy paths (formats buildScheduledDate emits)', () => {
  test('date only: "2026-05-15"', () => {
    expect(validateScheduledDate('2026-05-15').ok).toBe(true);
  });

  test('date + space + time: "2026-05-15 09:00:00"', () => {
    expect(validateScheduledDate('2026-05-15 09:00:00').ok).toBe(true);
  });

  test('ISO with T: "2026-05-15T09:00:00"', () => {
    expect(validateScheduledDate('2026-05-15T09:00:00').ok).toBe(true);
  });

  test('ISO with T + ms + Z: "2026-05-15T09:00:00.123Z"', () => {
    expect(validateScheduledDate('2026-05-15T09:00:00.123Z').ok).toBe(true);
  });

  test('ISO with TZ offset: "2026-05-15T09:00:00-04:00"', () => {
    expect(validateScheduledDate('2026-05-15T09:00:00-04:00').ok).toBe(true);
  });

  test('date + time without seconds: "2026-05-15 09:00"', () => {
    expect(validateScheduledDate('2026-05-15 09:00').ok).toBe(true);
  });
});

describe('validateScheduledDate — type tolerance', () => {
  test('non-string input coerced via String()', () => {
    expect(validateScheduledDate(20260515).ok).toBe(false); // not YYYY-MM-DD shape
  });

  test('Date object stringified rejected (no YYYY-MM-DD prefix)', () => {
    // String(new Date('2026-05-15')) gives "Fri May 15 2026 ..." — not our prefix.
    const r = validateScheduledDate(new Date('2026-05-15'));
    expect(r.ok).toBe(false);
  });
});
