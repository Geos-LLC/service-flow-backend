/**
 * Phase A contract test — tenant isolation invariants.
 *
 * Scope:
 *   - All operator endpoint Supabase queries filter by user_id from JWT.
 *   - Source-text scan: every .from('zb_outbound_commands') call inside
 *     zb-outbound.js is followed by an .eq('user_id', ...) before .select().
 *   - team_member_provider_mappings table has UNIQUE (user_id, zenbooker_provider_id)
 *     so one tenant's mapping cannot collide with another's.
 *   - claim RPC operates on shared rows; tenant isolation is enforced at
 *     application read layer (verified by source scan).
 */

const fs = require('fs');
const path = require('path');

const ROUTER_JS = fs.readFileSync(path.join(__dirname, '..', 'zb-outbound.js'), 'utf8');
const MIG_044 = fs.readFileSync(path.join(__dirname, '..', 'migrations', '044_zb_outbound_commands.sql'), 'utf8');
const MIG_045 = fs.readFileSync(path.join(__dirname, '..', 'migrations', '045_team_member_provider_mappings.sql'), 'utf8');

describe('tenant scope guards in operator router', () => {
  test('every .from(zb_outbound_commands) is paired with .eq(user_id', () => {
    // Source scan — look at occurrences of .from('zb_outbound_commands')
    // and assert .eq('user_id', userId) appears within ~600 chars after each.
    const occurrences = [];
    let idx = 0;
    while ((idx = ROUTER_JS.indexOf(".from('zb_outbound_commands')", idx)) !== -1) {
      occurrences.push(idx);
      idx += 1;
    }
    expect(occurrences.length).toBeGreaterThan(0);
    for (const at of occurrences) {
      const window = ROUTER_JS.slice(at, at + 600);
      expect(window).toMatch(/\.eq\(['"]user_id['"],\s*userId\)/);
    }
  });

  test('every authenticateToken handler reads req.user.userId', () => {
    expect(ROUTER_JS).toMatch(/req\.user\.userId/);
    // No route registers without authenticateToken
    const routeLines = ROUTER_JS.split('\n').filter((l) => /router\.(get|post|patch|delete)\(/.test(l));
    expect(routeLines.length).toBeGreaterThan(0);
    for (const line of routeLines) {
      expect(line).toContain('authenticateToken');
    }
  });

  test('team_member_provider_mappings query filters by user_id', () => {
    const at = ROUTER_JS.indexOf(".from('team_member_provider_mappings')");
    expect(at).toBeGreaterThan(-1);
    const window = ROUTER_JS.slice(at, at + 600);
    expect(window).toMatch(/\.eq\(['"]user_id['"],\s*userId\)/);
  });
});

describe('schema-level isolation', () => {
  test('zb_outbound_commands.user_id is NOT NULL', () => {
    // BIGINT matches SF schema (users.id / team_members.user_id are INTEGER;
    // BIGINT is a forward-compatible superset).
    expect(MIG_044).toMatch(/user_id\s+BIGINT\s+NOT NULL/);
  });

  test('team_member_provider_mappings has unique (user_id, zenbooker_provider_id)', () => {
    expect(MIG_045).toMatch(/UNIQUE\s*\(user_id,\s*zenbooker_provider_id\)/);
  });

  test('team_member_provider_mappings has unique (user_id, sf_team_member_id)', () => {
    expect(MIG_045).toMatch(/UNIQUE\s*\(user_id,\s*sf_team_member_id\)/);
  });

  test('idx_zb_outbound_user is user_id-leading', () => {
    expect(MIG_044).toMatch(/idx_zb_outbound_user[\s\S]{0,200}\(user_id,/);
  });

  test('idx_zb_outbound_field_group_open is user_id-leading', () => {
    expect(MIG_044).toMatch(/idx_zb_outbound_field_group_open[\s\S]{0,200}\(user_id,/);
  });
});

describe('claim RPC does NOT cross tenants implicitly', () => {
  test('claim_due returns user_id in payload (callers must filter)', () => {
    // The RPC returns user_id so the application layer can route per
    // tenant. Tenant isolation is enforced by the application (drainer
    // calls supabase-side API keys per row.user_id).
    expect(MIG_044).toMatch(/RETURNS TABLE[\s\S]*user_id\s+BIGINT/);
  });
});
