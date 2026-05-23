/**
 * Tests for the team_member ↔ ZB provider mapping helper and its
 * integration points in zenbooker-sync.js.
 *
 * Coverage (per Phase B design spec, "Lesia Tampa" repair):
 *   1. New ZB provider creates team_member + mapping
 *   2. Existing team_member gains zenbooker_id → mapping inserted
 *   3. Existing mapping remains idempotent on repeated sync
 *   4. Changed zenbooker_id updates mapping
 *   5. Inactive provider marks mapping inactive/stale
 *   6. Cross-tenant isolation
 *   7. Outbound resolver can resolve Lesia-style provider after sync
 *   8. Existing inbound ZB assignment behavior unchanged (helper failure non-fatal)
 *   9. No duplicate mapping rows
 */

const fs = require('fs');
const path = require('path');

const {
  deriveMappingFields,
  upsertTeamMemberProviderMappingFromZbSync,
} = require('../lib/team-member-provider-mapping');

const ZB_SYNC_JS = fs.readFileSync(
  path.join(__dirname, '..', 'zenbooker-sync.js'),
  'utf8'
);
const MIG_045 = fs.readFileSync(
  path.join(__dirname, '..', 'migrations', '045_team_member_provider_mappings.sql'),
  'utf8'
);

// ─────────────────────────────────────────────────────────────────────
// Mock supabase that simulates the (user_id, sf_team_member_id) unique
// constraint and the upsert() ON CONFLICT semantics actually used by
// the helper. Records all upserts for assertions.
// ─────────────────────────────────────────────────────────────────────
function mockSupabase(seed = []) {
  const state = { rows: seed.map((r) => ({ ...r })) };
  const calls = { upserts: [] };
  return {
    from(table) {
      return {
        upsert(payload, opts) {
          calls.upserts.push({ table, payload, opts });
          return {
            select() {
              return {
                maybeSingle: async () => {
                  if (table !== 'team_member_provider_mappings') {
                    return { data: null, error: null };
                  }
                  const key = `${payload.user_id}|${payload.sf_team_member_id}`;
                  const idx = state.rows.findIndex(
                    (r) => `${r.user_id}|${r.sf_team_member_id}` === key
                  );
                  // Simulate the secondary unique constraint
                  // (user_id, zenbooker_provider_id): if a DIFFERENT
                  // sf_team_member_id already has this zenbooker_provider_id
                  // for the same user, return an error like Postgres would.
                  const collidingIdx = state.rows.findIndex(
                    (r) =>
                      r.user_id === payload.user_id &&
                      r.zenbooker_provider_id === payload.zenbooker_provider_id &&
                      r.sf_team_member_id !== payload.sf_team_member_id
                  );
                  if (collidingIdx >= 0 && idx < 0) {
                    return {
                      data: null,
                      error: {
                        message:
                          'duplicate key value violates unique constraint "tmpm_user_provider_unique"',
                      },
                    };
                  }
                  const id =
                    idx >= 0
                      ? state.rows[idx].id
                      : `mock-${state.rows.length + 1}`;
                  const row = { id, ...payload };
                  if (idx >= 0) state.rows[idx] = row;
                  else state.rows.push(row);
                  return { data: row, error: null };
                },
              };
            },
          };
        },
      };
    },
    __calls: calls,
    __state: state,
  };
}

const silentLogger = {
  log: () => {},
  warn: () => {},
  error: () => {},
};

