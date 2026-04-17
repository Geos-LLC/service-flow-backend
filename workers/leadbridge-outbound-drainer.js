/**
 * LeadBridge outbound drainer — §8 of JOB_STATUS_SYNC_TO_LB.md.
 *
 * Runs every 5s inside the app process. Claims due outbox rows,
 * POSTs them to LB with a fresh HMAC signature, and transitions the
 * row based on the response.
 *
 * Concurrency (mandatory, both from day one):
 *   1. Per-tick advisory lock (pg_try_advisory_lock) so at most one
 *      replica drains per tick.
 *   2. Per-row claim via FOR UPDATE SKIP LOCKED + `claimed_by` lease
 *      + stale-lease recovery.
 *
 * Both concurrency primitives live in SQL-level RPCs created by
 * migration 022 — see lb_outbound_try_tick_lock, lb_outbound_sweep_stale_leases,
 * and lb_outbound_claim_due in that migration.
 */

const axios = require('axios')
const crypto = require('crypto')
const {
  getLbOutboundSubscription,
  signRequest,
  decryptIntegrationSecret,
  OUTBOUND_ENABLED,
  OUTBOUND_DRY_RUN,
} = require('../services/lb-outbound-delivery')

const TICK_MS = parseInt(process.env.LEADBRIDGE_OUTBOUND_TICK_MS || '5000', 10)
const BATCH_SIZE = parseInt(process.env.LEADBRIDGE_OUTBOUND_BATCH_SIZE || '50', 10)
const LEASE_S = parseInt(process.env.LEADBRIDGE_OUTBOUND_LEASE_S || '120', 10)
const NETWORK_MAX_ATTEMPTS = 5
const NO_SUB_MAX_ATTEMPTS = 48

// Retryable-by-network backoff (seconds).
function networkBackoff(attempt) {
  // attempts values passed in here are post-increment (1-based)
  const schedule = [0, 10, 60, 600, 3600]
  const idx = Math.min(Math.max(attempt, 1) - 1, schedule.length - 1)
  return schedule[idx]
}

// "No outbound subscription" backoff — starts at 1h, caps at 4h.
// Long cadence because the fix is user-side (reconnect), not a
// transient server blip. Events sit safely in `pending` with
// `defer_reason='no_outbound_subscription'` until reconnect drains
// them naturally.
function deferBackoff(attempt) {
  const ONE_HOUR = 3600
  const FOUR_HOURS = 14400
  const wait = ONE_HOUR * Math.min(attempt, 4)
  return Math.min(wait, FOUR_HOURS)
}

function nowIso() { return new Date().toISOString() }
function addSecondsIso(s) { return new Date(Date.now() + s * 1000).toISOString() }

function workerId() {
  return `sf-${process.pid}-${crypto.randomBytes(3).toString('hex')}`
}

/**
 * One drainer tick. Exported for tests + manual admin invocation.
 */
async function runDrainerTick({ supabase, logger = console, lbBaseUrl = null }) {
  if (!OUTBOUND_ENABLED()) return { skipped: 'disabled' }

  // 1. Try to acquire the per-tick advisory lock.
  let lockRes
  try {
    lockRes = await supabase.rpc('lb_outbound_try_tick_lock')
  } catch (e) {
    logger.error(`[LB Outbound] Tick lock RPC error: ${e.message}`)
    return { error: 'tick_lock_failed' }
  }
  const gotLock = lockRes && lockRes.data === true
  if (!gotLock) return { skipped: 'not_tick_leader' }

  const released = { done: false }
  const release = async () => {
    if (released.done) return
    released.done = true
    try { await supabase.rpc('lb_outbound_release_tick_lock') }
    catch (e) { logger.warn(`[LB Outbound] Tick lock release error: ${e.message}`) }
  }

  try {
    // 2. Stale-lease sweep — any row stuck in 'sending' past its
    //    claimed_until goes back to 'pending'. A crashed worker's
    //    rows resume here.
    const sweep = await supabase.rpc('lb_outbound_sweep_stale_leases')
    const sweptCount = typeof sweep.data === 'number' ? sweep.data : 0
    if (sweptCount > 0) {
      logger.log(`[LB Outbound] Swept ${sweptCount} stale leases`)
    }

    // 3. Claim due rows atomically.
    const worker = workerId()
    const { data: claimed, error: claimErr } = await supabase.rpc('lb_outbound_claim_due', {
      p_worker: worker,
      p_lease_s: LEASE_S,
      p_limit: BATCH_SIZE,
    })
    if (claimErr) {
      logger.error(`[LB Outbound] Claim RPC error: ${claimErr.message}`)
      return { error: 'claim_failed' }
    }

    const rows = Array.isArray(claimed) ? claimed : []
    if (rows.length === 0) return { processed: 0 }

    let processed = 0
    for (const row of rows) {
      try {
        await processRow({ supabase, logger, row, lbBaseUrl })
        processed++
      } catch (e) {
        // Any unexpected error here leaves the row in 'sending' with
        // a short lease; the next tick will sweep it back to pending.
        logger.error(`[LB Outbound] Process row ${row.event_id} unexpected error: ${e.message}`)
      }
    }
    return { processed }
  } finally {
    await release()
  }
}

