'use strict';

/**
 * SF → LB historical sync client (Phase 1) — matches LB's PRODUCTION
 * contract for /historical-sync/candidates and /link-leads-bulk.
 *
 * LB contract (provided 2026-05-30):
 *   /candidates request:   { user_id, sync_statuses, limit }
 *   /candidates response:  { ok, user_id, count, candidates: [...] }
 *   /link-leads-bulk:      apply-only; no dry_run flag; body { user_id, matches }
 *
 * NO cursor pagination. Pagination is state-transition based: linked
 * rows move out of pending. Caller surfaces `more_may_exist` when
 * count === requested limit.
 *
 * Covers:
 *   - HMAC headers attached
 *   - request body shape ({user_id, sync_statuses, limit})
 *   - response read from `candidates` (not `leads`)
 *   - more_may_exist = (count === limit)
 *   - 4xx/5xx/network errors → structured ok:false
 *   - linkLeadsBulk apply-only (no dry_run in request body)
 *   - argument validation: lbUserId required (was tenantId in pre-patch)
 */

process.env.SF_LB_PROVISIONING_SHARED_SECRET = 'p1-shared-test-' + 'A'.repeat(20);
process.env.LB_PROVISIONING_BASE_URL          = 'https://lb-test.example.com/api';

const {
  fetchCandidates,
  linkLeadsBulk,
  CANDIDATES_PATH,
  LINK_BULK_PATH,
  DEFAULT_BATCH_SIZE,
  MAX_BATCH_SIZE,
  DEFAULT_SYNC_STATUSES,
} = require('../lib/lb-historical-sync-client');

function makeHttpClient({ response, throwErr } = {}) {
  const calls = [];
  const fn = async (req) => {
    calls.push({ url: req.url, method: req.method, headers: { ...req.headers }, body: req.data });
    if (throwErr) throw new Error(throwErr);
    return response || { status: 200, data: { ok: true, user_id: LB_USER, count: 0, candidates: [] } };
  };
  fn.calls = calls;
  return fn;
}

const NOW = new Date('2026-06-01T12:00:00Z');
const LB_USER = 'c3d14499-dec1-42c3-a36c-713cb09842c6';   // Spotless LB account

