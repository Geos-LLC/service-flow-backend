'use strict';

// LB orchestration event emitter (Phase 2B parallel-run).
//
// Emits the four operational-outcome event types alongside the existing
// `job.status_changed` outbound chain. Both fire during Phase 2C canary.
//
//   service_scheduled    — first SF booking creation for an LB-linked job
//   service_rescheduled  — scheduled_date/time changed after creation
//   service_cancelled    — job transitions to cancelled
//   service_completed    — job transitions to completed (or 'done' / 'paid')
//
// Hard rules honored:
//   - only emit when feature flag is on for the tenant
//   - only emit for jobs with lb_external_request_id (LB-attributed)
//   - never emit en-route / started / paid / payroll / ledger transitions
//   - deterministic event_id per (job, event_type) — UNIQUE absorbs replays
//   - same outbox table + drainer + DLQ semantics as job.status_changed
//
// This module is INVOKED FROM:
//   - lib/lb-orchestration-handlers.js (after a booking-request succeeds → service_scheduled)
//   - services/job-status-service.js   (when an LB-linked job changes status)
//
// The job-status-service integration is parallel-run: it calls both the
// legacy `recordOutboundIfApplicable` AND `recordOrchestrationOutbound`.
// Either may no-op (skipped/duplicate); the other is independent.

const { isOrchestrationEnabledForTenant } = require('./lb-orchestration-feature-flag');
const { mapSfToLbCanonical } = require('./lb-sf-canonical-map');

const ORCHESTRATION_EVENT_TYPES = Object.freeze([
  'service_scheduled',
  'service_rescheduled',
  'service_cancelled',
  'service_completed',
]);

// Deterministic event_id format. Two emits for the same (job, type) collide
// on the existing UNIQUE constraint on leadbridge_outbound_events.event_id.
function orchestrationEventId(eventType, sfJobId) {
  return `evt_${eventType}_${sfJobId}`;
}

/**
 * Decide which orchestration event (if any) corresponds to an SF status
 * transition. Returns null if the transition shouldn't emit an
 * orchestration event.
 *
 * Note: service_rescheduled is NOT triggered by a status change — it's
 * triggered by a scheduled_date change on an already-scheduled job. The
 * job-status-service hook would not catch that; the reschedule handler
 * emits service_rescheduled directly.
 */
function classifyStatusTransitionForOrchestration(oldStatus, newStatus) {
  const canonical = mapSfToLbCanonical(newStatus);
  // We only fire on terminal-ish operational outcomes.
  if (canonical === 'cancelled') return 'service_cancelled';
  if (canonical === 'completed') return 'service_completed';
  // scheduled / in_progress / no_show etc. do NOT fire here.
  // service_scheduled is fired from the booking-request handler on create.
  return null;
}

/**
 * Record an orchestration outbound event in the same outbox the existing
 * recordOutboundIfApplicable uses. Returns:
 *   { action: 'enqueued', event_id }
 *   { action: 'skipped', reason }
 *   { action: 'duplicate', event_id }  // UNIQUE constraint absorbed replay
 *
 * Hard preconditions:
 *   - feature flag enabled for tenant
 *   - job.lb_external_request_id is non-null
 *   - eventType is one of ORCHESTRATION_EVENT_TYPES
 *
 * @param {object} supabase
 * @param {object} args
 * @param {string} args.eventType            — one of ORCHESTRATION_EVENT_TYPES
 * @param {object} args.job                  — { id, user_id, status, scheduled_date, lb_external_request_id, lb_channel, lb_business_id }
 * @param {object} [args.actor]              — { type, id, display_name }
 * @param {string} [args.source]             — 'system' | 'account_owner' | 'team_member' | 'leadbridge'
 * @param {string} [args.orchestrationSessionId]
 * @param {object} [args.extraPayload]
 * @param {object} [args.logger]
 */
async function recordOrchestrationOutbound(supabase, args) {
  const logger = args.logger || console;
  const job = args.job;
  if (!job || !job.id || !job.user_id) {
    return { action: 'skipped', reason: 'invalid_job' };
  }
  if (!isOrchestrationEnabledForTenant(job.user_id)) {
    return { action: 'skipped', reason: 'feature_flag_off' };
  }
  if (!job.lb_external_request_id) {
    return { action: 'skipped', reason: 'not_lb_attributed' };
  }
  if (!ORCHESTRATION_EVENT_TYPES.includes(args.eventType)) {
    return { action: 'skipped', reason: 'unknown_event_type' };
  }
  // Loop guard — never re-emit an event that originated in LB.
  if (args.source === 'leadbridge') {
    return { action: 'skipped', reason: 'leadbridge_origin_loop_guard' };
  }

  const eventId = orchestrationEventId(args.eventType, job.id);
  const occurredAt = new Date().toISOString();

  const payload = {
    event_id: eventId,
    event_type: args.eventType,
    sf_job_id: String(job.id),
    sf_user_id: job.user_id,
    source: 'service_flow',
    source_instance: 'sf-prod',
    occurred_at: occurredAt,
    channel: job.lb_channel || null,
    external_request_id: job.lb_external_request_id,
    job: {
      scheduled_date: job.scheduled_date || null,
      status: job.status || null,
    },
    actor: args.actor || { type: 'system', id: 'sf-orchestration', display_name: 'SF Orchestration' },
    orchestration_session_id: args.orchestrationSessionId || null,
    ...(args.extraPayload || {}),
  };

  const row = {
    event_id: eventId,
    user_id: job.user_id,
    sf_job_id: String(job.id),
    event_type: args.eventType,
    payload_json: payload,
    state: 'queued',
    attempts: 0,
    orchestration_session_id: args.orchestrationSessionId || null,
  };

  try {
    const { error } = await supabase
      .from('leadbridge_outbound_events')
      .insert(row);
    if (error) {
      // 23505 = unique_violation → idempotent replay
      if (error.code === '23505' || /duplicate key/i.test(error.message || '')) {
        logger.log?.(`[LB Orch] duplicate event_id=${eventId} (idempotent replay)`);
        return { action: 'duplicate', event_id: eventId };
      }
      logger.error?.(`[LB Orch] insert failed event_id=${eventId}: ${error.message}`);
      return { action: 'error', reason: error.message };
    }
    logger.log?.(`[LB Orch] enqueued ${args.eventType} job=${job.id} event_id=${eventId}`);
    return { action: 'enqueued', event_id: eventId };
  } catch (e) {
    logger.error?.(`[LB Orch] threw event_id=${eventId}: ${e.message}`);
    return { action: 'error', reason: e.message };
  }
}

module.exports = {
  ORCHESTRATION_EVENT_TYPES,
  orchestrationEventId,
  classifyStatusTransitionForOrchestration,
  recordOrchestrationOutbound,
};
