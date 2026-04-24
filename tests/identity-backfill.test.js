/**
 * Phase E — identity backfill: strict mode, dry-run, merge discipline.
 *
 * Covers:
 *   - resolveIdentity({ strict: true }) rejects phone-only and weak name matches
 *   - resolveIdentity({ dryRun: true }) returns decision without writing
 *   - backfillMappings: merge by external_id, merge by phone+name, create new,
 *     skip ambiguous, never merge on phone alone in strict mode
 *   - name normalization phase updates rows with raw names
 *
 * Shares the mock supabase pattern from identity-resolver.test.js.
 */

const { resolveIdentity } = require('../lib/identity-resolver');
const {
  backfillMappings,
  backfillZenbookerCustomers,
  fillNormalizedNamesIdentities,
  fillNormalizedNamesCRM,
  runIdentityBackfill,
  mappingToResolverInput,
} = require('../lib/identity-backfill');

function makeMockSupabase(seed = {}) {
  const state = {
    identities: (seed.identities || []).map(x => ({ ...x })),
    mappings: (seed.mappings || []).map(x => ({ ...x })),
    customers: (seed.customers || []).map(x => ({ ...x })),
    leads: (seed.leads || []).map(x => ({ ...x })),
    conversations: (seed.conversations || []).map(x => ({ ...x })),
    ambiguities: [],
    nextIdentityId: 2000,
  };

  function tableAccess(rows, unique = []) {
    const filters = [];
    let limit = null;
    let orderBy = null;
    const applyFilters = (rs) => rs.filter(r => filters.every(f => {
      if (f.op === 'eq') return r[f.col] === f.val;
      if (f.op === 'is_null') return r[f.col] == null;
      if (f.op === 'in') return f.val.includes(r[f.col]);
      if (f.op === 'not_is_null') return r[f.col] != null;
      if (f.op === 'gt') return r[f.col] > f.val;
      if (f.op === 'ilike') {
        const v = String(r[f.col] || '').toLowerCase();
        return v.includes(String(f.val).toLowerCase().replace(/%/g, ''));
      }
      if (f.op === 'range') return true; // handled by slice below
      return true;
    }));

    const chain = {
      select() { return chain; },
      eq(col, val) { filters.push({ op: 'eq', col, val }); return chain; },
      in(col, val) { filters.push({ op: 'in', col, val }); return chain; },
      gt(col, val) { filters.push({ op: 'gt', col, val }); return chain; },
      order(col, opts) { orderBy = { col, asc: opts?.ascending !== false }; return chain; },
      is(col, val) {
        if (val === null) filters.push({ op: 'is_null', col });
        return chain;
      },
      not(col, _op, val) {
        if (val === null) filters.push({ op: 'not_is_null', col });
        return chain;
      },
      ilike(col, val) { filters.push({ op: 'ilike', col, val }); return chain; },
      limit(n) { limit = n; return chain; },
      range(start, end) {
        filters.push({ op: 'range', start, end });
        return chain;
      },
      maybeSingle() {
        const r = applyFilters(rows);
        return Promise.resolve({ data: r[0] || null, error: null });
      },
      single() {
        return Promise.resolve({ data: null, error: { code: 'PGRST116' } });
      },
      update(patch) {
        return {
          eq(col, val) {
            const matches = rows.filter(r => r[col] === val);
            for (const m of matches) Object.assign(m, patch);
            return {
              select() {
                return {
                  single() {
                    return Promise.resolve({ data: matches[0] || null, error: null });
                  },
                };
              },
              then(fn) { return Promise.resolve({ data: matches, error: null }).then(fn); },
            };
          },
        };
      },
      insert(row) {
        return {
          select() {
            return {
              single() {
                for (const col of unique) {
                  if (row[col] && rows.some(r => r.user_id === row.user_id && r[col] === row[col])) {
                    return Promise.resolve({ data: null, error: { code: '23505' } });
                  }
                }
                const fresh = { id: state.nextIdentityId++, ...row };
                rows.push(fresh);
                return Promise.resolve({ data: fresh, error: null });
              },
            };
          },
        };
      },
      then(fn) {
        let result = applyFilters(rows);
        if (orderBy) {
          result = [...result].sort((a, b) => {
            const av = a[orderBy.col]; const bv = b[orderBy.col];
            const cmp = av < bv ? -1 : av > bv ? 1 : 0;
            return orderBy.asc ? cmp : -cmp;
          });
        }
        const rangeFilter = filters.find(f => f.op === 'range');
        if (rangeFilter) result = result.slice(rangeFilter.start, rangeFilter.end + 1);
        if (limit) result = result.slice(0, limit);
        return Promise.resolve({ data: result, error: null }).then(fn);
      },
    };
    return chain;
  }

  return {
    from(tbl) {
      if (tbl === 'communication_participant_identities') return tableAccess(state.identities, ['leadbridge_contact_id', 'openphone_contact_id', 'sigcore_participant_id', 'zenbooker_customer_id']);
      if (tbl === 'communication_participant_mappings') return tableAccess(state.mappings);
      if (tbl === 'communication_conversations') return tableAccess(state.conversations);
      if (tbl === 'customers') return tableAccess(state.customers);
      if (tbl === 'leads') return tableAccess(state.leads);
      if (tbl === 'communication_identity_ambiguities') return { insert: (row) => { state.ambiguities.push(row); return Promise.resolve({ data: null, error: null }); } };
      throw new Error('mock: unknown table ' + tbl);
    },
    _state: state,
  };
}

