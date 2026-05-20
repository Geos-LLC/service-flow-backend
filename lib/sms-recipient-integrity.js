'use strict';

/**
 * SMS Recipient Integrity — audit + structured forensic logging.
 *
 * Per P0 Notification Recipient Integrity Audit (2026-05-20):
 *
 *   1. EVERY SMS send must emit `[NotificationRecipient]` with the
 *      full provenance: message_type, resolved_phone, source,
 *      fallback_depth, customer_id, team_member_id, job_id,
 *      workspace_id, twilio_sid, path.
 *
 *   2. Customer-facing sends MUST NOT resolve a phone that is ALSO
 *      stored as a team_member phone within the same tenant.
 *      Cleaner-facing sends MUST NOT resolve a customer phone.
 *      If intent/recipient mismatches: BLOCK SEND + emit
 *      `[RecipientIntegrityViolation]`.
 *
 *   3. Phone match is via last-10-digit normalization (US convention)
 *      to defend against +1 prefix / parenthesization variation.
 *
 * Scope: enforces only when caller provides an `intent`. Legacy paths
 * that haven't been migrated still pass through unchecked — they will
 * be migrated in follow-up commits.
 *
 * See:
 *   docs/operations/recipient_source_map.md  (path inventory)
 *   docs/operations/sms-trace-142215.md      (forensic case study)
 */

const VALID_INTENTS = Object.freeze([
  'customer_facing',
  'cleaner_facing',
  'external_caller_supplied',
  'conversation_reply',
  'system_test',
]);

/**
 * Normalize a phone number to the last 10 digits (US convention).
 * Handles `+1`, parentheses, dashes, spaces. Returns null on empty input.
 */
function normalizePhone(p) {
  if (p == null) return null;
  const digits = String(p).replace(/\D/g, '');
  if (digits.length === 0) return null;
  return digits.length >= 10 ? digits.slice(-10) : digits;
}

/**
 * Mask a phone for logs (PII): show only last 2 digits.
 */
function maskPhone(p) {
  if (p == null) return 'null';
  const digits = String(p).replace(/\D/g, '');
  if (digits.length < 2) return '***';
  return '***' + digits.slice(-2);
}

/**
 * Check whether the resolved recipient phone collides with the OTHER
 * role within the same tenant.
 *
 * @param {Object} supabase   Supabase client
 * @param {Object} args
 *   userId    REQUIRED — tenant scope
 *   intent    REQUIRED — one of VALID_INTENTS
 *   recipient REQUIRED — the phone number we're about to send to
 *   logger    OPTIONAL — for internal warn lines on lookup errors
 *
 * @returns {Promise<{ verdict: 'ok'|'violation'|'skipped',
 *                     reason: string,
 *                     collision?: { table, id, phone } }>}
 *
 * Verdicts:
 *   'ok'        → safe to send
 *   'violation' → CALLER MUST BLOCK SEND
 *   'skipped'   → audit not applicable (e.g. intent doesn't enforce role exclusivity)
 *
 * NEVER throws — internal errors are swallowed and audit fails OPEN
 * (returns 'ok' with `reason='lookup_error'`). Rationale: do not
 * block legitimate SMS on transient DB hiccups. The gate exists for
 * KNOWN collisions, not for unknown DB errors.
 */
