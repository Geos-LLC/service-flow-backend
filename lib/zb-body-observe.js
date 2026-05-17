'use strict';

/**
 * ZB Q2-B instrumentation — top-level webhook body key sampling.
 *
 * Captures top-level body KEY NAMES (not values) for up to 50 inbound
 * ZB webhook deliveries or 24 hours, whichever first. Purpose: resolve
 * Q2-B (does ZB carry a stable per-event identifier separate from the
 * resource id?) without contacting ZB support.
 *
 * Activation:
 *   INSERT INTO platform_settings (key, value)
 *   VALUES ('zb_body_observe', '{"remaining":50,"started_at":"<now-iso>","max_age_hours":24}'::jsonb);
 *
 * Deactivation:
 *   DELETE FROM platform_settings WHERE key='zb_body_observe';
 *
 * Auto-disable: when remaining hits 0 OR now - started_at > max_age_hours,
 * the handler no-ops.
 *
 * Safety:
 *   - Only KEY names logged (no values, no headers, no PII).
 *   - 60s in-process cache → at most 1 DB read per minute per replica.
 *   - All exceptions swallowed; observability MUST NOT break the handler.
 *   - Atomic decrement: UPDATE … WHERE (value->>'remaining')::int > 0.
 */

const CACHE_TTL_MS = 60 * 1000;
let cached = { fetchedAt: 0, value: null };

function clearCache() {
  cached = { fetchedAt: 0, value: null };
}

async function readSetting(supabase) {
  const now = Date.now();
  if (cached.value !== undefined && now - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.value;
  }
  try {
    const { data, error } = await supabase
      .from('platform_settings')
      .select('value')
      .eq('key', 'zb_body_observe')
      .maybeSingle();
    if (error) {
      cached = { fetchedAt: now, value: null };
      return null;
    }
    const value = data && data.value ? data.value : null;
    cached = { fetchedAt: now, value };
    return value;
  } catch {
    cached = { fetchedAt: now, value: null };
    return null;
  }
}

function isWithinWindow(setting) {
  if (!setting) return false;
  const remaining = parseInt(setting.remaining, 10);
  if (!Number.isFinite(remaining) || remaining <= 0) return false;
  if (setting.started_at) {
    const maxAgeHours = parseInt(setting.max_age_hours, 10) || 24;
    const startedMs = Date.parse(setting.started_at);
    if (Number.isFinite(startedMs) && Date.now() - startedMs > maxAgeHours * 3600 * 1000) {
      return false;
    }
  }
  return true;
}

/**
 * Atomically decrement the remaining counter. Returns the new value or null.
 * Uses a WHERE clause that prevents going below zero — race-safe across replicas.
 */
async function decrement(supabase) {
  try {
    // Read current value, compute new value, conditionally update
    const { data: current } = await supabase
      .from('platform_settings')
      .select('value')
      .eq('key', 'zb_body_observe')
      .maybeSingle();
    if (!current || !current.value) return null;
    const remaining = parseInt(current.value.remaining, 10);
    if (!Number.isFinite(remaining) || remaining <= 0) return null;
    const newValue = { ...current.value, remaining: remaining - 1 };
    // Conditional update — only if remaining is still > 0 in the DB.
    const { error: updErr } = await supabase
      .from('platform_settings')
      .update({ value: newValue })
      .eq('key', 'zb_body_observe')
      .gt('value->>remaining', '0');
    if (updErr) return null;
    // Invalidate cache so the next read sees the new value
    clearCache();
    return newValue.remaining;
  } catch {
    return null;
  }
}

/**
 * Observe top-level body keys for one inbound ZB webhook delivery.
 *
 * @param {Object} supabase  Supabase client
 * @param {Object} body      The HTTP request body (object)
 * @param {Object} ctx       Optional context — { eventType, logger }
 * @returns {Promise<{ sampled: boolean, remaining?: number, keys?: string[] }>}
 *
 * Returns { sampled: false } when no sampling is active or window has expired.
 * NEVER throws.
 */
async function observe(supabase, body, ctx = {}) {
  const logger = ctx.logger || console;
  try {
    // Early-return on missing/invalid body — don't consume a sample slot
    // on a request the handler will reject anyway.
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return { sampled: false };
    }
    const setting = await readSetting(supabase);
    if (!isWithinWindow(setting)) {
      return { sampled: false };
    }

    // Compute top-level keys, sorted, comma-joined. No values touched.
    const keys = Object.keys(body).sort();
    const keysCsv = keys.join(',');
    const dataKeysCount = body && body.data && typeof body.data === 'object'
      ? Object.keys(body.data).length
      : 0;

    // Atomic decrement
    const remaining = await decrement(supabase);
    if (remaining == null) {
      // Race: another replica took the last slot. Treat as not sampled.
      return { sampled: false };
    }

    // [ZB-body-observe] structured Loki anchor — design proposal §"What gets logged"
    const eventType = ctx.eventType || (body && body.event) || 'unknown';
    if (logger.log) {
      logger.log(
        `[ZB-body-observe] sample_remaining=${remaining} event_type=${eventType} top_level_keys=${keysCsv} data_keys_count=${dataKeysCount}`
      );
    }
    return { sampled: true, remaining, keys };
  } catch (err) {
    // Observability MUST NOT break the handler.
    if (logger && logger.warn) logger.warn(`[ZB-body-observe] error swallowed: ${err && err.message}`);
    return { sampled: false };
  }
}

module.exports = {
  observe,
  // exported for tests
  readSetting,
  isWithinWindow,
  decrement,
  clearCache,
  CACHE_TTL_MS,
};
