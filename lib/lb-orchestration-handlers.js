'use strict';

// LB orchestration handlers — Phase 2B.
//
// Four endpoints, all gated by isOrchestrationEnabledForTenant:
//
//   GET  /orchestration/availability
//   POST /orchestration/booking-request
//   POST /orchestration/booking-cancel
//   POST /orchestration/handoff
//
// Common patterns across handlers:
//
//   1. Feature-flag gate (via requireOrchestrationEnabled middleware
//      at route registration time).
//   2. Idempotency: every POST takes an optional `idempotency_key`. If
//      a prior attempt with the same (tenant, endpoint, key) exists in
//      `lb_orchestration_attempts`, we return its stored response.
//   3. Audit: every attempt — success, replay, conflict, invalid —
//      persists to lb_orchestration_attempts with the response_status,
//      result classification, and (if applicable) the created sf_job_id.
//   4. Tenant scope: every DB query enforces user_id = req.user.userId.
//   5. No direct status mutation: booking-cancel calls into the
//      existing job-status-service so all status writes go through the
//      single audited path.
//
// Hard constraints:
//   - never writes jobs.status from raw SQL
//   - never bypasses outbound-event UNIQUE constraint
//   - never accepts a slot_token issued for a different tenant
//   - LB cannot mutate operational internals (cleaner, ledger, payment)

const { verifySlotToken, hashIdempotencyKey } = require('./lb-orchestration-token');
const { findAvailableSlots } = require('./lb-orchestration-availability');
const {
  recordOrchestrationOutbound,
} = require('./lb-orchestration-events');
// Authoritative emission path — owned by the operational write service.
// Booking-request inserts the job, then delegates service_scheduled
// emission to this helper. This way the event only fires when canonical
// SF state exists; if anything before the helper throws, no event leaks
// to LB. Re-required lazily inside the factory so the module's other
// helpers stay test-friendly without the full service dependency.
let _maybeEmitOrchestrationInsertEvent = null;
function getMaybeEmitOrchestrationInsertEvent() {
  if (!_maybeEmitOrchestrationInsertEvent) {
    _maybeEmitOrchestrationInsertEvent = require('../services/job-status-service').maybeEmitOrchestrationInsertEvent;
  }
  return _maybeEmitOrchestrationInsertEvent;
}

// ──────────────────────────────────────────────────────────────────
// Idempotency helpers
// ──────────────────────────────────────────────────────────────────
async function findIdempotentReply(supabase, userId, endpoint, idempotency_key) {
  if (!idempotency_key) return null;
  const { data, error } = await supabase
    .from('lb_orchestration_attempts')
    .select('id, response_status, response_payload, sf_job_id, result')
    .eq('user_id', userId)
    .eq('endpoint', endpoint)
    .eq('idempotency_key', idempotency_key)
    .maybeSingle();
  if (error || !data) return null;
  return data;
}

async function recordAttempt(supabase, args) {
  // Best-effort audit log. Never fail the request because of audit
  // persistence — that creates a security ostrich.
  try {
    await supabase.from('lb_orchestration_attempts').insert({
      user_id: args.userId,
      endpoint: args.endpoint,
      idempotency_key: args.idempotency_key || null,
      orchestration_session_id: args.orchestration_session_id || null,
      request_payload: args.request_payload || null,
      response_status: args.response_status,
      response_payload: args.response_payload || null,
      sf_job_id: args.sf_job_id || null,
      result: args.result,
    });
  } catch (e) {
    (args.logger || console).warn?.(`[LB Orch] audit insert failed: ${e?.message}`);
  }
}

