'use strict';

// SF-initiated, server-to-server orchestration provisioning.
//
// Triggered by the Communication Hub Connect flow. Replaces the
// browser-OAuth handshake (/authorize → /oauth/consent → /oauth/exchange)
// for tenant-driven Connect; the OAuth surface remains in the codebase
// but is not the default tenant path.
//
// Flow (matches the approved spec):
//
//   1. SF caller hands us { tenantId, lbEmail, lbPassword }.
//   2. We POST LB /v1/integrations/sf/verify-credentials (HMAC-signed):
//        { email, password, sf_tenant_id, sf_source_instance }
//      LB validates the credentials and returns:
//        { ok: true, link_token, link_token_expires_at, lb_user_id, lb_account_name? }
//   3. We mintCredential() — produces a fresh active SF orchestration
//      credential (sfo_v1...) for the tenant.
//   4. We POST LB /v1/integrations/sf/provision (HMAC-signed):
//        { link_token, sf_tenant_metadata, sf_credential, sf_endpoints,
//          sf_signature_metadata, sf_event_types }
//      LB consumes the link_token (single-use), stores sf_connection
//      keyed by lb_user_id + sf_tenant_id, and returns:
//        { ok: true, webhook_url, webhook_secret, subscription_id?,
//          state_ref?, lb_account_id, lb_account_name }
//   5. We encryptIntegrationSecret(webhook_secret) and UPDATE
//      communication_settings with the orchestration columns.
//   6. We enqueue connection.connected to the outbox (the drainer
//      delivers asynchronously).
//
// HARD RULES:
//   - Password is forwarded ONCE in the verify-credentials body and
//     never logged or stored. The wrapper at /connect MUST scrub it
//     from any error logging.
//   - Plaintext credential token is sent to LB once (provision body)
//     and is never logged.
//   - Plaintext webhook secret returned by LB is encrypted before any
//     DB write and never logged.
//   - On any step-3+ failure we compensate by revoking the freshly-
//     minted credential (matches performHandshake's pattern).
//   - One SF tenant per LB user enforced LB-side via sf_connection
//     uniqueness; SF surfaces LB's `already_connected_elsewhere`
//     verbatim on conflict.

const axios = require('axios');

const {
  mintCredential,
  revokeCredential,
  getCurrentKid,
} = require('./lb-orchestration-credentials');
const { buildConnectionConnectedEvent } = require('./lb-orchestration-event-builders');
const { enqueueOutbox } = require('./lb-orchestration-handshake');
const { buildProvisioningHeaders } = require('./lb-provisioning-sign');
const { encryptIntegrationSecret } = require('../services/lb-encryption');

const SETTINGS_TABLE = 'communication_settings';

const DEFAULT_LB_BASE       = 'https://thumbtack-bridge-production.up.railway.app/api';
const VERIFY_CREDS_PATH     = '/v1/integrations/sf/verify-credentials';
const PROVISION_PATH        = '/v1/integrations/sf/provision';
const DEFAULT_TIMEOUT_MS    = 30_000;

// SF endpoints exposed to LB in the provisioning payload. Same shape as
// lib/lb-orchestration-provisioning-payload.js — duplicated here so the
// direct-provision path has no dependency on the OAuth provisioning
// builder.
const SF_ENDPOINTS = {
  availability:        '/api/integrations/leadbridge/orchestration/availability',
  booking_request:     '/api/integrations/leadbridge/orchestration/booking-request',
  booking_cancel:      '/api/integrations/leadbridge/orchestration/booking-cancel',
  handoff:             '/api/integrations/leadbridge/orchestration/handoff',
  credentials_refresh: '/api/integrations/leadbridge/orchestration/credentials/refresh',
  disconnect:          '/api/integrations/leadbridge/disconnect',
};

const SF_EVENT_TYPES = [
  'service_scheduled',
  'service_rescheduled',
  'service_cancelled',
  'service_completed',
  'connection.connected',
  'credential.rotated',
  'connection.revoked',
];

