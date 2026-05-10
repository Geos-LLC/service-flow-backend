/**
 * Pure tests for mapJobLifecycle (ZB→SF status + timestamp normalization).
 *
 * Job 141934 (Jessica Pringle, Deep Cleaning, May 8) is the canonical
 * regression fixture for the canceled-but-SF-doesn't-know case.
 */

const {
  mapJobLifecycle,
  stripLifecycleDiagnostics,
  STATUS_MAP,
  zbDateToLocal,
} = require('../lib/zenbooker-lifecycle');

describe('mapJobLifecycle — status precedence', () => {
  test('canceled=true wins over status=scheduled (141934 case)', () => {
    const zb = {
      id: '1776498371004x949973991905558500',
      status: 'scheduled',
      canceled: true,
      rescheduled: true,
      start_date: '2026-05-08T13:00:00.000Z',
      timezone: 'America/New_York',
      recurring: false,
      invoice: { status: 'draft', amount_paid: '0.00' },
    };
    const out = mapJobLifecycle(zb);
    expect(out.status).toBe('cancelled');
    expect(out._zb_canceled).toBe(true);
    expect(out._zb_status_raw).toBe('scheduled');
    expect(out._zb_rescheduled).toBe(true);
    expect(out.scheduled_date).toBe('2026-05-08 09:00:00'); // EDT = UTC-4
    expect(out.is_recurring).toBe(false);
    expect(out.invoice_status).toBe('draft');
    expect(out.payment_status).toBe(null);
    expect('start_time' in out).toBe(false); // not started
    expect('end_time' in out).toBe(false);
  });

  test('status=complete + canceled=false → completed', () => {
    const zb = {
      status: 'complete', canceled: false,
      start_date: '2026-05-07T14:00:00.000Z', timezone: 'America/New_York',
      started_at: '2026-05-07T13:47:24.712Z',
      completed_at: '2026-05-07T17:11:05.908Z',
      invoice: { status: 'paid', amount_paid: '204.37' },
    };
    const out = mapJobLifecycle(zb);
    expect(out.status).toBe('completed');
    expect(out.start_time).toBe('2026-05-07T13:47:24.712Z');
    expect(out.end_time).toBe('2026-05-07T17:11:05.908Z');
    expect(out.invoice_status).toBe('paid');
    expect(out.payment_status).toBe('paid');
  });

  test('status=in-progress → SF status=started', () => {
    const out = mapJobLifecycle({ status: 'in-progress', canceled: false });
    expect(out.status).toBe('started');
  });

  test('unknown status → fallback pending', () => {
    const out = mapJobLifecycle({ status: 'something_unexpected', canceled: false });
    expect(out.status).toBe('pending');
  });

  test('status=unpaid → invoice_status=invoiced, payment partial when amount_paid > 0', () => {
    const out = mapJobLifecycle({
      status: 'complete', canceled: false,
      invoice: { status: 'unpaid', amount_paid: '50.00' },
    });
    expect(out.invoice_status).toBe('invoiced');
    expect(out.payment_status).toBe('partial');
  });

  test('status=unpaid + amount_paid 0 → payment_status null', () => {
    const out = mapJobLifecycle({
      status: 'complete', canceled: false,
      invoice: { status: 'unpaid', amount_paid: '0.00' },
    });
    expect(out.invoice_status).toBe('invoiced');
    expect(out.payment_status).toBe(null);
  });
});

describe('mapJobLifecycle — timestamps', () => {
  test('omits start_time and end_time when ZB has no started_at/completed_at', () => {
    const out = mapJobLifecycle({ status: 'scheduled', canceled: false });
    expect('start_time' in out).toBe(false);
    expect('end_time' in out).toBe(false);
  });

  test('scheduled_date converts UTC to ZB timezone', () => {
    expect(zbDateToLocal('2026-05-08T13:00:00.000Z', 'America/New_York')).toBe('2026-05-08 09:00:00');
    expect(zbDateToLocal(null, 'America/New_York')).toBe(null);
  });

  test('zbDateToLocal falls back to string strip when timezone parse fails', () => {
    // Pass a malformed timezone — Intl.DateTimeFormat will throw.
    const out = zbDateToLocal('2026-05-08T13:00:00.000Z', 'Not_A_Real_TZ');
    expect(out).toBe('2026-05-08 13:00:00');
  });
});

describe('STATUS_MAP', () => {
  test('contains all webhook-flowing values', () => {
    const expected = ['scheduled', 'rescheduled', 'en-route', 'en_route', 'enroute', 'started', 'in-progress', 'late', 'complete', 'completed'];
    for (const k of expected) expect(STATUS_MAP).toHaveProperty(k);
  });
});

describe('stripLifecycleDiagnostics', () => {
  test('removes underscore-prefixed keys', () => {
    const out = stripLifecycleDiagnostics({
      status: 'cancelled', is_recurring: false,
      _zb_canceled: true, _zb_status_raw: 'scheduled',
    });
    expect(out).toEqual({ status: 'cancelled', is_recurring: false });
  });
});
