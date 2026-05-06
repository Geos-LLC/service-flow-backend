/**
 * Source-Account Boundary — Phase 4 read-side visibility tests.
 *
 * Pins the helper contract + the integration shape in server.js
 * (flag-gated, 404 on detail, 409 on send, no writes, identities
 * untouched, hidden_at not set, gmail/outlook unchanged).
 */

const fs = require('fs');
const path = require('path');

const {
  loadDisconnectedAccountIds,
  getProviderAccountStatus,
  isConversationHiddenByBoundary,
  filterVisibleConversations,
  getHidingReason,
} = require('../lib/source-account-visibility');

const { FLAGS, isEnabled } = require('../lib/feature-flags');

// ── Supabase stub (keeps tests independent of other suites) ─────────

function makeSupabaseStub(state = {}) {
  state.tables = state.tables || {};
  function chain(table) {
    const filters = [];
    let isNeq = null;
    const obj = {
      select() { return obj; },
      eq(c, v) { filters.push({ op: 'eq', col: c, val: v }); return obj; },
      neq(c, v) { filters.push({ op: 'neq', col: c, val: v }); return obj; },
      async maybeSingle() {
        const r = (state.tables[table] || []).find(row => filters.every(f => f.op === 'eq' ? row[f.col] === f.val : row[f.col] !== f.val));
        return { data: r || null, error: null };
      },
      then(onFulfilled) {
        const rows = (state.tables[table] || []).filter(row => filters.every(f => f.op === 'eq' ? row[f.col] === f.val : row[f.col] !== f.val));
        return Promise.resolve({ data: rows, error: null }).then(onFulfilled);
      },
    };
    return obj;
  }
  return { from: (t) => chain(t), _state: state };
}

// ── isConversationHiddenByBoundary — pure decision ──────────────────

describe('isConversationHiddenByBoundary', () => {
  test('null provider_account_id → visible (legacy / gmail / outlook stay)', () => {
    expect(isConversationHiddenByBoundary({ provider_account_id: null }, new Set([1, 2]))).toBe(false);
    expect(isConversationHiddenByBoundary({ provider_account_id: undefined }, new Set([1, 2]))).toBe(false);
  });

  test('non-null but not in disconnected set → visible', () => {
    expect(isConversationHiddenByBoundary({ provider_account_id: 7 }, new Set([1, 2]))).toBe(false);
  });

  test('non-null AND in disconnected set → hidden', () => {
    expect(isConversationHiddenByBoundary({ provider_account_id: 2 }, new Set([1, 2]))).toBe(true);
  });

  test('empty disconnected set → all visible', () => {
    expect(isConversationHiddenByBoundary({ provider_account_id: 99 }, new Set())).toBe(false);
  });

  test('null conversation defensively returns false', () => {
    expect(isConversationHiddenByBoundary(null, new Set([1]))).toBe(false);
  });
});

// ── filterVisibleConversations — list shape ─────────────────────────

describe('filterVisibleConversations', () => {
  test('filters out conversations whose source PA is disconnected', () => {
    const convs = [
      { id: 1, provider_account_id: null },        // legacy/email — keep
      { id: 2, provider_account_id: 7 },           // active — keep
      { id: 3, provider_account_id: 2 },           // disconnected — drop
      { id: 4, provider_account_id: 4 },           // disconnected — drop
      { id: 5, provider: 'gmail', provider_account_id: null }, // gmail — keep
    ];
    const out = filterVisibleConversations(convs, new Set([2, 4]));
    expect(out.map(c => c.id)).toEqual([1, 2, 5]);
  });

  test('returns input unchanged when disconnected set is empty', () => {
    const convs = [{ id: 1, provider_account_id: 7 }];
    expect(filterVisibleConversations(convs, new Set())).toBe(convs);
    expect(filterVisibleConversations(convs, null)).toBe(convs);
  });

  test('returns [] for non-array input', () => {
    expect(filterVisibleConversations(null, new Set([1]))).toEqual([]);
    expect(filterVisibleConversations(undefined, new Set([1]))).toEqual([]);
  });

  test('does not mutate input array', () => {
    const convs = [
      { id: 1, provider_account_id: 2 },
      { id: 2, provider_account_id: 7 },
    ];
    const out = filterVisibleConversations(convs, new Set([2]));
    expect(convs).toHaveLength(2); // original untouched
    expect(out).toHaveLength(1);
  });
});

// ── getHidingReason — diagnostic string ─────────────────────────────

