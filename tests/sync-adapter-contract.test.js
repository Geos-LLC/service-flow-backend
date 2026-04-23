/**
 * Phase G — sync-adapter contract conformance.
 *
 * Asserts:
 *   - assertConforms catches misconfigured adapters (missing methods, bad policy)
 *   - ZenbookerSyncAdapter + BookingKoalaSyncAdapter both conform
 *   - ZB adapter has the registered sync source in source-registry
 *   - toIdentityInput / toCRMPatch produce the expected shapes
 *   - fill-nulls-only ownership policy never overwrites user-edited fields
 */

const { OWNERSHIP_POLICIES, assertConforms, assertSourceIsSyncAdapter, REQUIRED_METHODS } = require('../lib/sync-adapter-contract');
const { SOURCES } = require('../lib/source-registry');
const { buildZenbookerAdapter } = require('../lib/adapters/zenbooker-adapter');
const { buildBookingKoalaAdapter } = require('../lib/adapters/bookingkoala-adapter');

describe('sync-adapter-contract — assertConforms', () => {
  test('throws on non-object', () => {
    expect(() => assertConforms(null)).toThrow('must be an object');
    expect(() => assertConforms('string')).toThrow('must be an object');
  });

  test('throws on missing required field', () => {
    expect(() => assertConforms({})).toThrow('missing required field "source"');
    expect(() => assertConforms({ source: 'x' })).toThrow('missing required field "ownership_policy"');
  });

  test('throws on empty source string', () => {
    expect(() => assertConforms({ source: '', ownership_policy: 'fill_nulls', pull: ()=>{}, push: ()=>{}, toIdentityInput: ()=>{}, toCRMPatch: ()=>{} }))
      .toThrow('must be a non-empty string');
    expect(() => assertConforms({ source: '   ', ownership_policy: 'fill_nulls', pull: ()=>{}, push: ()=>{}, toIdentityInput: ()=>{}, toCRMPatch: ()=>{} }))
      .toThrow('must be a non-empty string');
  });

  test('throws on invalid ownership_policy', () => {
    const base = { source: 'x', pull: ()=>{}, push: ()=>{}, toIdentityInput: ()=>{}, toCRMPatch: ()=>{} };
    expect(() => assertConforms({ ...base, ownership_policy: 'yolo' })).toThrow('ownership_policy must be one of');
    expect(() => assertConforms({ ...base, ownership_policy: null })).toThrow('ownership_policy must be one of');
  });

  test('throws on missing method', () => {
    const base = { source: 'x', ownership_policy: 'fill_nulls' };
    for (const m of REQUIRED_METHODS) {
      const a = { ...base, pull: ()=>{}, push: ()=>{}, toIdentityInput: ()=>{}, toCRMPatch: ()=>{} };
      delete a[m];
      expect(() => assertConforms(a)).toThrow(`missing required method "${m}()"`);
    }
  });

  test('accepts a minimal valid adapter', () => {
    expect(() => assertConforms({
      source: 'test',
      ownership_policy: OWNERSHIP_POLICIES.FILL_NULLS,
      pull: async () => {},
      push: async () => {},
      toIdentityInput: () => ({}),
      toCRMPatch: () => null,
    })).not.toThrow();
  });
});

describe('sync-adapter-contract — assertSourceIsSyncAdapter', () => {
  test('throws when source is not in the registry', () => {
    const bad = { source: 'notreal', ownership_policy: OWNERSHIP_POLICIES.FILL_NULLS };
    expect(() => assertSourceIsSyncAdapter(bad, SOURCES, 'X')).toThrow('not in the registry');
  });

  test('throws when registry entry is not a sync adapter', () => {
    const bad = { source: 'leadbridge', ownership_policy: OWNERSHIP_POLICIES.FILL_NULLS };
    expect(() => assertSourceIsSyncAdapter(bad, SOURCES, 'X')).toThrow('is_sync_adapter=false');
  });

  test('accepts zenbooker from the real registry', () => {
    const ok = { source: 'zenbooker', ownership_policy: OWNERSHIP_POLICIES.FILL_NULLS };
    expect(() => assertSourceIsSyncAdapter(ok, SOURCES, 'X')).not.toThrow();
  });
});