describe('resolveIdentity — strict mode', () => {
  test('strict rejects phone-only-no-conflict match (would be merged in runtime)', async () => {
    const sb = makeMockSupabase({
      identities: [{ id: 1, user_id: 2, normalized_phone: '2629305925', normalized_name: null }],
    });
    const r = await resolveIdentity(sb, {
      userId: 2, source: 'openphone', strict: true,
      phone: '+12629305925', displayName: 'Linda Mau',
    });
    expect(r.status).toBe('ambiguous');
    expect(r.reason).toBe('strict_phone_only_rejected');
    // Non-strict version of the same call SHOULD merge
    const r2 = await resolveIdentity(sb, {
      userId: 2, source: 'openphone',
      phone: '+12629305925', displayName: 'Linda Mau',
    });
    expect(r2.status).toBe('matched');
    expect(r2.matchStep).toBe('phone_strong');
  });

  test('strict rejects weak subset match (runtime would auto-merge with soft log)', async () => {
    const sbSubset = makeMockSupabase({
      identities: [{ id: 2, user_id: 2, normalized_phone: '2629305925', normalized_name: 'linda', name_token_set: 'linda' }],
    });
    const strictR = await resolveIdentity(sbSubset, {
      userId: 2, source: 'openphone', strict: true,
      phone: '+12629305925', displayName: 'Linda Mau',
    });
    expect(strictR.status).toBe('ambiguous');
    expect(strictR.reason).toBe('strict_weak_name_rejected');

    // Same data, non-strict: weak subset merges.
    const sbSubset2 = makeMockSupabase({
      identities: [{ id: 22, user_id: 2, normalized_phone: '2629305925', normalized_name: 'linda', name_token_set: 'linda' }],
    });
    const runtimeR = await resolveIdentity(sbSubset2, {
      userId: 2, source: 'openphone',
      phone: '+12629305925', displayName: 'Linda Mau',
    });
    expect(runtimeR.status).toBe('matched');
    expect(runtimeR.matchStep).toBe('phone_weak');
  });

  test('strict rejects a genuinely weak Levenshtein match', async () => {
    const sb = makeMockSupabase({
      identities: [{ id: 3, user_id: 2, normalized_phone: '2629305925', normalized_name: 'lindor mab', name_token_set: 'lindor mab' }],
    });
    const r = await resolveIdentity(sb, {
      userId: 2, source: 'openphone', strict: true,
      phone: '+12629305925', displayName: 'Linda Mau',
    });
    expect(r.status).toBe('ambiguous');
    expect(r.reason).toBe('strict_weak_name_rejected');
  });

  test('strict still accepts external-id match', async () => {
    const sb = makeMockSupabase({
      identities: [{ id: 4, user_id: 2, leadbridge_contact_id: 'LB-1' }],
    });
    const r = await resolveIdentity(sb, {
      userId: 2, source: 'leadbridge', strict: true,
      externalId: 'LB-1', phone: '+12629305925', displayName: 'Linda Mau',
    });
    expect(r.status).toBe('matched');
    expect(r.matchStep).toBe('external_id');
  });

  test('strict still accepts strong phone+name match (exact)', async () => {
    const sb = makeMockSupabase({
      identities: [{ id: 5, user_id: 2, normalized_phone: '2629305925', normalized_name: 'linda mau', name_token_set: 'linda mau' }],
    });
    const r = await resolveIdentity(sb, {
      userId: 2, source: 'leadbridge', strict: true,
      externalId: 'LB-NEW', phone: '+12629305925', displayName: 'Linda Mau',
    });
    expect(r.status).toBe('matched');
    expect(r.matchStep).toBe('phone_strong');
  });

  test('strict still creates floating identity when no match', async () => {
    const sb = makeMockSupabase({});
    const r = await resolveIdentity(sb, {
      userId: 2, source: 'leadbridge', strict: true,
      externalId: 'LB-NEW', phone: '+12629305925', displayName: 'Linda Mau',
    });
    expect(r.status).toBe('matched');
    expect(r.createdFloating).toBe(true);
  });

  test('strict weak name match adopts CRM-anchored candidate (crm_anchor)', async () => {
    // Candidate is linked to a customer AND attempted name is token subset of
    // candidate's name — previously this logged strict_weak_name_rejected.
    // Now it should auto-adopt because the CRM link is authoritative.
    const sb = makeMockSupabase({
      identities: [{
        id: 7, user_id: 2, normalized_phone: '8134844937',
        normalized_name: 'greg provda real number', name_token_set: 'greg number provda real',
        sf_customer_id: 23158,
      }],
    });
    const r = await resolveIdentity(sb, {
      userId: 2, source: 'openphone', strict: true,
      phone: '+18134844937', displayName: 'Greg Provda',
    });
    expect(r.status).toBe('matched');
    expect(r.matchStep).toBe('crm_anchor');
    expect(r.identity.id).toBe(7);
  });

  test('strict does NOT adopt CRM-anchored candidate on genuine name conflict', async () => {
    // Candidate is customer-linked BUT name is in conflict — still reject.
    const sb = makeMockSupabase({
      identities: [{
        id: 8, user_id: 2, normalized_phone: '5551234567',
        normalized_name: 'john smith', name_token_set: 'john smith',
        sf_customer_id: 99999,
      }],
    });
    const r = await resolveIdentity(sb, {
      userId: 2, source: 'openphone', strict: true,
      phone: '+15551234567', displayName: 'Barbara Jones',
    });
    expect(r.status).toBe('ambiguous'); // names conflict, don't auto-adopt
  });
});

