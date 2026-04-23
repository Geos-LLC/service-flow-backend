/**
 * Phase D — Zenbooker sync-adapter identity semantics.
 *
 * Exercises resolveIdentity directly with source='zenbooker' to verify:
 *   - ZB can create floating identities, tagged identity_priority_source='sync'
 *   - ZB on ambiguous → returns { status: 'ambiguous' }; caller skips upsert
 *   - ZB enriches existing LB/OP identities but never downgrades priority_source
 *   - ZB matching by external_id (zenbooker_customer_id) and by phone+name
 *
 * Uses the same in-memory mock supabase pattern as identity-resolver.test.js.
 */

const { resolveIdentity } = require('../lib/identity-resolver');

function makeMockSupabase(seed = []) {
  const state = {
    identities: seed.map(x => ({ ...x })),
    ambiguities: [],
    nextIdentityId: 1000,
    forceInsertConflict: 0,
  };

  function fromIdentities() {
    const filters = [];
    let limit = null;

    const applyFilters = (rows) => rows.filter(r => filters.every(f => {
      if (f.op === 'eq') return r[f.col] === f.val;
      if (f.op === 'ilike') {
        const v = String(r[f.col] || '').toLowerCase();
        return v.includes(String(f.val).toLowerCase().replace(/%/g, ''));
      }
      return true;
    }));

    const chain = {
      select() { return chain; },
      eq(col, val) { filters.push({ op: 'eq', col, val }); return chain; },
      ilike(col, val) { filters.push({ op: 'ilike', col, val }); return chain; },
      limit(n) { limit = n; return chain; },
      maybeSingle() {
        const r = applyFilters(state.identities);
        return Promise.resolve({ data: r[0] || null, error: null });
      },
      single() { return Promise.resolve({ data: null, error: { code: 'PGRST116' } }); },
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
                  return Promise.resolve({ data: null, error: { code: '23505' } });
                }
                for (const col of ['leadbridge_contact_id', 'openphone_contact_id', 'sigcore_participant_id', 'zenbooker_customer_id']) {
                  if (row[col] && state.identities.some(r => r.user_id === row.user_id && r[col] === row[col])) {
                    return Promise.resolve({ data: null, error: { code: '23505' } });
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
        const r = applyFilters(state.identities);
        const trimmed = limit ? r.slice(0, limit) : r;
        return Promise.resolve({ data: trimmed, error: null }).then(fn);
      },
    };
    return chain;
  }

  return {
    from(tbl) {
      if (tbl === 'communication_participant_identities') return fromIdentities();
      if (tbl === 'communication_identity_ambiguities') return { insert: (row) => { state.ambiguities.push(row); return Promise.resolve({ data: null, error: null }); } };
      throw new Error('mock: unknown ' + tbl);
    },
    _state: state,
  };
}

describe('Zenbooker — sync-adapter identity creation', () => {
  test('ZB creates floating identity tagged identity_priority_source="sync"', async () => {
    const sb = makeMockSupabase([]);
    const r = await resolveIdentity(sb, {
      userId: 2, source: 'zenbooker', externalId: 'ZB-NEW-1',
      phone: '+12629305925', email: 'linda@test.com', displayName: 'Linda Mau',
    });
    expect(r.status).toBe('matched');
    expect(r.createdFloating).toBe(true);
    expect(r.identity.identity_priority_source).toBe('sync');
    expect(r.identity.zenbooker_customer_id).toBe('ZB-NEW-1');
    expect(r.identity.normalized_phone).toBe('2629305925');
    expect(r.identity.normalized_name).toBe('linda mau');
  });

  test('ZB enriches existing LB identity by external ID — does NOT downgrade priority', async () => {
    const sb = makeMockSupabase([{
      id: 1, user_id: 2,
      leadbridge_contact_id: 'LB-1', zenbooker_customer_id: null,
      normalized_phone: '2629305925', normalized_name: 'linda mau', name_token_set: 'linda mau',
      identity_priority_source: 'leadbridge',
    }]);
    // ZB arrives with same phone+name but different external ID
    const r = await resolveIdentity(sb, {
      userId: 2, source: 'zenbooker', externalId: 'ZB-LINDA',
      phone: '+12629305925', displayName: 'Linda Mau',
    });
    expect(r.status).toBe('matched');
    expect(r.matchStep).toBe('phone_strong');
    const row = sb._state.identities.find(x => x.id === 1);
    expect(row.zenbooker_customer_id).toBe('ZB-LINDA');
    expect(row.identity_priority_source).toBe('leadbridge'); // NOT downgraded to 'sync'
  });

  test('ZB enriches existing sync-only identity (no priority change since both are sync)', async () => {
    const sb = makeMockSupabase([{
      id: 5, user_id: 2,
      zenbooker_customer_id: 'ZB-OLD',
      normalized_phone: '2629305925', normalized_name: 'linda mau', name_token_set: 'linda mau',
      identity_priority_source: 'sync',
    }]);
    const r = await resolveIdentity(sb, {
      userId: 2, source: 'zenbooker', externalId: 'ZB-OLD',
      phone: '+12629305925', displayName: 'Linda Mau',
    });
    expect(r.status).toBe('matched');
    expect(r.matchStep).toBe('external_id');
    const row = sb._state.identities.find(x => x.id === 5);
    expect(row.identity_priority_source).toBe('sync');
  });
});

