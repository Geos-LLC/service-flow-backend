'use strict';

// S4 — Atomic handshake.
//
// Used by both:
//   - POST /api/integrations/leadbridge/oauth/exchange  (OAuth code grant)
//   - POST /api/integrations/leadbridge/connect         (canary path)
//
// Both endpoints converge on the same effective transaction:
//
//   1. Mint a fresh active credential for the tenant.
//   2. Set leadbridge_connected=true + lb_orchestration_enabled_at=now()
//      + persist webhook_url + encrypted webhook_secret + subscription_id/state_ref.
//   3. Enqueue a connection.connected event into lb_orchestration_outbox
//      (best-effort; not part of atomicity).
//
// Supabase JS does not expose multi-statement transactions, so the
// "atomicity" here is best-effort + compensating writes:
//   - If credential mint fails: nothing committed.
//   - If credential mint succeeds but settings update fails: we revoke
//     the freshly-minted credential (compensating action) before
//     returning the error.
//   - If both succeed but outbox enqueue fails: handshake still
//     reports success (the connection IS live) but the operator should
//     re-enqueue manually. This is acceptable because:
//       (a) connection.connected is informational, not critical for
//           tenant-facing orchestration to function.
//       (b) the alternative — failing the handshake because of a
//           messaging blip — would phantom-disconnect a working tenant.
//
// Hard rules:
//   - No webhook is delivered synchronously. The drainer picks up
//     connection.connected on its next tick.
//   - Caller (HTTP handler) is responsible for code consumption +
//     client_secret verification BEFORE invoking performHandshake.
//   - Caller validates webhook url + secret via lb-orchestration-clients
//     helpers BEFORE invoking performHandshake. This function trusts
//     its inputs.

const { mintCredential, revokeCredential, resolveSigningKey, getCurrentKid } = require('./lb-orchestration-credentials');
const { buildConnectionConnectedEvent } = require('./lb-orchestration-event-builders');
const { encryptIntegrationSecret } = require('../services/lb-encryption');

const SETTINGS_TABLE = 'communication_settings';
const OUTBOX_TABLE   = 'lb_orchestration_outbox';

/**
 * Run the handshake.
 *
 * @param {object} supabase
 * @param {object} args
 * @param {number} args.userId
 * @param {string} args.webhookUrl
 * @param {string} args.webhookSecret  — already validated by caller (≥32B base64)
 * @param {string} [args.subscriptionId]
 * @param {string} [args.stateRef]
 * @param {string} [args.kid]          — defaults to getCurrentKid()
 * @param {string} [args.createdBy='handshake']
 * @param {object} [args.logger]
 * @returns {Promise<{ ok: true, credential, settings, event_id, event_enqueued } | { ok: false, reason, step? }>}
 */
