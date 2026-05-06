/**
 * Source-Account Boundary — Phase 3A provisioner tests.
 *
 * Pins the planner contract and the apply/dry-run + LB-untouched
 * invariants. The CLI is verified by source-text scan plus an
 * integration test that drives the existing ensure* helpers against
 * a supabase stub and asserts idempotent behavior.
 */

const fs = require('fs');
const path = require('path');

const {
  normalizePhone,
  planOpenPhoneAccountsForUser,
  planWhatsappAccountForUser,
  aggregatePlans,
} = require('../lib/source-account-provision');

const {
  ensureOpenPhoneProviderAccount,
  ensureWhatsappProviderAccount,
} = require('../lib/source-account');

// ─── Lightweight supabase stub (mirrors the one in
// source-account-boundary.test.js — kept local so the test files stay
// independent). ───────────────────────────────────────────────────────

function makeSupabaseStub(state = {}) {
  state.tables = state.tables || {};
  state.inserts = state.inserts || [];
  state.updates = state.updates || [];

  function chain(table) {
    const filters = [];
    let pendingInsert = null;
    let pendingUpdate = null;

    const obj = {
      select() { return obj; },
      insert(row) {
        pendingInsert = row;
        const idForTable = (state.tables[table]?.length || 0) + 1;
        const stored = Array.isArray(row)
          ? row.map((r, i) => ({ id: idForTable + i, ...r }))
          : { id: idForTable, ...row };
        state.tables[table] = [...(state.tables[table] || []), ...(Array.isArray(stored) ? stored : [stored])];
        state.inserts.push({ table, row: stored });
        return {
          select: () => ({
            single: async () => ({ data: Array.isArray(stored) ? stored[0] : stored, error: null }),
          }),
        };
      },
      update(patch) { pendingUpdate = patch; return obj; },
      eq(col, val) { filters.push({ col, val }); return obj; },
      async maybeSingle() {
        const rows = (state.tables[table] || []).filter(r => filters.every(f => r[f.col] === f.val));
        if (pendingUpdate) {
          for (const r of rows) Object.assign(r, pendingUpdate);
          state.updates.push({ table, filters, patch: pendingUpdate });
          return { data: rows[0] || null, error: null };
        }
        return { data: rows[0] || null, error: null };
      },
      async single() {
        const r = (state.tables[table] || []).find(row => filters.every(f => row[f.col] === f.val));
        return { data: r || null, error: r ? null : { message: 'not found' } };
      },
      then(onFulfilled) {
        const rows = (state.tables[table] || []).filter(r => filters.every(f => r[f.col] === f.val));
        if (pendingUpdate) {
          for (const r of rows) Object.assign(r, pendingUpdate);
          state.updates.push({ table, filters, patch: pendingUpdate });
          return Promise.resolve({ data: rows, error: null }).then(onFulfilled);
        }
        return Promise.resolve({ data: rows, error: null }).then(onFulfilled);
      },
    };
    return obj;
  }

  return { from: (t) => chain(t), _state: state };
}

const silentLogger = { log: () => {}, warn: () => {}, error: () => {} };

// ─── planOpenPhoneAccountsForUser ─────────────────────────────────