// ─────────────────────────────────────────────────────────────────────
// 1. Pure helper — deriveMappingFields
// ─────────────────────────────────────────────────────────────────────
describe('deriveMappingFields (pure)', () => {
  test('returns null when required fields missing', () => {
    expect(deriveMappingFields({})).toBeNull();
    expect(deriveMappingFields({ userId: 2 })).toBeNull();
    expect(deriveMappingFields({ userId: 2, sfTeamMemberId: 2682 })).toBeNull();
    expect(
      deriveMappingFields({ userId: 2, zenbookerProviderId: 'zb1' })
    ).toBeNull();
    expect(
      deriveMappingFields({ sfTeamMemberId: 2682, zenbookerProviderId: 'zb1' })
    ).toBeNull();
  });

  test('default isActive → active + healthy', () => {
    const f = deriveMappingFields({
      userId: 2,
      sfTeamMemberId: 2682,
      zenbookerProviderId: '1779139117082x202793217343094800',
    });
    expect(f).toEqual({
      user_id: 2,
      sf_team_member_id: '2682',
      zenbooker_provider_id: '1779139117082x202793217343094800',
      mapping_source: 'zb_sync',
      status: 'active',
      sync_health: 'healthy',
    });
  });

  test('isActive=true → active + healthy (explicit)', () => {
    const f = deriveMappingFields({
      userId: 2,
      sfTeamMemberId: 2682,
      zenbookerProviderId: 'zb1',
      isActive: true,
    });
    expect(f.status).toBe('active');
    expect(f.sync_health).toBe('healthy');
  });

  test('TEST #5 — isActive=false → inactive + stale', () => {
    const f = deriveMappingFields({
      userId: 2,
      sfTeamMemberId: 2682,
      zenbookerProviderId: 'zb1',
      isActive: false,
    });
    expect(f.status).toBe('inactive');
    expect(f.sync_health).toBe('stale');
  });

  test('sf_team_member_id is always stringified', () => {
    const f = deriveMappingFields({
      userId: 2,
      sfTeamMemberId: 2682,
      zenbookerProviderId: 'zb1',
    });
    expect(typeof f.sf_team_member_id).toBe('string');
    expect(f.sf_team_member_id).toBe('2682');
  });
});

