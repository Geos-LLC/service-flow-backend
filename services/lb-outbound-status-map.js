/**
 * LeadBridge outbound status allowlist — DEFENSIVE FILTER ONLY
 *
 * MIRROR of geos-leadbridge/src/integrations/service-flow/sf-status-map.ts.
 * LB owns the status mapping contract. This file exists purely to
 * stop obviously-invalid statuses from wasting an HTTP round-trip.
 *
 * When LB's mapSfStatus adds/removes entries, update this list in the
 * same release cycle. Do NOT add SF-specific business logic here —
 * if the product needs to restrict which statuses sync, do that in a
 * feature flag / user setting / admin config, not here.
 *
 * After widening the list: replay rows sitting in
 * state='skipped_unmapped_status' via the admin endpoint so any
 * events previously filtered out get delivered.
 */

const ALLOWED_SF_STATUSES = new Set([
  // Pre-service
  'pending', 'confirmed', 'rescheduled',
  // In-service (two spellings supported since both appear in the
  // codebase's enum column)
  'in-progress', 'in_progress', 'en-route', 'en_route', 'started',
  // Completion
  'completed', 'complete', 'paid', 'done',
  // Cancellation
  'cancelled', 'canceled',
  'no-show', 'no_show',
  // Archival
  'archived', 'lost',
  // Lead-style states that may flow through the same pipeline
  'new', 'contacted', 'quoted',
])

function normalizeStatus(sfStatus) {
  return String(sfStatus || '').toLowerCase().trim()
}

function isOutboundAllowed(sfStatus) {
  return ALLOWED_SF_STATUSES.has(normalizeStatus(sfStatus))
}

module.exports = {
  ALLOWED_SF_STATUSES,
  isOutboundAllowed,
  normalizeStatus,
}