describe('getHidingReason', () => {
  test('returns null for visible rows', () => {
    expect(getHidingReason({ provider_account_id: null }, new Set([1]))).toBeNull();
    expect(getHidingReason({ provider_account_id: 7 }, new Set([1]))).toBeNull();
  });

  test('returns descriptive string for hidden rows', () => {
    const r = getHidingReason({ provider_account_id: 4 }, new Set([2, 4]));
    expect(r).toMatch(/source_account_disconnected/);
    expect(r).toMatch(/account_id=4/);
  });
});

// ── loadDisconnectedAccountIds ──────────────────────────────────────

describe('loadDisconnectedAccountIds', () => {
  test('returns Set of ids where status != active for the given user', async () => {
    const supa = makeSupabaseStub({
      tables: {
        communication_provider_accounts: [
          { id: 1, user_id: 42, status: 'active' },
          { id: 2, user_id: 42, status: 'disconnected' },
          { id: 3, user_id: 42, status: 'paused' },
          { id: 4, user_id: 42, status: 'error' },
          { id: 5, user_id: 99, status: 'disconnected' }, // different user — excluded
        ],
      },
    });
    const out = await loadDisconnectedAccountIds(supa, 42);
    expect(out instanceof Set).toBe(true);
    expect([...out].sort((a, b) => a - b)).toEqual([2, 3, 4]);
  });

  test('returns empty Set when no rows exist', async () => {
    const supa = makeSupabaseStub();
    const out = await loadDisconnectedAccountIds(supa, 42);
    expect(out.size).toBe(0);
  });

  test('returns empty Set on missing inputs', async () => {
    expect((await loadDisconnectedAccountIds(null, 42)).size).toBe(0);
    expect((await loadDisconnectedAccountIds({}, null)).size).toBe(0);
  });
});

// ── getProviderAccountStatus ────────────────────────────────────────

describe('getProviderAccountStatus', () => {
  test('returns the status string for an existing row', async () => {
    const supa = makeSupabaseStub({
      tables: {
        communication_provider_accounts: [
          { id: 7, status: 'active' },
          { id: 8, status: 'disconnected' },
        ],
      },
    });
    expect(await getProviderAccountStatus(supa, 7)).toBe('active');
    expect(await getProviderAccountStatus(supa, 8)).toBe('disconnected');
  });

  test('returns null when row does not exist', async () => {
    const supa = makeSupabaseStub();
    expect(await getProviderAccountStatus(supa, 999)).toBeNull();
  });

  test('returns null on missing inputs', async () => {
    expect(await getProviderAccountStatus(null, 7)).toBeNull();
    expect(await getProviderAccountStatus({}, null)).toBeNull();
  });
});

// ── Feature flag default OFF ────────────────────────────────────────

describe('SOURCE_ACCOUNT_BOUNDARY_ENFORCED defaults to OFF', () => {
  afterEach(() => { delete process.env[FLAGS.SOURCE_ACCOUNT_BOUNDARY_ENFORCED]; });

  test('default is false — preserves legacy behavior', () => {
    expect(isEnabled(FLAGS.SOURCE_ACCOUNT_BOUNDARY_ENFORCED)).toBe(false);
  });

  test('env opt-in activates the gate', () => {
    process.env[FLAGS.SOURCE_ACCOUNT_BOUNDARY_ENFORCED] = '1';
    expect(isEnabled(FLAGS.SOURCE_ACCOUNT_BOUNDARY_ENFORCED)).toBe(true);
  });
});

// ── server.js integration invariants (source-text scan) ─────────────

