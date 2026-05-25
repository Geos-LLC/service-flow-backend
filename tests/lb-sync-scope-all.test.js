/**
 * LeadBridge sync — canonical /v1/leads?scope=all endpoint contract.
 *
 * History:
 *   - 2026-04-28: LB started returning 400 on bare /v1/{platform}/leads.
 *     First fix added ?scope=all per-platform.
 *   - 2026-05-24: Reconciliation against LB DB showed /v1/thumbtack/leads
 *     returned ALL leads (Thumbtack + Yelp) while /v1/yelp/leads returned
 *     only ~30% of Yelp leads (broken/partial). Switched to the canonical
 *     /v1/leads?scope=all which returns the full 1,416-lead corpus with
 *     each lead carrying its own `platform` field.
 *
 * Coverage:
 *   1. Sync fetches /v1/leads?scope=all (canonical) — once per sync run
 *   2. No per-platform /v1/{thumbtack|yelp}/leads list calls remain
 *   3. Leads still partition per-account by external_business_id
 *   4. Upstream error logging captures status + body + context
 *   5. No duplicate provider accounts on reconnect
 *   6. Existing webhook subscription reuse remains unchanged
 */

const fs = require('fs');
const path = require('path');

const LB_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'leadbridge-service.js'),
  'utf8'
);

// ───────────────────────────────────────────────────────────
// 1 — canonical /v1/leads?scope=all is the only leads-list call site
// ───────────────────────────────────────────────────────────
describe('LB sync uses canonical /v1/leads?scope=all', () => {
  test('TEST #1 — sync calls /v1/leads?scope=all (canonical, no platform in path)', () => {
    expect(LB_SRC).toMatch(/['"`]\/v1\/leads\?scope=all['"`]/);
  });

  test('TEST #2 — canonical fetch is hoisted (single call site, not per-account)', () => {
    // The canonical fetch must happen ONCE, then be filtered per account.
    // Heuristic: the canonical path string appears at most a few times in
    // the file (once in code, optionally in a log line / comment).
    const matches = LB_SRC.match(/\/v1\/leads\?scope=all/g) || [];
    expect(matches.length).toBeGreaterThanOrEqual(1);
    expect(matches.length).toBeLessThanOrEqual(5);
  });

  test('REGRESSION — no /v1/${platform}/leads list calls remain (template form)', () => {
    const tplMatches = LB_SRC.match(/`\/v1\/\$\{platform\}\/leads[^`]*`/g) || [];
    expect(tplMatches).toEqual([]);
  });

  test('REGRESSION — no hardcoded /v1/thumbtack/leads or /v1/yelp/leads list calls', () => {
    // The per-platform list endpoints proved unreliable:
    //   /v1/thumbtack/leads — returned all platforms (route misleading)
    //   /v1/yelp/leads      — returned only ~30% of yelp leads
    // Per-lead /v1/thumbtack/leads/:id/messages is a SEPARATE endpoint and
    // legitimate, so we explicitly allow paths with /:something after /leads.
    const listSites = (
      LB_SRC.match(/['"`]\/v1\/(thumbtack|yelp)\/leads(?!\/)/g) || []
    );
    expect(listSites).toEqual([]);
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
    expect(LB_SRC).toMatch(
      /acct\.external_business_id[\s\S]{0,80}allLeads\.filter[\s\S]{0,200}:\s*allLeads/
    );
  });
});

// ───────────────────────────────────────────────────────────
// 4 — upstream error logging captures response body + context
// ───────────────────────────────────────────────────────────
describe('LB sync error logging captures upstream response body', () => {
  test('TEST #4a — Canonical-fetch failure logs status + body + user_id', () => {
    const at = LB_SRC.indexOf('/v1/leads?scope=all failed');
    expect(at).toBeGreaterThan(-1);
    const window = LB_SRC.slice(at, at + 600);
    expect(window).toMatch(/status:\s*upstreamStatus/);
    expect(window).toMatch(/body:\s*upstreamBody/);
    expect(window).toMatch(/user_id/);
  });

  test('TEST #4b — Account-level catch logs status + body + platform + user_id + account_id + business_id', () => {
    const at = LB_SRC.indexOf('[LB Sync] Account ');
    expect(at).toBeGreaterThan(-1);
    const window = LB_SRC.slice(at, at + 800);
    expect(window).toMatch(/status:\s*upstreamStatus|status:\s*e\.response\?\.status/);
    expect(window).toMatch(/body:\s*upstreamBody|body:\s*e\.response\?\.data/);
    expect(window).toMatch(/platform/);
    expect(window).toMatch(/user_id/);
    expect(window).toMatch(/account_id/);
    expect(window).toMatch(/business_id/);
  });

  test('TEST #4c — Messages-loop catch also logs upstream body + context', () => {
    const at = LB_SRC.indexOf('[LB Sync] Messages for lead ');
    expect(at).toBeGreaterThan(-1);
    const window = LB_SRC.slice(at, at + 600);
    expect(window).toMatch(/status:\s*e\.response\?\.status/);
    expect(window).toMatch(/body:\s*e\.response\?\.data/);
    expect(window).toMatch(/platform/);
    expect(window).toMatch(/user_id/);
    expect(window).toMatch(/account_id/);
  });

  test('TEST #4d — persisted sync_error includes upstream status + LB-provided message', () => {
    const at = LB_SRC.indexOf('[LB Sync] Account ');
    const window = LB_SRC.slice(at, at + 1200);
    expect(window).toMatch(/sync_error:\s*upstreamStatus\s*\?[\s\S]{0,120}persistedError/);
    expect(window).toMatch(
      /persistedError\s*=\s*upstreamBody\?\.message\s*\|\|\s*upstreamBody\?\.error\s*\|\|\s*e\.message/
    );
  });

  test('TEST #4e — no logging of Authorization header or token values', () => {
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
    expect(LB_SRC).toMatch(
      /\.from\(['"]communication_provider_accounts['"]\)[\s\S]{0,300}\.eq\(['"]external_account_id['"],/
    );
    expect(LB_SRC).toMatch(/if\s*\(existing\)\s*\{[\s\S]{0,600}\.update\(/);
    expect(LB_SRC).toMatch(/\}\s*else\s*\{[\s\S]{0,800}\.insert\(/);
  });

  test('REGRESSION — INSERT into provider_accounts only happens in the else branch', () => {
    const matches = LB_SRC.match(/\.from\(['"]communication_provider_accounts['"]\)\.insert\(/g) || [];
    expect(matches.length).toBeLessThanOrEqual(1);
  });
});

// ───────────────────────────────────────────────────────────
// 6 — existing webhook subscription reuse remains intact
// ───────────────────────────────────────────────────────────
describe('webhook subscription reuse on reconnect', () => {
  test('TEST #6 — outbound/lead_status/inbound subscriptions persist their IDs', () => {
    expect(LB_SRC).toMatch(/OUTBOUND_COLUMNS\s*=\s*\[/);
    expect(LB_SRC).toMatch(/leadbridge_outbound_subscription_id/);
    expect(LB_SRC).toMatch(/LEAD_STATUS_COLUMNS\s*=\s*\[/);
    expect(LB_SRC).toMatch(/leadbridge_lead_status_subscription_id/);
    expect(LB_SRC).toMatch(/leadbridge_inbound_subscription_id/);
  });

  test('registerOutboundSubscription is called (not a hard-fail on existing-sub)', () => {
    expect(LB_SRC).toMatch(/registerOutboundSubscription/);
    expect(LB_SRC).toMatch(/MUST NOT fail the connect flow|never break connect/i);
  });
});
