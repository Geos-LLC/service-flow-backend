#!/usr/bin/env node
/**
 * Repair leads.converted_customer_id projection for identities that have
 * both sf_lead_id AND sf_customer_id but whose lead is missing the
 * converted_customer_id pointer.
 *
 * Root cause: lib/identity-backfill.js historically wrote sf_customer_id
 * via a raw UPDATE that bypassed setIdentityCustomer (the only path that
 * triggers projectIdentityToCRM). Fix in identity-backfill.js +
 * lib/converted-customer-projection-repair.js (this module). This script
 * repairs the historic rows.
 *
 * Modes:
 *   DRY-RUN (default) — reports rows that would be projected. Writes nothing.
 *   APPLY (--apply)   — calls projectIdentityToCRM per row. Idempotent +
 *                       conflict-safe (never overwrites a lead already
 *                       converted to a different customer). Requires --user-id.
 *
 * Usage:
 *   node scripts/repair-converted-customer-projection.js                          # dry-run, all tenants
 *   node scripts/repair-converted-customer-projection.js --user-id 2              # dry-run, single tenant
 *   node scripts/repair-converted-customer-projection.js --user-id 2 --apply      # APPLY mode
 *   node scripts/repair-converted-customer-projection.js --user-id 2 --output report.json
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const { repairTenant } = require('../lib/converted-customer-projection-repair');

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
const userIdArg = getArg('--user-id', null);
const userIdFilter = userIdArg ? parseInt(userIdArg, 10) : null;
const apply = argv.includes('--apply');
const outputPath = getArg('--output', null);

if (apply && !userIdFilter) {
  console.error('--apply requires --user-id <id>. Refusing to bulk-update across all tenants without explicit scope.');
  process.exit(2);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });
const logger = console;

async function listTenants() {
  if (userIdFilter) return [userIdFilter];
  // Discover tenants with identities that could be candidates.
  const { data, error } = await supabase
    .from('communication_participant_identities')
    .select('user_id')
    .not('sf_lead_id', 'is', null)
    .not('sf_customer_id', 'is', null);
  if (error) throw new Error(error.message);
  return [...new Set((data || []).map(r => r.user_id))];
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`leads.converted_customer_id projection repair — ${apply ? 'APPLY' : 'DRY-RUN'}`);
  console.log(`  user_id filter: ${userIdFilter || '(all tenants)'}`);
  console.log('═══════════════════════════════════════════════════════════════');

  const tenants = await listTenants();
  console.log(`Tenants in scope: ${tenants.length}`);

  const results = [];
  for (const tid of tenants) {
    console.log(`\n── tenant ${tid} ──`);
    const summary = await repairTenant(supabase, logger, tid, { apply });
    results.push(summary);
    console.log(`  found:              ${summary.found}`);
    if (apply) {
      console.log(`  success:            ${summary.success}`);
      console.log(`  noop_idempotent:    ${summary.noop_idempotent}`);
      console.log(`  conflict (kept):    ${summary.conflict}`);
      console.log(`  data_missing:       ${summary.data_missing}`);
      console.log(`  frozen:             ${summary.frozen}`);
      console.log(`  cross_tenant_blkd:  ${summary.cross_tenant_blocked}`);
      console.log(`  errors:             ${summary.errors}`);
    } else {
      console.log(`  would-succeed:      ${summary.success}`);
      console.log(`  conflicts (kept):   ${summary.conflict}`);
    }
    if (summary.samples.length > 0) {
      console.log(`  samples (first ${Math.min(summary.samples.length, 5)}):`);
      for (const s of summary.samples.slice(0, 5)) {
        console.log(`    identity=${s.identity_id} lead=${s.sf_lead_id} customer=${s.sf_customer_id} status=${s.status || s.would_status}${s.current_converted_customer_id != null ? ` (existing=${s.current_converted_customer_id})` : ''}`);
      }
    }
  }

  if (outputPath) {
    fs.writeFileSync(path.resolve(outputPath), JSON.stringify({ generated_at: new Date().toISOString(), mode: apply ? 'apply' : 'dry-run', results }, null, 2));
    console.log(`\nFull report written to ${outputPath}`);
  }

  if (!apply) {
    console.log('\nDRY-RUN — nothing was written. Re-run with --apply --user-id <id> to apply.');
  } else {
    console.log('\nApply complete.');
  }
}

main().catch(e => { console.error(e); process.exit(1); });
