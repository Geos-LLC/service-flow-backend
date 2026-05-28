'use strict';

// LB orchestration — availability lookup (Phase 2B).
//
// Returns candidate time slots within a requested window for a given
// service, signed with slot_tokens that the booking-request handler
// will verify. The conflict check is intentionally conservative:
//
//   1. Compute candidate slots inside [requested_at - window/2,
//      requested_at + window/2], snapped to 30-minute boundaries.
//   2. For each candidate, query active SF jobs that would overlap
//      and skip slots that have a same-tenant job in that interval.
//   3. Sign each surviving slot with a slot_token (10-min validity).
//
// This is NOT a full scheduling engine. It's a minimum-correct
// availability check — the production scheduling engine (territories,
// team capacity, travel time, etc.) is a Phase 2D upgrade. Today this
// enforces "no double-booking on a tenant-wide basis," which is the
// invariant that matters for Phase 2C canary safety.

const { signSlotToken } = require('./lb-orchestration-token');

const SLOT_STEP_MINUTES = 30;
const DEFAULT_DURATION_MINUTES = 180;
const DEFAULT_WINDOW_MINUTES = 240;

function isoToMs(iso) {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) throw new Error(`invalid timestamp: ${iso}`);
  return t;
}
function msToIso(ms) {
  return new Date(Math.round(ms / 1000) * 1000).toISOString();
}

function snapToStep(ms, stepMs) {
  return Math.floor(ms / stepMs) * stepMs;
}

/**
 * Fetch SF jobs that overlap the search window for the tenant. Used to
 * eliminate candidate slots that conflict with already-scheduled work.
 */
async function fetchOverlappingJobs(supabase, userId, windowStartMs, windowEndMs) {
  // Conservative: pull any non-cancelled job in the window. Cancelled
  // jobs don't block new bookings.
  //
  // IMPORTANT: only enum values from the actual job_status enum can
  // appear in this IN list — Postgres rejects unknown labels with
  // "invalid input value for enum job_status" during the cast.
  // The job_status enum is:
  //   pending, confirmed, in-progress, completed, cancelled, scheduled,
  //   en-route, started, complete, late, rescheduled, paid
  // Variants like 'canceled' (American spelling), 'no-show', 'archived',
  // 'lost' DO NOT exist in this enum — including them in the IN list
  // causes the query to fail. Only 'cancelled' (British spelling) is
  // the actual terminal-state value.
  const startIso = msToIso(windowStartMs - 4 * 60 * 60 * 1000); // pad 4h for long-running services
  const endIso   = msToIso(windowEndMs   + 4 * 60 * 60 * 1000);
  const { data, error } = await supabase
    .from('jobs')
    .select('id, scheduled_date, end_time, status, duration')
    .eq('user_id', userId)
    .gte('scheduled_date', startIso)
    .lte('scheduled_date', endIso)
    .neq('status', 'cancelled');
  if (error) throw new Error(`fetchOverlappingJobs failed: ${error.message}`);
  return data || [];
}

function intervalsOverlap(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

/**
 * Compute candidate slots for an availability request.
 *
 * @param {object} supabase
 * @param {object} args
 * @param {number} args.userId
 * @param {number|string} args.service_id
 * @param {number} [args.duration_minutes=180]
 * @param {string} args.requested_at_iso
 * @param {number} [args.window_minutes=240]
 * @param {object} [args.logger]
 * @returns {Promise<{ candidate_slots: Array, search_window: object }>}
 */
async function findAvailableSlots(supabase, args) {
  const duration = Math.max(30, Number(args.duration_minutes || DEFAULT_DURATION_MINUTES));
  const windowMin = Math.max(60, Number(args.window_minutes || DEFAULT_WINDOW_MINUTES));
  const requestedMs = isoToMs(args.requested_at_iso);
  const windowHalfMs = (windowMin * 60 * 1000) / 2;
  const windowStartMs = requestedMs - windowHalfMs;
  const windowEndMs   = requestedMs + windowHalfMs;
  const stepMs = SLOT_STEP_MINUTES * 60 * 1000;
  const durationMs = duration * 60 * 1000;

  const overlapping = await fetchOverlappingJobs(supabase, args.userId, windowStartMs, windowEndMs);
  const blockingIntervals = overlapping
    .map(j => {
      const s = isoToMs(j.scheduled_date);
      const e = j.end_time ? isoToMs(j.end_time)
                : s + ((Number(j.duration) || duration) * 60 * 1000);
      return { start: s, end: e };
    })
    .filter(i => Number.isFinite(i.start) && Number.isFinite(i.end));

  const candidates = [];
  // Generate slots from window start to window end - duration, stepped.
  for (let t = snapToStep(windowStartMs, stepMs); t <= windowEndMs - durationMs; t += stepMs) {
    const slotStart = t;
    const slotEnd = t + durationMs;
    const conflict = blockingIntervals.some(b =>
      intervalsOverlap(slotStart, slotEnd, b.start, b.end));
    if (conflict) continue;
    candidates.push({
      start: msToIso(slotStart),
      end: msToIso(slotEnd),
      // Lightweight confidence: closer to requested_at = higher.
      confidence: Math.abs(slotStart - requestedMs) <= 60 * 60 * 1000 ? 'high'
                : Math.abs(slotStart - requestedMs) <= 3 * 60 * 60 * 1000 ? 'medium' : 'low',
      capacity: 1,
      slot_token: signSlotToken({
        tenant_id: args.userId,
        service_id: args.service_id ?? null,
        start_iso: msToIso(slotStart),
        end_iso: msToIso(slotEnd),
      }),
    });
    if (candidates.length >= 8) break; // cap response size
  }

  return {
    candidate_slots: candidates,
    search_window: {
      start: msToIso(windowStartMs),
      end: msToIso(windowEndMs),
    },
    duration_minutes: duration,
  };
}

module.exports = {
  findAvailableSlots,
  // exported for tests
  _intervalsOverlap: intervalsOverlap,
  _snapToStep: snapToStep,
};
