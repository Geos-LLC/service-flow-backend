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
const DEFAULT_PAGE_SIZE   = 100;
const MAX_PAGE_SIZE       = 500;
const DEFAULT_LB_BASE     = 'https://thumbtack-bridge-production.up.railway.app/api';

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
 * Fetch one page of LB's unlinked candidates for a tenant.
 *
 * @param {object} args
 * @param {number} args.tenantId       - SF user_id (= sf_tenant_id)
 * @param {string|null} [args.cursor]  - LB-issued opaque pagination token
 * @param {number} [args.limit=100]    - capped at MAX_PAGE_SIZE
 * @param {string|null} [args.lbBusinessId]  - optional scope to a specific LB account
 * @param {boolean} [args.onlyUnlinked=true] - LB-side filter; default true
 * @param {object} [args.httpClient]
 * @param {Date}   [args.now]
 * @returns {Promise<{
 *   ok: boolean,
 *   status?: number,
 *   leads?: Array<object>,
 *   cursor?: string|null,
 *   reason?: string,
 *   error_description?: string,
 * }>}
 */
async function fetchCandidates(args) {
  if (!args || args.tenantId == null) {
    return { ok: false, reason: 'invalid_arguments', error_description: 'tenantId required' };
  }
  const tenantId = Number(args.tenantId);
  const limit = Math.min(Number.isFinite(args.limit) ? args.limit : DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);

  const url = `${lbBaseUrl()}${CANDIDATES_PATH}`;
  const body = {
    sf_tenant_id:       tenantId,
    sf_source_instance: sourceInstance(),
    cursor:             args.cursor || null,
    limit,
    only_unlinked:      args.onlyUnlinked !== false,
  };
  if (args.lbBusinessId) body.lb_business_id = args.lbBusinessId;

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
  const leads = Array.isArray(d.leads) ? d.leads : [];
  return {
    ok:     true,
    status: res.status,
    leads,
    cursor: d.cursor || null,
  };
}

/**
 * Phase-2 stub. Posts matched LB↔SF pairs to LB so it can:
 *   - link its lb_lead → sf_job_id
 *   - mark lb_lead.sf_managed = true (blocking manual status edits)
 *
 * MUST NOT be called from the Phase-1 orchestrator path. The endpoint
 * forces dry_run=true; this client stub is reachable in Phase-2.
 *
 * @param {object} args
 * @param {number} args.tenantId
 * @param {boolean} args.dryRun  - explicit; defaults to true if omitted
 * @param {Array<object>} args.matches  - each { lb_lead_id, sf_job_id, sf_customer_id, confidence, match_signals, sf_job_status, sf_payment_status }
 * @returns {Promise<{ok, status?, applied?, rejected?, summary?, reason?, error_description?}>}
 */
async function linkLeadsBulk(args) {
  if (!args || args.tenantId == null) {
    return { ok: false, reason: 'invalid_arguments', error_description: 'tenantId required' };
  }
  if (!Array.isArray(args.matches)) {
    return { ok: false, reason: 'invalid_arguments', error_description: 'matches array required' };
  }
  const dryRun = args.dryRun !== false;   // default true; explicit opt-in to apply

  const url = `${lbBaseUrl()}${LINK_BULK_PATH}`;
  const body = {
    sf_tenant_id:       Number(args.tenantId),
    sf_source_instance: sourceInstance(),
    dry_run:            dryRun,
    matches:            args.matches,
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
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
};
