/**
 * Source-Account Boundary — Phase 2 dry-run report tests.
 *
 * Pins the classifier invariants and the report-builder shape. Also has
 * a static-source test that asserts the CLI script never writes (no
 * .insert/.update/.delete/.upsert calls in scripts/backfill-source-account-dry-run.js).
 *
 * No supabase round-trips here — pure logic + source-text scan.
 */

const fs = require('fs');
const path = require('path');

const {
  normalizePhone,
  indexProviderAccounts,
  classifyConversation,
  buildReport,
} = require('../lib/source-account-backfill');

// ── Test fixtures ────────────────────────────────────────────────

function lbAccount(over = {}) {
  return {
    id: 1, user_id: 42, provider: 'leadbridge', channel: 'thumbtack',
    external_account_id: 'acct-tt-1', external_business_id: 'biz-1',
    status: 'active', metadata: {}, ...over,
  };
}
function opAccount(over = {}) {
  return {
    id: 2, user_id: 42, provider: 'openphone', channel: 'openphone',
    external_account_id: 'PNm5YIDoXV', status: 'active',
    metadata: { phoneNumber: '+18139212100' }, ...over,
  };
}
function waAccount(over = {}) {
  return {
    id: 3, user_id: 42, provider: 'whatsapp', channel: 'whatsapp',
    external_account_id: '+18139212100', status: 'active', metadata: {}, ...over,
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
function waConv(over = {}) {
  return {
    id: 300, user_id: 42, provider: 'whatsapp', channel: 'whatsapp',
    endpoint_phone: '+18139212100', external_business_id: null,
    external_lead_id: null, external_conversation_id: null,
    provider_account_id: null, ...over,
  };
}

// ── classifyConversation ──────────────────────────────────────────

describe('classifyConversation: existing FK is never overwritten', () => {
  test('matched_existing when provider_account_id already set', () => {
    const idx = indexProviderAccounts([lbAccount({ id: 7, status: 'active' })]);
    const c = lbConv({ provider_account_id: 7 });
    const r = classifyConversation(c, idx);
    expect(r.bucket).toBe('matched_existing');
    expect(r.matched_account_id).toBe(7);
    expect(r.matched_account_status).toBe('active');
  });

  test('matched_existing carries disconnected status forward (still no overwrite)', () => {
    const idx = indexProviderAccounts([lbAccount({ id: 7, status: 'disconnected' })]);
    const c = lbConv({ provider_account_id: 7 });
    const r = classifyConversation(c, idx);
    expect(r.bucket).toBe('matched_existing');
    expect(r.matched_account_status).toBe('disconnected');
  });

  test('matched_existing with stale FK (account row deleted) reports null status, no crash', () => {
    const idx = indexProviderAccounts([]);
    const c = lbConv({ provider_account_id: 999 });
    const r = classifyConversation(c, idx);
    expect(r.bucket).toBe('matched_existing');
    expect(r.matched_account_id).toBe(999);
    expect(r.matched_account_status).toBeNull();
  });
});

describe('classifyConversation: LeadBridge inferred matching', () => {
  test('exactly 1 candidate by user+channel+business_id → matched_inferred', () => {
    const idx = indexProviderAccounts([lbAccount()]);
    const r = classifyConversation(lbConv(), idx);
    expect(r.bucket).toBe('matched_inferred');
    expect(r.matched_account_id).toBe(1);
  });

  test('multiple candidates → ambiguous (no auto-resolve)', () => {
    const idx = indexProviderAccounts([
      lbAccount({ id: 1 }),
      lbAccount({ id: 2 }),
    ]);
    const r = classifyConversation(lbConv(), idx);
    expect(r.bucket).toBe('ambiguous');
    expect(r.matched_account_id).toBeNull();
    expect(r.reason).toMatch(/2 candidates/);
  });

  test('no candidates → unmatched_legacy', () => {
    const idx = indexProviderAccounts([lbAccount({ external_business_id: 'biz-2' })]);
    const r = classifyConversation(lbConv(), idx);
    expect(r.bucket).toBe('unmatched_legacy');
  });

  test('LB conv with no external_business_id → unmatched_legacy', () => {
    const idx = indexProviderAccounts([lbAccount()]);
    const r = classifyConversation(lbConv({ external_business_id: null }), idx);
    expect(r.bucket).toBe('unmatched_legacy');
    expect(r.reason).toMatch(/no external_business_id/);
  });

  test('different channel does not match (yelp vs thumbtack)', () => {
    const idx = indexProviderAccounts([lbAccount({ channel: 'yelp' })]);
    const r = classifyConversation(lbConv({ channel: 'thumbtack' }), idx);
    expect(r.bucket).toBe('unmatched_legacy');
  });

  test('different user_id does not match', () => {
    const idx = indexProviderAccounts([lbAccount({ user_id: 99 })]);
    const r = classifyConversation(lbConv({ user_id: 42 }), idx);
    expect(r.bucket).toBe('unmatched_legacy');
  });
});

describe('classifyConversation: OpenPhone inferred matching', () => {
  test('exactly 1 PA matching endpoint_phone → matched_inferred', () => {
    const idx = indexProviderAccounts([opAccount()]);
    const r = classifyConversation(opConv(), idx);
    expect(r.bucket).toBe('matched_inferred');
    expect(r.matched_account_id).toBe(2);
  });

  test('OpenPhone normalizes 10-digit endpoint phone before lookup', () => {
    const idx = indexProviderAccounts([opAccount()]);
    const r = classifyConversation(opConv({ endpoint_phone: '8139212100' }), idx);
    expect(r.bucket).toBe('matched_inferred');
  });

  test('multiple PAs share the same number (rare) → ambiguous', () => {
    const idx = indexProviderAccounts([
      opAccount({ id: 2 }),
      opAccount({ id: 3 }),
    ]);
    const r = classifyConversation(opConv(), idx);
    expect(r.bucket).toBe('ambiguous');
  });

  test('no endpoint_phone → unmatched_legacy', () => {
    const idx = indexProviderAccounts([opAccount()]);
    const r = classifyConversation(opConv({ endpoint_phone: null }), idx);
    expect(r.bucket).toBe('unmatched_legacy');
    expect(r.reason).toMatch(/no endpoint_phone/);
  });

  test('OpenPhone NEVER matches by participant_phone alone (phone-only-guess guard)', () => {
    // No PA at all — even though the participant phone IS in the ecosystem,
    // we must never auto-attribute. Plan §9 rule: "Never guess on phone alone."
    const idx = indexProviderAccounts([]);
    const r = classifyConversation(opConv(), idx);
    expect(r.bucket).toBe('unmatched_legacy');
    expect(r.matched_account_id).toBeNull();
  });
});

describe('classifyConversation: WhatsApp inferred matching', () => {
  test('exactly 1 PA matching endpoint_phone → matched_inferred', () => {
    const idx = indexProviderAccounts([waAccount()]);
    const r = classifyConversation(waConv(), idx);
    expect(r.bucket).toBe('matched_inferred');
    expect(r.matched_account_id).toBe(3);
  });

  test('no PA → unmatched_legacy', () => {
    const idx = indexProviderAccounts([]);
    const r = classifyConversation(waConv(), idx);
    expect(r.bucket).toBe('unmatched_legacy');
  });
});

describe('classifyConversation: unknown providers', () => {
  test('email/sendgrid → unknown_provider', () => {
    const idx = indexProviderAccounts([]);
    const r = classifyConversation(opConv({ provider: 'sendgrid', channel: 'email' }), idx);
    expect(r.bucket).toBe('unknown_provider');
  });

  test('null provider → unknown_provider', () => {
    const idx = indexProviderAccounts([]);
    const r = classifyConversation(opConv({ provider: null }), idx);
    expect(r.bucket).toBe('unknown_provider');
  });
});

// ── buildReport ───────────────────────────────────────────────────

describe('buildReport: aggregation and would-hide accounting', () => {
  function fixture() {
    const idx = indexProviderAccounts([
      lbAccount({ id: 1, status: 'active' }),
      lbAccount({ id: 2, status: 'disconnected', external_business_id: 'biz-2' }),
      opAccount({ id: 3, status: 'active' }),
    ]);
    const convs = [
      lbConv({ id: 100, provider_account_id: 1 }),                           // matched_existing, active
      lbConv({ id: 101, provider_account_id: 2, external_business_id: 'biz-2' }), // matched_existing, disconnected
      lbConv({ id: 102, external_business_id: 'biz-1' }),                    // matched_inferred
      lbConv({ id: 103, external_business_id: 'biz-X' }),                    // unmatched_legacy
      opConv({ id: 200, endpoint_phone: '+18139212100' }),                   // matched_inferred
      opConv({ id: 201, endpoint_phone: '+15555555555' }),                   // unmatched_legacy
      opConv({ id: 202, provider: 'sendgrid', channel: 'email' }),           // unknown_provider
    ];
    return { idx, convs };
  }

  test('totals + bucket counts', () => {
    const { idx, convs } = fixture();
    const classified = convs.map(c => ({ conv: c, classification: classifyConversation(c, idx) }));
    const report = buildReport(classified);
    expect(report.total_conversations).toBe(7);
    expect(report.buckets.matched_existing).toBe(2);
    expect(report.buckets.matched_inferred).toBe(2);
    expect(report.buckets.unmatched_legacy).toBe(2);
    expect(report.buckets.unknown_provider).toBe(1);
    expect(report.buckets.ambiguous).toBe(0);
  });

  test('would_hide_when_enforced separates disconnected from legacy_unknown', () => {
    const { idx, convs } = fixture();
    const classified = convs.map(c => ({ conv: c, classification: classifyConversation(c, idx) }));
    const report = buildReport(classified);
    // 1 conv is matched_existing → disconnected account
    expect(report.would_hide_when_enforced.disconnected_account).toBe(1);
    // 2 unmatched_legacy + 1 unknown_provider = 3 legacy_unknown
    expect(report.would_hide_when_enforced.legacy_unknown_source).toBe(3);
    expect(report.would_hide_when_enforced.total).toBe(4);
  });

  test('apply_mode_propagation_estimate uses childCounts only for matched_inferred', () => {
    const { idx, convs } = fixture();
    const classified = convs.map(c => ({ conv: c, classification: classifyConversation(c, idx) }));
    const messagesByConvId = new Map([
      [100, 50],   // matched_existing — should NOT be counted
      [102, 8],    // matched_inferred — counted
      [103, 99],   // unmatched_legacy — should NOT be counted
      [200, 12],   // matched_inferred — counted
    ]);
    const callsByConvId = new Map([
      [102, 3],
      [200, 7],
    ]);
    const report = buildReport(classified, { messagesByConvId, callsByConvId });
    expect(report.apply_mode_propagation_estimate.child_messages_inheriting).toBe(20); // 8+12
    expect(report.apply_mode_propagation_estimate.child_calls_inheriting).toBe(10);    // 3+7
  });

  test('per-provider rollup', () => {
    const { idx, convs } = fixture();
    const classified = convs.map(c => ({ conv: c, classification: classifyConversation(c, idx) }));
    const report = buildReport(classified);
    expect(report.by_provider.leadbridge).toEqual({
      matched_existing: 2, matched_inferred: 1, ambiguous: 0,
      unmatched_legacy: 1, unknown_provider: 0,
    });
    expect(report.by_provider.openphone).toEqual({
      matched_existing: 0, matched_inferred: 1, ambiguous: 0,
      unmatched_legacy: 1, unknown_provider: 0,
    });
    expect(report.by_provider.sendgrid).toEqual({
      matched_existing: 0, matched_inferred: 0, ambiguous: 0,
      unmatched_legacy: 0, unknown_provider: 1,
    });
  });

  test('samples are capped at sampleSize per bucket', () => {
    const { idx } = fixture();
    const convs = Array.from({ length: 30 }, (_, i) =>
      lbConv({ id: 1000 + i, external_business_id: 'biz-X' }) // all unmatched_legacy
    );
    const classified = convs.map(c => ({ conv: c, classification: classifyConversation(c, idx) }));
    const report = buildReport(classified, {}, { sampleSize: 5 });
    expect(report.buckets.unmatched_legacy).toBe(30);
    expect(report.samples.unmatched_legacy).toHaveLength(5);
  });

  test('mode is always "dry-run"', () => {
    const report = buildReport([]);
    expect(report.mode).toBe('dry-run');
  });

  test('provider_accounts_status breakdown reflects opts.providerAccounts', () => {
    const accounts = [
      lbAccount({ status: 'active' }),
      lbAccount({ status: 'disconnected' }),
      lbAccount({ status: 'active' }),
      opAccount({ status: 'active' }),
    ];
    const report = buildReport([], {}, { providerAccounts: accounts });
    expect(report.provider_accounts_status['leadbridge/active']).toBe(2);
    expect(report.provider_accounts_status['leadbridge/disconnected']).toBe(1);
    expect(report.provider_accounts_status['openphone/active']).toBe(1);
  });
});

// ── Dry-run script invariants ─────────────────────────────────────

describe('scripts/backfill-source-account-dry-run.js: read-only invariants', () => {
  const scriptPath = path.join(__dirname, '..', 'scripts', 'backfill-source-account-dry-run.js');
  const src = fs.readFileSync(scriptPath, 'utf8');

  test('script does not call .insert(', () => {
    // .insert is the most common mutation in this codebase. Even an empty
    // dry-run must never make one.
    expect(src).not.toMatch(/\.insert\s*\(/);
  });

  test('script does not call .update(', () => {
    // Allow the literal word "update" in comments/strings ("apply mode will UPDATE..."),
    // but reject any actual method call that would trigger a write.
    expect(src).not.toMatch(/\.\s*update\s*\(/);
  });

  test('script does not call .upsert(', () => {
    expect(src).not.toMatch(/\.upsert\s*\(/);
  });

  test('script does not call .delete(', () => {
    expect(src).not.toMatch(/\.delete\s*\(/);
  });

  test('script rejects --apply explicitly', () => {
    // Hard guard: the CLI must refuse --apply with a non-zero exit so a
    // future contributor cannot bolt apply-mode onto this script.
    expect(src).toMatch(/--apply/);
    expect(src).toMatch(/process\.exit\(2\)/);
    expect(src).toMatch(/READ-ONLY/i);
  });

  test('READ_ONLY_GUARD blocks anything except "select"', () => {
    expect(src).toMatch(/READ_ONLY_GUARD\s*=\s*\(table,\s*op\)\s*=>/);
    expect(src).toMatch(/op\s*!==\s*'select'/);
  });
});

// ── normalizePhone — already covered in source-account.test.js but
// re-asserts the contract for the lib's own consumers.

describe('source-account-backfill: normalizePhone parity', () => {
  test('matches the helper contract (10-digit US → +1XXXXXXXXXX)', () => {
    expect(normalizePhone('8139212100')).toBe('+18139212100');
    expect(normalizePhone('+18139212100')).toBe('+18139212100');
    expect(normalizePhone(null)).toBeNull();
  });
});