function buildSfSignatureMetadata() {
  return {
    algorithm:             'hmac-sha256-hex',
    signed_string_format:  '${X-SF-Timestamp}.${raw_body}',
    body_canonical_form:   'timestamp_dot_raw_utf8_request_body',
    timestamp_format:      'unix_seconds',
    timestamp_example:     '1780011918',
    headers: {
      signature:  'X-SF-Signature',
      timestamp:  'X-SF-Timestamp',
      event_id:   'X-SF-Event-Id',
      event_type: 'X-SF-Event-Type',
      tenant_id:  'X-SF-Tenant-Id',
      kid:        'X-SF-Kid',
    },
    max_clock_skew_seconds: 300,
  };
}

function lbBaseUrl() {
  return process.env.LB_PROVISIONING_BASE_URL || process.env.LEADBRIDGE_URL || DEFAULT_LB_BASE;
}

function sfBaseUrl() {
  return process.env.SF_PUBLIC_BASE_URL
    || 'https://service-flow-backend-production-4568.up.railway.app';
}

function sourceInstance() {
  return process.env.SF_SOURCE_INSTANCE || 'sf-staging';
}

/**
 * POST an HMAC-signed JSON body to LB. Returns { ok, status, data } on
 * any HTTP response (2xx or 4xx/5xx). Returns { ok:false, networkError }
 * if the request never completed (DNS, timeout, etc.).
 *
 * Never logs the body. Caller is responsible for redacting if logging
 * the result.
 */
async function postSigned(url, bodyObject, { httpClient = axios, timeoutMs = DEFAULT_TIMEOUT_MS, now = new Date() } = {}) {
  let bodyString;
  try {
    bodyString = JSON.stringify(bodyObject);
  } catch (e) {
    return { ok: false, networkError: true, reason: 'body_serialize_failed' };
  }
  let signed;
  try {
    signed = buildProvisioningHeaders({ body: bodyString, now });
  } catch (e) {
    return { ok: false, networkError: true, reason: 'sign_failed', error: String(e && e.message || e) };
  }
  let res;
  try {
    res = await httpClient({
      method: 'POST',
      url,
      headers: signed.headers,
      data: signed.body,
      timeout: timeoutMs,
      // Don't throw on 4xx/5xx — we want to inspect.
      validateStatus: () => true,
      transformRequest: [(d) => d],   // we already serialized
    });
  } catch (e) {
    return { ok: false, networkError: true, reason: 'request_failed', error: String(e && e.message || e) };
  }
  return {
    ok:     res.status >= 200 && res.status < 300,
    status: res.status,
    data:   res.data,
  };
}

/**
 * Step 1 — Verify LB credentials. Returns the link_token on success.
 *
 * @param {object} args
 * @param {number} args.tenantId
 * @param {string} args.lbEmail
 * @param {string} args.lbPassword
 * @param {object} [args.httpClient]
 * @param {Date}   [args.now]
 * @returns {Promise<
 *   { ok: true, linkToken: string, lbUserId: string, lbAccountName?: string, expiresAt?: string }
 *   | { ok: false, status?: number, reason: string, errorDescription?: string }
 * >}
 */
async function verifyLbCredentials(args) {
  if (!args || args.tenantId == null) return { ok: false, reason: 'invalid_arguments' };
  if (typeof args.lbEmail !== 'string' || !args.lbEmail) return { ok: false, reason: 'lb_email_required' };
  if (typeof args.lbPassword !== 'string' || !args.lbPassword) return { ok: false, reason: 'lb_password_required' };

  const url = `${lbBaseUrl()}${VERIFY_CREDS_PATH}`;
  const body = {
    email:               args.lbEmail,
    password:            args.lbPassword,
    sf_tenant_id:        Number(args.tenantId),
    sf_source_instance:  sourceInstance(),
  };

  const res = await postSigned(url, body, { httpClient: args.httpClient, now: args.now });
  if (res.networkError) {
    return { ok: false, reason: 'lb_unreachable', errorDescription: res.reason };
  }
  if (!res.ok) {
    const data = res.data && typeof res.data === 'object' ? res.data : {};
    return {
      ok:               false,
      status:           res.status,
      reason:           data.error || (res.status === 401 ? 'invalid_credentials' : 'lb_verify_failed'),
      errorDescription: data.error_description || null,
    };
  }
  const d = res.data || {};
  if (!d.link_token || !d.lb_user_id) {
    return { ok: false, status: res.status, reason: 'lb_verify_malformed_response' };
  }
  return {
    ok:            true,
    linkToken:     String(d.link_token),
    lbUserId:      String(d.lb_user_id),
    lbAccountName: d.lb_account_name || null,
    expiresAt:     d.link_token_expires_at || null,
  };
}