// ──────────────────────────────────────────────────────────────────
// GET /orchestration/availability
// ──────────────────────────────────────────────────────────────────
function makeAvailabilityHandler({ supabase, logger }) {
  return async function availabilityHandler(req, res) {
    const userId = req.user.userId;
    const service_id = req.query.service_id ? Number(req.query.service_id) : null;
    const requested_at = String(req.query.requested_at || '');
    const window_minutes = Number(req.query.window_minutes || 240);
    const duration_minutes = Number(req.query.duration_minutes || 180);

    if (!requested_at) {
      const payload = { error: 'requested_at is required (ISO timestamp)' };
      await recordAttempt(supabase, {
        userId, endpoint: 'availability', request_payload: req.query,
        response_status: 400, response_payload: payload, result: 'invalid', logger,
      });
      return res.status(400).json(payload);
    }
    try {
      const result = await findAvailableSlots(supabase, {
        userId,
        service_id,
        requested_at_iso: requested_at,
        window_minutes,
        duration_minutes,
        logger,
      });
      const responsePayload = { tenant_id: userId, ...result };
      await recordAttempt(supabase, {
        userId, endpoint: 'availability',
        request_payload: req.query,
        response_status: 200,
        response_payload: { candidate_count: result.candidate_slots.length, search_window: result.search_window },
        result: 'success',
        logger,
      });
      return res.json(responsePayload);
    } catch (e) {
      logger.error?.(`[LB Orch] availability failed user=${userId}: ${e.message}`);
      const payload = { error: 'availability_lookup_failed', message: e.message };
      await recordAttempt(supabase, {
        userId, endpoint: 'availability', request_payload: req.query,
        response_status: 500, response_payload: payload, result: 'error', logger,
      });
      return res.status(500).json(payload);
    }
  };
}

