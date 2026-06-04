'use strict';

/**
 * Route-level guards for POST /api/integrations/leadbridge/historical-sync/feedback.
 *
 * The route accepts an authenticated request and dispatches to the
 * orchestrator. These tests pin the gate semantics that exist ONLY at
 * the route layer (the orchestrator is environment-agnostic):
 *
 *   1. dry_run defaults to true. A request body without `dry_run`
 *      reaches the orchestrator with dryRun=true and is therefore
 *      structurally read-only.
 *
 *   2. dry_run:false is REJECTED with 503 feedback_apply_disabled
 *      unless SF_HISTORICAL_FEEDBACK_APPLY_ENABLED is on. The
 *      orchestrator is never invoked, the LB client is never called.
 *
 *   3. dry_run:false requires owner/admin role even when the flag is
 *      on. Non-admin → 403 forbidden, no LB call.
 *
 *   4. would_link rows are NEVER posted to LB through this route.
 *      Verified by wiring a real router with a stubbed orchestrator
 *      that simulates a would_link-only batch — the LB client must
 *      not be called.
 */

process.env.SF_LB_PROVISIONING_SHARED_SECRET = 'p3-route-test-' + 'D'.repeat(20);
process.env.LB_PROVISIONING_BASE_URL          = 'https://lb-test.example.com/api';
process.env.JWT_SECRET                        = 'route-test-jwt-secret-please-do-not-use-in-prod';

const express = require('express');
const request = require('supertest');
const jwt     = require('jsonwebtoken');

// We mock the orchestrator at the require boundary so the route handler
// resolves to our spy instead of the real implementation. The spy lets
// us assert how the route called the orchestrator AND lets us return
// canned shapes without standing up Supabase or LB fixtures.
const mockRunHistoricalFeedbackApply = jest.fn();
const mockRunHistoricalSync          = jest.fn();
const mockRunHistoricalSyncApply     = jest.fn();
jest.mock('../lib/sf-historical-sync-orchestrator', () => ({
  runHistoricalSync:           (...a) => mockRunHistoricalSync(...a),
  runHistoricalSyncApply:      (...a) => mockRunHistoricalSyncApply(...a),
  runHistoricalFeedbackApply:  (...a) => mockRunHistoricalFeedbackApply(...a),
}));
// Same idea — stub remediation so its import doesn't drag the real
// orchestrator back in transitively.
jest.mock('../lib/sf-historical-remediation', () => ({
  remediate: jest.fn().mockResolvedValue({ ok: true, counts: { type_a: 0, type_b: 0 } }),
}));
// LB client stub — if any code-path slips past the flag gate, this is
// what would have been called.
const mockLinkLeadsBulk = jest.fn();
jest.mock('../lib/lb-historical-sync-client', () => ({
  fetchCandidates: jest.fn(),
  linkLeadsBulk:   (...a) => mockLinkLeadsBulk(...a),
  CANDIDATES_PATH: '/v1/integrations/sf/historical-sync/candidates',
  LINK_BULK_PATH:  '/v1/integrations/sf/link-leads-bulk',
}));

const leadbridgeServiceFactory = require('../leadbridge-service');

// Build a fresh app per test so we can swap env vars in/out cleanly.
function makeApp({ supabase } = {}) {
  const app = express();
  app.use(express.json());
  const router = leadbridgeServiceFactory(
    supabase || { from: () => { throw new Error('supabase must not be touched in this test'); } },
    { log() {}, warn() {}, error() {} },
  );
  app.use('/api/integrations/leadbridge', router);
  return app;
}

