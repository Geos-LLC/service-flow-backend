'use strict';

/**
 * Persist confirmation status to a jobs row.
 *
 * Wraps `supabase.from('jobs').update(...)` with mandatory error
 * inspection — the prior inline call sites in server.js did NOT check
 * the returned `{ error }` object, so a non-existent column
 * (`confirmation_method`) silently failed and audit columns
 * (`sms_sent`, `sms_phone`, `sms_sid`) were never persisted, even
 * though the underlying SMS was sent. See investigation notes for
 * job 142213 / 2026-05-20.
 *
 * Contract:
 *   - Returns { ok: true } on a successful update.
 *   - Returns { ok: false, error } on Supabase-side errors (column
 *     missing, network, RLS denial). Logs structured error line.
 *   - Returns { ok: false, error } on thrown exceptions. Logs.
 *   - NEVER throws — caller can safely `await` without try/catch.
 *
 * Logs use the structured-logger pattern `[JobConfirmation]` so the
 * Loki forwarder (which only ships `logger.X()` output) captures them.
 *
 * @param {Object} supabase  Supabase client instance
 * @param {Object} logger    Logger with .log / .error methods
 * @param {number} jobId     jobs.id to update
 * @param {Object} patch     Plain object of columns → values
 * @param {string} context   Short tag for log correlation (e.g. 'sms_success')
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
async function persistConfirmationStatus(supabase, logger, jobId, patch, context = 'unspecified') {
  if (!supabase || jobId == null || !patch || typeof patch !== 'object') {
    if (logger && logger.error) {
      logger.error(`[JobConfirmation] invalid input (job=${jobId} context=${context})`);
    }
    return { ok: false, error: 'invalid_input' };
  }

  try {
    const { error } = await supabase.from('jobs').update(patch).eq('id', jobId);
    if (error) {
      const msg = error.message || error.code || 'unknown';
      if (logger && logger.error) {
        logger.error(`[JobConfirmation] update failed job=${jobId} context=${context} error=${msg}`);
      }
      return { ok: false, error: msg };
    }
    if (logger && logger.log) {
      logger.log(`[JobConfirmation] update ok job=${jobId} context=${context}`);
    }
    return { ok: true };
  } catch (err) {
    const msg = (err && err.message) || String(err);
    if (logger && logger.error) {
      logger.error(`[JobConfirmation] update threw job=${jobId} context=${context} error=${msg}`);
    }
    return { ok: false, error: msg };
  }
}

module.exports = { persistConfirmationStatus };
