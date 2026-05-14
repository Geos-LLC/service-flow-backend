'use strict';

/**
 * P1.2 — ZB sync dirty marker.
 *
 * Replaces .catch(() => {}) silent swallows in zenbooker-sync.js. The marker
 * is a queryable signal that a downstream operation failed AFTER the
 * canonical webhook/sync handler's primary upsert succeeded. The handler
 * MUST continue (operation is non-fatal to the immediate response), but
 * operators need to see drift, and retry paths need a way to clear the
 * signal on success.
 *
 * Constitution refs:
 *   §0 P2 — sync paths fail loudly
 *   §6.2 — partial commit visibility
 *   §6.6 — missing upstream entity → log + audit, do not 5xx
 *
 * Idempotency contract:
 *   The migration creates a partial unique index on
 *   (user_id, sf_job_id, zenbooker_id, operation) WHERE resolved_at IS NULL.
 *   markDirty therefore: tries to UPDATE an existing open row first, falls
 *   back to INSERT, and survives a race-vs-concurrent-INSERT (23505) by
 *   retrying the UPDATE path.
 *
 * Structured log contract (the Loki anchor):
 *   Every markDirty call emits exactly one warn-level line with prefix
 *   [ZB-dirty] and key=value fields: user_id, sf_job_id, zenbooker_id,
 *   operation, error_class, retryable, message. Dashboard / alert rules
 *   key off this prefix.
 */

const VALID_OPERATIONS = Object.freeze([
  'transaction_payment_method',
  'payment_status_update',
  'customer_link',
  'zb_job_fetch',
  'zb_tx_fetch',
  'ledger_rebuild',
]);
const VALID_OPERATIONS_SET = new Set(VALID_OPERATIONS);

function classifyRetryable(err) {
  if (!err) return null;
  const msg = String(err.message || err).toLowerCase();
  if (/timeout|timed out|etimedout|econnreset|econnrefused|enotfound|eai_again|503|504|520|521|522|fetch failed|socket hang up|network/.test(msg)) return true;
  if (/(unique|conflict|violates|not null|invalid input|duplicate key|forbidden|not found)/.test(msg)) return false;
  return null;
}

function classifyErrorClass(err) {
  if (!err) return null;
  if (err.code) return String(err.code);
  if (err.name && err.name !== 'Error') return err.name;
  return 'Error';
}

function truncateMessage(s) {
  if (s == null) return 'unknown';
  return String(s).slice(0, 1000);
}

/**
 * Mark a row dirty. Never throws — last-resort guard ensures the original
 * sync handler can't be broken by a marker-system failure.
 *
 * @param {Object} supabase
 * @param {Object} args
 * @param {number|string} args.userId       REQUIRED — tenant scope
 * @param {number|null}   args.sfJobId      sf jobs.id — null when not yet known
 * @param {string|null}   args.zenbookerId  ZB entity id (job/tx/customer)
 * @param {string}        args.operation    one of VALID_OPERATIONS
 * @param {Error|string}  args.error        thrown error or message
 * @param {boolean|null}  [args.retryable]  override classifier
 * @param {Object}        [args.context]    arbitrary debug JSONB
 * @param {Object}        [args.logger]     defaults to console
 * @returns {Promise<{action: string, id?: number, error?: string}>}
 */
