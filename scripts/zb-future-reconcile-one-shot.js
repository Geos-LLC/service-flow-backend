#!/usr/bin/env node
/**
 * One-shot ZB future-job reconciliation runner.
 *
 * Wraps lib/zb-future-reconciler.js for operator-driven dry-run / apply runs
 * against a single tenant. Used to (a) verify the reconciler before flipping
 * the daily cron on, and (b) repair the Raquel-style silent-cancel cases
 * that ZB never webhooked us about.
 *
 * Usage:
 *   node scripts/zb-future-reconcile-one-shot.js --user-id=2 [--apply]
 *     [--lookahead-days=30] [--start-date=YYYY-MM-DD] [--end-date=YYYY-MM-DD]
 *     [--job-ids=142111,142222] [--zb-job-ids=1777899...,1779109...]
 *
 * Defaults:
 *   - dry-run (no writes) unless --apply is passed
 *   - lookahead = 30 days from now
 *
 * Env:
 *   SUPABASE_URL                 default https://ezyhbvskbwmwgwyduqpt.supabase.co
 *   SUPABASE_SERVICE_ROLE_KEY    required
 *
 * Exits non-zero on argument errors or unrecoverable failures. Per-job
 * failures are counted but never throw — full report is printed at the end.
 */

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { reconcileFutureJobs } = require('../lib/zb-future-reconciler');

function parseArgs() {
  const args = {};
  for (const arg of process.argv.slice(2)) {
    if (!arg.startsWith('--')) continue;
    const [k, v] = arg.slice(2).split('=');
    args[k] = v === undefined ? true : v;
  }
  return args;
}

async function main() {
  const args = parseArgs();
  const userId = parseInt(args['user-id'], 10);
  if (!Number.isFinite(userId) || userId <= 0) {
    console.error('--user-id=<integer> is required');
    process.exit(2);
  }
  const apply = !!args.apply;
  const lookaheadDays = args['lookahead-days']
    ? parseInt(args['lookahead-days'], 10) || 30
    : 30;
  const startDate = args['start-date'] || undefined;
  const endDate = args['end-date'] || undefined;
  const jobIdFilter = args['job-ids']
    ? String(args['job-ids']).split(',').map(s => parseInt(s.trim(), 10)).filter(Boolean)
    : undefined;
  const zenbookerIdFilter = args['zb-job-ids']
    ? String(args['zb-job-ids']).split(',').map(s => s.trim()).filter(Boolean)
    : undefined;

  const SUPABASE_URL = process.env.SUPABASE_URL || 'https://ezyhbvskbwmwgwyduqpt.supabase.co';
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_KEY) {
    console.error('SUPABASE_SERVICE_ROLE_KEY missing in env');
    process.exit(2);
  }
  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

  // Tenant lookup — confirm the user is ZB-connected and pull the api key.
  const { data: user, error: userErr } = await supabase
    .from('users')
    .select('id, zenbooker_api_key, zenbooker_status')
    .eq('id', userId)
    .maybeSingle();
  if (userErr) {
    console.error(`User lookup failed: ${userErr.message}`);
    process.exit(1);
  }
  if (!user) {
    console.error(`User ${userId} not found`);
    process.exit(1);
  }
  if (!user.zenbooker_api_key) {
    console.error(`User ${userId} has no zenbooker_api_key — not ZB-connected`);
    process.exit(1);
  }

  // Load zbFetch / updateJobStatus lazily — they aren't pure helpers; importing
  // server.js would boot the whole HTTP server, so we re-create a minimal
  // zbFetch and import updateJobStatus directly. Keeps this script standalone.
  const ZB_BASE = 'https://api.zenbooker.com/v1';
  const zbFetchFn = async (apiKey, path, params = {}) => {
    const url = new URL(`${ZB_BASE}${path}`);
    Object.entries(params).forEach(([k, v]) => {
      if (v !== undefined && v !== null) url.searchParams.set(k, v);
    });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    try {
      const res = await fetch(url.toString(), {
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        signal: controller.signal,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Zenbooker API ${res.status}: ${body}`);
      }
      return res.json();
    } finally {
      clearTimeout(timer);
    }
  };
  const { updateJobStatus } = require('../services/job-status-service');

  console.log(
    `[ZBFutureReconcile one-shot] userId=${userId} apply=${apply} ` +
    `lookahead=${lookaheadDays}d start=${startDate || 'now'} end=${endDate || `+${lookaheadDays}d`} ` +
    (jobIdFilter ? `jobIds=${jobIdFilter.join(',')} ` : '') +
    (zenbookerIdFilter ? `zbJobIds=${zenbookerIdFilter.join(',')} ` : '')
  );

  const { summary, changes } = await reconcileFutureJobs({
    supabase,
    userId,
    apiKey: user.zenbooker_api_key,
    dryRun: !apply,
    lookaheadDays,
    startDate,
    endDate,
    jobIdFilter,
    zenbookerIdFilter,
    logger: console,
    source: apply ? 'one_shot_apply' : 'one_shot_dryrun',
    zbFetchFn,
    updateJobStatusFn: updateJobStatus,
  });

  console.log('\n========== REPORT ==========');
  console.log(`Mode:    ${apply ? 'APPLY (writes)' : 'DRY-RUN (no writes)'}`);
  console.log(`User:    ${userId}`);
  console.log(`Summary: ${JSON.stringify(summary, null, 2)}`);
  if (changes.length > 0) {
    console.log(`\nChanges (${changes.length}):`);
    for (const c of changes) {
      console.log(
        `  - jobId=${c.jobId} zbJobId=${c.zbJobId} ${c.beforeStatus} → ${c.afterStatus}`
      );
    }
  } else {
    console.log('\nNo changes proposed.');
  }
  console.log('============================');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
