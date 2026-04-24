const {
  IDENTITY_SOURCE_COLUMNS,
  COLUMN_TO_SOURCE,
  classifyIdentitySource,
  aggregateSourceCounts,
} = require('../lib/identity-source-classifier');

describe('classifyIdentitySource', () => {
  test('empty row → no sources', () => {
    expect(classifyIdentitySource({})).toEqual({ sources: [] });
    expect(classifyIdentitySource(null)).toEqual({ sources: [] });
    expect(classifyIdentitySource(undefined)).toEqual({ sources: [] });
  });

  test('leadbridge_contact_id alone → leadbridge', () => {
    expect(classifyIdentitySource({ leadbridge_contact_id: 'LB-1' })).toEqual({ sources: ['leadbridge'] });
  });

  test('thumbtack_profile_id alone → leadbridge (LB owns the channel)', () => {
    expect(classifyIdentitySource({ thumbtack_profile_id: 'TT-1' })).toEqual({ sources: ['leadbridge'] });
  });

  test('yelp_profile_id alone → leadbridge', () => {
    expect(classifyIdentitySource({ yelp_profile_id: 'YELP-1' })).toEqual({ sources: ['leadbridge'] });
  });

  test('openphone_contact_id alone → openphone', () => {
    expect(classifyIdentitySource({ openphone_contact_id: 'OP-1' })).toEqual({ sources: ['openphone'] });
  });

  test('sigcore_participant_id alone → openphone (Sigcore is the OP transport layer)', () => {
    expect(classifyIdentitySource({ sigcore_participant_id: 'SIG-1' })).toEqual({ sources: ['openphone'] });
  });

  test('sigcore_participant_key alone → openphone', () => {
    expect(classifyIdentitySource({ sigcore_participant_key: 'KEY-1' })).toEqual({ sources: ['openphone'] });
  });

  test('openphone_contact_id + sigcore_participant_id → ONE openphone source (not two)', () => {
    const r = classifyIdentitySource({ openphone_contact_id: 'OP-1', sigcore_participant_id: 'SIG-1' });
    expect(r).toEqual({ sources: ['openphone'] });
  });

  test('all three OP columns → ONE openphone source', () => {
    const r = classifyIdentitySource({
      openphone_contact_id: 'OP-1',
      sigcore_participant_id: 'SIG-1',
      sigcore_participant_key: 'KEY-1',
    });
    expect(r).toEqual({ sources: ['openphone'] });
  });

  test('leadbridge_contact_id + thumbtack_profile_id → ONE leadbridge source', () => {
    const r = classifyIdentitySource({ leadbridge_contact_id: 'LB-1', thumbtack_profile_id: 'TT-1' });
    expect(r).toEqual({ sources: ['leadbridge'] });
  });

  test('zenbooker_customer_id alone → zenbooker', () => {
    expect(classifyIdentitySource({ zenbooker_customer_id: 'ZB-1' })).toEqual({ sources: ['zenbooker'] });
  });

  test('LB + OP → two sources (multi-source goal state)', () => {
    const r = classifyIdentitySource({ leadbridge_contact_id: 'LB-1', openphone_contact_id: 'OP-1' });
    expect(r.sources.sort()).toEqual(['leadbridge', 'openphone']);
  });

  test('LB + OP + ZB → three sources', () => {
    const r = classifyIdentitySource({
      leadbridge_contact_id: 'LB-1',
      openphone_contact_id: 'OP-1',
      zenbooker_customer_id: 'ZB-1',
    });
    expect(r.sources.sort()).toEqual(['leadbridge', 'openphone', 'zenbooker']);
  });

  test('thumbtack + sigcore + zenbooker → three sources (LB via TT)', () => {
    const r = classifyIdentitySource({
      thumbtack_profile_id: 'TT-1',
      sigcore_participant_id: 'SIG-1',
      zenbooker_customer_id: 'ZB-1',
    });
    expect(r.sources.sort()).toEqual(['leadbridge', 'openphone', 'zenbooker']);
  });

  test('null/undefined fields do not count', () => {
    const r = classifyIdentitySource({
      leadbridge_contact_id: null,
      thumbtack_profile_id: undefined,
      yelp_profile_id: '',
      openphone_contact_id: 'OP-1',
    });
    expect(r.sources).toEqual(['openphone']);
  });
});

