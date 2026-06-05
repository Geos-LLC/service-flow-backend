/**
 * Safe single-job ledger reconcile.
 *
 * Mirrors the calculation logic of `createLedgerEntriesForCompletedJob`
 * (server.js) so that earning/tip/incentive/cash_collected rows for one job
 * can be brought into agreement with current `jobs` + `transactions` data
 * WITHOUT the destructive delete-and-rebuild path used by `rebuildJobLedger`.
 *
 * Contract (matches user-approved invariants):
 *   - Never DELETE any cleaner_ledger row.
 *   - Never UPDATE a row whose `payout_batch_id IS NOT NULL`. Drift on paid
 *     rows is reported, not corrected.
 *   - Unpaid rows (`payout_batch_id IS NULL`) may have their `amount` and
 *     `effective_date` UPDATED to match the recomputed value. The previous
 *     amount is preserved in `metadata.previous_amount` for audit.
 *   - Missing rows are INSERTed idempotently on
 *     (job_id, team_member_id, type, effective_date).
 *
 * Returns a structured diff:
 *   {
 *     job_id, eligible, reason,
 *     applied: { inserted: [...], updated: [...] },
 *     skipped: { paid_rows_with_drift: [...], paid_rows_matching: [...] },
 *     no_change: [...],
 *     orphans: [...]   // existing unpaid rows whose (member,type) not in intended set
 *   }
 */

'use strict';

function num(v, fallback = 0) {
  if (v == null) return fallback;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}

function sumThirdPartyFees(feesBreakdown) {
  if (!Array.isArray(feesBreakdown)) return 0;
  return feesBreakdown
    .filter((f) => f && (f.type === 'fee' || f.adjustment_type === 'fee'))
    .reduce((s, f) => s + num(f.amount != null ? f.amount : f.adjustment_amount), 0);
}

// Returns null when no rate row covers the date so the caller can fall back to
// team_members.hourly_rate instead of silently zeroing pre-history jobs.
function getEffectivePayRate(payRates, dateStr) {
  for (const rate of payRates) {
    const rateFrom = String(rate.effective_from).split('T')[0].split(' ')[0];
    if (rateFrom <= dateStr) {
      return {
        hourlyRate: num(rate.hourly_rate),
        commissionPercentage: num(rate.commission_percentage),
      };
    }
  }
  return null;
}

function isManagerRole(role) {
  const r = (role || '').toLowerCase();
  return r === 'account owner' || r === 'owner' || r === 'manager' || r === 'admin' || r === 'scheduler';
}

function normDate(d) {
  return String(d || '').split('T')[0].split(' ')[0];
}

/**
 * Compute the intended ledger row set for a completed/paid job.
 * Mirrors createLedgerEntriesForCompletedJob exactly except:
 *   - skips the $0 placeholder branch (a missing earning is what we're
 *     reporting, not something to mask with a $0 row)
 *   - returns rows instead of inserting
 */
