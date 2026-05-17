#!/usr/bin/env node
'use strict';

// Hand-runnable smoke script for the Public Past Cleanings Map Widget V1
// (issue #3). Mirrors a subset of tests/public-past-cleanings-map.test.js
// so an operator can sanity-check the pure pipeline without spinning up
// jest. Run with:
//
//   node scripts/smoke-past-cleanings-map.js
//
// Exit code: 0 = all assertions pass, 1 = any failure.

const assert = require('assert');
const {
  MAX_PUBLIC_WIDGET_PINS,
  GEO_METHODS,
  projectFromJob,
  rowToPin,
  resolveTenantSettings,
  buildEffectiveOptions,
  buildResponse,
  disabledResponse,
} = require('../lib/public-past-cleanings-map');

function makeJob(over) {
  return Object.assign({
    id: 100, user_id: 1,
    customer_name: 'Jane Doe', customer_email: 'jane@example.com',
    customer_phone: '+15551234567',
    status: 'completed',
    completed_at: '2026-04-15T18:00:00.000Z',
    scheduled_date: '2026-04-15',
    service_name: 'Deep Clean',
    service_address_street: '123 Real Street',
    service_address_city: 'Brooklyn', service_address_zip: '11215',
    service_address_lat: 40.6680, service_address_lng: -73.9855,
    notes: 'gate code 1234',
  }, over || {});
}

let failures = 0;
function check(label, fn) {
  try { fn(); console.log('  ok  ' + label); }
  catch (e) { failures++; console.log('  FAIL ' + label + ': ' + e.message); }
}

console.log('public-past-cleanings-map smoke');

check('projection drops non-completed jobs', () => {
  for (const s of ['pending', 'cancelled', 'scheduled', null]) {
    assert.strictEqual(projectFromJob(makeJob({ status: s })), null);
  }
});

check('projection has no PII columns', () => {
  const row = projectFromJob(makeJob());
  const allowed = ['tenant_id','job_id','public_lat','public_lng','public_geo_method','service_type','city','completed_month','completed_year','completed_on'];
  assert.deepStrictEqual(Object.keys(row).sort(), allowed.slice().sort());
  assert.ok(!JSON.stringify(row).match(/Jane Doe|jane@example|5551234567|123 Real Street|gate code/i));
});

check('projection records jitter as geo method', () => {
  assert.strictEqual(projectFromJob(makeJob()).public_geo_method, GEO_METHODS.JITTER);
});

check('projection deterministic by job id', () => {
  assert.deepStrictEqual(projectFromJob(makeJob({ id: 7 })), projectFromJob(makeJob({ id: 7 })));
});

check('projection lat/lng never equal source coords', () => {
  const j = makeJob({ id: 42 });
  const row = projectFromJob(j);
  assert.notStrictEqual(row.public_lat, j.service_address_lat);
  assert.notStrictEqual(row.public_lng, j.service_address_lng);
});

check('rowToPin returns only public keys', () => {
  const pin = rowToPin(projectFromJob(makeJob()));
  assert.deepStrictEqual(Object.keys(pin).sort(), ['city','completedMonth','lat','lng','serviceType']);
});

check('tenant settings disabled by default', () => {
  assert.strictEqual(resolveTenantSettings({}).enabled, false);
});

check('tenant settings clamp max pins to hard cap (500)', () => {
  assert.strictEqual(MAX_PUBLIC_WIDGET_PINS, 500);
  const s = resolveTenantSettings({ past_cleanings_enabled: true, past_cleanings_max_pins: 99999, past_cleanings_range: 'all' });
  assert.strictEqual(s.maxPins, 500);
});

check('query maxPins cannot exceed tenant cap', () => {
  const o = buildEffectiveOptions({ past_cleanings_enabled: true, past_cleanings_max_pins: 100, past_cleanings_range: 'all' }, { maxPins: '99999' });
  assert.strictEqual(o.maxPins, 100);
});

check('query range can shorten but not lengthen', () => {
  const tight = { past_cleanings_enabled: true, past_cleanings_max_pins: 100, past_cleanings_range: '90d' };
  assert.strictEqual(buildEffectiveOptions(tight, { range: 'all' }).range, '90d');
  assert.strictEqual(buildEffectiveOptions(tight, { range: '365d' }).range, '90d');
});

check('buildResponse: maxPins is enforced', () => {
  const rows = [];
  for (let i = 0; i < 50; i++) rows.push(projectFromJob(makeJob({ id: 1000 + i })));
  const body = buildResponse({ rows, options: { range: 'all', maxPins: 7 }, tenantPublicId: 't1' });
  assert.strictEqual(body.pinCount, 7);
  assert.strictEqual(body.pins.length, 7);
});

check('disabledResponse shape', () => {
  const b = disabledResponse('acme');
  assert.strictEqual(b.enabled, false);
  assert.strictEqual(b.pinCount, 0);
  assert.deepStrictEqual(b.pins, []);
});

if (failures) {
  console.log('FAILED: ' + failures + ' assertion(s)');
  process.exit(1);
}
console.log('all smoke checks passed');
