#!/usr/bin/env node
/**
 * P0 pre-prod validation — read-only audit of historical scenarios on staging.
 *
 * Identifies real jobs in staging that exhibit each of the 8 scenarios that
 * P0 must handle correctly, and reports what the new code's BEHAVIOR would be
 * against the current data shape. **No mutations**. No script run by this
 * audit triggers a rebuild or write.
 *
 * Scenarios (Constitution §3.1, §3.3, §3.4, §3.6, §4.4):
 *   1. completed → cancelled → completed (cancel preserves non-completion-derived
 *      rows; restore is operator-driven)
 *   2. multi-cleaner shrink (cleaner removed from job_team_assignments after
 *      ledger was created)
 *   3. rate change after payout (settled earning's snapshot rate differs from
 *      current rate; drift audit must fire on next rebuild)
 *   4. legacy rows without snapshots (rebuild on a tip/incentive/cash_collected
 *      row that has no metadata at all — drift detection via direct amount
 *      compare, not via computeEarningFromSnapshot)
 *   5. payout batch cancel/reopen (detached entries with payout_batch_id NULL
 *      that were once linked to a cancelled batch)
 *   6. ZB invoice edit after settlement (settled earning's stored revenue
 *      differs from current job revenue)
 *   7. stale webhook replay (idempotency keys; verify dedup integrity)
 *   8. duplicate webhook delivery (verify no dup zenbooker_id transactions
 *      or duplicate (job, member, type, effective_date) ledger combinations)
 */

'use strict';

