/**
 * PR-2 — webhook handler invariants (source-text scan tests).
 *
 * Without spinning up Express, these tests assert the handler integration
 * has the right SHAPE: feature-flag gating, no metadata.userId fallback,
 * 401 reject paths, candidate-scan pattern, cross-tenant guards.
 *
 * Functional verification with real signatures lives in
 * tests/webhook-signature.test.js (the helper) and in the staging soak.
 */

const fs = require('fs');
const path = require('path');

const SERVER_JS = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const LB_JS = fs.readFileSync(path.join(__dirname, '..', 'leadbridge-service.js'), 'utf8');

// Pull only the Sigcore webhook handler block — narrows the search surface
// so unrelated mentions of "metadata.userId" elsewhere don't poison tests.
function extractHandlerBlock(src, startMarker, endMarker) {
  const startIdx = src.indexOf(startMarker);
  if (startIdx === -1) throw new Error(`Marker not found: ${startMarker}`);
  const endIdx = src.indexOf(endMarker, startIdx);
  if (endIdx === -1) throw new Error(`End marker not found: ${endMarker}`);
  return src.slice(startIdx, endIdx);
}

const SIGCORE_BLOCK = extractHandlerBlock(
  SERVER_JS,
  "app.post('/api/communications/webhooks/sigcore'",
  "// ── Phase 4: Sync/Backfill"
);

const LB_WEBHOOKS_BLOCK = extractHandlerBlock(
  LB_JS,
  "router.post('/webhooks',",
  "// ══════════════════════════════════════\n  // Background sync function"
);

// ─── Sigcore webhook handler ────────────────────────────────────────

