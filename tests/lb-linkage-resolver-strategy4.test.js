/**
 * Resolver Strategy 4 — customer_acquisition_match.
 *
 * Covers the new customer-level attribution lookup added in migration 054.
 * Reads customers.acquisition_external_request_id directly; falls through
 * to no_lb_lead when nothing is set.
 */

const { resolveLbLinkage, setCustomerAcquisitionIfMissing, REASONS } = require('../lib/lb-linkage-resolver');

// Supabase stub that supports the resolver's full read path + the
// fetchCustomerAcquisition .maybeSingle() call. customers/leads/identities
// data is supplied in the constructor.
function stub({ leads = [], identities = [], customer = null, customerUpdateReturning = null } = {}) {
  const writes = [];
  return {
    _writes: writes,
    from(table) {
      const filter = {};
      const updateBody = { patch: null };
      const chain = {
        select() { return chain; },
        eq(k, v) { filter[k] = v; return chain; },
        in() { return chain; },
        is(k, v) { filter[`__is_${k}`] = v; return chain; },
        limit() { return chain; },
        not(k, op, v) { filter[`__not_${k}`] = { op, v }; return chain; },
        update(patch) { updateBody.patch = patch; return chain; },
        maybeSingle() {
          if (table === 'customers') {
            // If this is the post-update .select().maybeSingle() flow, return
            // the configured customerUpdateReturning row (or null).
            if (updateBody.patch) {
              writes.push({ table, filter: {...filter}, patch: updateBody.patch });
              return Promise.resolve({ data: customerUpdateReturning, error: null });
            }
            if (customer && Object.entries(filter).every(([k, v]) => k.startsWith('__') || String(customer[k]) === String(v))) {
              return Promise.resolve({ data: customer, error: null });
            }
            return Promise.resolve({ data: null, error: null });
          }
          return Promise.resolve({ data: null, error: null });
        },
        then(resolve) {
          if (table === 'leads') {
            const rows = leads.filter(r => Object.entries(filter).every(([k, v]) => k.startsWith('__') || String(r[k]) === String(v)));
            resolve({ data: rows, error: null });
            return;
          }
          if (table === 'communication_participant_identities') {
            const rows = identities.filter(r => Object.entries(filter).every(([k, v]) => k.startsWith('__') || String(r[k]) === String(v)));
            resolve({ data: rows, error: null });
            return;
          }
          resolve({ data: [], error: null });
        },
      };
      return chain;
    },
  };
}

const SILENT = { log() {}, warn() {}, error() {} };