describe('aggregateSourceCounts', () => {
  test('empty input → zero counts', () => {
    expect(aggregateSourceCounts([])).toEqual({
      total: 0,
      multi_source: 0,
      single_source: { leadbridge_only: 0, openphone_only: 0, zenbooker_only: 0, no_source_ids: 0 },
    });
    expect(aggregateSourceCounts(null).total).toBe(0);
  });

  test('mixed rows → correct buckets + total reconciles to input length', () => {
    const rows = [
      { leadbridge_contact_id: 'LB-1' },                                           // lb_only
      { thumbtack_profile_id: 'TT-1' },                                            // lb_only (via TT)
      { openphone_contact_id: 'OP-1' },                                            // op_only
      { openphone_contact_id: 'OP-2', sigcore_participant_id: 'SIG-2' },           // op_only (same logical source)
      { sigcore_participant_id: 'SIG-3' },                                         // op_only (was "sigcore_only" before)
      { zenbooker_customer_id: 'ZB-1' },                                           // zb_only
      { leadbridge_contact_id: 'LB-2', openphone_contact_id: 'OP-3' },             // multi (LB+OP)
      { thumbtack_profile_id: 'TT-3', sigcore_participant_id: 'SIG-4' },           // multi (LB+OP via TT/SIG)
      { leadbridge_contact_id: 'LB-3', openphone_contact_id: 'OP-4', zenbooker_customer_id: 'ZB-3' }, // multi (3)
      {},                                                                          // no_source_ids
    ];
    const r = aggregateSourceCounts(rows);
    expect(r.total).toBe(10);
    expect(r.single_source).toEqual({ leadbridge_only: 2, openphone_only: 3, zenbooker_only: 1, no_source_ids: 1 });
    expect(r.multi_source).toBe(3);
    const sum = r.multi_source + r.single_source.leadbridge_only + r.single_source.openphone_only +
      r.single_source.zenbooker_only + r.single_source.no_source_ids;
    expect(sum).toBe(r.total);
  });

  test('every row accounted for — buckets always sum to total (invariant)', () => {
    // Property-ish: 20 random rows, sum must equal total.
    const rows = [];
    for (let i = 0; i < 20; i++) {
      const r = {};
      if (i % 3 === 0) r.leadbridge_contact_id = 'LB-' + i;
      if (i % 5 === 0) r.openphone_contact_id = 'OP-' + i;
      if (i % 7 === 0) r.zenbooker_customer_id = 'ZB-' + i;
      rows.push(r);
    }
    const a = aggregateSourceCounts(rows);
    const sum = a.multi_source + a.single_source.leadbridge_only + a.single_source.openphone_only +
      a.single_source.zenbooker_only + a.single_source.no_source_ids;
    expect(sum).toBe(a.total);
    expect(a.total).toBe(20);
  });
});

describe('meta — shape of the classifier is not accidentally changing', () => {
  test('IDENTITY_SOURCE_COLUMNS covers every mapped column', () => {
    for (const col of IDENTITY_SOURCE_COLUMNS) {
      expect(COLUMN_TO_SOURCE[col]).toBeDefined();
    }
    expect(Object.keys(COLUMN_TO_SOURCE).sort()).toEqual([...IDENTITY_SOURCE_COLUMNS].sort());
  });

  test('only three logical sources exist', () => {
    const sources = new Set(Object.values(COLUMN_TO_SOURCE));
    expect([...sources].sort()).toEqual(['leadbridge', 'openphone', 'zenbooker']);
  });
});