describe('server.js: read-side enforcement integration', () => {
  const serverPath = path.join(__dirname, '..', 'server.js');
  const src = fs.readFileSync(serverPath, 'utf8');

  test('imports the visibility helpers', () => {
    expect(src).toMatch(/loadDisconnectedAccountIds[\s\S]*getProviderAccountStatus[\s\S]*filterVisibleConversations/);
    expect(src).toMatch(/require\('\.\/lib\/source-account-visibility'\)/);
  });

  test('list endpoint gates the filter behind the flag', () => {
    // Find the list endpoint and confirm the filter call is inside an
    // isEnabled(SOURCE_ACCOUNT_BOUNDARY_ENFORCED) block.
    const listMatch = src.match(/app\.get\('\/api\/communications\/conversations'[\s\S]+?(?=app\.(?:get|post|patch|delete))/);
    expect(listMatch).toBeTruthy();
    const block = listMatch[0];
    expect(block).toMatch(/isEnabled\(FLAGS\.SOURCE_ACCOUNT_BOUNDARY_ENFORCED\)/);
    expect(block).toMatch(/filterVisibleConversations/);
    // Filter must follow the flag check (not before).
    const flagIdx = block.indexOf('isEnabled(FLAGS.SOURCE_ACCOUNT_BOUNDARY_ENFORCED)');
    const filterIdx = block.indexOf('filterVisibleConversations');
    expect(filterIdx).toBeGreaterThan(flagIdx);
  });

  test('detail endpoint returns 404 when source is not active (flag-gated)', () => {
    const detailMatch = src.match(/app\.get\('\/api\/communications\/conversations\/:id'[\s\S]+?(?=app\.(?:get|post|patch|delete))/);
    expect(detailMatch).toBeTruthy();
    const block = detailMatch[0];
    expect(block).toMatch(/isEnabled\(FLAGS\.SOURCE_ACCOUNT_BOUNDARY_ENFORCED\)/);
    expect(block).toMatch(/getProviderAccountStatus/);
    expect(block).toMatch(/res\.status\(404\)/);
    // The 404 must be inside the boundary block (right after the status check).
    expect(block).toMatch(/status\s*&&\s*status\s*!==\s*['"]active['"][\s\S]*?res\.status\(404\)/);
  });

  test('send endpoint returns 409 with reason source_account_disconnected (flag-gated)', () => {
    const sendMatch = src.match(/app\.post\('\/api\/communications\/conversations\/:id\/send'[\s\S]+?(?=app\.(?:get|post|patch|delete))/);
    expect(sendMatch).toBeTruthy();
    const block = sendMatch[0];
    expect(block).toMatch(/isEnabled\(FLAGS\.SOURCE_ACCOUNT_BOUNDARY_ENFORCED\)/);
    expect(block).toMatch(/getProviderAccountStatus/);
    expect(block).toMatch(/res\.status\(409\)\.json\(\{\s*reason:\s*['"]source_account_disconnected['"]/);
  });

  test('Phase 4 changes do not introduce DELETE / hidden_at writes', () => {
    // Pull just the new boundary blocks (between BOUNDARY comment markers)
    // and assert no DELETE or hidden_at SET appears in them.
    const boundaryBlocks = src.match(/Source-account boundary \(Phase 4\)[\s\S]*?(?=\n {4}\/\/|\n  \/\/|\n\})/g) || [];
    expect(boundaryBlocks.length).toBeGreaterThanOrEqual(3); // list + detail + send
    for (const block of boundaryBlocks) {
      expect(block).not.toMatch(/\.delete\s*\(/);
      expect(block).not.toMatch(/SET hidden_at/i);
      expect(block).not.toMatch(/hidden_at\s*=/);
      expect(block).not.toMatch(/communication_participant_identities/);
    }
  });
});

// ── End-to-end behavioral tests on the helpers (no server boot) ──────
//
// Exercises the "active vs disconnected vs gmail" matrix the way the
// real handlers will use the helper. Pinned to catch a regression that
// silently changes the visibility decision for any input shape.

describe('full visibility matrix', () => {
  const disconnected = new Set([2, 4]);

  test('ACTIVE: provider_account_id=7 → visible in list, no hide reason', () => {
    const conv = { id: 100, provider_account_id: 7 };
    expect(isConversationHiddenByBoundary(conv, disconnected)).toBe(false);
    expect(getHidingReason(conv, disconnected)).toBeNull();
  });

  test('DISCONNECTED LB account #2 → hidden, reason names the account', () => {
    const conv = { id: 139, provider: 'leadbridge', provider_account_id: 2 };
    expect(isConversationHiddenByBoundary(conv, disconnected)).toBe(true);
    expect(getHidingReason(conv, disconnected)).toMatch(/account_id=2/);
  });

  test('DISCONNECTED LB account #4 → hidden (covers Yelp Miami phantom)', () => {
    const conv = { id: 199, provider: 'leadbridge', channel: 'yelp', provider_account_id: 4 };
    expect(isConversationHiddenByBoundary(conv, disconnected)).toBe(true);
  });

  test('GMAIL conversation (provider=gmail, FK=null) → visible in normal view', () => {
    const conv = { id: 5193, provider: 'gmail', channel: 'email', provider_account_id: null };
    expect(isConversationHiddenByBoundary(conv, disconnected)).toBe(false);
  });

  test('OUTLOOK conversation → visible in normal view', () => {
    const conv = { id: 5710, provider: 'outlook', channel: 'email', provider_account_id: null };
    expect(isConversationHiddenByBoundary(conv, disconnected)).toBe(false);
  });

  test('Orphan OP conversation (FK=null because both phones were null) → visible in normal view', () => {
    // The 2 orphan rows we found in Phase 3B that had no endpoint_phone
    // and no participant_phone. They have provider_account_id=null after
    // Phase 1/3, so under normal view they stay visible. Account-scoped
    // view excludes them via the existing eq filter.
    const conv = { id: 145, provider: 'openphone', provider_account_id: null };
    expect(isConversationHiddenByBoundary(conv, disconnected)).toBe(false);
  });
});