describe('ZenbookerSyncAdapter', () => {
  const adapter = buildZenbookerAdapter();

  test('conforms to the contract', () => {
    expect(() => assertConforms(adapter, 'ZenbookerSyncAdapter')).not.toThrow();
    expect(() => assertSourceIsSyncAdapter(adapter, SOURCES, 'ZenbookerSyncAdapter')).not.toThrow();
  });

  test('source + ownership_policy', () => {
    expect(adapter.source).toBe('zenbooker');
    expect(adapter.ownership_policy).toBe(OWNERSHIP_POLICIES.NEVER_OVERWRITE_USER_EDITS);
  });

  test('toIdentityInput shapes a ZB customer correctly', () => {
    const input = adapter.toIdentityInput(
      { id: 'ZB-1', first_name: 'Linda', last_name: 'Mau', phone: '+12629305925', email: 'linda@test.com' },
      { userId: 2 }
    );
    expect(input).toEqual({
      userId: 2,
      source: 'zenbooker',
      externalId: 'ZB-1',
      phone: '+12629305925',
      email: 'linda@test.com',
      displayName: 'Linda Mau',
    });
  });

  test('toIdentityInput returns null for missing id', () => {
    expect(adapter.toIdentityInput({ name: 'X' })).toBeNull();
    expect(adapter.toIdentityInput(null)).toBeNull();
  });

  test('toCRMPatch fills nulls only, never overwrites user-edited fields', () => {
    const zb = {
      id: 'ZB-2', first_name: 'Linda', last_name: 'Mau',
      phone: '+12629305925', email: 'new@test.com',
      service_address: { line1: '1 Elm St', city: 'Tampa', state: 'FL', postal_code: '33602' },
    };
    const existing = {
      first_name: 'Linda Original', last_name: null, phone: '+19999999999',
      email: null, address: null, city: 'Tampa', state: null, zip_code: null, zenbooker_id: null,
    };
    const patch = adapter.toCRMPatch(zb, existing);
    // Preserved (user-edited):
    expect(patch.first_name).toBeUndefined();
    expect(patch.phone).toBeUndefined();
    expect(patch.city).toBeUndefined();
    // Filled (was null):
    expect(patch.last_name).toBe('Mau');
    expect(patch.email).toBe('new@test.com');
    expect(patch.address).toBe('1 Elm St');
    expect(patch.state).toBe('FL');
    expect(patch.zip_code).toBe('33602');
    expect(patch.zenbooker_id).toBe('ZB-2');
  });

  test('toCRMPatch returns null when nothing needs patching', () => {
    const zb = { id: 'ZB-3', first_name: 'Linda' };
    const existing = { first_name: 'Linda', zenbooker_id: 'ZB-3' };
    expect(adapter.toCRMPatch(zb, existing)).toBeNull();
  });

  test('toCRMPatch returns all fields when existing is null (new customer)', () => {
    const zb = { id: 'ZB-4', first_name: 'New', last_name: 'Customer', email: 'x@y.com' };
    const patch = adapter.toCRMPatch(zb, null);
    expect(patch.first_name).toBe('New');
    expect(patch.last_name).toBe('Customer');
    expect(patch.email).toBe('x@y.com');
    expect(patch.zenbooker_id).toBe('ZB-4');
  });

  test('pull delegates to zenbookerModule.syncCustomers when injected', async () => {
    let called = null;
    const mock = { syncCustomers: async (u, k) => { called = { u, k }; return { fetched: 7 }; } };
    const adapterWithMod = buildZenbookerAdapter({ zenbookerModule: mock });
    const res = await adapterWithMod.pull({ userId: 2, apiKey: 'K' });
    expect(res).toEqual({ fetched: 7 });
    expect(called).toEqual({ u: 2, k: 'K' });
  });

  test('pull returns empty result when no module injected', async () => {
    const res = await adapter.pull({ userId: 2 });
    expect(res).toEqual({ fetched: 0 });
  });

  test('push is a no-op when no module injected', async () => {
    const res = await adapter.push({ userId: 2 }, { kind: 'job_status' });
    expect(res.pushed).toBe(false);
  });
});

describe('BookingKoalaSyncAdapter (stub)', () => {
  const adapter = buildBookingKoalaAdapter();

  test('conforms to the contract at the interface level', () => {
    expect(() => assertConforms(adapter, 'BookingKoalaSyncAdapter')).not.toThrow();
  });

  test('source is bookingkoala, policy is never_overwrite_user_edits', () => {
    expect(adapter.source).toBe('bookingkoala');
    expect(adapter.ownership_policy).toBe(OWNERSHIP_POLICIES.NEVER_OVERWRITE_USER_EDITS);
  });

  test('is NOT yet in the source registry (expected until rollout)', () => {
    expect(SOURCES.bookingkoala).toBeUndefined();
    expect(() => assertSourceIsSyncAdapter(adapter, SOURCES, 'BK')).toThrow('not in the registry');
  });

  test('pull + push return not-implemented sentinel', async () => {
    expect((await adapter.pull())).toEqual({ implemented: false, reason: 'bookingkoala_adapter_stub' });
    expect((await adapter.push())).toEqual({ implemented: false, reason: 'bookingkoala_adapter_stub' });
  });

  test('toIdentityInput + toCRMPatch transforms are usable for rollout', () => {
    const input = adapter.toIdentityInput(
      { id: 'BK-1', first_name: 'Linda', last_name: 'Mau', phone: '+12629305925' },
      { userId: 2 }
    );
    expect(input).toEqual({
      userId: 2,
      source: 'bookingkoala',
      externalId: 'BK-1',
      phone: '+12629305925',
      email: null,
      displayName: 'Linda Mau',
    });

    const patch = adapter.toCRMPatch({ id: 'BK-1', first_name: 'Linda', last_name: null }, { first_name: null, last_name: null });
    expect(patch.first_name).toBe('Linda');
    expect(patch.bookingkoala_customer_id).toBe('BK-1');
  });
});
