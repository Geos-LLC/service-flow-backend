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

// LB-confirmed result codes that count as APPLIED for SF-side persistence.
// Each implies LB has accepted the link and we can safely run attachLbLink.
const APPLIED_RESULTS = Object.freeze(new Set(['linked', 'needs_review', 'no_match']));

// LB-confirmed result codes that mean DO NOT persist on SF side.
const REJECTED_RESULTS = Object.freeze(new Set(['conflict', 'not_found', 'failed']));

/**
 * Collapse `match_basis` to the wire shape LB expects (string).
 *
 * LB's contract is a single string per row (e.g. "externalRequestId").
 * Our matcher emits an array like ['phone_exact:…2443','name_exact'];
 * we serialize that to a single token here so the orchestrator never
 * has to know LB's wire shape.
 */
function normalizeMatchBasis(v) {
  if (typeof v === 'string') return v;
  if (Array.isArray(v) && v.length > 0) {
    // Preserve evidence: join all signals so a reader can reconstruct
    // why the matcher fired. LB stores as opaque text.
    return v.map(s => String(s)).join('+');
  }
  return '';
}

/**
 * Apply matched LB↔SF pairs against LB's production /link-leads-bulk
 * endpoint.
 *
 * Wire contract (confirmed with LB 2026-06-01):
 *
 *   request:
 *     { user_id, rows: [{
 *         lb_lead_id, sf_job_id, sf_customer_id,
 *         confidence, match_basis,            // STRING (not array)
 *         sf_status, sf_payment_status,
 *         occurred_at, reason,
 *     }, …] }
 *
 *   response:
 *     { ok, summary: { total, linked, needs_review, no_match,
 *                      conflict, not_found, failed, status_updates_applied },
 *       rows: [{ lb_lead_id, result, sync_status, detail? }, …] }
 *
 *   per-row `result` ∈ {linked, needs_review, no_match, conflict, not_found, failed}
 *     - APPLIED bucket (LB consents): linked, needs_review, no_match
 *     - REJECTED bucket (SF must not persist): conflict, not_found, failed
 *
 * The orchestrator continues to consume `{ ok, applied, rejected,
 * summary }` — we map LB's per-row result codes into the
 * applied/rejected arrays here so the apply path is untouched. The
 * full per-row LB detail is preserved on each applied/rejected entry
 * as `lb_result` and `lb_detail` for forensics.
 *
 * @param {object} args
 * @param {string} args.lbUserId
 * @param {Array<object>} args.matches  - each row: { lb_lead_id, sf_job_id,
 *                                          sf_customer_id, confidence,
 *                                          match_basis (string|array),
 *                                          sf_status, sf_payment_status,
 *                                          occurred_at, reason }
 * @returns {Promise<{ok, status?, applied?, rejected?, summary?,
 *                    reason?, error_description?}>}
 */
async function linkLeadsBulk(args) {
  if (!args || typeof args.lbUserId !== 'string' || args.lbUserId.length === 0) {
    return { ok: false, reason: 'invalid_arguments', error_description: 'lbUserId required' };
  }
  if (!Array.isArray(args.matches)) {
    return { ok: false, reason: 'invalid_arguments', error_description: 'matches array required' };
  }

  const rows = args.matches.map((m) => {
    if (!m || typeof m !== 'object') return m;
    return { ...m, match_basis: normalizeMatchBasis(m.match_basis) };
  });

  const url = `${lbBaseUrl()}${LINK_BULK_PATH}`;
  const body = {
    user_id: args.lbUserId,
    rows,
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
  const lbRows = Array.isArray(d.rows) ? d.rows : null;

  // LB returned HTTP 2xx but no per-row data — likely a body validation
  // failure (e.g. {ok:false, error:'invalid_body', rows:[]}). Surface as
  // a batch error so the orchestrator returns 502 lb_apply_failed
  // instead of silently rejecting every operator-approved row.
  if (!lbRows || lbRows.length === 0) {
    return {
      ok:                false,
      status:            res.status,
      reason:            d.error || 'lb_link_bulk_empty_response',
      error_description: d.detail || d.error_description || null,
      summary:           (d.summary && typeof d.summary === 'object') ? d.summary : null,
    };
  }

  // Group by LB's `result` field. Unknown values are treated as REJECTED
  // (fail-closed — we never persist for results LB hasn't documented).
  const applied  = [];
  const rejected = [];
  for (const r of lbRows) {
    if (!r || typeof r !== 'object' || !r.lb_lead_id) continue;
    const entry = {
      lb_lead_id:  r.lb_lead_id,
      lb_result:   r.result   || null,
      lb_sync_status: r.sync_status || null,
      lb_detail:   r.detail   || null,
    };
    if (APPLIED_RESULTS.has(r.result)) {
      // LB has accepted this row — orchestrator may run attachLbLink.
      // Carry sf_managed forward so the orchestrator's existing
      // appliedSet logic (keyed on lb_lead_id) keeps working.
      applied.push({ ...entry, sf_managed: true });
    } else {
      // REJECTED_RESULTS or any unknown value.
      rejected.push({ ...entry, reason: r.result || 'unknown_result' });
    }
  }

  return {
    ok:       true,
    status:   res.status,
    applied,
    rejected,
    summary:  (d.summary && typeof d.summary === 'object') ? d.summary : null,
  };
}

module.exports = {
  fetchCandidates,
  linkLeadsBulk,
  // exposed for tests
  normalizeMatchBasis,
  APPLIED_RESULTS,
  REJECTED_RESULTS,
  // constants exposed for tests
  CANDIDATES_PATH,
  LINK_BULK_PATH,
  DEFAULT_BATCH_SIZE,
  MAX_BATCH_SIZE,
  DEFAULT_SYNC_STATUSES,
};
