'use strict';

// Attach LB identifiers to an existing SF job (historical lead link).
//
// Called by POST /api/integrations/leadbridge/orchestration/attach-lb-link.
//
// Flow (idempotent, write-once-by-default):
//
//   1. Read the target SF job (must belong to tenant scope).
//   2. If already linked to a DIFFERENT lb_external_request_id and
//      !force_overwrite → return { ok:false, error:'already_linked',
//      existing:{…} } with HTTP 409 mapping.
//   3. Write `lb_link_audit` row (pre-state snapshot).
//   4. UPDATE jobs SET lb_external_request_id, lb_channel,
//      lb_business_id, lb_lead_id (and propagate lb_lead_id to the
//      customer if customer.lb_lead_id is currently NULL).
//   5. Enqueue a synthetic `job.status_changed` event with the job's
//      CURRENT status and a `reconciliation` payload block.
//      Deterministic event_id: `evt_reconcile_{sf_job_id}_{status}`.
//      Outbox UNIQUE(event_id) absorbs replays as no-op.
//
// Hard rules:
//   - tenant-scoped: every read/write filters `user_id = userId`
//   - same-input idempotent: if job is already linked to the SAME
//     lb_external_request_id, returns ok:true with already_linked_same=true
//     and re-enqueues the synthetic event (deterministic event_id collides)
//   - no plaintext PII echoed
//   - audit row is written BEFORE the UPDATE so a crash mid-write
//     leaves a forensic trail

const JOBS_TABLE      = 'jobs';
const CUSTOMERS_TABLE = 'customers';
const AUDIT_TABLE     = 'lb_link_audit';
const OUTBOX_TABLE    = 'leadbridge_outbound_events';

/**
 * Build the deterministic synthetic event_id used for reconciliation
 * status snapshots. Stable across retries; outbox UNIQUE absorbs dup.
 */
function reconcileEventId(sfJobId, status) {
  return `evt_reconcile_${sfJobId}_${String(status || 'unknown').toLowerCase()}`;
}

/**
 * Build the synthetic job.status_changed payload for the attach.
 *
 * Shape mirrors services/lb-outbound-delivery.js buildPayload() with
 * the addition of a `reconciliation` block. We do not import that
 * builder here because it pulls in a uuidv7 dependency and we don't
 * need fresh ids (deterministic).
 */
function buildReconciliationPayload({ job, customer, attachedAt, matchConfidence, matchSignals, lbLeadId, sourceInstance }) {
  const eventId = reconcileEventId(job.id, job.status);
  return {
    event_id:           eventId,
    event_type:         'job.status_changed',
    occurred_at:        attachedAt,
    source:             'service_flow',
    source_instance:    sourceInstance,
    sf_job_id:          String(job.id),
    sf_user_id:         job.user_id,
    external_request_id: job.lb_external_request_id,
    channel:            job.lb_channel,
    lb_lead_id:         lbLeadId || job.lb_lead_id || null,
    status: {
      new:      job.status,
      previous: null,                              // we don't know prior LB status; new-to-LB
    },
    actor: {
      type:         'lb',
      id:           null,
      display_name: 'leadbridge_reconciliation',
    },
    job: {
      scheduled_date:         job.scheduled_date ?? null,
      customer_name:          customer ? [customer.first_name, customer.last_name].filter(Boolean).join(' ') || null : null,
      amount:                 job.invoice_amount != null ? Number(job.invoice_amount)
                              : job.total_amount != null ? Number(job.total_amount)
                              : null,
      payment_status:         job.payment_status ?? null,
      payment_date:           job.payment_date   ?? null,
      customer_phone_last4:   (customer && typeof customer.phone === 'string')
                              ? (customer.phone.replace(/\D+/g,'').slice(-4) || null)
                              : null,
      customer_email_present: !!(customer && customer.email),
    },
    reconciliation: {
      attached_at:       attachedAt,
      match_confidence:  matchConfidence || null,
      match_signals:     Array.isArray(matchSignals) ? matchSignals : [],
    },
    raw: {},
  };
}