/**
 * Step 3 — Provision the connection on LB. Sends the credential plaintext
 * and SF metadata. LB returns webhook URL + secret.
 *
 * @param {object} args
 * @param {string} args.linkToken
 * @param {number} args.tenantId
 * @param {string} [args.tenantName]
 * @param {string} [args.tenantEmail]
 * @param {{ token: string, tokenPrefix: string, kid: string, issuedAt: string, expiresAt: string }} args.credential
 * @param {object} [args.httpClient]
 * @param {Date}   [args.now]
 * @returns {Promise<
 *   { ok: true, webhookUrl: string, webhookSecret: string, subscriptionId?: string, stateRef?: string, lbAccountId: string, lbAccountName?: string }
 *   | { ok: false, status?: number, reason: string, errorDescription?: string }
 * >}
 */
async function provisionWithLb(args) {
  if (!args || !args.linkToken)        return { ok: false, reason: 'link_token_required' };
  if (args.tenantId == null)           return { ok: false, reason: 'tenant_id_required' };
  if (!args.credential || !args.credential.token) {
    return { ok: false, reason: 'credential_required' };
  }

  const url = `${lbBaseUrl()}${PROVISION_PATH}`;
  // Body shape matches the OAuth /oauth/exchange provisioning payload
  // (lib/lb-orchestration-provisioning-payload.js) so LB can validate
  // both flows against a single schema. Top-level fields are
  // unprefixed: `version`, `tenant`, `credential`, `endpoints`,
  // `signature_metadata`, `event_types`. `link_token` is the only
  // direct-provision-specific top-level field.
  const body = {
    version: '1',
    link_token: args.linkToken,
    tenant: {
      sf_tenant_id:    Number(args.tenantId),
      sf_tenant_name:  args.tenantName  || null,
      sf_tenant_email: args.tenantEmail || null,
      sf_workspace_id: Number(args.tenantId),
      sf_base_url:     sfBaseUrl(),
      source_instance: sourceInstance(),
    },
    credential: {
      token:        args.credential.token,
      token_prefix: args.credential.tokenPrefix,
      kid:          args.credential.kid,
      scope:        'lb_orchestration',
      issued_at:    args.credential.issuedAt,
      expires_at:   args.credential.expiresAt,
    },
    endpoints:          SF_ENDPOINTS,
    signature_metadata: buildSfSignatureMetadata(),
    event_types:        SF_EVENT_TYPES,
  };

  const res = await postSigned(url, body, { httpClient: args.httpClient, now: args.now });
  if (res.networkError) {
    return { ok: false, reason: 'lb_unreachable', errorDescription: res.reason };
  }
  if (!res.ok) {
    const data = res.data && typeof res.data === 'object' ? res.data : {};
    // Special-case LB's "already connected elsewhere" so the SF caller
    // can surface a precise UX message.
    const code = data.error
      || (res.status === 409 ? 'already_connected_elsewhere'
        : res.status === 401 ? 'link_token_invalid'
        : 'lb_provision_failed');
    return {
      ok:               false,
      status:           res.status,
      reason:           code,
      errorDescription: data.error_description || null,
    };
  }
  const d = res.data || {};
  if (!d.webhook_url || !d.webhook_secret || !d.lb_account_id) {
    return { ok: false, status: res.status, reason: 'lb_provision_malformed_response' };
  }
  return {
    ok:             true,
    webhookUrl:     String(d.webhook_url),
    webhookSecret:  String(d.webhook_secret),
    subscriptionId: d.subscription_id || null,
    stateRef:       d.state_ref       || null,
    lbAccountId:    String(d.lb_account_id),
    lbAccountName:  d.lb_account_name || null,
  };
}

/**
 * Top-level orchestrator. Verify → mint → provision → persist → enqueue.
 *
 * Compensating actions on failure are spelled out in step comments.
 *
 * @param {object} supabase
 * @param {object} args
 * @param {number} args.tenantId
 * @param {string} args.lbEmail
 * @param {string} args.lbPassword
 * @param {string} [args.tenantName]
 * @param {string} [args.tenantEmail]
 * @param {object} [args.logger]
 * @param {object} [args.httpClient]    — for tests
 * @param {Date}   [args.now]           — for tests
 * @returns {Promise<
 *   { ok: true, credential: {credentialId,tokenPrefix,kid,issuedAt,expiresAt}, lbAccountId: string, lbAccountName?: string, webhookUrl: string, subscriptionId?: string, stateRef?: string, event_id: string, event_enqueued: boolean }
 *   | { ok: false, reason: string, step: string, status?: number, errorDescription?: string }
 * >}
 */
