#!/usr/bin/env node
/**
 * One-off cleanup for the "processing-fee-treated-as-tip" incident
 * (Tatiana Larionova Jun 2026).
 *
 * Background:
 *   - resolveTip in lib/zenbooker-financial.js used to set jobs.tip_amount
 *     from the (amount_paid - subtotal - taxes - adjustment_total) overage
 *     whenever the ZB invoice carried adjustment fields. For merchants where
 *     the customer pays the processing fee but ZB does NOT record it in
 *     adjustment_total, that overage IS the processing fee — not a tip.
 *   - SF then created cleaner_ledger 'tip' rows that paid that "tip" to
 *     cleaners. Wrong.
 *
 * This script:
 *   1. Takes a list of job IDs (CLI flag --jobs=1,2,3) OR --user-id=N
 *      to scope to one user's affected jobs.
 *   2. For each job, fetches the matching ZB invoice and recomputes
 *      what tip_amount SHOULD be using the new resolveTip rules
 *      (explicit ZB tip only — no implicit overage detection).
 *   3. If the recomputed value differs from current jobs.tip_amount:
 *        - Updates jobs.tip_amount to the recomputed value.
 *        - Deletes any UNBATCHED cleaner_ledger 'tip' rows for that job.
 *          (Settled / payout_batch_id != null rows are left alone — they're
 *          history; create a §3.6 compensating adjustment if needed.)
 *   4. By default runs in --dry-run mode. Pass --apply to actually write.
 *
 * Usage:
 *   # Dry run for two specific jobs (Tatiana's reported case):
 *   railway run --service service-flow-backend --environment staging \
 *     node scripts/clear-processing-fee-tips.js --jobs=141997,142018
 *
 *   # Apply:
 *   railway run --service service-flow-backend --environment staging \
 *     node scripts/clear-processing-fee-tips.js --jobs=141997,142018 --apply
 */

'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { createClient } = require('@supabase/supabase-js');
const fetch = require('node-fetch');

const args = process.argv.slice(2);
function flag(name, def = null) {
  const m = args.find(a => a.startsWith(`--${name}=`));
  return m ? m.slice(name.length + 3) : def;
}
const APPLY = args.includes('--apply');
const JOBS_FLAG = flag('jobs', '');
const USER_ID_FLAG = flag('user-id', '');
const ZB_BASE = process.env.ZENBOOKER_API_URL || 'https://api.zenbooker.com/v1';

if (!JOBS_FLAG && !USER_ID_FLAG) {
  console.error('Pass --jobs=ID,ID,ID OR --user-id=N (and optionally --apply).');
  process.exit(2);
}
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY required.');
  process.exit(1);
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function fetchZbInvoice(apiKey, invoiceId) {
  const res = await fetch(`${ZB_BASE}/invoices/${invoiceId}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) throw new Error(`ZB /invoices/${invoiceId} → ${res.status}`);
  return res.json();
}

async function fetchZbJob(apiKey, zbJobId) {
  const res = await fetch(`${ZB_BASE}/jobs/${zbJobId}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) throw new Error(`ZB /jobs/${zbJobId} → ${res.status}`);
  return res.json();
}

async function getCorrectedTipFromZb(apiKey, zbJobId) {
  const zbJob = await fetchZbJob(apiKey, zbJobId);
  const inv = (zbJob && zbJob.invoice) || {};
  // Prefer explicit invoice fetch when we have an invoice id (richer fields).
  let merged = inv;
  if (inv.id) {
    try { merged = { ...inv, ...(await fetchZbInvoice(apiKey, inv.id)) }; } catch (_) { /* fall back */ }
  }
  const explicitTip = parseFloat(merged.tip != null ? merged.tip : merged.tip_amount);
  if (!isNaN(explicitTip) && explicitTip > 0) return { tip: explicitTip, source: 'explicit_zb' };
  return { tip: 0, source: 'no_explicit_tip' };
}

async function resolveJobIds() {
  if (JOBS_FLAG) return JOBS_FLAG.split(',').map(s => parseInt(s.trim(), 10)).filter(Boolean);
  // user-id mode: find all unbatched tip rows for that user and dedupe by job_id
  const { data } = await supabase
    .from('cleaner_ledger')
    .select('job_id')
    .eq('user_id', parseInt(USER_ID_FLAG, 10))
    .eq('type', 'tip')
    .is('payout_batch_id', null)
    .not('job_id', 'is', null);
  return [...new Set((data || []).map(r => r.job_id))];
}

(async () => {
  const jobIds = await resolveJobIds();
  if (jobIds.length === 0) { console.log('No jobs to inspect.'); return; }
  console.log(`Inspecting ${jobIds.length} job(s). Mode: ${APPLY ? 'APPLY' : 'DRY-RUN'}`);

  let cleared = 0, kept = 0, errored = 0;
  for (const jobId of jobIds) {
    try {
      const { data: job } = await supabase
        .from('jobs').select('id, user_id, zenbooker_id, tip_amount')
        .eq('id', jobId).maybeSingle();
      if (!job) { console.log(`  job ${jobId}: not found, skipping`); continue; }
      const { data: user } = await supabase
        .from('users').select('zenbooker_api_key').eq('id', job.user_id).single();
      if (!user?.zenbooker_api_key) { console.log(`  job ${jobId}: no ZB API key for user ${job.user_id}, skipping`); continue; }
      if (!job.zenbooker_id) { console.log(`  job ${jobId}: no zenbooker_id, skipping`); continue; }

      const { tip: correctedTip, source } = await getCorrectedTipFromZb(user.zenbooker_api_key, job.zenbooker_id);
      const currentTip = parseFloat(job.tip_amount) || 0;

      if (Math.abs(correctedTip - currentTip) < 0.01) {
        console.log(`  job ${jobId}: tip already correct (${currentTip}) [${source}] — no change`);
        kept++; continue;
      }

      console.log(`  job ${jobId}: current=${currentTip} → corrected=${correctedTip} [${source}]`);
      if (!APPLY) { cleared++; continue; }

      // Update the job's tip_amount
      const { error: upErr } = await supabase.from('jobs').update({ tip_amount: correctedTip }).eq('id', jobId);
      if (upErr) throw new Error(`jobs update: ${upErr.message}`);

      // Delete unbatched 'tip' rows for this job (settled rows protected)
      const { data: delRows, error: delErr } = await supabase
        .from('cleaner_ledger').delete()
        .eq('job_id', jobId).eq('type', 'tip').is('payout_batch_id', null)
        .select('id');
      if (delErr) throw new Error(`ledger delete: ${delErr.message}`);
      console.log(`    → updated jobs.tip_amount and deleted ${(delRows || []).length} unbatched tip ledger row(s)`);
      cleared++;
    } catch (e) {
      console.error(`  job ${jobId}: ERROR ${e.message}`);
      errored++;
    }
  }

  console.log(`\nDone. cleared=${cleared} kept=${kept} errored=${errored} ${APPLY ? '' : '(DRY-RUN — re-run with --apply to write)'}`);
})();
