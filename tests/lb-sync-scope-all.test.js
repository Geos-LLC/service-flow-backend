/**
 * LeadBridge sync — scope=all contract fix + error-logging hardening.
 *
 * Background: LB started returning 400 ("businessId or scope=all is required
 * for this list endpoint") on the bare /v1/{platform}/leads endpoint around
 * 2026-04-28. SF's sync silently failed for every account for ~26 days
 * because the catch block only logged e.message ("Request failed with
 * status code 400"), hiding LB's actual error string.
 *
 * Coverage (per spec):
 *   1. Thumbtack sync request includes ?scope=all
 *   2. Yelp sync request includes ?scope=all
 *   3. Returned leads still partition by external_business_id
 *   4. 400 upstream error logs response body
 *   5. No duplicate provider accounts on reconnect
 *   6. Existing webhook subscription reuse remains unchanged
 *
 * Tests 1-4 directly verify the fix.
 * Tests 5-6 are source-scan regression guards for already-correct behavior
 *   verified live during the 2026-05-23 reconnect.
 */

const fs = require('fs');
const path = require('path');

const LB_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'leadbridge-service.js'),
  'utf8'
);

// ───────────────────────────────────────────────────────────
// 1 & 2 — scope=all is on the leads list path for both platforms
// ───────────────────────────────────────────────────────────
describe('LB leads list endpoint includes scope=all', () => {
  test('TEST #1+2 — leadsPath template uses ?scope=all (both platforms via ${platform})', () => {
    // The fix is one templated line that serves both thumbtack and yelp.
    expect(LB_SRC).toMatch(
      /const leadsPath = `\/v1\/\$\{platform\}\/leads\?scope=all`/
    );
  });

  test('REGRESSION — the bare /v1/${platform}/leads path (no query) is gone', () => {
    // Watch for any backslide. Allow it inside the comment block but not in
    // executable code: require the trailing backtick (string literal close)
    // to follow `leads` directly — that's only true when the query string
    // is missing.
    const bareCount = (
      LB_SRC.match(/const leadsPath = `\/v1\/\$\{platform\}\/leads`/g) || []
    ).length;
    expect(bareCount).toBe(0);
  });

  test('the path is the only LB leads-list call site (defensive)', () => {
    // Make sure no other call site bypasses the fix by constructing the
    // path elsewhere.
    const otherSites = (
      LB_SRC.match(/['"`]\/v1\/(thumbtack|yelp)\/leads(?!\/)/g) || []
    ).filter((s) => !s.includes('${platform}'));
    expect(otherSites).toEqual([]);
  });
});

// ───────────────────────────────────────────────────────────
// 3 — client-side filter by external_business_id preserved
// ───────────────────────────────────────────────────────────
describe('per-account partitioning preserved', () => {
  test('TEST #3 — leads are still filtered by acct.external_business_id client-side', () => {
    expect(LB_SRC).toMatch(
      /allLeads\.filter\(l\s*=>\s*l\.businessId\s*===\s*acct\.external_business_id\)/
    );
  });

  test('the filter still gates on acct.external_business_id being truthy', () => {
    // Pattern: `acct.external_business_id ? allLeads.filter(...) : allLeads`
    // (ternary form, defends against accidental removal of the conditional).
    expect(LB_SRC).toMatch(
      /acct\.external_business_id[\s\S]{0,80}allLeads\.filter[\s\S]{0,200}:\s*allLeads/
    );
  });
});

// ───────────────────────────────────────────────────────────
// 4 — upstream error logging captures response body + context
// ───────────────────────────────────────────────────────────
describe('LB sync error logging captures upstream response body', () => {
  test('TEST #4a — Account-level catch logs status + body + platform + user_id + account_id + business_id', () => {
    // Find the account-level catch by its log prefix and assert it
    // serializes the structured context we now require.
    const at = LB_SRC.indexOf('[LB Sync] Account ');
    expect(at).toBeGreaterThan(-1);
    // Window covers the structured fields we added.
    const window = LB_SRC.slice(at, at + 800);
    expect(window).toMatch(/status:\s*upstreamStatus|status:\s*e\.response\?\.status/);
    expect(window).toMatch(/body:\s*upstreamBody|body:\s*e\.response\?\.data/);
    expect(window).toMatch(/platform/);
    expect(window).toMatch(/user_id/);
    expect(window).toMatch(/account_id/);
    expect(window).toMatch(/business_id/);
  });

  test('TEST #4b — Messages-loop catch also logs upstream body + context', () => {
    const at = LB_SRC.indexOf('[LB Sync] Messages for lead ');
    expect(at).toBeGreaterThan(-1);
    const window = LB_SRC.slice(at, at + 600);
    expect(window).toMatch(/status:\s*e\.response\?\.status/);
    expect(window).toMatch(/body:\s*e\.response\?\.data/);
    expect(window).toMatch(/platform/);
    expect(window).toMatch(/user_id/);
    expect(window).toMatch(/account_id/);
  });

  test('TEST #4c — persisted sync_error includes upstream status + LB-provided message', () => {
    // The DB column gets a compact human-readable form so operators see the
    // actual reason in the UI, not just the axios "status code N" string.
    const at = LB_SRC.indexOf('[LB Sync] Account ');
    const window = LB_SRC.slice(at, at + 1200);
    expect(window).toMatch(/sync_error:\s*upstreamStatus\s*\?[\s\S]{0,120}persistedError/);
    expect(window).toMatch(
      /persistedError\s*=\s*upstreamBody\?\.message\s*\|\|\s*upstreamBody\?\.error\s*\|\|\s*e\.message/
    );
  });

  test('TEST #4d — no logging of Authorization header or token values', () => {
    // Spot-check: tokens are never echoed in axios errors so we shouldn't
    // see them in our error logs. Guard against future regressions.
    const at = LB_SRC.indexOf('[LB Sync] Account ');
    const window = LB_SRC.slice(at, at + 1200);
    expect(window).not.toMatch(/lbToken|Bearer\s|leadbridge_integration_token|authorization/i);
  });
});

// ───────────────────────────────────────────────────────────
// 5 — reconnect upserts provider_accounts (no duplicates)
// ───────────────────────────────────────────────────────────
describe('reconnect handler does not create duplicate provider_accounts', () => {
  test('TEST #5 — find-then-update-or-insert pattern keyed on external_account_id', () => {
    // The connect path at line ~775 does:
    //   .from('communication_provider_accounts')
    //   .select('id')
    //   .eq('user_id', userId)
    //   .eq('provider', 'leadbridge')
    //   .eq('channel', channel)
    //   .eq('external_account_id', externalId)
    //   .maybeSingle()
    //   if (existing) UPDATE else INSERT
    expect(LB_SRC).toMatch(
      /\.from\(['"]communication_provider_accounts['"]\)[\s\S]{0,300}\.eq\(['"]external_account_id['"],/
    );
    // The conditional branch must exist.
    expect(LB_SRC).toMatch(/if\s*\(existing\)\s*\{[\s\S]{0,600}\.update\(/);
    expect(LB_SRC).toMatch(/\}\s*else\s*\{[\s\S]{0,800}\.insert\(/);
  });

  test('REGRESSION — INSERT into provider_accounts only happens in the else branch', () => {
    // Count unconditional inserts of communication_provider_accounts to make
    // sure no new code path bypasses the find-first guard. The connect path
    // is the only legitimate insert site (the source-account boundary helpers
    // live in lib/source-account.js, not this file).
    const matches = LB_SRC.match(/\.from\(['"]communication_provider_accounts['"]\)\.insert\(/g) || [];
    // Should be at most 1 (the connect path's else branch).
    expect(matches.length).toBeLessThanOrEqual(1);
  });
});

// ───────────────────────────────────────────────────────────
// 6 — existing webhook subscription reuse remains intact
// ───────────────────────────────────────────────────────────
describe('webhook subscription reuse on reconnect', () => {
  test('TEST #6 — outbound/lead_status/inbound subscriptions persist their IDs via OUTBOUND_/LEAD_STATUS_/INBOUND_COLUMNS', () => {
    // These column groupings exist so reconnect can read the prior
    // subscription id back from the DB and avoid re-registering. Live
    // verification on 2026-05-23 reconnect confirmed the same IDs were
    // reused across disconnect→reconnect. Guard the column groupings here.
    expect(LB_SRC).toMatch(/OUTBOUND_COLUMNS\s*=\s*\[/);
    expect(LB_SRC).toMatch(/leadbridge_outbound_subscription_id/);
    expect(LB_SRC).toMatch(/LEAD_STATUS_COLUMNS\s*=\s*\[/);
    expect(LB_SRC).toMatch(/leadbridge_lead_status_subscription_id/);
    expect(LB_SRC).toMatch(/leadbridge_inbound_subscription_id/);
  });

  test('registerOutboundSubscription is called (not a hard-fail on existing-sub)', () => {
    // Subscription registration must not crash reconnect if the subscription
    // already exists. The comment at the call site documents this contract.
    expect(LB_SRC).toMatch(/registerOutboundSubscription/);
    expect(LB_SRC).toMatch(/MUST NOT fail the connect flow|never break connect/i);
  });
});
