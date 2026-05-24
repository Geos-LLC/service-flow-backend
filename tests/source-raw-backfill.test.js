'use strict';

const { classifyRow, looksLikeLbRaw } = require('../lib/source-raw-backfill');

describe('looksLikeLbRaw — shape detector', () => {
  test('matches per-account LB format', () => {
    expect(looksLikeLbRaw('Spotless Homes Tampa (yelp)')).toBe(true);
    expect(looksLikeLbRaw('Georgiy Sayapin (thumbtack)')).toBe(true);
    expect(looksLikeLbRaw('X (Thumbtack)')).toBe(true); // case-insensitive
  });
  test('matches legacy flat forms', () => {
    expect(looksLikeLbRaw('leadbridge_thumbtack')).toBe(true);
    expect(looksLikeLbRaw('leadbridge_yelp')).toBe(true);
    expect(looksLikeLbRaw('LEADBRIDGE_YELP')).toBe(true);
  });
  test('rejects canonical bucket names + other sources', () => {
    expect(looksLikeLbRaw('Thumbtack Miami')).toBe(false);
    expect(looksLikeLbRaw('Yelp Tampa')).toBe(false);
    expect(looksLikeLbRaw('Google Tampa')).toBe(false);
    expect(looksLikeLbRaw('Site Request')).toBe(false);
    expect(looksLikeLbRaw('cold call')).toBe(false);
  });
  test('handles null / empty', () => {
    expect(looksLikeLbRaw(null)).toBe(false);
    expect(looksLikeLbRaw('')).toBe(false);
  });
});

describe('classifyRow — two-field backfill classifier', () => {
  const tenantMappings = {
    leadbridge: {
      'georgiy sayapin (thumbtack)': 'Thumbtack Miami',
      'spotless homes tampa (yelp)': 'Yelp Tampa',
    },
    openphone: {
      'thumbtack m': 'Thumbtack Miami',
      'site': 'Site Request',
    },
  };

  test('LB-shape raw with LB mapping → remap_and_set_raw', () => {
    const out = classifyRow(
      { id: 1, user_id: 2, source: 'Georgiy Sayapin (thumbtack)', source_raw: null },
      tenantMappings,
    );
    expect(out.action).toBe('remap_and_set_raw');
    expect(out.new_source).toBe('Thumbtack Miami');
    expect(out.new_source_raw).toBe('Georgiy Sayapin (thumbtack)');
    expect(out.reason).toBe('lb_raw_mapped');
  });

  test('OP-shape raw with OP mapping → remap_and_set_raw', () => {
    const out = classifyRow(
      { id: 1, user_id: 2, source: 'Thumbtack M', source_raw: null },
      tenantMappings,
    );
    expect(out.action).toBe('remap_and_set_raw');
    expect(out.new_source).toBe('Thumbtack Miami');
    expect(out.new_source_raw).toBe('Thumbtack M');
    expect(out.reason).toBe('op_raw_mapped');
  });

  test('LB-shape raw with NO mapping → set_raw_only, source unchanged', () => {
    const out = classifyRow(
      { id: 1, user_id: 2, source: 'Other Acct (yelp)', source_raw: null },
      tenantMappings,
    );
    expect(out.action).toBe('set_raw_only');
    expect(out.new_source).toBe('Other Acct (yelp)');
    expect(out.new_source_raw).toBe('Other Acct (yelp)');
    expect(out.reason).toBe('unmapped');
  });

  test('canonical-shape source already (e.g. "Thumbtack Miami") with mapping → mapping_matches_current, set_raw_only', () => {
    // Source already looks canonical, no LB-shape suffix, OP mapping matches:
    // someone already set source to the canonical value; we only preserve raw.
    const out = classifyRow(
      { id: 1, user_id: 2, source: 'Site Request', source_raw: null },
      { leadbridge: {}, openphone: { 'site request': 'Site Request' } },
    );
    expect(out.action).toBe('set_raw_only');
    expect(out.new_source).toBe('Site Request');
    expect(out.new_source_raw).toBe('Site Request');
    expect(out.reason).toBe('mapping_matches_current');
  });

  test('null source → noop, nothing to preserve', () => {
    const out = classifyRow({ id: 1, user_id: 2, source: null, source_raw: null }, tenantMappings);
    expect(out.action).toBe('noop');
    expect(out.reason).toBe('source_was_null');
  });

  test('empty/whitespace source → noop', () => {
    const out = classifyRow({ id: 1, user_id: 2, source: '   ', source_raw: null }, tenantMappings);
    expect(out.action).toBe('noop');
  });

  test('source_raw already set → noop (never overwrite)', () => {
    const out = classifyRow(
      { id: 1, user_id: 2, source: 'Thumbtack Miami', source_raw: 'Georgiy Sayapin (thumbtack)' },
      tenantMappings,
    );
    expect(out.action).toBe('noop');
    expect(out.new_source_raw).toBe('Georgiy Sayapin (thumbtack)');
    expect(out.reason).toBe('source_raw_already_set');
  });

  test('null row → noop', () => {
    expect(classifyRow(null, tenantMappings).action).toBe('noop');
  });

  test('NO MAPPING POLLUTION ACROSS TENANTS — strictly user-scoped lookup', () => {
    // Tenant A has mapping. Tenant B's row has same raw string but no mapping.
    // Caller MUST pass tenant B's bucket only; classifier must NOT reach for
    // tenant A's mapping. Simulate by passing tenant B's empty bucket.
    const tenantBMappings = { leadbridge: {}, openphone: {} };
    const out = classifyRow(
      { id: 99, user_id: 7, source: 'Georgiy Sayapin (thumbtack)', source_raw: null },
      tenantBMappings,
    );
    expect(out.action).toBe('set_raw_only');
    expect(out.new_source).toBe('Georgiy Sayapin (thumbtack)'); // unchanged
    expect(out.reason).toBe('unmapped');
  });

  test('missing mappings object falls back safely', () => {
    const out = classifyRow(
      { id: 1, user_id: 2, source: 'Anything (yelp)', source_raw: null },
      null,
    );
    expect(out.action).toBe('set_raw_only');
    expect(out.new_source).toBe('Anything (yelp)');
    expect(out.reason).toBe('unmapped');
  });
});
