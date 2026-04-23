const {
  pickLBSource,
  isLegacyFlatSource,
  buildEnrichLeadPatch,
  assertCreateLeadInvariant,
} = require('../lib/lb-ingestion');

describe('pickLBSource', () => {
  test('per-location format with account name', () => {
    expect(pickLBSource({ accountDisplayName: 'Spotless Homes Tampa', channel: 'yelp' }))
      .toBe('Spotless Homes Tampa (yelp)');
    expect(pickLBSource({ accountDisplayName: 'Spotless Homes Miami', channel: 'thumbtack' }))
      .toBe('Spotless Homes Miami (thumbtack)');
  });
  test('falls back to flat form when no account name', () => {
    expect(pickLBSource({ accountDisplayName: null, channel: 'yelp' })).toBe('leadbridge_yelp');
    expect(pickLBSource({ accountDisplayName: null, channel: 'thumbtack' })).toBe('leadbridge_thumbtack');
  });
});

describe('isLegacyFlatSource', () => {
  test('recognizes both flat forms', () => {
    expect(isLegacyFlatSource('leadbridge_yelp')).toBe(true);
    expect(isLegacyFlatSource('leadbridge_thumbtack')).toBe(true);
  });
  test('rejects per-location + other sources', () => {
    expect(isLegacyFlatSource('Spotless Homes Tampa (yelp)')).toBe(false);
    expect(isLegacyFlatSource('Google Ads')).toBe(false);
    expect(isLegacyFlatSource(null)).toBe(false);
    expect(isLegacyFlatSource(undefined)).toBe(false);
  });
});

describe('buildEnrichLeadPatch — fill nulls, never overwrite', () => {
  test('returns null when existing is null', () => {
    expect(buildEnrichLeadPatch({ existing: null, input: {} })).toBeNull();
  });

  test('fills null source with per-location form', () => {
    const patch = buildEnrichLeadPatch({
      existing: { source: null, email: null },
      input: { accountDisplayName: 'Spotless Homes Tampa', channel: 'yelp' },
    });
    expect(patch.source).toBe('Spotless Homes Tampa (yelp)');
  });

  test('upgrades legacy flat source to per-location', () => {
    const patch = buildEnrichLeadPatch({
      existing: { source: 'leadbridge_yelp', email: null },
      input: { accountDisplayName: 'Spotless Homes Tampa', channel: 'yelp' },
    });
    expect(patch.source).toBe('Spotless Homes Tampa (yelp)');
  });

  test('does NOT overwrite per-location source', () => {
    const patch = buildEnrichLeadPatch({
      existing: { source: 'Spotless Homes Tampa (yelp)', email: null },
      input: { accountDisplayName: 'Other Account', channel: 'yelp' },
    });
    expect(patch).toBeNull();
  });

  test('does NOT overwrite non-LB source like Google Ads', () => {
    const patch = buildEnrichLeadPatch({
      existing: { source: 'Google Ads', email: null },
      input: { accountDisplayName: 'Spotless Homes Tampa', channel: 'yelp' },
    });
    expect(patch).toBeNull();
  });

  test('fills null email', () => {
    const patch = buildEnrichLeadPatch({
      existing: { source: 'Spotless Homes Tampa (yelp)', email: null },
      input: { customerEmail: 'user@test.com', accountDisplayName: 'Spotless Homes Tampa', channel: 'yelp' },
    });
    expect(patch.email).toBe('user@test.com');
  });

  test('does NOT overwrite non-null email', () => {
    const patch = buildEnrichLeadPatch({
      existing: { source: 'Spotless Homes Tampa (yelp)', email: 'original@test.com' },
      input: { customerEmail: 'different@test.com', accountDisplayName: 'Spotless Homes Tampa', channel: 'yelp' },
    });
    expect(patch).toBeNull();
  });

  test('returns null when nothing to patch', () => {
    const patch = buildEnrichLeadPatch({
      existing: { source: 'Spotless Homes Tampa (yelp)', email: 'u@t.com' },
      input: { customerEmail: 'u@t.com', accountDisplayName: 'Spotless Homes Tampa', channel: 'yelp' },
    });
    expect(patch).toBeNull();
  });

  test('always includes updated_at when patch is non-null', () => {
    const patch = buildEnrichLeadPatch({
      existing: { source: null, email: null },
      input: { accountDisplayName: 'X', channel: 'yelp' },
    });
    expect(patch.updated_at).toBeDefined();
  });
});

describe('assertCreateLeadInvariant — HARD INVARIANT: never create when sf_lead_id exists', () => {
  test('throws when identity is null', () => {
    expect(() => assertCreateLeadInvariant(null)).toThrow('identity is required');
  });

  test('throws when sf_lead_id is set', () => {
    expect(() => assertCreateLeadInvariant({ id: 1, sf_lead_id: 500 }))
      .toThrow('Invariant violated');
  });

  test('passes when sf_lead_id is null', () => {
    expect(() => assertCreateLeadInvariant({ id: 1, sf_lead_id: null })).not.toThrow();
  });

  test('passes when sf_lead_id is undefined', () => {
    expect(() => assertCreateLeadInvariant({ id: 1 })).not.toThrow();
  });

  test('passes when identity has only sf_customer_id', () => {
    expect(() => assertCreateLeadInvariant({ id: 1, sf_customer_id: 200 })).not.toThrow();
  });
});
