#!/usr/bin/env node
/**
 * Audit: SF tip_amount vs ZB authoritative invoice.tip.
 *
 * Scope is the PAY-PERIOD DATE RANGE — every job whose 'tip' ledger entry
 * falls within [period_start, period_end] inclusive, regardless of whether
 * the entry has been attached to a payout batch yet (pending + paid alike).
 * Compares each job's SF tip_amount to what Zenbooker's /invoices/:id
 * endpoint actually shows.
 *
 * READ-ONLY. No DB writes, no ZB writes. Pure inspection.
 *
 * Required env:
 *   SUPABASE_MGMT_TOKEN   sbp_* token (see memory/reference_supabase_management_api.md)
 *   ZB_API_KEY            Zenbooker API key for the tenant under audit
 *
 * Flags:
 *   --user-id=<n>             tenant user_id (default: 2)
 *   --period-start=YYYY-MM-DD start of pay period (inclusive)
 *   --period-end=YYYY-MM-DD   end of pay period (inclusive)
 *   --batch-id=<n>            audit one cleaner_payout_batch.id (overrides period flags)
 *   --json                    print full JSON report instead of human summary
 *
 * Typical use:
 *   SUPABASE_MGMT_TOKEN=sbp_... ZB_API_KEY=... node scripts/audit-tip-misclassification.js \
 *     --period-start=2026-05-24 --period-end=2026-05-30
 */

'use strict';

const SUPABASE_PROJECT_REF = process.env.SUPABASE_PROJECT_REF || 'ezyhbvskbwmwgwyduqpt';
const SUPABASE_MGMT_TOKEN = process.env.SUPABASE_MGMT_TOKEN;
const ZB_API_KEY = process.env.ZB_API_KEY;
const ZB_BASE = 'https://api.zenbooker.com/v1';

if (!SUPABASE_MGMT_TOKEN) {
  console.error('SUPABASE_MGMT_TOKEN env var is required (sbp_*).');
  process.exit(2);
}
if (!ZB_API_KEY) {
  console.error('ZB_API_KEY env var is required.');
  process.exit(2);
}

function parseArgs(argv) {
  const args = {};
  for (const a of argv.slice(2)) {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    if (!m) continue;
    args[m[1]] = m[2] == null ? true : m[2];
  }
  return args;
}

async function runQuery(sql) {
  const url = `https://api.supabase.com/v1/projects/${SUPABASE_PROJECT_REF}/database/query`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${SUPABASE_MGMT_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query: sql }),
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  return res.json();
}

async function zbFetch(path) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const res = await fetch(`${ZB_BASE}${path}`, {
      headers: { 'Authorization': `Bearer ${ZB_API_KEY}`, 'Content-Type': 'application/json' },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`Zenbooker ${res.status}: ${await res.text().catch(() => '')}`);
    return res.json();
  } finally {
    clearTimeout(timer);
  }
}

function n(v) { const x = parseFloat(v); return Number.isFinite(x) ? x : 0; }
function close(a, b) { return Math.abs(a - b) < 0.005; }