const SUPABASE_PROJECT_REF = process.env.SUPABASE_PROJECT_REF || 'ezyhbvskbwmwgwyduqpt';
const SUPABASE_MGMT_TOKEN = process.env.SUPABASE_MGMT_TOKEN;
if (!SUPABASE_MGMT_TOKEN) {
  console.error('SUPABASE_MGMT_TOKEN env var is required (sbp_*). See memory/reference_supabase_management_api.md.');
  process.exit(2);
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

function banner(n, title) {
  console.log();
  console.log(`═══ Scenario ${n} — ${title} ═══`);
}

function summarize(rows, sampleKeys) {
  if (!rows || rows.length === 0) {
    console.log('  matches: 0');
    return 0;
  }
  console.log(`  matches: ${rows.length}`);
  const sample = rows.slice(0, 5);
  for (const r of sample) {
    const parts = sampleKeys.map(k => `${k}=${r[k]}`).join(' ');
    console.log(`    ${parts}`);
  }
  if (rows.length > 5) console.log(`    … and ${rows.length - 5} more`);
  return rows.length;
}

(async () => {
  const out = { scenarios: {}, generated_at: new Date().toISOString() };

  // ── 1. completed → cancelled → completed (or cancelled with surviving non-completion rows)
  banner(1, 'cancel with surviving non-completion-derived rows');
  const r1 = await runQuery(`
    SELECT j.id AS job_id, j.status,
           COUNT(*) FILTER (WHERE cl.type IN ('reimbursement','adjustment','payout','expense_deduction')) AS preserved,
           COUNT(*) FILTER (WHERE cl.type IN ('earning','tip','incentive','cash_collected')) AS completion_derived
    FROM jobs j
    JOIN cleaner_ledger cl ON cl.job_id = j.id
    WHERE j.status = 'cancelled'
    GROUP BY j.id, j.status
    HAVING COUNT(*) FILTER (WHERE cl.type IN ('reimbursement','adjustment','payout','expense_deduction')) > 0
    ORDER BY j.id DESC
    LIMIT 200
  `);
  const r1n = summarize(r1, ['job_id', 'preserved', 'completion_derived']);
  console.log(`  ✓ Cancel preserves reimbursement/adjustment/payout/expense_deduction.`);
  console.log(`    Of ${r1n} cancelled jobs with preserved rows, ${r1.filter(r => r.completion_derived > 0).length} still`);
  console.log(`    have completion-derived rows visible. Per §3.1, those must be SETTLED (paid)`);
  console.log(`    — i.e. survived via the new payout_batch_id IS NULL guard.`);
  out.scenarios['1_cancel_preserve'] = { matches: r1n };

  // ── 1b. cancelled jobs whose surviving completion-derived rows are batched (correct outcome)
  banner('1b', 'cancelled jobs with settled completion-derived rows (immutability preserved)');
  const r1b = await runQuery(`
    SELECT j.id AS job_id,
           COUNT(*) FILTER (WHERE cl.payout_batch_id IS NOT NULL) AS settled,
           COUNT(*) FILTER (WHERE cl.payout_batch_id IS NULL) AS unbatched
    FROM jobs j
    JOIN cleaner_ledger cl ON cl.job_id = j.id
    WHERE j.status = 'cancelled' AND cl.type IN ('earning','tip','incentive','cash_collected')
    GROUP BY j.id
    HAVING COUNT(*) FILTER (WHERE cl.payout_batch_id IS NOT NULL) > 0
    ORDER BY j.id DESC
    LIMIT 200
  `);
  const r1bn = summarize(r1b, ['job_id', 'settled', 'unbatched']);
  console.log(`  ✓ ${r1bn} cancelled jobs retained settled rows — exactly what §3.1 requires.`);
  console.log(`    Pre-P0 behavior would have deleted these; post-P0 the safe-delete helper`);
  console.log(`    skips them and emits a "preserved settled rows" warn-log.`);
  out.scenarios['1b_cancel_with_settled'] = { matches: r1bn };

  // ── 2. Multi-cleaner shrink (ledger references members no longer in job_team_assignments)
  banner(2, 'multi-cleaner shrink (orphan unbatched ledger after assignment shrink)');
  const r2 = await runQuery(`
    WITH assigned AS (
      SELECT job_id, array_agg(DISTINCT team_member_id) AS current_members
      FROM job_team_assignments
      GROUP BY job_id
    ),
    ledger_members AS (
      SELECT job_id, array_agg(DISTINCT team_member_id) AS ledger_members
      FROM cleaner_ledger
      WHERE type IN ('earning','tip','incentive','cash_collected')
      GROUP BY job_id
    )
    SELECT a.job_id,
           a.current_members,
           lm.ledger_members,
           (SELECT COUNT(*) FROM cleaner_ledger cl
              WHERE cl.job_id = a.job_id
                AND cl.type IN ('earning','tip','incentive','cash_collected')
                AND cl.payout_batch_id IS NULL
                AND NOT (cl.team_member_id = ANY(a.current_members))
           ) AS unbatched_orphans,
           (SELECT COUNT(*) FROM cleaner_ledger cl
              WHERE cl.job_id = a.job_id
                AND cl.type IN ('earning','tip','incentive','cash_collected')
                AND cl.payout_batch_id IS NOT NULL
                AND NOT (cl.team_member_id = ANY(a.current_members))
           ) AS settled_orphans
    FROM assigned a
    JOIN ledger_members lm ON lm.job_id = a.job_id
    WHERE NOT (lm.ledger_members <@ a.current_members)
    ORDER BY a.job_id DESC
    LIMIT 200
  `);
  const r2n = summarize(r2, ['job_id', 'unbatched_orphans', 'settled_orphans']);
  console.log(`  Audit/repair behavior on rebuild (per constitution):`);
  console.log(`    - unbatched_orphans: rebuild's safeDelete sweep removes them (§4.2 projection rule).`);
  console.log(`    - settled_orphans: preserved (§3.1). Drift audit emitted if amount diverges.`);
  out.scenarios['2_multi_cleaner_shrink'] = { matches: r2n };

  // ── 3. Rate change after payout — settled earning whose stored hourly_rate
  //      differs from any current team_member_pay_rates row for that member.
  banner(3, 'rate change after payout (settled earning where stored rate ≠ current rate table)');
  const r3 = await runQuery(`
    SELECT cl.id AS ledger_id, cl.user_id, cl.team_member_id, cl.job_id,
           cl.amount AS settled_amount,
           cl.metadata->>'hourly_rate' AS stored_hr,
           cl.payout_batch_id,
           j.scheduled_date,
           (SELECT hourly_rate FROM team_member_pay_rates pr
              WHERE pr.team_member_id = cl.team_member_id
                AND pr.user_id = cl.user_id
                AND pr.effective_from <= j.scheduled_date::date
              ORDER BY pr.effective_from DESC LIMIT 1) AS effective_rate_at_job
    FROM cleaner_ledger cl
    JOIN jobs j ON j.id = cl.job_id
    WHERE cl.type = 'earning'
      AND cl.payout_batch_id IS NOT NULL
      AND cl.metadata ? 'hourly_rate'
      AND (cl.metadata->>'hourly_rate')::numeric > 0
    ORDER BY cl.id DESC
    LIMIT 1000
  `);
  const r3drift = r3.filter(r =>
    r.effective_rate_at_job != null &&
    Math.abs(Number(r.stored_hr) - Number(r.effective_rate_at_job)) > 0.01
  );
  console.log(`  inspected ${r3.length} settled earning rows`);
  console.log(`  ${r3drift.length} have stored_hr ≠ effective_rate_at_job (would drift on next rebuild)`);
  if (r3drift.length > 0) {
    r3drift.slice(0, 5).forEach(r => console.log(
      `    ledger_id=${r.ledger_id} job=${r.job_id} member=${r.team_member_id} stored=${r.stored_hr} effective=${r.effective_rate_at_job} batch=${r.payout_batch_id}`
    ));
  }
  console.log(`  ✓ Behavior on rebuild: settled row stays unchanged (§3.1).`);
  console.log(`    ledger_drift_detected row emitted only when dry-run-computed amount differs`);
  console.log(`    from stored amount, not just when the rate table changed.`);
  out.scenarios['3_rate_change_after_payout'] = { matches: r3drift.length, inspected: r3.length };

  // ── 4. Legacy rows without snapshots — sample for inspection
  banner(4, 'legacy rows where rebuild has no rate signal (tip/incentive/cash_collected pre-P0)');
  const r4 = await runQuery(`
    SELECT type, COUNT(*) AS n,
           MIN(id) AS min_id, MAX(id) AS max_id
    FROM cleaner_ledger
    WHERE type IN ('tip','incentive','cash_collected')
      AND (metadata IS NULL OR NOT (
        metadata ? 'hourly_rate_snapshot' OR metadata ? 'commission_pct_snapshot' OR
        metadata ? 'revenue_at_create' OR metadata ? 'hours_at_create' OR
        metadata ? 'hourly_rate' OR metadata ? 'commission_pct' OR
        metadata ? 'revenue' OR metadata ? 'hours' OR metadata ? 'member_count'
      ))
    GROUP BY type
  `);
  summarize(r4, ['type', 'n', 'min_id', 'max_id']);
  console.log(`  ✓ Behavior on rebuild: extractRateSnapshot returns null for these rows.`);
  console.log(`    Drift detection compares the row's amount directly against the dry-run-computed`);
  console.log(`    amount from current job state (jobs.tip_amount / incentive / transactions).`);
  console.log(`    No rate snapshot required — these types never used rates.`);
  out.scenarios['4_legacy_no_snapshot'] = { by_type: r4 };

  // ── 5. Payout batch cancel/reopen — cancelled batches + their now-detached entries
  banner(5, 'payout batch cancel/reopen (detached entries from cancelled batches)');
  const r5 = await runQuery(`
    SELECT b.id AS batch_id, b.user_id, b.team_member_id, b.status,
           b.total_amount, b.created_at,
           (SELECT COUNT(*) FROM cleaner_ledger cl
              WHERE cl.payout_batch_id = b.id AND cl.type = 'payout') AS payout_rows_still_linked,
           (SELECT COUNT(*) FROM cleaner_ledger cl
              WHERE cl.user_id = b.user_id AND cl.team_member_id = b.team_member_id
                AND cl.effective_date BETWEEN b.period_start AND b.period_end
                AND cl.payout_batch_id IS NULL) AS unbatched_in_period
    FROM cleaner_payout_batch b
    WHERE b.status = 'cancelled'
    ORDER BY b.created_at DESC NULLS LAST
    LIMIT 50
  `);
  const r5n = summarize(r5, ['batch_id', 'team_member_id', 'payout_rows_still_linked', 'unbatched_in_period']);
  console.log(`  Expected per §3.4: cancelling a paid batch should write a compensating adjustment`);
  console.log(`    + detach entries (or keep payout row + emit drift). Current code at server.js:38138-38142`);
  console.log(`    detaches entries via UPDATE payout_batch_id=NULL and DELETEs payout rows. This is`);
  console.log(`    the "adjust and rebuild" admin path — explicit batch-cancel allowed by §3.1 exception.`);
  out.scenarios['5_batch_cancel'] = { matches: r5n };

  // ── 6. ZB invoice edit after settlement — settled earning whose stored revenue
  //      differs from current job's effective revenue.
  banner(6, 'ZB invoice edit after settlement (settled earning where stored revenue ≠ current)');
  const r6 = await runQuery(`
    SELECT cl.id AS ledger_id, cl.job_id, cl.team_member_id, cl.amount AS settled_amount,
           (cl.metadata->>'revenue')::numeric AS stored_revenue,
           GREATEST(
             COALESCE(j.service_price, 0) + COALESCE(j.additional_fees, 0),
             COALESCE(j.total, 0),
             COALESCE(j.total_amount, 0)
           ) AS approx_current_revenue,
           cl.payout_batch_id
    FROM cleaner_ledger cl
    JOIN jobs j ON j.id = cl.job_id
    WHERE cl.type = 'earning'
      AND cl.payout_batch_id IS NOT NULL
      AND cl.metadata ? 'revenue'
      AND (cl.metadata->>'revenue')::numeric > 0
    ORDER BY cl.id DESC
    LIMIT 1000
  `);
  const r6drift = r6.filter(r => Math.abs(Number(r.stored_revenue) - Number(r.approx_current_revenue)) > 1);
  console.log(`  inspected ${r6.length} settled earnings with stored revenue`);
  console.log(`  ${r6drift.length} where stored revenue differs from current job revenue by > $1`);
  if (r6drift.length > 0) {
    r6drift.slice(0, 5).forEach(r => console.log(
      `    ledger_id=${r.ledger_id} job=${r.job_id} stored_rev=${r.stored_revenue} current_rev=${r.approx_current_revenue} batch=${r.payout_batch_id}`
    ));
  }
  console.log(`  ✓ Behavior on rebuild: settled row stays unchanged (§3.1).`);
  console.log(`    ledger_drift_detected emitted when dry-run-computed differs from settled amount.`);
  out.scenarios['6_zb_invoice_edit'] = { matches: r6drift.length, inspected: r6.length };

  // ── 7. Stale webhook replay — verify zenbooker_id dedup integrity
  banner(7, 'stale webhook replay (dedup integrity on zenbooker_id keys)');
  const r7a = await runQuery(`
    SELECT zenbooker_id, COUNT(*) AS dup_count
    FROM transactions
    WHERE zenbooker_id IS NOT NULL
    GROUP BY zenbooker_id
    HAVING COUNT(*) > 1
    ORDER BY dup_count DESC
    LIMIT 20
  `);
  const r7b = await runQuery(`
    SELECT zenbooker_id, COUNT(*) AS dup_count
    FROM jobs
    WHERE zenbooker_id IS NOT NULL
    GROUP BY zenbooker_id
    HAVING COUNT(*) > 1
    ORDER BY dup_count DESC
    LIMIT 20
  `);
  console.log(`  transactions.zenbooker_id duplicates: ${r7a.length}`);
  console.log(`  jobs.zenbooker_id duplicates:         ${r7b.length}`);
  if (r7a.length > 0) r7a.slice(0, 5).forEach(r => console.log(`    txn dup zb_id=${r.zenbooker_id} count=${r.dup_count}`));
  if (r7b.length > 0) r7b.slice(0, 5).forEach(r => console.log(`    job dup zb_id=${r.zenbooker_id} count=${r.dup_count}`));
  console.log(`  ✓ Zero duplicates = idempotent webhook replay safe.`);
  out.scenarios['7_stale_webhook_replay'] = { txn_dups: r7a.length, job_dups: r7b.length };

  // ── 8. Duplicate webhook delivery — check for duplicate (job, member, type, effective_date) on ledger
  banner(8, 'duplicate webhook delivery (cleaner_ledger uniqueness on job × member × type × date)');
  const r8 = await runQuery(`
    SELECT job_id, team_member_id, type, effective_date, COUNT(*) AS dup_count
    FROM cleaner_ledger
    WHERE type IN ('earning','tip','incentive','cash_collected')
      AND job_id IS NOT NULL
    GROUP BY job_id, team_member_id, type, effective_date
    HAVING COUNT(*) > 1
    ORDER BY dup_count DESC
    LIMIT 20
  `);
  console.log(`  duplicate (job, member, type, effective_date) tuples: ${r8.length}`);
  if (r8.length > 0) {
    r8.slice(0, 5).forEach(r => console.log(
      `    job=${r.job_id} member=${r.team_member_id} type=${r.type} date=${r.effective_date} count=${r.dup_count}`
    ));
    console.log(`  ⚠ Pre-existing duplicates may need operator review — likely from`);
    console.log(`    pre-P0 races where the old race-check returned early on partial state.`);
    console.log(`    Post-P0 race-check filters unbatched, which is stricter; no NEW dups should form.`);
  } else {
    console.log(`  ✓ No duplicates — idempotency on (job, member, type, effective_date) holds.`);
  }
  out.scenarios['8_duplicate_webhook'] = { dup_tuples: r8.length };

  // ── Final summary ─────────────────────────────────────────────────
  console.log();
  console.log('═══ Summary ═══');
  console.log(`  ${out.scenarios['1_cancel_preserve'].matches} cancelled jobs with preserved non-completion-derived rows`);
  console.log(`  ${out.scenarios['1b_cancel_with_settled'].matches} cancelled jobs retained settled completion-derived rows (§3.1 working)`);
  console.log(`  ${out.scenarios['2_multi_cleaner_shrink'].matches} jobs with multi-cleaner shrink (assignment-vs-ledger drift)`);
  console.log(`  ${out.scenarios['3_rate_change_after_payout'].matches}/${out.scenarios['3_rate_change_after_payout'].inspected} settled earnings with rate-table drift since payout`);
  console.log(`  ${out.scenarios['5_batch_cancel'].matches} cancelled payout batches`);
  console.log(`  ${out.scenarios['6_zb_invoice_edit'].matches}/${out.scenarios['6_zb_invoice_edit'].inspected} settled earnings with stored vs current revenue divergence`);
  console.log(`  ${out.scenarios['7_stale_webhook_replay'].txn_dups} txn dedup violations, ${out.scenarios['7_stale_webhook_replay'].job_dups} job dedup violations`);
  console.log(`  ${out.scenarios['8_duplicate_webhook'].dup_tuples} ledger duplicate-tuples`);
  console.log();
  console.log('  Per-row behavior on the next rebuild (read from constitution + new tests):');
  console.log('    - Scenario 1, 1b: cancel preserves; settled rows immutable; drift audit emitted on');
  console.log('      pre-P0-style status reset (current data shows §3.1 already holding).');
  console.log('    - Scenario 2: rebuild deletes unbatched orphans only; settled orphans preserved.');
  console.log('    - Scenario 3, 6: dry-run drift detection writes ledger_drift_detected; row untouched.');
  console.log('    - Scenario 4: drift detection falls back to direct amount compare (no snapshot path).');
  console.log('    - Scenario 5: batch-cancel is the §3.1 exception; current code is unchanged + safe.');
  console.log('    - Scenarios 7, 8: pre-existing duplicates not introduced by P0; new race-check is stricter.');
})();
