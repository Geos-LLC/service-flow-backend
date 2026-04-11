#!/usr/bin/env node
/**
 * One-shot backfill: fetch ZB invoices for completed jobs with null payment_method,
 * create missing transactions, update job.payment_method, rebuild ledger.
 *
 * Usage: node scripts/backfill-zenbooker-payments.js [user_id] [since_date]
 * Example: node scripts/backfill-zenbooker-payments.js 2 2026-04-01
 */

require('dotenv').config()
const axios = require('axios')
const { createClient } = require('@supabase/supabase-js')

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://ezyhbvskbwmwgwyduqpt.supabase.co'
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

const USER_ID = parseInt(process.argv[2]) || 2
const SINCE = process.argv[3] || '2026-04-01'

async function zbFetch(apiKey, path) {
  const res = await axios.get(`https://api.zenbooker.com/v1${path}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    timeout: 30000,
  })
  return res.data
}

async function main() {
  const { data: user } = await supabase.from('users').select('zenbooker_api_key').eq('id', USER_ID).single()
  if (!user?.zenbooker_api_key) {
    console.error('No ZB API key for user', USER_ID)
    process.exit(1)
  }
  const apiKey = user.zenbooker_api_key

  const { data: jobs } = await supabase.from('jobs')
    .select('id, zenbooker_id, customer_id, status')
    .eq('user_id', USER_ID)
    .eq('status', 'completed')
    .not('zenbooker_id', 'is', null)
    .is('payment_method', null)
    .gte('scheduled_date', SINCE)
    .order('scheduled_date')

  console.log(`Found ${jobs.length} jobs to backfill`)

  let created = 0, paid = 0, errors = 0

  for (const job of jobs) {
    try {
      const zbJob = await zbFetch(apiKey, `/jobs/${job.zenbooker_id}`)
      const invoiceId = zbJob?.invoice?.id
      if (!invoiceId) {
        console.log(`  job ${job.id}: no invoice, skip`)
        continue
      }

      const invoice = await zbFetch(apiKey, `/invoices/${invoiceId}`)
      const txs = invoice?.transactions || []
      if (txs.length === 0) {
        console.log(`  job ${job.id}: invoice has no transactions, skip`)
        continue
      }

      let paymentMethod = null
      for (const zbt of txs) {
        if (zbt.status !== 'succeeded') continue

        // Dedup
        const { data: existing } = await supabase.from('transactions')
          .select('id').eq('zenbooker_id', zbt.id).maybeSingle()
        if (existing) continue

        const pm = zbt.custom_payment_method_name || zbt.payment_method || 'other'
        paymentMethod = paymentMethod || pm

        const { error } = await supabase.from('transactions').insert({
          user_id: USER_ID,
          job_id: job.id,
          customer_id: job.customer_id,
          amount: parseFloat(zbt.amount) || 0,
          payment_method: pm,
          payment_intent_id: zbt.stripe_transaction_id || `zb_${zbt.id}`,
          status: 'completed',
          notes: zbt.memo || 'Backfilled from Zenbooker',
          zenbooker_id: zbt.id,
          created_at: zbt.payment_date || zbt.created,
        })
        if (error) {
          console.error(`  job ${job.id}: tx insert error:`, error.message)
          errors++
          continue
        }
        created++
      }

      if (paymentMethod) {
        await supabase.from('jobs').update({
          payment_method: paymentMethod,
          payment_status: 'paid',
        }).eq('id', job.id)
        paid++
        console.log(`  job ${job.id}: ${paymentMethod} ✓`)
      }

      // Small delay to avoid rate limiting
      await new Promise(r => setTimeout(r, 100))
    } catch (e) {
      console.error(`  job ${job.id}: error:`, e.message)
      errors++
    }
  }

  console.log(`\nDone: ${created} transactions created, ${paid} jobs marked paid, ${errors} errors`)
  console.log('Next: run ledger rebuild for these jobs')
}

main().catch(e => { console.error(e); process.exit(1) })