// ──────────────────────────────────────────────────────────────
// fetchCandidates — request shape + HMAC
// ──────────────────────────────────────────────────────────────
describe('fetchCandidates — request shape', () => {
  test('posts { user_id, sync_statuses, limit } per LB contract', async () => {
    const client = makeHttpClient();
    await fetchCandidates({ lbUserId: LB_USER, limit: 500, httpClient: client, now: NOW });
    expect(client.calls).toHaveLength(1);
    const c = client.calls[0];
    expect(c.url).toBe(`https://lb-test.example.com/api${CANDIDATES_PATH}`);
    expect(c.method).toBe('POST');
    const body = JSON.parse(c.body);
    expect(body).toEqual({
      user_id:       LB_USER,
      sync_statuses: ['pending'],
      limit:         500,
    });
    // Confirm we do NOT send the deprecated fields
    expect(body).not.toHaveProperty('sf_tenant_id');
    expect(body).not.toHaveProperty('sf_source_instance');
    expect(body).not.toHaveProperty('cursor');
    expect(body).not.toHaveProperty('only_unlinked');
    expect(body).not.toHaveProperty('lb_business_id');
  });

  test('attaches HMAC X-SF-LB-Signature + X-SF-LB-Timestamp', async () => {
    const client = makeHttpClient();
    await fetchCandidates({ lbUserId: LB_USER, httpClient: client, now: NOW });
    const h = client.calls[0].headers;
    expect(h['Content-Type']).toBe('application/json');
    expect(h['X-SF-LB-Timestamp']).toBe(String(Math.floor(NOW.getTime() / 1000)));
    expect(h['X-SF-LB-Signature']).toMatch(/^[0-9a-f]{64}$/);
  });

  test('defaults sync_statuses to ["pending"] when omitted', async () => {
    const client = makeHttpClient();
    await fetchCandidates({ lbUserId: LB_USER, httpClient: client, now: NOW });
    expect(JSON.parse(client.calls[0].body).sync_statuses).toEqual(['pending']);
  });

  test('respects custom sync_statuses array', async () => {
    const client = makeHttpClient();
    await fetchCandidates({ lbUserId: LB_USER, syncStatuses: ['pending', 'in_review'], httpClient: client, now: NOW });
    expect(JSON.parse(client.calls[0].body).sync_statuses).toEqual(['pending', 'in_review']);
  });

  test('caps limit at MAX_BATCH_SIZE', async () => {
    const client = makeHttpClient();
    await fetchCandidates({ lbUserId: LB_USER, limit: 99999, httpClient: client, now: NOW });
    expect(JSON.parse(client.calls[0].body).limit).toBe(MAX_BATCH_SIZE);   // 500
  });

  test('defaults limit to DEFAULT_BATCH_SIZE when omitted', async () => {
    const client = makeHttpClient();
    await fetchCandidates({ lbUserId: LB_USER, httpClient: client, now: NOW });
    expect(JSON.parse(client.calls[0].body).limit).toBe(DEFAULT_BATCH_SIZE);
  });

  test('missing lbUserId → invalid_arguments', async () => {
    const out = await fetchCandidates({});
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('invalid_arguments');
  });

  test('omits LB `status` filter from body when not provided', async () => {
    const client = makeHttpClient();
    await fetchCandidates({ lbUserId: LB_USER, httpClient: client, now: NOW });
    expect(JSON.parse(client.calls[0].body)).not.toHaveProperty('status');
  });

  test('forwards LB `status` filter when provided', async () => {
    const client = makeHttpClient();
    await fetchCandidates({ lbUserId: LB_USER, status: 'scheduled', httpClient: client, now: NOW });
    expect(JSON.parse(client.calls[0].body).status).toBe('scheduled');
  });

  test('ignores empty-string `status`', async () => {
    const client = makeHttpClient();
    await fetchCandidates({ lbUserId: LB_USER, status: '', httpClient: client, now: NOW });
    expect(JSON.parse(client.calls[0].body)).not.toHaveProperty('status');
  });
});

// ──────────────────────────────────────────────────────────────
// fetchCandidates — response shape + more_may_exist
// ──────────────────────────────────────────────────────────────
describe('fetchCandidates — response shape', () => {
  test('reads candidates array (not "leads")', async () => {
    const client = makeHttpClient({ response: { status: 200, data: {
      ok: true,
      user_id: LB_USER,
      count: 2,
      candidates: [
        { leadId: 'a', customerPhone: '8133752443' },
        { leadId: 'b', customerPhone: '9999999999' },
      ],
    } } });
    const out = await fetchCandidates({ lbUserId: LB_USER, limit: 500, httpClient: client, now: NOW });
    expect(out.ok).toBe(true);
    expect(out.candidates).toHaveLength(2);
    expect(out.count).toBe(2);
    expect(out.user_id).toBe(LB_USER);
  });

  test('more_may_exist=true when count === requested limit', async () => {
    const client = makeHttpClient({ response: { status: 200, data: {
      ok: true, user_id: LB_USER, count: 500,
      candidates: Array.from({ length: 500 }, (_, i) => ({ leadId: 'l' + i })),
    } } });
    const out = await fetchCandidates({ lbUserId: LB_USER, limit: 500, httpClient: client, now: NOW });
    expect(out.more_may_exist).toBe(true);
  });

  test('more_may_exist=false when count < requested limit', async () => {
    const client = makeHttpClient({ response: { status: 200, data: {
      ok: true, user_id: LB_USER, count: 17,
      candidates: Array.from({ length: 17 }, (_, i) => ({ leadId: 'l' + i })),
    } } });
    const out = await fetchCandidates({ lbUserId: LB_USER, limit: 500, httpClient: client, now: NOW });
    expect(out.more_may_exist).toBe(false);
  });

  test('does NOT return a cursor (no cursor pagination)', async () => {
    const client = makeHttpClient();
    const out = await fetchCandidates({ lbUserId: LB_USER, httpClient: client, now: NOW });
    expect(out).not.toHaveProperty('cursor');
  });

  test('LB error response → structured ok:false', async () => {
    const client = makeHttpClient({ response: { status: 401, data: { error: 'invalid_signature', detail: 'hmac mismatch' } } });
    const out = await fetchCandidates({ lbUserId: LB_USER, httpClient: client, now: NOW });
    expect(out.ok).toBe(false);
    expect(out.status).toBe(401);
    expect(out.reason).toBe('invalid_signature');
    expect(out.error_description).toBe('hmac mismatch');
  });

  test('network error → ok:false reason=lb_unreachable', async () => {
    const client = makeHttpClient({ throwErr: 'connect ETIMEDOUT' });
    const out = await fetchCandidates({ lbUserId: LB_USER, httpClient: client, now: NOW });
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('lb_unreachable');
  });

  test('falls back to candidates.length when LB omits count', async () => {
    const client = makeHttpClient({ response: { status: 200, data: {
      ok: true, user_id: LB_USER,
      candidates: [{ leadId: 'a' }, { leadId: 'b' }, { leadId: 'c' }],
      // no count field
    } } });
    const out = await fetchCandidates({ lbUserId: LB_USER, httpClient: client, now: NOW });
    expect(out.count).toBe(3);
  });
});