async function computeIntendedRows(supabase, jobId, userId, jobOverrides = {}) {
  const { data: jobBase } = await supabase
    .from('jobs')
    .select('id, user_id, team_member_id, status, price, service_price, total, total_amount, invoice_amount, tip_amount, incentive_amount, hours_worked, duration, estimated_duration, scheduled_date, start_time, end_time, discount, additional_fees, fees_breakdown, taxes, cleaner_salary_override')
    .eq('id', jobId)
    .single();

  if (!jobBase) return { eligible: false, reason: 'job_not_found', intended: [], job: null };

  // Overlay any in-flight financial updates so dry-run reflects the post-fix
  // state. Without this, an endpoint that's about to UPDATE the job would
  // dry-run the ledger against stale data and silently report no_change.
  const job = { ...jobBase, ...jobOverrides };

  const status = (job.status || '').toLowerCase();
  if (status !== 'completed' && status !== 'paid') {
    return { eligible: false, reason: `job_status_not_completed (${job.status})`, intended: [], job };
  }

  const { data: assignments = [] } = await supabase
    .from('job_team_assignments')
    .select('team_member_id, is_primary, incentive_amount')
    .eq('job_id', jobId);

  let teamMemberIds = [];
  if (assignments && assignments.length > 0) teamMemberIds = assignments.map((a) => a.team_member_id);
  else if (job.team_member_id) teamMemberIds = [job.team_member_id];

  if (teamMemberIds.length === 0) {
    return { eligible: false, reason: 'no_team_members', intended: [], job };
  }

  const { data: teamMembers = [] } = await supabase
    .from('team_members')
    .select('id, first_name, last_name, hourly_rate, commission_percentage, role, salary_start_date')
    .in('id', teamMemberIds)
    .in('status', ['active', 'inactive']);

  if (!teamMembers || teamMembers.length === 0) {
    return { eligible: false, reason: 'no_eligible_team_members', intended: [], job };
  }

  const memberIdsForCount = new Set();
  teamMembers.forEach((m) => memberIdsForCount.add(m.id));
  if (job.team_member_id) memberIdsForCount.add(job.team_member_id);
  const memberCount = memberIdsForCount.size;

  const effectiveDate = job.scheduled_date
    ? normDate(job.scheduled_date)
    : new Date().toISOString().split('T')[0];

  const basePrice = num(job.service_price) || num(job.price);
  const thirdPartyFees = sumThirdPartyFees(job.fees_breakdown);
  const jobRevenue = basePrice > 0
    ? basePrice + num(job.additional_fees) - thirdPartyFees
    : Math.max(0, num(job.total) || num(job.total_amount) || num(job.invoice_amount) || 0) - thirdPartyFees;

  let hoursWorked = 0;
  if (num(job.hours_worked) > 0) {
    hoursWorked = num(job.hours_worked);
  } else {
    const m = job.duration || job.estimated_duration || 0;
    if (m > 0) hoursWorked = m / 60;
  }

  const { data: payRates = [] } = await supabase
    .from('team_member_pay_rates')
    .select('team_member_id, hourly_rate, commission_percentage, effective_from')
    .in('team_member_id', teamMemberIds)
    .eq('user_id', job.user_id || userId)
    .order('effective_from', { ascending: false });

  const ratesByMember = {};
  (payRates || []).forEach((r) => {
    if (!ratesByMember[r.team_member_id]) ratesByMember[r.team_member_id] = [];
    ratesByMember[r.team_member_id].push(r);
  });

  const intended = [];

  for (const member of teamMembers) {
    const memberRates = ratesByMember[member.id] || [];
    const memberFallback = {
      hourlyRate: num(member.hourly_rate),
      commissionPercentage: num(member.commission_percentage),
    };
    const eff = (memberRates.length > 0 && getEffectivePayRate(memberRates, effectiveDate))
      || memberFallback;
    const hourlyRate = eff.hourlyRate;
    const commissionPct = eff.commissionPercentage;
    const isManager = isManagerRole(member.role);

    if (!isManager) {
      let earningAmount = 0;
      let metadata;
      const overrideTotal = job.cleaner_salary_override;

      if (overrideTotal != null && num(overrideTotal) > 0) {
        earningAmount = parseFloat((num(overrideTotal) / memberCount).toFixed(2));
        metadata = { override_total: num(overrideTotal), member_count: memberCount, source: 'cleaner_salary_override' };
      } else if (hourlyRate > 0 && commissionPct > 0) {
        const hourlyPay = hoursWorked * hourlyRate;
        const commissionPay = (jobRevenue / memberCount) * (commissionPct / 100);
        earningAmount = parseFloat((hourlyPay + commissionPay).toFixed(2));
        metadata = { hours: hoursWorked, hourly_rate: hourlyRate, commission_pct: commissionPct, revenue: jobRevenue, member_count: memberCount };
      } else if (commissionPct > 0) {
        earningAmount = parseFloat(((jobRevenue / memberCount) * (commissionPct / 100)).toFixed(2));
        metadata = { hours: hoursWorked, hourly_rate: hourlyRate, commission_pct: commissionPct, revenue: jobRevenue, member_count: memberCount };
      } else if (hourlyRate > 0) {
        earningAmount = parseFloat((hoursWorked * hourlyRate).toFixed(2));
        metadata = { hours: hoursWorked, hourly_rate: hourlyRate, commission_pct: commissionPct, revenue: jobRevenue, member_count: memberCount };
      }

      if (earningAmount > 0) {
        intended.push({
          team_member_id: member.id, job_id: jobId, type: 'earning',
          amount: earningAmount, effective_date: effectiveDate, metadata,
          note: `Earning for job #${jobId}`,
        });
      }
    }

    const jobTip = num(job.tip_amount);
    const memberTip = jobTip / Math.max(1, memberCount);
    if (memberTip > 0) {
      intended.push({
        team_member_id: member.id, job_id: jobId, type: 'tip',
        amount: parseFloat(memberTip.toFixed(2)), effective_date: effectiveDate,
        note: `Tip for job #${jobId}`,
      });
    }

    const assignmentRow = (assignments || []).find((a) => a.team_member_id === member.id);
    const assignmentIncentive = assignmentRow ? num(assignmentRow.incentive_amount) : 0;
    const jobIncentive = num(job.incentive_amount);
    const hasPerAssignmentIncentives = (assignments || []).some((a) => num(a.incentive_amount) > 0);
    const memberIncentive = hasPerAssignmentIncentives
      ? assignmentIncentive
      : (jobIncentive > 0 ? parseFloat((jobIncentive / Math.max(1, memberCount)).toFixed(2)) : 0);
    if (memberIncentive > 0) {
      intended.push({
        team_member_id: member.id, job_id: jobId, type: 'incentive',
        amount: memberIncentive, effective_date: effectiveDate,
        note: `Incentive for job #${jobId}`,
      });
    }
  }

  // cash_collected — sum of ZB cash transactions split per member
  const { data: cashTxs = [] } = await supabase
    .from('transactions')
    .select('amount, payment_method')
    .eq('job_id', jobId)
    .eq('status', 'completed')
    .ilike('payment_method', 'cash');
  if (cashTxs && cashTxs.length > 0) {
    const totalCash = cashTxs.reduce((s, tx) => s + num(tx.amount), 0);
    if (totalCash > 0) {
      for (const member of teamMembers) {
        const share = parseFloat((totalCash / memberCount).toFixed(2));
        intended.push({
          team_member_id: member.id, job_id: jobId, type: 'cash_collected',
          amount: -share, effective_date: effectiveDate,
          note: `Cash collected for job #${jobId}`,
        });
      }
    }
  }

  return { eligible: true, reason: 'completed', intended, job };
}

