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

const {
  mintCredential, revokeCredential, rotateCredential,
  markForRotation, performRefreshRotation,
  resolveSigningKey, getCurrentKid,
} = require('./lb-orchestration-credentials');
const {
  buildConnectionConnectedEvent,
  buildCredentialRotatedEvent,
  buildCredentialRotationRequiredEvent,
} = require('./lb-orchestration-event-builders');
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
 * Rotation flow. Used by admin /credentials/rotate.
 *
 * Order:
 *   1. Snapshot webhook config (so the credential.rotated event delivers
 *      using the current webhook secret even if subsequent state changes).
 *   2. Call rotateCredential primitive (old → rotating w/ 5-min grace,
 *      new → active).
 *   3. Build + enqueue credential.rotated event with new credential
 *      metadata + previous_grace_expires_at.
 *
 * If step 1 finds no webhook configured, skip step 3 (nothing to notify);
 * rotation still completes. The webhook delivery is best-effort; rotation
 * primitive success is the source of truth.
 *
 * The plaintext token is returned in the function result so the calling
 * HTTP handler can echo it to the operator (admin endpoint). It is NEVER
 * included in the outbox payload — the credential.rotated webhook event
 * carries metadata only (cred_id, token_prefix, expires_at). LB receives
 * the new plaintext via its own /credentials/rotate flow (LB-initiated),
 * not via this admin-driven path.
 */
async function performRotation(supabase, args) {
  if (!supabase || typeof supabase.from !== 'function') {
    throw new Error('performRotation: supabase required');
  }
  if (!args || args.userId == null) {
    return { ok: false, reason: 'invalid_arguments' };
  }
  const logger = args.logger || { log() {}, warn() {}, error() {} };
  const userId = Number(args.userId);
  const reason = args.reason || 'scheduled';

  // Step 1 — snapshot webhook config.
  const { data: settingBefore, error: lookupErr } = await supabase
    .from(SETTINGS_TABLE)
    .select('lb_orchestration_webhook_url,lb_orchestration_webhook_secret_enc,lb_orchestration_subscription_id,lb_orchestration_state_ref')
    .eq('user_id', userId)
    .maybeSingle();
  if (lookupErr) {
    return { ok: false, reason: 'db_error', step: 'settings_lookup', dbError: lookupErr.message };
  }
  const hasWebhook = !!(settingBefore && settingBefore.lb_orchestration_webhook_url && settingBefore.lb_orchestration_webhook_secret_enc);

  // Step 2 — perform the rotation.
  const rot = await rotateCredential(supabase, { userId, reason });
  if (!rot.ok) {
    return { ok: false, reason: rot.reason, step: 'rotate' };
  }

  // Step 3 — enqueue credential.rotated (best-effort).
  let eventId = null;
  let eventEnqueued = false;
  if (hasWebhook) {
    const event = buildCredentialRotatedEvent({
      tenantId: userId,
      previousCredentialId: rot.previousCredentialId,
      previousGraceExpiresAt: rot.previousGraceExpiresAt,
      newCredential: {
        credentialId: rot.newCredentialId,
        tokenPrefix:  rot.newTokenPrefix,
        expiresAt:    rot.expiresAt,
      },
      reason,
    });
    eventId = event.event_id;
    const enq = await enqueueOutbox(supabase, {
      userId,
      event,
      webhookUrl:       settingBefore.lb_orchestration_webhook_url,
      webhookSecretEnc: settingBefore.lb_orchestration_webhook_secret_enc,
      subscriptionId:   settingBefore.lb_orchestration_subscription_id || null,
      stateRef:         settingBefore.lb_orchestration_state_ref || null,
    });
    eventEnqueued = !!enq.ok;
    if (!enq.ok) {
      try { logger.warn(`[orch-rotation] outbox enqueue failed user=${userId} reason=${enq.reason}`); } catch (_) {}
    }
  } else {
    try { logger.log(`[orch-rotation] no webhook configured for user=${userId}; rotation completed without enqueue`); } catch (_) {}
  }

  try { logger.log(`[orch-rotation] ok user=${userId} prev=${rot.previousCredentialId} new=${rot.newCredentialId} grace_expires=${rot.previousGraceExpiresAt} event=${eventId || 'none'}`); } catch (_) {}

  return {
    ok:                      true,
    token:                   rot.token,
    newCredentialId:         rot.newCredentialId,
    newTokenPrefix:          rot.newTokenPrefix,
    previousCredentialId:    rot.previousCredentialId,
    previousGraceExpiresAt:  rot.previousGraceExpiresAt,
    issuedAt:                rot.issuedAt,
    expiresAt:               rot.expiresAt,
    event_id:                eventId,
    event_enqueued:          eventEnqueued,
    reason,
  };
}