describe('resolveIdentity — dryRun mode', () => {
  test('dryRun + existing match returns identity WITHOUT updating', async () => {
    const initial = { id: 10, user_id: 2, leadbridge_contact_id: 'LB-D', display_name: null, updated_at: 'original' };
    const sb = makeMockSupabase({ identities: [initial] });
    const r = await resolveIdentity(sb, {
      userId: 2, source: 'leadbridge', dryRun: true,
      externalId: 'LB-D', phone: '+12629305925', displayName: 'New Name',
    });
    expect(r.status).toBe('matched');
    expect(r.identity.id).toBe(10);
    const row = sb._state.identities.find(x => x.id === 10);
    expect(row.display_name).toBeNull(); // UNCHANGED
    expect(row.updated_at).toBe('original');
  });

  test('dryRun + no match returns synthetic floating identity (not inserted)', async () => {
    const sb = makeMockSupabase({});
    const beforeCount = sb._state.identities.length;
    const r = await resolveIdentity(sb, {
      userId: 2, source: 'leadbridge', dryRun: true,
      externalId: 'LB-X', phone: '+12629305925', displayName: 'Linda Mau',
    });
    expect(r.status).toBe('matched');
    expect(r.createdFloating).toBe(true);
    expect(r.identity.id).toBeNull(); // synthetic
    expect(sb._state.identities.length).toBe(beforeCount); // nothing written
  });

  test('dryRun + ambiguous does NOT log to ambiguities table', async () => {
    const sb = makeMockSupabase({
      identities: [
        { id: 20, user_id: 2, normalized_phone: '2629305925', normalized_name: 'linda mau', name_token_set: 'linda mau' },
        { id: 21, user_id: 2, normalized_phone: '2629305925', normalized_name: 'linda mau', name_token_set: 'linda mau' },
      ],
    });
    const r = await resolveIdentity(sb, {
      userId: 2, source: 'leadbridge', dryRun: true,
      phone: '+12629305925', displayName: 'Linda Mau',
    });
    expect(r.status).toBe('ambiguous');
    expect(sb._state.ambiguities).toHaveLength(0);
  });
});

describe('mappingToResolverInput', () => {
  test('builds strict OP input with all relevant fields', () => {
    const input = mappingToResolverInput(2, {
      id: 5, sigcore_participant_id: 'SIG-1', sigcore_participant_key: 'KEY-1',
      participant_phone_e164: '+12629305925', provider_contact_id: 'OP-X',
    }, 'Linda Mau');
    expect(input).toEqual({
      userId: 2,
      source: 'openphone',
      strict: true,
      externalId: 'OP-X',
      sigcoreParticipantId: 'SIG-1',
      sigcoreParticipantKey: 'KEY-1',
      phone: '+12629305925',
      displayName: 'Linda Mau',
    });
  });
});