async function processRow({ supabase, logger, row, lbBaseUrl }) {
  // 4. Look up the active outbound subscription for the row's user.
  const subscription = await getLbOutboundSubscription(supabase, row.user_id)
  if (!subscription) {
    // "No subscription yet" — retryable defer, NOT terminal.
    const attempts = (row.attempts || 0) + 1
    if (attempts > NO_SUB_MAX_ATTEMPTS) {
      await transition(supabase, row.id, {
        state: 'dlq',
        attempts,
        terminal_at: nowIso(),
        defer_reason: 'no_outbound_subscription',
        last_error: 'no_outbound_subscription: exceeded max defer attempts',
      })
      logLine(logger, { row, to: 'dlq', result: null, attempts, note: 'no_outbound_subscription' })
    } else {
      const wait = deferBackoff(attempts)
      await transition(supabase, row.id, {
        state: 'pending',
        attempts,
        next_attempt_at: addSecondsIso(wait),
        defer_reason: 'no_outbound_subscription',
        claimed_by: null,
        claimed_until: null,
      })
      logLine(logger, { row, to: 'pending', result: 'deferred_no_subscription', attempts })
    }
    return
  }

  // 5. Decrypt the HMAC secret per attempt — never cached in memory
  //    longer than one request.
  let secret
  try {
    secret = decryptIntegrationSecret(
      subscription.leadbridge_outbound_encrypted_secret,
      subscription.leadbridge_outbound_secret_key_version
    )
  } catch (e) {
    const attempts = (row.attempts || 0) + 1
    await transition(supabase, row.id, {
      state: 'dlq',
      attempts,
      terminal_at: nowIso(),
      last_error: `decrypt_failed: ${e.message}`,
    })
    logger.error(`[LB Outbound] Decrypt failed for user ${row.user_id}: ${e.message}`)
    return
  }

  // 6. Build the request. Body is the frozen payload verbatim so LB
  //    sees byte-identical content across retries (idempotency via
  //    `event_id` is exact-match).
  const rawBody = JSON.stringify(row.payload_json)
  const timestamp = Math.floor(Date.now() / 1000).toString()
  const signature = signRequest(secret, rawBody, timestamp)
  // Zero out the secret reference as soon as we're done signing.
  secret = null

  const url = subscription.leadbridge_outbound_webhook_url
  const headers = {
    'Content-Type': 'application/json',
    'X-SF-Signature': signature,
    'X-SF-Timestamp': timestamp,
    'X-SF-Subscription-Id': subscription.leadbridge_outbound_subscription_id,
    'X-SF-Event-Id': row.event_id, // LB may use as a second idempotency key
  }

  // 7. DRY_RUN short-circuits at the HTTP boundary. We've already
  //    built + signed a real payload so we know the full pipeline
  //    works end-to-end; we just don't hit the network.
  if (OUTBOUND_DRY_RUN()) {
    await transition(supabase, row.id, {
      state: 'sent',
      result: 'dry_run',
      attempts: (row.attempts || 0) + 1,
      terminal_at: nowIso(),
      defer_reason: null,
      last_error: null,
    })
    await touchLastEventAt(supabase, row.user_id)
    logLine(logger, { row, to: 'sent', result: 'dry_run', attempts: (row.attempts || 0) + 1 })
    return
  }

  const effectiveUrl = lbBaseUrl ? url.replace(/^https?:\/\/[^/]+/, lbBaseUrl) : url

  let resp
  let networkErr = null
  try {
    resp = await axios({
      method: 'POST',
      url: effectiveUrl,
      headers,
      data: rawBody,           // string — matches what we signed
      timeout: 15000,
      validateStatus: () => true, // handle all codes below
    })
  } catch (e) {
    networkErr = e
  }

  // 8. Response handling.
  const attempts = (row.attempts || 0) + 1
  if (networkErr) {
    await retryOrDlq(supabase, row, attempts, `network: ${networkErr.code || networkErr.message}`)
    logLine(logger, { row, to: attempts > NETWORK_MAX_ATTEMPTS ? 'dlq' : 'pending', result: 'network_error', attempts })
    return
  }

  const status = resp.status
  const body = resp.data || {}

  if (status === 200) {
    await transition(supabase, row.id, {
      state: 'sent',
      result: body?.result || 'applied',
      attempts,
      terminal_at: nowIso(),
      defer_reason: null,
      last_error: null,
    })
    await touchLastEventAt(supabase, row.user_id)
    logLine(logger, { row, to: 'sent', result: body?.result || 'applied', attempts })
    return
  }

  if (status === 409) {
    // LB saw this event_id before — treat as sent (idempotent duplicate).
    await transition(supabase, row.id, {
      state: 'sent',
      result: 'duplicate',
      attempts,
      terminal_at: nowIso(),
      defer_reason: null,
      last_error: null,
    })
    await touchLastEventAt(supabase, row.user_id)
    logLine(logger, { row, to: 'sent', result: 'duplicate', attempts })
    return
  }

  if (status === 422) {
    // LB rejected the status mapping (allowlist drift). Permanent.
    await transition(supabase, row.id, {
      state: 'skipped_unmapped_status',
      attempts,
      terminal_at: nowIso(),
      last_error: typeof body === 'string' ? body : (body?.error || '422'),
    })
    logLine(logger, { row, to: 'skipped_unmapped_status', result: '422', attempts })
    return
  }

  if (status === 400 || status === 401 || status === 404) {
    // Hard errors — payload/auth/url is structurally wrong. Retrying
    // will just burn attempts.
    await transition(supabase, row.id, {
      state: 'dlq',
      attempts,
      terminal_at: nowIso(),
      last_error: `http ${status}: ${typeof body === 'string' ? body : JSON.stringify(body).slice(0, 300)}`,
    })
    logLine(logger, { row, to: 'dlq', result: String(status), attempts })
    return
  }

  // 429 / 5xx / anything else — retryable.
  await retryOrDlq(supabase, row, attempts, `http ${status}: ${typeof body === 'string' ? body : JSON.stringify(body).slice(0, 300)}`)
  logLine(logger, { row, to: attempts > NETWORK_MAX_ATTEMPTS ? 'dlq' : 'pending', result: String(status), attempts })
}

