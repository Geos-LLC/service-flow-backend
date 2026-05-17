'use strict';

/**
 * ZB Outbound — structured metric emitters for Phase B.
 *
 * Each emit() function logs ONE structured line with the prefix
 * [ZB-outbound-metric] so Grafana / Loki can index + aggregate
 * without any Prometheus client wiring.
 *
 * Per-doc requirement (phase-b-readiness-v2.md §4.1 / pilot-tenant
 * §2.6): the following types are mandatory:
 *   queued, sent, confirmed, timeout, conflict, superseded, invalidated, dlq
 *
 * Confirm latency P50/P95 are computed by Grafana queries over the
 * latency_ms field emitted on `confirmed` events.
 *
 * Design refs:
 *   - zb-outbound-command-confirmation.md §16 observability spec
 *
 * Safety: every function is wrapped to NEVER throw. Logging failure
 * MUST NOT break the request path or the drainer.
 */

const VALID_METRIC_TYPES = Object.freeze([
  'queued',
  'sent',
  'confirmed',
  'timeout',
  'conflict',
  'superseded',
  'invalidated',
  'dlq',
  'skipped_precondition',
]);

const VALID_TYPES_SET = new Set(VALID_METRIC_TYPES);

/**
 * Emit one structured metric line.
 *
 * @param {Object} args
 *   type              REQUIRED — one of VALID_METRIC_TYPES
 *   userId            tenant scope
 *   commandType       'job.create' | 'job.reschedule' | ...
 *   fieldGroup        'create' | 'schedule' | 'assignment' | ...
 *   eventId           the command's stable event_id (joins multi-line traces)
 *   latencyMs         confirm latency in ms (only for type='confirmed')
 *   errorClass        short error name (only for types: dlq, conflict, timeout)
 *   note              short free-text (e.g., defer_reason)
 *   logger            defaults to console
 */
function emit(args) {
  const a = args || {};
  const logger = a.logger || console;
  try {
    if (!a.type || !VALID_TYPES_SET.has(a.type)) {
      if (logger.warn) logger.warn(`[ZB-outbound-metric] invalid_type=${a.type}`);
      return;
    }
    const parts = [
      '[ZB-outbound-metric]',
      `type=${a.type}`,
      a.userId != null ? `user_id=${a.userId}` : null,
      a.commandType ? `command_type=${a.commandType}` : null,
      a.fieldGroup ? `field_group=${a.fieldGroup}` : null,
      a.eventId ? `event_id=${a.eventId}` : null,
      a.latencyMs != null ? `latency_ms=${a.latencyMs}` : null,
      a.errorClass ? `error_class=${a.errorClass}` : null,
      a.note ? `note=${a.note}` : null,
    ].filter(Boolean);
    const line = parts.join(' ');
    if (a.type === 'dlq' || a.type === 'conflict' || a.type === 'timeout' || a.type === 'invalidated') {
      if (logger.warn) logger.warn(line);
      else if (logger.log) logger.log(line);
    } else {
      if (logger.log) logger.log(line);
    }
  } catch (err) {
    // Observability MUST NOT throw.
    try { if (logger && logger.warn) logger.warn(`[ZB-outbound-metric] emit_failed: ${err && err.message}`); } catch {}
  }
}

// Convenience wrappers — call sites read more naturally.
function emitQueued(args) { return emit({ ...args, type: 'queued' }); }
function emitSent(args) { return emit({ ...args, type: 'sent' }); }
function emitConfirmed(args) { return emit({ ...args, type: 'confirmed' }); }
function emitTimeout(args) { return emit({ ...args, type: 'timeout' }); }
function emitConflict(args) { return emit({ ...args, type: 'conflict' }); }
function emitSuperseded(args) { return emit({ ...args, type: 'superseded' }); }
function emitInvalidated(args) { return emit({ ...args, type: 'invalidated' }); }
function emitDlq(args) { return emit({ ...args, type: 'dlq' }); }
function emitSkippedPrecondition(args) { return emit({ ...args, type: 'skipped_precondition' }); }

module.exports = {
  emit,
  emitQueued,
  emitSent,
  emitConfirmed,
  emitTimeout,
  emitConflict,
  emitSuperseded,
  emitInvalidated,
  emitDlq,
  emitSkippedPrecondition,
  VALID_METRIC_TYPES,
};
