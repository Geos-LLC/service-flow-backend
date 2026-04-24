const { runIntegrationSync, fillMissingAttribution, loadSourceMappings, SOURCES } = require('../lib/integration-sync-orchestrator');

// Minimal mock for the supabase chain patterns this module uses.
function mockSupabase({ customers = [], leads = [], sourceMappings = [], conversations = [], ambiguitiesOpen = 0 } = {}) {
  function tableChain(rows, { pkCol = 'id' } = {}) {
    const filters = [];
    let limit = null;
    let orderAsc = true;
    let selectHead = false;
    const apply = () => rows.filter(r => filters.every(f => {
      if (f.op === 'eq') return r[f.col] === f.val;
      if (f.op === 'gt') return r[f.col] > f.val;
      if (f.op === 'is_null') return r[f.col] == null;
      if (f.op === 'not_is_null') return r[f.col] != null;
      if (f.op === 'or_null_or_empty') return r.source == null || r.source === '';
      if (f.op === 'or_phone_like') {
        const last10s = f.patterns.map(p => String(p || '').replace(/%/g, ''));
        const pv = String(r.participant_phone || '').toLowerCase();
        return last10s.some(p => pv.includes(p.toLowerCase()));
      }
      return true;
    }));
    const chain = {
      select(_cols, opts) { if (opts?.head) selectHead = true; return chain; },
      eq(col, val) { filters.push({ op: 'eq', col, val }); return chain; },
      gt(col, val) { filters.push({ op: 'gt', col, val }); return chain; },
      is(col, val) { if (val === null) filters.push({ op: 'is_null', col }); return chain; },
      not(col, _op, val) { if (val === null) filters.push({ op: 'not_is_null', col }); return chain; },
      or(expr) {
        if (expr && expr.includes('source.is.null')) { filters.push({ op: 'or_null_or_empty' }); return chain; }
        const m = expr && [...expr.matchAll(/participant_phone\.ilike\.%(\d+)%/g)].map(x => x[1]);
        if (m && m.length) filters.push({ op: 'or_phone_like', patterns: m });
        return chain;
      },
      order(_col, opts) { orderAsc = opts?.ascending !== false; return chain; },
      limit(n) { limit = n; return chain; },
      then(fn) {
        let r = apply();
        if (orderAsc) r.sort((a, b) => (a[pkCol] || 0) - (b[pkCol] || 0));
        if (limit) r = r.slice(0, limit);
        const out = { data: r, error: null };
        if (selectHead) out.count = r.length;
        return Promise.resolve(out).then(fn);
      },
      maybeSingle() { const r = apply(); return Promise.resolve({ data: r[0] || null, error: null }); },
      update(patch) {
        return {
          eq(col, val) {
            const target = rows.find(r => r[col] === val);
            if (target) Object.assign(target, patch);
            return {
              or() { return this; }, // defensive double-check filter — mock no-op
              then(fn) { return Promise.resolve({ data: target ? [target] : [], error: null }).then(fn); },
            };
          },
        };
      },
    };
    return chain;
  }
  return {
    from(tbl) {
      if (tbl === 'customers') return tableChain(customers);
      if (tbl === 'leads') return tableChain(leads);
      if (tbl === 'lead_source_mappings') return tableChain(sourceMappings);
      if (tbl === 'communication_conversations') return tableChain(conversations);
      if (tbl === 'communication_identity_ambiguities') {
        return {
          select(_c, opts) {
            return {
              eq() { return this; },
              then(fn) { return Promise.resolve({ count: opts?.head ? ambiguitiesOpen : 0, data: [], error: null }).then(fn); },
            };
          },
        };
      }
      throw new Error('mock: unknown table ' + tbl);
    },
  };
}

describe('SOURCES constant', () => {
  test('is exactly openphone/leadbridge/zenbooker', () => {
    expect([...SOURCES].sort()).toEqual(['leadbridge', 'openphone', 'zenbooker']);
  });
});

describe('loadSourceMappings', () => {
  test('returns { lowercased raw: canonical }', async () => {
    const sb = mockSupabase({
      sourceMappings: [
        { user_id: 2, provider: 'openphone', raw_value: 'Thumbtack J', source_name: 'Thumbtack Jacksonville' },
        { user_id: 2, provider: 'openphone', raw_value: 'Google Tampa', source_name: 'Google Tampa' },
      ],
    });
    const m = await loadSourceMappings(sb, 2, 'openphone');
    expect(m['thumbtack j']).toBe('Thumbtack Jacksonville');
    expect(m['google tampa']).toBe('Google Tampa');
  });
  test('empty when no mappings', async () => {
    const sb = mockSupabase({ sourceMappings: [] });
    expect(await loadSourceMappings(sb, 2)).toEqual({});
  });
});