async function retryOrDlq(supabase, row, attempts, errorMessage) {
  if (attempts > NETWORK_MAX_ATTEMPTS) {
    await transition(supabase, row.id, {
      state: 'dlq',
      attempts,
      terminal_at: nowIso(),
      last_error: errorMessage,
    })
    return
  }
  const wait = networkBackoff(attempts)
  await transition(supabase, row.id, {
    state: 'pending',
    attempts,
    next_attempt_at: addSecondsIso(wait),
    last_error: errorMessage,
    claimed_by: null,
    claimed_until: null,
  })
}

async function transition(supabase, id, fields) {
  const patch = { ...fields }
  if (!('last_attempt_at' in patch)) patch.last_attempt_at = nowIso()
  const { error } = await supabase.from('leadbridge_outbound_events').update(patch).eq('id', id)
  if (error) throw error
}

async function touchLastEventAt(supabase, userId) {
  try {
    await supabase
      .from('communication_settings')
      .update({ leadbridge_outbound_last_event_at: nowIso() })
      .eq('user_id', userId)
  } catch {
    // Best-effort — a missing settings row would be strange (we only
    // got here via getLbOutboundSubscription) but don't fail the row.
  }
}

function logLine(logger, { row, to, result, attempts, note }) {
  const payload = row.payload_json || {}
  logger.log(
    `[LB Outbound] event=${row.event_id} job=${row.sf_job_id} user=${row.user_id} state=${to}` +
    (result ? ` result=${result}` : '') +
    ` attempts=${attempts}` +
    (note ? ` note=${note}` : '')
  )
}

/**
 * Start the drainer loop. Returns a handle with stop().
 */
function startDrainer({ supabase, logger = console }) {
  if (!supabase) throw new Error('startDrainer: supabase required')
  if (!OUTBOUND_ENABLED()) {
    logger.log('[LB Outbound] Drainer not started — LEADBRIDGE_OUTBOUND_STATUS_ENABLED is false.')
    return { stop: () => {} }
  }

  let stopped = false
  let timer = null

  const tick = async () => {
    if (stopped) return
    try {
      await runDrainerTick({ supabase, logger })
    } catch (e) {
      logger.error(`[LB Outbound] Drainer tick error: ${e.message}`)
    } finally {
      if (!stopped) timer = setTimeout(tick, TICK_MS)
    }
  }

  // Kick off first tick after a short random jitter so multiple
  // instances don't hammer in lockstep.
  const jitter = Math.floor(Math.random() * 2000)
  timer = setTimeout(tick, jitter)
  logger.log(`[LB Outbound] Drainer started (tick=${TICK_MS}ms batch=${BATCH_SIZE} dry_run=${OUTBOUND_DRY_RUN()})`)

  return {
    stop: () => {
      stopped = true
      if (timer) clearTimeout(timer)
      logger.log('[LB Outbound] Drainer stopped')
    },
  }
}

module.exports = {
  startDrainer,
  runDrainerTick,
  // exposed for tests
  networkBackoff,
  deferBackoff,
  NETWORK_MAX_ATTEMPTS,
  NO_SUB_MAX_ATTEMPTS,
}
