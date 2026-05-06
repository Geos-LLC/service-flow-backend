#!/usr/bin/env node
/**
 * Source-account boundary — Phase 3B: apply-mode backfill of
 * provider_account_id on existing conversations + messages + calls.
 *
 * Identities are explicitly out of scope.
 *
 * Usage:
 *   node scripts/source-account-apply-backfill.js
 *   node scripts/source-account-apply-backfill.js --apply
 *   node scripts/source-account-apply-backfill.js --user-id 42
 *   node scripts/source-account-apply-backfill.js --output report.json
 *   node scripts/source-account-apply-backfill.js --sample-size 25
 *
 * Default is dry-run (no writes). --apply must be passed explicitly.
 *
 * Hard guarantees:
 *   - Never overwrites a non-null provider_account_id (planner skips +
 *     emitted SQL has WHERE provider_account_id IS NULL).
 *   - Only matched_inferred conversations are updated. Ambiguous /
 *     unmatched_legacy / unknown_provider / matched_existing are skipped.
 *   - Identities are not touched.
 *   - hidden_at is not touched.
 *   - SOURCE_ACCOUNT_BOUNDARY_ENFORCED is not read or written.
 *   - Every write stamps metadata.source_account_backfill_batch_id so
 *     a single rollback SQL block reverses the entire batch.
 *
 * Writes go through the Supabase Management API (raw SQL) so the
 * provider_account_id assignment + metadata-merge stamp are atomic in
 * one statement. The Supabase JS client cannot express the jsonb || merge.
 *
 * See docs/security/source-account-boundary-plan.md.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const https = require('https');
const { createClient } = require('@supabase/supabase-js');

const {
  indexProviderAccounts,
  classifyConversation,
} = require('../lib/source-account-backfill');

const {
  planConversationApply,
  generateBatchId,
  buildBackfillSql,
  buildChildCountSql,
  buildRollbackSql,
  chunkIds,
} = require('../lib/source-account-apply');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://ezyhbvskbwmwgwyduqpt.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SUPABASE_PROJECT_REF = process.env.SUPABASE_PROJECT_REF || 'ezyhbvskbwmwgwyduqpt';
const SUPABASE_MGMT_TOKEN = process.env.SUPABASE_MGMT_TOKEN;

if (!SUPABASE_KEY) {
  console.error('SUPABASE_SERVICE_ROLE_KEY missing in env');
  process.exit(1);
}
if (!SUPABASE_MGMT_TOKEN) {
  console.error('SUPABASE_MGMT_TOKEN missing in env');
  console.error('Required: a Supabase Management API token (sbp_*). Used for raw-SQL UPDATEs');
  console.error('that need atomic jsonb || merges (the supabase-js client cannot express them).');
  console.error('Set SUPABASE_MGMT_TOKEN=sbp_... in your .env or shell.');
  process.exit(1);
}

const argv = process.argv.slice(2);
function getArg(name, fallback) {
  const i = argv.indexOf(name);
  if (i === -1 || i === argv.length - 1) return fallback;
  return argv[i + 1];
}

const APPLY = argv.includes('--apply');
const USER_ID = getArg('--user-id', null);
const OUTPUT_PATH = getArg('--output', null);
const SAMPLE_SIZE = parseInt(getArg('--sample-size', '10'), 10);
const CHUNK_SIZE = parseInt(getArg('--chunk-size', '500'), 10);

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ── Read-only Proxy for dry-run ────────────────────────────────────
//
// In dry-run, the supabase client is wrapped so any non-select op
// throws. Apply mode bypasses the wrapper. The Management API path
// (writes) only runs when APPLY is true — never in dry-run.
const supaForRead = APPLY ? supabase : new Proxy(supabase, {
  get(t, p) {
    if (p === 'from') {
      return (table) => {
        const chain = t.from(table);
        return new Proxy(chain, {
          get(t2, m) {
            if (m === 'insert' || m === 'update' || m === 'upsert' || m === 'delete') {
              throw new Error(`[DRY-RUN] refusing ${m} on ${table} — pass --apply to write`);
            }
            const v = t2[m];
            return typeof v === 'function' ? v.bind(t2) : v;
          },
        });
      };
    }
    return Reflect.get(t, p);
  },
});

// ── Management API helpers ─────────────────────────────────────────
//
// Used for raw-SQL UPDATE (apply mode) and child-row count (dry-run).
// SELECT/UPDATE results return as JSON. Errors throw.
function mgmtSql(sql) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ query: sql });
    const req = https.request({
      hostname: 'api.supabase.com',
      path: `/v1/projects/${SUPABASE_PROJECT_REF}/database/query`,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${SUPABASE_MGMT_TOKEN}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(data)); } catch { resolve(data); }
        } else {
          reject(new Error(`mgmtSql ${res.statusCode}: ${data.slice(0, 500)}`));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Pagination helpers ─────────────────────────────────────────────
async function paginatedSelect(client, table, columns, filterFn) {
  const PAGE = 1000;
  const out = [];
  let from = 0;
  for (;;) {
    let q = client.from(table).select(columns).range(from, from + PAGE - 1);
    if (filterFn) q = filterFn(q);
    const { data, error } = await q;
    if (error) throw new Error(`[${table}] ${error.message}`);
    if (!data || data.length === 0) break;
    out.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return out;
}

// ── Main ───────────────────────────────────────────────────────────
async function main() {
  console.error(`[Apply-Backfill] mode=${APPLY ? 'APPLY' : 'dry-run'}${USER_ID ? ` user_id=${USER_ID}` : ''}`);

  const accounts = await paginatedSelect(
    supaForRead, 'communication_provider_accounts',
    'id, user_id, provider, channel, external_account_id, external_business_id, status, metadata, display_name',
    USER_ID ? (q => q.eq('user_id', USER_ID)) : null
  );
  const accountIndex = indexProviderAccounts(accounts);
  console.error(`[Apply-Backfill] ${accounts.length} provider_accounts loaded`);

  const conversations = await paginatedSelect(
    supaForRead, 'communication_conversations',
    'id, user_id, provider, channel, endpoint_phone, external_business_id, external_lead_id, external_conversation_id, provider_account_id, participant_identity_id',
    USER_ID ? (q => q.eq('user_id', USER_ID)) : null
  );
  console.error(`[Apply-Backfill] ${conversations.length} conversations loaded`);

  const classified = conversations.map(conv => ({
    conv,
    classification: classifyConversation(conv, accountIndex),
  }));

  const plan = planConversationApply(classified);

  // For each (account, [convIds]) group, count child rows that would be
  // touched. Use Management API SELECT to mirror the apply-time WHERE.
  const childCounts = { messagesByAccount: new Map(), callsByAccount: new Map() };
  for (const [accountId, ids] of plan.conversationsByAccount) {
    let mTotal = 0;
    let cTotal = 0;
    for (const chunk of chunkIds(ids, CHUNK_SIZE)) {
      const mRes = await mgmtSql(buildChildCountSql('messages', chunk));
      const cRes = await mgmtSql(buildChildCountSql('calls', chunk));
      mTotal += (mRes[0]?.n || 0);
      cTotal += (cRes[0]?.n || 0);
    }
    childCounts.messagesByAccount.set(accountId, mTotal);
    childCounts.callsByAccount.set(accountId, cTotal);
  }

  // Sample IDs per account (capped) for the report.
  const sampleIdsByAccount = new Map();
  for (const [accountId, ids] of plan.conversationsByAccount) {
    sampleIdsByAccount.set(accountId, ids.slice(0, SAMPLE_SIZE));
  }

  // Generate batch id once; same id is used for the metadata stamp on every
  // updated row + the rollback block that the report prints.
  const batchId = generateBatchId();
  const nowIso = new Date().toISOString();
  const rollbackSql = buildRollbackSql(batchId);

  // Estimate totals.
  let messagesTotal = 0;
  let callsTotal = 0;
  for (const v of childCounts.messagesByAccount.values()) messagesTotal += v;
  for (const v of childCounts.callsByAccount.values()) callsTotal += v;

  // ── Apply (only with --apply) ─────────────────────────────────────
  let applyResults = null;
  if (APPLY) {
    applyResults = {
      batch_id: batchId,
      conversations_updated_by_account: {},
      messages_updated_by_account: {},
      calls_updated_by_account: {},
      conversations_updated_total: 0,
      messages_updated_total: 0,
      calls_updated_total: 0,
      errors: [],
    };

    for (const [accountId, ids] of plan.conversationsByAccount) {
      try {
        let conv = 0, msg = 0, call = 0;
        for (const chunk of chunkIds(ids, CHUNK_SIZE)) {
          // Count first (matches what we report, mirrors apply WHERE).
          const cConvRes = await mgmtSql(`SELECT COUNT(*)::int AS n FROM public.communication_conversations
WHERE id = ANY(ARRAY[${chunk.join(',')}]::int[]) AND provider_account_id IS NULL;`);
          const cMsgRes  = await mgmtSql(buildChildCountSql('messages', chunk));
          const cCallRes = await mgmtSql(buildChildCountSql('calls', chunk));
          const willConv = cConvRes[0]?.n || 0;
          const willMsg  = cMsgRes[0]?.n || 0;
          const willCall = cCallRes[0]?.n || 0;

          // Apply child tables FIRST so rollback can reason about them
          // independently if a later UPDATE fails. Idempotent regardless.
          await mgmtSql(buildBackfillSql('messages', accountId, chunk, batchId, nowIso));
          await mgmtSql(buildBackfillSql('calls', accountId, chunk, batchId, nowIso));
          await mgmtSql(buildBackfillSql('conversations', accountId, chunk, batchId, nowIso));

          conv += willConv;
          msg += willMsg;
          call += willCall;
        }
        applyResults.conversations_updated_by_account[accountId] = conv;
        applyResults.messages_updated_by_account[accountId] = msg;
        applyResults.calls_updated_by_account[accountId] = call;
        applyResults.conversations_updated_total += conv;
        applyResults.messages_updated_total += msg;
        applyResults.calls_updated_total += call;
      } catch (e) {
        applyResults.errors.push({ account_id: accountId, error: e.message });
      }
    }

    // Verification pass — count rows stamped with this batch id.
    const verify = await mgmtSql(`SELECT
      (SELECT COUNT(*)::int FROM public.communication_conversations WHERE metadata->>'source_account_backfill_batch_id' = '${batchId}') AS conv,
      (SELECT COUNT(*)::int FROM public.communication_messages WHERE metadata->>'source_account_backfill_batch_id' = '${batchId}') AS msg,
      (SELECT COUNT(*)::int FROM public.communication_calls WHERE metadata->>'source_account_backfill_batch_id' = '${batchId}') AS call;`);
    applyResults.verification = verify[0] || null;
  }

  // ── Report ───────────────────────────────────────────────────────
  const samples = {};
  for (const [accountId, ids] of sampleIdsByAccount) {
    samples[accountId] = ids;
  }

  const report = {
    generated_at: nowIso,
    mode: APPLY ? 'apply' : 'dry-run',
    scope: { user_id: USER_ID || 'all' },
    batch_id: batchId,
    plan: {
      accepted_conversations: plan.accepted_count,
      skipped: plan.skipReasons,
      conversations_by_account: Object.fromEntries(
        [...plan.conversationsByAccount].map(([k, v]) => [k, v.length])
      ),
      sample_conv_ids_by_account: samples,
      child_estimates: {
        messages_total: messagesTotal,
        calls_total: callsTotal,
        messages_by_account: Object.fromEntries(childCounts.messagesByAccount),
        calls_by_account: Object.fromEntries(childCounts.callsByAccount),
      },
    },
    apply_results: applyResults,
    rollback_sql: rollbackSql,
  };

  if (OUTPUT_PATH) {
    fs.writeFileSync(path.resolve(OUTPUT_PATH), JSON.stringify(report, null, 2));
    console.error(`[Apply-Backfill] report written to ${OUTPUT_PATH}`);
  }

  printSummary(report);
}

function printSummary(report) {
  console.log('');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  Source-Account Boundary — Phase 3B Apply Backfill');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`  Generated:  ${report.generated_at}`);
  console.log(`  Scope:      user_id=${report.scope.user_id}`);
  console.log(`  Mode:       ${report.mode}`);
  console.log(`  Batch ID:   ${report.batch_id}`);
  console.log('');
  console.log('  Plan:');
  console.log(`    Accepted conversations:        ${report.plan.accepted_conversations}`);
  console.log('    Skipped:');
  for (const [k, n] of Object.entries(report.plan.skipped)) {
    console.log(`      ${k.padEnd(22)} ${n}`);
  }
  console.log('');
  console.log('  Conversations by target account:');
  for (const [accId, n] of Object.entries(report.plan.conversations_by_account)) {
    console.log(`    account #${accId.padEnd(4)} ${n.toString().padStart(6)} convs`);
  }
  console.log('');
  console.log(`  Child rows that would be backfilled:`);
  console.log(`    Messages: ${report.plan.child_estimates.messages_total}`);
  console.log(`    Calls:    ${report.plan.child_estimates.calls_total}`);
  console.log('');
  console.log('  Sample conv IDs by account (capped):');
  for (const [accId, ids] of Object.entries(report.plan.sample_conv_ids_by_account)) {
    console.log(`    account #${accId}: ${ids.join(', ')}`);
  }
  console.log('');

  if (report.apply_results) {
    const a = report.apply_results;
    console.log('  Apply results:');
    console.log(`    Conversations updated: ${a.conversations_updated_total}`);
    console.log(`    Messages updated:      ${a.messages_updated_total}`);
    console.log(`    Calls updated:         ${a.calls_updated_total}`);
    console.log(`    Errors:                ${a.errors.length}`);
    if (a.verification) {
      console.log(`  Verification (rows stamped with this batch_id):`);
      console.log(`    conversations=${a.verification.conv} messages=${a.verification.msg} calls=${a.verification.call}`);
    }
    if (a.errors.length) {
      console.log('  Errors:');
      for (const e of a.errors) console.log(`    account=${e.account_id} ${e.error}`);
    }
    console.log('');
  }

  console.log('  Rollback SQL (run via Supabase Management API or psql):');
  console.log('  ─────────────────────────────────────────────────────────────');
  console.log(report.rollback_sql.split('\n').map(l => '  ' + l).join('\n'));
  console.log('  ─────────────────────────────────────────────────────────────');
  console.log('');

  console.log('═══════════════════════════════════════════════════════════════');
  if (report.mode === 'dry-run') {
    console.log('  No data written. Re-run with --apply to backfill.');
  } else {
    console.log('  Apply complete. Identities NOT touched.');
    console.log('  SOURCE_ACCOUNT_BOUNDARY_ENFORCED still OFF.');
    console.log('  Read paths unchanged.');
  }
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('');
}

main().catch(e => {
  console.error('[Apply-Backfill] failed:', e);
  process.exit(1);
});