describe('planOpenPhoneAccountsForUser', () => {
  test('emits create plan for a new phoneNumberId', () => {
    const plans = planOpenPhoneAccountsForUser(42, [
      { id: 'PNm5YIDoXV', number: '+18139212100', name: 'Sales' },
    ], []);
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({
      action: 'create_openphone',
      user_id: 42,
      external_account_id: 'PNm5YIDoXV',
      phone_number: '+18139212100',
      display_name: 'Sales',
    });
  });

  test('emits reuse plan when external_account_id already exists', () => {
    const existing = [{
      id: 7, user_id: 42, provider: 'openphone', channel: 'openphone',
      external_account_id: 'PNm5YIDoXV', status: 'active',
    }];
    const plans = planOpenPhoneAccountsForUser(42, [
      { id: 'PNm5YIDoXV', number: '+18139212100' },
    ], existing);
    expect(plans[0]).toMatchObject({
      action: 'reuse_openphone',
      existing_id: 7,
      existing_status: 'active',
    });
  });

  test('reuse plan flags non-active existing status (for reactivation report)', () => {
    const existing = [{
      id: 7, user_id: 42, provider: 'openphone',
      external_account_id: 'PNm5YIDoXV', status: 'disconnected',
    }];
    const plans = planOpenPhoneAccountsForUser(42, [
      { id: 'PNm5YIDoXV', number: '+18139212100' },
    ], existing);
    expect(plans[0].action).toBe('reuse_openphone');
    expect(plans[0].existing_status).toBe('disconnected');
  });

  test('skip plan when phoneNumberId missing — never guesses', () => {
    const plans = planOpenPhoneAccountsForUser(42, [
      { number: '+18139212100' }, // no id field
    ], []);
    expect(plans[0].action).toBe('skip_openphone');
    expect(plans[0].reason).toMatch(/missing phoneNumberId/);
  });

  test('handles empty cached_phone_numbers', () => {
    expect(planOpenPhoneAccountsForUser(42, [], [])).toEqual([]);
    expect(planOpenPhoneAccountsForUser(42, null, [])).toEqual([]);
  });

  test('does NOT consider LB rows when planning OP', () => {
    const lbRow = {
      id: 99, user_id: 42, provider: 'leadbridge',
      external_account_id: 'PNm5YIDoXV', status: 'active',
    };
    const plans = planOpenPhoneAccountsForUser(42, [{ id: 'PNm5YIDoXV', number: '+18139212100' }], [lbRow]);
    // LB row with same external_account_id must NOT count as an existing OP row.
    expect(plans[0].action).toBe('create_openphone');
  });

  test('matches existing across different user_id values when caller scopes correctly', () => {
    // The caller is responsible for passing only this user's PA rows.
    // Planner doesn't filter by user_id internally — it trusts the caller.
    const existing = [{
      id: 7, user_id: 42, provider: 'openphone',
      external_account_id: 'PNm5YIDoXV', status: 'active',
    }];
    const plans = planOpenPhoneAccountsForUser(42, [{ id: 'PNm5YIDoXV', number: '+18139212100' }], existing);
    expect(plans[0].action).toBe('reuse_openphone');
  });

  test('multiple phones produce one plan each', () => {
    const plans = planOpenPhoneAccountsForUser(42, [
      { id: 'PN1', number: '+18139212100' },
      { id: 'PN2', number: '+19045778584' },
    ], []);
    expect(plans).toHaveLength(2);
    expect(plans[0].action).toBe('create_openphone');
    expect(plans[1].action).toBe('create_openphone');
  });

  test('display_name falls back to "OpenPhone <phone>" when name missing', () => {
    const plans = planOpenPhoneAccountsForUser(42, [{ id: 'PN1', number: '+18139212100' }], []);
    expect(plans[0].display_name).toBe('OpenPhone +18139212100');
  });
});

// ─── planWhatsappAccountForUser ───────────────────────────────────

describe('planWhatsappAccountForUser', () => {
  test('emits create plan for a new connected WA phone', () => {
    const plan = planWhatsappAccountForUser(42, '+18139212100', []);
    expect(plan).toMatchObject({
      action: 'create_whatsapp',
      user_id: 42,
      phone_number: '+18139212100',
    });
  });

  test('emits reuse plan when WA row already exists for that phone', () => {
    const existing = [{
      id: 9, user_id: 42, provider: 'whatsapp',
      external_account_id: '+18139212100', status: 'active',
    }];
    const plan = planWhatsappAccountForUser(42, '+18139212100', existing);
    expect(plan).toMatchObject({ action: 'reuse_whatsapp', existing_id: 9, existing_status: 'active' });
  });

  test('emits skip plan when phone missing — never guesses', () => {
    expect(planWhatsappAccountForUser(42, null, []).action).toBe('skip_whatsapp');
    expect(planWhatsappAccountForUser(42, '', []).action).toBe('skip_whatsapp');
  });

  test('normalizes 10-digit phone before lookup', () => {
    const existing = [{
      id: 9, user_id: 42, provider: 'whatsapp',
      external_account_id: '+18139212100', status: 'active',
    }];
    const plan = planWhatsappAccountForUser(42, '8139212100', existing);
    expect(plan.action).toBe('reuse_whatsapp');
  });

  test('does NOT match LB row even if external_account_id collides', () => {
    const lbRow = {
      id: 99, user_id: 42, provider: 'leadbridge',
      external_account_id: '+18139212100', status: 'active',
    };
    const plan = planWhatsappAccountForUser(42, '+18139212100', [lbRow]);
    expect(plan.action).toBe('create_whatsapp');
  });

  test('does NOT match another OP row with the same phone in metadata', () => {
    const opRow = {
      id: 7, user_id: 42, provider: 'openphone',
      external_account_id: 'PNm5YIDoXV', status: 'active',
      metadata: { phoneNumber: '+18139212100' },
    };
    const plan = planWhatsappAccountForUser(42, '+18139212100', [opRow]);
    // OP row uses a different external_account_id key — must NOT collide with WA.
    expect(plan.action).toBe('create_whatsapp');
  });
});

