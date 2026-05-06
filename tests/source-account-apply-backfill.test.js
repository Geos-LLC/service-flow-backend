/**
 * Source-Account Boundary — Phase 3B apply-backfill tests.
 *
 * Pins the planner contract, the SQL-builder shape, the no-overwrite
 * guard, and the CLI's dry-run + identity-untouched invariants.
 */

const fs = require('fs');
const path = require('path');

const {
  classifyConversation,
  indexProviderAccounts,
} = require('../lib/source-account-backfill');

const {
  APPLY_BUCKETS,
  SKIP_BUCKETS,
  planConversationApply,
  generateBatchId,
  buildBackfillSql,
  buildChildCountSql,
  buildRollbackSql,
  chunkIds,
} = require('../lib/source-account-apply');

// ── Fixtures ─────────────────────────────────────────────────────

function lbAcct(over = {}) {
  return {
    id: 1, user_id: 42, provider: 'leadbridge', channel: 'thumbtack',
    external_account_id: 'acct-tt-1', external_business_id: 'biz-1',
    status: 'active', metadata: {}, ...over,
  };
}
function opAcct(over = {}) {
  return {
    id: 2, user_id: 42, provider: 'openphone', channel: 'openphone',
    external_account_id: 'PNm5YIDoXV', status: 'active',
    metadata: { phoneNumber: '+18139212100' }, ...over,
  };
}

function lbConv(over = {}) {
  return {
    id: 100, user_id: 42, provider: 'leadbridge', channel: 'thumbtack',
    endpoint_phone: null, external_business_id: 'biz-1',
    external_lead_id: 'lead-1', external_conversation_id: 'thread-1',
    provider_account_id: null, ...over,
  };
}
function opConv(over = {}) {
  return {
    id: 200, user_id: 42, provider: 'openphone', channel: 'sms',
    endpoint_phone: '+18139212100', external_business_id: null,
    external_lead_id: null, external_conversation_id: 'sigcoreConvX',
    provider_account_id: null, ...over,
  };
}

function classify(conv, accountIndex) {
  return classifyConversation(conv, accountIndex);
}

// ── planConversationApply ────────────────────────────────────────

describe('planConversationApply: bucket gating', () => {
  test('matched_inferred is accepted and grouped by target account', () => {
    const idx = indexProviderAccounts([opAcct({ id: 7 }), lbAcct({ id: 8 })]);
    const classified = [
      { conv: opConv({ id: 200 }), classification: classify(opConv({ id: 200 }), idx) },
      { conv: opConv({ id: 201 }), classification: classify(opConv({ id: 201 }), idx) },
      { conv: lbConv({ id: 300 }), classification: classify(lbConv({ id: 300 }), idx) },
    ];
    const plan = planConversationApply(classified);
    expect(plan.accepted_count).toBe(3);
    expect([...plan.conversationsByAccount.get(7)].sort((a,b)=>a-b)).toEqual([200, 201]);
    expect(plan.conversationsByAccount.get(8)).toEqual([300]);
  });

  test('matched_existing is skipped (FK already set)', () => {
    const idx = indexProviderAccounts([opAcct({ id: 7 })]);
    // Conv has provider_account_id=7 → matched_existing
    const conv = opConv({ id: 200, provider_account_id: 7 });
    const plan = planConversationApply([{ conv, classification: classify(conv, idx) }]);
    expect(plan.accepted_count).toBe(0);
    // Either already_set (the overwrite guard fires first) or matched_existing
    // bucket — either way it's skipped. Sum should be 1.
    const totalSkipped = plan.skipReasons.already_set + plan.skipReasons.matched_existing;
    expect(totalSkipped).toBe(1);
  });

  test('ambiguous is skipped', () => {
    const idx = indexProviderAccounts([opAcct({ id: 7 }), opAcct({ id: 8 })]);
    const plan = planConversationApply([{ conv: opConv({ id: 200 }), classification: classify(opConv({ id: 200 }), idx) }]);
    expect(plan.accepted_count).toBe(0);
    expect(plan.skipReasons.ambiguous).toBe(1);
  });

  test('unmatched_legacy is skipped', () => {
    const idx = indexProviderAccounts([]);
    const plan = planConversationApply([{ conv: opConv({ id: 200 }), classification: classify(opConv({ id: 200 }), idx) }]);
    expect(plan.accepted_count).toBe(0);
    expect(plan.skipReasons.unmatched_legacy).toBe(1);
  });

  test('unknown_provider is skipped', () => {
    const idx = indexProviderAccounts([]);
    const conv = opConv({ id: 200, provider: 'sendgrid', channel: 'email' });
    const plan = planConversationApply([{ conv, classification: classify(conv, idx) }]);
    expect(plan.accepted_count).toBe(0);
    expect(plan.skipReasons.unknown_provider).toBe(1);
  });

  test('non-null provider_account_id is NEVER accepted, regardless of bucket', () => {
    // Even if classifier says matched_inferred, the planner's overwrite
    // guard fires first because conv.provider_account_id is set.
    const idx = indexProviderAccounts([opAcct({ id: 7 })]);
    const conv = opConv({ id: 200, provider_account_id: 99 }); // pre-set to a DIFFERENT id
    const plan = planConversationApply([{ conv, classification: classify(conv, idx) }]);
    expect(plan.accepted_count).toBe(0);
    expect(plan.skipReasons.already_set).toBe(1);
    // Verify the planner did NOT add this id to any bucket.
    expect([...plan.conversationsByAccount.values()].flat()).not.toContain(200);
  });

  test('SKIP_BUCKETS exposes the spec-mandated skip set', () => {
    expect(SKIP_BUCKETS.has('matched_existing')).toBe(true);
    expect(SKIP_BUCKETS.has('ambiguous')).toBe(true);
    expect(SKIP_BUCKETS.has('unmatched_legacy')).toBe(true);
    expect(SKIP_BUCKETS.has('unknown_provider')).toBe(true);
  });

  test('APPLY_BUCKETS exposes the single accepted bucket', () => {
    expect([...APPLY_BUCKETS]).toEqual(['matched_inferred']);
  });

  test('skipped_count equals sum of skipReason values', () => {
    const idx = indexProviderAccounts([opAcct({ id: 7 }), opAcct({ id: 8 })]);
    const classified = [
      { conv: opConv({ id: 200, provider_account_id: 7 }), classification: classify(opConv({ id: 200, provider_account_id: 7 }), idx) },
      { conv: opConv({ id: 201 }), classification: classify(opConv({ id: 201 }), idx) }, // ambiguous
      { conv: opConv({ id: 202, provider: 'gmail', channel: 'email' }), classification: classify(opConv({ id: 202, provider: 'gmail', channel: 'email' }), idx) },
    ];
    const plan = planConversationApply(classified);
    expect(plan.skipped_count).toBe(3);
    const sum = Object.values(plan.skipReasons).reduce((a,b) => a+b, 0);
    expect(sum).toBe(plan.skipped_count);
  });
});