function key(r) { return `${r.team_member_id}:${r.type}`; }

/**
 * Reconcile one job's earning/tip/incentive/cash_collected rows.
 *
 * @param {object} supabase — supabase-js client
 * @param {object} args
 * @param {number} args.jobId
 * @param {number} args.userId         — for `created_by` on inserts
 * @param {boolean} [args.dryRun=false] — when true, do not write; return diff only
 * @returns {Promise<object>} structured diff
 */
async function safeReconcileJobLedger(supabase, { jobId, userId, dryRun = false, jobOverrides = {} }) {
  const computed = await computeIntendedRows(supabase, jobId, userId, jobOverrides);
  const result = {
    job_id: jobId,
    eligible: computed.eligible,
    reason: computed.reason,
    dry_run: !!dryRun,
    applied: { inserted: [], updated: [] },
    skipped: { paid_rows_with_drift: [], paid_rows_matching: [] },
    no_change: [],
    orphans: [],
  };
  if (!computed.eligible) return result;

  // Existing rows for the relevant types
  const REPAIR_TYPES = ['earning', 'tip', 'incentive', 'cash_collected'];
  const { data: existing = [] } = await supabase
    .from('cleaner_ledger')
    .select('id, team_member_id, job_id, type, amount, payout_batch_id, effective_date, metadata, note')
    .eq('job_id', jobId)
    .in('type', REPAIR_TYPES);

  const existingByKey = {};
  for (const e of existing) {
    (existingByKey[key(e)] = existingByKey[key(e)] || []).push(e);
  }

  for (const want of computed.intended) {
    const matches = existingByKey[key(want)] || [];
    const paid = matches.filter((m) => m.payout_batch_id != null);
    const unpaid = matches.filter((m) => m.payout_batch_id == null);

    // Paid row(s) for this (member,type): never touch. Report drift if amount differs.
    for (const p of paid) {
      const paidAmt = num(p.amount);
      if (Math.abs(paidAmt - want.amount) >= 0.01) {
        result.skipped.paid_rows_with_drift.push({
          ledger_id: p.id, payout_batch_id: p.payout_batch_id,
          team_member_id: p.team_member_id, type: p.type,
          paid_amount: paidAmt, intended_amount: want.amount,
          delta: parseFloat((want.amount - paidAmt).toFixed(2)),
        });
      } else {
        result.skipped.paid_rows_matching.push({ ledger_id: p.id, team_member_id: p.team_member_id, type: p.type, amount: paidAmt });
      }
    }

    if (unpaid.length === 0 && paid.length === 0) {
      // INSERT (idempotent — caller already has the existing set; collisions ruled out).
      if (!dryRun) {
        const insertRow = {
          user_id: computed.job.user_id || userId,
          team_member_id: want.team_member_id,
          job_id: want.job_id,
          type: want.type,
          amount: want.amount,
          effective_date: want.effective_date,
          note: want.note,
          metadata: want.metadata || null,
          created_by: userId,
        };
        const { data: ins, error: insErr } = await supabase
          .from('cleaner_ledger')
          .insert(insertRow)
          .select('id, team_member_id, type, amount, effective_date, payout_batch_id')
          .single();
        if (insErr) {
          result.applied.inserted.push({ error: insErr.message, want });
        } else {
          result.applied.inserted.push(ins);
        }
      } else {
        result.applied.inserted.push({ ...want, _dry_run: true });
      }
      continue;
    }

    // Unpaid row(s) exist — UPDATE the first (canonical) one if amount/eff differs.
    // Additional unpaid duplicates would be unusual; we leave them in place and
    // surface them as orphans in the final pass.
    if (unpaid.length > 0) {
      const target = unpaid[0];
      const curAmt = num(target.amount);
      const curEff = normDate(target.effective_date);
      const wantEff = normDate(want.effective_date);
      const amtDrift = Math.abs(curAmt - want.amount) >= 0.01;
      const effDrift = curEff !== wantEff;

      if (amtDrift || effDrift) {
        const newMetadata = {
          ...(target.metadata || {}),
          ...(want.metadata || {}),
          previous_amount: curAmt,
          previous_effective_date: curEff,
          reconciled_at: new Date().toISOString(),
          reconcile_source: 'safeReconcileJobLedger',
        };
        if (!dryRun) {
          const { data: upd, error: updErr } = await supabase
            .from('cleaner_ledger')
            .update({
              amount: want.amount,
              effective_date: want.effective_date,
              metadata: newMetadata,
            })
            .eq('id', target.id)
            .is('payout_batch_id', null)
            .select('id, team_member_id, type, amount, effective_date, payout_batch_id')
            .single();
          if (updErr) {
            result.applied.updated.push({ error: updErr.message, ledger_id: target.id });
          } else if (!upd) {
            // Row was paid between SELECT and UPDATE — race. Skip.
            result.skipped.paid_rows_with_drift.push({
              ledger_id: target.id,
              note: 'Row became paid between read and write — skipped',
              team_member_id: target.team_member_id, type: target.type,
              intended_amount: want.amount,
            });
          } else {
            result.applied.updated.push({
              ...upd,
              previous_amount: curAmt,
              previous_effective_date: curEff,
            });
          }
        } else {
          result.applied.updated.push({
            ledger_id: target.id, team_member_id: target.team_member_id, type: target.type,
            previous_amount: curAmt, intended_amount: want.amount,
            previous_effective_date: curEff, intended_effective_date: wantEff,
            _dry_run: true,
          });
        }
      } else {
        result.no_change.push({ ledger_id: target.id, team_member_id: target.team_member_id, type: target.type, amount: curAmt });
      }
    }
  }

  // Orphan unpaid rows: existing (member,type) not in intended set.
  const intendedKeys = new Set(computed.intended.map(key));
  for (const e of existing) {
    if (!intendedKeys.has(key(e))) {
      result.orphans.push({
        ledger_id: e.id, team_member_id: e.team_member_id, type: e.type,
        amount: num(e.amount), effective_date: normDate(e.effective_date),
        payout_batch_id: e.payout_batch_id,
        action: 'left_alone (create-only contract; orphan UPDATE/DELETE out of scope)',
      });
    }
  }

  return result;
}

module.exports = {
  safeReconcileJobLedger,
  computeIntendedRows,
};
