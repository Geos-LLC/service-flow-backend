/**
 * lb-recurring-classifier.js — pure-helper unit tests.
 *
 * Covers the Stage-3 recurring-customer model:
 *   - cadence detection (recurring vs irregular)
 *   - address consistency (mode share)
 *   - customerSourceAlignsWithLb (alignment / contradiction / unknown)
 *   - classifyRecurring (all 6 subtier branches)
 *   - pickAcquisitionJob (window match / earliest fallback / nothing-eligible)
 */

const {
  classifyRecurring,
  customerSourceAlignsWithLb,
  cadence,
  addressConsistency,
  pickAcquisitionJob,
  nameMatch,
  last10,
} = require('../lib/lb-recurring-classifier');

// ──────────────────────────────────────────────────────────────────
// customerSourceAlignsWithLb
// ──────────────────────────────────────────────────────────────────
describe('customerSourceAlignsWithLb', () => {
  test('Thumbtack source aligned with thumbtack LB', () => {
    expect(customerSourceAlignsWithLb('Thumbtack Tampa', 'thumbtack')).toBe(true);
    expect(customerSourceAlignsWithLb('Thumbtack St Pete', 'thumbtack')).toBe(true);
  });
  test('Yelp source aligned with yelp LB', () => {
    expect(customerSourceAlignsWithLb('Spotless Homes Tampa (yelp)', 'yelp')).toBe(true);
  });
  test('cross-platform contradiction returns false', () => {
    expect(customerSourceAlignsWithLb('Yelp Tampa', 'thumbtack')).toBe(false);
    expect(customerSourceAlignsWithLb('Thumbtack Tampa', 'yelp')).toBe(false);
  });
  test('unattributed / ambiguous returns null', () => {
    expect(customerSourceAlignsWithLb(null, 'thumbtack')).toBeNull();
    expect(customerSourceAlignsWithLb('', 'thumbtack')).toBeNull();
    expect(customerSourceAlignsWithLb('Other', 'thumbtack')).toBeNull();
    expect(customerSourceAlignsWithLb('Manual entry', 'yelp')).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────
// cadence
// ──────────────────────────────────────────────────────────────────
describe('cadence', () => {
  function date(d) { return new Date(d).toISOString(); }
  test('detects biweekly cadence', () => {
    const jobs = [
      { scheduled_date: date('2026-01-01') },
      { scheduled_date: date('2026-01-15') },
      { scheduled_date: date('2026-01-29') },
      { scheduled_date: date('2026-02-12') },
    ];
    const c = cadence(jobs);
    expect(c.isRecurring).toBe(true);
    expect(c.medianGapDays).toBeGreaterThan(13);
    expect(c.medianGapDays).toBeLessThan(15);
    expect(c.gapCV).toBeLessThan(0.5);
  });
  test('detects monthly cadence', () => {
    const jobs = [
      { scheduled_date: date('2026-01-01') },
      { scheduled_date: date('2026-02-01') },
      { scheduled_date: date('2026-03-01') },
      { scheduled_date: date('2026-04-01') },
    ];
    expect(cadence(jobs).isRecurring).toBe(true);
  });
  test('rejects when median gap > 90 days', () => {
    const jobs = [
      { scheduled_date: date('2026-01-01') },
      { scheduled_date: date('2026-06-01') },
      { scheduled_date: date('2026-11-01') },
    ];
    expect(cadence(jobs).isRecurring).toBe(false);
  });
  test('rejects when CV ≥ 0.5 (irregular spacing)', () => {
    const jobs = [
      { scheduled_date: date('2026-01-01') },
      { scheduled_date: date('2026-01-02') },
      { scheduled_date: date('2026-02-15') },
      { scheduled_date: date('2026-03-30') },
    ];
    expect(cadence(jobs).isRecurring).toBe(false);
  });
  test('returns gapCount=0 for <3 dates', () => {
    expect(cadence([{ scheduled_date: date('2026-01-01') }]).gapCount).toBe(0);
    expect(cadence([{ scheduled_date: date('2026-01-01') }, { scheduled_date: date('2026-01-15') }]).gapCount).toBe(0);
  });
  test('handles missing scheduled_date via created_at fallback', () => {
    const jobs = [
      { created_at: date('2026-01-01') },
      { created_at: date('2026-01-15') },
      { created_at: date('2026-01-29') },
    ];
    const c = cadence(jobs);
    expect(c.gapCount).toBe(2);
  });
});

// ──────────────────────────────────────────────────────────────────
// addressConsistency
// ──────────────────────────────────────────────────────────────────
describe('addressConsistency', () => {
  test('all jobs at same address → mode_share=1', () => {
    const jobs = Array.from({ length: 5 }, () => ({ service_address_street: '123 Main St', service_address_zip: '33701' }));
    expect(addressConsistency(jobs).modeShare).toBe(1);
  });
  test('mixed addresses → mode_share < 1', () => {
    const jobs = [
      { service_address_street: '123 Main St', service_address_zip: '33701' },
      { service_address_street: '123 Main St', service_address_zip: '33701' },
      { service_address_street: '456 Oak Rd', service_address_zip: '33702' },
    ];
    const a = addressConsistency(jobs);
    expect(a.distinctAddresses).toBe(2);
    expect(a.modeShare).toBeCloseTo(2/3, 2);
  });
  test('no address data returns zeros', () => {
    expect(addressConsistency([{}, { service_address_street: null }]).total).toBe(0);
  });
});

// ──────────────────────────────────────────────────────────────────
// classifyRecurring — every branch
// ──────────────────────────────────────────────────────────────────
function lbLead(over={}) {
  return {
    externalRequestId: 'EXT-A',
    customerName: 'Jane Doe',
    customerPhone: '+15125551111',
    platform: 'thumbtack',
    businessId: 'BIZ-1',
    createdAt: '2026-01-01T00:00:00Z',
    status: 'completed',
    ...over,
  };
}
function cust(over={}) {
  return { id: 100, first_name: 'Jane', last_name: 'Doe', phone: '+15125551111', source: 'Thumbtack Tampa', zenbooker_id: 'zb-100', ...over };
}
function job(over={}) {
  return {
    id: 999,
    customer_id: 100,
    created_at: '2026-01-15T00:00:00Z',
    scheduled_date: '2026-01-20T00:00:00Z',
    status: 'completed',
    is_recurring: false,
    service_address_street: '123 Main St',
    service_address_zip: '33701',
    lb_external_request_id: null,
    lb_channel: null,
    ...over,
  };
}

describe('classifyRecurring', () => {
  test('duplicate_phone_collision when phone is shared with another LB ext', () => {
    const r = classifyRecurring({
      lbLead: lbLead(),
      custMatch: cust(),
      peers: [cust()],
      jobs: [job()],
      identities: [],
      phoneCollisionExts: ['EXT-A', 'EXT-OTHER'],
    });
    expect(r.subtier).toBe('duplicate_phone_collision');
  });

  test('weak_identity when no customer match', () => {
    const r = classifyRecurring({ lbLead: lbLead(), custMatch: null, peers: [], jobs: [], identities: [], phoneCollisionExts: [] });
    expect(r.subtier).toBe('weak_identity');
  });

  test('true_multi_candidate_ambiguity when multiple customers share phone', () => {
    const r = classifyRecurring({
      lbLead: lbLead(),
      custMatch: cust(),
      peers: [cust({id:100}), cust({id:101})],
      jobs: [],
      identities: [],
      phoneCollisionExts: [],
    });
    expect(r.subtier).toBe('true_multi_candidate_ambiguity');
  });

  test('conflicting_acquisition_source when source is yelp but LB is thumbtack', () => {
    const r = classifyRecurring({
      lbLead: lbLead({ platform: 'thumbtack' }),
      custMatch: cust({ source: 'Yelp Tampa' }),
      peers: [cust()],
      jobs: [job()],
      identities: [],
      phoneCollisionExts: [],
    });
    expect(r.subtier).toBe('conflicting_acquisition_source');
  });

  test('recurring_customer_high_confidence via source-aligned + recurring cadence', () => {
    const jobs = [
      job({ id: 1, scheduled_date: '2026-01-01' }),
      job({ id: 2, scheduled_date: '2026-01-15' }),
      job({ id: 3, scheduled_date: '2026-01-29' }),
      job({ id: 4, scheduled_date: '2026-02-12' }),
    ];
    const r = classifyRecurring({
      lbLead: lbLead(),
      custMatch: cust({ source: 'Thumbtack Tampa' }),
      peers: [cust()],
      jobs,
      identities: [],
      phoneCollisionExts: [],
    });
    expect(r.subtier).toBe('recurring_customer_high_confidence');
    expect(r.reason).toContain('recurring_signal');
    expect(r.jobs_total).toBe(4);
  });

  test('recurring_customer_high_confidence via source-aligned + multi-touch (2 jobs, no cadence)', () => {
    const r = classifyRecurring({
      lbLead: lbLead(),
      custMatch: cust({ source: 'Thumbtack Tampa' }),
      peers: [cust()],
      jobs: [job({ id: 1 }), job({ id: 2 })],
      identities: [],
      phoneCollisionExts: [],
    });
    expect(r.subtier).toBe('recurring_customer_high_confidence');
    expect(r.reason).toContain('multi_touch');
  });

  test('weak_identity when no source attribution + no LB identity + no signals', () => {
    const r = classifyRecurring({
      lbLead: lbLead(),
      custMatch: cust({ source: 'Other' }),
      peers: [cust()],
      jobs: [job({ id: 1 })],
      identities: [],
      phoneCollisionExts: [],
    });
    expect(r.subtier).toBe('weak_identity');
  });

  test('recurring HIGH via identity even without source attribution', () => {
    const r = classifyRecurring({
      lbLead: lbLead(),
      custMatch: cust({ source: 'Other' }),
      peers: [cust()],
      jobs: [job({ id: 1 }), job({ id: 2 })],
      identities: [{ source_channel: 'leadbridge' }],
      phoneCollisionExts: [],
    });
    expect(r.subtier).toBe('recurring_customer_high_confidence');
  });
});

// ──────────────────────────────────────────────────────────────────
// pickAcquisitionJob
// ──────────────────────────────────────────────────────────────────
describe('pickAcquisitionJob', () => {
  test('picks first job in window (LB+/-180d)', () => {
    const lbCreated = '2026-01-01T00:00:00Z';
    const jobs = [
      { id: 100, created_at: '2025-01-01', lb_external_request_id: null },  // out of window
      { id: 200, created_at: '2026-02-01', lb_external_request_id: null },  // in window
      { id: 300, created_at: '2026-04-01', lb_external_request_id: null },  // in window, later
    ];
    expect(pickAcquisitionJob(lbCreated, jobs).id).toBe(200);
  });
  test('falls back to earliest job overall when no in-window match', () => {
    const lbCreated = '2026-01-01T00:00:00Z';
    const jobs = [
      { id: 100, created_at: '2025-01-01', lb_external_request_id: null },
      { id: 200, created_at: '2024-06-01', lb_external_request_id: null },
    ];
    expect(pickAcquisitionJob(lbCreated, jobs).id).toBe(200);
  });
  test('excludes already-linked jobs', () => {
    const lbCreated = '2026-01-01T00:00:00Z';
    const jobs = [
      { id: 100, created_at: '2026-01-15', lb_external_request_id: 'OTHER' },  // already linked
      { id: 200, created_at: '2026-02-15', lb_external_request_id: null },
    ];
    expect(pickAcquisitionJob(lbCreated, jobs).id).toBe(200);
  });
  test('returns null when no eligible jobs', () => {
    expect(pickAcquisitionJob('2026-01-01', [])).toBeNull();
    expect(pickAcquisitionJob('2026-01-01', [{ id: 1, created_at: '2026-01-01', lb_external_request_id: 'X' }])).toBeNull();
  });
  test('falls back to earliest when lbCreatedAt is unparseable', () => {
    const jobs = [
      { id: 100, created_at: '2026-03-01', lb_external_request_id: null },
      { id: 200, created_at: '2026-01-01', lb_external_request_id: null },
    ];
    expect(pickAcquisitionJob('not-a-date', jobs).id).toBe(200);
  });
});
