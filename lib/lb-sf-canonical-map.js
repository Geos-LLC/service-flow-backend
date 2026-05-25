'use strict';

// SF status → LB canonical pipeline status.
//
// SF-side mirror of LB's `geos-leadbridge/src/integrations/service-flow/sf-status-map.ts`.
// LB owns the contract — when LB widens or changes its accepted mapping,
// this file MUST move in lockstep. The reconcile workflow uses this to
// compare SF job state against LB lead state in the same vocabulary.
//
// The function returns one of LB's canonical statuses, or null when the
// SF value is unknown / unsupported. Reconcile callers treat null as
// "skip — unsupported".

const LB_CANONICAL = Object.freeze([
  'new',
  'contacted',
  'engaged',
  'quoted',
  'booked',
  'scheduled',
  'in_progress',
  'completed',
  'lost',
  'cancelled',
  'no_show',
  'archived',
]);

// Forward direction of LB's active pipeline. Off-pipeline terminals
// (lost/cancelled/no_show/archived) are intentionally absent so the
// regression guard never blocks a transition INTO them.
const LB_PIPELINE_ORDER = Object.freeze([
  'new',
  'contacted',
  'engaged',
  'quoted',
  'booked',
  'scheduled',
  'in_progress',
  'completed',
]);

// LB's HARD_TERMINAL — block ALL writes. Reconcile must respect this:
// once a lead is `archived`, no SF status push will be accepted.
const LB_HARD_TERMINAL = Object.freeze(new Set(['archived']));

// LB's AUTOMATION_TERMINAL — block lb_automation writes only; SF
// (service_flow source) can still override. Reconcile pushes via the
// service_flow source, so these are not blocking.
const LB_AUTOMATION_TERMINAL = Object.freeze(new Set([
  'lost', 'cancelled', 'no_show', 'completed', 'archived',
]));

function normalizeStatus(s) {
  return String(s || '').toLowerCase().trim();
}

function mapSfToLbCanonical(sfStatus) {
  const s = normalizeStatus(sfStatus);
  if (!s) return null;
  switch (s) {
    // Pre-service → scheduled
    case 'pending':
    case 'confirmed':
    case 'rescheduled':
      return 'scheduled';
    // In-service → in_progress
    case 'in-progress':
    case 'in_progress':
    case 'en-route':
    case 'en_route':
    case 'started':
      return 'in_progress';
    // Completion → completed
    case 'completed':
    case 'complete':
    case 'paid':
    case 'done':
      return 'completed';
    // Cancellation
    case 'cancelled':
    case 'canceled':
      return 'cancelled';
    case 'no-show':
    case 'no_show':
      return 'no_show';
    case 'archived':
      return 'archived';
    case 'lost':
      return 'lost';
    // Early-funnel passthrough — these reach SF jobs only in edge cases
    case 'new':
      return 'new';
    case 'contacted':
      return 'contacted';
    case 'quoted':
      return 'quoted';
    default:
      return null;
  }
}

// True when both canonicals are on the active pipeline AND `newStatus`
// is strictly earlier than `lbCurrent`. Reconcile uses this as a safety
// gate: if SF would push the LB lead backwards in the pipeline, we skip.
// Transitions INTO an off-pipeline terminal (lost/cancelled/no_show/
// archived) are never regressions — they're allowed from any pipeline
// position.
function isPipelineRegression(lbCurrent, sfNew) {
  if (!lbCurrent || !sfNew) return false;
  const li = LB_PIPELINE_ORDER.indexOf(lbCurrent);
  const si = LB_PIPELINE_ORDER.indexOf(sfNew);
  if (li < 0 || si < 0) return false;
  return si < li;
}

function isHardTerminal(canonical) {
  return LB_HARD_TERMINAL.has(canonical);
}

module.exports = {
  LB_CANONICAL,
  LB_PIPELINE_ORDER,
  LB_HARD_TERMINAL,
  LB_AUTOMATION_TERMINAL,
  mapSfToLbCanonical,
  isPipelineRegression,
  isHardTerminal,
  normalizeStatus,
};
