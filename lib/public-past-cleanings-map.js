'use strict';

// Public Past Cleanings Map Widget — pure helpers.
//
// Two concerns live here, both DB-free:
//
//   1. projectFromJob(job) — turns a raw completed job into a sanitized
//      projection row destined for the public_job_map_projection table.
//      Geo privacy (deterministic jitter or zip/city centroid) is applied
//      here so the projection table itself never carries exact coords.
//
//   2. buildResponse({ pins, settings, options, tenantPublicId }) —
//      turns projection rows + tenant settings + the request query into
//      the public JSON response served by the HTTP endpoint. Response
//      shape is fixed; the only fields ever exposed per pin are:
//        lat, lng, city, serviceType, completedMonth.
//
// Privacy contract (issue #3):
//   - Only completed jobs are eligible. Status check in projectFromJob.
//   - Coordinates are perturbed by a deterministic offset (~280 m
//     envelope, keyed on job id) and rounded to 5 decimal places. The
//     same job always projects to the same approximate spot across
//     rebuilds, but the true coordinate cannot be recovered.
//   - Falls back to zip-prefix or city centroid hints when no usable
//     lat/lng is on the job. The fallback method is recorded in
//     public_geo_method so audits can see the policy applied per pin.
//   - Public response fields: lat, lng, city, serviceType, completedMonth.
//   - NEVER emitted: customer name/email/phone, exact lat/lng, street,
//     full zip, notes, scheduled time, customer_id, internal job id.

// ── constants ───────────────────────────────────────────────────────────────

// Hard system-wide cap on pins, regardless of tenant setting or query
// override. Spec calls this MAX_PUBLIC_WIDGET_PINS=500.
const MAX_PUBLIC_WIDGET_PINS = 500;
const DEFAULT_MAX_PINS = 250;

const ALLOWED_RANGES = Object.freeze({
  '90d': 90,
  '365d': 365,
  all: null,
});
const DEFAULT_RANGE = '365d';

const GEO_METHODS = Object.freeze({
  JITTER: 'jitter',
  ZIP_CENTROID: 'zip_centroid',
  CITY_CENTROID: 'city_centroid',
});

// ~0.0025° ≈ 280 m at mid-latitudes. Visible "near" the real spot but
// not identifying.
const JITTER_DEGREES = 0.0025;

// ── helpers ─────────────────────────────────────────────────────────────────

function clampInt(v, fallback, max) {
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, max);
}

function normalizeRange(raw) {
  if (raw == null) return null;
  const k = String(raw).trim().toLowerCase();
  if (k === '90' || k === '90d' || k === '90days') return '90d';
  if (k === '365' || k === '365d' || k === '365days' || k === '1y') return '365d';
  if (k === 'all' || k === '*') return 'all';
  return null;
}

// Deterministic small offset so pins render in the same approximate
// spot across reloads but cannot be reversed to the true coordinate.
function hashKey(seed) {
  const s = String(seed == null ? '' : seed);
  let h1 = 0x9e3779b1 >>> 0;
  let h2 = 0x85ebca77 >>> 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x85ebca6b) >>> 0;
    h2 = Math.imul(h2 ^ c, 0xc2b2ae35) >>> 0;
  }
  return [h1, h2];
}

function jitterFor(seed) {
  const [h1, h2] = hashKey(seed);
  const dx = ((h1 / 0xffffffff) * 2 - 1) * JITTER_DEGREES;
  const dy = ((h2 / 0xffffffff) * 2 - 1) * JITTER_DEGREES;
  return { dLat: dy, dLng: dx };
}

function roundCoord(n) {
  // 5 decimal places ≈ 1 m precision in absolute terms, but the source
  // is already jittered by ±280 m so the published coordinate is
  // effectively "neighborhood-level".
  return Math.round(n * 100000) / 100000;
}

function pickCity(job) {
  const city = (job.service_address_city || '').trim();
  if (city) return city;
  const zip = (job.service_address_zip || '').trim();
  if (zip) return `${zip.slice(0, 3)}xx`;
  return null;
}

