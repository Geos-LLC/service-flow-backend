'use strict';

/**
 * P1.3 (Synchronization Constitution §6.2) — atomic financial-write helper.
 *
 * Wraps `supabase.rpc('zb_apply_payment_writes', ...)` so callers don't
 * have to remember the argument shape. The Postgres function is one
 * implicit transaction: a failure anywhere inside rolls back every write,
 * so the invariant `jobs.payment_status='paid' ⟺ matching transactions row
 * exists` is preserved across crashes, network blips, and partial DB errors.
 *
 * Contract:
 *   - userId required; jobs are tenant-scoped at the SQL layer.
 *   - sfJobId may be null when the caller is upserting txs only.
 *   - jobUpdates is a flat object with payment-related fields. Unknown keys
 *     are silently dropped by the function (whitelisted columns only).
 *   - txDataArray is an array of tx-shape objects; each is idempotent on
 *     its zenbooker_id (update-by-zb-id → adopt-manual → insert).
 *
 * On rpc error this helper returns { ok: false, error } and emits a structured
 * [ZB-atomic-rpc-failed] log line. Callers MUST then call markDirty so the
 * row surfaces in zb_sync_dirty. Helper never throws.
 */

// Whitelist of payment-related job columns the RPC may write. Note that
// `total_paid_amount` was historically referenced in zenbooker-sync.js but
// never existed in the jobs schema — PostgREST silently dropped it from the
// pre-P1.3 .update() calls. Excluded here so the RPC compiles.
const VALID_JOB_FIELDS = new Set([
  'payment_status', 'invoice_status', 'payment_method',
  'service_price', 'price', 'total', 'total_amount', 'invoice_amount',
  'tip_amount', 'additional_fees', 'discount', 'duration', 'taxes',
  'fees_breakdown',
]);

const VALID_TX_FIELDS = new Set([
  'job_id', 'customer_id', 'amount', 'payment_method', 'payment_intent_id',
  'status', 'notes', 'tip_amount', 'discount', 'zenbooker_id', 'created_at',
]);

function sanitizeJobUpdates(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (!VALID_JOB_FIELDS.has(k)) continue;
    if (v === undefined) continue;
    out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : null;
}

function sanitizeTxArray(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.map((tx) => {
    if (!tx || typeof tx !== 'object') return null;
    const out = {};
    for (const [k, v] of Object.entries(tx)) {
      if (!VALID_TX_FIELDS.has(k)) continue;
      if (v === undefined) continue;
      out[k] = v;
    }
    return out;
  }).filter(Boolean);
}

/**
 * @param {Object} supabase
 * @param {Object} args
 * @param {number|string} args.userId            REQUIRED — tenant scope
 * @param {number|null}   args.sfJobId           required when jobUpdates present
 * @param {Object|null}   [args.jobUpdates]      payment-column updates for the job row
 * @param {Array<Object>} [args.txDataArray]     transactions to upsert (idempotent on zenbooker_id)
 * @param {Object}        [args.logger]          defaults to console
 * @returns {Promise<{ ok: boolean, result?: Object, error?: Object, code?: string }>}
 */
async function applyAtomicPaymentWrites(supabase, args) {
  const { userId, sfJobId = null, jobUpdates = null, txDataArray = [], logger } = args || {};
  const log = logger || console;

  if (!userId) {
    log.error?.(`[ZB-atomic] applyAtomicPaymentWrites called without userId`);
    return { ok: false, error: { message: 'userId required' }, code: 'INVALID_INPUT' };
  }

  const cleanJobUpdates = sanitizeJobUpdates(jobUpdates);
  const cleanTxArray = sanitizeTxArray(txDataArray);

  if (!cleanJobUpdates && cleanTxArray.length === 0) {
    return { ok: true, result: { committed: true, jobs_updated: 0, tx_actions: [], noop: true } };
  }

  // jobs update without sf_job_id is a misconfiguration — the function would
  // reject it anyway, but surface it loud here.
  if (cleanJobUpdates && sfJobId == null) {
    log.error?.(`[ZB-atomic] jobUpdates supplied without sfJobId; refusing`);
    return { ok: false, error: { message: 'sfJobId required when jobUpdates present' }, code: 'INVALID_INPUT' };
  }

  try {
    const { data, error } = await supabase.rpc('zb_apply_payment_writes', {
      p_user_id: userId,
      p_sf_job_id: sfJobId,
      p_job_updates: cleanJobUpdates,
      p_tx_data_array: cleanTxArray,
    });

    if (error) {
      const code = error.code || 'RPC_ERROR';
      const msg = String(error.message || 'rpc failed').slice(0, 400);
      log.warn?.(
        `[ZB-atomic-rpc-failed] user_id=${userId} sf_job_id=${sfJobId} `
        + `tx_count=${cleanTxArray.length} code=${code} message=${msg}`
      );
      return { ok: false, error, code };
    }

    log.log?.(
      `[ZB-atomic] committed user_id=${userId} sf_job_id=${sfJobId} `
      + `jobs_updated=${data?.jobs_updated ?? 0} tx_count=${(data?.tx_actions || []).length}`
    );
    return { ok: true, result: data };
  } catch (e) {
    log.error?.(`[ZB-atomic-rpc-failed] uncaught: user_id=${userId} sf_job_id=${sfJobId} message=${e.message}`);
    return { ok: false, error: { message: e.message }, code: 'UNCAUGHT' };
  }
}

module.exports = {
  applyAtomicPaymentWrites,
  VALID_JOB_FIELDS,
  VALID_TX_FIELDS,
  // Exported for tests
  sanitizeJobUpdates,
  sanitizeTxArray,
};
