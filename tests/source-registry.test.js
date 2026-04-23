const { SOURCES, getSource, isChannelOwnedByAnySource, listSyncAdapters, affectsIdentityPriority } = require('../lib/source-registry');

describe('source-registry', () => {
  test('all four expected sources registered', () => {
    expect(Object.keys(SOURCES).sort()).toEqual(['leadbridge', 'manual_sf', 'openphone', 'zenbooker']);
  });

  test('leadbridge owns thumbtack + yelp', () => {
    expect(SOURCES.leadbridge.owned_channels).toEqual(['thumbtack', 'yelp']);
  });

  test('isChannelOwnedByAnySource detects LB-owned channels', () => {
    expect(isChannelOwnedByAnySource('thumbtack')).toBe('leadbridge');
    expect(isChannelOwnedByAnySource('Thumbtack')).toBe('leadbridge');
    expect(isChannelOwnedByAnySource('yelp')).toBe('leadbridge');
    expect(isChannelOwnedByAnySource('google')).toBeNull();
    expect(isChannelOwnedByAnySource('')).toBeNull();
    expect(isChannelOwnedByAnySource(null)).toBeNull();
  });

  test('isChannelOwnedByAnySource can exclude a source', () => {
    expect(isChannelOwnedByAnySource('thumbtack', 'leadbridge')).toBeNull();
  });

  test('zenbooker is the only sync adapter today', () => {
    expect(listSyncAdapters()).toEqual(['zenbooker']);
  });

  test('sync sources do NOT affect identity priority', () => {
    expect(affectsIdentityPriority('zenbooker')).toBe(false);
  });

  test('LB + OP + manual DO affect identity priority', () => {
    expect(affectsIdentityPriority('leadbridge')).toBe(true);
    expect(affectsIdentityPriority('openphone')).toBe(true);
    expect(affectsIdentityPriority('manual_sf')).toBe(true);
  });

  test('LB has higher priority (lower number) than OP, ZB', () => {
    expect(SOURCES.leadbridge.priority).toBeLessThan(SOURCES.openphone.priority);
    expect(SOURCES.openphone.priority).toBeLessThan(SOURCES.zenbooker.priority);
  });

  test('getSource throws on unknown source', () => {
    expect(() => getSource('foo')).toThrow('Unknown source: foo');
  });

  test('ZB is flagged as sync_adapter; others are not', () => {
    expect(SOURCES.zenbooker.is_sync_adapter).toBe(true);
    expect(SOURCES.leadbridge.is_sync_adapter).toBe(false);
    expect(SOURCES.openphone.is_sync_adapter).toBe(false);
  });
});
