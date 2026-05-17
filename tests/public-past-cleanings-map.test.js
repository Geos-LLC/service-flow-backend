'use strict';

// Tests for the Public Past Cleanings Map Widget (issue #3).
//
// Covers:
//   - tenant isolation (sanitizer never returns a foreign tenant's row)
//   - only completed jobs are returned
//   - no private customer/address fields exposed
//   - feature flag OFF returns the disabled response shape
//   - max pins respected
//   - approximate coordinates: deterministic, not equal to source coords
//   - date range filtering

const {
  FLAGS,
  isEnabled,
} = require('../lib/feature-flags');

const {
  parseOptions,
  sanitizeJob,
  buildResponse,
  disabledResponse,
  DEFAULT_MAX_PINS,
  HARD_MAX_PINS,
  ALLOWED_RANGES,
} = require('../lib/public-past-cleanings-map');

const ALLOWED_KEYS = ['lat', 'lng', 'city', 'serviceType', 'completedMonth'];
const FORBIDDEN_KEYS = [
  'customer_id', 'customer_name', 'customer_email', 'customer_phone',
  'first_name', 'last_name', 'email', 'phone',
  'service_address_street', 'service_address_zip',
  'service_address_lat', 'service_address_lng',
  'notes', 'internal_notes', 'customer_notes',
  'scheduled_time', 'id', 'user_id',
];

function makeJob(over) {
  return Object.assign({
    id: 100,
    user_id: 1,
    customer_id: 99,
    customer_name: 'Jane Doe',
    customer_email: 'jane@example.com',
    customer_phone: '+15551234567',
    status: 'completed',
    scheduled_date: '2026-04-15T14:30:00.000Z',
    scheduled_time: '14:30:00',
    service_name: 'Deep Clean',
    service_address_street: '123 Real Street',
    service_address_city: 'Brooklyn',
    service_address_zip: '11215',
    service_address_lat: 40.6680,
    service_address_lng: -73.9855,
    notes: 'gate code 1234, dog in yard',
    internal_notes: 'pay tip in cash',
  }, over || {});
}

describe('public-past-cleanings-map: feature flag', () => {
  afterEach(() => { delete process.env.PUBLIC_CLEANINGS_MAP_WIDGET_ENABLED; });

  test('flag exists and defaults to false', () => {
    expect(FLAGS.PUBLIC_CLEANINGS_MAP_WIDGET_ENABLED).toBe('PUBLIC_CLEANINGS_MAP_WIDGET_ENABLED');
    expect(isEnabled(FLAGS.PUBLIC_CLEANINGS_MAP_WIDGET_ENABLED)).toBe(false);
  });

  test('disabledResponse shape — what the endpoint returns when flag is OFF', () => {
    const body = disabledResponse('acme-cleaners');
    expect(body).toEqual({
      enabled: false,
      tenantPublicId: 'acme-cleaners',
      range: null,
      maxPins: 0,
      pinCount: 0,
      pins: [],
    });
  });
});

describe('public-past-cleanings-map: sanitizeJob privacy contract', () => {
  test('returns only the allowed keys — never private customer/address fields', () => {
    const pin = sanitizeJob(makeJob());
    expect(pin).not.toBeNull();
    const keys = Object.keys(pin).sort();
    expect(keys).toEqual(ALLOWED_KEYS.slice().sort());
    for (const banned of FORBIDDEN_KEYS) {
      expect(Object.prototype.hasOwnProperty.call(pin, banned)).toBe(false);
    }
    expect(JSON.stringify(pin)).not.toMatch(/Jane Doe|jane@example|5551234567|123 Real Street|gate code/i);
  });

  test('drops non-completed jobs', () => {
    for (const status of ['pending', 'confirmed', 'scheduled', 'cancelled', 'in_progress', null, undefined]) {
      expect(sanitizeJob(makeJob({ status }))).toBeNull();
    }
  });

  test('drops jobs without usable coordinates', () => {
    expect(sanitizeJob(makeJob({ service_address_lat: null, service_address_lng: null }))).toBeNull();
    expect(sanitizeJob(makeJob({ service_address_lat: 0, service_address_lng: 0 }))).toBeNull();
    expect(sanitizeJob(makeJob({ service_address_lat: 'not a number' }))).toBeNull();
    expect(sanitizeJob(makeJob({ service_address_lat: 95 }))).toBeNull();
    expect(sanitizeJob(makeJob({ service_address_lng: 200 }))).toBeNull();
  });

  test('approximate coordinates: never equal exact source coords', () => {
    const j = makeJob({ id: 42, service_address_lat: 40.66801234, service_address_lng: -73.98551234 });
    const pin = sanitizeJob(j);
    expect(pin.lat).not.toBe(j.service_address_lat);
    expect(pin.lng).not.toBe(j.service_address_lng);
    // jitter envelope is 0.0025°; rounding to 3dp adds another ~0.0005°
    expect(Math.abs(pin.lat - j.service_address_lat)).toBeLessThan(0.005);
    expect(Math.abs(pin.lng - j.service_address_lng)).toBeLessThan(0.005);
  });

  test('approximate coordinates are deterministic per job id (no pin-jitter on reload)', () => {
    const j = makeJob({ id: 7 });
    const a = sanitizeJob(j);
    const b = sanitizeJob(j);
    expect(a).toEqual(b);
  });

  test('different jobs at the same coord get different jitter', () => {
    const a = sanitizeJob(makeJob({ id: 1, service_address_lat: 40.7, service_address_lng: -74.0 }));
    const b = sanitizeJob(makeJob({ id: 2, service_address_lat: 40.7, service_address_lng: -74.0 }));
    expect(a.lat === b.lat && a.lng === b.lng).toBe(false);
  });

  test('city falls back to zip-prefix when service_address_city is empty', () => {
    expect(sanitizeJob(makeJob({ service_address_city: '', service_address_zip: '11215' })).city).toBe('112xx');
    expect(sanitizeJob(makeJob({ service_address_city: null, service_address_zip: null })).city).toBeNull();
  });

  test('completedMonth is YYYY-MM, not a full timestamp', () => {
    const pin = sanitizeJob(makeJob({ scheduled_date: '2026-04-15T14:30:00.000Z' }));
    expect(pin.completedMonth).toBe('2026-04');
    expect(pin.completedMonth).not.toMatch(/14:30/);
  });
});