describe('resolveLbLinkage — Strategy 4 (customer_acquisition_match)', () => {
  test('customer has leadbridge acquisition → linked via Strategy 4', async () => {
    const supabase = stub({
      leads: [],
      identities: [],
      customer: {
        id: 100,
        user_id: 2,
        acquisition_source: 'leadbridge',
        acquisition_channel: 'thumbtack',
        acquisition_business_id: 'BIZ-1',
        acquisition_external_request_id: 'EXT-A',
        acquisition_at: '2026-01-01T00:00:00Z',
      },
    });
    const out = await resolveLbLinkage(supabase, { userId: 2, customerId: 100, logger: SILENT });
    expect(out.result).toBe('linked');
    expect(out.reason).toBe(REASONS.CUSTOMER_ACQUISITION_MATCH);
    expect(out.link.lb_external_request_id).toBe('EXT-A');
    expect(out.link.lb_channel).toBe('thumbtack');
    expect(out.link.lb_business_id).toBe('BIZ-1');
  });

  test('customer has acquisition_source=zenbooker → Strategy 4 skips, falls through', async () => {
    const supabase = stub({
      customer: {
        id: 100,
        user_id: 2,
        acquisition_source: 'zenbooker',
        acquisition_channel: null,
        acquisition_business_id: null,
        acquisition_external_request_id: 'ZB-X',
        acquisition_at: '2026-01-01T00:00:00Z',
      },
    });
    const out = await resolveLbLinkage(supabase, { userId: 2, customerId: 100, logger: SILENT });
    expect(out.result).toBe('not_linked');
    expect(out.reason).toBe(REASONS.CUSTOMER_WITHOUT_IDENTITY);
  });

  test('customer has no acquisition row → no_lb_lead fallback', async () => {
    const supabase = stub({
      customer: { id: 100, user_id: 2, acquisition_source: null, acquisition_external_request_id: null },
      identities: [{ id: 33, user_id: 2, sf_customer_id: 100, sf_lead_id: null, source_channel: 'zenbooker' }],
    });
    const out = await resolveLbLinkage(supabase, { userId: 2, customerId: 100, logger: SILENT });
    expect(out.result).toBe('not_linked');
    expect(out.reason).toBe(REASONS.NO_LB_LEAD);
  });

  test('Strategy 4 only runs after Strategy 1/2/3 fail (lead_match takes precedence)', async () => {
    const supabase = stub({
      leads: [{ id: 5, user_id: 2, converted_customer_id: 100, lb_external_request_id: 'EXT-FROM-LEAD', lb_channel: 'thumbtack' }],
      customer: {
        id: 100,
        user_id: 2,
        acquisition_source: 'leadbridge',
        acquisition_external_request_id: 'EXT-FROM-ACQ',
        acquisition_channel: 'thumbtack',
      },
    });
    const out = await resolveLbLinkage(supabase, { userId: 2, customerId: 100, logger: SILENT });
    expect(out.reason).toBe(REASONS.LEAD_MATCH);
    expect(out.link.lb_external_request_id).toBe('EXT-FROM-LEAD');
  });
});

describe('setCustomerAcquisitionIfMissing', () => {
  test('writes when acquisition_external_request_id IS NULL (row returned)', async () => {
    const supabase = stub({
      customerUpdateReturning: { id: 100 },
    });
    const res = await setCustomerAcquisitionIfMissing(supabase, 2, 100, {
      lb_external_request_id: 'EXT-A',
      lb_channel: 'thumbtack',
      lb_business_id: 'BIZ-1',
      acquired_at: '2026-01-01',
    });
    expect(res.ok).toBe(true);
    expect(res.wrote).toBe(true);
    expect(supabase._writes).toHaveLength(1);
    const w = supabase._writes[0];
    expect(w.table).toBe('customers');
    expect(w.patch.acquisition_source).toBe('leadbridge');
    expect(w.patch.acquisition_external_request_id).toBe('EXT-A');
    expect(w.patch.acquisition_channel).toBe('thumbtack');
    expect(w.patch.acquisition_business_id).toBe('BIZ-1');
    // IS NULL guard recorded
    expect(w.filter['__is_acquisition_external_request_id']).toBeNull();
  });

  test('no-op when row not returned (already-populated customer)', async () => {
    const supabase = stub({ customerUpdateReturning: null });
    const res = await setCustomerAcquisitionIfMissing(supabase, 2, 100, {
      lb_external_request_id: 'EXT-A',
      lb_channel: 'thumbtack',
      lb_business_id: 'BIZ-1',
    });
    expect(res.ok).toBe(true);
    expect(res.wrote).toBe(false);
  });

  test('refuses when link has no lb_external_request_id', async () => {
    const supabase = stub();
    const res = await setCustomerAcquisitionIfMissing(supabase, 2, 100, { lb_channel: 'thumbtack' });
    expect(res.wrote).toBe(false);
    expect(res.reason).toBe('no_link');
    expect(supabase._writes).toHaveLength(0);
  });

  test('refuses when userId or customerId is null', async () => {
    const supabase = stub();
    const link = { lb_external_request_id: 'EXT', lb_channel: 'thumbtack' };
    expect((await setCustomerAcquisitionIfMissing(supabase, null, 100, link)).reason).toBe('no_ids');
    expect((await setCustomerAcquisitionIfMissing(supabase, 2, null, link)).reason).toBe('no_ids');
    expect(supabase._writes).toHaveLength(0);
  });
});
