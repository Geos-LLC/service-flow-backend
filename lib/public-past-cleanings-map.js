'use strict';

// Public Past Cleanings Map Widget — sanitization + response builder.
//
// Pure module (no DB / network). The HTTP handler does the tenant lookup
// and SELECT, then hands the rows here to be turned into a public-safe
// pin set.
//
// Privacy contract (issue #3):
//   - Only completed jobs are included.
//   - Approximate coordinates only — exact job lat/lng are perturbed by a
//     deterministic offset (~150–500 m typical) so the original address
//     cannot be recovered from the pin. The jitter is keyed off the job
//     id so the same job always renders in the same approximate spot
//     across page loads (no "moving pins" effect).
//   - Exposed fields: approximate lat/lng, city (or zip prefix fallback),
//     service type, completed month/year.
//   - Never exposed: customer name, email, phone, exact address /
//     street / unit / zip, notes, scheduled time, customer_id, job id.

const DEFAULT_MAX_PINS = 250;
const HARD_MAX_PINS = 1000;
const ALLOWED_RANGES = Object.freeze({
  '90d': 90,
  '365d': 365,
  all: null,
});
const DEFAULT_RANGE = '365d';

// Jitter envelope. At mid-latitudes 1° lat ≈ 111 km, so 0.0025° ≈ 280 m.
// We want pins that are visibly "near" the real spot but not identifying.
const JITTER_DEGREES = 0.0025;

function clampInt(v, fallback, max) {
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, max);
}

function normalizeRange(raw) {
  if (raw == null) return DEFAULT_RANGE;
  const k = String(raw).trim().toLowerCase();
  if (k === '90' || k === '90d' || k === '90days') return '90d';
  if (k === '365' || k === '365d' || k === '365days' || k === '1y') return '365d';
  if (k === 'all' || k === '*' || k === '') return 'all';
  return DEFAULT_RANGE;
}

function parseOptions(raw) {
  raw = raw || {};
  const range = normalizeRange(raw.range);
  const requestedMax = clampInt(raw.maxPins, DEFAULT_MAX_PINS, HARD_MAX_PINS);
  return {
    range,
    maxPins: requestedMax,
    rangeDays: ALLOWED_RANGES[range],
  };
}

// Deterministic small offset so pins render in the same approximate
// spot across reloads but cannot be reversed to the true coordinate.
// Uses a string hash so callers don't need to import a crypto lib.
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
  // Map to [-1, 1) then scale.
  const dx = ((h1 / 0xffffffff) * 2 - 1) * JITTER_DEGREES;
  const dy = ((h2 / 0xffffffff) * 2 - 1) * JITTER_DEGREES;
  return { dLat: dy, dLng: dx };
}

function roundCoord(n) {
  // Keep ~3 decimal places so the public payload doesn't carry the full
  // 7-decimal precision of the source row. ~110 m at mid-latitudes.
  return Math.round(n * 1000) / 1000;
}

function pickCity(job) {
  const city = (job.service_address_city || '').trim();
  if (city) return city;
  const zip = (job.service_address_zip || '').trim();
  if (zip) return `${zip.slice(0, 3)}xx`;
  return null;
}

function monthYear(scheduledDate) {
  if (!scheduledDate) return null;
  const d = new Date(scheduledDate);
  if (Number.isNaN(d.getTime())) {
    // scheduled_date is `text NOT NULL` in the schema — fall back to
    // pulling YYYY-MM out of a plausible prefix.
    const m = /^(\d{4})-(\d{2})/.exec(String(scheduledDate));
    if (m) return `${m[1]}-${m[2]}`;
    return null;
  }
  const y = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${mm}`;
}

// One job row -> one sanitized pin, or null if the job lacks coordinates
// or isn't safe to include.
function sanitizeJob(job) {
  if (!job) return null;
  if (job.status !== 'completed') return null;
  const lat = Number(job.service_address_lat);
  const lng = Number(job.service_address_lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat === 0 && lng === 0) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;

  const seed = job.id != null ? `job:${job.id}` : `coord:${lat},${lng}`;
  const { dLat, dLng } = jitterFor(seed);

  const pin = {
    lat: roundCoord(lat + dLat),
    lng: roundCoord(lng + dLng),
    city: pickCity(job),
    serviceType: job.service_name || job.service_type || null,
    completedMonth: monthYear(job.scheduled_date),
  };
  return pin;
}

// Apply the date range filter against scheduled_date (which is the
// completion date for completed jobs in this codebase).
function withinRange(job, rangeDays, now) {
  if (rangeDays == null) return true;
  const d = new Date(job.scheduled_date);
  if (Number.isNaN(d.getTime())) return false;
  const cutoff = now.getTime() - rangeDays * 24 * 60 * 60 * 1000;
  return d.getTime() >= cutoff;
}

function buildResponse({ jobs, options, tenantPublicId, now }) {
  const opts = parseOptions(options);
  const nowDate = now instanceof Date ? now : new Date();
  const rows = Array.isArray(jobs) ? jobs : [];

  const pins = [];
  for (const job of rows) {
    if (!withinRange(job, opts.rangeDays, nowDate)) continue;
    const pin = sanitizeJob(job);
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

module.exports = {
  DEFAULT_MAX_PINS,
  HARD_MAX_PINS,
  ALLOWED_RANGES,
  parseOptions,
  sanitizeJob,
  buildResponse,
  disabledResponse,
  // exported for tests
  _hashKey: hashKey,
  _jitterFor: jitterFor,
};
