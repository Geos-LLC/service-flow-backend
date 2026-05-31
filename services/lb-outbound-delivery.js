/**
 * LeadBridge outbound delivery — payload builder, outbox insert, HMAC signer.
 *
 * This is an internal module. It is NOT a separate integration — the
 * outbox is the durability layer of the existing LeadBridge
 * integration. Callers are `job-status-service.js` (on status change)
 * and `maybeEmitInsertEvent` (on LB-linked job creation).
 *
 * Design invariants:
 *   - payload is built once and frozen in `payload_json`
 *   - `event_id` is stable across retries (LB uses it as idempotency key)
 *   - the signer regenerates X-SF-Signature per attempt (time-bound)
 *   - no plaintext secret ever appears in logs
 */

const crypto = require('crypto')
const { isOutboundAllowed, normalizeStatus } = require('./lb-outbound-status-map')
const { decryptIntegrationSecret } = require('./lb-encryption')
const { recordOutboundSkippedNotLinked } = require('../lib/lb-linkage-metrics')

const SF_INSTANCE = process.env.SF_INSTANCE || 'sf-prod'
const OUTBOUND_ENABLED = () => String(process.env.LEADBRIDGE_OUTBOUND_STATUS_ENABLED || 'false').toLowerCase() === 'true'
const OUTBOUND_DRY_RUN = () => String(process.env.LEADBRIDGE_OUTBOUND_DRY_RUN || 'true').toLowerCase() === 'true'

// UUID v7 using system clock ms. Keeps events sortable by creation
// time so the drainer's ORDER BY is stable even if two events are
// inserted in the same millisecond.
function uuidv7() {
  const timeMs = Date.now()
  const timeHex = timeMs.toString(16).padStart(12, '0')
  const rand = crypto.randomBytes(10)
  // Set version (7) and variant (10xx) bits per RFC 9562
  rand[0] = (rand[0] & 0x0f) | 0x70
  rand[2] = (rand[2] & 0x3f) | 0x80
  const hex =
    timeHex.slice(0, 8) + '-' +
    timeHex.slice(8, 12) + '-' +
    rand.slice(0, 2).toString('hex') + '-' +
    rand.slice(2, 4).toString('hex') + '-' +
    rand.slice(4, 10).toString('hex')
  return hex
}

function buildPayload({ job, oldStatus, newStatus, actor, eventIdOverride }) {
  // eventIdOverride lets reconcile-sourced events use a deterministic id
  // like `evt_reconcile_<job>_<canonical>` so a repeat sync collides on
  // the outbox UNIQUE(event_id) and is treated as duplicate / no-op.
  // Status-change-triggered events leave it unset → fresh uuidv7.
  //
  // Fields added by migration 060 (LB historical lead link):
  //   - lb_lead_id                — LB's own UUID, propagated from the
  //                                  jobs row when present
  //   - job.payment_status / .payment_date — gives LB the
  //                                          completion-and-paid signal
  //                                          retroactive attaches need
  //   - job.customer_phone_last4 / .customer_email_present —
  //                                          de-identified verifiers LB
  //                                          can use to confirm the
  //                                          attach landed on the right
  //                                          row, without echoing PII
  const customerPhoneLast4 = (typeof job.customer_phone === 'string')
    ? (job.customer_phone.replace(/\D+/g, '').slice(-4) || null)
    : null
  const customerEmailPresent = !!(typeof job.customer_email === 'string' && job.customer_email.length > 0)

  // Phase-3: sf_managed flag.
  //
  // True iff the job carries an LB linkage (lb_external_request_id +
  // lb_channel). Per the historical-sync product spec: once a lead is
  // linked, LB UI must block manual status edits and SF is the source
  // of truth. This boolean lets LB sanity-check incoming events against
  // its sf_managed flag on the lb_lead row.
  //
  // Always present on the payload (true | false), never omitted — that
  // way LB can assert on shape, not on field presence.
  const isLbLinked = !!(job.lb_external_request_id && job.lb_channel)

  return {
    event_id: eventIdOverride || `evt_${uuidv7()}`,
    event_type: 'job.status_changed',
    occurred_at: new Date().toISOString(),
    source: 'service_flow',
    source_instance: SF_INSTANCE,
    sf_job_id: String(job.id),
    sf_user_id: job.user_id,
    external_request_id: job.lb_external_request_id,
    channel: job.lb_channel,
    lb_lead_id: job.lb_lead_id ?? null,
    sf_managed: isLbLinked,
    status: {
      new: normalizeStatus(newStatus),
      previous: oldStatus == null ? null : normalizeStatus(oldStatus),
    },
    actor: {
      type: actor?.type || 'system',
      // LB's LeadStatusAuditLog.actorId is String — coerce numeric SF
      // user/team_member ids to string so Prisma validation passes.
      id: actor?.id == null ? null : String(actor.id),
      display_name: actor?.display_name ?? null,
    },
    job: {
      scheduled_date: job.scheduled_date ?? null,
      customer_name: job.customer_name ?? null,
      amount: job.invoice_amount != null ? Number(job.invoice_amount) : (job.total_amount != null ? Number(job.total_amount) : null),
      payment_status: job.payment_status ?? null,
      payment_date: job.payment_date ?? null,
      customer_phone_last4: customerPhoneLast4,
      customer_email_present: customerEmailPresent,
    },
    raw: {},
  }
}

