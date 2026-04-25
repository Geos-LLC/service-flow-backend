#!/usr/bin/env node
/**
 * Surgical backfill: insert cash_collected ledger entries for completed cash-paid jobs
 * that are missing them.
 *
 * Why surgical (vs full rebuildJobLedger):
 *   rebuildJobLedger deletes+recreates earnings via createLedgerEntriesForCompletedJob.
 *   Old jobs may have earnings already linked to paid payout_batch_ids; if a cleaner's
 *   hourly_rate or commission_pct has changed since payout, the rebuilt earning will
 *   have a different amount, breaking the batch's settled total. We only want to
 *   add the missing cash_collected rows.
 *
 * Logic mirrors the cash branch of createLedgerEntriesForCompletedJob (server.js).
 *
 * Usage:
 *   node scripts/backfill-cash-collected.js          # dry-run
 *   node scripts/backfill-cash-collected.js --apply  # actually insert
 */

require('dotenv').config()
const { createClient } = require('@supabase/supabase-js')

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://ezyhbvskbwmwgwyduqpt.supabase.co'
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!SUPABASE_KEY) {
  console.error('SUPABASE_SERVICE_ROLE_KEY missing in env')
  process.exit(1)
}
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)
const APPLY = process.argv.includes('--apply')

async function findAffectedJobs() {
  // Pull all cash-paid completed transactions, then filter to those whose job has no
  // cash_collected ledger entry. Paginate to avoid the 1000-row Supabase default.
  const cashTxs = []
  let from = 0
  const PAGE = 1000
  for (;;) {
    const { data, error } = await supabase
      .from('transactions')
      .select('job_id, amount')
      .eq('payment_method', 'cash')
      .eq('status', 'completed')
      .not('job_id', 'is', null)
      .range(from, from + PAGE - 1)
    if (error) throw error
    if (!data || data.length === 0) break
    cashTxs.push(...data)
    if (data.length < PAGE) break
    from += PAGE
  }

  // Aggregate cash per job
  const jobCash = new Map()
  for (const tx of cashTxs) {
    jobCash.set(tx.job_id, (jobCash.get(tx.job_id) || 0) + (parseFloat(tx.amount) || 0))
  }

  // Filter to jobs with NO cash_collected ledger entry
  const affected = []
  const jobIds = [...jobCash.keys()]
  // Chunked IN query
  const CHUNK = 200
  for (let i = 0; i < jobIds.length; i += CHUNK) {
    const slice = jobIds.slice(i, i + CHUNK)
    const { data: existing, error } = await supabase
      .from('cleaner_ledger')
      .select('job_id')
      .eq('type', 'cash_collected')
      .in('job_id', slice)
    if (error) throw error
    const haveCash = new Set((existing || []).map(r => r.job_id))
    for (const jid of slice) {
      if (!haveCash.has(jid)) affected.push({ job_id: jid, total_cash: jobCash.get(jid) })
    }
  }
  return affected
}

async function fetchJobMembers(jobIds) {
  // jobs lookup
  const jobs = new Map()
  for (let i = 0; i < jobIds.length; i += 200) {
    const slice = jobIds.slice(i, i + 200)
    const { data, error } = await supabase
      .from('jobs')
      .select('id, user_id, scheduled_date, team_member_id, status')
      .in('id', slice)
    if (error) throw error
    for (const j of (data || [])) jobs.set(j.id, j)
  }
  // assignments
  const assignments = new Map() // job_id -> [team_member_id]
  for (let i = 0; i < jobIds.length; i += 200) {
    const slice = jobIds.slice(i, i + 200)
    const { data, error } = await supabase
      .from('job_team_assignments')
      .select('job_id, team_member_id')
      .in('job_id', slice)
    if (error) throw error
    for (const a of (data || [])) {
      if (!assignments.has(a.job_id)) assignments.set(a.job_id, [])
      assignments.get(a.job_id).push(a.team_member_id)
    }
  }
  return { jobs, assignments }
}

function effectiveDateFor(job) {
  if (!job.scheduled_date) return new Date().toISOString().split('T')[0]
  return String(job.scheduled_date).split('T')[0].split(' ')[0]
}

async function main() {
  console.log(APPLY ? 'APPLY mode — will insert rows' : 'DRY RUN — no inserts. Pass --apply to commit.')
  console.log()

  const affected = await findAffectedJobs()
  console.log(`Found ${affected.length} jobs with cash transactions but no cash_collected ledger entry`)
  if (affected.length === 0) return

  const jobIds = affected.map(a => a.job_id)
  const { jobs, assignments } = await fetchJobMembers(jobIds)

  let toInsert = []
  let skipped_no_member = 0
  let skipped_not_completed = 0

  for (const a of affected) {
    const job = jobs.get(a.job_id)
    if (!job) { skipped_no_member++; continue }
    if (job.status !== 'completed') { skipped_not_completed++; continue }

    let memberIds = assignments.get(a.job_id) || []
    if (memberIds.length === 0 && job.team_member_id) memberIds = [job.team_member_id]
    if (memberIds.length === 0) { skipped_no_member++; continue }

    const memberCount = memberIds.length
    const memberShare = parseFloat((a.total_cash / memberCount).toFixed(2))
    if (memberShare <= 0) continue

    const eff = effectiveDateFor(job)
    for (const mid of memberIds) {
      toInsert.push({
        user_id: job.user_id,
        team_member_id: mid,
        job_id: a.job_id,
        type: 'cash_collected',
        amount: -memberShare,
        effective_date: eff,
        note: `Cash collected for job #${a.job_id}`,
        metadata: { backfilled: true, backfill_run: '2026-04-25' },
        created_by: job.user_id,
      })
    }
  }

  console.log(`Plan: ${toInsert.length} cash_collected rows across ${affected.length - skipped_no_member - skipped_not_completed} jobs`)
  console.log(`Skipped: ${skipped_no_member} (no team member), ${skipped_not_completed} (job not completed)`)
  console.log(`Total negative offset: $${toInsert.reduce((s, r) => s + r.amount, 0).toFixed(2)}`)

  if (!APPLY) {
    console.log()
    console.log('First 5 rows preview:')
    console.log(JSON.stringify(toInsert.slice(0, 5), null, 2))
    return
  }

  // Insert in chunks of 200
  let inserted = 0, errors = 0
  for (let i = 0; i < toInsert.length; i += 200) {
    const chunk = toInsert.slice(i, i + 200)
    const { error } = await supabase.from('cleaner_ledger').insert(chunk)
    if (error) {
      console.error(`Chunk ${i}: error`, error.message)
      errors++
    } else {
      inserted += chunk.length
    }
  }
  console.log(`\nInserted ${inserted} rows, ${errors} chunks failed.`)
}

main().catch(e => { console.error(e); process.exit(1) })
