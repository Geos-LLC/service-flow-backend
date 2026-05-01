/**
 * LeadBridge → ServiceFlow inbound status mapping.
 *
 * LB owns its own canonical pipeline:
 *   new -> contacted -> engaged -> quoted -> booked -> scheduled -> in_progress -> completed
 *   terminals: lost, cancelled, no_show, archived
 * (mirror of geos-leadbridge/prisma/schema.prisma Lead.status comment.)
 *
 * SF jobs only exist downstream of conversion. Most early-funnel LB
 * statuses (new/contacted/engaged/quoted/booked) have no job to update
 * — we return null and the caller logs `skipped_no_job_status`.
 *
 * The set of values returned MUST be a subset of ALLOWED_SF_STATUSES
 * in lb-outbound-status-map.js so an inbound write that produces an
 * outbound emit (which would be loop-skipped anyway via source='leadbridge')
 * doesn't accidentally land on a status the outbound layer would
 * later filter as `skipped_unmapped_status`.
 */

const LB_PIPELINE_STATUSES = new Set([
  'new', 'contacted', 'engaged', 'quoted', 'booked',
  'scheduled', 'in_progress', 'completed',
  'lost', 'cancelled', 'no_show', 'archived',
])

function normalizeLbStatus(raw) {
  return String(raw || '').toLowerCase().trim()
}

/**
 * Returns the SF jobs.status string to write, or null when the LB
 * status has no SF-job equivalent (early-funnel or terminal-lead-only).
 */
function mapLbToSfStatus(lbStatus) {
  const lower = normalizeLbStatus(lbStatus)
  switch (lower) {
    case 'scheduled':    return 'scheduled'
    case 'in_progress':  return 'in-progress'
    case 'completed':    return 'completed'
    case 'cancelled':    return 'cancelled'
    case 'no_show':      return 'no-show'
    // Pre-conversion lead states: no SF job to update.
    case 'new':
    case 'contacted':
    case 'engaged':
    case 'quoted':
    case 'booked':
    // Terminal lead-only states: do not synthesize a job change.
    case 'lost':
    case 'archived':
      return null
    default:
      return null
  }
}

function isKnownLbStatus(lbStatus) {
  return LB_PIPELINE_STATUSES.has(normalizeLbStatus(lbStatus))
}

module.exports = {
  LB_PIPELINE_STATUSES,
  mapLbToSfStatus,
  isKnownLbStatus,
  normalizeLbStatus,
}
