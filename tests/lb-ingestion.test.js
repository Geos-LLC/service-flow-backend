const {
  pickLBSource,
  pickLBSourceRaw,
  pickLBSources,
  isLegacyFlatSource,
  buildEnrichLeadPatch,
  assertCreateLeadInvariant,
  assertCreateChildLeadInvariant,
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

describe('pickLBSourceRaw', () => {
  test('always returns the raw display-name form, never the mapped value', () => {
    expect(pickLBSourceRaw({ accountDisplayName: 'Georgiy Sayapin', channel: 'thumbtack' }))
      .toBe('Georgiy Sayapin (thumbtack)');
  });
  test('falls back to flat when displayName missing', () => {
    expect(pickLBSourceRaw({ accountDisplayName: null, channel: 'yelp' })).toBe('leadbridge_yelp');
  });
});

describe('pickLBSources — two-field attribution', () => {
  test('returns canonical + raw when mapping has an entry', () => {
    const out = pickLBSources({
      accountDisplayName: 'Georgiy Sayapin',
      channel: 'thumbtack',
      sourceMappingsLookup: { 'georgiy sayapin (thumbtack)': 'Thumbtack Miami' },
    });
    expect(out).toEqual({ source: 'Thumbtack Miami', source_raw: 'Georgiy Sayapin (thumbtack)' });
  });

  test('falls back to raw on both fields when no mapping entry', () => {
    const out = pickLBSources({
      accountDisplayName: 'Newly Connected Acct',
      channel: 'yelp',
      sourceMappingsLookup: { 'georgiy sayapin (thumbtack)': 'Thumbtack Miami' },
    });
    expect(out).toEqual({
      source: 'Newly Connected Acct (yelp)',
      source_raw: 'Newly Connected Acct (yelp)',
    });
  });

  test('treats missing sourceMappingsLookup as no mapping (legacy mode)', () => {
    const out = pickLBSources({ accountDisplayName: 'X', channel: 'thumbtack' });
    expect(out).toEqual({ source: 'X (thumbtack)', source_raw: 'X (thumbtack)' });
  });

  test('treats empty sourceMappingsLookup as no mapping', () => {
    const out = pickLBSources({ accountDisplayName: 'X', channel: 'thumbtack', sourceMappingsLookup: {} });
    expect(out).toEqual({ source: 'X (thumbtack)', source_raw: 'X (thumbtack)' });
  });

  test('mapping lookup is case-insensitive (raw is lowercased before lookup)', () => {
    // pre-normalized lookup keys (loader stores lower-cased keys)
    const out = pickLBSources({
      accountDisplayName: 'GEORGIY SAYAPIN',
      channel: 'Thumbtack',
      sourceMappingsLookup: { 'georgiy sayapin (thumbtack)': 'Thumbtack Miami' },
    });
    expect(out.source).toBe('Thumbtack Miami');
    // source_raw preserves the original casing from the account display name
    expect(out.source_raw).toBe('GEORGIY SAYAPIN (Thumbtack)');
  });

  test('no canonical leakage: a stray mapping for a different raw value is not used', () => {
    const out = pickLBSources({
      accountDisplayName: 'Other Acct',
      channel: 'thumbtack',
      sourceMappingsLookup: { 'georgiy sayapin (thumbtack)': 'Thumbtack Miami' },
    });
    expect(out.source).toBe('Other Acct (thumbtack)');
    expect(out.source_raw).toBe('Other Acct (thumbtack)');
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

  test('does NOT overwrite per-location source (when source_raw already set)', () => {
    const patch = buildEnrichLeadPatch({
      existing: { source: 'Spotless Homes Tampa (yelp)', source_raw: 'Spotless Homes Tampa (yelp)', email: null },
      input: { accountDisplayName: 'Other Account', channel: 'yelp' },
    });
    expect(patch).toBeNull();
  });

  test('does NOT overwrite non-LB source like Google Ads (when source_raw already set)', () => {
    const patch = buildEnrichLeadPatch({
      existing: { source: 'Google Ads', source_raw: 'Google Ads', email: null },
      input: { accountDisplayName: 'Spotless Homes Tampa', channel: 'yelp' },
    });
    expect(patch).toBeNull();
  });

  test('fills null email', () => {
    const patch = buildEnrichLeadPatch({
      existing: { source: 'Spotless Homes Tampa (yelp)', source_raw: 'Spotless Homes Tampa (yelp)', email: null },
      input: { customerEmail: 'user@test.com', accountDisplayName: 'Spotless Homes Tampa', channel: 'yelp' },
    });
    expect(patch.email).toBe('user@test.com');
  });

  test('does NOT overwrite non-null email (when source_raw already set)', () => {
    const patch = buildEnrichLeadPatch({
      existing: { source: 'Spotless Homes Tampa (yelp)', source_raw: 'Spotless Homes Tampa (yelp)', email: 'original@test.com' },
      input: { customerEmail: 'different@test.com', accountDisplayName: 'Spotless Homes Tampa', channel: 'yelp' },
    });
    expect(patch).toBeNull();
  });

  test('returns null when nothing to patch (source_raw already set)', () => {
    const patch = buildEnrichLeadPatch({
      existing: { source: 'Spotless Homes Tampa (yelp)', source_raw: 'Spotless Homes Tampa (yelp)', email: 'u@t.com' },
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

  // ── source_raw two-field attribution ───────────────────────────────────
  test('fills source_raw when it is missing on an existing row', () => {
    const patch = buildEnrichLeadPatch({
      existing: { source: 'Spotless Homes Tampa (yelp)', source_raw: null, email: 'u@t.com' },
      input: { accountDisplayName: 'Spotless Homes Tampa', channel: 'yelp', customerEmail: 'u@t.com' },
    });
    expect(patch).not.toBeNull();
    expect(patch.source_raw).toBe('Spotless Homes Tampa (yelp)');
  });

  test('does NOT overwrite existing source_raw', () => {
    const patch = buildEnrichLeadPatch({
      existing: { source: 'Yelp Tampa', source_raw: 'Spotless Homes Tampa (yelp)', email: 'u@t.com' },
      input: { accountDisplayName: 'Other Acct', channel: 'yelp', customerEmail: 'u@t.com' },
    });
    expect(patch).toBeNull(); // nothing to do — source is non-legacy, source_raw set, email set
  });

  test('writes mapped source AND raw source on a fresh fill (canonical mapping supplied)', () => {
    const patch = buildEnrichLeadPatch({
      existing: { source: null, source_raw: null, email: null },
      input: {
        accountDisplayName: 'Georgiy Sayapin',
        channel: 'thumbtack',
        sourceMappingsLookup: { 'georgiy sayapin (thumbtack)': 'Thumbtack Miami' },
      },
    });
    expect(patch.source).toBe('Thumbtack Miami');
    expect(patch.source_raw).toBe('Georgiy Sayapin (thumbtack)');
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

describe('assertCreateChildLeadInvariant — Phase 0.5', () => {
  test('I-CL-1: throws when parent is null', () => {
    expect(() => assertCreateChildLeadInvariant(null, 2)).toThrow(/parent lead not found/);
  });

  test('I-CL-2: throws on cross-tenant parent', () => {
    expect(() => assertCreateChildLeadInvariant({ id: 67, user_id: 999, parent_lead_id: null }, 2))
      .toThrow(/cross-tenant parent/);
  });

  test('I-CL-2: matches numeric vs string user_id safely', () => {
    expect(() => assertCreateChildLeadInvariant({ id: 67, user_id: '2', parent_lead_id: null }, 2))
      .not.toThrow();
  });

  test('I-CL-3: throws when parent is itself a child (no grandchildren)', () => {
    expect(() => assertCreateChildLeadInvariant({ id: 245, user_id: 2, parent_lead_id: 67 }, 2))
      .toThrow(/parent is itself a child/);
  });

  test('happy path: parent is canonical, same tenant', () => {
    expect(() => assertCreateChildLeadInvariant({ id: 67, user_id: 2, parent_lead_id: null }, 2))
      .not.toThrow();
  });
});
