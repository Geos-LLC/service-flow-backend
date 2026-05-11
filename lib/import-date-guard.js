/**
 * Import-time date validation guard.
 *
 * Pre-fix: BookingKoala CSV import accepted any string into `jobs.scheduled_date`
 * (column type is text). Job 142078 ended up with `"+045930-01-01"` because
 * buildScheduledDate() only warned on malformed input and let it through.
 *
 * Layer 1 fix: reject scheduled_date values whose year is outside [2000, 2100].
 * This is a defense-in-depth guard the writer applies BEFORE INSERT/UPDATE.
 * (Layer 2 would migrate the column to `timestamp` so the DB itself rejects
 * malformed values — not in scope for this PR.)
 */

'use strict';

const MIN_YEAR = 2000;
const MAX_YEAR = 2100;

/**
 * Validate a scheduled_date string proposed for write.
 *
 * Accepts these shapes:
 *   "YYYY-MM-DD"
 *   "YYYY-MM-DD HH:MM:SS"
 *   "YYYY-MM-DDTHH:MM:SS"      (ISO with T)
 *   "YYYY-MM-DD HH:MM:SS.fff"  (with fractional seconds)
 *   "YYYY-MM-DD HH:MM"         (no seconds — buildScheduledDate sometimes emits this)
 *
 * Rejects:
 *   - null / undefined / empty string  → returns { ok: false, reason: 'empty' }
 *   - strings that don't start with YYYY-MM-DD (e.g. "+045930-01-01", "12/15/2024", "01/01 09:00:00")
 *   - years < MIN_YEAR or > MAX_YEAR
 *   - month not 01–12
 *   - day not 01–31
 *
 * @param {string|null|undefined} value
 * @returns {{ok: true, year: number, normalized_prefix: string} | {ok: false, reason: string}}
 */
function validateScheduledDate(value) {
  if (value == null) return { ok: false, reason: 'empty' };
  const s = String(value).trim();
  if (s === '') return { ok: false, reason: 'empty' };

  // Match the canonical YYYY-MM-DD prefix; reject the BC-prefix (`-`) or
  // far-future-prefix (`+`) variants that Postgres uses for out-of-range
  // years and that JS Date.toISOString() emits for years > 9999.
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?$/);
  if (!m) {
    return { ok: false, reason: `does_not_match_YYYY-MM-DD_prefix (got "${s.slice(0, 30)}")` };
  }
  const year = parseInt(m[1], 10);
  const month = parseInt(m[2], 10);
  const day = parseInt(m[3], 10);

  if (!Number.isFinite(year) || year < MIN_YEAR || year > MAX_YEAR) {
    return { ok: false, reason: `year_out_of_range (${year}, allowed ${MIN_YEAR}-${MAX_YEAR})` };
  }
  if (!Number.isFinite(month) || month < 1 || month > 12) {
    return { ok: false, reason: `month_out_of_range (${month})` };
  }
  if (!Number.isFinite(day) || day < 1 || day > 31) {
    return { ok: false, reason: `day_out_of_range (${day})` };
  }
  // Validate the date is real (e.g. reject Feb 30) — Date round-trip.
  // Use UTC to avoid timezone shenanigans for the validation only.
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) {
    return { ok: false, reason: `invalid_calendar_date (${year}-${month}-${day})` };
  }

  return { ok: true, year, normalized_prefix: `${m[1]}-${m[2]}-${m[3]}` };
}

module.exports = {
  validateScheduledDate,
  MIN_YEAR,
  MAX_YEAR,
};
