#!/usr/bin/env node
/* eslint-disable no-console */
'use strict';

// =====================================================================
// ZB historical cleanup — READ-ONLY classifier (Phase 1)
// =====================================================================
//
// Classifies SF jobs into safe_archive / safe_keep / manual_review /
// untouched_outside_scope buckets and emits JSON + CSV reports for
// operator review. NEVER mutates the database.
//
// Hard guards in this CLI:
//   - rejects --apply with exit 2
//   - REQUIRES explicit --user-id <int> for any classification run
//   - --tenant <alias> is DISCOVERY ONLY (lists candidates and exits)
//   - wraps supabase client to throw on any non-select op
//   - HARD_STOP if safe_archive count > MAX_ARCHIVE_ROWS (exit 3)
//
// Usage:
//   # Discovery — list candidates for an alias, then EXIT.
//   node scripts/zb-cleanup-classify.js --tenant spotless
//
//   # Classification — explicit user_id required.
//   node scripts/zb-cleanup-classify.js --user-id 2
//   node scripts/zb-cleanup-classify.js --user-id 2 \
//     --window-start 2026-03-01 --window-end 2026-04-01 \
//     --output-dir scripts/.tmp-zb-cleanup/zbc_X/ \
//     --max-archive-rows 10000 \
//     [--allow-large-batch] [--no-csv] [--sample-size 25]
//
// Exit codes:
//   0  success
//   1  error (env / supabase / runtime)
//   2  --apply was passed (this script never accepts it)
//   3  HARD_STOP: safe_archive exceeded threshold and --allow-large-batch
//      was not passed
//   4  ambiguous tenant or other operator-resolvable input issue

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const {
  CLASSIFIER_VERSION,
  classifyJob,
} = require('../lib/zb-cleanup/classifier');
const { detectWindow, bucketByDay } = require('../lib/zb-cleanup/window-detector');
const {
  discoverCandidates,
  loadUserById,
} = require('../lib/zb-cleanup/tenant-resolver');
const { rowsToCsv } = require('../lib/zb-cleanup/csv');
const { sha256OfFile } = require('../lib/zb-cleanup/checksums');
const { buildProvenance } = require('../lib/zb-cleanup/provenance');
const { wrapClient } = require('../lib/zb-cleanup/read-only-guard');

// ─── Hard guard: this script never accepts --apply ────────────────────
if (process.argv.includes('--apply')) {
  console.error('[zb-cleanup-classify] this is a READ-ONLY classifier.');
  console.error('--apply is not a flag this script accepts. Apply mode will');
  console.error('ship as a separate script after Phase 4 sign-off.');
  process.exit(2);
}

// ─── CLI parsing ──────────────────────────────────────────────────────
const argv = process.argv.slice(2);
function getArg(name, fallback) {
  const i = argv.indexOf(name);
  if (i === -1 || i === argv.length - 1) return fallback;
  return argv[i + 1];
}
function hasFlag(name) {
  return argv.includes(name);
}

const TENANT_ALIAS = getArg('--tenant', null);
const USER_ID_RAW = getArg('--user-id', null);
const WINDOW_START_OVERRIDE = getArg('--window-start', null);
const WINDOW_END_OVERRIDE = getArg('--window-end', null);
const OUTPUT_DIR_OVERRIDE = getArg('--output-dir', null);
const MAX_ARCHIVE_ROWS = parseInt(
  getArg(
    '--max-archive-rows',
    process.env.ZB_CLEANUP_MAX_ARCHIVE_ROWS || '10000',
  ),
  10,
);
const ALLOW_LARGE_BATCH = hasFlag('--allow-large-batch');
const SAMPLE_SIZE = parseInt(getArg('--sample-size', '25'), 10);
const NO_CSV = hasFlag('--no-csv');
const DRIFT_THRESHOLD_MS =
  parseInt(getArg('--drift-threshold-ms', String(60 * 60 * 1000)), 10);

// ─── Supabase client + READ_ONLY_GUARD ────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY env vars required');
  process.exit(1);
}

const rawClient = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false },
});