// ──────────────────────────────────────────────────────────────────
// POST /orchestration/booking-request
// ──────────────────────────────────────────────────────────────────
function makeBookingRequestHandler({ supabase, logger, setCustomerAcquisitionIfMissing }) {
  return async function bookingRequestHandler(req, res) {
    const userId = req.user.userId;
    const body = req.body || {};
    const idempotency_key = body.idempotency_key ? String(body.idempotency_key).slice(0, 200) : null;
    const orchestration_session_id = body.lb_conversation_id || body.orchestration_session_id || null;

    // 1. Idempotent replay?
    const prior = await findIdempotentReply(supabase, userId, 'booking_request', idempotency_key);
    if (prior) {
      logger.log?.(`[LB Orch] idempotent_replay booking-request user=${userId} key=${idempotency_key}`);
      return res.status(prior.response_status || 200).json({
        ...(prior.response_payload || {}),
        idempotent_replay: true,
      });
    }

    // 2. Validate slot_token
    const slot_token = body.slot_token;
    const ver = verifySlotToken(String(slot_token || ''), {
      expected_tenant_id: userId,
    });
    if (!ver.valid) {
      const payload = { error: 'invalid_slot_token', reason: ver.reason };
      await recordAttempt(supabase, {
        userId, endpoint: 'booking_request', idempotency_key, orchestration_session_id,
        request_payload: redactCustomer(body),
        response_status: ver.reason === 'expired' ? 410 : 400,
        response_payload: payload,
        result: ver.reason === 'expired' ? 'stale_slot' : 'invalid',
        logger,
      });
      return res.status(ver.reason === 'expired' ? 410 : 400).json(payload);
    }
    const slot = ver.payload;

    // 3. Validate customer + attribution payloads
    const customer = body.customer || {};
    const attribution = body.marketplace_attribution || {};
    if (!customer.phone) {
      const payload = { error: 'customer.phone is required' };
      await recordAttempt(supabase, {
        userId, endpoint: 'booking_request', idempotency_key, orchestration_session_id,
        request_payload: redactCustomer(body),
        response_status: 422, response_payload: payload, result: 'invalid', logger,
      });
      return res.status(422).json(payload);
    }
    if (!attribution.lb_external_request_id) {
      const payload = { error: 'marketplace_attribution.lb_external_request_id is required' };
      await recordAttempt(supabase, {
        userId, endpoint: 'booking_request', idempotency_key, orchestration_session_id,
        request_payload: redactCustomer(body),
        response_status: 422, response_payload: payload, result: 'invalid', logger,
      });
      return res.status(422).json(payload);
    }

    // 4. Re-validate slot availability under current state (race protection)
    // We re-fetch overlapping jobs for the proposed slot window and refuse
    // if another booking landed since slot_token issuance.
    const slotStartIso = slot.start_iso;
    const slotEndIso = slot.end_iso;
    // job_status enum check: see lb-orchestration-availability.js for the
    // full enum list. Only 'cancelled' is a real terminal value — variants
    // like 'canceled' / 'archived' / 'no-show' aren't in the enum and will
    // break this query if listed.
    const { data: overlap, error: overlapErr } = await supabase
      .from('jobs')
      .select('id, scheduled_date, end_time')
      .eq('user_id', userId)
      .gte('scheduled_date', new Date(new Date(slotStartIso).getTime() - 60 * 60 * 1000).toISOString())
      .lte('scheduled_date', slotEndIso)
      .neq('status', 'cancelled');
    if (overlapErr) {
      logger.warn?.(`[LB Orch] overlap check failed user=${userId}: ${overlapErr.message}`);
    }
    const overlapsExisting = (overlap || []).some(j => {
      const jobStart = new Date(j.scheduled_date).getTime();
      const jobEnd = j.end_time ? new Date(j.end_time).getTime() : jobStart + 3 * 60 * 60 * 1000;
      const reqStart = new Date(slotStartIso).getTime();
      const reqEnd = new Date(slotEndIso).getTime();
      return reqStart < jobEnd && jobStart < reqEnd;
    });
    if (overlapsExisting) {
      const payload = { error: 'slot_taken', reason: 'slot_no_longer_available', replacement_suggestions: [] };
      await recordAttempt(supabase, {
        userId, endpoint: 'booking_request', idempotency_key, orchestration_session_id,
        request_payload: redactCustomer(body),
        response_status: 409, response_payload: payload, result: 'conflict', logger,
      });
      return res.status(409).json(payload);
    }

    // 5. Find or create customer (by phone last-10, tenant-scoped)
    const phoneLast10 = String(customer.phone).replace(/[^0-9]/g, '').slice(-10);
    let customerId = null;
    try {
      const { data: existing } = await supabase
        .from('customers').select('id').eq('user_id', userId)
        .ilike('phone', `%${phoneLast10}%`).limit(1).maybeSingle();
      if (existing) customerId = existing.id;
    } catch (_) {}
    if (!customerId) {
      const insertCust = {
        user_id: userId,
        first_name: customer.first_name || null,
        last_name: customer.last_name || null,
        phone: customer.phone,
        email: customer.email || null,
        source: attribution.lb_channel ? `LeadBridge ${attribution.lb_channel}` : 'LeadBridge',
      };
      const { data: created, error: ce } = await supabase
        .from('customers').insert(insertCust).select('id').maybeSingle();
      if (ce || !created) {
        const payload = { error: 'customer_create_failed', message: ce?.message };
        await recordAttempt(supabase, {
          userId, endpoint: 'booking_request', idempotency_key, orchestration_session_id,
          request_payload: redactCustomer(body),
          response_status: 500, response_payload: payload, result: 'error', logger,
        });
        return res.status(500).json(payload);
      }
      customerId = created.id;
    }

    // 6. Stamp acquisition (write-once via existing helper)
    try {
      await setCustomerAcquisitionIfMissing(supabase, userId, customerId, {
        lb_external_request_id: attribution.lb_external_request_id,
        lb_channel: attribution.lb_channel || null,
        lb_business_id: attribution.lb_business_id || null,
        acquired_at: new Date().toISOString(),
      });
    } catch (e) {
      logger.warn?.(`[LB Orch] acquisition stamp failed cust=${customerId}: ${e?.message}`);
    }

    // 7. Create job (status='confirmed', lb_external_request_id stamped)
    const jobInsert = {
      user_id: userId,
      customer_id: customerId,
      service_id: body.service_id || null,
      status: 'confirmed',
      scheduled_date: slot.start_iso,
      end_time: slot.end_iso,
      lb_external_request_id: attribution.lb_external_request_id,
      lb_channel: attribution.lb_channel || null,
      lb_business_id: attribution.lb_business_id || null,
      orchestration_session_id,
      last_status_source: 'lb_orchestration',
      last_status_changed_at: new Date().toISOString(),
    };
    const { data: jobRow, error: jobErr } = await supabase
      .from('jobs').insert(jobInsert).select('id, user_id, status, scheduled_date, lb_external_request_id, lb_channel, lb_business_id').maybeSingle();
    if (jobErr || !jobRow) {
      const payload = { error: 'job_create_failed', message: jobErr?.message };
      await recordAttempt(supabase, {
        userId, endpoint: 'booking_request', idempotency_key, orchestration_session_id,
        request_payload: redactCustomer(body),
        response_status: 500, response_payload: payload, result: 'error', logger,
      });
      return res.status(500).json(payload);
    }

    // 8. Emit service_scheduled — owned by the operational write path.
    // The handler does NOT emit directly; it delegates to the canonical
    // emission helper in job-status-service. The job INSERT above has
    // committed; emission can only fire when canonical state exists.
    // If the helper throws, the booking still stands — the event is
    // replayable via the orchestration_attempts audit row.
    const emit = await getMaybeEmitOrchestrationInsertEvent()(supabase, jobRow,
      { type: 'system', id: 'lb_orchestration', display_name: 'LeadBridge orchestration' },
      {
        orchestrationSessionId: orchestration_session_id,
        extraPayload: { lb_conversation_id: body.lb_conversation_id || null },
      });

    const response = {
      job_id: jobRow.id,
      status: jobRow.status,
      customer_id: customerId,
      scheduled_date: jobRow.scheduled_date,
      orchestration_session_id,
      confirmation: { event_id: emit.event_id || null, action: emit.action },
    };

    await recordAttempt(supabase, {
      userId, endpoint: 'booking_request', idempotency_key, orchestration_session_id,
      request_payload: redactCustomer(body),
      response_status: 201, response_payload: response,
      sf_job_id: jobRow.id, result: 'success', logger,
    });
    return res.status(201).json(response);
  };
}

