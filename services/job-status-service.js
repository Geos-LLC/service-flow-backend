/**
 * Centralized job-status write path.
 *
 * EVERY mutation of `jobs.status` in Service Flow MUST go through
 * `updateJobStatus` in this file. That invariant is protected by a
 * merge-blocking CI guard (see scripts/check-job-status-writes.js).
 *
 * Responsibilities:
 *   - read current (status, lb linkage, actor-relevant fields)
 *   - early-return when newStatus === oldStatus (metric only, no row)
 *   - atomically UPDATE the row with the new status + last_status_source
 *   - insert an outbox row when appropriate (see §4 of the plan)
 *
 * The outbox insert happens via `recordOutboundIfApplicable` in
 * `lb-outbound-delivery.js`. Loop-prevention is handled there based
 * on the caller-supplied `source` argument.
 *
 * Why not use the Supabase client's transaction API? Supabase-js
 * doesn't expose multi-statement transactions, so we rely on
 * ordering + the outbox row being "safe-to-retry" if a crash lands
 * between the UPDATE and the INSERT. In the worst case the drainer
 * never sees a row that was actually written — but that matches the
 * same-status no-op behavior (no event emitted), so it degrades
 * gracefully. The alternative (write the outbox row first) would
 * violate the "status change actually happened" precondition.
 */

const { recordOutboundIfApplicable, buildPayload, insertOutboxRow, OUTBOUND_ENABLED } = require('./lb-outbound-delivery')
const { isOutboundAllowed, normalizeStatus } = require('./lb-outbound-status-map')

const VALID_SOURCES = new Set([
  'account_owner',
  'team_member',
  'system',
  'service_flow',
  'leadbridge',
])

// In-process metric counters. Exposed via getMetrics() for the
// existing /metrics surface if one is later wired up. Keeping them
// in-process avoids a dependency on prom-client right now.
const metrics = {
  skipped_same_status: 0,
  skipped_not_linked: 0,
  skipped_loop: 0,
  skipped_unmapped_status: 0,
  enqueued: 0,
  insert_enqueued: 0,
}

function getMetrics() {
  return { ...metrics }
}

/**
 * Build the minimum set of fields we need from the jobs row to
 * produce an outbound payload + make routing decisions.
 */
const JOB_SELECT_COLUMNS = 'id, user_id, status, lb_external_request_id, lb_channel, scheduled_date, invoice_amount, total_amount, customer_name, customer_id'

async function readJob(supabase, jobId, userId) {
  let query = supabase.from('jobs').select(JOB_SELECT_COLUMNS).eq('id', jobId)
  if (userId != null) query = query.eq('user_id', userId)
  const { data, error } = await query.maybeSingle()
  if (error) throw error
  return data
}

/**
 * The ONLY place where `jobs.status` is written.
 *
 * @param {object} supabase
 * @param {object} args
 * @param {string|number} args.jobId
 * @param {string} args.newStatus
 * @param {object} [args.actor]         { type, id, display_name }
 * @param {string} args.source          See VALID_SOURCES
 * @param {string|number} [args.userId] Scope the UPDATE to a user (optional)
 * @param {object} [args.extraFields]   Extra columns to set in the same UPDATE
 *                                      (e.g. `updated_at`, cancellation fields).
 *                                      Reserved keys: status / last_status_source /
 *                                      last_status_changed_at — always set by us.
 *
 * @returns {object} {
 *   changed: boolean,           // true if status actually changed
 *   previousStatus: string,
 *   newStatus: string,
 *   outboundAction: string,     // 'disabled' | 'skipped_*' | 'enqueued' | 'no_change'
 *   job: object                 // the post-update row (post-read)
 * }
 */
