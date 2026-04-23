const { isAggregatorName, channelFromSourceName, shouldOpenPhoneCreateLead } = require('../lib/openphone-ingestion');

describe('isAggregatorName', () => {
  test('real people are not aggregators', () => {
    expect(isAggregatorName('Linda Mau')).toBe(false);
    expect(isAggregatorName('John Smith')).toBe(false);
    expect(isAggregatorName('Jöhn O\'Brien')).toBe(false);
  });
  test('platform aliases are aggregators', () => {
    expect(isAggregatorName('Thumbtack')).toBe(true);
    expect(isAggregatorName('Yelp Support')).toBe(true);
    expect(isAggregatorName('LeadBridge')).toBe(true);
    expect(isAggregatorName('Google Ads')).toBe(true);
    expect(isAggregatorName('Cold Call')).toBe(true);
    expect(isAggregatorName('Reference')).toBe(true);
  });
  test('null/empty → not aggregator', () => {
    expect(isAggregatorName(null)).toBe(false);
    expect(isAggregatorName('')).toBe(false);
  });
});

describe('channelFromSourceName', () => {
  test('Thumbtack variants → thumbtack', () => {
    expect(channelFromSourceName('Thumbtack Tampa')).toBe('thumbtack');
    expect(channelFromSourceName('Thumbtack Jacksonville')).toBe('thumbtack');
    expect(channelFromSourceName('thumbtack')).toBe('thumbtack');
  });
  test('Yelp variants → yelp', () => {
    expect(channelFromSourceName('Yelp Tampa')).toBe('yelp');
    expect(channelFromSourceName('Yelp Jacksonville')).toBe('yelp');
  });
  test('Google / other → null', () => {
    expect(channelFromSourceName('Google Tampa')).toBeNull();
    expect(channelFromSourceName('Google Ads')).toBeNull();
    expect(channelFromSourceName('Facebook')).toBeNull();
    expect(channelFromSourceName('Other')).toBeNull();
    expect(channelFromSourceName(null)).toBeNull();
  });
});

describe('shouldOpenPhoneCreateLead — identity state gates', () => {
  test('no identity → no create', () => {
    expect(shouldOpenPhoneCreateLead({ identity: null })).toEqual(expect.objectContaining({ create: false, reason: 'no_identity' }));
  });
  test('identity already has lead → no create (HARD rule)', () => {
    const r = shouldOpenPhoneCreateLead({
      identity: { id: 1, sf_lead_id: 500 },
      canonicalSource: 'Google Tampa',
      participantName: 'Linda Mau',
    });
    expect(r).toEqual(expect.objectContaining({ create: false, reason: 'identity_has_lead' }));
  });
  test('identity already has customer → no create', () => {
    const r = shouldOpenPhoneCreateLead({
      identity: { id: 1, sf_customer_id: 200 },
      canonicalSource: 'Google Tampa',
      participantName: 'Linda Mau',
    });
    expect(r).toEqual(expect.objectContaining({ create: false, reason: 'identity_has_customer' }));
  });
});

describe('shouldOpenPhoneCreateLead — name / source gates', () => {
  test('no canonical source → no create', () => {
    const r = shouldOpenPhoneCreateLead({
      identity: { id: 1 },
      canonicalSource: null,
      participantName: 'Linda Mau',
    });
    expect(r).toEqual(expect.objectContaining({ create: false, reason: 'no_canonical_source' }));
  });
  test('no participant name (noise) → no create', () => {
    const r = shouldOpenPhoneCreateLead({
      identity: { id: 1 },
      canonicalSource: 'Google Tampa',
      participantName: null,
    });
    expect(r).toEqual(expect.objectContaining({ create: false, reason: 'noise_no_name' }));
  });
  test('aggregator-named contact → no create', () => {
    const r = shouldOpenPhoneCreateLead({
      identity: { id: 1 },
      canonicalSource: 'Google Tampa',
      participantName: 'Thumbtack Support',
    });
    expect(r).toEqual(expect.objectContaining({ create: false, reason: 'aggregator_name' }));
  });
});