describe('Sigcore webhook handler', () => {
  test('imports authenticateWebhook helper', () => {
    expect(SERVER_JS).toMatch(/require\('\.\/lib\/webhook-signature'\)/);
  });

  test('reads X-Sigcore-Signature header (with x-callio fallback for compat)', () => {
    expect(SIGCORE_BLOCK).toMatch(/x-sigcore-signature/);
    expect(SIGCORE_BLOCK).toMatch(/x-callio-signature/);
  });

  test('reads X-Sigcore-Timestamp header', () => {
    expect(SIGCORE_BLOCK).toMatch(/x-sigcore-timestamp/);
  });

  test('verification scans candidates from communication_settings.sigcore_webhook_secret', () => {
    expect(SIGCORE_BLOCK).toMatch(/sigcore_webhook_secret/);
    expect(SIGCORE_BLOCK).toMatch(/authenticateWebhook\(/);
  });

  test('flag-gates the 401 reject (SIGCORE_WEBHOOK_HMAC_REQUIRED)', () => {
    expect(SIGCORE_BLOCK).toMatch(/isEnabled\(FLAGS\.SIGCORE_WEBHOOK_HMAC_REQUIRED\)/);
    // 401 only reached when flag enforced + verification failed
    const enforcedSection = SIGCORE_BLOCK.match(/if \(enforced && !verifiedUserId\)[\s\S]+?return res\.status\(401\)/);
    expect(enforcedSection).toBeTruthy();
  });

  test('metadata.userId LEGACY FALLBACK is removed', () => {
    // The old code path: `if (payload.metadata?.userId) { userId = parseInt(...); }`
    // PR-2 removes that. The string `metadata.userId` can still appear in comments
    // explaining the removal; what must NOT appear is the actual assignment.
    expect(SIGCORE_BLOCK).not.toMatch(/userId\s*=\s*parseInt\(\s*payload\.metadata/);
    expect(SIGCORE_BLOCK).not.toMatch(/userId\s*=\s*payload\.metadata/);
  });

  test('cross-tenant defense: signed userId must match routed userId', () => {
    expect(SIGCORE_BLOCK).toMatch(/verifiedUserId.*!==.*userId|userId.*!==.*verifiedUserId/);
    expect(SIGCORE_BLOCK).toMatch(/cross-tenant/i);
  });

  test('handler does NOT set hidden_at, does NOT touch identities', () => {
    // PR-2 is strictly auth — it must not stray into other tables.
    // The original handler does touch identities (legitimate for OP sync);
    // what we assert is that the AUTH BLOCK at the top doesn't.
    const authPrefix = SIGCORE_BLOCK.split('// Return 200 immediately')[0];
    expect(authPrefix).not.toMatch(/communication_participant_identities/);
    expect(authPrefix).not.toMatch(/SET hidden_at/i);
  });
});

// ─── LB /webhooks handler ───────────────────────────────────────────

describe('LB /webhooks handler', () => {
  test('reads X-LB-Signature + X-LB-Timestamp', () => {
    expect(LB_WEBHOOKS_BLOCK).toMatch(/x-lb-signature/);
    expect(LB_WEBHOOKS_BLOCK).toMatch(/x-lb-timestamp/);
  });

  test('flag-gates 401 (LB_INBOUND_HMAC_REQUIRED)', () => {
    expect(LB_WEBHOOKS_BLOCK).toMatch(/isEnabled\(FLAGS\.LB_INBOUND_HMAC_REQUIRED\)/);
    const enforcedSection = LB_WEBHOOKS_BLOCK.match(/if \(enforced && !verifiedUserId\)[\s\S]+?return res\.status\(401\)/);
    expect(enforcedSection).toBeTruthy();
  });

  test('decrypts per-user inbound secret via decryptIntegrationSecret', () => {
    expect(LB_WEBHOOKS_BLOCK).toMatch(/leadbridge_inbound_encrypted_secret/);
    expect(LB_WEBHOOKS_BLOCK).toMatch(/decryptIntegrationSecret/);
  });

  test('cross-tenant defense: signed userId must match account_id lookup', () => {
    expect(LB_WEBHOOKS_BLOCK).toMatch(/cross-tenant/i);
    expect(LB_WEBHOOKS_BLOCK).toMatch(/acct\.user_id\s*!==\s*verifiedUserId/);
  });

  test('still does idempotency check on event_id', () => {
    expect(LB_WEBHOOKS_BLOCK).toMatch(/Idempotency check/);
    expect(LB_WEBHOOKS_BLOCK).toMatch(/communication_webhook_events/);
  });

  test('does not fall back to payload-only attribution when flag enforced', () => {
    // When flag ON without a verified signature, the request MUST 401 —
    // it must NOT fall through to the old account_id-only path.
    const enforcedReturn = LB_WEBHOOKS_BLOCK.match(/if \(enforced && !verifiedUserId\)[\s\S]+?return res\.status\(401\)[\s\S]+?\}/);
    expect(enforcedReturn).toBeTruthy();
    expect(enforcedReturn[0]).toMatch(/return res\.status\(401\)/);
  });
});

// ─── Connect / Reconnect / Disconnect surface ───────────────────────

describe('LB connect/reconnect/disconnect lifecycle for inbound subscription', () => {
  test('connect handler calls registerInboundSubscription', () => {
    expect(LB_JS).toMatch(/registerInboundSubscription/);
    // Must appear inside the /connect handler — pull just that block
    const connectBlock = LB_JS.match(/router\.post\('\/connect'[\s\S]+?(?=router\.(?:get|post|delete|patch)\()/);
    expect(connectBlock).toBeTruthy();
    expect(connectBlock[0]).toMatch(/registerInboundSubscription/);
  });

  test('reconnect handler calls registerInboundSubscription', () => {
    const reconnectBlock = LB_JS.match(/router\.post\('\/reconnect'[\s\S]+?(?=router\.(?:get|post|delete|patch)\()/);
    expect(reconnectBlock).toBeTruthy();
    expect(reconnectBlock[0]).toMatch(/registerInboundSubscription/);
  });

  test('disconnect clears INBOUND_COLUMNS', () => {
    const disconnectBlock = LB_JS.match(/router\.delete\('\/disconnect'[\s\S]+?(?=router\.(?:get|post|delete|patch)\()/);
    expect(disconnectBlock).toBeTruthy();
    expect(disconnectBlock[0]).toMatch(/INBOUND_COLUMNS/);
  });

  test('integration status surface includes inbound subscription state', () => {
    const statusBlock = LB_JS.match(/buildIntegrationStatus[\s\S]+?(?=^\s*async function\s|^\s*router\.)/m);
    expect(statusBlock).toBeTruthy();
    expect(statusBlock[0]).toMatch(/inbound_subscription_id|inbound_registered_at|inboundSubActive/);
  });

  test('reconnect_required true when any leg (incl. inbound) inactive', () => {
    expect(LB_JS).toMatch(/reconnect_required:\s*!outboundActive\s*\|\|\s*!leadStatusActive\s*\|\|\s*!inboundSubActive/);
  });
});

// ─── Migration shape ────────────────────────────────────────────────

describe('migration 037 shape', () => {
  const migration = fs.readFileSync(
    path.join(__dirname, '..', 'migrations', '037_lb_inbound_subscription.sql'),
    'utf8'
  );

  test('adds 7 leadbridge_inbound_* columns', () => {
    const cols = [
      'leadbridge_inbound_subscription_id',
      'leadbridge_inbound_encrypted_secret',
      'leadbridge_inbound_secret_key_version',
      'leadbridge_inbound_webhook_url',
      'leadbridge_inbound_events',
      'leadbridge_inbound_registered_at',
      'leadbridge_inbound_last_event_at',
    ];
    for (const c of cols) {
      expect(migration).toMatch(new RegExp(`ADD COLUMN IF NOT EXISTS ${c}\\s`));
    }
  });

  test('uses ADD COLUMN IF NOT EXISTS (idempotent)', () => {
    expect(migration).toMatch(/ADD COLUMN IF NOT EXISTS/);
    expect(migration).not.toMatch(/^ALTER TABLE.*ADD COLUMN [a-z]/m);
  });

  test('partial index on subscription_id', () => {
    expect(migration).toMatch(/CREATE INDEX IF NOT EXISTS communication_settings_lb_inbound_sub_idx/);
    expect(migration).toMatch(/WHERE leadbridge_inbound_subscription_id IS NOT NULL/);
  });
});
