#!/usr/bin/env node
/**
 * Source-account boundary — Phase 2 dry-run report.
 *
 * READ-ONLY by design. Does not write to Supabase. Does not flip any
 * feature flag. Does not mark anything hidden.
 *
 * Usage:
 *   node scripts/backfill-source-account-dry-run.js
 *   node scripts/backfill-source-account-dry-run.js --user-id 42
 *   node scripts/backfill-source-account-dry-run.js --output report.json
 *   node scripts/backfill-source-account-dry-run.js --sample-size 25
 *
 * The script intentionally does NOT accept --apply. Phase 3 will add a
 * separate apply-mode CLI behind its own flag once this dry-run is reviewed.
 *
 * See docs/security/source-account-boundary-plan.md §9 and lib/source-account-backfill.js.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const {
  indexProviderAccounts,
  classifyConversation,
  buildReport,
} = require('../lib/source-account-backfill');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://ezyhbvskbwmwgwyduqpt.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_KEY) {
  console.error('SUPABASE_SERVICE_ROLE_KEY missing in env');
  process.exit(1);
}

// Hard guard: this script must never write. Any --apply flag is rejected
// loudly. Phase 3 will introduce a separate apply CLI, not bolt onto this one.
if (process.argv.includes('--apply')) {
  console.error('This is the Phase 2 DRY-RUN script. It does not accept --apply.');
  console.error('Apply mode will ship as a separate Phase 3 script after review.');
  process.exit(2);
}

const argv = process.argv.slice(2);
function getArg(name, fallback) {
  const i = argv.indexOf(name);
  if (i === -1 || i === argv.length - 1) return fallback;
  return argv[i + 1];
}

const USER_ID = getArg('--user-id', null);
const OUTPUT_PATH = getArg('--output', null);
const SAMPLE_SIZE = parseInt(getArg('--sample-size', '10'), 10);

// Use a read-only client wrapper. The Supabase client itself does not
// have a "read-only" mode, so we wall it off below: every method that
// would mutate is forbidden.
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const READ_ONLY_GUARD = (table, op) => {
  if (op !== 'select') {
    throw new Error(`[DRY-RUN GUARD] refusing ${op} on ${table} — Phase 2 is read-only`);
  }
};

// Pagination helper. Service Flow has been bitten by Supabase's 1000-row
// default limit (see Obsidian feedback_supabase_pagination.md), so every
// query in this script paginates explicitly.
async function paginatedSelect(table, columns, applyFilters) {
  READ_ONLY_GUARD(table, 'select');
  const PAGE = 1000;
  const out = [];
  let from = 0;
  for (;;) {
    let q = supabase.from(table).select(columns).range(from, from + PAGE - 1);
    if (applyFilters) q = applyFilters(q);
    const { data, error } = await q;
    if (error) throw new Error(`[${table}] ${error.message}`);
    if (!data || data.length === 0) break;
    out.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return out;
}

async function main() {
  console.error(`[DRY-RUN] starting Phase 2 source-account boundary report${USER_ID ? ` for user ${USER_ID}` : ''}`);

  // 1. Load every provider_account row first — small table, drives the index.
  const accounts = await paginatedSelect(
    'communication_provider_accounts',
    'id, user_id, provider, channel, external_account_id, external_business_id, status, metadata, display_name',
    USER_ID ? (q => q.eq('user_id', USER_ID)) : null
  );
  console.error(`[DRY-RUN] loaded ${accounts.length} provider_accounts rows`);
  const accountIndex = indexProviderAccounts(accounts);

  // 2. Load every conversation row. Project only what classifyConversation needs.
  const conversations = await paginatedSelect(
    'communication_conversations',
    'id, user_id, provider, channel, endpoint_phone, external_business_id, external_lead_id, external_conversation_id, provider_account_id, participant_identity_id',
    USER_ID ? (q => q.eq('user_id', USER_ID)) : null
  );
  console.error(`[DRY-RUN] loaded ${conversations.length} conversations`);

  const classified = conversations.map(conv => ({
    conv,
    classification: classifyConversation(conv, accountIndex),
  }));

  // 3. Child counts — only meaningful for conversations that would be
  //    inferred-stamped in apply mode. Skip the full-table scan if there
  //    are no inferred matches.
  const inferredConvIds = new Set(
    classified
      .filter(({ classification }) => classification.bucket === 'matched_inferred')
      .map(({ conv }) => conv.id)
  );

  const messagesByConvId = new Map();
  const callsByConvId = new Map();

  if (inferredConvIds.size > 0) {
    console.error(`[DRY-RUN] tallying child rows for ${inferredConvIds.size} would-be-stamped conversations`);
    // Pull message + call ids in chunks to keep the count down. Supabase
    // .in() caps at ~1000 so chunk to be safe.
    const ids = [...inferredConvIds];
    const CHUNK = 500;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const slice = ids.slice(i, i + CHUNK);
      const [{ data: msgs }, { data: calls }] = await Promise.all([
        supabase.from('communication_messages').select('conversation_id').in('conversation_id', slice),
        supabase.from('communication_calls').select('conversation_id').in('conversation_id', slice),
      ]);
      for (const m of (msgs || [])) {
        messagesByConvId.set(m.conversation_id, (messagesByConvId.get(m.conversation_id) || 0) + 1);
      }
      for (const c of (calls || [])) {
        callsByConvId.set(c.conversation_id, (callsByConvId.get(c.conversation_id) || 0) + 1);
      }
    }
  }

  // 4. Identity coverage — extra rollup for Open Decision A in the plan.
  //    Just counts how many identities currently have null provider_account_id.
  //    Identity reads are NOT proposed to be gated, so this is informational.
  const { count: identitiesNullFkCount } = await supabase
    .from('communication_participant_identities')
    .select('id', { count: 'exact', head: true })
    .is('provider_account_id', null);
  const { count: identitiesTotalCount } = await supabase
    .from('communication_participant_identities')
    .select('id', { count: 'exact', head: true });

  const report = buildReport(classified, { messagesByConvId, callsByConvId }, {
    sampleSize: SAMPLE_SIZE,
    providerAccounts: accounts,
  });

  report.scope = {
    user_id: USER_ID || 'all',
    provider_accounts_loaded: accounts.length,
  };
  report.identities = {
    total: identitiesTotalCount || 0,
    null_provider_account_id: identitiesNullFkCount || 0,
    note: 'Per plan §11 Open Decision A, identity reads are NOT proposed to be gated by source-account status. Reported for awareness only.',
  };

  // 5. Output
  if (OUTPUT_PATH) {
    fs.writeFileSync(path.resolve(OUTPUT_PATH), JSON.stringify(report, null, 2));
    console.error(`[DRY-RUN] report written to ${OUTPUT_PATH}`);
  }

  // Always print a human-readable summary to stdout.
  printSummary(report);
}

function printSummary(report) {
  console.log('');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  Source-Account Boundary — Phase 2 Dry-Run Report');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`  Generated: ${report.generated_at}`);
  console.log(`  Scope:     user_id=${report.scope.user_id}`);
  console.log(`  Mode:      ${report.mode}`);
  console.log('');
  console.log(`  Total conversations: ${report.total_conversations}`);
  console.log('');
  console.log('  Bucket breakdown:');
  for (const [b, n] of Object.entries(report.buckets)) {
    const pct = report.total_conversations === 0
      ? '  -- '
      : ((n / report.total_conversations) * 100).toFixed(1).padStart(5) + '%';
    console.log(`    ${pct}  ${n.toString().padStart(6)}  ${b}`);
  }
  console.log('');
  console.log('  By provider:');
  for (const [prov, b] of Object.entries(report.by_provider)) {
    const total = Object.values(b).reduce((a, c) => a + c, 0);
    console.log(`    ${prov.padEnd(15)} total=${total}  matched_existing=${b.matched_existing}  matched_inferred=${b.matched_inferred}  ambiguous=${b.ambiguous}  unmatched_legacy=${b.unmatched_legacy}  unknown_provider=${b.unknown_provider}`);
  }
  console.log('');
  console.log('  Provider account status:');
  for (const [k, n] of Object.entries(report.provider_accounts_status)) {
    console.log(`    ${k.padEnd(30)} ${n}`);
  }
  console.log('');
  console.log('  Would be hidden when enforcement enabled:');
  console.log(`    Disconnected-account rows:  ${report.would_hide_when_enforced.disconnected_account}`);
  console.log(`    Legacy-unknown rows:        ${report.would_hide_when_enforced.legacy_unknown_source}`);
  console.log(`    Total would-hide:           ${report.would_hide_when_enforced.total}`);
  console.log('');
  console.log('  Apply-mode propagation estimate (child rows that would inherit FK):');
  console.log(`    Messages:  ${report.apply_mode_propagation_estimate.child_messages_inheriting}`);
  console.log(`    Calls:     ${report.apply_mode_propagation_estimate.child_calls_inheriting}`);
  console.log('');
  console.log('  Identities (informational — not gated):');
  console.log(`    Total:                      ${report.identities.total}`);
  console.log(`    Without provider_account_id: ${report.identities.null_provider_account_id}`);
  console.log('');
  console.log('  Sample IDs per bucket (up to sampleSize):');
  for (const [b, samples] of Object.entries(report.samples)) {
    if (!samples.length) continue;
    console.log(`    ${b}:`);
    for (const s of samples) {
      console.log(`      conv=${s.id} user=${s.user_id} ${s.provider}/${s.channel} matched_account=${s.matched_account_id || '-'} (${s.matched_account_status || 'n/a'}) — ${s.reason}`);
    }
  }
  console.log('');
  if (report.hide_samples.disconnected.length) {
    console.log('  Sample disconnected-account hides:');
    for (const s of report.hide_samples.disconnected) {
      console.log(`    conv=${s.id} user=${s.user_id} ${s.provider} → account #${s.matched_account_id} (${s.status})`);
    }
    console.log('');
  }
  if (report.hide_samples.legacy_unknown.length) {
    console.log('  Sample legacy-unknown hides:');
    for (const s of report.hide_samples.legacy_unknown) {
      console.log(`    conv=${s.id} user=${s.user_id} ${s.provider}/${s.channel} — ${s.reason}`);
    }
    console.log('');
  }
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  No data was written. Phase 3 (apply mode) is a separate script.');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('');
}

main().catch(e => {
  console.error('[DRY-RUN] failed:', e);
  process.exit(1);
});
