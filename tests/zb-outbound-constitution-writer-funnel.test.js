/**
 * Phase A contract test — writer-funnel invariants.
 *
 * 1. zb_outbound_commands INSERT may ONLY originate from a documented
 *    producer module. Phase A has no producers; the assertion is that
 *    no .insert into the table appears in zb-outbound.js or the
 *    drainer worker.
 * 2. The drainer's processRow function MUST NOT write to canonical SF
 *    projection tables (jobs, job_team_assignments, customers,
 *    team_members). The single-writer guarantee (constitution §2.4)
 *    means projections are written ONLY by the inbound webhook handler.
 * 3. §4.4 diff invariant: zb-outbound-delivery.js MUST reject any
 *    payload containing assigned_providers replacement array.
 */

const fs = require('fs');
const path = require('path');

const ROUTER_JS = fs.readFileSync(path.join(__dirname, '..', 'zb-outbound.js'), 'utf8');
const DRAINER_JS = fs.readFileSync(path.join(__dirname, '..', 'workers', 'zb-outbound-drainer.js'), 'utf8');
const DELIVERY_JS = fs.readFileSync(path.join(__dirname, '..', 'lib', 'zb-outbound-delivery.js'), 'utf8');

describe('Phase A: no producer in router or drainer', () => {
  test('zb-outbound.js does NOT INSERT into zb_outbound_commands', () => {
    // Read-only operator endpoints; no .insert(...) calls in this file
    expect(ROUTER_JS).not.toMatch(/from\(['"]zb_outbound_commands['"]\)[\s\S]{0,200}\.insert/);
  });

  test('drainer does NOT INSERT into zb_outbound_commands', () => {
    expect(DRAINER_JS).not.toMatch(/from\(['"]zb_outbound_commands['"]\)[\s\S]{0,200}\.insert/);
  });
});

describe('drainer does NOT write SF projection tables (single-writer §2.4)', () => {
  const FORBIDDEN_TABLES = ['jobs', 'job_team_assignments', 'customers', 'team_members'];

  for (const tbl of FORBIDDEN_TABLES) {
    test(`drainer does not .update on ${tbl}`, () => {
      // Look for any .from('<tbl>') that's followed by .update / .insert / .delete
      const pattern = new RegExp(`from\\(['"]${tbl}['"]\\)[\\s\\S]{0,200}\\.(update|insert|delete)`);
      expect(DRAINER_JS).not.toMatch(pattern);
    });
  }

  test('drainer ONLY mutates zb_outbound_commands (its own queue)', () => {
    // The Phase A processRow stub updates zb_outbound_commands itself
    expect(DRAINER_JS).toMatch(/from\(['"]zb_outbound_commands['"]\)[\s\S]{0,200}\.update/);
  });
});

describe('§4.4 diff invariant enforcement', () => {
  test('delivery module rejects assigned_providers replacement array', () => {
    // The validation rejects the forbidden replacement-array payload
    expect(DELIVERY_JS).toMatch(/assigned_providers.+forbidden.+§4\.4|assigned_providers replacement array forbidden/);
  });

  test('delivery module requires {assign, unassign, notify} for assign_providers', () => {
    expect(DELIVERY_JS).toMatch(/assign array required/);
    expect(DELIVERY_JS).toMatch(/unassign array required/);
    expect(DELIVERY_JS).toMatch(/notify boolean required/);
  });

  test('FIELD_GROUP maps each command_type', () => {
    const { FIELD_GROUP, ALLOWED_COMMAND_TYPES } = require('../lib/zb-outbound-delivery');
    for (const ct of ALLOWED_COMMAND_TYPES) {
      expect(FIELD_GROUP[ct]).toBeDefined();
    }
  });
});

describe('origin metadata enforcement (design §3.7)', () => {
  test('VALID_ORIGINS is the documented 5', () => {
    const { VALID_ORIGINS } = require('../lib/zb-outbound-delivery');
    expect(VALID_ORIGINS.slice().sort()).toEqual(['api', 'automation', 'migration', 'reconcile', 'user']);
  });

  test('default origin is "user" when unspecified', () => {
    const { buildCommandRow } = require('../lib/zb-outbound-delivery');
    const r = buildCommandRow({
      user_id: 'u1', command_type: 'job.cancel', sf_job_id: 'j1',
      payload: {}, source_revision: { status: 'scheduled', canceled: false },
    });
    expect(r.row.origin).toBe('user');
  });
});