// Wrap the client so every .from(...) returns a builder where any
// non-select op throws. The guard semantics live in
// lib/zb-cleanup/read-only-guard.js for unit testability.
const supabase = wrapClient(rawClient);

// ─── Pagination helper ────────────────────────────────────────────────
async function paginatedSelect(table, columns, applyFilters) {
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

// ─── Batch-id ─────────────────────────────────────────────────────────
function makeBatchId() {
  const ts = new Date()
    .toISOString()
    .replace(/[-:.TZ]/g, '')
    .slice(0, 14); // yyyyMMddHHmmss
  const rand = crypto.randomBytes(3).toString('hex');
  return `zbc_${ts.slice(0, 8)}T${ts.slice(8)}_${rand}`;
}

// ─── Discovery mode ───────────────────────────────────────────────────
async function runDiscovery() {
  console.error(`[discovery] looking up alias '${TENANT_ALIAS}'`);
  const candidates = await discoverCandidates(supabase, TENANT_ALIAS);
  const out = {
    mode: 'discovery',
    classifier_version: CLASSIFIER_VERSION,
    alias: TENANT_ALIAS,
    candidates,
    next_step:
      candidates.merged_unique_user_ids.length === 0
        ? `No tenants matched '${TENANT_ALIAS}'. Refine the alias.`
        : `Re-run with explicit --user-id <id>. Discovery never auto-selects.`,
  };
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  return candidates.merged_unique_user_ids.length === 0 ? 4 : 0;
}

// ─── Classification mode ─────────────────────────────────────────────
async function runClassification(userId) {
  const batchId = makeBatchId();
  const outputDir =
    OUTPUT_DIR_OVERRIDE ||
    path.join(__dirname, '.tmp-zb-cleanup', batchId);
  fs.mkdirSync(outputDir, { recursive: true });
  console.error(`[classify] batch_id=${batchId}`);
  console.error(`[classify] output_dir=${outputDir}`);

  // ---- Tenant load (explicit id, not fuzzy) ---------------------------
  const tenant = await loadUserById(supabase, userId);
  console.error(
    `[classify] tenant user_id=${tenant.id} email=${tenant.email || '?'} business_name=${tenant.business_name || '?'}`,
  );

  // ---- Window detection -----------------------------------------------
  let windowStart;
  let windowEnd;
  let windowMeta;
  if (WINDOW_START_OVERRIDE && WINDOW_END_OVERRIDE) {
    windowStart = new Date(WINDOW_START_OVERRIDE).toISOString();
    windowEnd = new Date(WINDOW_END_OVERRIDE).toISOString();
    windowMeta = { autoDetected: false };
    console.error(`[classify] window override ${windowStart} → ${windowEnd}`);
  } else {
    console.error('[classify] auto-detecting import window...');
    // Pull the smallest possible projection — just created_at — for jobs
    // carrying any import signature. Restricted to tenant.
    const sigRows = await paginatedSelect(
      'jobs',
      'created_at, tags, contact_info',
      (q) => q.eq('user_id', tenant.id),
    );
    const importRows = sigRows.filter(
      (r) =>
        (Array.isArray(r.tags) && (r.tags.includes('imported') || r.tags.includes('booking-koala'))) ||
        (typeof r.tags === 'string' && /import/i.test(r.tags)) ||
        (r.contact_info && typeof r.contact_info === 'object' && r.contact_info.external_id),
    );
    const detected = detectWindow(importRows);
    if (!detected.ok) {
      console.error(
        `[classify] auto-detect failed: ${detected.reason} (candidate bursts: ${detected.candidateBurstCount})`,
      );
      console.error('  re-run with --window-start YYYY-MM-DD --window-end YYYY-MM-DD');
      return 4;
    }
    windowStart = detected.start;
    windowEnd = detected.end;
    windowMeta = {
      autoDetected: true,
      burstDensityMaxPerDay: detected.burstDensityMaxPerDay,
      burstTotalRows: detected.burstTotalRows,
    };
    console.error(`[classify] auto-detected window ${windowStart} → ${windowEnd}`);
  }

  // ---- Load candidate jobs --------------------------------------------
  console.error('[classify] loading candidate jobs...');
  const jobs = await paginatedSelect(
    'jobs',
    `id, user_id, customer_id, status, scheduled_date, created_at, updated_at,
     last_status_source, last_status_changed_at, cancelled_at, cancellation_fee,
     is_recurring, recurring_end_date,
     lb_external_request_id, lb_channel,
     zenbooker_id,
     payment_status, invoice_status,
     start_time, end_time, hours_worked, tip_amount, incentive_amount,
     total_amount, invoice_amount, service_price,
     tags, contact_info,
     customer:customers(id, first_name, last_name, phone, email)`,
    (q) =>
      q
        .eq('user_id', tenant.id)
        .gte('created_at', windowStart)
        .lt('created_at', windowEnd),
  );
  console.error(`[classify] loaded ${jobs.length} jobs in window`);

  // ---- Build lookups (paginated, scoped to tenant) -------------------
  console.error('[classify] building lookups...');
  const jobIds = jobs.map((j) => j.id);
  const customerIds = [
    ...new Set(jobs.map((j) => j.customer_id).filter((x) => x != null)),
  ];

  const lookups = await buildLookups(tenant.id, jobIds, customerIds);

  // Also need a tenant-wide customer-jobs-total count (for risk score and
  // some SAFE_KEEP rules). Cheap projected scan.
  const allTenantJobs = await paginatedSelect(
    'jobs',
    'id, customer_id',
    (q) => q.eq('user_id', tenant.id),
  );
  const customerJobsTotal = new Map();
  for (const r of allTenantJobs) {
    if (r.customer_id == null) continue;
    customerJobsTotal.set(
      r.customer_id,
      (customerJobsTotal.get(r.customer_id) || 0) + 1,
    );
  }
  lookups.customerJobsTotal = customerJobsTotal;

  // ---- Classify -------------------------------------------------------
  console.error('[classify] running classifier...');
  const buckets = {
    safe_archive: [],
    safe_keep: [],
    manual_review: [],
    untouched_outside_scope: [],
  };
  for (const job of jobs) {
    const result = classifyJob(job, lookups, {
      windowStart,
      windowEnd,
      driftThresholdMs: DRIFT_THRESHOLD_MS,
    });
    buckets[result.bucket].push({
      job_id: job.id,
      user_id: job.user_id,
      bucket: result.bucket,
      reasons: result.reasons,
      risk: result.risk,
      row: job,
    });
  }

  // ---- Manual review subgrouping (for CSVs) --------------------------
  const manualReview = buckets.manual_review;
  const csvData = NO_CSV
    ? null
    : buildManualReviewCsvData(manualReview, jobs, allTenantJobs, tenant.id);

  // ---- Threshold guard -----------------------------------------------
  const archiveCount = buckets.safe_archive.length;
  const warnings = [];
  let exitCode = 0;
  if (archiveCount > MAX_ARCHIVE_ROWS && !ALLOW_LARGE_BATCH) {
    warnings.push({
      level: 'HARD_STOP',
      code: 'safe_archive_exceeded_threshold',
      message: `safe_archive count ${archiveCount} > MAX_ARCHIVE_ROWS ${MAX_ARCHIVE_ROWS}. Re-run with --allow-large-batch to override.`,
      threshold: MAX_ARCHIVE_ROWS,
      observed: archiveCount,
    });
    exitCode = 3;
  } else if (archiveCount > MAX_ARCHIVE_ROWS && ALLOW_LARGE_BATCH) {
    warnings.push({
      level: 'WARN',
      code: 'safe_archive_exceeded_threshold_overridden',
      message: `safe_archive count ${archiveCount} > MAX_ARCHIVE_ROWS ${MAX_ARCHIVE_ROWS} — proceeding due to --allow-large-batch.`,
      threshold: MAX_ARCHIVE_ROWS,
      observed: archiveCount,
    });
  }

  // ---- Cascade preview (defensive — these MUST be 0 for safe_archive)
  const cascadePreview = {
    cleaner_ledger: countLookupHits(buckets.safe_archive, lookups.ledgerJobIds),
    job_status_history: countLookupHits(buckets.safe_archive, lookups.statusHistJobIds),
    payroll_edits: countLookupHits(buckets.safe_archive, lookups.payrollEditJobIds),
    transactions: countLookupHits(buckets.safe_archive, lookups.txJobIds),
    job_team_assignments: lookups.assignmentCountByJobId
      ? sumLookupCounts(buckets.safe_archive, lookups.assignmentCountByJobId)
      : null,
  };
  for (const [k, v] of Object.entries(cascadePreview)) {
    if (k === 'job_team_assignments') continue; // expected non-zero — assignments don't disqualify
    if (v && v > 0) {
      warnings.push({
        level: 'HARD_STOP',
        code: 'cascade_preview_invariant_violated',
        message: `safe_archive contains ${v} rows with non-empty ${k}. Classifier bug.`,
        table: k,
        count: v,
      });
      exitCode = exitCode === 3 ? 3 : 1;
    }
  }

  // ---- Write per-bucket JSON -----------------------------------------
  const fileMap = {
    'safe-archive.json': buckets.safe_archive,
    'safe-keep.json': buckets.safe_keep,
    'manual-review.json': buckets.manual_review,
    'untouched-outside-scope.json': buckets.untouched_outside_scope,
  };
  const checksums = {};
  for (const [name, data] of Object.entries(fileMap)) {
    const abs = path.join(outputDir, name);
    fs.writeFileSync(abs, JSON.stringify(data, null, 2));
    checksums[name] = sha256OfFile(abs);
    console.error(`[write] ${name} (${data.length} rows)`);
  }

  // ---- Write CSVs -----------------------------------------------------
  if (csvData) {
    for (const [name, payload] of Object.entries(csvData)) {
      const abs = path.join(outputDir, name);
      fs.writeFileSync(abs, rowsToCsv(payload.rows, payload.columns));
      checksums[name] = sha256OfFile(abs);
      console.error(`[write] ${name} (${payload.rows.length} rows)`);
    }
  }

  // ---- Build summary --------------------------------------------------
  const reasonsTop = (rows) => {
    const tally = new Map();
    for (const r of rows) for (const c of r.reasons || []) tally.set(c, (tally.get(c) || 0) + 1);
    return [...tally.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([code, n]) => ({ code, n }));
  };

  const provenance = await buildProvenance({
    supabase,
    supabaseUrl: SUPABASE_URL,
    backendRoot: path.join(__dirname, '..'),
    scriptPath: path.relative(path.join(__dirname, '..'), __filename),
    classifierVersion: CLASSIFIER_VERSION,
  });

  const summary = {
    batch_id: batchId,
    classifier_version: CLASSIFIER_VERSION,
    generated_at: new Date().toISOString(),
    mode: 'classification',
    tenant: {
      user_id: tenant.id,
      email: tenant.email,
      business_name: tenant.business_name,
      created_at: tenant.created_at,
    },
    import_window: {
      start: windowStart,
      end: windowEnd,
      ...windowMeta,
    },
    drift_threshold_ms: DRIFT_THRESHOLD_MS,
    threshold_guard: {
      max_archive_rows: MAX_ARCHIVE_ROWS,
      allow_large_batch: ALLOW_LARGE_BATCH,
    },
    totals: {
      all_jobs_for_tenant: allTenantJobs.length,
      in_import_window: jobs.length,
    },
    buckets: {
      safe_archive: { count: buckets.safe_archive.length, reasons_top: reasonsTop(buckets.safe_archive) },
      safe_keep: { count: buckets.safe_keep.length, reasons_top: reasonsTop(buckets.safe_keep) },
      manual_review: { count: buckets.manual_review.length, reasons_top: reasonsTop(buckets.manual_review) },
      untouched_outside_scope: {
        count: buckets.untouched_outside_scope.length,
        reasons_top: reasonsTop(buckets.untouched_outside_scope),
      },
    },
    cascade_preview_for_safe_archive: cascadePreview,
    manual_review_breakdown: csvData
      ? Object.fromEntries(
          Object.entries(csvData).map(([k, v]) => [k.replace(/\.csv$/, ''), v.rows.length]),
        )
      : null,
    risk_score_distribution_safe_archive:
      computeRiskDistribution(buckets.safe_archive),
    sample_rows: {
      safe_archive: buckets.safe_archive.slice(0, SAMPLE_SIZE),
      safe_keep: buckets.safe_keep.slice(0, SAMPLE_SIZE),
      manual_review: buckets.manual_review.slice(0, SAMPLE_SIZE),
    },
    output_files: Object.keys(checksums).map((name) => ({
      name,
      sha256: checksums[name],
      bytes: fs.statSync(path.join(outputDir, name)).size,
    })),
    provenance,
    warnings,
    next_steps: [
      'Operator reviews summary.json → buckets + warnings',
      'Operator reviews each MANUAL_REVIEW CSV',
      'Apply phase is a SEPARATE script — sign off required',
    ],
  };

  // ---- summary.json self-checksum (post-write) -----------------------
  const summaryAbs = path.join(outputDir, 'summary.json');
  fs.writeFileSync(summaryAbs, JSON.stringify(summary, null, 2));
  const summarySha = sha256OfFile(summaryAbs);
  // Append the self-hash as a sibling file rather than mutating summary.json
  // (keeps summary.json content stable for re-checksumming).
  fs.writeFileSync(
    path.join(outputDir, 'summary.json.sha256'),
    summarySha + '  summary.json\n',
  );
  console.error(`[write] summary.json (sha256 ${summarySha})`);

  // README for the directory
  fs.writeFileSync(
    path.join(outputDir, 'README.md'),
    buildReadme(batchId, summary),
  );

  // Print summary to stdout for piping (full content)
  process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
  return exitCode;
}

// ─── Lookup builder (read-only) ──────────────────────────────────────
async function buildLookups(tenantId, jobIds, customerIds) {
  // We chunk .in() filters at 500 to keep request sizes sane.
  const CHUNK = 500;
  const chunks = (arr) => {
    const out = [];
    for (let i = 0; i < arr.length; i += CHUNK) out.push(arr.slice(i, i + CHUNK));
    return out;
  };

  // cleaner_ledger split: any ledger rows AND batched-only subset
  const ledgerJobIds = new Set();
  const batchedLedgerJobIds = new Set();
  const unbatchedLedgerJobIds = new Set();
  for (const batch of chunks(jobIds)) {
    if (batch.length === 0) continue;
    const { data, error } = await supabase
      .from('cleaner_ledger')
      .select('job_id, payout_batch_id')
      .in('job_id', batch);
    if (error) throw new Error(`cleaner_ledger: ${error.message}`);
    for (const r of data || []) {
      ledgerJobIds.add(r.job_id);
      if (r.payout_batch_id != null) batchedLedgerJobIds.add(r.job_id);
      else unbatchedLedgerJobIds.add(r.job_id);
    }
  }

  const txJobIds = new Set();
  for (const batch of chunks(jobIds)) {
    if (batch.length === 0) continue;
    const { data, error } = await supabase
      .from('transactions')
      .select('job_id')
      .in('job_id', batch);
    if (error) throw new Error(`transactions: ${error.message}`);
    for (const r of data || []) txJobIds.add(r.job_id);
  }

  const statusHistJobIds = new Set();
  for (const batch of chunks(jobIds)) {
    if (batch.length === 0) continue;
    try {
      const { data, error } = await supabase
        .from('job_status_history')
        .select('job_id')
        .in('job_id', batch);
      if (error) throw error;
      for (const r of data || []) statusHistJobIds.add(r.job_id);
    } catch (e) {
      // Table may not exist in all envs — defensive skip.
      console.error(`[lookup] job_status_history skipped: ${e.message}`);
      break;
    }
  }

  const payrollEditJobIds = new Set();
  for (const batch of chunks(jobIds)) {
    if (batch.length === 0) continue;
    try {
      const { data, error } = await supabase
        .from('payroll_edits')
        .select('job_id')
        .in('job_id', batch);
      if (error) throw error;
      for (const r of data || []) payrollEditJobIds.add(r.job_id);
    } catch (e) {
      console.error(`[lookup] payroll_edits skipped: ${e.message}`);
      break;
    }
  }

  const cancellationExpenseJobIds = new Set();
  for (const batch of chunks(jobIds)) {
    if (batch.length === 0) continue;
    try {
      const { data, error } = await supabase
        .from('job_expenses')
        .select('job_id, expense_type')
        .in('job_id', batch)
        .eq('expense_type', 'cancellation');
      if (error) throw error;
      for (const r of data || []) cancellationExpenseJobIds.add(r.job_id);
    } catch (e) {
      console.error(`[lookup] job_expenses skipped: ${e.message}`);
      break;
    }
  }

  const lbOutboxJobIds = new Set();
  for (const batch of chunks(jobIds)) {
    if (batch.length === 0) continue;
    try {
      const { data, error } = await supabase
        .from('lb_outbound_outbox')
        .select('external_request_id')
        .in(
          'external_request_id',
          batch.map((id) => String(id)),
        );
      if (error) throw error;
      for (const r of data || []) lbOutboxJobIds.add(Number(r.external_request_id));
    } catch (e) {
      console.error(`[lookup] lb_outbound_outbox skipped: ${e.message}`);
      break;
    }
  }

  // Customer-scoped lookups
  const futureJobsByCustomer = new Set();
  const recurringParentByCustomer = new Set();
  for (const batch of chunks(customerIds)) {
    if (batch.length === 0) continue;
    const { data, error } = await supabase
      .from('jobs')
      .select('customer_id, scheduled_date, status, is_recurring, recurring_end_date')
      .eq('user_id', tenantId)
      .in('customer_id', batch);
    if (error) throw new Error(`jobs (customer scope): ${error.message}`);
    const today = new Date().toISOString().slice(0, 10);
    for (const r of data || []) {
      if (
        r.scheduled_date &&
        String(r.scheduled_date).slice(0, 10) >= today &&
        r.status !== 'cancelled'
      ) {
        futureJobsByCustomer.add(r.customer_id);
      }
      if (
        r.is_recurring === true &&
        (r.recurring_end_date == null ||
          String(r.recurring_end_date).slice(0, 10) >= today)
      ) {
        recurringParentByCustomer.add(r.customer_id);
      }
    }
  }

  const convsByCustomer = new Set();
  for (const batch of chunks(customerIds)) {
    if (batch.length === 0) continue;
    const { data, error } = await supabase
      .from('communication_conversations')
      .select('customer_id')
      .eq('user_id', tenantId)
      .in('customer_id', batch);
    if (error) throw new Error(`communication_conversations: ${error.message}`);
    for (const r of data || []) {
      if (r.customer_id != null) convsByCustomer.add(r.customer_id);
    }
  }

  // assignment counts (informational only; not a classifier blocker)
  const assignmentCountByJobId = new Map();
  for (const batch of chunks(jobIds)) {
    if (batch.length === 0) continue;
    const { data, error } = await supabase
      .from('job_team_assignments')
      .select('job_id')
      .in('job_id', batch);
    if (error) throw new Error(`job_team_assignments: ${error.message}`);
    for (const r of data || []) {
      assignmentCountByJobId.set(
        r.job_id,
        (assignmentCountByJobId.get(r.job_id) || 0) + 1,
      );
    }
  }

  return {
    ledgerJobIds,
    batchedLedgerJobIds,
    unbatchedLedgerJobIds,
    txJobIds,
    statusHistJobIds,
    payrollEditJobIds,
    cancellationExpenseJobIds,
    lbOutboxJobIds,
    futureJobsByCustomer,
    recurringParentByCustomer,
    convsByCustomer,
    assignmentCountByJobId,
  };
}

function countLookupHits(rows, set) {
  if (!set) return 0;
  let n = 0;
  for (const r of rows) if (set.has(r.job_id)) n++;
  return n;
}

function sumLookupCounts(rows, map) {
  if (!map) return 0;
  let n = 0;
  for (const r of rows) n += map.get(r.job_id) || 0;
  return n;
}

function computeRiskDistribution(safeArchive) {
  const dist = { high_confidence: 0, medium_confidence: 0, borderline: 0 };
  for (const r of safeArchive) {
    if (!r.risk) continue;
    dist[r.risk.band] = (dist[r.risk.band] || 0) + 1;
  }
  const scores = safeArchive
    .map((r) => (r.risk ? r.risk.score : null))
    .filter((s) => s != null)
    .sort((a, b) => a - b);
  return {
    bands: dist,
    score_min: scores[0] ?? null,
    score_p10: scores[Math.floor(scores.length * 0.1)] ?? null,
    score_median: scores[Math.floor(scores.length * 0.5)] ?? null,
    score_max: scores[scores.length - 1] ?? null,
  };
}

// ─── MANUAL_REVIEW CSV builders ──────────────────────────────────────
function stripPhone(p) {
  return (p || '').replace(/\D/g, '').slice(-10);
}

function buildManualReviewCsvData(manualReviewRows, allWindowJobs, allTenantJobs, tenantId) {
  // 1) duplicate phones — within tenant
  const phoneToCustomers = new Map();
  for (const j of allWindowJobs) {
    if (!j.customer || !j.customer.phone) continue;
    const k = stripPhone(j.customer.phone);
    if (!k) continue;
    if (!phoneToCustomers.has(k)) phoneToCustomers.set(k, new Map());
    phoneToCustomers.get(k).set(j.customer.id, {
      id: j.customer.id,
      name: [j.customer.first_name, j.customer.last_name].filter(Boolean).join(' '),
    });
  }
  const dupPhones = [];
  for (const [phone, custMap] of phoneToCustomers) {
    if (custMap.size < 2) continue;
    const ids = [...custMap.keys()];
    const names = [...custMap.values()].map((c) => c.name);
    const totalJobs = allTenantJobs.filter((j) => ids.includes(j.customer_id)).length;
    dupPhones.push({
      user_id: tenantId,
      phone_last10: phone,
      customer_count: custMap.size,
      customer_ids: ids,
      customer_names: names,
      total_jobs_in_cluster: totalJobs,
      last_activity_at: null,
    });
  }

  // 2) conflict mappings
  const conflictMappings = [];
  // external_id → many SF customers
  const extIdToJobs = new Map();
  for (const j of allWindowJobs) {
    const ext = j.contact_info && j.contact_info.external_id;
    if (!ext) continue;
    if (!extIdToJobs.has(ext)) extIdToJobs.set(ext, []);
    extIdToJobs.get(ext).push(j);
  }
  for (const [ext, jbs] of extIdToJobs) {
    const custs = [...new Set(jbs.map((j) => j.customer_id).filter(Boolean))];
    if (custs.length > 1) {
      conflictMappings.push({
        user_id: tenantId,
        conflict_type: 'external_id_to_many',
        key_value: ext,
        sf_customer_ids: custs,
        zenbooker_ids: [...new Set(jbs.map((j) => j.zenbooker_id).filter(Boolean))],
        sf_job_ids: jbs.map((j) => j.id),
        notes: '',
      });
    }
  }

  // 3) cross-account dups would require all-tenant scan; out-of-scope for
  // single-tenant run — emit empty file with header so operators see it
  // exists. (Multi-tenant variant ships when --tenant=ALL is supported.)
  const crossAccountDups = [];

  // 4) unusual states — derived from manual_review reason codes
  const UNUSUAL_CODES = new Set([
    'completed_with_cancelled_at',
    'total_without_service_price',
    'null_scheduled_date',
    'imported_outside_window',
    'orphan_ledger',
    'recurring_completed_no_chain',
    'lb_linked_but_status_source_null',
  ]);
  const unusualStates = manualReviewRows
    .filter((r) => r.reasons.some((c) => UNUSUAL_CODES.has(c)))
    .map((r) => ({
      job_id: r.job_id,
      user_id: r.user_id,
      status: r.row.status,
      anomaly_codes: r.reasons.filter((c) => UNUSUAL_CODES.has(c)),
      scheduled_date: r.row.scheduled_date,
      created_at: r.row.created_at,
      total_amount: r.row.total_amount,
      service_price: r.row.service_price,
      customer_id: r.row.customer_id,
      customer_name:
        r.row.customer
          ? [r.row.customer.first_name, r.row.customer.last_name].filter(Boolean).join(' ')
          : '',
      notes: '',
    }));

  // 5) partial LB linkage
  const partialLb = manualReviewRows
    .filter((r) => r.reasons.includes('partial_lb_linkage') || r.reasons.includes('lb_linked_but_status_source_null'))
    .map((r) => ({
      job_id: r.job_id,
      user_id: r.user_id,
      lb_external_request_id: r.row.lb_external_request_id,
      lb_channel: r.row.lb_channel,
      last_status_source: r.row.last_status_source,
      status: r.row.status,
      scheduled_date: r.row.scheduled_date,
      customer_id: r.row.customer_id,
      notes: '',
    }));

  return {
    'dup-phones.csv': {
      rows: dupPhones,
      columns: [
        'user_id',
        'phone_last10',
        'customer_count',
        'customer_ids',
        'customer_names',
        'total_jobs_in_cluster',
        'last_activity_at',
      ],
    },
    'conflict-mappings.csv': {
      rows: conflictMappings,
      columns: [
        'user_id',
        'conflict_type',
        'key_value',
        'sf_customer_ids',
        'zenbooker_ids',
        'sf_job_ids',
        'notes',
      ],
    },
    'cross-account-dups.csv': {
      rows: crossAccountDups,
      columns: [
        'phone_last10',
        'scheduled_date',
        'service_name',
        'user_ids',
        'job_ids',
        'customer_names',
        'statuses',
      ],
    },
    'unusual-states.csv': {
      rows: unusualStates,
      columns: [
        'job_id',
        'user_id',
        'status',
        'anomaly_codes',
        'scheduled_date',
        'created_at',
        'total_amount',
        'service_price',
        'customer_id',
        'customer_name',
        'notes',
      ],
    },
    'partial-lb-linkage.csv': {
      rows: partialLb,
      columns: [
        'job_id',
        'user_id',
        'lb_external_request_id',
        'lb_channel',
        'last_status_source',
        'status',
        'scheduled_date',
        'customer_id',
        'notes',
      ],
    },
  };
}

function buildReadme(batchId, summary) {
  return [
    `# ZB Cleanup Classifier Output — ${batchId}`,
    '',
    `Generated: ${summary.generated_at}`,
    `Classifier: ${summary.classifier_version}`,
    `Tenant: user_id=${summary.tenant.user_id} (${summary.tenant.business_name || summary.tenant.email || '?'})`,
    `Window: ${summary.import_window.start} → ${summary.import_window.end}`,
    '',
    '## Files',
    '- `summary.json` — totals, buckets, warnings, provenance, checksums',
    '- `summary.json.sha256` — self-hash for tamper detection',
    '- `safe-archive.json` — rows safe to soft-archive (Phase 4 input)',
    '- `safe-keep.json` — rows that must remain visible',
    '- `manual-review.json` — rows requiring human triage',
    '- `untouched-outside-scope.json` — rows the classifier excluded for audit',
    '- `dup-phones.csv` — duplicate-phone clusters within tenant',
    '- `conflict-mappings.csv` — ambiguous customer mappings',
    '- `cross-account-dups.csv` — empty in single-tenant runs',
    '- `unusual-states.csv` — anomalies for human triage',
    '- `partial-lb-linkage.csv` — half-linked LB rows',
    '',
    '## What this is NOT',
    '- This is **NOT** an apply step. No DB rows changed.',
    '- This is **NOT** authorization to archive. Phase 4 is a separate script.',
    '- Re-running produces a new batch_id — output is immutable per run.',
    '',
    '## Verification',
    'Re-compute SHA256 of any output file and compare against `summary.json.output_files[*].sha256`.',
  ].join('\n');
}

// ─── main ────────────────────────────────────────────────────────────
(async () => {
  try {
    if (TENANT_ALIAS && USER_ID_RAW == null) {
      const code = await runDiscovery();
      process.exit(code);
    }
    if (USER_ID_RAW == null) {
      console.error('Required: --user-id <int>   (or --tenant <alias> for discovery)');
      console.error('Discovery never auto-selects a tenant — explicit id required for classification.');
      process.exit(4);
    }
    const code = await runClassification(USER_ID_RAW);
    process.exit(code);
  } catch (e) {
    console.error('[zb-cleanup-classify] FATAL:', e.message);
    if (process.env.DEBUG) console.error(e.stack);
    process.exit(1);
  }
})();
