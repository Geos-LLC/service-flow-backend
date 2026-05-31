'use strict';

// SF → LB client for the SF-driven historical sync flow.
//
// Two endpoints, both HMAC-signed using SF_LB_PROVISIONING_SHARED_SECRET
// (same scheme as /verify-credentials and /provision):
//
//   POST /api/v1/integrations/sf/historical-sync/candidates
//        Pull LB's unlinked leads for this tenant. Paginated by cursor.
//
//   POST /api/v1/integrations/sf/link-leads-bulk
//        Post SF→LB matches to LB so it can link + mark sf_managed=true.
//        NOT CALLED IN PHASE 1 — exists in the client for Phase-2 wiring,
//        but the orchestrator forces dry_run=true and never invokes it.
//
// Hard rules:
//   - no plaintext SF state leaks to LB (PII fields pass through as
//     LB already has them; SF only adds sf_job_id / sf_customer_id /
//     confidence / signals)
//   - HMAC headers regenerated per request (timestamp inside signature
//     defeats replay)
//   - request body bounded; pagination owned by caller
//   - never throws on 4xx/5xx — returns structured { ok:false, status, ... }
//   - linkLeadsBulk is a Phase-2 stub. Calling it in Phase-1 paths is a
//     bug; the function itself works but the orchestrator must not call
//     it while dry_run is forced.

const axios = require('axios');

const { buildProvisioningHeaders } = require('./lb-provisioning-sign');

const CANDIDATES_PATH = '/v1/integrations/sf/historical-sync/candidates';
const LINK_BULK_PATH  = '/v1/integrations/sf/link-leads-bulk';

const DEFAULT_TIMEOUT_MS  = 30_000;
const DEFAULT_BATCH_SIZE  = 500;
const MAX_BATCH_SIZE      = 500;
const DEFAULT_LB_BASE     = 'https://thumbtack-bridge-production.up.railway.app/api';
const DEFAULT_SYNC_STATUSES = Object.freeze(['pending']);

function lbBaseUrl() {
  return process.env.LB_PROVISIONING_BASE_URL
      || process.env.LEADBRIDGE_URL
      || DEFAULT_LB_BASE;
}

function sourceInstance() {
  return process.env.SF_SOURCE_INSTANCE
      || process.env.SF_INSTANCE
      || 'sf-prod';
}

/**
 * HMAC-signed POST to LB. Returns the LB response (success or error)
 * structured. Never throws on non-2xx.
 *
 * @param {string} url
 * @param {object} bodyObject
 * @param {object} opts  - { httpClient, timeoutMs, now }
 */