function parseScheduledDate(value) {
  if (!value) return null;
  // jobs.scheduled_date is TEXT NOT NULL in this schema. Accept either
  // an ISO timestamp or a bare YYYY-MM-DD.
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value));
  if (m) {
    return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  }
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function monthYearString(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;
  const y = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${mm}`;
}

// ── projection builder ──────────────────────────────────────────────────────

// Turn a raw job row into a projection row ready for INSERT into
// public_job_map_projection. Returns null if the job is not eligible
// (wrong status, no coords AND no city/zip fallback, invalid date).
//
// The projection row uses these fields:
//   tenant_id, job_id, public_lat, public_lng, public_geo_method,
//   service_type, city, completed_month, completed_year, completed_on
function projectFromJob(job) {
  if (!job) return null;
  if (job.status !== 'completed') return null;

  const tenantId = job.user_id != null ? Number(job.user_id) : null;
  const jobId = job.id != null ? Number(job.id) : null;
  if (!Number.isFinite(tenantId) || !Number.isFinite(jobId)) return null;

  const completedDate = parseScheduledDate(job.completed_at || job.scheduled_date);
  if (!completedDate) return null;

  const city = pickCity(job);

  // Derive public coordinates. Order of preference:
  //   1. real lat/lng + deterministic jitter
  //   2. zip-centroid hint (if a centroid lookup table is provided)
  //   3. city-centroid hint (same)
  // Without centroid tables wired up in v1, we only have option 1.
  // Jobs lacking real coordinates are excluded — they can't be plotted
  // without a centroid resolver.
  const lat = Number(job.service_address_lat);
  const lng = Number(job.service_address_lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat === 0 && lng === 0) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;

  const seed = `job:${jobId}`;
  const { dLat, dLng } = jitterFor(seed);
  const publicLat = roundCoord(lat + dLat);
  const publicLng = roundCoord(lng + dLng);

  return {
    tenant_id: tenantId,
    job_id: jobId,
    public_lat: publicLat,
    public_lng: publicLng,
    public_geo_method: GEO_METHODS.JITTER,
    service_type: (job.service_name || job.service_type || null) || null,
    city,
    completed_month: completedDate.getUTCMonth() + 1,
    completed_year: completedDate.getUTCFullYear(),
    completed_on: completedDate.toISOString().slice(0, 10),
  };
}

// ── response builder ────────────────────────────────────────────────────────

// Turn a projection row into a public pin. The projection table already
// contains only sanitized columns — this is a final shape transform.
function rowToPin(row) {
  if (!row) return null;
  const lat = Number(row.public_lat);
  const lng = Number(row.public_lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const year = Number(row.completed_year);
  const month = Number(row.completed_month);
  let completedMonth = null;
  if (Number.isFinite(year) && Number.isFinite(month) && month >= 1 && month <= 12) {
    completedMonth = `${year}-${String(month).padStart(2, '0')}`;
  }
  return {
    lat,
    lng,
    city: row.city || null,
    serviceType: row.service_type || null,
    completedMonth,
  };
}

// Normalize raw tenant settings out of the DB row into the shape we use
// to drive request handling. Defensive against missing / malformed cols
// — anything off-spec snaps back to the defaults.
function resolveTenantSettings(raw) {
  const row = raw || {};
  const enabled = row.past_cleanings_enabled === true;
  const range = normalizeRange(row.past_cleanings_range) || DEFAULT_RANGE;
  const maxPins = clampInt(row.past_cleanings_max_pins, DEFAULT_MAX_PINS, MAX_PUBLIC_WIDGET_PINS);
  return { enabled, range, maxPins };
}

// Build the response options for a single request. Tenant settings are
// the source of truth; query params can REDUCE limits (smaller maxPins,
// shorter range) but never EXCEED them — that way an embedder cannot
// override the tenant's chosen privacy budget by spoofing the URL.
function buildEffectiveOptions(tenantSettings, query) {
  const settings = resolveTenantSettings(tenantSettings);
  const requestedRange = normalizeRange(query && query.range);
  const requestedMaxPins = query && query.maxPins != null
    ? clampInt(query.maxPins, settings.maxPins, MAX_PUBLIC_WIDGET_PINS)
    : settings.maxPins;

  // Pick the *more restrictive* range of (tenant setting, request).
  let effectiveRange = settings.range;
  if (requestedRange) {
    const tenantDays = ALLOWED_RANGES[settings.range];
    const requestedDays = ALLOWED_RANGES[requestedRange];
    if (tenantDays == null) {
      effectiveRange = requestedRange;
    } else if (requestedDays != null && requestedDays <= tenantDays) {
      effectiveRange = requestedRange;
    }
  }

  // Effective maxPins is min(tenant setting, query override, hard cap).
  const effectiveMaxPins = Math.min(settings.maxPins, requestedMaxPins, MAX_PUBLIC_WIDGET_PINS);

  return {
    enabled: settings.enabled,
    range: effectiveRange,
    rangeDays: ALLOWED_RANGES[effectiveRange],
    maxPins: effectiveMaxPins,
  };
}

function disabledResponse(tenantPublicId) {
  return {
    enabled: false,
    tenantPublicId: tenantPublicId || null,
    range: null,
    maxPins: 0,
    pinCount: 0,
    pins: [],
  };
}

function buildResponse({ rows, options, tenantPublicId }) {
  const opts = options || {};
  const pins = [];
  const all = Array.isArray(rows) ? rows : [];
  for (const row of all) {
    const pin = rowToPin(row);
    if (pin) pins.push(pin);
    if (pins.length >= opts.maxPins) break;
  }
  return {
    enabled: true,
    tenantPublicId: tenantPublicId || null,
    range: opts.range,
    maxPins: opts.maxPins,
    pinCount: pins.length,
    pins,
  };
}

module.exports = {
  MAX_PUBLIC_WIDGET_PINS,
  DEFAULT_MAX_PINS,
  ALLOWED_RANGES,
  DEFAULT_RANGE,
  GEO_METHODS,
  projectFromJob,
  rowToPin,
  resolveTenantSettings,
  buildEffectiveOptions,
  buildResponse,
  disabledResponse,
  _hashKey: hashKey,
  _jitterFor: jitterFor,
  _normalizeRange: normalizeRange,
};