async function performHandshake(supabase, args) {
  if (!supabase || typeof supabase.from !== 'function') {
    throw new Error('performHandshake: supabase required');
  }
  if (!args || args.userId == null || !args.webhookUrl || !args.webhookSecret) {
    return { ok: false, reason: 'invalid_arguments' };
  }

  const logger = args.logger || { log() {}, warn() {}, error() {} };
  const userId = Number(args.userId);
  const kid    = args.kid || getCurrentKid();

  // Sanity: signing key must be configured for this kid. If not, fail
  // BEFORE mutating anything.
  if (!resolveSigningKey(kid)) {
    return { ok: false, reason: 'signing_key_not_configured', step: 'preflight', kid };
  }

  // Settings row must exist. Refuse to auto-create — production tenants
  // always have a row (signup creates it). Canary test fixtures must
  // pre-create.
  const { data: settingRow, error: settingLookupErr } = await supabase
    .from(SETTINGS_TABLE)
    .select('user_id,leadbridge_connected,leadbridge_connected_at,lb_orchestration_enabled_at,lb_orchestration_webhook_url,lb_orchestration_webhook_secret_enc')
    .eq('user_id', userId)
    .maybeSingle();
  if (settingLookupErr) {
    return { ok: false, reason: 'db_error', step: 'settings_lookup', dbError: settingLookupErr.message };
  }
  if (!settingRow) {
    return { ok: false, reason: 'communication_settings_not_found', step: 'preflight' };
  }

  // Step 1 — mint credential.
  const minted = await mintCredential(supabase, {
    userId,
    kid,
    createdBy: args.createdBy || 'handshake',
  });
  if (!minted.ok) {
    if (minted.reason === 'active_credential_already_exists') {
      return { ok: false, reason: 'already_connected', step: 'mint' };
    }
    if (minted.reason === 'signing_key_not_configured') {
      return { ok: false, reason: 'signing_key_not_configured', step: 'mint', kid };
    }
    return { ok: false, reason: `mint_failed:${minted.reason}`, step: 'mint' };
  }

  // Step 2 — persist webhook + flip enablement in one UPDATE.
  let encryptedSecret;
  try {
    encryptedSecret = encryptIntegrationSecret(args.webhookSecret);
  } catch (err) {
    // Compensate.
    await rollbackCredential(supabase, userId, 'handshake_encrypt_failed', logger);
    return { ok: false, reason: 'encryption_failed', step: 'encrypt', error: String(err && err.message || err) };
  }

  const nowIso = new Date().toISOString();
  const updatePayload = {
    leadbridge_connected:                true,
    leadbridge_connected_at:             settingRow.leadbridge_connected_at || nowIso,
    lb_orchestration_enabled_at:         nowIso,
    lb_orchestration_webhook_url:        args.webhookUrl,
    lb_orchestration_webhook_secret_enc: encryptedSecret,
    lb_orchestration_webhook_set_at:     nowIso,
  };
  if (args.subscriptionId) updatePayload.lb_orchestration_subscription_id = String(args.subscriptionId);
  if (args.stateRef)        updatePayload.lb_orchestration_state_ref       = String(args.stateRef);

  const { data: updatedSetting, error: updateErr } = await supabase
    .from(SETTINGS_TABLE)
    .update(updatePayload)
    .eq('user_id', userId)
    .select('user_id,leadbridge_connected,lb_orchestration_enabled_at,lb_orchestration_webhook_url,lb_orchestration_webhook_set_at,lb_orchestration_subscription_id,lb_orchestration_state_ref')
    .maybeSingle();

  if (updateErr) {
    // Compensate.
    await rollbackCredential(supabase, userId, 'handshake_settings_update_failed', logger);
    return { ok: false, reason: 'db_error', step: 'settings_update', dbError: updateErr.message };
  }

  // Step 3 — enqueue connection.connected (best-effort).
  const event = buildConnectionConnectedEvent({
    tenantId:     userId,
    connectedAt:  nowIso,
    webhookSetAt: nowIso,
    credential: {
      credentialId: minted.credentialId,
      tokenPrefix:  minted.tokenPrefix,
      kid:          minted.kid,
      expiresAt:    minted.expiresAt,
    },
  });

  const enqueueRes = await enqueueOutbox(supabase, {
    userId,
    event,
    webhookUrl:      args.webhookUrl,
    webhookSecretEnc: encryptedSecret,
    subscriptionId:   args.subscriptionId || null,
    stateRef:         args.stateRef || null,
  });

  if (!enqueueRes.ok) {
    try { logger.warn(`[orch-handshake] outbox enqueue failed user=${userId} eid=${event.event_id} reason=${enqueueRes.reason}`); } catch (_) {}
  }

  try { logger.log(`[orch-handshake] connected user=${userId} cred=${minted.credentialId} prefix=${minted.tokenPrefix}`); } catch (_) {}

  return {
    ok: true,
    credential: {
      credentialId: minted.credentialId,
      tokenPrefix:  minted.tokenPrefix,
      kid:          minted.kid,
      issuedAt:     minted.issuedAt,
      expiresAt:    minted.expiresAt,
      token:        minted.token,         // plaintext — returned ONCE
    },
    settings: updatedSetting,
    event_id:        event.event_id,
    event_enqueued:  !!enqueueRes.ok,
  };
}

/**
 * Disconnect flow. Used by augmented DELETE /disconnect.
 *
 * Order (matters for refinement: emit connection.revoked BEFORE clearing webhook):
 *   1. Snapshot current webhook url + encrypted secret from settings.
 *   2. Enqueue connection.revoked event with that snapshot. The
 *      drainer will deliver the event using the snapshotted secret,
 *      regardless of subsequent state mutations.
 *   3. Revoke active + rotating credentials.
 *   4. Clear webhook + enablement fields on settings.
 *
 * If step 1 finds no webhook configured, skip step 2 (nothing to notify).
 * If any step after 1 fails, partial state is exposed — but the gate
 * is closed because credentials are revoked / about to be revoked.
 */
