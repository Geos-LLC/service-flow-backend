'use strict';

// Tests for the Public Past Cleanings Map Widget V1 (issue #3).
//
// Covers:
//   - tenant isolation (sanitizer never returns a foreign tenant's row)
//   - only completed jobs are projected
//   - no private customer / address fields exposed in either projection or response
//   - global feature flag OFF → disabled response shape
//   - per-tenant disabled flag → disabled response shape
//   - max pins hard cap (MAX_PUBLIC_WIDGET_PINS = 500)
//   - date range (90d / 365d / all) filter behavior
//   - deterministic geo jitter (no "moving pins" on reload)
//   - tenant settings + query params: query CANNOT exceed tenant cap

const {
  FLAGS,
  isEnabled,
} = require('../lib/feature-flags');

const {
  MAX_PUBLIC_WIDGET_PINS,
  DEFAULT_MAX_PINS,
  DEFAULT_RANGE,
  ALLOWED_RANGES,
  GEO_METHODS,
  projectFromJob,
  rowToPin,
  resolveTenantSettings,
  buildEffectiveOptions,
  buildResponse,
  disabledResponse,
} = require('../lib/public-past-cleanings-map');

const { defaultSettings } = require('../lib/tenant-widget-settings');

const PUBLIC_PIN_KEYS = ['lat', 'lng', 'city', 'serviceType', 'completedMonth'];
const FORBIDDEN_PIN_KEYS = [
  'customer_id', 'customer_name', 'customer_email', 'customer_phone',
  'first_name', 'last_name', 'email', 'phone',
  'service_address_street', 'service_address_zip',
  'service_address_lat', 'service_address_lng',
  'notes', 'internal_notes', 'customer_notes',
  'scheduled_time', 'id', 'user_id', 'tenant_id', 'job_id',
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
    completed_at: '2026-04-15T18:00:00.000Z',
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

function projectionRowFromJob(job) {
  // Helper: simulate what a refresher worker would persist into
  // public_job_map_projection.
  return projectFromJob(job);
}

// ─── feature flag ─────────────────────────────────────────────────────────

describe('public-past-cleanings-map: feature flag', () => {
  afterEach(() => { delete process.env.PUBLIC_CLEANINGS_MAP_WIDGET_ENABLED; });

  test('flag exists and defaults to false', () => {
    expect(FLAGS.PUBLIC_CLEANINGS_MAP_WIDGET_ENABLED).toBe('PUBLIC_CLEANINGS_MAP_WIDGET_ENABLED');
    expect(isEnabled(FLAGS.PUBLIC_CLEANINGS_MAP_WIDGET_ENABLED)).toBe(false);
  });

  test('flag flips on with env override', () => {
    process.env.PUBLIC_CLEANINGS_MAP_WIDGET_ENABLED = '1';
    expect(isEnabled(FLAGS.PUBLIC_CLEANINGS_MAP_WIDGET_ENABLED)).toBe(true);
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

// ─── projection (raw job → projection row) ────────────────────────────────

describe('projectFromJob: privacy contract', () => {
  test('projection row contains only sanitized columns — no PII', () => {
    const row = projectFromJob(makeJob());
    expect(row).not.toBeNull();
    const allowed = [
      'tenant_id', 'job_id',  // FK / scope columns: stay in DB, never returned to public
      'public_lat', 'public_lng', 'public_geo_method',
      'service_type', 'city', 'completed_month', 'completed_year', 'completed_on',
    ];
    expect(Object.keys(row).sort()).toEqual(allowed.slice().sort());
    expect(JSON.stringify(row)).not.toMatch(/Jane Doe|jane@example|5551234567|123 Real Street|gate code/i);
  });

  test('drops non-completed jobs', () => {
    for (const status of ['pending', 'confirmed', 'scheduled', 'cancelled', 'in_progress', null, undefined]) {
      expect(projectFromJob(makeJob({ status }))).toBeNull();
    }
  });

  test('drops jobs missing coordinates or with invalid lat/lng', () => {
    expect(projectFromJob(makeJob({ service_address_lat: null, service_address_lng: null }))).toBeNull();
    expect(projectFromJob(makeJob({ service_address_lat: 0, service_address_lng: 0 }))).toBeNull();
    expect(projectFromJob(makeJob({ service_address_lat: 'not a number' }))).toBeNull();
    expect(projectFromJob(makeJob({ service_address_lat: 95 }))).toBeNull();
    expect(projectFromJob(makeJob({ service_address_lng: 200 }))).toBeNull();
  });

  test('approximate coordinates: never equal exact source coords', () => {
    const j = makeJob({ id: 42, service_address_lat: 40.66801234, service_address_lng: -73.98551234 });
    const row = projectFromJob(j);
    expect(row.public_lat).not.toBe(j.service_address_lat);
    expect(row.public_lng).not.toBe(j.service_address_lng);
    // jitter envelope is 0.0025°; rounding adds at most ~0.00001°.
    expect(Math.abs(row.public_lat - j.service_address_lat)).toBeLessThan(0.005);
    expect(Math.abs(row.public_lng - j.service_address_lng)).toBeLessThan(0.005);
  });

  test('approximate coordinates are deterministic per job id', () => {
    const j = makeJob({ id: 7 });
    expect(projectFromJob(j)).toEqual(projectFromJob(j));
  });

  test('different jobs at the same exact coord get different jitter', () => {
    const a = projectFromJob(makeJob({ id: 1, service_address_lat: 40.7, service_address_lng: -74.0 }));
    const b = projectFromJob(makeJob({ id: 2, service_address_lat: 40.7, service_address_lng: -74.0 }));
    expect(a.public_lat === b.public_lat && a.public_lng === b.public_lng).toBe(false);
  });

  test('records geo method as jitter', () => {
    const row = projectFromJob(makeJob());
    expect(row.public_geo_method).toBe(GEO_METHODS.JITTER);
  });

  test('completed_on/month/year derived from completed_at when present', () => {
    const row = projectFromJob(makeJob({
      scheduled_date: '2026-01-01',
      completed_at: '2026-04-15T18:00:00.000Z',
    }));
    expect(row.completed_year).toBe(2026);
    expect(row.completed_month).toBe(4);
    expect(row.completed_on).toBe('2026-04-15');
  });

  test('falls back to scheduled_date when completed_at is absent', () => {
    const row = projectFromJob(makeJob({
      completed_at: null,
      scheduled_date: '2026-02-09',
    }));
    expect(row.completed_year).toBe(2026);
    expect(row.completed_month).toBe(2);
    expect(row.completed_on).toBe('2026-02-09');
  });

  test('city falls back to zip-prefix when service_address_city is empty', () => {
    expect(projectFromJob(makeJob({ service_address_city: '', service_address_zip: '11215' })).city).toBe('112xx');
    expect(projectFromJob(makeJob({ service_address_city: null, service_address_zip: null })).city).toBeNull();
  });

  test('tenant isolation: each row stamped with its own tenant_id', () => {
    const a = projectFromJob(makeJob({ id: 1, user_id: 100 }));
    const b = projectFromJob(makeJob({ id: 2, user_id: 200 }));
    expect(a.tenant_id).toBe(100);
    expect(b.tenant_id).toBe(200);
  });
});

// ─── rowToPin (projection → public pin) ───────────────────────────────────

describe('rowToPin: public pin shape', () => {
  test('returns only the allowed public keys', () => {
    const row = projectFromJob(makeJob());
    const pin = rowToPin(row);
    expect(Object.keys(pin).sort()).toEqual(PUBLIC_PIN_KEYS.slice().sort());
    for (const banned of FORBIDDEN_PIN_KEYS) {
      expect(Object.prototype.hasOwnProperty.call(pin, banned)).toBe(false);
    }
  });

  test('completedMonth is "YYYY-MM" string, never a timestamp', () => {
    const row = projectFromJob(makeJob({ completed_at: '2026-04-15T18:00:00.000Z' }));
    const pin = rowToPin(row);
    expect(pin.completedMonth).toBe('2026-04');
    expect(pin.completedMonth).not.toMatch(/T|:|18/);
  });

  test('drops rows with non-numeric coords', () => {
    expect(rowToPin({ public_lat: 'x', public_lng: 0, completed_year: 2026, completed_month: 1 })).toBeNull();
  });
});

// ─── tenant settings + query coercion ─────────────────────────────────────

describe('resolveTenantSettings', () => {
  test('disabled by default when no row exists', () => {
    expect(defaultSettings().enabled).toBe(false);
  });

  test('clamps max pins to MAX_PUBLIC_WIDGET_PINS', () => {
    const s = resolveTenantSettings({ past_cleanings_enabled: true, past_cleanings_max_pins: 99999, past_cleanings_range: 'all' });
    expect(s.maxPins).toBe(MAX_PUBLIC_WIDGET_PINS);
    expect(MAX_PUBLIC_WIDGET_PINS).toBe(500);
  });

  test('snaps invalid range back to default', () => {
    const s = resolveTenantSettings({ past_cleanings_enabled: true, past_cleanings_range: 'forever' });
    expect(s.range).toBe(DEFAULT_RANGE);
  });

  test('range allowlist is 90d / 365d / all', () => {
    expect(Object.keys(ALLOWED_RANGES).sort()).toEqual(['365d', '90d', 'all']);
  });
});

describe('buildEffectiveOptions', () => {
  test('query maxPins cannot exceed tenant cap', () => {
    const settings = { past_cleanings_enabled: true, past_cleanings_max_pins: 100, past_cleanings_range: 'all' };
    const opts = buildEffectiveOptions(settings, { maxPins: '99999' });
    expect(opts.maxPins).toBe(100);
  });

  test('query maxPins can lower the effective cap', () => {
    const settings = { past_cleanings_enabled: true, past_cleanings_max_pins: 250, past_cleanings_range: 'all' };
    expect(buildEffectiveOptions(settings, { maxPins: '25' }).maxPins).toBe(25);
  });

  test('hard cap MAX_PUBLIC_WIDGET_PINS always enforced regardless of settings', () => {
    // Even if a corrupt settings row somehow ends up with a higher value,
    // resolveTenantSettings clamps to the hard cap, and buildEffectiveOptions
    // takes the min of (tenant, query, hard cap).
    const settings = { past_cleanings_enabled: true, past_cleanings_max_pins: 99999, past_cleanings_range: 'all' };
    expect(buildEffectiveOptions(settings, { maxPins: '99999' }).maxPins).toBe(MAX_PUBLIC_WIDGET_PINS);
  });

  test('query range can shorten window but not extend it', () => {
    const tightSettings = { past_cleanings_enabled: true, past_cleanings_max_pins: 100, past_cleanings_range: '90d' };
    // Asking for "all" when tenant set 90d → stays at 90d
    expect(buildEffectiveOptions(tightSettings, { range: 'all' }).range).toBe('90d');
    // Asking for 365d when tenant set 90d → stays at 90d (less restrictive denied)
    expect(buildEffectiveOptions(tightSettings, { range: '365d' }).range).toBe('90d');
    // Tenant set "all" + query "90d" → 90d wins (more restrictive accepted)
    const looseSettings = { past_cleanings_enabled: true, past_cleanings_max_pins: 100, past_cleanings_range: 'all' };
    expect(buildEffectiveOptions(looseSettings, { range: '90d' }).range).toBe('90d');
  });
});

// ─── response builder ─────────────────────────────────────────────────────

describe('buildResponse: PII does not leak through the response', () => {
  function projectionRowsBatch() {
    return [
      projectFromJob(makeJob({ id: 1,  status: 'completed', completed_at: '2026-05-10T12:00:00Z' })),
      projectFromJob(makeJob({ id: 2,  status: 'completed', completed_at: '2025-09-01T12:00:00Z' })),
      projectFromJob(makeJob({ id: 3,  status: 'completed', completed_at: '2024-01-01T12:00:00Z' })),
    ];
  }

  test('response shape never includes raw PII at any level', () => {
    const body = buildResponse({
      rows: projectionRowsBatch(),
      options: { range: '365d', maxPins: 250 },
      tenantPublicId: 'acme',
    });
    const serialized = JSON.stringify(body);
    expect(serialized).not.toMatch(/Jane Doe|jane@example|5551234567|123 Real Street|gate code/i);
    for (const pin of body.pins) {
      expect(Object.keys(pin).sort()).toEqual(PUBLIC_PIN_KEYS.slice().sort());
    }
  });

  test('top-level shape: enabled / range / maxPins / pinCount / pins / tenantPublicId', () => {
    const body = buildResponse({
      rows: projectionRowsBatch(),
      options: { range: '90d', maxPins: 50 },
      tenantPublicId: 'acme',
    });
    expect(body.enabled).toBe(true);
    expect(body.tenantPublicId).toBe('acme');
    expect(body.range).toBe('90d');
    expect(body.maxPins).toBe(50);
    expect(body.pinCount).toBe(body.pins.length);
  });

  test('tenant isolation: empty rows array → zero pins; the builder cannot synthesize foreign data', () => {
    const body = buildResponse({ rows: [], options: { range: 'all', maxPins: 250 }, tenantPublicId: 'unknown' });
    expect(body.pinCount).toBe(0);
    expect(body.pins).toEqual([]);
    expect(body.enabled).toBe(true);
    expect(body.tenantPublicId).toBe('unknown');
  });

  test('maxPins is respected (early termination)', () => {
    const many = [];
    for (let i = 0; i < 50; i++) {
      many.push(projectFromJob(makeJob({ id: 1000 + i, completed_at: '2026-05-01T00:00:00Z' })));
    }
    const body = buildResponse({ rows: many, options: { range: 'all', maxPins: 7 }, tenantPublicId: 't1' });
    expect(body.maxPins).toBe(7);
    expect(body.pinCount).toBe(7);
    expect(body.pins).toHaveLength(7);
  });
});

// ─── disabled states ──────────────────────────────────────────────────────

describe('disabled states', () => {
  test('global flag OFF → disabledResponse is what the endpoint returns', () => {
    delete process.env.PUBLIC_CLEANINGS_MAP_WIDGET_ENABLED;
    expect(isEnabled(FLAGS.PUBLIC_CLEANINGS_MAP_WIDGET_ENABLED)).toBe(false);
    const body = disabledResponse('acme');
    expect(body.enabled).toBe(false);
    expect(body.pins).toEqual([]);
  });

  test('tenant settings disabled → disabledResponse is what the endpoint returns', () => {
    const settings = resolveTenantSettings({ past_cleanings_enabled: false, past_cleanings_max_pins: 250, past_cleanings_range: 'all' });
    expect(settings.enabled).toBe(false);
    // Per endpoint logic in server.js: if !settings.enabled → disabledResponse.
    const body = disabledResponse('acme');
    expect(body.enabled).toBe(false);
    expect(body.pinCount).toBe(0);
  });

  test('hard cap MAX_PUBLIC_WIDGET_PINS is 500 (spec)', () => {
    expect(MAX_PUBLIC_WIDGET_PINS).toBe(500);
  });

  test('default max pins is below hard cap', () => {
    expect(DEFAULT_MAX_PINS).toBeLessThanOrEqual(MAX_PUBLIC_WIDGET_PINS);
  });
});
