'use strict';

/**
 * Phase 1 — retroactive repair guards.
 *
 * Tests the active-window safeguard per operator correction (2026-05-21):
 *   "If BOTH lead.updated_at AND customer.updated_at are within a short
 *    active window (example 24h), THEN downgrade HIGH → review_required."
 *
 * Lives in lib/retroactive-repair-guards.js; called from
 * identity-conflicts.js /repair-lead-links and scripts/phase1-dryrun-repair.js.
 */

const { shouldDowngradeForActiveWindow, filterByExclusion } = require('../lib/retroactive-repair-guards');

const NOW = new Date('2026-05-21T12:00:00Z').getTime();

describe('shouldDowngradeForActiveWindow', () => {
  test('both rows touched within 24h → downgrade', () => {
    const r = shouldDowngradeForActiveWindow({
      leadUpdatedAt: '2026-05-21T01:00:00Z',     // 11h ago
      customerUpdatedAt: '2026-05-21T05:00:00Z', // 7h ago
      activeWindowHours: 24,
      now: NOW,
    });
    expect(r.downgrade).toBe(true);
    expect(r.reason).toBe('active_window_24h');
  });

  test('only lead recent → no downgrade', () => {
    const r = shouldDowngradeForActiveWindow({
      leadUpdatedAt: '2026-05-21T05:00:00Z',     // 7h ago
      customerUpdatedAt: '2026-05-10T00:00:00Z', // 11 days ago
      activeWindowHours: 24,
      now: NOW,
    });
    expect(r.downgrade).toBe(false);
  });

  test('only customer recent → no downgrade', () => {
    const r = shouldDowngradeForActiveWindow({
      leadUpdatedAt: '2026-04-01T00:00:00Z',
      customerUpdatedAt: '2026-05-21T05:00:00Z',
      activeWindowHours: 24,
      now: NOW,
    });
    expect(r.downgrade).toBe(false);
  });

  test('neither recent → no downgrade', () => {
    const r = shouldDowngradeForActiveWindow({
      leadUpdatedAt: '2026-01-01T00:00:00Z',
      customerUpdatedAt: '2026-02-01T00:00:00Z',
      activeWindowHours: 24,
      now: NOW,
    });
    expect(r.downgrade).toBe(false);
  });

  test('window=0 disables safeguard (even if both recent)', () => {
    const r = shouldDowngradeForActiveWindow({
      leadUpdatedAt: '2026-05-21T11:30:00Z',
      customerUpdatedAt: '2026-05-21T11:45:00Z',
      activeWindowHours: 0,
      now: NOW,
    });
    expect(r.downgrade).toBe(false);
  });

  test('null activeWindowHours → safeguard disabled', () => {
    const r = shouldDowngradeForActiveWindow({
      leadUpdatedAt: '2026-05-21T11:30:00Z',
      customerUpdatedAt: '2026-05-21T11:45:00Z',
      activeWindowHours: null,
      now: NOW,
    });
    expect(r.downgrade).toBe(false);
  });

  test('null leadUpdatedAt → no signal, no downgrade', () => {
    const r = shouldDowngradeForActiveWindow({
      leadUpdatedAt: null,
      customerUpdatedAt: '2026-05-21T11:45:00Z',
      activeWindowHours: 24,
      now: NOW,
    });
    expect(r.downgrade).toBe(false);
  });

  test('null customerUpdatedAt → no signal, no downgrade', () => {
    const r = shouldDowngradeForActiveWindow({
      leadUpdatedAt: '2026-05-21T11:45:00Z',
      customerUpdatedAt: null,
      activeWindowHours: 24,
      now: NOW,
    });
    expect(r.downgrade).toBe(false);
  });

  test('both null → no signal, no downgrade', () => {
    const r = shouldDowngradeForActiveWindow({
      leadUpdatedAt: null,
      customerUpdatedAt: null,
      activeWindowHours: 24,
      now: NOW,
    });
    expect(r.downgrade).toBe(false);
  });

  test('configurable window — 1h excludes things that 24h includes', () => {
    const within24hButNot1h = {
      leadUpdatedAt: '2026-05-21T05:00:00Z',     // 7h ago
      customerUpdatedAt: '2026-05-21T05:00:00Z',
      now: NOW,
    };
    expect(shouldDowngradeForActiveWindow({ ...within24hButNot1h, activeWindowHours: 24 }).downgrade).toBe(true);
    expect(shouldDowngradeForActiveWindow({ ...within24hButNot1h, activeWindowHours: 1 }).downgrade).toBe(false);
  });

  test('reason string echoes the hours value', () => {
    const r = shouldDowngradeForActiveWindow({
      leadUpdatedAt: '2026-05-21T11:30:00Z',
      customerUpdatedAt: '2026-05-21T11:45:00Z',
      activeWindowHours: 48,
      now: NOW,
    });
    expect(r.reason).toBe('active_window_48h');
  });

  test('Date objects accepted as input (not only ISO strings)', () => {
    const r = shouldDowngradeForActiveWindow({
      leadUpdatedAt: new Date('2026-05-21T01:00:00Z'),
      customerUpdatedAt: new Date('2026-05-21T05:00:00Z'),
      activeWindowHours: 24,
      now: NOW,
    });
    expect(r.downgrade).toBe(true);
  });

  test('uses Date.now() when "now" not provided', () => {
    // Just verifies the call doesn't crash without `now`. Real verification
    // happens via injected `now` in the other tests.
    const r = shouldDowngradeForActiveWindow({
      leadUpdatedAt: new Date(Date.now() - 1000),
      customerUpdatedAt: new Date(Date.now() - 1000),
      activeWindowHours: 24,
    });
    expect(r.downgrade).toBe(true);
  });

  test('future timestamps (clock skew) → not treated as active', () => {
    // If updated_at is somehow in the future, treat as not-recent rather
    // than panicking. (now - future) is negative; helper guards against this.
    const r = shouldDowngradeForActiveWindow({
      leadUpdatedAt: '2026-06-01T00:00:00Z', // 11 days in the future relative to NOW
      customerUpdatedAt: '2026-06-01T00:00:00Z',
      activeWindowHours: 24,
      now: NOW,
    });
    expect(r.downgrade).toBe(false);
  });

  test('negative activeWindowHours treated as disabled', () => {
    const r = shouldDowngradeForActiveWindow({
      leadUpdatedAt: '2026-05-21T11:30:00Z',
      customerUpdatedAt: '2026-05-21T11:45:00Z',
      activeWindowHours: -5,
      now: NOW,
    });
    expect(r.downgrade).toBe(false);
  });
});