function adminToken() {
  return jwt.sign({ userId: 2, email: 'admin@example.com', role: 'admin' }, process.env.JWT_SECRET, { expiresIn: '1h' });
}
function tenantToken() {
  // Tenant role — neither 'owner' nor 'admin'.
  return jwt.sign({ userId: 2, email: 'tenant@example.com', role: 'tenant' }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

beforeEach(() => {
  mockRunHistoricalFeedbackApply.mockReset();
  mockRunHistoricalSync.mockReset();
  mockRunHistoricalSyncApply.mockReset();
  mockLinkLeadsBulk.mockReset();
  delete process.env.SF_HISTORICAL_FEEDBACK_APPLY_ENABLED;
});

// ──────────────────────────────────────────────────────────────────────
// dry_run defaults true — orchestrator receives dryRun=true
// ──────────────────────────────────────────────────────────────────────
describe('POST /historical-sync/feedback — dry_run defaults true', () => {
  test('no body → orchestrator called with dryRun:true; no flag needed', async () => {
    mockRunHistoricalFeedbackApply.mockResolvedValue({
      ok: true, phase: 'phase_3_feedback_dry_run',
      summary: { dry_run: true, processed: 0, would_no_match: 0, would_review: 0, would_failed: 0 },
      proposed_rows: [], per_lead: [],
    });
    const app = makeApp();
    const res = await request(app)
      .post('/api/integrations/leadbridge/historical-sync/feedback')
      .set('Authorization', 'Bearer ' + adminToken())
      .send({});
    expect(res.status).toBe(200);
    expect(mockRunHistoricalFeedbackApply).toHaveBeenCalledTimes(1);
    const callArgs = mockRunHistoricalFeedbackApply.mock.calls[0][1];
    expect(callArgs.dryRun).toBe(true);
    expect(callArgs.tenantId).toBe(2);
    expect(mockLinkLeadsBulk).not.toHaveBeenCalled();
  });

  test('explicit dry_run:true ignores the flag and proceeds', async () => {
    mockRunHistoricalFeedbackApply.mockResolvedValue({ ok: true, phase: 'phase_3_feedback_dry_run', summary: {}, proposed_rows: [], per_lead: [] });
    const app = makeApp();
    const res = await request(app)
      .post('/api/integrations/leadbridge/historical-sync/feedback')
      .set('Authorization', 'Bearer ' + adminToken())
      .send({ dry_run: true });
    expect(res.status).toBe(200);
    expect(mockRunHistoricalFeedbackApply.mock.calls[0][1].dryRun).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────
// dry_run:false blocked when flag is off
// ──────────────────────────────────────────────────────────────────────
describe('POST /historical-sync/feedback — flag gate', () => {
  test('dry_run:false WITHOUT SF_HISTORICAL_FEEDBACK_APPLY_ENABLED → 503, orchestrator not called', async () => {
    // Flag unset (deleted in beforeEach).
    const app = makeApp();
    const res = await request(app)
      .post('/api/integrations/leadbridge/historical-sync/feedback')
      .set('Authorization', 'Bearer ' + adminToken())
      .send({ dry_run: false });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('feedback_apply_disabled');
    expect(mockRunHistoricalFeedbackApply).not.toHaveBeenCalled();
    expect(mockLinkLeadsBulk).not.toHaveBeenCalled();
  });

  test('dry_run:false with flag=false → still 503', async () => {
    process.env.SF_HISTORICAL_FEEDBACK_APPLY_ENABLED = 'false';
    const app = makeApp();
    const res = await request(app)
      .post('/api/integrations/leadbridge/historical-sync/feedback')
      .set('Authorization', 'Bearer ' + adminToken())
      .send({ dry_run: false });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('feedback_apply_disabled');
    expect(mockRunHistoricalFeedbackApply).not.toHaveBeenCalled();
  });

  test('dry_run:false with flag=true + non-admin role → 403 forbidden', async () => {
    process.env.SF_HISTORICAL_FEEDBACK_APPLY_ENABLED = 'true';
    const app = makeApp();
    const res = await request(app)
      .post('/api/integrations/leadbridge/historical-sync/feedback')
      .set('Authorization', 'Bearer ' + tenantToken())
      .send({ dry_run: false });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('forbidden');
    expect(mockRunHistoricalFeedbackApply).not.toHaveBeenCalled();
    expect(mockLinkLeadsBulk).not.toHaveBeenCalled();
  });

  test('dry_run:false with flag=true + admin → orchestrator called with dryRun:false', async () => {
    process.env.SF_HISTORICAL_FEEDBACK_APPLY_ENABLED = 'true';
    mockRunHistoricalFeedbackApply.mockResolvedValue({
      ok: true, phase: 'phase_3_feedback_apply', summary: { applied: 0 },
      applied: [], rejected: [], per_lead: [], request_id: null,
    });
    const app = makeApp();
    const res = await request(app)
      .post('/api/integrations/leadbridge/historical-sync/feedback')
      .set('Authorization', 'Bearer ' + adminToken())
      .send({ dry_run: false });
    expect(res.status).toBe(200);
    expect(mockRunHistoricalFeedbackApply.mock.calls[0][1].dryRun).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────
// would_link is the orchestrator's invariant — pinned here too via the route
// ──────────────────────────────────────────────────────────────────────
describe('POST /historical-sync/feedback — would_link is never posted', () => {
  test('summary reports would_link but no LB POST happens', async () => {
    // Simulate an orchestrator return where every candidate landed in
    // would_link. Whether the LB client was invoked is the orchestrator's
    // contract — pin it from outside by checking the mocked LB client
    // remained silent.
    mockRunHistoricalFeedbackApply.mockResolvedValue({
      ok: true, phase: 'phase_3_feedback_dry_run',
      summary: { dry_run: true, processed: 5, would_link: 5, would_review: 0, would_no_match: 0, would_failed: 0 },
      proposed_rows: [],
      per_lead: Array.from({ length: 5 }, (_, i) => ({
        lb_lead_id: 'L-' + i, bucket: 'would_link', reason: null, action: 'skip_use_apply_path',
      })),
    });

    const app = makeApp();
    const res = await request(app)
      .post('/api/integrations/leadbridge/historical-sync/feedback')
      .set('Authorization', 'Bearer ' + adminToken())
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.summary.would_link).toBe(5);
    expect(res.body.proposed_rows).toEqual([]);
    expect(mockLinkLeadsBulk).not.toHaveBeenCalled();
  });
});