// ── generateBatchId / chunkIds ────────────────────────────────────

describe('generateBatchId', () => {
  test('matches expected shape', () => {
    const id = generateBatchId(new Date('2026-05-06T01:23:45Z'), () => 'abc123');
    expect(id).toBe('sab3b_20260506T012345_abc123');
    expect(id).toMatch(/^sab3b_[0-9TZ]+_[a-z0-9]{4,12}$/);
  });

  test('two calls in the same second produce different ids (random suffix)', () => {
    const a = generateBatchId();
    const b = generateBatchId();
    // Suffix is random — collision probability is tiny but nonzero. Re-run if it ever flakes.
    expect(a).not.toBe(b);
  });
});

describe('chunkIds', () => {
  test('chunks into bounded slices', () => {
    const ids = Array.from({ length: 1500 }, (_, i) => i + 1);
    const chunks = chunkIds(ids, 500);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toHaveLength(500);
    expect(chunks[2]).toHaveLength(500);
  });

  test('returns single chunk when size >= length', () => {
    expect(chunkIds([1, 2, 3], 500)).toEqual([[1, 2, 3]]);
  });

  test('respects custom size', () => {
    expect(chunkIds([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });
});

// ── buildBackfillSql ──────────────────────────────────────────────

describe('buildBackfillSql', () => {
  const batchId = 'sab3b_20260506T012345_abc123';
  const nowIso = '2026-05-06T01:23:45.678Z';

  test('conversations: sets FK + merges metadata, gated by IS NULL', () => {
    const sql = buildBackfillSql('conversations', 12, [100, 101, 102], batchId, nowIso);
    expect(sql).toMatch(/UPDATE public\.communication_conversations/);
    expect(sql).toMatch(/SET provider_account_id = 12/);
    expect(sql).toMatch(/COALESCE\(metadata, '\{\}'::jsonb\) \|\|/);
    expect(sql).toMatch(/source_account_backfill_batch_id.*sab3b_20260506T012345_abc123/);
    expect(sql).toMatch(/source_account_backfilled_at.*2026-05-06T01:23:45/);
    expect(sql).toMatch(/WHERE id = ANY\(ARRAY\[100,101,102\]::int\[\]\)/);
    // No-overwrite guard at SQL layer (belt + braces with planner)
    expect(sql).toMatch(/AND provider_account_id IS NULL;$/);
  });

  test('messages: keys on conversation_id', () => {
    const sql = buildBackfillSql('messages', 12, [100, 101], batchId, nowIso);
    expect(sql).toMatch(/UPDATE public\.communication_messages/);
    expect(sql).toMatch(/WHERE conversation_id = ANY\(ARRAY\[100,101\]::int\[\]\)/);
    expect(sql).toMatch(/AND provider_account_id IS NULL;$/);
  });

  test('calls: keys on conversation_id', () => {
    const sql = buildBackfillSql('calls', 12, [100], batchId, nowIso);
    expect(sql).toMatch(/UPDATE public\.communication_calls/);
    expect(sql).toMatch(/WHERE conversation_id = ANY\(ARRAY\[100\]::int\[\]\)/);
  });

  test('rejects non-positive accountId', () => {
    expect(() => buildBackfillSql('conversations', 0, [1], batchId, nowIso)).toThrow(/positive int/);
    expect(() => buildBackfillSql('conversations', -5, [1], batchId, nowIso)).toThrow(/positive int/);
    expect(() => buildBackfillSql('conversations', 'twelve', [1], batchId, nowIso)).toThrow(/positive int/);
  });

  test('rejects empty convIds (no all-rows update by accident)', () => {
    expect(() => buildBackfillSql('conversations', 12, [], batchId, nowIso)).toThrow(/non-empty/);
  });

  test('rejects non-integer ids (SQL-injection guard)', () => {
    expect(() => buildBackfillSql('conversations', 12, [1, 2, '3; DROP TABLE'], batchId, nowIso)).toThrow(/positive int/);
    expect(() => buildBackfillSql('conversations', 12, [1.5], batchId, nowIso)).toThrow(/positive int/);
  });

  test('rejects malformed batch id (SQL-injection guard)', () => {
    expect(() => buildBackfillSql('conversations', 12, [1], "'; DROP TABLE--", nowIso)).toThrow(/batchId shape/);
    expect(() => buildBackfillSql('conversations', 12, [1], 'random_string', nowIso)).toThrow(/batchId shape/);
  });

  test('rejects malformed nowIso', () => {
    expect(() => buildBackfillSql('conversations', 12, [1], batchId, 'yesterday')).toThrow(/ISO-8601/);
  });

  test('rejects unknown table', () => {
    expect(() => buildBackfillSql('users', 12, [1], batchId, nowIso)).toThrow(/unknown table/);
  });
});

// ── buildChildCountSql ────────────────────────────────────────────

describe('buildChildCountSql', () => {
  test('messages: counts unstamped child rows', () => {
    const sql = buildChildCountSql('messages', [100, 101]);
    expect(sql).toMatch(/SELECT COUNT\(\*\)::int AS n FROM public\.communication_messages/);
    expect(sql).toMatch(/WHERE conversation_id = ANY\(ARRAY\[100,101\]::int\[\]\) AND provider_account_id IS NULL;$/);
  });

  test('calls: counts unstamped child rows', () => {
    const sql = buildChildCountSql('calls', [100]);
    expect(sql).toMatch(/SELECT COUNT\(\*\)::int AS n FROM public\.communication_calls/);
    expect(sql).toMatch(/AND provider_account_id IS NULL;$/);
  });

  test('rejects empty array', () => {
    expect(() => buildChildCountSql('messages', [])).toThrow(/non-empty/);
  });

  test('rejects unknown table', () => {
    expect(() => buildChildCountSql('conversations', [1])).toThrow(/unknown table/);
  });
});

// ── buildRollbackSql ──────────────────────────────────────────────

describe('buildRollbackSql', () => {
  const batchId = 'sab3b_20260506T012345_abc123';

  test('emits 3 UPDATEs (messages, calls, conversations) keyed on metadata batch_id', () => {
    const sql = buildRollbackSql(batchId);
    expect(sql).toMatch(/UPDATE public\.communication_messages/);
    expect(sql).toMatch(/UPDATE public\.communication_calls/);
    expect(sql).toMatch(/UPDATE public\.communication_conversations/);
    const updateCount = (sql.match(/^UPDATE/gm) || []).length;
    expect(updateCount).toBe(3);
  });

  test('reverses provider_account_id and strips both metadata stamps', () => {
    const sql = buildRollbackSql(batchId);
    expect(sql).toMatch(/SET provider_account_id = NULL/);
    expect(sql).toMatch(/metadata - 'source_account_backfill_batch_id' - 'source_account_backfilled_at'/);
  });

  test('keys WHERE on the exact batch id', () => {
    const sql = buildRollbackSql(batchId);
    expect(sql).toMatch(new RegExp(`metadata->>'source_account_backfill_batch_id' = '${batchId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`));
  });

  test('rejects malformed batch id', () => {
    expect(() => buildRollbackSql("'; DROP TABLE--")).toThrow(/batchId shape/);
  });

  test('child tables come BEFORE parent so child rollbacks complete first', () => {
    // Order matters: messages/calls reverse first, then conversations.
    // Not strictly required (no FK cycle), but matches the apply order
    // and keeps rollback reasoning linear.
    const sql = buildRollbackSql(batchId);
    const msgIdx = sql.indexOf('UPDATE public.communication_messages');
    const callIdx = sql.indexOf('UPDATE public.communication_calls');
    const convIdx = sql.indexOf('UPDATE public.communication_conversations');
    expect(msgIdx).toBeLessThan(convIdx);
    expect(callIdx).toBeLessThan(convIdx);
  });
});

// ── CLI source-text invariants ────────────────────────────────────

describe('scripts/source-account-apply-backfill.js: invariants', () => {
  const scriptPath = path.join(__dirname, '..', 'scripts', 'source-account-apply-backfill.js');
  const src = fs.readFileSync(scriptPath, 'utf8');

  test('default mode is dry-run; --apply must be explicit', () => {
    expect(src).toMatch(/const APPLY = argv\.includes\('--apply'\)/);
  });

  test('dry-run wraps supabase to refuse non-select chain methods', () => {
    expect(src).toMatch(/refusing \$\{m\} on \$\{table\}/);
  });

  test('Management API write path only runs when APPLY is true', () => {
    // The mgmtSql call that does buildBackfillSql must be inside an
    // `if (APPLY)` branch. Strictly, the dry-run also calls mgmtSql for
    // SELECT count queries (by design — SELECT is read-only). What MUST
    // be APPLY-gated is the buildBackfillSql call that produces UPDATEs.
    const applyBlockMatch = src.match(/if \(APPLY\) \{[\s\S]*?\n  \}/);
    expect(applyBlockMatch).toBeTruthy();
    expect(applyBlockMatch[0]).toMatch(/buildBackfillSql/);
    // And the file must NOT call buildBackfillSql outside that block.
    const allBuildCalls = (src.match(/buildBackfillSql\(/g) || []).length;
    const applyBuildCalls = (applyBlockMatch[0].match(/buildBackfillSql\(/g) || []).length;
    expect(allBuildCalls).toBe(applyBuildCalls);
  });

  test('script never reads or writes communication_participant_identities', () => {
    // Phase 3B is explicitly NOT identity backfill.
    expect(src).not.toMatch(/communication_participant_identities/);
  });

  test('script never writes to hidden_at column', () => {
    // The header comment legitimately mentions hidden_at to document scope.
    // The test rejects only actual SQL or update payloads that touch it.
    expect(src).not.toMatch(/SET hidden_at/i);
    expect(src).not.toMatch(/hidden_at\s*[:=]/);
    expect(src).not.toMatch(/['"]hidden_at['"]\s*:/);
  });

  test('script does not read or write SOURCE_ACCOUNT_BOUNDARY_ENFORCED at runtime', () => {
    expect(src).not.toMatch(/process\.env\.SOURCE_ACCOUNT_BOUNDARY_ENFORCED/);
    expect(src).not.toMatch(/isEnabled\([^)]*SOURCE_ACCOUNT_BOUNDARY_ENFORCED/);
    expect(src).not.toMatch(/FLAGS\.SOURCE_ACCOUNT_BOUNDARY_ENFORCED/);
  });

  test('rollback SQL is included in the printed report', () => {
    expect(src).toMatch(/Rollback SQL/);
    expect(src).toMatch(/buildRollbackSql/);
  });

  test('apply path issues child UPDATEs BEFORE parent (matches rollback order)', () => {
    // Pull the apply branch and confirm messages + calls are stamped
    // before conversations.
    const applyBlockMatch = src.match(/if \(APPLY\) \{[\s\S]*?(?=  \/\/ ── Report)/);
    expect(applyBlockMatch).toBeTruthy();
    const block = applyBlockMatch[0];
    const msgIdx = block.indexOf("buildBackfillSql('messages'");
    const callIdx = block.indexOf("buildBackfillSql('calls'");
    const convIdx = block.indexOf("buildBackfillSql('conversations'");
    expect(msgIdx).toBeGreaterThan(-1);
    expect(callIdx).toBeGreaterThan(-1);
    expect(convIdx).toBeGreaterThan(-1);
    expect(msgIdx).toBeLessThan(convIdx);
    expect(callIdx).toBeLessThan(convIdx);
  });
});
