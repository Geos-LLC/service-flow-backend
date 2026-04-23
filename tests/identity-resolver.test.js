const { resolveIdentity, classifyNameMatch, levenshtein, isTokenSubset } = require('../lib/identity-resolver');

function makeMockSupabase(seed = []) {
  const state = {
    identities: seed.map(x => ({ ...x })),
    ambiguities: [],
    nextIdentityId: 1000,
    insertConflictCount: 0,
    forceInsertConflict: 0,
  };

  function fromIdentities() {
    let filters = [];
    let limit = null;

    const applyFilters = (rows) => rows.filter(r =>
      filters.every(f => {
        if (f.op === 'eq') return r[f.col] === f.val;
        if (f.op === 'ilike') {
          const v = String(r[f.col] || '').toLowerCase();
          const p = String(f.val).toLowerCase().replace(/%/g, '');
          return v.includes(p);
        }
        return true;
      })
    );

    const chain = {
      select() { return chain; },
      eq(col, val) { filters.push({ op: 'eq', col, val }); return chain; },
      ilike(col, val) { filters.push({ op: 'ilike', col, val }); return chain; },
      limit(n) { limit = n; return chain; },
      maybeSingle() {
        const results = applyFilters(state.identities);
        return Promise.resolve({ data: results[0] || null, error: null });
      },
      single() {
        return Promise.resolve({ data: null, error: { code: 'PGRST116', message: 'no rows' } });
      },
      update(patch) {
        return {
          eq(col, val) {
            return {
              select() {
                return {
                  single() {
                    const row = state.identities.find(r => r[col] === val);
                    if (!row) return Promise.resolve({ data: null, error: { message: 'not found' } });
                    Object.assign(row, patch);
                    return Promise.resolve({ data: row, error: null });
                  },
                };
              },
            };
          },
        };
      },
      insert(row) {
        return {
          select() {
            return {
              single() {
                if (state.forceInsertConflict > 0) {
                  state.forceInsertConflict -= 1;
                  return Promise.resolve({ data: null, error: { code: '23505', message: 'duplicate key value' } });
                }
                for (const col of ['leadbridge_contact_id', 'openphone_contact_id', 'sigcore_participant_id', 'zenbooker_customer_id']) {
                  if (row[col] && state.identities.some(r => r.user_id === row.user_id && r[col] === row[col])) {
                    return Promise.resolve({ data: null, error: { code: '23505', message: 'duplicate key value' } });
                  }
                }
                const fresh = { id: state.nextIdentityId++, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), ...row };
                state.identities.push(fresh);
                return Promise.resolve({ data: fresh, error: null });
              },
            };
          },
        };
      },
      then(fn) {
        const results = applyFilters(state.identities);
        const trimmed = limit ? results.slice(0, limit) : results;
        return Promise.resolve({ data: trimmed, error: null }).then(fn);
      },
    };

    return chain;
  }

  function fromAmbiguities() {
    return {
      insert(row) {
        state.ambiguities.push(row);
        return Promise.resolve({ data: null, error: null });
      },
    };
  }

  return {
    from(tbl) {
      if (tbl === 'communication_participant_identities') return fromIdentities();
      if (tbl === 'communication_identity_ambiguities') return fromAmbiguities();
      throw new Error(`mock: unknown table ${tbl}`);
    },
    _state: state,
  };
}

describe('classifyNameMatch', () => {
  test('exact', () => expect(classifyNameMatch('linda mau', 'linda mau', 'linda mau', 'linda mau')).toBe('strong_exact'));
  test('tokenset', () => expect(classifyNameMatch('linda mau', 'linda mau', 'mau linda', 'linda mau')).toBe('strong_tokenset'));
  test('leven 1 diff', () => expect(classifyNameMatch('linda mau', 'linda mau', 'linda mao', 'linda mao')).toBe('strong_leven'));
  test('subset weak', () => expect(classifyNameMatch('linda', 'linda', 'linda mau', 'linda mau')).toBe('weak_subset'));
  test('conflict', () => expect(classifyNameMatch('bob smith', 'bob smith', 'alice jones', 'alice jones')).toBe('conflict'));
  test('one missing', () => expect(classifyNameMatch('linda mau', 'linda mau', null, null)).toBe('one_missing'));
  test('neither named', () => expect(classifyNameMatch(null, null, null, null)).toBe('neither_named'));
});

