'use strict';

// LB linkage metrics — in-process counters surfaced via getMetrics()
// for the existing/future /metrics endpoint. No external dependency.
//
// One counter per (jobs_created_*) bucket + outbound skip counter.
// Keyed solely on the resolver's `reason` enum so the metric set is
// stable and matches the [LBLinkage] log lines 1:1.

const { REASONS } = require('./lb-linkage-resolver');

const counters = {
  // Job-create outcome buckets.
  jobs_created_with_lb_linkage: 0,
  jobs_created_without_lb_linkage: 0,
  jobs_created_review_required: 0,

  // Per-reason fine-grained.
  reasons: {},

  // Outbound-side counter — incremented when an updateJobStatus call
  // hits a job that has no lb_external_request_id and we therefore
  // skip enqueueing an outbound event. Distinct from skipped_loop /
  // skipped_unmapped so operators can tell "wired but unlinked" apart
  // from "wired and looping back".
  outbound_status_skipped_not_linked: 0,
};

function bumpReason(reason) {
  if (!reason) return;
  counters.reasons[reason] = (counters.reasons[reason] || 0) + 1;
}

/**
 * Called by job creators after resolveLbLinkage returns.
 * @param {{result: string, reason: string}} resolution
 */
function recordJobCreate(resolution) {
  if (!resolution) return;
  bumpReason(resolution.reason);
  switch (resolution.result) {
    case 'linked':
      counters.jobs_created_with_lb_linkage++;
      break;
    case 'review_required':
      counters.jobs_created_review_required++;
      break;
    default:
      counters.jobs_created_without_lb_linkage++;
  }
}

function recordOutboundSkippedNotLinked() {
  counters.outbound_status_skipped_not_linked++;
}

function getMetrics() {
  return {
    jobs_created_with_lb_linkage: counters.jobs_created_with_lb_linkage,
    jobs_created_without_lb_linkage: counters.jobs_created_without_lb_linkage,
    jobs_created_review_required: counters.jobs_created_review_required,
    outbound_status_skipped_not_linked: counters.outbound_status_skipped_not_linked,
    reasons: { ...counters.reasons },
  };
}

// Reset — exposed for tests only.
function __resetForTests() {
  counters.jobs_created_with_lb_linkage = 0;
  counters.jobs_created_without_lb_linkage = 0;
  counters.jobs_created_review_required = 0;
  counters.outbound_status_skipped_not_linked = 0;
  for (const k of Object.keys(counters.reasons)) delete counters.reasons[k];
}

module.exports = {
  recordJobCreate,
  recordOutboundSkippedNotLinked,
  getMetrics,
  REASONS,
  __resetForTests,
};