async function performDirectProvision(supabase, args) {
  if (!supabase || typeof supabase.from !== 'function') {
    throw new Error('performDirectProvision: supabase required');
  }
  if (!args || args.tenantId == null)               return { ok: false, reason: 'invalid_arguments', step: 'preflight' };
  if (typeof args.lbEmail !== 'string' || !args.lbEmail) return { ok: false, reason: 'lb_email_required', step: 'preflight' };
  if (typeof args.lbPassword !== 'string' || !args.lbPassword) return { ok: false, reason: 'lb_password_required', step: 'preflight' };

  const logger = args.logger || { log() {}, warn() {}, error() {} };
  const tenantId = Number(args.tenantId);

  // Preflight: shared secret + signing key must be configured.
  try {
    require('./lb-provisioning-sign').getSharedSecret();
  } catch (e) {
    return { ok: false, reason: 'shared_secret_not_configured', step: 'preflight' };
  }

  // Step 0: communication_settings row must exist (signup creates it).
  // performHandshake also checks; we replicate so we don't even bother
  // calling LB if the SF row is missing.
  const { data: settingRow, error: settingLookupErr } = await supabase
    .from(SETTINGS_TABLE)
    .select('user_id,leadbridge_connected,leadbridge_connected_at,lb_orchestration_enabled_at,lb_orchestration_webhook_url')
    .eq('user_id', tenantId)
    .maybeSingle();
  if (settingLookupErr) {
    return { ok: false, reason: 'db_error', step: 'settings_lookup', errorDescription: settingLookupErr.message };
  }
  if (!settingRow) {
    return { ok: false, reason: 'communication_settings_not_found', step: 'preflight' };
  }
  if (settingRow.lb_orchestration_enabled_at) {
    return { ok: false, reason: 'already_provisioned', step: 'preflight' };
  }

  // Step 1 — verify with LB.
  const verify = await verifyLbCredentials({
    tenantId, lbEmail: args.lbEmail, lbPassword: args.lbPassword,
    httpClient: args.httpClient, now: args.now,
  });
  if (!verify.ok) {
    try { logger.warn(`[orch-direct] verify failed tenant=${tenantId} reason=${verify.reason} status=${verify.status || ''}`); } catch (_) {}
    return { ok: false, reason: verify.reason, step: 'verify_credentials', status: verify.status, errorDescription: verify.errorDescription };
  }

  // Step 2 — mint credential.
  const kid = args.kid || getCurrentKid();
  const minted = await mintCredential(supabase, {
    userId: tenantId,
    kid,
    createdBy: args.createdBy || 'direct_provision',
  });
  if (!minted.ok) {
    if (minted.reason === 'active_credential_already_exists') {
      // Race: someone else minted between our preflight and now.
      return { ok: false, reason: 'already_provisioned', step: 'mint' };
    }
    if (minted.reason === 'signing_key_not_configured') {
      return { ok: false, reason: 'signing_key_not_configured', step: 'mint' };
    }
    return { ok: false, reason: `mint_failed:${minted.reason}`, step: 'mint' };
  }

  // Step 3 — provision on LB. Sends credential plaintext + link_token.
  const provision = await provisionWithLb({
    linkToken:   verify.linkToken,
    tenantId,
    tenantName:  args.tenantName,
    tenantEmail: args.tenantEmail,
    credential: {
      token:        minted.token,
      tokenPrefix:  minted.tokenPrefix,
      kid:          minted.kid,
      issuedAt:     minted.issuedAt,
      expiresAt:    minted.expiresAt,
    },
    httpClient: args.httpClient, now: args.now,
  });
  if (!provision.ok) {
    // Compensate: revoke the freshly-minted credential.
    await rollbackCredential(supabase, tenantId, `provision_failed_${provision.reason}`, logger);
    try { logger.warn(`[orch-direct] provision failed tenant=${tenantId} reason=${provision.reason} status=${provision.status || ''}`); } catch (_) {}
    return { ok: false, reason: provision.reason, step: 'provision', status: provision.status, errorDescription: provision.errorDescription };
  }

  // Step 4 — encrypt webhook secret + persist + enable + enqueue.
  let webhookSecretEnc;
  try {
    webhookSecretEnc = encryptIntegrationSecret(provision.webhookSecret);
  } catch (err) {
    await rollbackCredential(supabase, tenantId, 'encrypt_webhook_secret_failed', logger);
    return { ok: false, reason: 'encryption_failed', step: 'encrypt', errorDescription: String(err && err.message || err) };
  }

  const nowIso = new Date().toISOString();
  const updatePayload = {
    leadbridge_connected:                true,
    leadbridge_connected_at:             settingRow.leadbridge_connected_at || nowIso,
    lb_orchestration_enabled_at:         nowIso,
    lb_orchestration_webhook_url:        provision.webhookUrl,
    lb_orchestration_webhook_secret_enc: webhookSecretEnc,
    lb_orchestration_webhook_set_at:     nowIso,
  };
  if (provision.subscriptionId) updatePayload.lb_orchestration_subscription_id = String(provision.subscriptionId);
  if (provision.stateRef)        updatePayload.lb_orchestration_state_ref       = String(provision.stateRef);

  const { data: updatedSetting, error: updateErr } = await supabase
    .from(SETTINGS_TABLE)
    .update(updatePayload)
    .eq('user_id', tenantId)
    .select('user_id,leadbridge_connected,lb_orchestration_enabled_at,lb_orchestration_webhook_url,lb_orchestration_webhook_set_at,lb_orchestration_subscription_id,lb_orchestration_state_ref')
    .maybeSingle();
  if (updateErr) {
    await rollbackCredential(supabase, tenantId, 'settings_update_failed', logger);
    return { ok: false, reason: 'db_error', step: 'settings_update', errorDescription: updateErr.message };
  }

  // Step 5 — enqueue connection.connected (best-effort).
  const event = buildConnectionConnectedEvent({
    tenantId,
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
    userId:           tenantId,
    event,
    webhookUrl:       provision.webhookUrl,
    webhookSecretEnc,
    subscriptionId:   provision.subscriptionId || null,
    stateRef:         provision.stateRef       || null,
  });
  if (!enqueueRes.ok) {
    try { logger.warn(`[orch-direct] outbox enqueue failed tenant=${tenantId} eid=${event.event_id} reason=${enqueueRes.reason}`); } catch (_) {}
  }

  try {
    logger.log(`[orch-direct] connected tenant=${tenantId} cred=${minted.credentialId} prefix=${minted.tokenPrefix} lb_account=${provision.lbAccountId}`);
  } catch (_) {}

  return {
    ok: true,
    credential: {
      credentialId: minted.credentialId,
      tokenPrefix:  minted.tokenPrefix,
      kid:          minted.kid,
      issuedAt:     minted.issuedAt,
      expiresAt:    minted.expiresAt,
    },
    lbAccountId:    provision.lbAccountId,
    lbAccountName:  provision.lbAccountName,
    webhookUrl:     provision.webhookUrl,
    subscriptionId: provision.subscriptionId,
    stateRef:       provision.stateRef,
    settings:       updatedSetting,
    event_id:       event.event_id,
    event_enqueued: !!enqueueRes.ok,
  };
}

// ─────────────────────────────────────────────────────────────────
// Internal
// ─────────────────────────────────────────────────────────────────

async function rollbackCredential(supabase, tenantId, reason, logger) {
  try {
    const r = await revokeCredential(supabase, { userId: tenantId, reason });
    try { logger.warn(`[orch-direct] rolled back credential tenant=${tenantId} revoked=${r.revokedCount} reason=${reason}`); } catch (_) {}
  } catch (err) {
    try { logger.error(`[orch-direct] rollback failed tenant=${tenantId}: ${err && err.message}`); } catch (_) {}
  }
}

module.exports = {
  performDirectProvision,
  // Exposed for unit tests + the /provision-retry endpoint:
  verifyLbCredentials,
  provisionWithLb,
  // Constants exposed for tests / observability:
  SF_ENDPOINTS,
  SF_EVENT_TYPES,
  VERIFY_CREDS_PATH,
  PROVISION_PATH,
};
