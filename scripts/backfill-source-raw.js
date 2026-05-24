#!/usr/bin/env node
/**
 * Two-field source attribution backfill (migration 050).
 *
 * Populates leads.source_raw for historical LB-ingested rows that were created
 * before the two-field attribution migration. Optionally retags leads.source
 * to the canonical mapped value when a lead_source_mappings entry exists for
 * the row's current raw source.
 *
 * Modes:
 *   DRY-RUN (default) — reports rows_to_update, mapped count, unmapped count,
 *                       affected source labels, before/after examples. Writes
 *                       NOTHING to the database.
 *   APPLY (--apply)   — performs the UPDATE in batches. Requires --user-id.
 *
 * Per-row policy:
 *   For each lead with source_raw IS NULL:
 *     1. Determine the raw label:
 *          - If source is an LB-shaped raw label ("X (thumbtack)" / "X (yelp)" /
 *            "leadbridge_thumbtack" / "leadbridge_yelp"): use existing source as raw
 *          - Else (non-LB source, e.g. OP / manual): treat source as raw too
 *     2. Look up canonical via lead_source_mappings (provider='leadbridge' first,
 *        then 'openphone' as fallback). Mapping is strictly user-scoped.
 *     3. If mapped: set source_raw=oldSource, source=canonical
 *        If unmapped: set source_raw=oldSource, source unchanged
 *
 * Hard invariants (never violated):
 *   - source_raw is never overwritten when already non-null
 *   - mapping lookups are user-scoped (no cross-tenant leakage)
 *   - never touches phone/identity/external_lead_id (status sync uses those)
 *
 * Usage:
 *   node scripts/backfill-source-raw.js                          # dry-run, all tenants
 *   node scripts/backfill-source-raw.js --user-id 2              # dry-run, single tenant
 *   node scripts/backfill-source-raw.js --user-id 2 --apply      # APPLY mode
 *   node scripts/backfill-source-raw.js --user-id 2 --output report.json
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const { classifyRow } = require('../lib/source-raw-backfill');

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
const sampleSize = parseInt(getArg('--sample-size', '10'), 10);

if (apply && !userIdFilter) {
  console.error('--apply requires --user-id <id>. Refusing to bulk-update across all tenants without explicit scope.');
  process.exit(2);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });

async function loadMappingsForUser(userId) {
  const out = { leadbridge: {}, openphone: {} };
  const { data } = await supabase.from('lead_source_mappings')
    .select('raw_value, source_name, provider')
    .eq('user_id', userId);
  for (const r of (data || [])) {
    if (!r.raw_value || !r.source_name) continue;
    const bucket = r.provider === 'leadbridge' ? out.leadbridge : out.openphone;
    bucket[r.raw_value.toLowerCase()] = r.source_name;
  }
  return out;
}

async function fetchLeadsNeedingBackfill(userId) {
  const PAGE = 500;
  const out = [];
  let lastId = 0;
  for (;;) {
    let q = supabase.from('leads')
      .select('id, user_id, source, source_raw')
      .is('source_raw', null)
      .gt('id', lastId)
      .order('id', { ascending: true })
      .limit(PAGE);
    if (userId) q = q.eq('user_id', userId);
    const { data, error } = await q;
    if (error) { console.error('fetchLeads error:', error.message); process.exit(3); }
    if (!data || data.length === 0) break;
    out.push(...data);
    lastId = data[data.length - 1].id;
    if (data.length < PAGE) break;
  }
  return out;
}

async function applyBatch(rows) {
  // Update one at a time for clear error attribution. Batch size is small
  // because of Supabase row-level update API constraints.
  let updated = 0;
  let failed = 0;
  let skipped = 0;
  for (const r of rows) {
    if (r.classification.action === 'noop') { skipped++; continue; }
    if (r.classification.new_source_raw == null) { skipped++; continue; } // nothing meaningful to preserve
    const patch = {
      source_raw: r.classification.new_source_raw,
      updated_at: new Date().toISOString(),
    };
    if (r.classification.action === 'remap_and_set_raw') {
      patch.source = r.classification.new_source;
    }
    const { error } = await supabase.from('leads')
      .update(patch)
      .eq('id', r.id)
      .is('source_raw', null); // defensive — never overwrite an already-set raw
    if (error) {
      failed++;
      console.warn(`  ❌ lead ${r.id}: ${error.message}`);
    } else {
      updated++;
    }
  }
  return { updated, failed, skipped };
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`Two-field source attribution backfill — ${apply ? 'APPLY' : 'DRY-RUN'}`);
  console.log(`  user_id filter: ${userIdFilter || '(all tenants)'}`);
  console.log(`  sample size:    ${sampleSize}`);
  console.log('═══════════════════════════════════════════════════════════════');

  const leads = await fetchLeadsNeedingBackfill(userIdFilter);
  console.log(`\nLeads with source_raw IS NULL: ${leads.length}`);
  if (leads.length === 0) {
    console.log('Nothing to do.');
    return;
  }

  // Group by user_id and load mappings per tenant.
  const userIds = [...new Set(leads.map(l => l.user_id))];
  console.log(`Distinct tenants:              ${userIds.length}`);

  const mappingsByUser = {};
  for (const uid of userIds) {
    mappingsByUser[uid] = await loadMappingsForUser(uid);
  }

  // Classify every row. Pass each row its OWN tenant's mappings — strictly
  // user-scoped so a stray mapping from tenant A cannot pollute tenant B.
  const classified = leads.map(l => ({
    ...l,
    classification: classifyRow(l, mappingsByUser[l.user_id]),
  }));

  // Aggregate.
  const counters = {
    total: classified.length,
    remap_and_set_raw: 0,
    set_raw_only: 0,
    noop: 0,
    by_reason: {},
    by_source_label: {},
    by_tenant: {},
  };
  for (const r of classified) {
    counters[r.classification.action] = (counters[r.classification.action] || 0) + 1;
    counters.by_reason[r.classification.reason] = (counters.by_reason[r.classification.reason] || 0) + 1;
    const label = r.source || '(null)';
    counters.by_source_label[label] = (counters.by_source_label[label] || 0) + 1;
    counters.by_tenant[r.user_id] = (counters.by_tenant[r.user_id] || 0) + 1;
  }

  // Report.
  console.log('\n── Action breakdown ───────────────────────────────────────────');
  console.log(`  remap_and_set_raw (source AND source_raw change):  ${counters.remap_and_set_raw}`);
  console.log(`  set_raw_only      (source_raw set, source kept):   ${counters.set_raw_only}`);
  console.log('\n── Reason breakdown ───────────────────────────────────────────');
  for (const [k, v] of Object.entries(counters.by_reason).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(v).padStart(6)}  ${k}`);
  }
  console.log('\n── Source labels affected ─────────────────────────────────────');
  const labels = Object.entries(counters.by_source_label).sort((a, b) => b[1] - a[1]);
  for (const [k, v] of labels.slice(0, 25)) {
    console.log(`  ${String(v).padStart(6)}  "${k}"`);
  }
  if (labels.length > 25) console.log(`  ... +${labels.length - 25} more labels`);

  console.log('\n── Per-tenant ─────────────────────────────────────────────────');
  for (const [k, v] of Object.entries(counters.by_tenant).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(v).padStart(6)}  user_id=${k}`);
  }

  // Examples (before/after).
  console.log(`\n── Sample (first ${sampleSize}) ─────────────────────────────────`);
  for (const r of classified.slice(0, sampleSize)) {
    const c = r.classification;
    const arrow = c.action === 'remap_and_set_raw' ? ' → ' : ' = ';
    console.log(`  lead ${r.id} (tenant ${r.user_id}):`);
    console.log(`    source:     "${r.source}"${arrow}"${c.new_source}"  [${c.reason}]`);
    console.log(`    source_raw: NULL → "${c.new_source_raw}"`);
  }

  if (outputPath) {
    const payload = { generated_at: new Date().toISOString(), mode: apply ? 'apply' : 'dry-run', counters, samples: classified.slice(0, 50) };
    fs.writeFileSync(path.resolve(outputPath), JSON.stringify(payload, null, 2));
    console.log(`\nFull report written to ${outputPath}`);
  }

  if (!apply) {
    console.log('\nDRY-RUN — nothing was written. Re-run with --apply --user-id <id> to apply.');
    return;
  }

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('APPLY MODE — writing updates in batches of 100');
  console.log('═══════════════════════════════════════════════════════════════');
  const BATCH = 100;
  let totalUpdated = 0;
  let totalFailed = 0;
  let totalSkipped = 0;
  for (let i = 0; i < classified.length; i += BATCH) {
    const slice = classified.slice(i, i + BATCH);
    const { updated, failed, skipped } = await applyBatch(slice);
    totalUpdated += updated;
    totalFailed += failed;
    totalSkipped += skipped;
    process.stdout.write(`  ${i + slice.length}/${classified.length} processed (updated=${totalUpdated} failed=${totalFailed} skipped=${totalSkipped})\r`);
  }
  console.log('\nDone.');
  console.log(`  Updated: ${totalUpdated}`);
  console.log(`  Skipped: ${totalSkipped}`);
  console.log(`  Failed:  ${totalFailed}`);
}

main().catch(e => { console.error(e); process.exit(1); });