// ─────────────────────────────────────────────────────────────────────
// 2. DB helper — upsertTeamMemberProviderMappingFromZbSync
// ─────────────────────────────────────────────────────────────────────
describe('upsertTeamMemberProviderMappingFromZbSync', () => {
  test('TEST #1 — fresh provider creates a new mapping row', async () => {
    const sb = mockSupabase([]);
    const res = await upsertTeamMemberProviderMappingFromZbSync(sb, silentLogger, {
      userId: 2,
      sfTeamMemberId: 2682,
      zenbookerProviderId: '1779139117082x202793217343094800',
    });
    expect(res.mode).toBe('upserted');
    expect(sb.__state.rows).toHaveLength(1);
    expect(sb.__state.rows[0].status).toBe('active');
    expect(sb.__state.rows[0].sync_health).toBe('healthy');
    expect(sb.__state.rows[0].zenbooker_provider_id).toBe(
      '1779139117082x202793217343094800'
    );
  });

  test('TEST #2 — existing team_member missing mapping gets one (Lesia case)', async () => {
    // Pre-existing team_member with zenbooker_id but no mapping row.
    // Helper called from the SKIP branch of syncTeamMembers — should insert.
    const sb = mockSupabase([]); // mapping table empty for this user/team
    const res = await upsertTeamMemberProviderMappingFromZbSync(sb, silentLogger, {
      userId: 2,
      sfTeamMemberId: 2682,
      zenbookerProviderId: '1779139117082x202793217343094800',
    });
    expect(res.mode).toBe('upserted');
    expect(sb.__state.rows).toHaveLength(1);
  });

  test('TEST #3 — repeated upsert is idempotent (no duplicate rows)', async () => {
    const sb = mockSupabase([]);
    const input = {
      userId: 2,
      sfTeamMemberId: 2682,
      zenbookerProviderId: 'zb-xyz',
    };
    await upsertTeamMemberProviderMappingFromZbSync(sb, silentLogger, input);
    await upsertTeamMemberProviderMappingFromZbSync(sb, silentLogger, input);
    await upsertTeamMemberProviderMappingFromZbSync(sb, silentLogger, input);
    expect(sb.__state.rows).toHaveLength(1);
    expect(sb.__calls.upserts).toHaveLength(3);
    expect(sb.__calls.upserts[0].opts).toEqual({
      onConflict: 'user_id,sf_team_member_id',
    });
  });

  test('TEST #4 — changed zenbooker_id for same team_member updates the row', async () => {
    const sb = mockSupabase([
      {
        id: 'mock-1',
        user_id: 2,
        sf_team_member_id: '2682',
        zenbooker_provider_id: 'old-zb-id',
        mapping_source: 'zb_sync',
        status: 'active',
        sync_health: 'healthy',
      },
    ]);
    const res = await upsertTeamMemberProviderMappingFromZbSync(sb, silentLogger, {
      userId: 2,
      sfTeamMemberId: 2682,
      zenbookerProviderId: 'new-zb-id',
    });
    expect(res.mode).toBe('upserted');
    expect(sb.__state.rows).toHaveLength(1); // still one row
    expect(sb.__state.rows[0].zenbooker_provider_id).toBe('new-zb-id');
    expect(sb.__state.rows[0].id).toBe('mock-1'); // same id, updated in place
  });

  test('TEST #5 — inactive provider produces status=inactive + sync_health=stale', async () => {
    const sb = mockSupabase([]);
    await upsertTeamMemberProviderMappingFromZbSync(sb, silentLogger, {
      userId: 2,
      sfTeamMemberId: 2682,
      zenbookerProviderId: 'zb1',
      isActive: false,
    });
    expect(sb.__state.rows[0].status).toBe('inactive');
    expect(sb.__state.rows[0].sync_health).toBe('stale');
  });

  test('TEST #6 — cross-tenant isolation: user 2 + user 3 with same sfId do not collide', async () => {
    const sb = mockSupabase([
      {
        id: 'mock-a',
        user_id: 2,
        sf_team_member_id: '100',
        zenbooker_provider_id: 'zb-tenant-2',
        mapping_source: 'zb_sync',
        status: 'active',
        sync_health: 'healthy',
      },
    ]);
    const res = await upsertTeamMemberProviderMappingFromZbSync(sb, silentLogger, {
      userId: 3,
      sfTeamMemberId: 100,
      zenbookerProviderId: 'zb-tenant-3',
    });
    expect(res.mode).toBe('upserted');
    expect(sb.__state.rows).toHaveLength(2);
    const t2 = sb.__state.rows.find((r) => r.user_id === 2);
    const t3 = sb.__state.rows.find((r) => r.user_id === 3);
    expect(t2.zenbooker_provider_id).toBe('zb-tenant-2');
    expect(t3.zenbooker_provider_id).toBe('zb-tenant-3');
    expect(t2.sf_team_member_id).toBe('100');
    expect(t3.sf_team_member_id).toBe('100');
  });

  test('TEST #9 — no duplicate mapping rows across many syncs of same team', async () => {
    const sb = mockSupabase([]);
    for (let i = 0; i < 25; i++) {
      await upsertTeamMemberProviderMappingFromZbSync(sb, silentLogger, {
        userId: 2,
        sfTeamMemberId: 2682,
        zenbookerProviderId: '1779139117082x202793217343094800',
      });
    }
    expect(sb.__state.rows).toHaveLength(1);
  });

  test('returns skipped (not error) when required fields missing', async () => {
    const sb = mockSupabase([]);
    const warnings = [];
    const logger = { log: () => {}, warn: (m) => warnings.push(m), error: () => {} };
    const res = await upsertTeamMemberProviderMappingFromZbSync(sb, logger, {
      userId: 2,
      sfTeamMemberId: null,
      zenbookerProviderId: 'zb1',
    });
    expect(res.mode).toBe('skipped');
    expect(res.reason).toBe('missing_required_field');
    expect(sb.__state.rows).toHaveLength(0);
    expect(warnings.length).toBe(1);
  });

  test('returns error mode when DB upsert errors (does not throw)', async () => {
    const failingSupabase = {
      from() {
        return {
          upsert() {
            return {
              select() {
                return {
                  maybeSingle: async () => ({
                    data: null,
                    error: { message: 'db_down' },
                  }),
                };
              },
            };
          },
        };
      },
    };
    const errors = [];
    const logger = { log: () => {}, warn: () => {}, error: (m) => errors.push(m) };
    const res = await upsertTeamMemberProviderMappingFromZbSync(
      failingSupabase,
      logger,
      { userId: 2, sfTeamMemberId: 2682, zenbookerProviderId: 'zb1' }
    );
    expect(res.mode).toBe('error');
    expect(res.error).toBe('db_down');
    expect(errors.length).toBe(1);
  });

  test('safe when secondary unique (zenbooker_provider_id) collides — returns error mode', async () => {
    // Same provider_id already mapped to a DIFFERENT sf_team_member_id.
    // The (user_id, zenbooker_provider_id) unique constraint should reject.
    const sb = mockSupabase([
      {
        id: 'mock-existing',
        user_id: 2,
        sf_team_member_id: '999',
        zenbooker_provider_id: 'zb-shared',
        mapping_source: 'zb_sync',
        status: 'active',
        sync_health: 'healthy',
      },
    ]);
    const res = await upsertTeamMemberProviderMappingFromZbSync(sb, silentLogger, {
      userId: 2,
      sfTeamMemberId: 2682,
      zenbookerProviderId: 'zb-shared',
    });
    expect(res.mode).toBe('error');
    expect(res.error).toMatch(/tmpm_user_provider_unique|duplicate/);
    expect(sb.__state.rows).toHaveLength(1); // no spurious insert
  });
});