async function performDisconnect(supabase, args) {
  if (!supabase || typeof supabase.from !== 'function') {
    throw new Error('performDisconnect: supabase required');
  }
  if (!args || args.userId == null) {
    return { ok: false, reason: 'invalid_arguments' };
  }
  const logger = args.logger || { log() {}, warn() {}, error() {} };
  const userId = Number(args.userId);
  const actor  = args.actor  || 'service_flow';
  const reason = args.reason || 'disconnect';

  // Step 1 — snapshot webhook before any mutation.
  const { data: settingBefore, error: lookupErr } = await supabase
    .from(SETTINGS_TABLE)
    .select('lb_orchestration_webhook_url,lb_orchestration_webhook_secret_enc,lb_orchestration_subscription_id,lb_orchestration_state_ref')
    .eq('user_id', userId)
    .maybeSingle();
  if (lookupErr) {
    return { ok: false, reason: 'db_error', step: 'settings_lookup', dbError: lookupErr.message };
  }

  const hadWebhook = !!(settingBefore && settingBefore.lb_orchestration_webhook_url && settingBefore.lb_orchestration_webhook_secret_enc);

  // Step 2 — enqueue connection.revoked BEFORE we clear webhook config.
  let eventId = null;
  if (hadWebhook) {
    const { buildConnectionRevokedEvent } = require('./lb-orchestration-event-builders');
    const event = buildConnectionRevokedEvent({
      tenantId: userId,
      actor,
      reason,
      revokedAtMs: Date.now(),
    });
    const enq = await enqueueOutbox(supabase, {
      userId,
      event,
      webhookUrl:       settingBefore.lb_orchestration_webhook_url,
      webhookSecretEnc: settingBefore.lb_orchestration_webhook_secret_enc,
      subscriptionId:   settingBefore.lb_orchestration_subscription_id || null,
      stateRef:         settingBefore.lb_orchestration_state_ref || null,
    });
    eventId = event.event_id;
    if (!enq.ok) {
      try { logger.warn(`[orch-disconnect] outbox enqueue failed user=${userId} reason=${enq.reason}`); } catch (_) {}
    }
  }

  // Step 3 — revoke credentials.
  const revoked = await revokeCredential(supabase, { userId, reason });

  // Step 4 — clear webhook + enablement state.
  const { error: clearErr } = await supabase
    .from(SETTINGS_TABLE)
    .update({
      leadbridge_connected:                false,
      lb_orchestration_enabled_at:         null,
      lb_orchestration_webhook_url:        null,
      lb_orchestration_webhook_secret_enc: null,
      lb_orchestration_webhook_set_at:     null,
      lb_orchestration_subscription_id:    null,
      lb_orchestration_state_ref:          null,
    })
    .eq('user_id', userId);

  if (clearErr) {
    try { logger.error(`[orch-disconnect] settings clear failed user=${userId}: ${clearErr.message}`); } catch (_) {}
    return {
      ok: false,
      reason: 'db_error',
      step: 'settings_clear',
      dbError: clearErr.message,
      revoked_count: revoked.revokedCount || 0,
      event_id: eventId,
    };
  }

  try { logger.log(`[orch-disconnect] ok user=${userId} revoked=${revoked.revokedCount} event=${eventId || 'none'}`); } catch (_) {}

  return {
    ok:            true,
    revoked_count: revoked.revokedCount || 0,
    revoked_ids:   revoked.revokedIds   || [],
    event_id:      eventId,
    event_enqueued: !!eventId,
    actor,
    reason,
  };
}

// ─────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────

async function rollbackCredential(supabase, userId, reason, logger) {
  try {
    const r = await revokeCredential(supabase, { userId, reason });
    try { logger.warn(`[orch-handshake] rolled back credential user=${userId} revoked=${r.revokedCount} reason=${reason}`); } catch (_) {}
  } catch (err) {
    try { logger.error(`[orch-handshake] rollback failed user=${userId}: ${err && err.message}`); } catch (_) {}
  }
}

/**
 * Insert an event into the orchestration outbox. Idempotent on
 * event_id (UNIQUE) — re-enqueues are absorbed.
 */
async function enqueueOutbox(supabase, args) {
  if (!args || !args.event || !args.event.event_id) {
    return { ok: false, reason: 'invalid_event' };
  }
  const row = {
    user_id:             Number(args.userId),
    event_id:            args.event.event_id,
    event_type:          args.event.event_type,
    payload_json:        args.event,
    webhook_url:         args.webhookUrl,
    webhook_secret_enc:  args.webhookSecretEnc,
    subscription_id:     args.subscriptionId,
    state_ref:           args.stateRef,
    state:               'pending',
    attempts:            0,
    next_attempt_at:     new Date().toISOString(),
  };
  const { error } = await supabase.from(OUTBOX_TABLE).insert(row);
  if (error) {
    if (error.code === '23505') {
      // UNIQUE violation on event_id — already enqueued. Idempotent success.
      return { ok: true, duplicate: true };
    }
    return { ok: false, reason: 'db_error', dbError: error.message };
  }
  return { ok: true };
}

module.exports = {
  performHandshake,
  performDisconnect,
  enqueueOutbox,
  OUTBOX_TABLE,
};
