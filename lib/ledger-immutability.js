'use strict';

/**
 * P0.1 — cleaner_ledger immutability enforcement.
 *
 * Constitution §3.1: a cleaner_ledger row with payout_batch_id IS NOT NULL is
 * immutable. It MUST NOT be UPDATEd or DELETEd outside an explicit batch-cancel.
 * Corrections happen via compensating entries (§3.6), never in-place mutation.
 *
 * This module concentrates the batched-row guard so every rebuild/cleanup site
 * can use it consistently and the contract is testable.
 *
 * Canonical completion-derived types — kept in sync with the same constant
 * defined inline in server.js / zenbooker-sync.js / tests/cancellation.test.js.
 */

const COMPLETION_DERIVED_TYPES = ['earning', 'tip', 'incentive', 'cash_collected'];

/**
 * Delete completion-derived cleaner_ledger rows for a job, but ONLY those that
 * are not yet settled (payout_batch_id IS NULL). Reports how many batched rows
 * were skipped so the caller can decide whether to emit a drift audit.
 *
 * @param {Object} supabase                Supabase client
 * @param {Object} opts
 * @param {number} opts.jobId              required
 * @param {string[]} [opts.types]          defaults to COMPLETION_DERIVED_TYPES
 * @param {string} [opts.source]           tag for logging (e.g. 'rebuildJobLedger')
 * @returns {Promise<{deleted: number, skippedBatched: Array<{id, team_member_id, type, payout_batch_id, amount, metadata}>}>}
 */
async function safeDeleteCompletionDerivedLedger(supabase, { jobId, types, source = 'unknown' }) {
  if (!jobId) throw new Error('safeDeleteCompletionDerivedLedger: jobId required');
  const t = Array.isArray(types) && types.length > 0 ? types : COMPLETION_DERIVED_TYPES;

  // Look up rows that WOULD have been deleted under the old (unguarded) rule
  // so we can report on any settled rows we're protecting.
  const { data: settled } = await supabase
    .from('cleaner_ledger')
    .select('id, team_member_id, type, payout_batch_id, amount, metadata')
    .eq('job_id', jobId)
    .in('type', t)
    .not('payout_batch_id', 'is', null);

  // Delete only the unbatched rows.
  const { data: deleted, error } = await supabase
    .from('cleaner_ledger')
    .delete()
    .eq('job_id', jobId)
    .in('type', t)
    .is('payout_batch_id', null)
    .select('id');

  if (error) {
    // Surface the error to the caller — silent swallow violates Constitution §0 P2.
    throw new Error(`[ledger-immutability] delete failed for job ${jobId} (${source}): ${error.message}`);
  }

  return {
    deleted: deleted ? deleted.length : 0,
    skippedBatched: settled || [],
  };
}

/**
 * Record drift on a settled row into the ledger_drift_detected audit table.
 * Best-effort: failure to insert the audit row MUST NOT block the surrounding
 * rebuild — but it MUST be logged. (Constitution §0 P2 — fail loudly.)
 *
 * @param {Object} supabase
 * @param {Object} row           the settled cleaner_ledger row (id/user_id/team_member_id/job_id/type/amount/payout_batch_id/metadata)
 * @param {Object} drift
 * @param {number} drift.computedAmount   what the rebuild would have written
 * @param {string} drift.source           e.g. 'rebuildJobLedger'
 * @param {string} [drift.reason]
 * @param {Object} [drift.computedInputs] inputs used by the rebuild
 * @param {Function} [logger]    optional logger (defaults to console)
 */
async function recordLedgerDrift(supabase, row, drift, logger = console) {
  if (!row || row.payout_batch_id == null) return; // only batched rows drift
  const currentAmount = Number(row.amount) || 0;
  const computedAmount = Number(drift.computedAmount);
  if (!Number.isFinite(computedAmount)) return;
  if (Math.abs(currentAmount - computedAmount) < 0.01) return; // no meaningful drift

  try {
    const { error } = await supabase.from('ledger_drift_detected').insert({
      ledger_id: row.id,
      user_id: row.user_id,
      team_member_id: row.team_member_id || null,
      job_id: row.job_id || null,
      ledger_type: row.type,
      payout_batch_id: row.payout_batch_id,
      current_amount: currentAmount,
      computed_amount: computedAmount,
      source: drift.source || 'unknown',
      reason: drift.reason || null,
      stored_snapshot: row.metadata || null,
      computed_inputs: drift.computedInputs || null,
    });
    if (error) {
      logger.error(`[ledger-drift] insert failed for ledger #${row.id}: ${error.message}`);
    } else {
      logger.warn(
        `[ledger-drift] settled ledger #${row.id} (batch ${row.payout_batch_id}, type ${row.type}) `
        + `paid ${currentAmount.toFixed(2)} but rebuild would compute ${computedAmount.toFixed(2)} — `
        + `compensating entry required (§3.6). source=${drift.source}`
      );
    }
  } catch (e) {
    logger.error(`[ledger-drift] unexpected error: ${e.message}`);
  }
}

module.exports = {
  COMPLETION_DERIVED_TYPES,
  safeDeleteCompletionDerivedLedger,
  recordLedgerDrift,
};
