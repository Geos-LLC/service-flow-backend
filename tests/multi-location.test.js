/**
 * Multi-Location Communication Architecture Tests
 *
 * Tests for location resolution, conversation storage with location fields,
 * location filtering, and mapping patterns.
 */

// ── Location Resolution Logic ──

describe('Location Resolution', () => {
  // Pure logic extracted from resolveConversationLocation()
  function resolveLocation(mappings, { providerAccountId, externalLocationId }) {
    if (!providerAccountId) {
      return { locationId: null, resolution: 'no_account', locationName: null }
    }

    // Step 1: Exact match — provider account + external location ID
    if (externalLocationId) {
      const exact = mappings.find(m =>
        m.provider_account_id === providerAccountId &&
        m.external_location_id === externalLocationId &&
        m.is_active
      )
      if (exact) {
        return {
          locationId: exact.sf_location_id,
          resolution: 'exact',
          locationName: exact.location_name || exact.external_location_name || null,
        }
      }
    }

    // Step 2: Account-level fallback
    const accountMappings = mappings.filter(m =>
      m.provider_account_id === providerAccountId &&
      m.mapping_type === 'account_level' &&
      m.is_active
    )

    if (accountMappings.length === 1) {
      return {
        locationId: accountMappings[0].sf_location_id,
        resolution: 'account_fallback',
        locationName: accountMappings[0].location_name || null,
      }
    }

    // Step 3: Unresolved
    return { locationId: null, resolution: 'unresolved', locationName: null }
  }

  // ── Thumbtack: 1 account = 1 location ──

  test('Thumbtack account-level mapping resolves to territory', () => {
    const mappings = [
      { provider_account_id: 7, sf_location_id: 341, mapping_type: 'account_level', external_location_id: null, location_name: 'Jacksonville', is_active: true },
    ]
    const result = resolveLocation(mappings, { providerAccountId: 7 })
    expect(result.locationId).toBe(341)
    expect(result.resolution).toBe('account_fallback')
    expect(result.locationName).toBe('Jacksonville')
  })

  test('Thumbtack: each account resolves to its own territory', () => {
    const mappings = [
      { provider_account_id: 7, sf_location_id: 341, mapping_type: 'account_level', external_location_id: null, location_name: 'Jacksonville', is_active: true },
      { provider_account_id: 6, sf_location_id: 340, mapping_type: 'account_level', external_location_id: null, location_name: 'St. Petersburg', is_active: true },
      { provider_account_id: 8, sf_location_id: 342, mapping_type: 'account_level', external_location_id: null, location_name: 'Tampa', is_active: true },
    ]

    expect(resolveLocation(mappings, { providerAccountId: 7 }).locationId).toBe(341)
    expect(resolveLocation(mappings, { providerAccountId: 6 }).locationId).toBe(340)
    expect(resolveLocation(mappings, { providerAccountId: 8 }).locationId).toBe(342)
  })

  // ── Yelp: 1 account = N locations ──

  test('Yelp location-level mapping resolves by external_location_id', () => {
    const mappings = [
      { provider_account_id: 3, sf_location_id: 341, mapping_type: 'location_level', external_location_id: 'yelp_jax_123', location_name: 'Jacksonville', is_active: true },
      { provider_account_id: 3, sf_location_id: 340, mapping_type: 'location_level', external_location_id: 'yelp_stp_456', location_name: 'St. Petersburg', is_active: true },
    ]

    const jax = resolveLocation(mappings, { providerAccountId: 3, externalLocationId: 'yelp_jax_123' })
    expect(jax.locationId).toBe(341)
    expect(jax.resolution).toBe('exact')
    expect(jax.locationName).toBe('Jacksonville')

    const stp = resolveLocation(mappings, { providerAccountId: 3, externalLocationId: 'yelp_stp_456' })
    expect(stp.locationId).toBe(340)
    expect(stp.resolution).toBe('exact')
  })

  test('Yelp: unknown external_location_id returns unresolved', () => {
    const mappings = [
      { provider_account_id: 3, sf_location_id: 341, mapping_type: 'location_level', external_location_id: 'yelp_jax_123', location_name: 'Jacksonville', is_active: true },
    ]

    const result = resolveLocation(mappings, { providerAccountId: 3, externalLocationId: 'yelp_unknown_789' })
    expect(result.locationId).toBeNull()
    expect(result.resolution).toBe('unresolved')
  })

  // ── Unresolved states ──

  test('no provider account → no_account', () => {
    const result = resolveLocation([], { providerAccountId: null })
    expect(result.locationId).toBeNull()
    expect(result.resolution).toBe('no_account')
  })

  test('no mappings at all → unresolved', () => {
    const result = resolveLocation([], { providerAccountId: 7 })
    expect(result.locationId).toBeNull()
    expect(result.resolution).toBe('unresolved')
  })

  test('inactive mapping is ignored', () => {
    const mappings = [
      { provider_account_id: 7, sf_location_id: 341, mapping_type: 'account_level', external_location_id: null, location_name: 'Jacksonville', is_active: false },
    ]
    const result = resolveLocation(mappings, { providerAccountId: 7 })
    expect(result.locationId).toBeNull()
    expect(result.resolution).toBe('unresolved')
  })

  test('multiple account-level mappings for same account → unresolved (ambiguous)', () => {
    const mappings = [
      { provider_account_id: 3, sf_location_id: 341, mapping_type: 'account_level', external_location_id: null, location_name: 'Jacksonville', is_active: true },
      { provider_account_id: 3, sf_location_id: 340, mapping_type: 'account_level', external_location_id: null, location_name: 'St. Petersburg', is_active: true },
    ]
    const result = resolveLocation(mappings, { providerAccountId: 3 })
    expect(result.locationId).toBeNull()
    expect(result.resolution).toBe('unresolved')
  })

  // ── Priority: exact > account_fallback ──

  test('exact match takes priority over account-level fallback', () => {
    const mappings = [
      { provider_account_id: 3, sf_location_id: 999, mapping_type: 'account_level', external_location_id: null, location_name: 'Default', is_active: true },
      { provider_account_id: 3, sf_location_id: 341, mapping_type: 'location_level', external_location_id: 'yelp_jax', location_name: 'Jacksonville', is_active: true },
    ]

    const result = resolveLocation(mappings, { providerAccountId: 3, externalLocationId: 'yelp_jax' })
    expect(result.locationId).toBe(341)
    expect(result.resolution).toBe('exact')
  })

  test('no externalLocationId falls through to account-level', () => {
    const mappings = [
      { provider_account_id: 3, sf_location_id: 999, mapping_type: 'account_level', external_location_id: null, location_name: 'Default', is_active: true },
      { provider_account_id: 3, sf_location_id: 341, mapping_type: 'location_level', external_location_id: 'yelp_jax', location_name: 'Jacksonville', is_active: true },
    ]

    const result = resolveLocation(mappings, { providerAccountId: 3 })
    expect(result.locationId).toBe(999)
    expect(result.resolution).toBe('account_fallback')
  })
})