describe('filterByExclusion', () => {
  test('empty excludeIds → all kept, nothing excluded', () => {
    const conflicts = [{ id: 1 }, { id: 2 }, { id: 3 }];
    const r = filterByExclusion(conflicts, []);
    expect(r.kept).toEqual(conflicts);
    expect(r.excluded).toEqual([]);
    expect(r.excludedIds).toEqual([]);
  });

  test('null/undefined excludeIds → all kept', () => {
    const conflicts = [{ id: 1 }, { id: 2 }];
    expect(filterByExclusion(conflicts, null).kept).toEqual(conflicts);
    expect(filterByExclusion(conflicts, undefined).kept).toEqual(conflicts);
  });

  test('excluded IDs partitioned correctly', () => {
    const conflicts = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }];
    const r = filterByExclusion(conflicts, [2, 4]);
    expect(r.kept.map(c => c.id)).toEqual([1, 3]);
    expect(r.excluded.map(c => c.id)).toEqual([2, 4]);
    expect(r.excludedIds).toEqual([2, 4]);
  });

  test('string IDs coerced to numbers', () => {
    const conflicts = [{ id: 1 }, { id: 2 }, { id: 3 }];
    const r = filterByExclusion(conflicts, ['1', '3']);
    expect(r.kept.map(c => c.id)).toEqual([2]);
    expect(r.excludedIds).toEqual([1, 3]);
  });

  test('non-finite excludes silently dropped (no false exclusion)', () => {
    const conflicts = [{ id: 1 }, { id: 2 }];
    const r = filterByExclusion(conflicts, ['', 'foo', NaN, null, undefined]);
    expect(r.kept).toEqual(conflicts);
    expect(r.excluded).toEqual([]);
  });

  test('excludeIds containing conflict id not present in list → no error', () => {
    const conflicts = [{ id: 1 }, { id: 2 }];
    const r = filterByExclusion(conflicts, [999]);
    expect(r.kept).toEqual(conflicts);
    expect(r.excluded).toEqual([]);
    expect(r.excludedIds).toEqual([]);
  });

  test('conflicts array null/empty → empty kept', () => {
    expect(filterByExclusion(null, [1, 2]).kept).toEqual([]);
    expect(filterByExclusion(undefined, [1, 2]).kept).toEqual([]);
    expect(filterByExclusion([], [1, 2]).kept).toEqual([]);
  });

  test('conflict with no numeric id is kept (defensive)', () => {
    const conflicts = [{ id: 1 }, { id: null }, { /* no id */ }];
    const r = filterByExclusion(conflicts, [1]);
    expect(r.kept.length).toBe(2);
    expect(r.kept.find(c => c.id === null)).toBeDefined();
  });

  test('does not mutate input arrays', () => {
    const conflicts = [{ id: 1 }, { id: 2 }];
    const excludeIds = [1];
    filterByExclusion(conflicts, excludeIds);
    expect(conflicts).toEqual([{ id: 1 }, { id: 2 }]);
    expect(excludeIds).toEqual([1]);
  });
});
