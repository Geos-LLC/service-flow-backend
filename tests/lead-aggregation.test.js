'use strict';

const {
  canonicalLeadId,
  isCanonical,
  isChild,
  groupByCanonical,
  personLevelCounts,
} = require('../lib/lead-aggregation');

describe('canonicalLeadId', () => {
  test('canonical row → own id', () => {
    expect(canonicalLeadId({ id: 67, parent_lead_id: null })).toBe(67);
  });
  test('child row → parent id', () => {
    expect(canonicalLeadId({ id: 245, parent_lead_id: 67 })).toBe(67);
  });
  test('null safety', () => {
    expect(canonicalLeadId(null)).toBeNull();
    expect(canonicalLeadId({ id: null })).toBeNull();
  });
});

describe('isCanonical / isChild', () => {
  test('canonical: parent_lead_id null', () => {
    expect(isCanonical({ id: 1, parent_lead_id: null })).toBe(true);
    expect(isChild({ id: 1, parent_lead_id: null })).toBe(false);
  });
  test('child: parent_lead_id set', () => {
    expect(isCanonical({ id: 2, parent_lead_id: 1 })).toBe(false);
    expect(isChild({ id: 2, parent_lead_id: 1 })).toBe(true);
  });
});

describe('groupByCanonical', () => {
  test('empty input → {}', () => {
    expect(groupByCanonical([])).toEqual({});
  });

  test('canonical with no children groups to itself', () => {
    const leads = [{ id: 67, parent_lead_id: null, source: 'Thumbtack', lead_cost: 200, created_at: '2026-01-01' }];
    const g = groupByCanonical(leads);
    expect(g[67]).toBeDefined();
    expect(g[67].canonical_lead).toEqual(leads[0]);
    expect(g[67].children).toEqual([]);
    expect(g[67].acquisition_count).toBe(1);
    expect(g[67].total_lead_cost).toBe(200);
    expect(g[67].sources).toEqual(['Thumbtack']);
  });

  test('canonical with two children groups all three', () => {
    const leads = [
      { id: 67, parent_lead_id: null, source: 'Thumbtack', lead_cost: 200, created_at: '2026-01-01', converted_customer_id: 23421 },
      { id: 100, parent_lead_id: 67, source: 'Yelp', lead_cost: 150, created_at: '2026-03-01', lead_origin_type: 'repeat_acquisition' },
      { id: 200, parent_lead_id: 67, source: 'Google', lead_cost: 75, created_at: '2026-09-01', lead_origin_type: 'repeat_acquisition' },
    ];
    const g = groupByCanonical(leads);
    expect(Object.keys(g)).toEqual(['67']);
    expect(g[67].canonical_lead.id).toBe(67);
    expect(g[67].children.map(c => c.id).sort()).toEqual([100, 200]);
    expect(g[67].acquisition_count).toBe(3);
    expect(g[67].total_lead_cost).toBe(425);
    expect(g[67].converted_customer_id).toBe(23421);
    expect(g[67].converted).toBe(true);
    expect(g[67].sources.sort()).toEqual(['Google', 'Thumbtack', 'Yelp']);
  });

  test('orphan child (parent missing) gets its own group', () => {
    const leads = [{ id: 100, parent_lead_id: 67, source: 'Yelp', lead_cost: 150 }];
    const g = groupByCanonical(leads);
    expect(g[67]).toBeDefined();
    expect(g[67].canonical_lead).toBeNull();
    expect(g[67].children.length).toBe(1);
  });

  test('two separate canonicals → two groups', () => {
    const leads = [
      { id: 1, parent_lead_id: null, source: 'Thumbtack' },
      { id: 2, parent_lead_id: null, source: 'Yelp' },
    ];
    const g = groupByCanonical(leads);
    expect(Object.keys(g).sort()).toEqual(['1', '2']);
  });

  test('total_lead_cost ignores non-numeric values', () => {
    const leads = [
      { id: 1, parent_lead_id: null, lead_cost: 100 },
      { id: 2, parent_lead_id: 1, lead_cost: null },
      { id: 3, parent_lead_id: 1, lead_cost: 'invalid' },
      { id: 4, parent_lead_id: 1, lead_cost: 50 },
    ];
    const g = groupByCanonical(leads);
    expect(g[1].total_lead_cost).toBe(150);
  });
});

describe('personLevelCounts', () => {
  test('empty input zeros', () => {
    const c = personLevelCounts([]);
    expect(c.total_leads).toBe(0);
    expect(c.unique_people).toBe(0);
    expect(c.conversion_rate).toBe(0);
  });

  test('counts unique people via canonical grouping', () => {
    const leads = [
      { id: 1, parent_lead_id: null, lead_origin_type: 'first_touch' },
      { id: 2, parent_lead_id: 1, lead_origin_type: 'repeat_acquisition' },
      { id: 3, parent_lead_id: null, lead_origin_type: 'first_touch' },
    ];
    const c = personLevelCounts(leads);
    expect(c.total_leads).toBe(3);
    expect(c.unique_people).toBe(2);
    expect(c.first_touch_count).toBe(2);
    expect(c.repeat_acquisition_count).toBe(1);
    expect(c.reactivation_count).toBe(0);
  });

  test('reactivation distinguished from first_touch', () => {
    const leads = [
      { id: 1, parent_lead_id: null, lead_origin_type: 'first_touch' },
      { id: 2, parent_lead_id: null, lead_origin_type: 'reactivation' },
    ];
    const c = personLevelCounts(leads);
    expect(c.first_touch_count).toBe(1);
    expect(c.reactivation_count).toBe(1);
    expect(c.repeat_acquisition_count).toBe(0);
  });

  test('NULL lead_origin_type counts as first_touch (legacy backward compat)', () => {
    const leads = [{ id: 1, parent_lead_id: null, lead_origin_type: null }];
    expect(personLevelCounts(leads).first_touch_count).toBe(1);
  });

  test('conversion_rate computed per person, not per acquisition', () => {
    // 2 people, 4 acquisition events. Person 1 converted; person 2 not.
    const leads = [
      { id: 1, parent_lead_id: null, converted_customer_id: 9001 },
      { id: 2, parent_lead_id: 1 },
      { id: 3, parent_lead_id: 1 },
      { id: 4, parent_lead_id: null, converted_customer_id: null },
    ];
    const c = personLevelCounts(leads);
    expect(c.unique_people).toBe(2);
    expect(c.converted_people).toBe(1);
    expect(c.conversion_rate).toBe(0.5);
  });

  test('total_acquisition_cost sums across all acquisition events', () => {
    const leads = [
      { id: 1, parent_lead_id: null, lead_cost: 200 },
      { id: 2, parent_lead_id: 1, lead_cost: 150 },
      { id: 3, parent_lead_id: 1, lead_cost: 75 },
    ];
    expect(personLevelCounts(leads).total_acquisition_cost).toBe(425);
  });
});