function signRequest(secret, rawBody, timestamp) {
  const msg = `${timestamp}.${rawBody}`
  const hmac = crypto.createHmac('sha256', secret).update(msg).digest('hex')
  return `sha256=${hmac}`
}

/**
 * Insert an outbox row. Must be called from within (or immediately
 * after) the status-write transaction so the event is durable before
 * we return to the caller.
 *
 * @param {object} supabase      Supabase client
 * @param {object} args
 * @param {string} args.user_id
 * @param {string|number} args.sf_job_id
 * @param {object} args.payload  Frozen payload (already built)
 * @param {string} args.state    'pending' | 'skipped_unmapped_status'
 * @param {string} [args.terminal_at]  ISO — required when state is terminal
 */
async function insertOutboxRow(supabase, { user_id, sf_job_id, payload, state = 'pending', terminal_at = null }) {
  const row = {
    event_id: payload.event_id,
    user_id,
    sf_job_id: String(sf_job_id),
    event_type: payload.event_type || 'job.status_changed',
    payload_json: payload,
    state,
    attempts: 0,
    next_attempt_at: state === 'pending' ? new Date().toISOString() : null,
    terminal_at,
  }
  const { data, error } = await supabase
    .from('leadbridge_outbound_events')
    .insert(row)
    .select('id, event_id, state')
    .single()
  if (error) {
    // UNIQUE violation on event_id → idempotent no-op (retry safety).
    if (error.code === '23505') {
      console.log(`[SF → LB] event duplicate event=${payload.event_id} job=${sf_job_id}`)
      return { duplicate: true, event_id: payload.event_id }
    }
    throw error
  }
  // §7 lifecycle log — every persisted outbox row gets one of these.
  const verb = state === 'pending' ? 'event queued' : `skipped_unmapped_status`
  console.log(`[SF → LB] ${verb} event=${payload.event_id} job=${sf_job_id} status=${payload?.status?.new}`)
  return data
}

/**
 * Decide what to do with an outbound event given the job and status,
 * and (if appropriate) persist the outbox row.
 *
 * Callable from both updateJobStatus (status change) and the
 * INSERT-time helper. Returns one of:
 *   { action: 'disabled' }              — kill switch off
 *   { action: 'skipped_not_linked' }    — job not LB-linked
 *   { action: 'skipped_loop' }          — source='leadbridge'
 *   { action: 'skipped_unmapped', row } — persisted terminal row
 *   { action: 'enqueued', row }         — persisted pending row
 */
async function recordOutboundIfApplicable(supabase, { job, oldStatus, newStatus, actor, source, eventIdOverride }) {
  if (!OUTBOUND_ENABLED()) {
    return { action: 'disabled' }
  }
  if (source === 'leadbridge') {
    // Loop prevention — LB-originated write, do not echo back.
    return { action: 'skipped_loop' }
  }
  if (!job || !job.lb_external_request_id || !job.lb_channel) {
    // System invariant log — every status change on an unlinked LB-eligible
    // job is recorded so the operator can audit how many lifecycle events
    // we drop because linkage never landed at job-create time.
    recordOutboundSkippedNotLinked()
    console.log(
      `[LBLinkage] action=outbound_skipped_not_linked job_id=${job?.id ?? 'null'} ` +
      `user_id=${job?.user_id ?? 'null'} status=${newStatus} previous=${oldStatus ?? 'null'} ` +
      `source=${source} reason=no_lb_linkage_on_job`
    )
    return { action: 'skipped_not_linked' }
  }
  if (!isOutboundAllowed(newStatus)) {
    const payload = buildPayload({ job, oldStatus, newStatus, actor, eventIdOverride })
    const row = await insertOutboxRow(supabase, {
      user_id: job.user_id,
      sf_job_id: job.id,
      payload,
      state: 'skipped_unmapped_status',
      terminal_at: new Date().toISOString(),
    })
    return { action: 'skipped_unmapped', row }
  }

  const payload = buildPayload({ job, oldStatus, newStatus, actor })
  const row = await insertOutboxRow(supabase, {
    user_id: job.user_id,
    sf_job_id: job.id,
    payload,
    state: 'pending',
  })
  return { action: 'enqueued', row }
}

/**
 * Look up the active outbound subscription for a user.
 * Returns null when outbound is not active (disconnected, never
 * registered, or /subscribe failed on the last connect).
 */
async function getLbOutboundSubscription(supabase, userId) {
  const { data } = await supabase
    .from('communication_settings')
    .select([
      'leadbridge_connected',
      'leadbridge_outbound_subscription_id',
      'leadbridge_outbound_encrypted_secret',
      'leadbridge_outbound_secret_key_version',
      'leadbridge_outbound_webhook_url',
      'leadbridge_outbound_events',
      'leadbridge_outbound_registered_at',
      'leadbridge_outbound_last_event_at',
    ].join(','))
    .eq('user_id', userId)
    .maybeSingle()

  if (!data) return null
  if (!data.leadbridge_connected) return null
  if (!data.leadbridge_outbound_subscription_id) return null
  if (!data.leadbridge_outbound_encrypted_secret) return null
  if (!data.leadbridge_outbound_webhook_url) return null
  return data
}

module.exports = {
  // exported for tests + callers
  buildPayload,
  insertOutboxRow,
  recordOutboundIfApplicable,
  signRequest,
  getLbOutboundSubscription,
  decryptIntegrationSecret,
  uuidv7,
  // feature flag helpers (exported for the drainer)
  OUTBOUND_ENABLED,
  OUTBOUND_DRY_RUN,
  SF_INSTANCE,
}