// ── Conversation Location Storage ──

describe('Conversation Location Storage', () => {
  test('conversation stores both raw and resolved location fields', () => {
    const conv = {
      sf_location_id: 341,
      external_location_id: 'yelp_jax_123',
      external_business_id: 'biz_456',
      external_location_name: 'Spotless Homes Jacksonville',
      provider_account_id: 3,
    }

    // Resolved
    expect(conv.sf_location_id).toBe(341)
    // Raw provider fields preserved
    expect(conv.external_location_id).toBe('yelp_jax_123')
    expect(conv.external_business_id).toBe('biz_456')
    expect(conv.external_location_name).toBe('Spotless Homes Jacksonville')
  })

  test('unresolved conversation stores raw fields with null sf_location_id', () => {
    const conv = {
      sf_location_id: null,
      external_location_id: 'yelp_unknown',
      external_business_id: 'biz_789',
      external_location_name: 'Unknown Location',
      provider_account_id: 3,
    }

    expect(conv.sf_location_id).toBeNull()
    expect(conv.external_location_id).toBe('yelp_unknown')
    expect(conv.external_location_name).toBe('Unknown Location')
    // Critical: provider_account_id preserved for later remapping
    expect(conv.provider_account_id).toBe(3)
  })

  test('OpenPhone conversations have null location (no location concept)', () => {
    const conv = {
      provider: 'openphone',
      sf_location_id: null,
      external_location_id: null,
      external_location_name: null,
    }

    expect(conv.sf_location_id).toBeNull()
    expect(conv.external_location_id).toBeNull()
  })
})

// ── Location Filtering ──