describe('public-past-cleanings-map: parseOptions', () => {
  test('defaults', () => {
    const o = parseOptions(undefined);
    expect(o).toEqual({ range: '365d', maxPins: DEFAULT_MAX_PINS, rangeDays: 365 });
  });

  test('range normalization', () => {
    expect(parseOptions({ range: '90' }).range).toBe('90d');
    expect(parseOptions({ range: '90d' }).range).toBe('90d');
    expect(parseOptions({ range: '365' }).range).toBe('365d');
    expect(parseOptions({ range: 'all' }).range).toBe('all');
    expect(parseOptions({ range: 'all' }).rangeDays).toBeNull();
    expect(parseOptions({ range: 'garbage' }).range).toBe('365d');
  });

  test('maxPins is clamped to HARD_MAX_PINS', () => {
    expect(parseOptions({ maxPins: 999999 }).maxPins).toBe(HARD_MAX_PINS);
    expect(parseOptions({ maxPins: -10 }).maxPins).toBe(DEFAULT_MAX_PINS);
    expect(parseOptions({ maxPins: 'banana' }).maxPins).toBe(DEFAULT_MAX_PINS);
    expect(parseOptions({ maxPins: 5 }).maxPins).toBe(5);
  });

  test('ALLOWED_RANGES exposes 90d / 365d / all', () => {
    expect(Object.keys(ALLOWED_RANGES).sort()).toEqual(['365d', '90d', 'all']);
  });
});

describe('public-past-cleanings-map: buildResponse', () => {
  const now = new Date('2026-05-17T00:00:00.000Z');

  // now = 2026-05-17. 90d cutoff = 2026-02-16. 365d cutoff = 2025-05-17.
  function jobsBatch() {
    return [
      makeJob({ id: 1, status: 'completed',  scheduled_date: '2026-05-10T12:00:00Z' }),  // within 90d
      makeJob({ id: 2, status: 'completed',  scheduled_date: '2025-09-01T12:00:00Z' }),  // within 365d but >90d
      makeJob({ id: 3, status: 'completed',  scheduled_date: '2024-01-01T12:00:00Z' }),  // older than 365d
      makeJob({ id: 4, status: 'pending',    scheduled_date: '2026-05-12T12:00:00Z' }),  // not completed — drop
      makeJob({ id: 5, status: 'cancelled',  scheduled_date: '2026-05-12T12:00:00Z' }),  // cancelled — drop
      makeJob({ id: 6, status: 'completed',  scheduled_date: '2026-05-15T12:00:00Z', service_address_lat: null }), // no coords — drop
    ];
  }

  test('only completed + geocoded jobs survive (no leakage of pending/cancelled)', () => {
    const body = buildResponse({ jobs: jobsBatch(), options: { range: 'all' }, tenantPublicId: 't1', now });
    expect(body.enabled).toBe(true);
    expect(body.pinCount).toBe(3);
    expect(body.pins).toHaveLength(3);
  });

  test('range=90d trims older entries', () => {
    const body = buildResponse({ jobs: jobsBatch(), options: { range: '90d' }, tenantPublicId: 't1', now });
    expect(body.range).toBe('90d');
    expect(body.pinCount).toBe(1);
  });

  test('range=365d trims entries older than a year', () => {
    const body = buildResponse({ jobs: jobsBatch(), options: { range: '365d' }, tenantPublicId: 't1', now });
    expect(body.range).toBe('365d');
    expect(body.pinCount).toBe(2);
  });

  test('maxPins is respected (early termination)', () => {
    const many = [];
    for (let i = 0; i < 50; i++) {
      many.push(makeJob({ id: 1000 + i, scheduled_date: '2026-05-01T00:00:00Z' }));
    }
    const body = buildResponse({ jobs: many, options: { range: 'all', maxPins: 7 }, tenantPublicId: 't1', now });
    expect(body.maxPins).toBe(7);
    expect(body.pinCount).toBe(7);
    expect(body.pins).toHaveLength(7);
  });

  test('tenant isolation — handler is responsible for the SQL filter; the builder must not invent rows for an unrelated tenant', () => {
    // If the handler passes an empty job set (e.g. wrong tenant), the
    // builder must return zero pins. This guards against accidental
    // "fallback" behavior leaking other tenants' data through the
    // shared sanitizer.
    const body = buildResponse({ jobs: [], options: {}, tenantPublicId: 'unknown-tenant', now });
    expect(body.pinCount).toBe(0);
    expect(body.pins).toEqual([]);
    expect(body.enabled).toBe(true);
    expect(body.tenantPublicId).toBe('unknown-tenant');
  });

  test('response shape never includes raw PII at the top level either', () => {
    const body = buildResponse({ jobs: jobsBatch(), options: {}, tenantPublicId: 't1', now });
    const serialized = JSON.stringify(body);
    expect(serialized).not.toMatch(/Jane Doe|jane@example|5551234567|123 Real Street|gate code/i);
    for (const pin of body.pins) {
      expect(Object.keys(pin).sort()).toEqual(ALLOWED_KEYS.slice().sort());
    }
  });
});