/**
 * Attach LB identifiers to an existing SF job.
 *
 * @param {object} supabase
 * @param {object} args
 * @param {number} args.userId
 * @param {object} args.input  - { sf_job_id, lb_external_request_id, lb_channel, lb_business_id, lb_lead_id, match_confidence, match_signals, force_overwrite }
 * @param {string} [args.sourceInstance='sf-prod']  - tag for the synthetic event
 * @param {string} [args.actor='lb']                - audit-table actor:
 *                                                    'lb' (default — LB-initiated attach),
 *                                                    'sf_historical_apply' (SF Phase-2 operator apply),
 *                                                    'sf_user' | 'system' (future)
 * @returns {Promise<{ok, ...}>}
 */
async function attachLbLink(supabase, { userId, input, sourceInstance, actor }) {
  if (!supabase || typeof supabase.from !== 'function') {
    throw new Error('attachLbLink: supabase required');
  }
  if (userId == null) return { ok: false, status: 400, error: 'invalid_arguments', detail: 'userId required' };
  const inp = input || {};
  if (inp.sf_job_id == null)             return { ok: false, status: 400, error: 'invalid_arguments', detail: 'sf_job_id required' };
  if (!inp.lb_external_request_id)        return { ok: false, status: 400, error: 'invalid_arguments', detail: 'lb_external_request_id required' };
  if (!inp.lb_channel)                    return { ok: false, status: 400, error: 'invalid_arguments', detail: 'lb_channel required' };

  const srcInstance = sourceInstance || process.env.SF_SOURCE_INSTANCE || process.env.SF_INSTANCE || 'sf-prod';
  const force = inp.force_overwrite === true;

  // 1. Read job (tenant-scoped). Use only the columns we need.
  const { data: job, error: jobErr } = await supabase.from(JOBS_TABLE)
    .select('id, user_id, customer_id, status, payment_status, payment_date, scheduled_date, total_amount, invoice_amount, lb_external_request_id, lb_channel, lb_business_id, lb_lead_id, last_status_changed_at')
    .eq('id', inp.sf_job_id)
    .eq('user_id', userId)
    .maybeSingle();

  if (jobErr) return { ok: false, status: 503, error: 'db_error', detail: jobErr.message };
  if (!job)   return { ok: false, status: 404, error: 'job_not_found' };

  // 2. Conflict check
  const sameLink = job.lb_external_request_id === inp.lb_external_request_id;
  if (job.lb_external_request_id && !sameLink && !force) {
    return {
      ok: false,
      status: 409,
      error: 'already_linked',
      existing: {
        lb_external_request_id: job.lb_external_request_id,
        lb_channel:             job.lb_channel,
        lb_business_id:         job.lb_business_id || null,
        lb_lead_id:             job.lb_lead_id     || null,
      },
    };
  }

  const action = job.lb_external_request_id == null ? 'attach' : (sameLink ? 'reattach_same' : 'overwrite');
  const previousState = {
    lb_external_request_id: job.lb_external_request_id || null,
    lb_channel:             job.lb_channel             || null,
    lb_business_id:         job.lb_business_id         || null,
    lb_lead_id:             job.lb_lead_id             || null,
  };

  // 3. Audit row FIRST (best-effort, but if it succeeds we know the
  //    intent. If the UPDATE below crashes, the audit row is forensic.)
  const auditRow = {
    user_id:        userId,
    actor:          (typeof actor === 'string' && actor.length > 0) ? actor : 'lb',
    action,
    sf_job_id:      job.id,
    sf_customer_id: job.customer_id,
    lb_external_request_id: inp.lb_external_request_id,
    lb_lead_id:     inp.lb_lead_id     || null,
    lb_channel:     inp.lb_channel,
    lb_business_id: inp.lb_business_id || null,
    match_confidence: inp.match_confidence || null,
    match_signals:    Array.isArray(inp.match_signals) ? inp.match_signals : null,
    previous_state:   previousState,
  };
  const { error: auditErr } = await supabase.from(AUDIT_TABLE).insert(auditRow);
  if (auditErr) {
    return { ok: false, status: 503, error: 'audit_write_failed', detail: auditErr.message };
  }

  // 4. UPDATE the jobs row (single statement, tenant-scoped re-check).
  //
  // Original logic skipped this on `reattach_same` as a no-op
  // optimisation. The bug surfaced in prod Batch #1: when LB sets
  // jobs.lb_external_request_id via the regular webhook flow but
  // jobs.lb_lead_id was never populated, the attach landed in
  // `reattach_same` (same external_request_id) → UPDATE skipped →
  // lb_lead_id remained NULL even though the audit row claimed an
  // attach. Fix: still skip the UPDATE for pure no-ops, but run it
  // when any of the four linkage fields is missing on the SF side.
  const needsUpdate = action !== 'reattach_same'
    || (inp.lb_lead_id     && !job.lb_lead_id)
    || (inp.lb_business_id && !job.lb_business_id)
    || (inp.lb_channel     && job.lb_channel !== inp.lb_channel);
  if (needsUpdate) {
    const update = {
      lb_external_request_id: inp.lb_external_request_id,
      lb_channel:             inp.lb_channel,
      lb_business_id:         inp.lb_business_id || job.lb_business_id || null,
      lb_lead_id:             inp.lb_lead_id     || job.lb_lead_id     || null,
    };
    const { error: updErr } = await supabase.from(JOBS_TABLE)
      .update(update)
      .eq('id', job.id)
      .eq('user_id', userId);
    if (updErr) return { ok: false, status: 503, error: 'db_error', detail: updErr.message };
  }

  // 5. Propagate lb_lead_id to the customer if currently NULL.
  let customer = null;
  if (job.customer_id) {
    const { data: c } = await supabase.from(CUSTOMERS_TABLE)
      .select('id, user_id, first_name, last_name, email, phone, lb_lead_id')
      .eq('id', job.customer_id)
      .eq('user_id', userId)
      .maybeSingle();
    customer = c || null;
    if (customer && !customer.lb_lead_id && inp.lb_lead_id) {
      await supabase.from(CUSTOMERS_TABLE)
        .update({ lb_lead_id: inp.lb_lead_id })
        .eq('id', customer.id)
        .eq('user_id', userId);
      customer.lb_lead_id = inp.lb_lead_id;
    }
  }

  // 6. Build synthetic status event.
  const updatedJob = {
    ...job,
    lb_external_request_id: inp.lb_external_request_id,
    lb_channel:             inp.lb_channel,
    lb_business_id:         inp.lb_business_id || job.lb_business_id || null,
    lb_lead_id:             inp.lb_lead_id     || job.lb_lead_id     || null,
  };
  const attachedAt = new Date().toISOString();
  const payload = buildReconciliationPayload({
    job: updatedJob,
    customer,
    attachedAt,
    matchConfidence: inp.match_confidence,
    matchSignals:    inp.match_signals,
    lbLeadId:        inp.lb_lead_id,
    sourceInstance:  srcInstance,
  });

  // 7. Enqueue (deterministic event_id; UNIQUE absorbs replays).
  let eventEnqueued = true;
  let eventDuplicate = false;
  try {
    const outboxRow = {
      event_id:        payload.event_id,
      user_id:         userId,
      sf_job_id:       String(job.id),
      event_type:      payload.event_type,
      payload_json:    payload,
      state:           'pending',
      attempts:        0,
      next_attempt_at: new Date().toISOString(),
    };
    const { error: insErr } = await supabase.from(OUTBOX_TABLE).insert(outboxRow);
    if (insErr) {
      if (insErr.code === '23505') {
        eventEnqueued = false;
        eventDuplicate = true;          // already enqueued in a prior attach attempt
      } else {
        // Don't fail the attach for outbox issues — the link is persisted.
        eventEnqueued = false;
      }
    }
  } catch (_) {
    eventEnqueued = false;
  }

  return {
    ok: true,
    sf_job_id:                       job.id,
    previous_lb_external_request_id: previousState.lb_external_request_id,
    new_lb_external_request_id:      inp.lb_external_request_id,
    new_lb_lead_id:                  inp.lb_lead_id || null,
    new_lb_channel:                  inp.lb_channel,
    new_lb_business_id:              inp.lb_business_id || job.lb_business_id || null,
    action,                           // 'attach' | 'overwrite' | 'reattach_same'
    synthetic_status_event_id:       payload.event_id,
    synthetic_status_event_enqueued: eventEnqueued,
    synthetic_status_event_duplicate: eventDuplicate,
    customer_lb_lead_id_propagated:  !!(customer && customer.lb_lead_id === (inp.lb_lead_id || null)),
  };
}

module.exports = {
  attachLbLink,
  // exposed for tests
  reconcileEventId,
  buildReconciliationPayload,
};