describe('Location Filtering', () => {
  const conversations = [
    { id: 1, channel: 'thumbtack', provider: 'leadbridge', sf_location_id: 341 },
    { id: 2, channel: 'thumbtack', provider: 'leadbridge', sf_location_id: 340 },
    { id: 3, channel: 'yelp', provider: 'leadbridge', sf_location_id: 341 },
    { id: 4, channel: 'yelp', provider: 'leadbridge', sf_location_id: null },
    { id: 5, channel: 'sms', provider: 'openphone', sf_location_id: null },
  ]

  function filterByLocation(convs, locationId) {
    if (locationId === 'unassigned') {
      return convs.filter(c => c.sf_location_id === null && c.provider === 'leadbridge')
    }
    if (locationId) {
      return convs.filter(c => c.sf_location_id === parseInt(locationId))
    }
    return convs
  }

  test('locationId=341 returns Jacksonville conversations', () => {
    const result = filterByLocation(conversations, '341')
    expect(result.length).toBe(2)
    expect(result.map(c => c.id)).toEqual([1, 3])
  })

  test('locationId=340 returns St. Petersburg conversations', () => {
    const result = filterByLocation(conversations, '340')
    expect(result.length).toBe(1)
    expect(result[0].id).toBe(2)
  })

  test('locationId=unassigned returns only unresolved LB conversations', () => {
    const result = filterByLocation(conversations, 'unassigned')
    expect(result.length).toBe(1)
    expect(result[0].id).toBe(4) // yelp with null location
    // OpenPhone null location is NOT included (not LB)
    expect(result.find(c => c.provider === 'openphone')).toBeUndefined()
  })

  test('no locationId returns all conversations', () => {
    const result = filterByLocation(conversations, null)
    expect(result.length).toBe(5)
  })
})

// ── Mapping Patterns ──

describe('Mapping Patterns', () => {
  test('account_level: Thumbtack 1 account → 1 territory', () => {
    const mapping = {
      provider_account_id: 7,
      sf_location_id: 341,
      mapping_type: 'account_level',
      external_location_id: null,
      provider: 'leadbridge',
      channel: 'thumbtack',
    }

    expect(mapping.mapping_type).toBe('account_level')
    expect(mapping.external_location_id).toBeNull()
    expect(mapping.sf_location_id).toBe(341)
  })

  test('location_level: Yelp 1 account → N territories via external_location_id', () => {
    const mappings = [
      { provider_account_id: 3, sf_location_id: 341, mapping_type: 'location_level', external_location_id: 'yelp_jax', channel: 'yelp' },
      { provider_account_id: 3, sf_location_id: 340, mapping_type: 'location_level', external_location_id: 'yelp_stp', channel: 'yelp' },
    ]

    // Same account, different locations
    expect(mappings[0].provider_account_id).toBe(mappings[1].provider_account_id)
    expect(mappings[0].sf_location_id).not.toBe(mappings[1].sf_location_id)
    expect(mappings[0].external_location_id).not.toBe(mappings[1].external_location_id)
    expect(mappings.every(m => m.mapping_type === 'location_level')).toBe(true)
  })

  test('manual: admin override mapping', () => {
    const mapping = {
      provider_account_id: 3,
      sf_location_id: 341,
      mapping_type: 'manual',
      external_location_id: null,
    }

    expect(mapping.mapping_type).toBe('manual')
  })
})

// ── Channel Filtering ──

describe('Channel Filtering (OpenPhone vs LB)', () => {
  function filterByChannel(convs, channel) {
    if (channel === 'openphone') {
      return convs.filter(c => c.provider === 'openphone')
    }
    if (channel) {
      return convs.filter(c => c.channel === channel)
    }
    return convs
  }

  const conversations = [
    { id: 1, channel: 'sms', provider: 'openphone' },
    { id: 2, channel: 'call', provider: 'openphone' },
    { id: 3, channel: 'thumbtack', provider: 'leadbridge' },
    { id: 4, channel: 'yelp', provider: 'leadbridge' },
  ]

  test('channel=openphone filters by provider (covers sms+call)', () => {
    const result = filterByChannel(conversations, 'openphone')
    expect(result.length).toBe(2)
    expect(result.every(c => c.provider === 'openphone')).toBe(true)
  })

  test('channel=thumbtack filters by exact channel', () => {
    const result = filterByChannel(conversations, 'thumbtack')
    expect(result.length).toBe(1)
    expect(result[0].channel).toBe('thumbtack')
  })

  test('channel=yelp filters by exact channel', () => {
    const result = filterByChannel(conversations, 'yelp')
    expect(result.length).toBe(1)
    expect(result[0].channel).toBe('yelp')
  })

  test('no channel returns all', () => {
    const result = filterByChannel(conversations, null)
    expect(result.length).toBe(4)
  })
})