describe('shouldOpenPhoneCreateLead — OpenPhone direct (non-LB channels)', () => {
  test('Google → create direct', () => {
    const r = shouldOpenPhoneCreateLead({
      identity: { id: 1 },
      canonicalSource: 'Google Tampa',
      participantName: 'Linda Mau',
    });
    expect(r).toEqual({
      create: true,
      reason: 'openphone_direct',
      note: 'openphone_direct',
      source: 'Google Tampa',
      channel: null,
    });
  });
  test('Facebook → create direct', () => {
    const r = shouldOpenPhoneCreateLead({
      identity: { id: 1 },
      canonicalSource: 'Facebook',
      participantName: 'Linda Mau',
    });
    expect(r.create).toBe(true);
    expect(r.note).toBe('openphone_direct');
  });
  test('Other → create direct', () => {
    const r = shouldOpenPhoneCreateLead({
      identity: { id: 1 },
      canonicalSource: 'Other',
      participantName: 'Linda Mau',
    });
    expect(r.create).toBe(true);
  });
});

describe('shouldOpenPhoneCreateLead — LB-owned channels (recovery path)', () => {
  test('Thumbtack + NO leadbridge_contact_id → LB-RECOVERY create', () => {
    const r = shouldOpenPhoneCreateLead({
      identity: { id: 1, leadbridge_contact_id: null },
      canonicalSource: 'Thumbtack Tampa',
      participantName: 'Linda Mau',
    });
    expect(r).toEqual({
      create: true,
      reason: 'lb_recovery',
      note: 'openphone_lb_recovery',
      source: 'Thumbtack Tampa',
      channel: 'thumbtack',
    });
  });

  test('Yelp + NO leadbridge_contact_id → LB-RECOVERY create', () => {
    const r = shouldOpenPhoneCreateLead({
      identity: { id: 1, leadbridge_contact_id: null },
      canonicalSource: 'Yelp Jacksonville',
      participantName: 'Linda Mau',
    });
    expect(r.create).toBe(true);
    expect(r.note).toBe('openphone_lb_recovery');
    expect(r.channel).toBe('yelp');
  });

  test('Thumbtack + leadbridge_contact_id PRESENT → skip (LB owns it)', () => {
    const r = shouldOpenPhoneCreateLead({
      identity: { id: 1, leadbridge_contact_id: 'LB-123' },
      canonicalSource: 'Thumbtack Tampa',
      participantName: 'Linda Mau',
    });
    expect(r).toEqual(expect.objectContaining({ create: false, reason: 'lb_owned_already_ingested' }));
  });

  test('Yelp + leadbridge_contact_id PRESENT → skip', () => {
    const r = shouldOpenPhoneCreateLead({
      identity: { id: 1, leadbridge_contact_id: 'LB-456' },
      canonicalSource: 'Yelp Tampa',
      participantName: 'Linda Mau',
    });
    expect(r.create).toBe(false);
  });
});

describe('shouldOpenPhoneCreateLead — end-to-end example (Linda Mau scenarios)', () => {
  test('Scenario A: OpenPhone sees Thumbtack SMS first, LB lagging → recovery', () => {
    const r = shouldOpenPhoneCreateLead({
      identity: { id: 100, sf_lead_id: null, sf_customer_id: null, leadbridge_contact_id: null },
      canonicalSource: 'Thumbtack Tampa',
      participantName: 'Linda Mau',
    });
    expect(r.create).toBe(true);
    expect(r.note).toBe('openphone_lb_recovery');
  });

  test('Scenario B: LB already ingested → OP skips', () => {
    const r = shouldOpenPhoneCreateLead({
      identity: { id: 100, sf_lead_id: null, sf_customer_id: null, leadbridge_contact_id: 'LB-LINDA' },
      canonicalSource: 'Thumbtack Tampa',
      participantName: 'Linda Mau',
    });
    expect(r.create).toBe(false);
  });

  test('Scenario C: LB created lead earlier, identity has sf_lead_id → OP skips', () => {
    const r = shouldOpenPhoneCreateLead({
      identity: { id: 100, sf_lead_id: 500, leadbridge_contact_id: 'LB-LINDA' },
      canonicalSource: 'Thumbtack Tampa',
      participantName: 'Linda Mau',
    });
    expect(r.create).toBe(false);
    expect(r.reason).toBe('identity_has_lead');
  });

  test('Scenario D: Google ad → direct create (not LB-owned)', () => {
    const r = shouldOpenPhoneCreateLead({
      identity: { id: 100, sf_lead_id: null, sf_customer_id: null, leadbridge_contact_id: null },
      canonicalSource: 'Google Tampa',
      participantName: 'Linda Mau',
    });
    expect(r.create).toBe(true);
    expect(r.note).toBe('openphone_direct');
  });
});