describe('fillMissingAttribution', () => {
  const mappings = [
    { user_id: 2, provider: 'openphone', raw_value: 'Thumbtack J', source_name: 'Thumbtack Jacksonville' },
    { user_id: 2, provider: 'openphone', raw_value: 'Google Tampa', source_name: 'Google Tampa' },
  ];

  test('fills customer.source from latest OP conversation company', async () => {
    const customers = [{ id: 100, user_id: 2, phone: '+13055650291', source: null }];
    const conversations = [
      { user_id: 2, participant_phone: '+13055650291', company: 'Thumbtack J', last_event_at: '2026-04-20T00:00:00Z' },
    ];
    const sb = mockSupabase({ customers, sourceMappings: mappings, conversations });
    const r = await fillMissingAttribution(sb, 2);
    expect(r.customers_filled).toBe(1);
    expect(customers[0].source).toBe('Thumbtack Jacksonville');
  });

  test('does NOT overwrite non-null source', async () => {
    const customers = [{ id: 100, user_id: 2, phone: '+13055650291', source: 'Manual' }];
    const conversations = [
      { user_id: 2, participant_phone: '+13055650291', company: 'Thumbtack J', last_event_at: '2026-04-20T00:00:00Z' },
    ];
    const sb = mockSupabase({ customers, sourceMappings: mappings, conversations });
    const r = await fillMissingAttribution(sb, 2);
    expect(r.customers_filled).toBe(0);
    expect(customers[0].source).toBe('Manual');
  });

  test('skips when company has no mapping', async () => {
    const customers = [{ id: 100, user_id: 2, phone: '+13055650291', source: null }];
    const conversations = [
      { user_id: 2, participant_phone: '+13055650291', company: 'Random Unknown', last_event_at: '2026-04-20T00:00:00Z' },
    ];
    const sb = mockSupabase({ customers, sourceMappings: mappings, conversations });
    const r = await fillMissingAttribution(sb, 2);
    expect(r.customers_filled).toBe(0);
  });

  test('skips when no mappings configured at all', async () => {
    const customers = [{ id: 100, user_id: 2, phone: '+13055650291', source: null }];
    const sb = mockSupabase({ customers, sourceMappings: [], conversations: [] });
    const r = await fillMissingAttribution(sb, 2);
    expect(r).toEqual({ customers_filled: 0, leads_filled: 0 });
  });

  test('fills both customers and leads', async () => {
    const customers = [{ id: 100, user_id: 2, phone: '+13055650291', source: null }];
    const leads = [{ id: 200, user_id: 2, phone: '+12626666666', source: null }];
    const conversations = [
      { user_id: 2, participant_phone: '+13055650291', company: 'Thumbtack J', last_event_at: '2026-04-20T00:00:00Z' },
      { user_id: 2, participant_phone: '+12626666666', company: 'Google Tampa', last_event_at: '2026-04-20T00:00:00Z' },
    ];
    const sb = mockSupabase({ customers, leads, sourceMappings: mappings, conversations });
    const r = await fillMissingAttribution(sb, 2);
    expect(r.customers_filled).toBe(1);
    expect(r.leads_filled).toBe(1);
  });
});

describe('runIntegrationSync', () => {
  test('rejects unknown source', async () => {
    const sb = mockSupabase();
    await expect(runIntegrationSync(sb, 2, 'myspace')).rejects.toThrow('unknown source');
  });

  test('openphone run with no deps — runs source-fill + reports open_issues', async () => {
    const customers = [{ id: 100, user_id: 2, phone: '+13055650291', source: null }];
    const conversations = [
      { user_id: 2, participant_phone: '+13055650291', company: 'Thumbtack J', last_event_at: '2026-04-20T00:00:00Z' },
    ];
    const sb = mockSupabase({
      customers,
      sourceMappings: [{ user_id: 2, provider: 'openphone', raw_value: 'Thumbtack J', source_name: 'Thumbtack Jacksonville' }],
      conversations,
      ambiguitiesOpen: 7,
    });
    const summary = await runIntegrationSync(sb, 2, 'openphone');
    expect(summary.source).toBe('openphone');
    expect(summary.source_fill.customers_filled).toBe(1);
    expect(summary.open_issues).toBe(7);
    expect(summary.errors).toEqual([]);
  });

  test('zenbooker run with injected dep receives the sync result in summary', async () => {
    const sb = mockSupabase({});
    const summary = await runIntegrationSync(sb, 2, 'zenbooker', {
      deps: {
        runZenbookerFullSync: async () => ({ customers_synced: 42, customers_created: 5, customers_adopted: 3 }),
      },
    });
    expect(summary.records_synced).toBe(42);
    expect(summary.records_created).toBe(5);
    expect(summary.records_linked).toBe(3);
  });
});