describe('Zenbooker — ambiguity discipline (never resolves ambiguity)', () => {
  test('2 phone candidates with matching name → ZB returns ambiguous, no merge', async () => {
    const sb = makeMockSupabase([
      { id: 10, user_id: 2, normalized_phone: '2629305925', normalized_name: 'linda mau', name_token_set: 'linda mau', identity_priority_source: 'leadbridge' },
      { id: 11, user_id: 2, normalized_phone: '2629305925', normalized_name: 'linda mau', name_token_set: 'linda mau', identity_priority_source: 'openphone' },
    ]);
    const r = await resolveIdentity(sb, {
      userId: 2, source: 'zenbooker', externalId: 'ZB-AMBIG',
      phone: '+12629305925', displayName: 'Linda Mau',
    });
    expect(r.status).toBe('ambiguous');
    expect(r.candidates.sort()).toEqual([10, 11]);
  });

  test('phone-name conflict → ZB returns ambiguous', async () => {
    const sb = makeMockSupabase([{
      id: 20, user_id: 2, normalized_phone: '2629305925', normalized_name: 'bob smith', name_token_set: 'bob smith', identity_priority_source: 'leadbridge',
    }]);
    const r = await resolveIdentity(sb, {
      userId: 2, source: 'zenbooker', externalId: 'ZB-CONFLICT',
      phone: '+12629305925', displayName: 'Alice Jones',
    });
    expect(r.status).toBe('ambiguous');
    expect(r.reason).toBe('phone_name_conflict_or_multi');
    // Ensure ZB did NOT create a new identity when ambiguous.
    const ambigRow = sb._state.identities.find(x => x.zenbooker_customer_id === 'ZB-CONFLICT');
    expect(ambigRow).toBeUndefined();
  });

  test('ambiguous result is logged to communication_identity_ambiguities', async () => {
    const sb = makeMockSupabase([
      { id: 30, user_id: 2, normalized_phone: '2629305925', normalized_name: 'linda mau', name_token_set: 'linda mau' },
      { id: 31, user_id: 2, normalized_phone: '2629305925', normalized_name: 'linda mau', name_token_set: 'linda mau' },
    ]);
    await resolveIdentity(sb, {
      userId: 2, source: 'zenbooker', externalId: 'ZB-LOG',
      phone: '+12629305925', displayName: 'Linda Mau',
    });
    expect(sb._state.ambiguities).toHaveLength(1);
    expect(sb._state.ambiguities[0].source).toBe('zenbooker');
    expect(sb._state.ambiguities[0].status).toBe('open');
  });
});

describe('Zenbooker — priority promotion on cross-source merge', () => {
  test('sync identity later matched by LB → priority flips to leadbridge', async () => {
    // Stage 1: ZB creates the floating identity.
    const sb = makeMockSupabase([]);
    const zbRes = await resolveIdentity(sb, {
      userId: 2, source: 'zenbooker', externalId: 'ZB-FIRST',
      phone: '+12629305925', displayName: 'Linda Mau',
    });
    expect(zbRes.identity.identity_priority_source).toBe('sync');

    // Stage 2: LB webhook arrives later with matching phone+name.
    const lbRes = await resolveIdentity(sb, {
      userId: 2, source: 'leadbridge', externalId: 'LB-LATER',
      phone: '+12629305925', displayName: 'Linda Mau',
    });
    expect(lbRes.status).toBe('matched');
    expect(lbRes.matchStep).toBe('phone_strong');
    expect(lbRes.identity.id).toBe(zbRes.identity.id);
    expect(lbRes.identity.identity_priority_source).toBe('leadbridge');
    expect(lbRes.identity.leadbridge_contact_id).toBe('LB-LATER');
    expect(lbRes.identity.zenbooker_customer_id).toBe('ZB-FIRST');
  });
});