// ─── aggregatePlans ───────────────────────────────────────────────

describe('aggregatePlans', () => {
  test('counts each action bucket', () => {
    const plans = [
      { action: 'create_openphone', user_id: 1 },
      { action: 'create_openphone', user_id: 1 },
      { action: 'reuse_openphone', user_id: 1, existing_status: 'active' },
      { action: 'skip_openphone', user_id: 2 },
      { action: 'create_whatsapp', user_id: 1 },
      { action: 'reuse_whatsapp', user_id: 3, existing_status: 'disconnected' },
    ];
    const r = aggregatePlans(plans);
    expect(r.counts).toEqual({
      create_openphone: 2, reuse_openphone: 1, skip_openphone: 1,
      create_whatsapp: 1, reuse_whatsapp: 1, skip_whatsapp: 0,
    });
    expect(r.users_scanned).toBe(3);
  });

  test('flags reactivations (reuse with non-active existing_status)', () => {
    const plans = [
      { action: 'reuse_openphone', user_id: 1, existing_status: 'active' },
      { action: 'reuse_openphone', user_id: 2, existing_status: 'disconnected' },
      { action: 'reuse_whatsapp', user_id: 3, existing_status: 'paused' },
    ];
    const r = aggregatePlans(plans);
    expect(r.inconsistencies.reactivations).toBe(2);
    expect(r.inconsistencies.reactivation_samples).toHaveLength(2);
  });

  test('caps samples at sampleSize', () => {
    const plans = Array.from({ length: 50 }, (_, i) => ({
      action: 'create_openphone', user_id: i, external_account_id: `PN${i}`,
    }));
    const r = aggregatePlans(plans, { sampleSize: 5 });
    expect(r.counts.create_openphone).toBe(50);
    expect(r.samples.create_openphone).toHaveLength(5);
  });
});

// ─── ensure* helpers driven by planner output (apply-mode contract) ──

describe('Phase 3A apply-mode behavior (against supabase stub)', () => {
  test('apply creates OP rows, second apply is idempotent (all reuse)', async () => {
    const supa = makeSupabaseStub();
    // Run #1: empty table → all inserts
    const planA = planOpenPhoneAccountsForUser(42, [
      { id: 'PN1', number: '+18139212100' },
      { id: 'PN2', number: '+19045778584' },
    ], []);
    expect(planA.every(p => p.action === 'create_openphone')).toBe(true);
    for (const p of planA) {
      await ensureOpenPhoneProviderAccount(supa, silentLogger, p.user_id, {
        id: p.external_account_id, number: p.phone_number, name: p.display_name,
      });
    }
    expect(supa._state.tables.communication_provider_accounts).toHaveLength(2);
    const insertsAfterFirstRun = supa._state.inserts.length;

    // Run #2: same plan, but now read existing rows back
    const existing = supa._state.tables.communication_provider_accounts;
    const planB = planOpenPhoneAccountsForUser(42, [
      { id: 'PN1', number: '+18139212100' },
      { id: 'PN2', number: '+19045778584' },
    ], existing);
    expect(planB.every(p => p.action === 'reuse_openphone')).toBe(true);
    for (const p of planB) {
      await ensureOpenPhoneProviderAccount(supa, silentLogger, p.user_id, {
        id: p.external_account_id, number: p.phone_number,
      });
    }
    // No new inserts — only updates (reactivation pass).
    expect(supa._state.inserts).toHaveLength(insertsAfterFirstRun);
    expect(supa._state.tables.communication_provider_accounts).toHaveLength(2);
  });

  test('apply creates WA row, second apply is idempotent', async () => {
    const supa = makeSupabaseStub();
    const planA = planWhatsappAccountForUser(42, '+18139212100', []);
    expect(planA.action).toBe('create_whatsapp');
    await ensureWhatsappProviderAccount(supa, silentLogger, planA.user_id, planA.phone_number);
    expect(supa._state.tables.communication_provider_accounts).toHaveLength(1);

    const existing = supa._state.tables.communication_provider_accounts;
    const planB = planWhatsappAccountForUser(42, '+18139212100', existing);
    expect(planB.action).toBe('reuse_whatsapp');
    await ensureWhatsappProviderAccount(supa, silentLogger, planB.user_id, planB.phone_number);
    expect(supa._state.tables.communication_provider_accounts).toHaveLength(1); // no duplicate
  });

  test('apply does NOT touch LeadBridge rows even when present in the stub', async () => {
    const supa = makeSupabaseStub({
      tables: {
        communication_provider_accounts: [{
          id: 1, user_id: 42, provider: 'leadbridge', channel: 'thumbtack',
          external_account_id: 'lb-acct', status: 'active',
        }],
      },
    });
    const plan = planWhatsappAccountForUser(42, '+18139212100', []);
    await ensureWhatsappProviderAccount(supa, silentLogger, plan.user_id, plan.phone_number);
    // LB row still untouched
    const lbRow = supa._state.tables.communication_provider_accounts.find(r => r.provider === 'leadbridge');
    expect(lbRow).toMatchObject({ id: 1, status: 'active' });
    // No update was issued for the LB row
    const lbUpdates = supa._state.updates.filter(u =>
      u.filters.some(f => f.col === 'id' && f.val === 1)
    );
    expect(lbUpdates).toHaveLength(0);
  });

  test('skip plans are not applied (no insert/update for skip_openphone)', async () => {
    const supa = makeSupabaseStub();
    const plans = planOpenPhoneAccountsForUser(42, [
      { number: '+18139212100' }, // missing id → skip
    ], []);
    expect(plans[0].action).toBe('skip_openphone');
    // CLI semantics: skip plans are NOT passed to ensure*. Verify by simulating
    // the CLI loop: only create_*/reuse_* trigger ensure calls.
    for (const p of plans) {
      if (p.action === 'create_openphone' || p.action === 'reuse_openphone') {
        await ensureOpenPhoneProviderAccount(supa, silentLogger, p.user_id, {
          id: p.external_account_id, number: p.phone_number,
        });
      }
    }
    expect(supa._state.tables.communication_provider_accounts || []).toHaveLength(0);
  });
});