describe('levenshtein + token subset', () => {
  test('levenshtein basic', () => {
    expect(levenshtein('', '')).toBe(0);
    expect(levenshtein('a', 'b')).toBe(1);
    expect(levenshtein('linda', 'lynda')).toBe(1);
    expect(levenshtein('mau', 'mao')).toBe(1);
  });
  test('isTokenSubset', () => {
    expect(isTokenSubset('linda', 'linda mau')).toBe(true);
    expect(isTokenSubset('linda mau', 'linda')).toBe(true);
    expect(isTokenSubset('bob', 'alice jones')).toBe(false);
    expect(isTokenSubset('', 'x')).toBe(false);
  });
});

describe('resolveIdentity — Step 1 (external ID)', () => {
  test('LB external ID match returns identity + match step', async () => {
    const supabase = makeMockSupabase([{
      id: 1, user_id: 2, leadbridge_contact_id: 'LB123', normalized_phone: '2629305925',
      display_name: 'Linda Mau', normalized_name: 'linda mau', name_token_set: 'linda mau',
    }]);
    const r = await resolveIdentity(supabase, { userId: 2, source: 'leadbridge', externalId: 'LB123', phone: '+12629305925', displayName: 'Linda Mau' });
    expect(r.status).toBe('matched');
    expect(r.matchStep).toBe('external_id');
    expect(r.identity.id).toBe(1);
  });

  test('OpenPhone sigcore_participant_id match', async () => {
    const supabase = makeMockSupabase([{
      id: 2, user_id: 2, sigcore_participant_id: 'SIG-456', normalized_phone: '2629305925',
    }]);
    const r = await resolveIdentity(supabase, { userId: 2, source: 'openphone', sigcoreParticipantId: 'SIG-456', externalId: 'OP456', phone: '+12629305925' });
    expect(r.status).toBe('matched');
    expect(r.identity.id).toBe(2);
  });

  test('ZB zenbooker_customer_id match', async () => {
    const supabase = makeMockSupabase([{
      id: 3, user_id: 2, zenbooker_customer_id: 'ZB789', sf_customer_id: 500,
    }]);
    const r = await resolveIdentity(supabase, { userId: 2, source: 'zenbooker', externalId: 'ZB789', phone: '+12629305925', displayName: 'Linda Mau' });
    expect(r.status).toBe('matched');
    expect(r.identity.id).toBe(3);
  });
});

describe('resolveIdentity — Step 2/3 (phone + name tiers)', () => {
  test('single strong phone+name match → auto merge', async () => {
    const supabase = makeMockSupabase([{
      id: 10, user_id: 2, normalized_phone: '2629305925', normalized_name: 'linda mau', name_token_set: 'linda mau', display_name: 'Linda Mau',
    }]);
    const r = await resolveIdentity(supabase, { userId: 2, source: 'openphone', phone: '+12629305925', displayName: 'Linda Mau' });
    expect(r.status).toBe('matched');
    expect(r.matchStep).toBe('phone_strong');
    expect(r.identity.id).toBe(10);
  });

  test('two strong phone+name matches → ambiguous', async () => {
    const supabase = makeMockSupabase([
      { id: 11, user_id: 2, normalized_phone: '2629305925', normalized_name: 'linda mau', name_token_set: 'linda mau' },
      { id: 12, user_id: 2, normalized_phone: '2629305925', normalized_name: 'linda mau', name_token_set: 'linda mau' },
    ]);
    const r = await resolveIdentity(supabase, { userId: 2, source: 'leadbridge', phone: '+12629305925', displayName: 'Linda Mau' });
    expect(r.status).toBe('ambiguous');
    expect(r.candidates.sort()).toEqual([11, 12]);
  });

  test('phone-only match where existing has no name → merge (phone_strong)', async () => {
    const supabase = makeMockSupabase([{
      id: 13, user_id: 2, normalized_phone: '2629305925', normalized_name: null, name_token_set: null,
    }]);
    const r = await resolveIdentity(supabase, { userId: 2, source: 'openphone', phone: '+12629305925', displayName: 'Linda Mau' });
    expect(r.status).toBe('matched');
    expect(r.matchStep).toBe('phone_strong');
  });

  test('weak name match (subset) → merge + auto_merged_weak log', async () => {
    const supabase = makeMockSupabase([{
      id: 14, user_id: 2, normalized_phone: '2629305925', normalized_name: 'linda mau', name_token_set: 'linda mau',
    }]);
    const r = await resolveIdentity(supabase, { userId: 2, source: 'openphone', phone: '+12629305925', displayName: 'Linda' });
    expect(r.status).toBe('matched');
    expect(r.matchStep).toBe('phone_weak');
    const logs = supabase._state.ambiguities;
    expect(logs).toHaveLength(1);
    expect(logs[0].status).toBe('auto_merged_weak');
    expect(logs[0].reason).toBe('phone_weak_name_match');
  });

  test('name conflict → ambiguous (never merge)', async () => {
    const supabase = makeMockSupabase([{
      id: 15, user_id: 2, normalized_phone: '2629305925', normalized_name: 'bob smith', name_token_set: 'bob smith',
    }]);
    const r = await resolveIdentity(supabase, { userId: 2, source: 'openphone', phone: '+12629305925', displayName: 'Alice Jones' });
    expect(r.status).toBe('ambiguous');
    expect(r.reason).toBe('phone_name_conflict_or_multi');
  });

  test('two phone candidates without name strong match → ambiguous', async () => {
    const supabase = makeMockSupabase([
      { id: 16, user_id: 2, normalized_phone: '2629305925', normalized_name: 'alice jones', name_token_set: 'alice jones' },
      { id: 17, user_id: 2, normalized_phone: '2629305925', normalized_name: 'bob smith', name_token_set: 'bob smith' },
    ]);
    const r = await resolveIdentity(supabase, { userId: 2, source: 'openphone', phone: '+12629305925', displayName: 'Linda Mau' });
    expect(r.status).toBe('ambiguous');
  });
});

