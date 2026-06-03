'use strict';

/**
 * /connect — stale-orchestration clear (the fix for the 2026-06-03 reconnect
 * gap where direct-SQL disconnect left lb_orchestration_* set, causing the
 * next /connect's performDirectProvision to silently skip with
 * reason=already_provisioned and never call LB /v1/integrations/sf/provision).
 *
 * Covers:
 *   - stale state detected → clear emitted in upsert payload
 *   - clean disconnect → no clear emitted (preserves current behavior)
 *   - first-time connect (no prior row) → no clear, normal payload
 *   - prior row with leadbridge_connected=true → no clear (already provisioned
 *     is the correct semantic; performDirectProvision will short-circuit)
 *   - orchStale flag correctly returned for telemetry
 */

// Required so the module load doesn't try to mount express routes against
// undefined supabase. The factory is unused in this test file.
process.env.SF_LB_PROVISIONING_SHARED_SECRET = process.env.SF_LB_PROVISIONING_SHARED_SECRET
  || 'p1-orch-stale-test-' + 'B'.repeat(20);

const { buildConnectUpsertPayload } = require('../leadbridge-service');

const NOW = new Date('2026-06-03T01:00:00Z');
const BASE_ARGS = {
  userId: 2,
  lbToken: 'lb_token_xyz',
  lbUserId: 'c3d14499-dec1-42c3-a36c-713cb09842c6',
  now: NOW,
};

describe('buildConnectUpsertPayload — stale orchestration clear', () => {
  test('STALE state: leadbridge_connected=false + lb_orchestration_enabled_at set → clears the 6 orch columns', () => {
    const prior = {
      leadbridge_connected: false,
      lb_orchestration_enabled_at: '2026-05-30T15:47:30Z',
    };
    const { payload, orchStale } = buildConnectUpsertPayload({ ...BASE_ARGS, priorSettings: prior });
    expect(orchStale).toBe(true);
    // Base reconnect fields
    expect(payload.user_id).toBe(2);
    expect(payload.leadbridge_connected).toBe(true);
    expect(payload.leadbridge_integration_token).toBe('lb_token_xyz');
    expect(payload.leadbridge_user_id).toBe('c3d14499-dec1-42c3-a36c-713cb09842c6');
    expect(payload.leadbridge_connected_at).toBe('2026-06-03T01:00:00.000Z');
    // All 6 orchestration columns cleared so performDirectProvision sees a clean slate
    expect(payload).toMatchObject({
      lb_orchestration_enabled_at:         null,
      lb_orchestration_webhook_url:        null,
      lb_orchestration_webhook_secret_enc: null,
      lb_orchestration_webhook_set_at:     null,
      lb_orchestration_subscription_id:    null,
      lb_orchestration_state_ref:          null,
    });
  });

  test('CLEAN disconnect: leadbridge_connected=false + lb_orchestration_enabled_at=null → no clear emitted (already clean)', () => {
    const prior = {
      leadbridge_connected: false,
      lb_orchestration_enabled_at: null,
    };
    const { payload, orchStale } = buildConnectUpsertPayload({ ...BASE_ARGS, priorSettings: prior });
    expect(orchStale).toBe(false);
    expect(payload).not.toHaveProperty('lb_orchestration_enabled_at');
    expect(payload).not.toHaveProperty('lb_orchestration_webhook_url');
    expect(payload).not.toHaveProperty('lb_orchestration_webhook_secret_enc');
    expect(payload).not.toHaveProperty('lb_orchestration_webhook_set_at');
    expect(payload).not.toHaveProperty('lb_orchestration_subscription_id');
    expect(payload).not.toHaveProperty('lb_orchestration_state_ref');
    // Base fields still present
    expect(payload.leadbridge_connected).toBe(true);
  });

  test('FIRST-TIME connect: no prior row → no clear emitted', () => {
    const { payload, orchStale } = buildConnectUpsertPayload({ ...BASE_ARGS, priorSettings: null });
    expect(orchStale).toBe(false);
    expect(payload).not.toHaveProperty('lb_orchestration_enabled_at');
    expect(payload.leadbridge_connected).toBe(true);
  });

  test('FIRST-TIME connect (undefined): no prior row → no clear emitted', () => {
    const { payload, orchStale } = buildConnectUpsertPayload({ ...BASE_ARGS, priorSettings: undefined });
    expect(orchStale).toBe(false);
    expect(payload).not.toHaveProperty('lb_orchestration_enabled_at');
  });

  test('NORMAL already-provisioned: leadbridge_connected=true + lb_orchestration_enabled_at set → no clear (lets performDirectProvision short-circuit)', () => {
    // This is the path that protects against accidental double-provisioning.
    // The fix only clears when prior connected=false — when connected=true,
    // performDirectProvision's preflight correctly returns already_provisioned.
    const prior = {
      leadbridge_connected: true,
      lb_orchestration_enabled_at: '2026-05-30T15:47:30Z',
    };
    const { payload, orchStale } = buildConnectUpsertPayload({ ...BASE_ARGS, priorSettings: prior });
    expect(orchStale).toBe(false);
    expect(payload).not.toHaveProperty('lb_orchestration_enabled_at');
    expect(payload).not.toHaveProperty('lb_orchestration_webhook_url');
    // Normal reconnect fields still applied
    expect(payload.leadbridge_connected).toBe(true);
  });

  test('telemetry: orchStale=true is returned for the /connect log line', () => {
    const prior = { leadbridge_connected: false, lb_orchestration_enabled_at: '2026-05-30T15:47:30Z' };
    const { orchStale } = buildConnectUpsertPayload({ ...BASE_ARGS, priorSettings: prior });
    // The /connect handler emits a `[LB] /connect cleared stale orchestration state ...`
    // log line gated on this boolean — assert it surfaces correctly.
    expect(orchStale).toBe(true);
  });

  test('REGRESSION: 2026-06-03 tenant-2 reconnect scenario — exactly the production state observed', () => {
    // Tenant 2 prod state at 2026-06-03 00:31: R1 had cleared leadbridge_*
    // columns but lb_orchestration_enabled_at still pointed to the prior
    // provisioning on 2026-05-30. The next /connect should now clear that.
    const prior = {
      leadbridge_connected: false,
      lb_orchestration_enabled_at: '2026-05-30T15:47:30.816+00:00',
    };
    const { payload, orchStale } = buildConnectUpsertPayload({
      userId: 2,
      lbToken: 'eyJhbGc...real_token_redacted',
      lbUserId: 'c3d14499-dec1-42c3-a36c-713cb09842c6',
      priorSettings: prior,
      now: NOW,
    });
    expect(orchStale).toBe(true);
    expect(payload.lb_orchestration_enabled_at).toBeNull();
    expect(payload.lb_orchestration_webhook_url).toBeNull();
    expect(payload.lb_orchestration_webhook_secret_enc).toBeNull();
    expect(payload.lb_orchestration_subscription_id).toBeNull();
    expect(payload.lb_orchestration_webhook_set_at).toBeNull();
    expect(payload.lb_orchestration_state_ref).toBeNull();
    // The clear is bundled into the same upsert so the next step
    // (performDirectProvision) reads a clean row from the same write.
    expect(payload.user_id).toBe(2);
    expect(payload.leadbridge_connected).toBe(true);
  });
});