async function auditRecipientIntegrity(supabase, args) {
  const o = args || {};
  if (!supabase) return { verdict: 'skipped', reason: 'no_supabase' };
  if (o.userId == null) return { verdict: 'skipped', reason: 'no_user_id' };
  if (!o.recipient) return { verdict: 'skipped', reason: 'no_recipient' };
  if (!o.intent) return { verdict: 'skipped', reason: 'no_intent' };
  if (o.intent !== 'customer_facing' && o.intent !== 'cleaner_facing') {
    return { verdict: 'skipped', reason: 'intent_not_role_scoped' };
  }
  const last10 = normalizePhone(o.recipient);
  if (!last10 || last10.length < 7) {
    return { verdict: 'skipped', reason: 'unparseable_phone' };
  }

  try {
    if (o.intent === 'customer_facing') {
      // Customer-facing must not match any team_member phone in this tenant.
      const { data, error } = await supabase
        .from('team_members')
        .select('id, first_name, last_name, phone')
        .eq('user_id', o.userId)
        .not('phone', 'is', null);
      if (error) {
        if (o.logger && o.logger.warn) {
          o.logger.warn(`[RecipientIntegrity] team_members lookup error: ${error.message}`);
        }
        return { verdict: 'ok', reason: 'lookup_error' };
      }
      const collision = (data || []).find((m) => normalizePhone(m.phone) === last10);
      if (collision) {
        return {
          verdict: 'violation',
          reason: 'customer_facing_resolved_to_team_member_phone',
          collision: { table: 'team_members', id: collision.id, phone: collision.phone },
        };
      }
    } else {
      // Cleaner-facing must not match any customer phone in this tenant.
      const { data, error } = await supabase
        .from('customers')
        .select('id, phone')
        .eq('user_id', o.userId)
        .not('phone', 'is', null);
      if (error) {
        if (o.logger && o.logger.warn) {
          o.logger.warn(`[RecipientIntegrity] customers lookup error: ${error.message}`);
        }
        return { verdict: 'ok', reason: 'lookup_error' };
      }
      const collision = (data || []).find((c) => normalizePhone(c.phone) === last10);
      if (collision) {
        return {
          verdict: 'violation',
          reason: 'cleaner_facing_resolved_to_customer_phone',
          collision: { table: 'customers', id: collision.id, phone: collision.phone },
        };
      }
    }
    return { verdict: 'ok', reason: 'no_collision' };
  } catch (err) {
    if (o.logger && o.logger.warn) {
      o.logger.warn(`[RecipientIntegrity] audit threw: ${err && err.message}`);
    }
    return { verdict: 'ok', reason: 'exception' };
  }
}

/**
 * Emit the structured `[NotificationRecipient]` log line.
 *
 * @param {Object} logger  Must expose .log(message)
 * @param {Object} fields  All fields per audit spec. Missing fields default to 'null'.
 *
 * NEVER throws.
 */
function emitNotificationRecipientLog(logger, fields) {
  if (!logger || !logger.log) return;
  const f = fields || {};
  try {
    const parts = [
      `message_type=${f.message_type || 'unknown'}`,
      `resolved_phone=${maskPhone(f.resolved_phone)}`,
      `source=${f.source || 'unknown'}`,
      `fallback_depth=${f.fallback_depth != null ? f.fallback_depth : 0}`,
      `customer_id=${f.customer_id != null ? f.customer_id : 'null'}`,
      `team_member_id=${f.team_member_id != null ? f.team_member_id : 'null'}`,
      `job_id=${f.job_id != null ? f.job_id : 'null'}`,
      `workspace_id=${f.workspace_id != null ? f.workspace_id : 'null'}`,
      `twilio_sid=${f.twilio_sid || 'null'}`,
      `path=${f.path || 'unknown'}`,
    ];
    if (f.result) parts.push(`result=${f.result}`);
    if (f.error) parts.push(`error=${String(f.error).slice(0, 200)}`);
    logger.log(`[NotificationRecipient] ${parts.join(' ')}`);
  } catch (_) {
    // never throw out of logging
  }
}

/**
 * Emit the structured `[RecipientIntegrityViolation]` log line.
 *
 * Called when audit returns verdict='violation'. Caller MUST block the send.
 *
 * @param {Object} logger  Must expose .error(message)
 * @param {Object} fields  All provenance + reason + collision metadata.
 */
function emitRecipientIntegrityViolation(logger, fields) {
  if (!logger || !logger.error) return;
  const f = fields || {};
  try {
    const parts = [
      `message_type=${f.message_type || 'unknown'}`,
      `intent=${f.intent || 'unknown'}`,
      `resolved_phone=${maskPhone(f.resolved_phone)}`,
      `source=${f.source || 'unknown'}`,
      `reason=${f.reason || 'unspecified'}`,
      `customer_id=${f.customer_id != null ? f.customer_id : 'null'}`,
      `team_member_id=${f.team_member_id != null ? f.team_member_id : 'null'}`,
      `collision_table=${f.collision_table || 'null'}`,
      `collision_id=${f.collision_id != null ? f.collision_id : 'null'}`,
      `job_id=${f.job_id != null ? f.job_id : 'null'}`,
      `workspace_id=${f.workspace_id != null ? f.workspace_id : 'null'}`,
      `path=${f.path || 'unknown'}`,
      `action=blocked`,
    ];
    logger.error(`[RecipientIntegrityViolation] ${parts.join(' ')}`);
  } catch (_) {
    // never throw out of logging
  }
}

module.exports = {
  VALID_INTENTS,
  normalizePhone,
  maskPhone,
  auditRecipientIntegrity,
  emitNotificationRecipientLog,
  emitRecipientIntegrityViolation,
};
