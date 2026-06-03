'use strict';

/**
 * Allowlist tests for SF→LB outbound status filter.
 *
 * The allowlist is a DEFENSIVE filter — it stops obviously-invalid statuses
 * from wasting an HTTP round-trip. LB owns the authoritative mapping
 * (geos-leadbridge/src/integrations/service-flow/sf-status-map.ts). This
 * file MUST stay in lock-step with LB's mapSfStatus switch cases.
 *
 * Test coverage covers all six SF-connected lifecycle states + legacy
 * pre-service synonyms + terminal states + back-compat for early funnel.
 */

const { isOutboundAllowed, normalizeStatus, ALLOWED_SF_STATUSES } = require('../services/lb-outbound-status-map');

describe('isOutboundAllowed — SF-connected lifecycle statuses (Issue #47)', () => {
  test('scheduled is allowed into outbox send path', () => {
    expect(isOutboundAllowed('scheduled')).toBe(true);
  });

  test('booked is allowed into outbox send path', () => {
    expect(isOutboundAllowed('booked')).toBe(true);
  });

  test('in_progress is allowed (underscore form)', () => {
    expect(isOutboundAllowed('in_progress')).toBe(true);
  });

  test('in-progress is allowed (hyphen form — back-compat)', () => {
    expect(isOutboundAllowed('in-progress')).toBe(true);
  });

  test('completed is still allowed (regression check)', () => {
    expect(isOutboundAllowed('completed')).toBe(true);
  });
});

describe('isOutboundAllowed — existing behavior unchanged', () => {
  test('cancelled is allowed', () => {
    expect(isOutboundAllowed('cancelled')).toBe(true);
  });

  test('canceled (US spelling) is allowed', () => {
    expect(isOutboundAllowed('canceled')).toBe(true);
  });

  test('lost is allowed', () => {
    expect(isOutboundAllowed('lost')).toBe(true);
  });

  test('no_show is allowed', () => {
    expect(isOutboundAllowed('no_show')).toBe(true);
  });

  test('paid is allowed (completion synonym)', () => {
    expect(isOutboundAllowed('paid')).toBe(true);
  });

  test('archived is allowed', () => {
    expect(isOutboundAllowed('archived')).toBe(true);
  });

  test('pending is allowed (legacy pre-service)', () => {
    expect(isOutboundAllowed('pending')).toBe(true);
  });

  test('confirmed is allowed (legacy pre-service)', () => {
    expect(isOutboundAllowed('confirmed')).toBe(true);
  });

  test('rescheduled is allowed (legacy pre-service)', () => {
    expect(isOutboundAllowed('rescheduled')).toBe(true);
  });

  test('en_route is allowed (mid-service synonym)', () => {
    expect(isOutboundAllowed('en_route')).toBe(true);
  });

  test('started is allowed (mid-service synonym)', () => {
    expect(isOutboundAllowed('started')).toBe(true);
  });

  test('new is allowed (early funnel passthrough)', () => {
    expect(isOutboundAllowed('new')).toBe(true);
  });

  test('contacted is allowed (early funnel passthrough)', () => {
    expect(isOutboundAllowed('contacted')).toBe(true);
  });

  test('quoted is allowed (early funnel passthrough)', () => {
    expect(isOutboundAllowed('quoted')).toBe(true);
  });
});

describe('isOutboundAllowed — case + whitespace normalization', () => {
  test('case-insensitive: SCHEDULED', () => {
    expect(isOutboundAllowed('SCHEDULED')).toBe(true);
  });

  test('case-insensitive: BOOKED', () => {
    expect(isOutboundAllowed('BOOKED')).toBe(true);
  });

  test('case-insensitive: In_Progress', () => {
    expect(isOutboundAllowed('In_Progress')).toBe(true);
  });

  test('whitespace trimmed', () => {
    expect(isOutboundAllowed('  scheduled  ')).toBe(true);
  });
});

describe('isOutboundAllowed — unknown statuses still rejected (fail-closed)', () => {
  test('made-up status rejected', () => {
    expect(isOutboundAllowed('foo_bar')).toBe(false);
  });

  test('typo near-miss rejected', () => {
    expect(isOutboundAllowed('schedules')).toBe(false);   // plural typo
  });

  test('null rejected', () => {
    expect(isOutboundAllowed(null)).toBe(false);
  });

  test('undefined rejected', () => {
    expect(isOutboundAllowed(undefined)).toBe(false);
  });

  test('empty string rejected', () => {
    expect(isOutboundAllowed('')).toBe(false);
  });

  test('non-string rejected (number)', () => {
    expect(isOutboundAllowed(42)).toBe(false);
  });
});

describe('normalizeStatus', () => {
  test('lowercases + trims', () => {
    expect(normalizeStatus('  SCHEDULED  ')).toBe('scheduled');
    expect(normalizeStatus('In_Progress')).toBe('in_progress');
  });

  test('handles null/undefined gracefully', () => {
    expect(normalizeStatus(null)).toBe('');
    expect(normalizeStatus(undefined)).toBe('');
  });
});

describe('ALLOWED_SF_STATUSES — invariants', () => {
  test('includes all four SF-connected lifecycle states', () => {
    expect(ALLOWED_SF_STATUSES.has('scheduled')).toBe(true);
    expect(ALLOWED_SF_STATUSES.has('booked')).toBe(true);
    expect(ALLOWED_SF_STATUSES.has('in_progress')).toBe(true);
    expect(ALLOWED_SF_STATUSES.has('completed')).toBe(true);
  });

  test('does NOT include cancelled/no_show variants as lifecycle-entry states', () => {
    // These are terminal but still allowed (they propagate status changes);
    // sanity check that they remain in the set.
    expect(ALLOWED_SF_STATUSES.has('cancelled')).toBe(true);
    expect(ALLOWED_SF_STATUSES.has('no_show')).toBe(true);
  });

  test('size is stable — no accidental removals', () => {
    // 23 entries after Issue #47 (was 21, +2 for scheduled and booked).
    expect(ALLOWED_SF_STATUSES.size).toBe(23);
  });
});
