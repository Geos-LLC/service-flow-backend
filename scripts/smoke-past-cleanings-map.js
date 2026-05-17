#!/usr/bin/env node
// Standalone smoke test for the past-cleanings-map module. Not part of
// the jest suite — handy for hand-running during development.
'use strict';

const m = require('../lib/public-past-cleanings-map');
const { FLAGS, isEnabled } = require('../lib/feature-flags');

let failures = 0;
function assert(cond, label) {
  if (cond) console.log('ok  ', label);
  else { failures++; console.log('FAIL', label); }
}

assert(FLAGS.PUBLIC_CLEANINGS_MAP_WIDGET_ENABLED === 'PUBLIC_CLEANINGS_MAP_WIDGET_ENABLED', 'flag registered');
assert(isEnabled(FLAGS.PUBLIC_CLEANINGS_MAP_WIDGET_ENABLED) === false, 'flag defaults off');

const job = {
  id: 100, status: 'completed', scheduled_date: '2026-04-15T14:30:00.000Z',
  service_name: 'Deep Clean',
  service_address_city: 'Brooklyn', service_address_zip: '11215',
  service_address_lat: 40.6680, service_address_lng: -73.9855,
  customer_name: 'Jane Doe', customer_email: 'jane@example.com',
};
const pin = m.sanitizeJob(job);
assert(JSON.stringify(Object.keys(pin).sort()) === JSON.stringify(['city','completedMonth','lat','lng','serviceType']), 'pin keys');
assert(!/Jane Doe|jane@example/i.test(JSON.stringify(pin)), 'pin no PII');
assert(m.sanitizeJob({...job, status: 'pending'}) === null, 'drops pending');
assert(m.sanitizeJob({...job, status: 'cancelled'}) === null, 'drops cancelled');
assert(m.sanitizeJob({...job, service_address_lat: null}) === null, 'drops null coord');
assert(m.sanitizeJob({...job, service_address_lat: 0, service_address_lng: 0}) === null, 'drops 0,0');
assert(m.sanitizeJob({...job, service_address_lat: 'not a number'}) === null, 'drops non-number');
assert(m.sanitizeJob({...job, service_address_lat: 95}) === null, 'drops out-of-range lat');

const det1 = m.sanitizeJob({...job, id: 7});
const det2 = m.sanitizeJob({...job, id: 7});
assert(det1.lat === det2.lat && det1.lng === det2.lng, 'deterministic');

const a = m.sanitizeJob({...job, id: 1});
const b = m.sanitizeJob({...job, id: 2});
assert(!(a.lat === b.lat && a.lng === b.lng), 'different ids differ');

const jx = m.sanitizeJob({...job, id: 42, service_address_lat: 40.66801234, service_address_lng: -73.98551234});
assert(jx.lat !== 40.66801234 && Math.abs(jx.lat - 40.66801234) < 0.005, 'jitter lat within bound');
assert(jx.lng !== -73.98551234 && Math.abs(jx.lng - -73.98551234) < 0.005, 'jitter lng within bound');

assert(m.sanitizeJob({...job, service_address_city: '', service_address_zip: '11215'}).city === '112xx', 'zip fallback');
assert(m.sanitizeJob({...job, service_address_city: null, service_address_zip: null}).city === null, 'null city/zip');
assert(m.sanitizeJob({...job, scheduled_date: '2026-04-15T14:30:00.000Z'}).completedMonth === '2026-04', 'YYYY-MM');

const def = m.parseOptions(undefined);
assert(def.range === '365d' && def.maxPins === 250 && def.rangeDays === 365, 'parseOptions defaults');
assert(m.parseOptions({range:'90'}).range === '90d', 'normalize 90 -> 90d');
assert(m.parseOptions({range:'all'}).rangeDays === null, 'all -> null rangeDays');
assert(m.parseOptions({range:'garbage'}).range === '365d', 'garbage -> default');
assert(m.parseOptions({maxPins: 999999}).maxPins === 1000, 'clamp HARD_MAX_PINS');
assert(m.parseOptions({maxPins: -10}).maxPins === 250, 'negative -> default');
assert(m.parseOptions({maxPins: 'banana'}).maxPins === 250, 'NaN -> default');
assert(m.parseOptions({maxPins: 5}).maxPins === 5, 'small explicit');

const now = new Date('2026-05-17T00:00:00.000Z');
const batch = [
  {...job, id: 1, scheduled_date: '2026-05-10T12:00:00Z'},
  {...job, id: 2, scheduled_date: '2025-09-01T12:00:00Z'},
  {...job, id: 3, scheduled_date: '2024-01-01T12:00:00Z'},
  {...job, id: 4, status: 'pending', scheduled_date: '2026-05-12T12:00:00Z'},
  {...job, id: 5, status: 'cancelled', scheduled_date: '2026-05-12T12:00:00Z'},
  {...job, id: 6, scheduled_date: '2026-05-15T12:00:00Z', service_address_lat: null},
];
assert(m.buildResponse({jobs: batch, options: {range:'all'}, tenantPublicId:'t', now}).pinCount === 3, 'all -> 3 pins');
assert(m.buildResponse({jobs: batch, options: {range:'90d'}, tenantPublicId:'t', now}).pinCount === 1, '90d -> 1 pin');
assert(m.buildResponse({jobs: batch, options: {range:'365d'}, tenantPublicId:'t', now}).pinCount === 2, '365d -> 2 pins');

const many = [];
for (let i = 0; i < 50; i++) many.push({...job, id: 1000+i, scheduled_date: '2026-05-01T00:00:00Z'});
assert(m.buildResponse({jobs: many, options: {range:'all', maxPins: 7}, tenantPublicId:'t', now}).pinCount === 7, 'maxPins respected');

const empty = m.buildResponse({jobs: [], options: {}, tenantPublicId: 'unknown', now});
assert(empty.enabled === true && empty.pinCount === 0 && empty.tenantPublicId === 'unknown', 'empty tenant -> 0 pins');

assert(!/Jane Doe|jane@example/i.test(JSON.stringify(m.buildResponse({jobs: batch, options: {}, tenantPublicId: 't', now}))), 'full body has no PII');

console.log('');
console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