(async () => {
  const args = parseArgs(process.argv);
  const userId = parseInt(args['user-id'] || '2', 10);
  const periodStart = args['period-start'];
  const periodEnd = args['period-end'];
  const batchId = args['batch-id'] ? parseInt(args['batch-id'], 10) : null;
  const asJson = !!args.json;

  let scopeClause;
  let scopeLabel;
  if (batchId) {
    scopeClause = `cl.payout_batch_id = ${batchId}`;
    scopeLabel = `batch_id=${batchId}`;
  } else if (periodStart && periodEnd) {
    // Pay-period date range: every tip ledger entry whose effective_date
    // lands in the window, batched or not.
    scopeClause = `cl.effective_date BETWEEN '${periodStart}' AND '${periodEnd}'`;
    scopeLabel = `pay-period ${periodStart} → ${periodEnd} (pending + paid)`;
  } else {
    console.error('Specify either --batch-id=<n> OR both --period-start and --period-end.');
    process.exit(2);
  }

  // One row per affected job — only completed jobs whose 'tip' ledger entries
  // landed in the audited period AND were already attached to a payout batch.
  const sql = `
    SELECT
      j.id                          AS job_id,
      j.zenbooker_id                AS zb_job_id,
      j.service_name,
      j.scheduled_date,
      j.status,
      j.payment_status,
      j.service_price::numeric(12,2)     AS sf_service_price,
      j.total_amount::numeric(12,2)      AS sf_total_amount,
      j.tip_amount::numeric(12,2)        AS sf_tip_amount,
      j.additional_fees::numeric(12,2)   AS sf_additional_fees,
      j.taxes::numeric(12,2)             AS sf_taxes,
      COALESCE(SUM(cl.amount), 0)::numeric(12,2) AS ledger_tip_total,
      ARRAY_AGG(DISTINCT cl.payout_batch_id ORDER BY cl.payout_batch_id) AS batch_ids
    FROM jobs j
    JOIN cleaner_ledger cl ON cl.job_id = j.id
    WHERE j.user_id = ${userId}
      AND cl.type = 'tip'
      AND ${scopeClause}
      AND j.zenbooker_id IS NOT NULL
    GROUP BY j.id, j.zenbooker_id, j.service_name, j.scheduled_date, j.status,
             j.payment_status, j.service_price, j.total_amount, j.tip_amount,
             j.additional_fees, j.taxes
    ORDER BY j.id DESC
  `;

  console.log(`# Tip audit — user_id=${userId}, scope=${scopeLabel}`);
  const candidates = await runQuery(sql);
  console.log(`Candidate jobs in scope: ${candidates.length}`);

  if (candidates.length === 0) {
    console.log('Nothing to audit. Done.');
    process.exit(0);
  }

  const findings = [];
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const sfTip = n(c.sf_tip_amount);
    const sfFee = n(c.sf_additional_fees);
    const sfTotal = n(c.sf_total_amount);
    const sfSub = n(c.sf_service_price);
    const sfTax = n(c.sf_taxes);
    const ledgerTip = n(c.ledger_tip_total);

    let zbTip = null;
    let zbAdj = null;
    let zbSub = null;
    let zbAmtPaid = null;
    let invoiceId = null;
    let error = null;
    try {
      const zbJob = await zbFetch(`/jobs/${c.zb_job_id}`);
      invoiceId = zbJob?.invoice?.id || null;
      if (invoiceId) {
        const inv = await zbFetch(`/invoices/${invoiceId}`);
        zbTip = n(inv.tip != null ? inv.tip : inv.tip_amount);
        zbAdj = n(inv.adjustment_total);
        zbSub = n(inv.subtotal);
        zbAmtPaid = n(inv.amount_paid);
      } else {
        error = 'no_invoice_id_on_zb_job';
      }
    } catch (e) {
      error = e.message.slice(0, 200);
    }

    let verdict;
    if (error) {
      verdict = 'ERROR';
    } else if (close(sfTip, zbTip)) {
      verdict = 'OK';
    } else if (sfTip > 0 && zbTip === 0 && close(sfTip, sfFee) && sfFee > 0) {
      verdict = 'BAD_FEE_AS_TIP';
    } else if (sfTip > 0 && zbTip === 0) {
      verdict = 'BAD_TIP_NO_ZB_TIP';
    } else if (sfTip > 0 && zbTip > 0) {
      verdict = 'MISMATCH';
    } else if (sfTip === 0 && zbTip > 0) {
      verdict = 'MISSING_TIP_IN_SF';
    } else {
      verdict = 'UNKNOWN';
    }

    findings.push({
      job_id: c.job_id,
      zb_job_id: c.zb_job_id,
      invoice_id: invoiceId,
      service: c.service_name,
      date: c.scheduled_date,
      status: c.status,
      payment_status: c.payment_status,
      batch_ids: c.batch_ids,
      sf: { tip: sfTip, fee: sfFee, subtotal: sfSub, total: sfTotal, taxes: sfTax },
      zb: { tip: zbTip, adjustment_total: zbAdj, subtotal: zbSub, amount_paid: zbAmtPaid },
      ledger_tip_paid_out: ledgerTip,
      verdict,
      error,
    });

    if ((i + 1) % 25 === 0) console.error(`  …processed ${i + 1}/${candidates.length}`);
  }

  if (asJson) {
    console.log(JSON.stringify({ scope: scopeLabel, user_id: userId, findings }, null, 2));
    return;
  }

  const byVerdict = findings.reduce((acc, f) => { (acc[f.verdict] ||= []).push(f); return acc; }, {});
  console.log('\n── Verdict summary ──');
  for (const v of Object.keys(byVerdict).sort()) {
    console.log(`  ${v.padEnd(22)} ${byVerdict[v].length}`);
  }

  const suspect = findings.filter(f => !['OK'].includes(f.verdict));
  if (suspect.length === 0) {
    console.log('\nAll audited jobs match ZB. No corrections needed.');
    return;
  }

  console.log(`\n── Suspect jobs (${suspect.length}) ──`);
  console.log('job_id | date       | verdict              | SF tip | ZB tip | SF fee | ZB adj | ledger paid | batches');
  console.log('-'.repeat(118));
  for (const f of suspect) {
    const dateStr = f.date ? String(f.date).slice(0, 10) : '—';
    const batches = (f.batch_ids || []).join(',');
    console.log(
      `${String(f.job_id).padEnd(6)} | ${dateStr} | ${f.verdict.padEnd(20)} | ` +
      `${String(f.sf.tip).padStart(6)} | ${String(f.zb.tip ?? '—').padStart(6)} | ` +
      `${String(f.sf.fee).padStart(6)} | ${String(f.zb.adjustment_total ?? '—').padStart(6)} | ` +
      `${String(f.ledger_tip_paid_out).padStart(11)} | ${batches}`
    );
    if (f.error) console.log(`        error: ${f.error}`);
  }

  const badFeeAsTip = (byVerdict.BAD_FEE_AS_TIP || []).reduce((s, f) => s + f.sf.tip, 0);
  const otherSuspect = suspect
    .filter(f => f.verdict !== 'BAD_FEE_AS_TIP' && f.verdict !== 'ERROR')
    .reduce((s, f) => s + f.sf.tip, 0);
  console.log(`\n  Σ SF tip on BAD_FEE_AS_TIP rows: $${badFeeAsTip.toFixed(2)}`);
  console.log(`  Σ SF tip on other suspect rows:  $${otherSuspect.toFixed(2)}`);
  console.log('\nRe-run with --json to get the structured report.');
})().catch((e) => {
  console.error('Audit failed:', e);
  process.exit(1);
});