describe('backfillMappings', () => {
  test('dry-run counts merge-by-phone-name without writing identity_id', async () => {
    const sb = makeMockSupabase({
      identities: [{
        id: 100, user_id: 2, leadbridge_contact_id: 'LB-LINDA',
        normalized_phone: '2629305925', normalized_name: 'linda mau', name_token_set: 'linda mau',
        identity_priority_source: 'leadbridge',
      }],
      mappings: [{
        id: 500, tenant_id: 2, identity_id: null,
        sigcore_participant_id: 'SIG-LINDA', participant_phone_e164: '+12629305925',
      }],
      conversations: [{
        id: 9000, participant_mapping_id: 500, participant_name: 'Linda Mau', last_event_at: '2026-04-20',
      }],
    });
    const counts = await backfillMappings(sb, 2, { apply: false });
    expect(counts.scanned).toBe(1);
    expect(counts.merged_by_phone_name).toBe(1);
    expect(counts.created_new).toBe(0);
    // Mapping should NOT be updated (dry-run)
    const m = sb._state.mappings[0];
    expect(m.identity_id).toBeNull();
  });

  test('apply mode writes identity_id on merged mapping', async () => {
    const sb = makeMockSupabase({
      identities: [{
        id: 101, user_id: 2, leadbridge_contact_id: 'LB-X',
        normalized_phone: '2629305925', normalized_name: 'linda mau', name_token_set: 'linda mau',
      }],
      mappings: [{
        id: 501, tenant_id: 2, identity_id: null,
        sigcore_participant_id: 'SIG-X', participant_phone_e164: '+12629305925',
      }],
      conversations: [{
        id: 9001, participant_mapping_id: 501, participant_name: 'Linda Mau', last_event_at: '2026-04-20',
      }],
    });
    const counts = await backfillMappings(sb, 2, { apply: true });
    expect(counts.merged_by_phone_name).toBe(1);
    const m = sb._state.mappings[0];
    expect(m.identity_id).toBe(101);
  });

  test('apply: creates new identity when no match exists (conservative new, not merged)', async () => {
    const sb = makeMockSupabase({
      identities: [],
      mappings: [{
        id: 502, tenant_id: 2, identity_id: null,
        sigcore_participant_id: 'SIG-ALONE', participant_phone_e164: '+13055550101',
      }],
      conversations: [{
        id: 9002, participant_mapping_id: 502, participant_name: 'Sam Alone', last_event_at: '2026-04-20',
      }],
    });
    const counts = await backfillMappings(sb, 2, { apply: true });
    expect(counts.created_new).toBe(1);
    expect(sb._state.identities).toHaveLength(1);
    expect(sb._state.identities[0].sigcore_participant_id).toBe('SIG-ALONE');
    expect(sb._state.identities[0].identity_priority_source).toBe('openphone');
  });

  test('NEVER merges on phone alone (strict mode): single phone-only candidate → ambiguous', async () => {
    const sb = makeMockSupabase({
      identities: [{
        id: 200, user_id: 2, normalized_phone: '2629305925', normalized_name: null, name_token_set: null,
      }],
      mappings: [{
        id: 600, tenant_id: 2, identity_id: null,
        sigcore_participant_id: 'SIG-PHONE-ONLY', participant_phone_e164: '+12629305925',
      }],
      conversations: [{
        id: 9100, participant_mapping_id: 600, participant_name: 'Linda Mau', last_event_at: '2026-04-20',
      }],
    });
    const counts = await backfillMappings(sb, 2, { apply: true });
    expect(counts.skipped_ambiguous).toBe(1);
    expect(counts.merged_by_phone_name).toBe(0);
    const m = sb._state.mappings[0];
    expect(m.identity_id).toBeNull();
  });

  test('mapping without any identity fields is skipped', async () => {
    const sb = makeMockSupabase({
      identities: [],
      mappings: [{ id: 700, tenant_id: 2, identity_id: null, sigcore_participant_id: null, sigcore_participant_key: null, provider_contact_id: null, participant_phone_e164: '+12629305925' }],
      conversations: [],
    });
    const counts = await backfillMappings(sb, 2, { apply: true });
    expect(counts.skipped_no_identity_fields).toBe(1);
    expect(counts.merged_by_phone_name).toBe(0);
    expect(counts.created_new).toBe(0);
  });
});