/**
 * R1B — Mark the tenant's active credential as needing refresh AND
 * enqueue the credential.rotated webhook notification. Used by admin
 * /credentials/mark_for_rotation.
 *
 * Order:
 *   1. Snapshot webhook config.
 *   2. Call markForRotation primitive (sets needs_refresh_at on active row).
 *   3. Build credential.rotated event (refresh_required: true variant).
 *   4. Enqueue to outbox. Drainer delivers; LB triggers /refresh on receipt.
 *
 * Idempotent: if marker already set, returns the existing timestamp
 * (already_marked). Caller decides whether to re-emit the event.
 */
async function performMarkForRotation(supabase, args) {
  if (!supabase || typeof supabase.from !== 'function') {
    throw new Error('performMarkForRotation: supabase required');
  }
  if (!args || args.userId == null) {
    return { ok: false, reason: 'invalid_arguments' };
  }
  const logger = args.logger || { log() {}, warn() {}, error() {} };
  const userId = Number(args.userId);
  const reason = args.reason || 'operator_request';

  // Step 1 — snapshot webhook config.
  const { data: settingBefore, error: lookupErr } = await supabase
    .from(SETTINGS_TABLE)
    .select('lb_orchestration_webhook_url,lb_orchestration_webhook_secret_enc,lb_orchestration_subscription_id,lb_orchestration_state_ref')
    .eq('user_id', userId)
    .maybeSingle();
  if (lookupErr) {
    return { ok: false, reason: 'db_error', step: 'settings_lookup', dbError: lookupErr.message };
  }
  const hasWebhook = !!(settingBefore && settingBefore.lb_orchestration_webhook_url && settingBefore.lb_orchestration_webhook_secret_enc);

  // Step 2 — set the marker.
  const mark = await markForRotation(supabase, { userId });
  if (!mark.ok && mark.reason !== 'already_marked') {
    return { ok: false, reason: mark.reason, step: 'mark', dbError: mark.dbError };
  }
  // mark.credentialId is set in both ok and already_marked cases.

  // Step 3 — build event.
  let eventId = null;
  let eventEnqueued = false;
  if (hasWebhook) {
    const event = buildCredentialRotationRequiredEvent({
      tenantId:            userId,
      currentCredentialId: mark.credentialId,
      reason,
    });
    eventId = event.event_id;
    const enq = await enqueueOutbox(supabase, {
      userId,
      event,
      webhookUrl:       settingBefore.lb_orchestration_webhook_url,
      webhookSecretEnc: settingBefore.lb_orchestration_webhook_secret_enc,
      subscriptionId:   settingBefore.lb_orchestration_subscription_id || null,
      stateRef:         settingBefore.lb_orchestration_state_ref || null,
    });
    eventEnqueued = !!enq.ok;
    if (!enq.ok) {
      try { logger.warn(`[orch-mark-rotation] outbox enqueue failed user=${userId} reason=${enq.reason}`); } catch (_) {}
    } else if (enq.duplicate) {
      // UNIQUE event_id absorbed — LB already has an outstanding mark event for this cred. Idempotent.
      try { logger.log(`[orch-mark-rotation] event_id duplicate (idempotent) user=${userId} event=${eventId}`); } catch (_) {}
    }
  } else {
    try { logger.log(`[orch-mark-rotation] no webhook configured for user=${userId}; marker set but no event enqueued`); } catch (_) {}
  }

  try { logger.log(`[orch-mark-rotation] ok user=${userId} cred=${mark.credentialId} needs_refresh_at=${mark.needsRefreshAt} event=${eventId || 'none'} already_marked=${mark.reason === 'already_marked'}`); } catch (_) {}

  return {
    ok:                true,
    credentialId:      mark.credentialId,
    needsRefreshAt:    mark.needsRefreshAt,
    alreadyMarked:     mark.reason === 'already_marked',
    event_id:          eventId,
    event_enqueued:    eventEnqueued,
    reason,
  };
}