describe('resolveIdentity — NEVER merges on phone alone when ambiguous', () => {
  test('two phone-only candidates + no-name incoming → ambiguous, no merge', async () => {
    const supabase = makeMockSupabase([
      { id: 18, user_id: 2, normalized_phone: '2629305925', normalized_name: null },
      { id: 19, user_id: 2, normalized_phone: '2629305925', normalized_name: null },
    ]);
    const r = await resolveIdentity(supabase, { userId: 2, source: 'openphone', phone: '+12629305925' });
    expect(r.status).toBe('ambiguous');
  });
});

describe('resolveIdentity — Step 4 (email)', () => {
  test('single email match with strong name → merge', async () => {
    const supabase = makeMockSupabase([{
      id: 20, user_id: 2, email: 'linda@test.com', normalized_name: 'linda mau', name_token_set: 'linda mau',
    }]);
    const r = await resolveIdentity(supabase, { userId: 2, source: 'openphone', email: 'linda@test.com', displayName: 'Linda Mau' });
    expect(r.status).toBe('matched');
    expect(r.matchStep).toBe('email');
  });

  test('two email candidates → ambiguous', async () => {
    const supabase = makeMockSupabase([
      { id: 21, user_id: 2, email: 'linda@test.com' },
      { id: 22, user_id: 2, email: 'linda@test.com' },
    ]);
    const r = await resolveIdentity(supabase, { userId: 2, source: 'openphone', email: 'linda@test.com', displayName: 'Linda Mau' });
    expect(r.status).toBe('ambiguous');
    expect(r.reason).toBe('multi_email_match');
  });
});

describe('resolveIdentity — Step 5 (create floating)', () => {
  test('LB creates new identity with priority tag "leadbridge"', async () => {
    const supabase = makeMockSupabase([]);
    const r = await resolveIdentity(supabase, { userId: 2, source: 'leadbridge', externalId: 'LB-NEW', phone: '+12629305925', displayName: 'Linda Mau' });
    expect(r.status).toBe('matched');
    expect(r.createdFloating).toBe(true);
    expect(r.identity.identity_priority_source).toBe('leadbridge');
    expect(r.identity.status).toBe('unresolved_floating');
    expect(r.identity.leadbridge_contact_id).toBe('LB-NEW');
    expect(r.identity.normalized_name).toBe('linda mau');
  });

  test('OP creates new identity with priority tag "openphone"', async () => {
    const supabase = makeMockSupabase([]);
    const r = await resolveIdentity(supabase, { userId: 2, source: 'openphone', externalId: 'OP-NEW', sigcoreParticipantId: 'SIG-NEW', phone: '+12629305925', displayName: 'Linda Mau' });
    expect(r.identity.identity_priority_source).toBe('openphone');
    expect(r.identity.openphone_contact_id).toBe('OP-NEW');
    expect(r.identity.sigcore_participant_id).toBe('SIG-NEW');
  });

  test('ZB creates new identity with priority tag "sync"', async () => {
    const supabase = makeMockSupabase([]);
    const r = await resolveIdentity(supabase, { userId: 2, source: 'zenbooker', externalId: 'ZB-NEW', phone: '+12629305925', displayName: 'Linda Mau' });
    expect(r.status).toBe('matched');
    expect(r.createdFloating).toBe(true);
    expect(r.identity.identity_priority_source).toBe('sync');
    expect(r.identity.zenbooker_customer_id).toBe('ZB-NEW');
  });
});