async function postSigned(url, bodyObject, { httpClient = axios, timeoutMs = DEFAULT_TIMEOUT_MS, now = new Date() } = {}) {
  let bodyString;
  try { bodyString = JSON.stringify(bodyObject); }
  catch (e) { return { ok: false, networkError: true, reason: 'body_serialize_failed' }; }

  let signed;
  try { signed = buildProvisioningHeaders({ body: bodyString, now }); }
  catch (e) { return { ok: false, networkError: true, reason: 'sign_failed', error: String(e && e.message || e) }; }

  let res;
  try {
    res = await httpClient({
      method:           'POST',
      url,
      headers:          signed.headers,
      data:             signed.body,
      timeout:          timeoutMs,
      validateStatus:   () => true,
      transformRequest: [(d) => d],  // body pre-serialized
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
 * Fetch one batch of LB's pending candidates for an LB user.
 *
 * Per LB's production contract:
 *   - request body: { user_id, sync_statuses, limit }
 *   - response:    { ok, user_id, count, candidates: [...] }
 *   - NO cursor pagination — state-transition based instead. The caller
 *     re-invokes after applying linkages until count=0. In Phase 1 we
 *     don't apply, so we only fetch one batch up to limit=500 and
 *     surface `more_may_exist` when count === limit.
 *
 * Each candidate uses LB's camelCase field names:
 *   leadId, externalRequestId, platform, businessId, customerName,
 *   customerPhone, customerEmail, status, createdAt, statusUpdatedAt,
 *   ageDays
 *
 * Mapping LB→SF/matcher field names is the orchestrator's job.
 *
 * @param {object} args
 * @param {string} args.lbUserId               - LB account UUID (from
 *                                                communication_settings.leadbridge_user_id)
 * @param {Array<string>} [args.syncStatuses=['pending']]
 * @param {string} [args.status]               - optional LB lead status filter
 *                                                (e.g. "scheduled"). Omitted
 *                                                from the request body when
 *                                                unset so LB returns all
 *                                                statuses for the user.
 * @param {number} [args.limit=500]            - capped at MAX_BATCH_SIZE
 * @param {object} [args.httpClient]
 * @param {Date}   [args.now]
 * @returns {Promise<{
 *   ok: boolean,
 *   status?: number,
 *   user_id?: string,
 *   count?: number,
 *   candidates?: Array<object>,
 *   more_may_exist?: boolean,        // true when count === requested limit
 *   reason?: string,
 *   error_description?: string,
 * }>}
 */
async function fetchCandidates(args) {
  if (!args || typeof args.lbUserId !== 'string' || args.lbUserId.length === 0) {
    return { ok: false, reason: 'invalid_arguments', error_description: 'lbUserId required' };
  }
  const limit = Math.min(
    Number.isFinite(args.limit) ? args.limit : DEFAULT_BATCH_SIZE,
    MAX_BATCH_SIZE,
  );
  const syncStatuses = Array.isArray(args.syncStatuses) && args.syncStatuses.length > 0
    ? args.syncStatuses
    : DEFAULT_SYNC_STATUSES.slice();

  const url = `${lbBaseUrl()}${CANDIDATES_PATH}`;
  const body = {
    user_id:       args.lbUserId,
    sync_statuses: syncStatuses,
    limit,
  };
  if (typeof args.status === 'string' && args.status.length > 0) {
    body.status = args.status;
  }

  const res = await postSigned(url, body, { httpClient: args.httpClient, now: args.now });
  if (res.networkError) {
    return { ok: false, reason: 'lb_unreachable', error_description: res.reason || null };
  }
  if (!res.ok) {
    const d = (res.data && typeof res.data === 'object') ? res.data : {};
    return {
      ok:                false,
      status:            res.status,
      reason:            d.error || `lb_candidates_${res.status}`,
      error_description: d.detail || d.error_description || null,
    };
  }
  const d = res.data || {};
  const candidates = Array.isArray(d.candidates) ? d.candidates : [];
  const count = Number.isFinite(d.count) ? d.count : candidates.length;
  return {
    ok:             true,
    status:         res.status,
    user_id:        typeof d.user_id === 'string' ? d.user_id : args.lbUserId,
    count,
    candidates,
    more_may_exist: count >= limit,
  };
}

/**
 * Phase-2 stub — apply-only (per LB's production contract, no dry_run flag).
 *
 * Posts matched LB↔SF pairs to LB so it can:
 *   - link its lb_lead → sf_job_id
 *   - mark lb_lead.sf_managed = true (blocking manual status edits)
 *
 * MUST NOT be called from the Phase-1 orchestrator path. Phase 1
 * enforces dry-run-only by never invoking this function. The stub exists
 * for Phase-2 wiring; calling it will hit LB and apply mutations.
 *
 * @param {object} args
 * @param {string} args.lbUserId             - LB user UUID
 * @param {Array<object>} args.matches       - each { lb_lead_id, sf_job_id, sf_customer_id, confidence, match_signals, sf_job_status, sf_payment_status }
 * @returns {Promise<{ok, status?, applied?, rejected?, summary?, reason?, error_description?}>}
 */
async function linkLeadsBulk(args) {
  if (!args || typeof args.lbUserId !== 'string' || args.lbUserId.length === 0) {
    return { ok: false, reason: 'invalid_arguments', error_description: 'lbUserId required' };
  }
  if (!Array.isArray(args.matches)) {
    return { ok: false, reason: 'invalid_arguments', error_description: 'matches array required' };
  }

  const url = `${lbBaseUrl()}${LINK_BULK_PATH}`;
  const body = {
    user_id: args.lbUserId,
    matches: args.matches,
  };

  const res = await postSigned(url, body, { httpClient: args.httpClient, now: args.now });
  if (res.networkError) {
    return { ok: false, reason: 'lb_unreachable', error_description: res.reason || null };
  }
  if (!res.ok) {
    const d = (res.data && typeof res.data === 'object') ? res.data : {};
    return {
      ok:                false,
      status:            res.status,
      reason:            d.error || `lb_link_bulk_${res.status}`,
      error_description: d.detail || d.error_description || null,
    };
  }
  const d = res.data || {};
  return {
    ok:       true,
    status:   res.status,
    applied:  Array.isArray(d.applied)  ? d.applied  : [],
    rejected: Array.isArray(d.rejected) ? d.rejected : [],
    summary:  (d.summary && typeof d.summary === 'object') ? d.summary : null,
  };
}

module.exports = {
  fetchCandidates,
  linkLeadsBulk,
  // constants exposed for tests
  CANDIDATES_PATH,
  LINK_BULK_PATH,
  DEFAULT_BATCH_SIZE,
  MAX_BATCH_SIZE,
  DEFAULT_SYNC_STATUSES,
};