// ──────────────────────────────────────────────────────────────
// linkLeadsBulk — Phase-2 stub (apply-only, no dry_run flag)
// ──────────────────────────────────────────────────────────────
describe('linkLeadsBulk — apply-only contract', () => {
  test('posts { user_id, matches } only — no dry_run flag', async () => {
    const client = makeHttpClient({ response: { status: 200, data: { ok: true, applied: [], rejected: [], summary: { total: 0 } } } });
    await linkLeadsBulk({ lbUserId: LB_USER, matches: [{ lb_lead_id: 'a', sf_job_id: 1 }], httpClient: client, now: NOW });
    const body = JSON.parse(client.calls[0].body);
    expect(body).toEqual({
      user_id: LB_USER,
      matches: [{ lb_lead_id: 'a', sf_job_id: 1 }],
    });
    expect(body).not.toHaveProperty('dry_run');
    expect(body).not.toHaveProperty('sf_tenant_id');
    expect(body).not.toHaveProperty('sf_source_instance');
  });

  test('attaches HMAC signature', async () => {
    const client = makeHttpClient();
    await linkLeadsBulk({ lbUserId: LB_USER, matches: [], httpClient: client, now: NOW });
    expect(client.calls[0].headers['X-SF-LB-Signature']).toMatch(/^[0-9a-f]{64}$/);
    expect(client.calls[0].url).toBe(`https://lb-test.example.com/api${LINK_BULK_PATH}`);
  });

  test('missing lbUserId → invalid_arguments', async () => {
    const out = await linkLeadsBulk({ matches: [] });
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('invalid_arguments');
  });

  test('missing matches array → invalid_arguments', async () => {
    const out = await linkLeadsBulk({ lbUserId: LB_USER });
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('invalid_arguments');
  });

  test('passes through applied/rejected/summary from LB response', async () => {
    const client = makeHttpClient({ response: { status: 200, data: {
      ok: true,
      applied: [{ lb_lead_id: 'a', sf_managed: true }],
      rejected: [{ lb_lead_id: 'b', reason: 'already_linked' }],
      summary: { total: 2, applied: 1, rejected: 1 },
    } } });
    const out = await linkLeadsBulk({ lbUserId: LB_USER, matches: [{ lb_lead_id: 'a' }, { lb_lead_id: 'b' }], httpClient: client, now: NOW });
    expect(out.ok).toBe(true);
    expect(out.applied).toHaveLength(1);
    expect(out.rejected).toHaveLength(1);
    expect(out.summary.total).toBe(2);
  });
});

describe('DEFAULT_SYNC_STATUSES', () => {
  test('is exported as a frozen ["pending"] array', () => {
    expect(DEFAULT_SYNC_STATUSES).toEqual(['pending']);
  });
});