async function markDirty(supabase, args) {
  const { userId, sfJobId = null, zenbookerId = null, operation, error, retryable, context = null, logger } = args || {};
  const log = logger || console;

  // Validate inputs strictly — caller bugs are surfaced loud.
  if (!userId) {
    log.error?.(`[ZB-dirty] markDirty called without userId; refusing to mark (operation=${operation})`);
    return { action: 'invalid', error: 'userId required' };
  }
  if (!operation || !VALID_OPERATIONS_SET.has(operation)) {
    log.error?.(`[ZB-dirty] invalid operation ${JSON.stringify(operation)}; valid: ${VALID_OPERATIONS.join(',')}`);
    return { action: 'invalid', error: `invalid operation: ${operation}` };
  }
  if (sfJobId == null && !zenbookerId) {
    log.error?.(`[ZB-dirty] markDirty called without sfJobId or zenbookerId (operation=${operation})`);
    return { action: 'invalid', error: 'sfJobId or zenbookerId required' };
  }

  const errorClass = classifyErrorClass(error);
  const errorMessage = truncateMessage(error?.message ?? error);
  const retry = (typeof retryable === 'boolean') ? retryable : classifyRetryable(error);

  // The structured fail-loud log is the most important side effect — it
  // ALWAYS fires, even if the DB write below fails. Loki rate-alerts key
  // off this line.
  const logFn = log.warn ? log.warn.bind(log) : log.log ? log.log.bind(log) : console.warn;
  logFn(
    `[ZB-dirty] user_id=${userId} sf_job_id=${sfJobId == null ? 'null' : sfJobId} `
    + `zenbooker_id=${zenbookerId || 'null'} operation=${operation} `
    + `error_class=${errorClass || 'null'} retryable=${retry === null ? 'unknown' : retry} `
    + `message=${errorMessage.replace(/\s+/g, ' ').slice(0, 240)}`
  );

  try {
    // Step 1: look up an existing OPEN row to keep idempotency.
    let findQuery = supabase.from('zb_sync_dirty')
      .select('id, attempts')
      .eq('user_id', userId)
      .eq('operation', operation)
      .is('resolved_at', null);
    if (sfJobId != null) findQuery = findQuery.eq('sf_job_id', sfJobId);
    else findQuery = findQuery.is('sf_job_id', null);
    if (zenbookerId) findQuery = findQuery.eq('zenbooker_id', zenbookerId);
    else findQuery = findQuery.is('zenbooker_id', null);
    const { data: existing } = await findQuery.maybeSingle();

    if (existing) {
      await supabase.from('zb_sync_dirty')
        .update({
          attempts: (existing.attempts || 1) + 1,
          last_seen_at: new Date().toISOString(),
          error_class: errorClass,
          error_message: errorMessage,
          retryable: retry,
          context: context || null,
        })
        .eq('id', existing.id);
      return { action: 'updated', id: existing.id };
    }

    const { data: inserted, error: insErr } = await supabase.from('zb_sync_dirty')
      .insert({
        user_id: userId,
        sf_job_id: sfJobId,
        zenbooker_id: zenbookerId,
        operation,
        error_class: errorClass,
        error_message: errorMessage,
        retryable: retry,
        context: context || null,
      })
      .select('id')
      .single();

    if (insErr) {
      // Concurrent insert with same key — retry the UPDATE path.
      const looksLikeUniqueViolation =
        insErr.code === '23505' ||
        /duplicate key|unique/i.test(insErr.message || '');
      if (looksLikeUniqueViolation) {
        let raceQ = supabase.from('zb_sync_dirty')
          .select('id, attempts')
          .eq('user_id', userId)
          .eq('operation', operation)
          .is('resolved_at', null);
        if (sfJobId != null) raceQ = raceQ.eq('sf_job_id', sfJobId);
        else raceQ = raceQ.is('sf_job_id', null);
        if (zenbookerId) raceQ = raceQ.eq('zenbooker_id', zenbookerId);
        else raceQ = raceQ.is('zenbooker_id', null);
        const { data: race } = await raceQ.maybeSingle();
        if (race) {
          await supabase.from('zb_sync_dirty')
            .update({
              attempts: (race.attempts || 1) + 1,
              last_seen_at: new Date().toISOString(),
              error_class: errorClass,
              error_message: errorMessage,
              retryable: retry,
              context: context || null,
            })
            .eq('id', race.id);
          return { action: 'updated_after_race', id: race.id };
        }
      }
      log.error?.(`[ZB-dirty] insert failed: ${insErr.message}`);
      return { action: 'failed', error: insErr.message };
    }
    return { action: 'inserted', id: inserted?.id };
  } catch (e) {
    // Marker subsystem MUST NEVER crash the caller — the structured log line
    // above is the floor of observability that we never lose.
    log.error?.(`[ZB-dirty] markDirty crashed: ${e.message}`);
    return { action: 'crashed', error: e.message };
  }
}

/**
 * Resolve any open dirty rows matching the same (tenant, target, operation).
 * Called from retry paths after a successful operation. Tenant-scoped.
 *
 * @returns {Promise<{action: string, count: number}>}
 */
async function resolveDirty(supabase, args) {
  const { userId, sfJobId = null, zenbookerId = null, operation, resolvedBy, note } = args || {};
  if (!userId || !operation) return { action: 'noop', count: 0 };
  if (sfJobId == null && !zenbookerId) return { action: 'noop', count: 0 };

  try {
    let q = supabase.from('zb_sync_dirty')
      .update({
        resolved_at: new Date().toISOString(),
        resolved_by: resolvedBy || 'auto:retry_success',
        resolution_note: note || null,
      })
      .eq('user_id', userId)
      .eq('operation', operation)
      .is('resolved_at', null);
    if (sfJobId != null) q = q.eq('sf_job_id', sfJobId);
    if (zenbookerId) q = q.eq('zenbooker_id', zenbookerId);
    const { data, error } = await q.select('id');
    if (error) return { action: 'failed', count: 0, error: error.message };
    return { action: 'resolved', count: data?.length || 0 };
  } catch (e) {
    return { action: 'crashed', count: 0, error: e.message };
  }
}

module.exports = {
  VALID_OPERATIONS,
  VALID_OPERATIONS_SET,
  classifyRetryable,
  classifyErrorClass,
  markDirty,
  resolveDirty,
};