describe('resolveIdentity — concurrency (unique-violation retry)', () => {
  test('first insert returns 23505, retry finds the concurrently-created row', async () => {
    const supabase = makeMockSupabase([]);
    supabase._state.forceInsertConflict = 1;
    supabase._state.identities.push({
      id: 99, user_id: 2, leadbridge_contact_id: 'LB-RACE',
    });
    const r = await resolveIdentity(supabase, { userId: 2, source: 'leadbridge', externalId: 'LB-RACE', phone: '+12629305925', displayName: 'Linda Mau' });
    expect(r.status).toBe('matched');
    expect(r.matchStep).toBe('external_id');
    expect(r.identity.id).toBe(99);
  });

  test('3 consecutive conflicts exhaust retries', async () => {
    const supabase = makeMockSupabase([]);
    supabase._state.forceInsertConflict = 5;
    const r = await resolveIdentity(supabase, { userId: 2, source: 'leadbridge', externalId: 'LB-X', phone: '+12629305925', displayName: 'Linda Mau' });
    expect(r.status).toBe('error');
  });
});

describe('resolveIdentity — enrichment preserves non-null values', () => {
  test('does not overwrite non-null display_name', async () => {
    const supabase = makeMockSupabase([{
      id: 30, user_id: 2, leadbridge_contact_id: 'LB-1', display_name: 'Linda Original',
      normalized_name: 'linda original', name_token_set: 'linda original',
    }]);
    await resolveIdentity(supabase, { userId: 2, source: 'leadbridge', externalId: 'LB-1', displayName: 'Linda Changed' });
    const row = supabase._state.identities.find(r => r.id === 30);
    expect(row.display_name).toBe('Linda Original');
  });

  test('fills null display_name on match', async () => {
    const supabase = makeMockSupabase([{
      id: 31, user_id: 2, leadbridge_contact_id: 'LB-2', display_name: null,
    }]);
    await resolveIdentity(supabase, { userId: 2, source: 'leadbridge', externalId: 'LB-2', displayName: 'Linda Filled' });
    const row = supabase._state.identities.find(r => r.id === 31);
    expect(row.display_name).toBe('Linda Filled');
  });

  test('OP enriches existing LB identity with openphone_contact_id (multi-source goal)', async () => {
    const supabase = makeMockSupabase([{
      id: 32, user_id: 2, leadbridge_contact_id: 'LB-X', normalized_phone: '2629305925',
      normalized_name: 'linda mau', name_token_set: 'linda mau', identity_priority_source: 'leadbridge',
    }]);
    await resolveIdentity(supabase, { userId: 2, source: 'openphone', externalId: 'OP-X', sigcoreParticipantId: 'SIG-X', phone: '+12629305925', displayName: 'Linda Mau' });
    const row = supabase._state.identities.find(r => r.id === 32);
    expect(row.openphone_contact_id).toBe('OP-X');
    expect(row.sigcore_participant_id).toBe('SIG-X');
    expect(row.identity_priority_source).toBe('leadbridge');
  });
});

describe('resolveIdentity — input validation', () => {
  test('throws on missing userId', async () => {
    const supabase = makeMockSupabase([]);
    await expect(resolveIdentity(supabase, { source: 'leadbridge' })).rejects.toThrow('userId');
  });

  test('throws on missing source', async () => {
    const supabase = makeMockSupabase([]);
    await expect(resolveIdentity(supabase, { userId: 2 })).rejects.toThrow('source');
  });

  test('throws on unknown source', async () => {
    const supabase = makeMockSupabase([]);
    await expect(resolveIdentity(supabase, { userId: 2, source: 'foobar' })).rejects.toThrow('Unknown source');
  });
});