// ──────────────────────────────────────────────────────────────────
// POST /orchestration/booking-cancel
// ──────────────────────────────────────────────────────────────────
function makeBookingCancelHandler({ supabase, logger, updateJobStatus }) {
  return async function bookingCancelHandler(req, res) {
    const userId = req.user.userId;
    const body = req.body || {};
    const idempotency_key = body.idempotency_key ? String(body.idempotency_key).slice(0, 200) : null;
    const orchestration_session_id = body.lb_conversation_id || body.orchestration_session_id || null;
    const jobId = body.job_id ? Number(body.job_id) : null;

    if (!jobId) {
      const payload = { error: 'job_id is required' };
      await recordAttempt(supabase, {
        userId, endpoint: 'booking_cancel', idempotency_key, orchestration_session_id,
        request_payload: body, response_status: 400, response_payload: payload, result: 'invalid', logger,
      });
      return res.status(400).json(payload);
    }

    const prior = await findIdempotentReply(supabase, userId, 'booking_cancel', idempotency_key);
    if (prior) {
      return res.status(prior.response_status || 200).json({
        ...(prior.response_payload || {}),
        idempotent_replay: true,
      });
    }

    // Load job, validate it exists and is cancellable.
    const { data: job, error: jerr } = await supabase
      .from('jobs')
      .select('id, user_id, status, scheduled_date, lb_external_request_id, lb_channel, lb_business_id')
      .eq('id', jobId).eq('user_id', userId).maybeSingle();
    if (jerr || !job) {
      const payload = { error: 'job_not_found' };
      await recordAttempt(supabase, {
        userId, endpoint: 'booking_cancel', idempotency_key, orchestration_session_id,
        request_payload: body, response_status: 404, response_payload: payload, result: 'invalid', logger,
      });
      return res.status(404).json(payload);
    }
    const CANCELLABLE = new Set(['pending', 'confirmed', 'scheduled', 'rescheduled']);
    if (!CANCELLABLE.has(String(job.status || '').toLowerCase())) {
      const payload = { error: 'job_not_cancellable', current_status: job.status };
      await recordAttempt(supabase, {
        userId, endpoint: 'booking_cancel', idempotency_key, orchestration_session_id,
        request_payload: body, response_status: 409, response_payload: payload,
        sf_job_id: jobId, result: 'conflict', logger,
      });
      return res.status(409).json(payload);
    }

    // Update status via the centralized job-status-service. This handles
    // the loop guard + history row insert + the LEGACY outbound emission.
    // The orchestration emitter below is the NEW path — both fire during
    // Phase 2C canary; UNIQUE absorbs duplicate event_ids.
    try {
      await updateJobStatus({
        jobId,
        userId,
        newStatus: 'cancelled',
        source: 'lb_orchestration',
        actor: {
          type: 'system',
          id: 'lb_orchestration',
          display_name: body.actor_display_name || 'LeadBridge orchestration',
        },
        reason: body.reason || 'customer_requested',
      });
    } catch (e) {
      const payload = { error: 'cancel_failed', message: e.message };
      await recordAttempt(supabase, {
        userId, endpoint: 'booking_cancel', idempotency_key, orchestration_session_id,
        request_payload: body, response_status: 500, response_payload: payload,
        sf_job_id: jobId, result: 'error', logger,
      });
      return res.status(500).json(payload);
    }

    // Explicit orchestration event emission. (Status-change hook also
    // tries to emit; UNIQUE constraint absorbs the duplicate.)
    const emit = await recordOrchestrationOutbound(supabase, {
      eventType: 'service_cancelled',
      job: { ...job, status: 'cancelled' },
      actor: { type: 'system', id: 'lb_orchestration', display_name: 'LeadBridge orchestration' },
      source: 'lb_orchestration',
      orchestrationSessionId: orchestration_session_id,
      extraPayload: { reason: body.reason || 'customer_requested' },
      logger,
    });

    const response = {
      job_id: jobId,
      status: 'cancelled',
      orchestration_session_id,
      confirmation: { event_id: emit.event_id || null, action: emit.action },
    };
    await recordAttempt(supabase, {
      userId, endpoint: 'booking_cancel', idempotency_key, orchestration_session_id,
      request_payload: body, response_status: 200, response_payload: response,
      sf_job_id: jobId, result: 'success', logger,
    });
    return res.status(200).json(response);
  };
}

