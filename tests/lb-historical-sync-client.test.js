'use strict';

/**
 * SF → LB historical sync client (Phase 1).
 *
 * Covers:
 *   - HMAC headers attached to both endpoint calls
 *   - fetchCandidates: happy path, pagination cursor, lb_business_id scope
 *   - fetchCandidates: 4xx / 5xx / network error → structured { ok:false }
 *   - linkLeadsBulk: stub callable but defaults to dry_run:true
 *   - linkLeadsBulk argument validation
 *   - URL composition uses LB_PROVISIONING_BASE_URL / LEADBRIDGE_URL env
 */

process.env.SF_LB_PROVISIONING_SHARED_SECRET = 'p1-shared-test-' + 'A'.repeat(20);
process.env.LB_PROVISIONING_BASE_URL          = 'https://lb-test.example.com/api';
process.env.SF_SOURCE_INSTANCE                = 'sf-test';

const {
  fetchCandidates,
  linkLeadsBulk,
  CANDIDATES_PATH,
  LINK_BULK_PATH,
} = require('../lib/lb-historical-sync-client');

function makeHttpClient({ response, throwErr } = {}) {
  const calls = [];
  const fn = async (req) => {
    calls.push({ url: req.url, method: req.method, headers: { ...req.headers }, body: req.data });
    if (throwErr) throw new Error(throwErr);
    return response || { status: 200, data: { ok: true, leads: [], cursor: null } };
  };
  fn.calls = calls;
  return fn;
}

const NOW = new Date('2026-06-01T12:00:00Z');

describe('fetchCandidates — HMAC + payload', () => {
  test('signs request and posts to /historical-sync/candidates', async () => {
    const client = makeHttpClient();
    const out = await fetchCandidates({ tenantId: 2, cursor: null, limit: 100, httpClient: client, now: NOW });
    expect(out.ok).toBe(true);
    expect(client.calls).toHaveLength(1);
    const c = client.calls[0];
    expect(c.url).toBe(`https://lb-test.example.com/api${CANDIDATES_PATH}`);
    expect(c.method).toBe('POST');
    expect(c.headers['Content-Type']).toBe('application/json');
    expect(c.headers['X-SF-LB-Timestamp']).toBe(String(Math.floor(NOW.getTime() / 1000)));
    expect(c.headers['X-SF-LB-Signature']).toMatch(/^[0-9a-f]{64}$/);
    const body = JSON.parse(c.body);
    expect(body.sf_tenant_id).toBe(2);
    expect(body.sf_source_instance).toBe('sf-test');
    expect(body.cursor).toBeNull();
    expect(body.limit).toBe(100);
    expect(body.only_unlinked).toBe(true);
  });

  test('passes cursor through verbatim', async () => {
    const client = makeHttpClient();
    await fetchCandidates({ tenantId: 2, cursor: 'cur_xyz_123', httpClient: client, now: NOW });
    expect(JSON.parse(client.calls[0].body).cursor).toBe('cur_xyz_123');
  });

  test('caps limit at MAX_PAGE_SIZE', async () => {
    const client = makeHttpClient();
    await fetchCandidates({ tenantId: 2, limit: 99999, httpClient: client, now: NOW });
    expect(JSON.parse(client.calls[0].body).limit).toBe(500);  // MAX_PAGE_SIZE
  });

  test('includes lb_business_id when provided', async () => {
    const client = makeHttpClient();
    await fetchCandidates({ tenantId: 2, lbBusinessId: '532386425642459138', httpClient: client, now: NOW });
    expect(JSON.parse(client.calls[0].body).lb_business_id).toBe('532386425642459138');
  });

  test('returns leads + cursor from LB response', async () => {
    const client = makeHttpClient({ response: { status: 200, data: {
      ok: true,
      cursor: 'cur_next_42',
      leads: [
        { lb_lead_id: 'a', customer_phone: '8133752443' },
        { lb_lead_id: 'b', customer_phone: '9999999999' },
      ],
    } } });
    const out = await fetchCandidates({ tenantId: 2, httpClient: client, now: NOW });
    expect(out.ok).toBe(true);
    expect(out.leads).toHaveLength(2);
    expect(out.cursor).toBe('cur_next_42');
  });

  test('LB returns 401 → ok:false with reason + status', async () => {
    const client = makeHttpClient({ response: { status: 401, data: { error: 'invalid_signature', detail: 'hmac mismatch' } } });
    const out = await fetchCandidates({ tenantId: 2, httpClient: client, now: NOW });
    expect(out.ok).toBe(false);
    expect(out.status).toBe(401);
    expect(out.reason).toBe('invalid_signature');
    expect(out.error_description).toBe('hmac mismatch');
  });

  test('network error → ok:false reason=lb_unreachable', async () => {
    const client = makeHttpClient({ throwErr: 'connect ETIMEDOUT' });
    const out = await fetchCandidates({ tenantId: 2, httpClient: client, now: NOW });
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('lb_unreachable');
  });

  test('missing tenantId → invalid_arguments', async () => {
    const out = await fetchCandidates({});
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('invalid_arguments');
  });
});

describe('linkLeadsBulk — Phase-2 stub callable, defaults dry_run=true', () => {
  test('defaults dry_run to true when not specified', async () => {
    const client = makeHttpClient({ response: { status: 200, data: { ok: true, applied: [], rejected: [], summary: { total: 0 } } } });
    await linkLeadsBulk({ tenantId: 2, matches: [], httpClient: client, now: NOW });
    expect(JSON.parse(client.calls[0].body).dry_run).toBe(true);
  });

  test('respects explicit dry_run:false (Phase 2 only — orchestrator never sets this in Phase 1)', async () => {
    const client = makeHttpClient({ response: { status: 200, data: { ok: true, applied: [], rejected: [], summary: { total: 0 } } } });
    await linkLeadsBulk({ tenantId: 2, dryRun: false, matches: [{ lb_lead_id: 'x', sf_job_id: 1 }], httpClient: client, now: NOW });
    expect(JSON.parse(client.calls[0].body).dry_run).toBe(false);
  });

  test('signs the request', async () => {
    const client = makeHttpClient();
    await linkLeadsBulk({ tenantId: 2, matches: [], httpClient: client, now: NOW });
    expect(client.calls[0].headers['X-SF-LB-Signature']).toMatch(/^[0-9a-f]{64}$/);
    expect(client.calls[0].headers['X-SF-LB-Timestamp']).toBeDefined();
    expect(client.calls[0].url).toBe(`https://lb-test.example.com/api${LINK_BULK_PATH}`);
  });

  test('missing matches array → invalid_arguments', async () => {
    const out = await linkLeadsBulk({ tenantId: 2 });
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('invalid_arguments');
  });

  test('missing tenantId → invalid_arguments', async () => {
    const out = await linkLeadsBulk({ matches: [] });
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
    const out = await linkLeadsBulk({ tenantId: 2, dryRun: false, matches: [{ lb_lead_id: 'a' }, { lb_lead_id: 'b' }], httpClient: client, now: NOW });
    expect(out.ok).toBe(true);
    expect(out.applied).toHaveLength(1);
    expect(out.rejected).toHaveLength(1);
    expect(out.summary.total).toBe(2);
  });
});
