#!/usr/bin/env node
/**
 * Source-account boundary — Phase 3A: retroactive provider-account
 * provisioning for existing OpenPhone + WhatsApp connections.
 *
 * Phase 1 only created `communication_provider_accounts` rows on
 * *new* connect. This script backfills rows for users who were
 * already connected before Phase 1 shipped, so the eventual
 * provider_account_id backfill (Phase 3B) has FK targets.
 *
 * Usage:
 *   node scripts/source-account-provision-provider-accounts.js
 *   node scripts/source-account-provision-provider-accounts.js --apply
 *   node scripts/source-account-provision-provider-accounts.js --user-id 42
 *   node scripts/source-account-provision-provider-accounts.js --output report.json
 *   node scripts/source-account-provision-provider-accounts.js --sample-size 25
 *
 * Default is dry-run: no writes. --apply must be passed explicitly.
 *
 * Hard guarantees:
 *   - LeadBridge accounts are NEVER created or modified by this script.
 *     The planner only emits OP + WA actions; the apply step calls only
 *     the OP/WA ensure helpers from lib/source-account.js.
 *   - Conversations / messages / calls / identities are NEVER touched
 *     in this phase. That is Phase 3B.
 *   - SOURCE_ACCOUNT_BOUNDARY_ENFORCED stays OFF; this script does not
 *     read or write the flag.
 *
 * See docs/security/source-account-boundary-plan.md.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const {
  planOpenPhoneAccountsForUser,
  planWhatsappAccountForUser,
  aggregatePlans,
} = require('../lib/source-account-provision');

const {
  ensureOpenPhoneProviderAccount,
  ensureWhatsappProviderAccount,
} = require('../lib/source-account');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://ezyhbvskbwmwgwyduqpt.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_KEY) {
  console.error('SUPABASE_SERVICE_ROLE_KEY missing in env');
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

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const silentLogger = { log: () => {}, warn: (m) => console.error('[ensure]', m), error: (m) => console.error('[ensure]', m) };

// ── Read-only guard for dry-run ────────────────────────────────────
//
// In dry-run mode we wrap supabase.from(table) so non-select chain
// methods throw. In --apply, the wrapper passes through and the
// OP/WA ensure helpers are allowed to write — but ONLY to OP/WA
// rows in communication_provider_accounts (the helpers themselves
// hard-code provider='openphone' / 'whatsapp').
const supaForPlanner = APPLY ? supabase : new Proxy(supabase, {
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

// Pagination helper.
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

async function main() {
  console.error(`[Provision] mode=${APPLY ? 'APPLY' : 'dry-run'}${USER_ID ? ` user_id=${USER_ID}` : ''}`);

  // 1. Load relevant communication_settings rows. Only currently-connected
  //    OP or WA. Disconnected settings are filtered at the source —
  //    the provisioner does NOT make assumptions about historical state.
  const settings = await paginatedSelect(
    supaForPlanner,
    'communication_settings',
    'user_id, openphone_connected, cached_phone_numbers, whatsapp_connected, whatsapp_phone_number',
    (q) => {
      let r = q;
      if (USER_ID) r = r.eq('user_id', USER_ID);
      // OR-condition for connected providers
      r = r.or('openphone_connected.eq.true,whatsapp_connected.eq.true');
      return r;
    }
  );
  console.error(`[Provision] loaded ${settings.length} connected communication_settings rows`);

  // 2. Load all OP + WA provider_accounts (skip LB entirely — never touched).
  const existingPaRows = await paginatedSelect(
    supaForPlanner,
    'communication_provider_accounts',
    'id, user_id, provider, channel, external_account_id, status, metadata',
    (q) => {
      let r = q;
      if (USER_ID) r = r.eq('user_id', USER_ID);
      return r.in('provider', ['openphone', 'whatsapp']);
    }
  );
  console.error(`[Provision] loaded ${existingPaRows.length} existing OP/WA provider_accounts`);
  const existingByUser = new Map();
  for (const r of existingPaRows) {
    const arr = existingByUser.get(r.user_id) || [];
    arr.push(r);
    existingByUser.set(r.user_id, arr);
  }

  // 3. Plan per user.
  const plans = [];
  for (const s of settings) {
    const userPa = existingByUser.get(s.user_id) || [];
    if (s.openphone_connected) {
      plans.push(...planOpenPhoneAccountsForUser(s.user_id, s.cached_phone_numbers || [], userPa));
    }
    if (s.whatsapp_connected) {
      plans.push(planWhatsappAccountForUser(s.user_id, s.whatsapp_phone_number, userPa));
    }
  }

  const planSummary = aggregatePlans(plans, { sampleSize: SAMPLE_SIZE });

  // 4. Apply (only when --apply).
  let applyResults = null;
  if (APPLY) {
    applyResults = { created: 0, reused: 0, errors: 0, error_samples: [] };
    for (const p of plans) {
      try {
        if (p.action === 'create_openphone' || p.action === 'reuse_openphone') {
          const id = await ensureOpenPhoneProviderAccount(supabase, silentLogger, p.user_id, {
            id: p.external_account_id, number: p.phoneNumber || p.phone_number, name: p.display_name,
          });
          if (!id) {
            applyResults.errors++;
            if (applyResults.error_samples.length < SAMPLE_SIZE) {
              applyResults.error_samples.push({ ...p, reason: 'ensureOpenPhoneProviderAccount returned null' });
            }
          } else if (p.action === 'create_openphone') {
            applyResults.created++;
          } else {
            applyResults.reused++;
          }
        } else if (p.action === 'create_whatsapp' || p.action === 'reuse_whatsapp') {
          const id = await ensureWhatsappProviderAccount(supabase, silentLogger, p.user_id, p.phone_number);
          if (!id) {
            applyResults.errors++;
            if (applyResults.error_samples.length < SAMPLE_SIZE) {
              applyResults.error_samples.push({ ...p, reason: 'ensureWhatsappProviderAccount returned null' });
            }
          } else if (p.action === 'create_whatsapp') {
            applyResults.created++;
          } else {
            applyResults.reused++;
          }
        }
        // skip_* actions are intentionally not applied.
      } catch (e) {
        applyResults.errors++;
        if (applyResults.error_samples.length < SAMPLE_SIZE) {
          applyResults.error_samples.push({ ...p, reason: e.message });
        }
      }
    }
  }

  const report = {
    generated_at: new Date().toISOString(),
    mode: APPLY ? 'apply' : 'dry-run',
    scope: { user_id: USER_ID || 'all' },
    settings_rows_scanned: settings.length,
    provider_accounts_loaded: existingPaRows.length,
    plan: planSummary,
    apply_results: applyResults,
  };

  if (OUTPUT_PATH) {
    fs.writeFileSync(path.resolve(OUTPUT_PATH), JSON.stringify(report, null, 2));
    console.error(`[Provision] report written to ${OUTPUT_PATH}`);
  }

  printSummary(report);
}

function printSummary(report) {
  console.log('');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  Source-Account Boundary — Phase 3A Provisioning');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`  Generated: ${report.generated_at}`);
  console.log(`  Scope:     user_id=${report.scope.user_id}`);
  console.log(`  Mode:      ${report.mode}`);
  console.log('');
  console.log(`  Connected settings rows scanned: ${report.settings_rows_scanned}`);
  console.log(`  Existing OP+WA provider_accounts: ${report.provider_accounts_loaded}`);
  console.log(`  Distinct users in plan:           ${report.plan.users_scanned}`);
  console.log('');
  console.log('  Plan counts:');
  for (const [k, n] of Object.entries(report.plan.counts)) {
    console.log(`    ${k.padEnd(20)} ${n.toString().padStart(6)}`);
  }
  console.log('');
  if (report.plan.inconsistencies.reactivations > 0) {
    console.log(`  Reactivations (existing row had non-active status):`);
    console.log(`    count: ${report.plan.inconsistencies.reactivations}`);
    for (const s of report.plan.inconsistencies.reactivation_samples) {
      console.log(`      user=${s.user_id} ${s.action} existing=#${s.existing_id} (${s.existing_status})`);
    }
    console.log('');
  }

  for (const [bucket, samples] of Object.entries(report.plan.samples)) {
    if (!samples.length) continue;
    console.log(`  ${bucket} samples:`);
    for (const s of samples) {
      const phone = s.phone_number || '-';
      const ext = s.external_account_id || '-';
      const exId = s.existing_id ? `existing=#${s.existing_id}` : '';
      const reason = s.reason ? ` — ${s.reason}` : '';
      console.log(`    user=${s.user_id} phone=${phone} ext=${ext} ${exId}${reason}`);
    }
    console.log('');
  }

  if (report.apply_results) {
    console.log('  Apply results:');
    console.log(`    created:      ${report.apply_results.created}`);
    console.log(`    reused:       ${report.apply_results.reused}`);
    console.log(`    errors:       ${report.apply_results.errors}`);
    if (report.apply_results.error_samples.length) {
      console.log('  Error samples:');
      for (const s of report.apply_results.error_samples) {
        console.log(`    user=${s.user_id} ${s.action} reason=${s.reason}`);
      }
    }
    console.log('');
  }

  console.log('═══════════════════════════════════════════════════════════════');
  if (report.mode === 'dry-run') {
    console.log('  No data was written. Re-run with --apply to provision.');
  } else {
    console.log('  Apply complete. No conversations/messages/calls were touched.');
    console.log('  SOURCE_ACCOUNT_BOUNDARY_ENFORCED still OFF.');
  }
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('');
}

main().catch(e => {
  console.error('[Provision] failed:', e);
  process.exit(1);
});