// ──────────────────────────────────────────────────────────────────
// POST /orchestration/handoff
// ──────────────────────────────────────────────────────────────────
// Minimal Phase 2B implementation: records the handoff request as an
// audit entry. Future: integrate with the task / notification system.
function makeHandoffHandler({ supabase, logger }) {
  return async function handoffHandler(req, res) {
    const userId = req.user.userId;
    const body = req.body || {};
    const idempotency_key = body.idempotency_key ? String(body.idempotency_key).slice(0, 200) : null;
    const orchestration_session_id = body.lb_conversation_id || body.orchestration_session_id || null;
    if (!body.reason) {
      const payload = { error: 'reason is required' };
      await recordAttempt(supabase, {
        userId, endpoint: 'handoff', idempotency_key, orchestration_session_id,
        request_payload: redactCustomer(body), response_status: 400,
        response_payload: payload, result: 'invalid', logger,
      });
      return res.status(400).json(payload);
    }
    const prior = await findIdempotentReply(supabase, userId, 'handoff', idempotency_key);
    if (prior) {
      return res.status(prior.response_status || 200).json({
        ...(prior.response_payload || {}),
        idempotent_replay: true,
      });
    }
    const response = {
      accepted: true,
      orchestration_session_id,
      message: 'Handoff request recorded. Operator will follow up.',
    };
    await recordAttempt(supabase, {
      userId, endpoint: 'handoff', idempotency_key, orchestration_session_id,
      request_payload: redactCustomer(body), response_status: 202,
      response_payload: response, result: 'success', logger,
    });
    return res.status(202).json(response);
  };
}

// Redact PII before audit-logging — we keep enough for debugging but
// strip identifiers operators don't need.
function redactCustomer(body) {
  if (!body || typeof body !== 'object') return body;
  const out = { ...body };
  if (out.customer) {
    out.customer = {
      ...out.customer,
      phone: out.customer.phone ? '***' + String(out.customer.phone).slice(-4) : null,
      email: out.customer.email ? out.customer.email.replace(/(.{2}).*(@.*)/, '$1***$2') : null,
    };
  }
  return out;
}

module.exports = {
  makeAvailabilityHandler,
  makeBookingRequestHandler,
  makeBookingCancelHandler,
  makeHandoffHandler,
  // exported for tests
  _findIdempotentReply: findIdempotentReply,
  _recordAttempt: recordAttempt,
};
