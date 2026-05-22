'use strict';

/**
 * ZB Outbound — inbound webhook → outbound command correlation (Phase B).
 *
 * Wired into the ZB webhook handler (zenbooker-sync.js) AFTER the
 * existing handleJobEvent / handlePaymentEvent dispatch completes.
 *
 * Phase B scope: only `job.created` events correlate to `job.create`
 * commands. Other event types (job.rescheduled, job.canceled, etc.)
 * skip correlation — their command types aren't in Phase B.
 *
 * Correlation algorithm (design §3.5):
 *   1. Find open commands matching this echo:
 *      - For job.create → state IN ('sent','confirm_timeout','ambiguous_pending_review')
 *      - AND zenbooker_id = data.id (drainer stamped this on successful POST)
 *      - AND user_id = <tenant resolved by webhook>
 *   2. If exactly one match → transition to 'confirmed'.
 *   3. If multiple matches → mark all 'ambiguous_pending_review'
 *      (shouldn't happen in Phase B since zenbooker_id is unique per
 *      successful create, but defensively coded).
 *   4. If no match → no-op (the echo isn't from any tracked SF intent;
 *      this is the common case — most ZB webhooks come from manager
 *      UI activity, not from SF outbound).
 *
 * The dedup key for the inbound webhook itself remains the existing
 * `data.id` (resource id) — design §3.5 says SF should migrate to
 * body.webhook_id eventually, but Phase B keeps the existing path
 * unchanged for compatibility.
 *
 * NEVER throws.
 */

const { emitConfirmed } = require('./zb-outbound-metrics');

// Command type that maps to each Phase 1 echo event type.
// Phase B only correlates job.created → job.create.
const ECHO_TO_COMMAND_TYPE = Object.freeze({
  'job.created': 'job.create',
  // Future Phase C/D/E:
  // 'job.rescheduled': 'job.reschedule',
  // 'job.canceled': 'job.cancel',
  // 'job.service_providers.assigned': 'job.assign_providers',
  // 'customer.edited': 'customer.upsert',
});

function isCorrelatable(event) {
  return Boolean(ECHO_TO_COMMAND_TYPE[event]);
}

/**
 * Run correlation for one inbound webhook delivery.
 *
 * @param {Object} supabase  Supabase client
 * @param {Object} args
 *   userId            SF user_id resolved by the webhook handler
 *   event             webhook event name (e.g. 'job.created')
 *   data              webhook payload's `data` object
 *   webhookId         the body-level webhook_id (per Q2-B resolution)
 *   logger            defaults to console
 * @returns {Promise<{ correlated: number, ambiguous: number, matched_event_ids: string[] }>}
 */
async function correlateInboundEcho(supabase, args) {
  const logger = (args && args.logger) || console;
  const result = { correlated: 0, ambiguous: 0, matched_event_ids: [] };
  try {
    const { userId, event, data, webhookId } = args || {};
    if (!event || !data || !data.id) return result;

    const commandType = ECHO_TO_COMMAND_TYPE[event];
    if (!commandType) return result;

    if (userId == null) return result;

    // Look up open commands for this zenbooker_id + command_type + tenant
    const { data: candidates, error } = await supabase
      .from('zb_outbound_commands')
      .select('id, event_id, command_type, sf_job_id, user_id, intent_hash, state, sent_at, field_group')
      .eq('user_id', userId)
      .eq('command_type', commandType)
      .eq('zenbooker_id', String(data.id))
      .in('state', ['sent', 'confirm_timeout', 'ambiguous_pending_review']);
    if (error) {
      if (logger.warn) logger.warn(`[ZB Outbound correlation] lookup failed: ${error.message}`);
      return result;
    }
    if (!candidates || candidates.length === 0) {
      return result;
    }

    if (candidates.length === 1) {
      const cmd = candidates[0];
      await confirmCommand(supabase, cmd, webhookId, logger);
      result.correlated = 1;
      result.matched_event_ids.push(cmd.event_id);
      return result;
    }

    // Multiple matches — should not happen for job.create with unique
    // zenbooker_id, but defensively flag all as ambiguous_pending_review.
    for (const cmd of candidates) {
      await supabase
        .from('zb_outbound_commands')
        .update({
          state: 'ambiguous_pending_review',
          conflict_metadata: { reason: 'multiple_matches_on_same_zenbooker_id', candidate_count: candidates.length },
        })
        .eq('id', cmd.id);
      result.matched_event_ids.push(cmd.event_id);
    }
    result.ambiguous = candidates.length;
    if (logger.warn) {
      logger.warn(`[ZB Outbound correlation] ambiguous matches event=${event} zb_id=${data.id} count=${candidates.length}`);
    }
    return result;
  } catch (err) {
    if (logger && logger.warn) {
      logger.warn(`[ZB Outbound correlation] threw (swallowed): ${err && err.message}`);
    }
    return result;
  }
}

async function confirmCommand(supabase, cmd, webhookId, logger) {
  const nowIso = new Date().toISOString();
  const update = {
    state: 'confirmed',
    confirmed_at: nowIso,
    correlation_confidence: 'exact',
  };
  if (webhookId) update.zb_event_id = webhookId;
  await supabase.from('zb_outbound_commands').update(update).eq('id', cmd.id);

  // Latency in ms from sent_at to confirmed_at — emitted as metric for
  // Grafana P50/P95 aggregation
  let latencyMs = null;
  if (cmd.sent_at) {
    const sentMs = Date.parse(cmd.sent_at);
    if (Number.isFinite(sentMs)) latencyMs = Date.now() - sentMs;
  }
  emitConfirmed({
    userId: cmd.user_id,
    commandType: cmd.command_type,
    fieldGroup: cmd.field_group,
    eventId: cmd.event_id,
    latencyMs,
    logger,
  });
  if (logger.log) {
    logger.log(`[ZB Outbound correlation] confirmed event=${cmd.event_id} cmd=${cmd.command_type} latency_ms=${latencyMs == null ? 'unknown' : latencyMs}`);
  }
}

module.exports = {
  correlateInboundEcho,
  confirmCommand,
  isCorrelatable,
  ECHO_TO_COMMAND_TYPE,
};