// ─── CLI source-text guards ───────────────────────────────────────

describe('scripts/source-account-provision-provider-accounts.js: invariants', () => {
  const scriptPath = path.join(__dirname, '..', 'scripts', 'source-account-provision-provider-accounts.js');
  const src = fs.readFileSync(scriptPath, 'utf8');

  test('default mode is dry-run (apply requires explicit flag)', () => {
    expect(src).toMatch(/const APPLY = argv\.includes\('--apply'\)/);
  });

  test('dry-run wraps supabase to refuse non-select chain methods', () => {
    expect(src).toMatch(/refusing \$\{m\} on \$\{table\}/);
    expect(src).toMatch(/insert.*update.*upsert.*delete/);
  });

  test('LB is filtered at the read layer (only OP+WA loaded)', () => {
    expect(src).toMatch(/\.in\('provider', \['openphone', 'whatsapp'\]\)/);
  });

  test('script never imports or writes to communication_conversations / messages / calls / identities', () => {
    expect(src).not.toMatch(/communication_conversations/);
    expect(src).not.toMatch(/communication_messages/);
    expect(src).not.toMatch(/communication_calls/);
    expect(src).not.toMatch(/communication_participant_identities/);
  });

  test('apply uses ensure* helpers (which themselves only write OP/WA rows)', () => {
    expect(src).toMatch(/ensureOpenPhoneProviderAccount/);
    expect(src).toMatch(/ensureWhatsappProviderAccount/);
  });

  test('does NOT read or write SOURCE_ACCOUNT_BOUNDARY_ENFORCED at runtime', () => {
    // The header comment legitimately mentions the flag to document intent
    // ("stays OFF"). The test rejects only actual code references that would
    // read or write the flag.
    expect(src).not.toMatch(/process\.env\.SOURCE_ACCOUNT_BOUNDARY_ENFORCED/);
    expect(src).not.toMatch(/isEnabled\([^)]*SOURCE_ACCOUNT_BOUNDARY_ENFORCED/);
    expect(src).not.toMatch(/FLAGS\.SOURCE_ACCOUNT_BOUNDARY_ENFORCED/);
  });
});

// ─── normalizePhone parity (helper exported again for CLI use) ─────

describe('normalizePhone parity', () => {
  test('matches lib/source-account contract', () => {
    expect(normalizePhone('8139212100')).toBe('+18139212100');
    expect(normalizePhone('+18139212100')).toBe('+18139212100');
    expect(normalizePhone(null)).toBeNull();
    expect(normalizePhone('')).toBeNull();
  });
});