/**
 * R1B — LB-facing pull-style refresh. Used by
 * POST /api/integrations/leadbridge/orchestration/credentials/refresh.
 *
 * Caller is the LB tenant runtime, authenticated via the current
 * orchestration bearer (req.user.cred_id from authenticateOrchestrationToken).
 *
 * Returns the new plaintext token ONCE. Subsequent calls return 409.
 *
 * Returns:
 *   { ok: true, credential: {token, token_prefix, kid, scope, issued_at, expires_at},
 *               rotation:   {previous_credential_id, previous_grace_expires_at, reason} }
 *   { ok: false, reason }   — caller maps to HTTP (409 / 410 / 503)
 */
async function performRefresh(supabase, args) {
  if (!supabase || typeof supabase.from !== 'function') {
    throw new Error('performRefresh: supabase required');
  }
  if (!args || args.userId == null || args.bearerCredentialId == null) {
    return { ok: false, reason: 'invalid_arguments' };
  }
  const logger = args.logger || { log() {}, warn() {}, error() {} };
  const userId       = Number(args.userId);
  const bearerCredId = Number(args.bearerCredentialId);
  const reason       = args.reason || 'lb_initiated';

  // Check connection state first. If disconnected, return 410.
  const { data: setting, error: settingErr } = await supabase
    .from(SETTINGS_TABLE)
    .select('leadbridge_connected,lb_orchestration_enabled_at')
    .eq('user_id', userId)
    .maybeSingle();
  if (settingErr) {
    return { ok: false, reason: 'db_error', step: 'settings_lookup', dbError: settingErr.message };
  }
  if (!setting || setting.leadbridge_connected !== true || !setting.lb_orchestration_enabled_at) {
    return { ok: false, reason: 'connection_revoked' };
  }

  // Delegate to the gated rotation primitive.
  const out = await performRefreshRotation(supabase, {
    userId,
    bearerCredentialId: bearerCredId,
    reason,
  });

  if (!out.ok) {
    try { logger.log(`[orch-refresh] refused user=${userId} bearer_cred=${bearerCredId} reason=${out.reason}`); } catch (_) {}
    return out;
  }

  try { logger.log(`[orch-refresh] rotated user=${userId} prev=${out.previousCredentialId} new=${out.newCredentialId} prefix=${out.newTokenPrefix}`); } catch (_) {}

  return {
    ok: true,
    credential: {
      token:        out.token,
      token_prefix: out.newTokenPrefix,
      kid:          getCurrentKid(),
      scope:        'lb_orchestration',
      issued_at:    out.issuedAt,
      expires_at:   out.expiresAt,
    },
    rotation: {
      previous_credential_id:    out.previousCredentialId,
      previous_grace_expires_at: out.previousGraceExpiresAt,
      reason,
    },
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
  performRotation,            // force-rotate (admin /credentials/rotate)
  performMarkForRotation,     // R1B: mark + notify (admin /credentials/mark_for_rotation)
  performRefresh,             // R1B: LB-facing /orchestration/credentials/refresh
  performDisconnect,
  enqueueOutbox,
  OUTBOX_TABLE,
};