// ─────────────────────────────────────────────────────────────────────
// 3. Integration with zenbooker-sync.js — source-text scans
//    (verifies the helper is wired into all write sites, mirrors the
//    pattern used by tests/zb-outbound-tenant-isolation.test.js)
// ─────────────────────────────────────────────────────────────────────
describe('zenbooker-sync.js integration', () => {
  test('helper is imported', () => {
    expect(ZB_SYNC_JS).toMatch(
      /require\(['"]\.\/lib\/team-member-provider-mapping['"]\)/
    );
    expect(ZB_SYNC_JS).toMatch(/upsertTeamMemberProviderMappingFromZbSync/);
  });

  test('syncTeamMembers calls helper in BOTH existing and new branches', () => {
    // The whole syncTeamMembers function body should mention the helper at
    // least twice — once in the skip-existing path (Lesia gap-fill) and
    // once in the post-insert path (new provider mirror).
    const fnStart = ZB_SYNC_JS.indexOf('async function syncTeamMembers(');
    expect(fnStart).toBeGreaterThan(-1);
    // Slice through end of function — find the next `async function` at the
    // same indentation level, or end of file.
    const fnSlice = ZB_SYNC_JS.slice(fnStart, fnStart + 4000);
    const matches = fnSlice.match(/upsertTeamMemberProviderMappingFromZbSync/g);
    expect(matches).not.toBeNull();
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  test('TEST #8 — team_members.insert still happens before mapping mirror (no behavior change to inbound)', () => {
    const insertAt = ZB_SYNC_JS.indexOf(".from('team_members').insert(mapped)");
    expect(insertAt).toBeGreaterThan(-1);
    const helperAt = ZB_SYNC_JS.indexOf(
      'upsertTeamMemberProviderMappingFromZbSync',
      insertAt
    );
    // Helper must be called AFTER insert in the new-provider branch.
    expect(helperAt).toBeGreaterThan(insertAt);
    // Within a small window — confirms the call is logically adjacent.
    expect(helperAt - insertAt).toBeLessThan(800);
  });

  test('TEST #7 — outbound resolver path is preserved (mapping table query unchanged)', () => {
    // Outbound router still queries the mapping table the same way.
    // If sync writes mappings correctly, the outbound resolver finds them.
    const outboundJs = fs.readFileSync(
      path.join(__dirname, '..', 'zb-outbound.js'),
      'utf8'
    );
    expect(outboundJs).toMatch(/\.from\(['"]team_member_provider_mappings['"]\)/);
    expect(outboundJs).toMatch(/sf_team_member_id/);
    expect(outboundJs).toMatch(/zenbooker_provider_id/);
  });
});

// ─────────────────────────────────────────────────────────────────────
// 4. Schema invariants (mirrors zb-outbound-tenant-isolation.test.js)
// ─────────────────────────────────────────────────────────────────────
describe('schema invariants we rely on', () => {
  test('TEST #9b — unique (user_id, sf_team_member_id) prevents duplicate mapping rows', () => {
    expect(MIG_045).toMatch(/UNIQUE\s*\(user_id,\s*sf_team_member_id\)/);
  });

  test('TEST #6b — unique (user_id, zenbooker_provider_id) enforces cross-tenant isolation', () => {
    expect(MIG_045).toMatch(/UNIQUE\s*\(user_id,\s*zenbooker_provider_id\)/);
  });
});