describe('backfillZenbookerCustomers', () => {
  test('merges ZB customer into existing LB identity when phone+name match (sync tag does NOT downgrade LB)', async () => {
    const sb = makeMockSupabase({
      identities: [{
        id: 300, user_id: 2, leadbridge_contact_id: 'LB-RACHEL',
        normalized_phone: '9545472588', normalized_name: 'rachael rivers', name_token_set: 'rachael rivers',
        identity_priority_source: 'leadbridge',
      }],
      customers: [{
        id: 800, user_id: 2, zenbooker_id: 'ZB-RACHEL',
        phone: '+19545472588', email: null, first_name: 'Rachael', last_name: 'Rivers',
      }],
    });
    const counts = await backfillZenbookerCustomers(sb, 2, { apply: true });
    expect(counts.merged_by_phone_name).toBe(1);
    const id = sb._state.identities.find(x => x.id === 300);
    expect(id.zenbooker_customer_id).toBe('ZB-RACHEL');
    expect(id.sf_customer_id).toBe(800);
    expect(id.identity_priority_source).toBe('leadbridge'); // NOT downgraded
  });

  test('creates a new sync-tagged identity when no match exists', async () => {
    const sb = makeMockSupabase({
      identities: [],
      customers: [{
        id: 801, user_id: 2, zenbooker_id: 'ZB-NEW',
        phone: '+17044005005', first_name: 'Newby', last_name: 'Test',
      }],
    });
    const counts = await backfillZenbookerCustomers(sb, 2, { apply: true });
    expect(counts.created_new).toBe(1);
    expect(sb._state.identities).toHaveLength(1);
    expect(sb._state.identities[0].identity_priority_source).toBe('sync');
  });
});

describe('fillNormalizedNames', () => {
  test('computes normalized_name + name_token_set on identities with raw display_name', async () => {
    const sb = makeMockSupabase({
      identities: [
        { id: 900, user_id: 2, display_name: 'Dr. Jöhn O\'Brien Jr.', normalized_name: null, name_token_set: null },
        { id: 901, user_id: 2, display_name: 'Linda Mau', normalized_name: null, name_token_set: null },
      ],
    });
    const counts = await fillNormalizedNamesIdentities(sb, 2, { apply: true });
    expect(counts.updated).toBe(2);
    expect(sb._state.identities.find(x => x.id === 900).normalized_name).toBe('john obrien');
    expect(sb._state.identities.find(x => x.id === 901).normalized_name).toBe('linda mau');
  });

  test('normalization ALWAYS writes (Phase 0 is not gated by apply) — dry-run preserves this', async () => {
    const sb = makeMockSupabase({
      identities: [{ id: 910, user_id: 2, display_name: 'Linda Mau', normalized_name: null }],
    });
    // Deliberate: Phase 0 writes regardless — otherwise dry-run can't match
    // phone+name candidates against unpopulated normalized_name columns.
    const counts = await fillNormalizedNamesIdentities(sb, 2, { apply: false });
    expect(counts.updated).toBe(1);
    expect(sb._state.identities[0].normalized_name).toBe('linda mau');
  });

  test('CRM backfill concatenates first_name + last_name', async () => {
    const sb = makeMockSupabase({
      customers: [{ id: 950, user_id: 2, first_name: 'Linda', last_name: 'Mau', normalized_name: null, name_token_set: null }],
    });
    const counts = await fillNormalizedNamesCRM(sb, 2, 'customers', ['first_name', 'last_name'], { apply: true });
    expect(counts.updated).toBe(1);
    expect(sb._state.customers[0].normalized_name).toBe('linda mau');
    expect(sb._state.customers[0].name_token_set).toBe('linda mau');
  });
});

describe('runIdentityBackfill orchestrator', () => {
  test('runs all phases + returns phase-by-phase summary', async () => {
    const sb = makeMockSupabase({
      identities: [{ id: 1000, user_id: 2, display_name: 'Linda Mau', leadbridge_contact_id: 'LB-1' }],
      mappings: [{ id: 500, tenant_id: 2, identity_id: null, sigcore_participant_id: 'SIG-1', participant_phone_e164: '+12629305925' }],
      conversations: [{ id: 9000, participant_mapping_id: 500, participant_name: 'Linda Mau', last_event_at: '2026-04-20' }],
      customers: [{ id: 800, user_id: 2, zenbooker_id: 'ZB-1', first_name: 'Linda', last_name: 'Mau', phone: '+12629305925' }],
      leads: [],
    });
    const summary = await runIdentityBackfill(sb, 2, { apply: true });
    expect(summary.apply).toBe(true);
    expect(summary.normalize_identities.updated).toBe(1);
    expect(summary.normalize_customers.updated).toBe(1);
    expect(summary.backfill_mappings.scanned).toBe(1);
    expect(summary.backfill_zenbooker_customers.scanned).toBe(1);
  });
});