async function updateJobStatus(supabase, {
  jobId,
  newStatus,
  actor,
  source,
  userId,
  extraFields = {},
}) {
  if (!jobId) throw new Error('updateJobStatus: jobId required')
  if (!newStatus) throw new Error('updateJobStatus: newStatus required')
  if (!source || !VALID_SOURCES.has(source)) {
    throw new Error(`updateJobStatus: invalid source '${source}'. Must be one of: ${[...VALID_SOURCES].join(', ')}`)
  }

  const normalizedNew = normalizeStatus(newStatus)
  const job = await readJob(supabase, jobId, userId)
  if (!job) {
    const err = new Error('Job not found')
    err.code = 'JOB_NOT_FOUND'
    throw err
  }

  const previousStatus = job.status || null
  if (normalizeStatus(previousStatus) === normalizedNew) {
    metrics.skipped_same_status++
    return {
      changed: false,
      previousStatus,
      newStatus: normalizedNew,
      outboundAction: 'no_change',
      job,
    }
  }

  const now = new Date().toISOString()

  // Build the UPDATE — merge caller-supplied extra fields but never
  // let them silently override our status/marker writes.
  const safeExtras = { ...extraFields }
  for (const reserved of ['status', 'last_status_source', 'last_status_changed_at']) {
    delete safeExtras[reserved]
  }

  const update = {
    ...safeExtras,
    status: newStatus,               // preserve caller's exact enum value (could be 'in-progress' or 'in_progress')
    last_status_source: source,
    last_status_changed_at: now,
    updated_at: safeExtras.updated_at || now,
  }

  let upd = supabase.from('jobs').update(update).eq('id', jobId)
  if (userId != null) upd = upd.eq('user_id', userId)
  const { error: updErr } = await upd
  if (updErr) throw updErr

  // Decide + persist outbox row (no-op if outbound disabled / unlinked / loop).
  let outboundAction = 'disabled'
  try {
    const result = await recordOutboundIfApplicable(supabase, {
      job: { ...job, status: newStatus }, // pass the post-update view to the payload builder
      oldStatus: previousStatus,
      newStatus,
      actor,
      source,
    })
    outboundAction = result.action
    if (result.action === 'enqueued') metrics.enqueued++
    else if (result.action === 'skipped_loop') metrics.skipped_loop++
    else if (result.action === 'skipped_not_linked') metrics.skipped_not_linked++
    else if (result.action === 'skipped_unmapped') metrics.skipped_unmapped_status++
  } catch (e) {
    // Durability degrades gracefully — log but do NOT fail the status
    // update. The status write already committed; a failed outbox
    // insert is exposed in logs + metrics and can be replayed.
    console.error('[LB Outbound] Outbox insert failed:', e.message, { jobId, newStatus, source })
  }

  return {
    changed: true,
    previousStatus,
    newStatus: normalizedNew,
    outboundAction,
    job: { ...job, status: newStatus, last_status_source: source, last_status_changed_at: now },
  }
}

/**
 * Insert-time helper — emit a job.status_changed event when a newly
 * created job is LB-linked with an allowlisted status.
 *
 * Per §5 of the plan: we do NOT retroactively emit if `lb_external_request_id`
 * is filled in later via an UPDATE. The LB identity must be present
 * on the INSERT row. This matches the tradeoff documented there.
 *
 * Call this AFTER the jobs INSERT has committed. Takes the fresh
 * row (with its generated id) so payload has full identity.
 *
 * @param {object} supabase
 * @param {object} inserted  The freshly-inserted jobs row
 * @param {object} actor
 */
async function maybeEmitInsertEvent(supabase, inserted, actor) {
  if (!OUTBOUND_ENABLED()) return { action: 'disabled' }
  if (!inserted) return { action: 'no_row' }
  if (!inserted.lb_external_request_id || !inserted.lb_channel) {
    return { action: 'skipped_not_linked' }
  }
  if (!isOutboundAllowed(inserted.status)) {
    return { action: 'skipped_unmapped' }
  }
  try {
    const payload = buildPayload({
      job: inserted,
      oldStatus: null,
      newStatus: inserted.status,
      actor,
    })
    const row = await insertOutboxRow(supabase, {
      user_id: inserted.user_id,
      sf_job_id: inserted.id,
      payload,
      state: 'pending',
    })
    metrics.insert_enqueued++
    return { action: 'enqueued', row }
  } catch (e) {
    console.error('[LB Outbound] Insert-event outbox insert failed:', e.message, { jobId: inserted.id })
    return { action: 'error', error: e.message }
  }
}

module.exports = {
  updateJobStatus,
  maybeEmitInsertEvent,
  VALID_SOURCES,
  getMetrics,
}
