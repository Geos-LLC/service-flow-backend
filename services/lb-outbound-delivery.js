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

function buildPayload({ job, oldStatus, newStatus, actor }) {
  return {
    event_id: `evt_${uuidv7()}`,
    event_type: 'job.status_changed',
    occurred_at: new Date().toISOString(),
    source: 'service_flow',
    source_instance: SF_INSTANCE,
    sf_job_id: String(job.id),
    sf_user_id: job.user_id,
    external_request_id: job.lb_external_request_id,
    channel: job.lb_channel,
    status: {
      new: normalizeStatus(newStatus),
      previous: oldStatus == null ? null : normalizeStatus(oldStatus),
    },
    actor: {
      type: actor?.type || 'system',
      id: actor?.id ?? null,
      display_name: actor?.display_name ?? null,
    },
    job: {
      scheduled_date: job.scheduled_date ?? null,
      customer_name: job.customer_name ?? null,
      amount: job.invoice_amount != null ? Number(job.invoice_amount) : (job.total_amount != null ? Number(job.total_amount) : null),
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
    if (error.code === '23505') return { duplicate: true, event_id: payload.event_id }
    throw error
  }
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
async function recordOutboundIfApplicable(supabase, { job, oldStatus, newStatus, actor, source }) {
  if (!OUTBOUND_ENABLED()) {
    return { action: 'disabled' }
  }
  if (source === 'leadbridge') {
    // Loop prevention — LB-originated write, do not echo back.
    return { action: 'skipped_loop' }
  }
  if (!job || !job.lb_external_request_id || !job.lb_channel) {
    return { action: 'skipped_not_linked' }
  }
  if (!isOutboundAllowed(newStatus)) {
    const payload = buildPayload({ job, oldStatus, newStatus, actor })
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
