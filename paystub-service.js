/**
 * Paystubs Module (Loosely Coupled)
 *
 * Mount: app.use('/api/paystubs', require('./paystub-service')(supabase, logger, notificationEmail))
 * Remove: delete this file + remove the line above = zero breakage
 *
 * Paystubs are immutable document records. They do NOT recalculate finances —
 * `snapshot_json` freezes the breakdown at generation time.
 *
 * Source of truth: cleaner_ledger
 * Paystub role: document + email delivery tracking
 */

const express = require('express')
const PDFDocument = require('pdfkit')

module.exports = (supabase, logger, notificationEmail) => {
  const router = express.Router()

  // ══════════════════════════════════════
  // Auth middleware — reuse the app's JWT
  // ══════════════════════════════════════
  const authenticateToken = async (req, res, next) => {
    const authHeader = req.headers['authorization']
    const token = authHeader && authHeader.split(' ')[1]
    if (!token) return res.status(401).json({ error: 'No token provided' })
    try {
      const jwt = require('jsonwebtoken')
      const decoded = jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key')
      req.user = decoded
      next()
    } catch (e) {
      return res.status(401).json({ error: 'Invalid token' })
    }
  }
  router.use(authenticateToken)

  // ══════════════════════════════════════════════════════════════
  // Helpers (exported for tests via module.exports.__helpers)
  // ══════════════════════════════════════════════════════════════

  function formatDate(dateStr) {
    if (!dateStr) return ''
    const s = String(dateStr)
    // Bare YYYY-MM-DD parses as UTC midnight → off-by-one in negative TZs. Anchor at local midnight.
    const isBareDate = /^\d{4}-\d{2}-\d{2}$/.test(s)
    const d = new Date(isBareDate ? s + 'T00:00:00' : s)
    if (isNaN(d.getTime())) return s
    return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
  }

  function toNum(v) {
    const n = parseFloat(v)
    return isNaN(n) ? 0 : n
  }

  function escapeHtml(str) {
    if (str == null) return ''
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
  }

  /**
   * Aggregate ledger entries into paystub totals + line items.
   * Pure function — easy to test.
   *
   * @param {Array} entries - ledger rows with { type, amount, job_id, note, metadata }
   * @param {Object} jobLookup - { [jobId]: { service_name, customer_name, scheduled_date, hours } }
   * @returns {Object} { totals, lineItems }
   */
  function aggregateLedgerEntries(entries, jobLookup = {}) {
    const totals = {
      earnings: 0,
      managerSalary: 0,
      managerCommission: 0,
      tips: 0,
      incentives: 0,
      adjustments: 0,
      reimbursements: 0,
      cashCollected: 0,
      netPayout: 0,
    }
    const lineItemsByJob = new Map()
    const managerSalaryItems = []     // [{ date, hours, rate, amount, note }]
    const managerCommissionItems = [] // [{ date, dayRevenue, commissionPct, amount, note }]

    for (const entry of (entries || [])) {
      const amt = toNum(entry.amount)
      const type = (entry.type || '').toLowerCase()
      const meta = entry.metadata || {}

      // payout entries are settlement records — not part of earned pay
      if (type === 'payout') continue

      // Manager-level earnings (job_id NULL) — pulled out for per-day breakdowns
      if (type === 'earning' && !entry.job_id && (meta.is_manager_salary || meta.is_manager_commission)) {
        if (meta.is_manager_salary) {
          totals.managerSalary += amt
          managerSalaryItems.push({
            date: entry.effective_date || null,
            hours: toNum(meta.scheduled_hours),
            rate: toNum(meta.hourly_rate),
            amount: amt,
            note: entry.note || '',
          })
        } else if (meta.is_manager_commission) {
          totals.managerCommission += amt
          managerCommissionItems.push({
            date: entry.effective_date || null,
            dayRevenue: toNum(meta.day_revenue),
            commissionPct: toNum(meta.commission_pct),
            amount: amt,
            note: entry.note || '',
          })
        }
        continue
      }

      if (type === 'earning') totals.earnings += amt
      else if (type === 'tip') totals.tips += amt
      else if (type === 'incentive') totals.incentives += amt
      else if (type === 'adjustment') totals.adjustments += amt
      else if (type === 'reimbursement') totals.reimbursements += amt
      else if (type === 'cash_collected') totals.cashCollected += amt
      else if (type === 'cash_to_company') totals.cashCollected += amt

      // Track per-job breakdown for line items
      if (entry.job_id) {
        const key = entry.job_id
        if (!lineItemsByJob.has(key)) {
          const job = jobLookup[key] || {}
          lineItemsByJob.set(key, {
            jobId: key,
            date: job.scheduled_date || null,
            service: job.service_name || '',
            customerName: job.customer_name || '',
            hours: toNum(job.hours),
            earning: 0,
            tip: 0,
            incentive: 0,
            reimbursement: 0,
            cashCollected: 0,
          })
        }
        const item = lineItemsByJob.get(key)
        if (type === 'earning') item.earning += amt
        else if (type === 'tip') item.tip += amt
        else if (type === 'incentive') item.incentive += amt
        else if (type === 'reimbursement') item.reimbursement += amt
        else if (type === 'cash_collected' || type === 'cash_to_company') item.cashCollected += amt
      }
    }

    totals.netPayout =
      totals.earnings + totals.managerSalary + totals.managerCommission +
      totals.tips + totals.incentives + totals.adjustments +
      totals.reimbursements + totals.cashCollected

    // Round all totals to 2 decimal places for clean display
    for (const k of Object.keys(totals)) {
      totals[k] = parseFloat(totals[k].toFixed(2))
    }

    const byDate = (a, b) => {
      const da = a.date ? new Date(a.date).getTime() : 0
      const db = b.date ? new Date(b.date).getTime() : 0
      return da - db
    }
    const lineItems = Array.from(lineItemsByJob.values()).sort(byDate)
    managerSalaryItems.sort(byDate)
    managerCommissionItems.sort(byDate)

    return { totals, lineItems, managerSalaryItems, managerCommissionItems }
  }

  /**
   * Render paystub snapshot as HTML (inline-styled, email-ready).
   */
  function renderPaystubHtml(snapshot) {
    const s = snapshot || {}
    const cleaner = s.cleaner || {}
    const company = s.company || {}
    const period = s.period || {}
    const totals = s.totals || {}
    const lineItems = s.lineItems || []
    const managerSalaryItems = s.managerSalaryItems || []
    const managerCommissionItems = s.managerCommissionItems || []
    const payout = s.payout || {}

    const cleanerName = escapeHtml(`${cleaner.firstName || ''} ${cleaner.lastName || ''}`.trim() || 'Team Member')
    const companyName = escapeHtml(company.name || 'Service Flow')
    const periodLabel = `${formatDate(period.start)} – ${formatDate(period.end)}`

    const fmt = (n) => `$${(parseFloat(n) || 0).toFixed(2)}`
    const fmtNeg = (n) => {
      const v = parseFloat(n) || 0
      return v < 0 ? `-$${Math.abs(v).toFixed(2)}` : `$${v.toFixed(2)}`
    }

    const rowsHtml = lineItems.map(item => `
      <tr>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;font-size:13px;">${escapeHtml(formatDate(item.date))}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;font-size:13px;">${escapeHtml(item.service)}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;font-size:13px;">${escapeHtml(item.customerName)}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;font-size:13px;text-align:right;">${fmt(item.earning)}</td>
      </tr>
    `).join('')

    const lineItemsSection = lineItems.length > 0 ? `
      <h3 style="font-size:14px;color:#111;margin:24px 0 8px 0;">Jobs</h3>
      <table style="width:100%;border-collapse:collapse;background:#fff;border:1px solid #eee;border-radius:6px;overflow:hidden;">
        <thead>
          <tr style="background:#f9fafb;">
            <th style="padding:8px 12px;text-align:left;font-size:12px;color:#6b7280;font-weight:600;">Date</th>
            <th style="padding:8px 12px;text-align:left;font-size:12px;color:#6b7280;font-weight:600;">Service</th>
            <th style="padding:8px 12px;text-align:left;font-size:12px;color:#6b7280;font-weight:600;">Customer</th>
            <th style="padding:8px 12px;text-align:right;font-size:12px;color:#6b7280;font-weight:600;">Earning</th>
          </tr>
        </thead>
        <tbody>${rowsHtml}</tbody>
      </table>
    ` : ''

    const managerSalaryRows = managerSalaryItems.map(it => `
      <tr>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;font-size:13px;">${escapeHtml(formatDate(it.date))}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;font-size:13px;">${it.hours.toFixed(1)}h × $${it.rate.toFixed(2)}/hr</td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;font-size:13px;text-align:right;">${fmt(it.amount)}</td>
      </tr>
    `).join('')
    const managerSalarySection = managerSalaryItems.length > 0 ? `
      <h3 style="font-size:14px;color:#111;margin:24px 0 8px 0;">Salary Breakdown</h3>
      <table style="width:100%;border-collapse:collapse;background:#fff;border:1px solid #eee;border-radius:6px;overflow:hidden;">
        <thead>
          <tr style="background:#f9fafb;">
            <th style="padding:8px 12px;text-align:left;font-size:12px;color:#6b7280;font-weight:600;">Date</th>
            <th style="padding:8px 12px;text-align:left;font-size:12px;color:#6b7280;font-weight:600;">Calculation</th>
            <th style="padding:8px 12px;text-align:right;font-size:12px;color:#6b7280;font-weight:600;">Amount</th>
          </tr>
        </thead>
        <tbody>${managerSalaryRows}</tbody>
      </table>
    ` : ''

    const managerCommissionRows = managerCommissionItems.map(it => `
      <tr>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;font-size:13px;">${escapeHtml(formatDate(it.date))}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;font-size:13px;">${it.commissionPct.toFixed(2)}% of ${fmt(it.dayRevenue)}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;font-size:13px;text-align:right;">${fmt(it.amount)}</td>
      </tr>
    `).join('')
    const managerCommissionSection = managerCommissionItems.length > 0 ? `
      <h3 style="font-size:14px;color:#111;margin:24px 0 8px 0;">Commission Breakdown</h3>
      <table style="width:100%;border-collapse:collapse;background:#fff;border:1px solid #eee;border-radius:6px;overflow:hidden;">
        <thead>
          <tr style="background:#f9fafb;">
            <th style="padding:8px 12px;text-align:left;font-size:12px;color:#6b7280;font-weight:600;">Date</th>
            <th style="padding:8px 12px;text-align:left;font-size:12px;color:#6b7280;font-weight:600;">Calculation</th>
            <th style="padding:8px 12px;text-align:right;font-size:12px;color:#6b7280;font-weight:600;">Amount</th>
          </tr>
        </thead>
        <tbody>${managerCommissionRows}</tbody>
      </table>
    ` : ''

    const payoutInfo = payout.paidAt ? `<p style="font-size:12px;color:#6b7280;">Paid on ${escapeHtml(formatDate(payout.paidAt))}</p>` : ''

    // Payment block — only rendered when paystub is linked to a payout batch
    let paymentBlockHtml = ''
    if (payout.amount !== null && payout.amount !== undefined) {
      const amt = parseFloat(payout.amount) || 0
      const isPaid = payout.status === 'paid'
      let label, valueText, bgColor, textColor
      if (amt > 0) {
        label = isPaid ? 'Payment Sent' : 'Payment Pending'
        valueText = fmt(amt)
        bgColor = isPaid ? '#ecfdf5' : '#fef3c7'
        textColor = isPaid ? '#065f46' : '#92400e'
      } else if (amt < 0) {
        label = 'Balance Owed (carried to next period)'
        valueText = fmtNeg(amt)
        bgColor = '#fef2f2'
        textColor = '#991b1b'
      } else {
        label = 'Settled'
        valueText = fmt(0)
        bgColor = '#f3f4f6'
        textColor = '#374151'
      }
      const paidAtLine = payout.paidAt ? `<div style="font-size:11px;color:${textColor};opacity:0.8;margin-top:2px;">on ${escapeHtml(formatDate(payout.paidAt))}</div>` : ''
      paymentBlockHtml = `
        <div style="margin-top:12px;padding:14px;background:${bgColor};border-radius:8px;display:flex;justify-content:space-between;align-items:center;">
          <div>
            <div style="font-size:12px;color:${textColor};font-weight:600;text-transform:uppercase;letter-spacing:0.5px;">${escapeHtml(label)}</div>
            ${paidAtLine}
          </div>
          <div style="font-size:18px;font-weight:700;color:${textColor};">${valueText}</div>
        </div>`
    }

    return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Paystub</title></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;background:#f3f4f6;margin:0;padding:24px;">
  <div style="max-width:640px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #e5e7eb;">
    <div style="background:#2563eb;color:#fff;padding:24px;">
      <div style="font-size:12px;opacity:0.9;text-transform:uppercase;letter-spacing:1px;">${companyName}</div>
      <div style="font-size:22px;font-weight:700;margin-top:4px;">Paystub</div>
    </div>
    <div style="padding:24px;">
      <div style="font-size:14px;color:#111;">Hello <strong>${cleanerName}</strong>,</div>
      <div style="font-size:13px;color:#6b7280;margin-top:4px;">Pay period: <strong>${escapeHtml(periodLabel)}</strong></div>
      ${payoutInfo}

      <h3 style="font-size:14px;color:#111;margin:24px 0 8px 0;">Summary</h3>
      <table style="width:100%;border-collapse:collapse;background:#f9fafb;border-radius:6px;overflow:hidden;">
        <tr><td style="padding:10px 14px;font-size:13px;color:#374151;">Earnings</td><td style="padding:10px 14px;font-size:13px;text-align:right;">${fmt(totals.earnings)}</td></tr>
        ${totals.managerSalary ? `<tr><td style="padding:10px 14px;font-size:13px;color:#374151;border-top:1px solid #e5e7eb;">Manager salary</td><td style="padding:10px 14px;font-size:13px;text-align:right;border-top:1px solid #e5e7eb;">${fmt(totals.managerSalary)}</td></tr>` : ''}
        ${totals.managerCommission ? `<tr><td style="padding:10px 14px;font-size:13px;color:#374151;border-top:1px solid #e5e7eb;">Manager commission</td><td style="padding:10px 14px;font-size:13px;text-align:right;border-top:1px solid #e5e7eb;">${fmt(totals.managerCommission)}</td></tr>` : ''}
        <tr><td style="padding:10px 14px;font-size:13px;color:#374151;border-top:1px solid #e5e7eb;">Tips</td><td style="padding:10px 14px;font-size:13px;text-align:right;border-top:1px solid #e5e7eb;">${fmt(totals.tips)}</td></tr>
        <tr><td style="padding:10px 14px;font-size:13px;color:#374151;border-top:1px solid #e5e7eb;">Incentives</td><td style="padding:10px 14px;font-size:13px;text-align:right;border-top:1px solid #e5e7eb;">${fmt(totals.incentives)}</td></tr>
        <tr><td style="padding:10px 14px;font-size:13px;color:#374151;border-top:1px solid #e5e7eb;">Reimbursements</td><td style="padding:10px 14px;font-size:13px;text-align:right;border-top:1px solid #e5e7eb;">${fmt(totals.reimbursements)}</td></tr>
        <tr><td style="padding:10px 14px;font-size:13px;color:#374151;border-top:1px solid #e5e7eb;">Adjustments</td><td style="padding:10px 14px;font-size:13px;text-align:right;border-top:1px solid #e5e7eb;">${fmtNeg(totals.adjustments)}</td></tr>
        <tr><td style="padding:10px 14px;font-size:13px;color:#374151;border-top:1px solid #e5e7eb;">Cash collected</td><td style="padding:10px 14px;font-size:13px;text-align:right;border-top:1px solid #e5e7eb;">${fmtNeg(totals.cashCollected)}</td></tr>
        ${totals.priorDebt ? `<tr><td style="padding:10px 14px;font-size:13px;color:#374151;border-top:1px solid #e5e7eb;">Prior period debt</td><td style="padding:10px 14px;font-size:13px;text-align:right;border-top:1px solid #e5e7eb;">${fmtNeg(totals.priorDebt)}</td></tr>` : ''}
        <tr><td style="padding:14px;font-size:15px;font-weight:700;color:#111;border-top:2px solid #111;">Net Earned</td><td style="padding:14px;font-size:15px;font-weight:700;text-align:right;border-top:2px solid #111;">${fmt(totals.netPayout)}</td></tr>
      </table>

      ${paymentBlockHtml}

      ${managerSalarySection}
      ${managerCommissionSection}
      ${lineItemsSection}

      <p style="font-size:12px;color:#9ca3af;margin-top:24px;">If anything looks incorrect, please contact your administrator.</p>
    </div>
  </div>
</body>
</html>`.trim()
  }

  function renderPaystubText(snapshot) {
    const s = snapshot || {}
    const cleaner = s.cleaner || {}
    const totals = s.totals || {}
    const period = s.period || {}
    const name = `${cleaner.firstName || ''} ${cleaner.lastName || ''}`.trim() || 'Team Member'
    const fmt = (n) => `$${(parseFloat(n) || 0).toFixed(2)}`
    return [
      `Paystub for ${name}`,
      `Period: ${formatDate(period.start)} - ${formatDate(period.end)}`,
      '',
      `Earnings:       ${fmt(totals.earnings)}`,
      `Tips:           ${fmt(totals.tips)}`,
      `Incentives:     ${fmt(totals.incentives)}`,
      `Reimbursements: ${fmt(totals.reimbursements)}`,
      `Adjustments:    ${fmt(totals.adjustments)}`,
      `Cash collected: ${fmt(totals.cashCollected)}`,
      `Net Paid:       ${fmt(totals.netPayout)}`,
      '',
      'Full breakdown attached as PDF.',
    ].join('\n')
  }

  /**
   * Render a slim, mobile-friendly email body summary.
   * Designed to fit on a 320px screen with no horizontal scroll.
   * Full breakdown lives in the attached PDF.
   */
  function renderPaystubSummaryHtml(snapshot) {
    const s = snapshot || {}
    const cleaner = s.cleaner || {}
    const company = s.company || {}
    const period = s.period || {}
    const totals = s.totals || {}
    const payout = s.payout || {}

    const cleanerName = escapeHtml(`${cleaner.firstName || ''} ${cleaner.lastName || ''}`.trim() || 'Team Member')
    const companyName = escapeHtml(company.name || 'Service Flow')
    const periodLabel = `${formatDate(period.start)} – ${formatDate(period.end)}`

    const fmt = (n) => `$${(parseFloat(n) || 0).toFixed(2)}`
    const fmtNeg = (n) => {
      const v = parseFloat(n) || 0
      return v < 0 ? `-$${Math.abs(v).toFixed(2)}` : `$${v.toFixed(2)}`
    }

    // Stacked rows — each is a flex row, label left, value right. Always fits ≥320px.
    const row = (label, value, opts = {}) => {
      const bold = opts.bold ? 'font-weight:700;' : ''
      const top = opts.top ? 'border-top:2px solid #111;margin-top:6px;padding-top:12px;' : 'border-top:1px solid #e5e7eb;padding-top:10px;'
      const sz = opts.bold ? '15px' : '13px'
      return `<div style="display:flex;justify-content:space-between;align-items:baseline;${top}padding-bottom:0;font-size:${sz};color:#111;${bold}">
        <span style="color:#374151;">${escapeHtml(label)}</span>
        <span style="text-align:right;">${value}</span>
      </div>`
    }

    const rows = []
    rows.push(row('Earnings', fmt(totals.earnings)))
    if (totals.managerSalary) rows.push(row('Manager salary', fmt(totals.managerSalary)))
    if (totals.managerCommission) rows.push(row('Manager commission', fmt(totals.managerCommission)))
    if (totals.tips) rows.push(row('Tips', fmt(totals.tips)))
    if (totals.incentives) rows.push(row('Incentives', fmt(totals.incentives)))
    if (totals.reimbursements) rows.push(row('Reimbursements', fmt(totals.reimbursements)))
    if (totals.adjustments) rows.push(row('Adjustments', fmtNeg(totals.adjustments)))
    if (totals.cashCollected) rows.push(row('Cash collected', fmtNeg(totals.cashCollected)))
    if (totals.priorDebt) rows.push(row('Prior period debt', fmtNeg(totals.priorDebt)))
    rows.push(row('Net Earned', fmt(totals.netPayout), { bold: true, top: true }))

    let paymentBlock = ''
    if (payout.amount !== null && payout.amount !== undefined) {
      const amt = parseFloat(payout.amount) || 0
      const isPaid = payout.status === 'paid'
      let label, valueText, bgColor, textColor
      if (amt > 0) {
        label = isPaid ? 'Payment Sent' : 'Payment Pending'
        valueText = fmt(amt)
        bgColor = isPaid ? '#ecfdf5' : '#fef3c7'
        textColor = isPaid ? '#065f46' : '#92400e'
      } else if (amt < 0) {
        label = 'Balance Owed (carried to next period)'
        valueText = fmtNeg(amt)
        bgColor = '#fef2f2'
        textColor = '#991b1b'
      } else {
        label = 'Settled'
        valueText = fmt(0)
        bgColor = '#f3f4f6'
        textColor = '#374151'
      }
      const paidAtLine = payout.paidAt ? `<div style="font-size:11px;color:${textColor};opacity:0.8;margin-top:2px;">on ${escapeHtml(formatDate(payout.paidAt))}</div>` : ''
      paymentBlock = `
        <div style="margin-top:16px;padding:14px;background:${bgColor};border-radius:8px;">
          <div style="font-size:11px;color:${textColor};font-weight:600;text-transform:uppercase;letter-spacing:0.5px;">${escapeHtml(label)}</div>
          ${paidAtLine}
          <div style="font-size:20px;font-weight:700;color:${textColor};margin-top:4px;">${valueText}</div>
        </div>`
    }

    return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Paystub</title>
</head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;background:#f3f4f6;margin:0;padding:16px;">
  <div style="max-width:480px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #e5e7eb;">
    <div style="background:#2563eb;color:#fff;padding:20px;">
      <div style="font-size:11px;opacity:0.9;text-transform:uppercase;letter-spacing:1px;">${companyName}</div>
      <div style="font-size:20px;font-weight:700;margin-top:4px;">Paystub</div>
    </div>
    <div style="padding:20px;">
      <div style="font-size:14px;color:#111;">Hello <strong>${cleanerName}</strong>,</div>
      <div style="font-size:13px;color:#6b7280;margin-top:4px;">Pay period: <strong>${escapeHtml(periodLabel)}</strong></div>

      <div style="margin-top:18px;background:#f9fafb;border-radius:8px;padding:14px;">
        ${rows.join('')}
      </div>

      ${paymentBlock}

      <p style="font-size:13px;color:#374151;margin-top:20px;">
        The full breakdown — every job, manager salary days, and commission entries — is attached to this email as a PDF.
      </p>
      <p style="font-size:12px;color:#9ca3af;margin-top:12px;">If anything looks incorrect, please contact your administrator.</p>
    </div>
  </div>
</body>
</html>`.trim()
  }

  /**
   * Render the paystub as a PDF buffer using pdfkit.
   * Returns a Promise<Buffer>. Mirrors the full-detail HTML view.
   */
  function renderPaystubPdfBuffer(snapshot) {
    return new Promise((resolve, reject) => {
      try {
        const s = snapshot || {}
        const cleaner = s.cleaner || {}
        const company = s.company || {}
        const period = s.period || {}
        const totals = s.totals || {}
        const lineItems = s.lineItems || []
        const managerSalaryItems = s.managerSalaryItems || []
        const managerCommissionItems = s.managerCommissionItems || []
        const payout = s.payout || {}

        const cleanerName = `${cleaner.firstName || ''} ${cleaner.lastName || ''}`.trim() || 'Team Member'
        const companyName = company.name || 'Service Flow'
        const periodLabel = `${formatDate(period.start)} – ${formatDate(period.end)}`

        const fmt = (n) => `$${(parseFloat(n) || 0).toFixed(2)}`
        const fmtNeg = (n) => {
          const v = parseFloat(n) || 0
          return v < 0 ? `-$${Math.abs(v).toFixed(2)}` : `$${v.toFixed(2)}`
        }

        const doc = new PDFDocument({ size: 'LETTER', margin: 48 })
        const buffers = []
        doc.on('data', b => buffers.push(b))
        doc.on('end', () => resolve(Buffer.concat(buffers)))
        doc.on('error', reject)

        const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right

        // Header
        doc.fillColor('#2563eb').fontSize(10).text(companyName.toUpperCase(), { characterSpacing: 1 })
        doc.moveDown(0.2)
        doc.fillColor('#111').fontSize(22).text('Paystub')
        doc.moveDown(0.4)
        doc.fillColor('#374151').fontSize(11).text(`Hello ${cleanerName},`)
        doc.fillColor('#6b7280').fontSize(10).text(`Pay period: ${periodLabel}`)
        doc.moveDown(1)

        // Summary block — two-column key/value list
        const summaryRows = []
        summaryRows.push(['Earnings', fmt(totals.earnings)])
        if (totals.managerSalary) summaryRows.push(['Manager salary', fmt(totals.managerSalary)])
        if (totals.managerCommission) summaryRows.push(['Manager commission', fmt(totals.managerCommission)])
        summaryRows.push(['Tips', fmt(totals.tips)])
        summaryRows.push(['Incentives', fmt(totals.incentives)])
        summaryRows.push(['Reimbursements', fmt(totals.reimbursements)])
        summaryRows.push(['Adjustments', fmtNeg(totals.adjustments)])
        summaryRows.push(['Cash collected', fmtNeg(totals.cashCollected)])
        if (totals.priorDebt) summaryRows.push(['Prior period debt', fmtNeg(totals.priorDebt)])

        doc.fillColor('#111').fontSize(13).text('Summary')
        doc.moveDown(0.3)
        const summaryStartY = doc.y
        // Light gray box behind summary
        const summaryHeight = (summaryRows.length + 1) * 18 + 16
        doc.save()
          .roundedRect(doc.page.margins.left, summaryStartY, pageWidth, summaryHeight, 6)
          .fill('#f9fafb')
          .restore()

        doc.y = summaryStartY + 10
        doc.fontSize(11)
        for (const [label, value] of summaryRows) {
          doc.fillColor('#374151').text(label, doc.page.margins.left + 12, doc.y, { continued: false, width: pageWidth / 2 })
          doc.fillColor('#111').text(value, doc.page.margins.left + pageWidth / 2, doc.y - doc.currentLineHeight(), {
            width: pageWidth / 2 - 12,
            align: 'right',
          })
          doc.moveDown(0.4)
        }
        // Net Earned bold row
        doc.moveDown(0.2)
        doc.strokeColor('#111').lineWidth(1.2).moveTo(doc.page.margins.left + 12, doc.y).lineTo(doc.page.margins.left + pageWidth - 12, doc.y).stroke()
        doc.moveDown(0.4)
        doc.fillColor('#111').fontSize(13).text('Net Earned', doc.page.margins.left + 12, doc.y, { width: pageWidth / 2 })
        doc.fillColor('#111').fontSize(13).text(fmt(totals.netPayout), doc.page.margins.left + pageWidth / 2, doc.y - doc.currentLineHeight(), {
          width: pageWidth / 2 - 12,
          align: 'right',
        })
        doc.y = summaryStartY + summaryHeight + 12

        // Payment block
        if (payout.amount !== null && payout.amount !== undefined) {
          const amt = parseFloat(payout.amount) || 0
          const isPaid = payout.status === 'paid'
          let label, valueText, bgColor, textColor
          if (amt > 0) {
            label = isPaid ? 'PAYMENT SENT' : 'PAYMENT PENDING'
            valueText = fmt(amt)
            bgColor = isPaid ? '#ecfdf5' : '#fef3c7'
            textColor = isPaid ? '#065f46' : '#92400e'
          } else if (amt < 0) {
            label = 'BALANCE OWED (CARRIED FORWARD)'
            valueText = fmtNeg(amt)
            bgColor = '#fef2f2'
            textColor = '#991b1b'
          } else {
            label = 'SETTLED'
            valueText = fmt(0)
            bgColor = '#f3f4f6'
            textColor = '#374151'
          }
          const blockY = doc.y
          const blockH = 44
          doc.save().roundedRect(doc.page.margins.left, blockY, pageWidth, blockH, 6).fill(bgColor).restore()
          doc.fillColor(textColor).fontSize(9).text(label, doc.page.margins.left + 12, blockY + 10, { width: pageWidth - 24, characterSpacing: 0.5 })
          if (payout.paidAt) {
            doc.fontSize(9).fillColor(textColor).text(`on ${formatDate(payout.paidAt)}`, doc.page.margins.left + 12, blockY + 22, { width: pageWidth - 24 })
          }
          doc.fontSize(15).fillColor(textColor).text(valueText, doc.page.margins.left + 12, blockY + 14, { width: pageWidth - 24, align: 'right' })
          doc.y = blockY + blockH + 12
        }

        // Helper: draw a 3-column or 4-column table
        const drawTable = (title, headers, rows, colWidths) => {
          if (!rows || rows.length === 0) return
          // Page break if needed
          if (doc.y > doc.page.height - doc.page.margins.bottom - 80) {
            doc.addPage()
          }
          doc.fillColor('#111').fontSize(13).text(title)
          doc.moveDown(0.3)
          const tableX = doc.page.margins.left
          let y = doc.y

          // Header row
          doc.save().rect(tableX, y, pageWidth, 22).fill('#f9fafb').restore()
          doc.fillColor('#6b7280').fontSize(9)
          let cx = tableX + 8
          headers.forEach((h, i) => {
            const align = i === headers.length - 1 ? 'right' : 'left'
            const w = colWidths[i] - (i === 0 ? 8 : 0) - (i === headers.length - 1 ? 8 : 0)
            doc.text(h.toUpperCase(), cx, y + 7, { width: w, align, characterSpacing: 0.4 })
            cx += colWidths[i]
          })
          y += 22

          // Body rows
          doc.fontSize(10).fillColor('#111')
          for (const row of rows) {
            // Page break if row would overflow
            if (y > doc.page.height - doc.page.margins.bottom - 24) {
              doc.addPage()
              y = doc.page.margins.top
            }
            cx = tableX + 8
            row.forEach((cell, i) => {
              const align = i === row.length - 1 ? 'right' : 'left'
              const w = colWidths[i] - (i === 0 ? 8 : 0) - (i === row.length - 1 ? 8 : 0)
              doc.fillColor('#111').text(String(cell), cx, y + 6, { width: w, align })
              cx += colWidths[i]
            })
            // Border
            doc.strokeColor('#eeeeee').lineWidth(0.5).moveTo(tableX, y + 22).lineTo(tableX + pageWidth, y + 22).stroke()
            y += 22
          }
          doc.y = y + 12
        }

        // Manager salary breakdown
        if (managerSalaryItems.length > 0) {
          const cols = [pageWidth * 0.25, pageWidth * 0.45, pageWidth * 0.30]
          const rows = managerSalaryItems.map(it => [
            formatDate(it.date),
            `${(it.hours || 0).toFixed(1)}h × $${(it.rate || 0).toFixed(2)}/hr`,
            fmt(it.amount),
          ])
          drawTable('Salary Breakdown', ['Date', 'Calculation', 'Amount'], rows, cols)
        }

        // Manager commission breakdown
        if (managerCommissionItems.length > 0) {
          const cols = [pageWidth * 0.25, pageWidth * 0.45, pageWidth * 0.30]
          const rows = managerCommissionItems.map(it => [
            formatDate(it.date),
            `${(it.commissionPct || 0).toFixed(2)}% of ${fmt(it.dayRevenue)}`,
            fmt(it.amount),
          ])
          drawTable('Commission Breakdown', ['Date', 'Calculation', 'Amount'], rows, cols)
        }

        // Jobs
        if (lineItems.length > 0) {
          const cols = [pageWidth * 0.20, pageWidth * 0.30, pageWidth * 0.30, pageWidth * 0.20]
          const rows = lineItems.map(it => [
            formatDate(it.date),
            it.service || '',
            it.customerName || '',
            fmt(it.earning),
          ])
          drawTable('Jobs', ['Date', 'Service', 'Customer', 'Earning'], rows, cols)
        }

        // Footer
        if (doc.y > doc.page.height - doc.page.margins.bottom - 30) doc.addPage()
        doc.moveDown(0.5)
        doc.fillColor('#9ca3af').fontSize(9).text('If anything looks incorrect, please contact your administrator.', { align: 'left' })

        doc.end()
      } catch (e) {
        reject(e)
      }
    })
  }

  /**
   * Build the full paystub snapshot by reading from cleaner_ledger.
   * NEVER recalculates from jobs — ledger is the source of truth.
   */
  async function buildPaystubSnapshot({ userId, teamMemberId, periodStart, periodEnd, payoutBatchId }) {
    // 1. Team member profile
    const { data: tm, error: tmErr } = await supabase
      .from('team_members')
      .select('id, first_name, last_name, email, role, hourly_rate, commission_percentage, status')
      .eq('id', teamMemberId)
      .maybeSingle()
    if (tmErr || !tm) throw new Error(`Team member ${teamMemberId} not found`)

    // 2. Business/user profile
    const { data: owner } = await supabase
      .from('users')
      .select('business_name, first_name, last_name')
      .eq('id', userId)
      .maybeSingle()
    const companyName = owner?.business_name || [owner?.first_name, owner?.last_name].filter(Boolean).join(' ') || 'Service Flow'

    // 3. Resolve period from batch if needed
    let pStart = periodStart
    let pEnd = periodEnd
    let payoutBatch = null
    if (payoutBatchId) {
      const { data: batch } = await supabase
        .from('cleaner_payout_batch')
        .select('id, period_start, period_end, status, paid_at, total_amount, team_member_id')
        .eq('id', payoutBatchId)
        .eq('user_id', userId)
        .maybeSingle()
      if (!batch) throw new Error(`Payout batch ${payoutBatchId} not found`)
      payoutBatch = batch
      pStart = pStart || batch.period_start
      pEnd = pEnd || batch.period_end
    }
    if (!pStart || !pEnd) throw new Error('periodStart and periodEnd are required')

    // 4. Ledger entries — filter by batch if provided, else by period
    let ledgerQuery = supabase
      .from('cleaner_ledger')
      .select('id, team_member_id, job_id, type, amount, effective_date, note, metadata, payout_batch_id')
      .eq('user_id', userId)
      .eq('team_member_id', teamMemberId)

    if (payoutBatchId) {
      ledgerQuery = ledgerQuery.eq('payout_batch_id', payoutBatchId)
    } else {
      ledgerQuery = ledgerQuery.gte('effective_date', pStart).lte('effective_date', pEnd)
    }

    const { data: entries, error: entriesErr } = await ledgerQuery
    if (entriesErr) throw new Error(`Failed to fetch ledger entries: ${entriesErr.message}`)

    // 5. Job lookup (for line items)
    const jobIds = [...new Set((entries || []).map(e => e.job_id).filter(Boolean))]
    const jobLookup = {}
    if (jobIds.length > 0) {
      const { data: jobs } = await supabase
        .from('jobs')
        .select('id, service_name, customer_id, scheduled_date, hours_worked, duration, estimated_duration')
        .in('id', jobIds)
      const customerIds = [...new Set((jobs || []).map(j => j.customer_id).filter(Boolean))]
      let customerMap = {}
      if (customerIds.length > 0) {
        const { data: customers } = await supabase
          .from('customers')
          .select('id, first_name, last_name')
          .in('id', customerIds)
        customerMap = Object.fromEntries((customers || []).map(c => [c.id, `${c.first_name || ''} ${c.last_name || ''}`.trim()]))
      }
      for (const j of (jobs || [])) {
        const durationMin = j.duration || j.estimated_duration || 0
        const hours = j.hours_worked > 0 ? parseFloat(j.hours_worked) : (durationMin / 60)
        jobLookup[j.id] = {
          service_name: j.service_name || '',
          customer_name: customerMap[j.customer_id] || '',
          scheduled_date: j.scheduled_date,
          hours: parseFloat(hours.toFixed(2)),
        }
      }
    }

    // 6. Aggregate
    const { totals, lineItems, managerSalaryItems, managerCommissionItems } = aggregateLedgerEntries(entries, jobLookup)

    // 6b. Prior-period debt carry-forward.
    // When a batch absorbs a prior negative batch (via recovered_by_batch_id) the
    // absorbed -$X isn't a ledger row in THIS batch — it's netted into batch.total_amount
    // at creation time. Without surfacing it, the paystub summary (sum of ledger rows)
    // won't match the actual Payment amount (batch.total_amount).
    let priorDebt = 0
    let recoveredBatches = []
    if (payoutBatch?.id) {
      const { data: recovered } = await supabase
        .from('cleaner_payout_batch')
        .select('id, period_start, period_end, total_amount')
        .eq('user_id', userId)
        .eq('recovered_by_batch_id', payoutBatch.id)
      recoveredBatches = (recovered || []).map(b => ({
        id: b.id,
        periodStart: b.period_start,
        periodEnd: b.period_end,
        amount: parseFloat(b.total_amount) || 0,
      }))
      priorDebt = recoveredBatches.reduce((sum, b) => sum + b.amount, 0)
    }

    if (priorDebt !== 0) {
      totals.priorDebt = parseFloat(priorDebt.toFixed(2))
      totals.netPayout = parseFloat((totals.netPayout + priorDebt).toFixed(2))
    } else {
      totals.priorDebt = 0
    }

    return {
      version: 1,
      generatedAt: new Date().toISOString(),
      cleaner: {
        id: tm.id,
        firstName: tm.first_name || '',
        lastName: tm.last_name || '',
        email: tm.email || null,
        role: tm.role || null,
      },
      company: { name: companyName },
      period: { start: pStart, end: pEnd },
      lineItems,
      managerSalaryItems,
      managerCommissionItems,
      totals,
      recoveredBatches,
      payout: {
        batchId: payoutBatch?.id || null,
        status: payoutBatch?.status || null,
        paidAt: payoutBatch?.paid_at || null,
        amount: payoutBatch ? parseFloat(payoutBatch.total_amount || 0) : null,
        method: null,
      },
    }
  }

  // ══════════════════════════════════════
  // GET /api/paystubs — list
  // ══════════════════════════════════════
  router.get('/', async (req, res) => {
    try {
      const userId = req.user.userId
      const { teamMemberId, status, periodStart, periodEnd, limit = 100 } = req.query

      let q = supabase.from('paystubs')
        .select('*')
        .eq('user_id', userId)
        .order('period_end', { ascending: false })
        .limit(parseInt(limit) || 100)

      if (teamMemberId) q = q.eq('team_member_id', parseInt(teamMemberId))
      if (status) q = q.eq('status', status)
      if (periodStart) q = q.gte('period_end', periodStart)
      if (periodEnd) q = q.lte('period_start', periodEnd)

      const { data, error } = await q
      if (error) return res.status(500).json({ error: error.message })
      res.json({ paystubs: data || [] })
    } catch (e) {
      logger.error('[Paystubs] List error:', e.message)
      res.status(500).json({ error: 'Failed to list paystubs' })
    }
  })

  // ══════════════════════════════════════
  // GET /api/paystubs/:id — detail
  // ══════════════════════════════════════
  router.get('/:id', async (req, res) => {
    try {
      const userId = req.user.userId
      const { data, error } = await supabase.from('paystubs')
        .select('*').eq('id', req.params.id).eq('user_id', userId).maybeSingle()
      if (error) return res.status(500).json({ error: error.message })
      if (!data) return res.status(404).json({ error: 'Paystub not found' })
      res.json(data)
    } catch (e) {
      logger.error('[Paystubs] Get error:', e.message)
      res.status(500).json({ error: 'Failed to get paystub' })
    }
  })

  // ══════════════════════════════════════
  // POST /api/paystubs — generate
  // ══════════════════════════════════════
  router.post('/', async (req, res) => {
    try {
      const userId = req.user.userId
      const { teamMemberId, payoutBatchId, periodStart, periodEnd } = req.body || {}
      if (!teamMemberId) return res.status(400).json({ error: 'teamMemberId is required' })
      if (!payoutBatchId && (!periodStart || !periodEnd)) {
        return res.status(400).json({ error: 'Either payoutBatchId or periodStart+periodEnd is required' })
      }

      // Guard: prevent duplicate paystub for same batch
      if (payoutBatchId) {
        const { data: existing } = await supabase.from('paystubs')
          .select('id').eq('user_id', userId).eq('payout_batch_id', payoutBatchId).maybeSingle()
        if (existing) return res.status(409).json({ error: 'Paystub already exists for this payout batch', paystubId: existing.id })
      }

      const snapshot = await buildPaystubSnapshot({ userId, teamMemberId, periodStart, periodEnd, payoutBatchId })

      const { data: created, error: createErr } = await supabase.from('paystubs').insert({
        user_id: userId,
        team_member_id: parseInt(teamMemberId),
        payout_batch_id: payoutBatchId || null,
        period_start: snapshot.period.start,
        period_end: snapshot.period.end,
        status: 'issued',
        issued_at: new Date().toISOString(),
        snapshot_json: snapshot,
        created_by: userId,
      }).select().single()

      if (createErr) {
        logger.error('[Paystubs] Create error:', createErr)
        return res.status(500).json({ error: createErr.message })
      }
      res.json(created)
    } catch (e) {
      logger.error('[Paystubs] Generate error:', e.message)
      res.status(500).json({ error: e.message || 'Failed to generate paystub' })
    }
  })

  // ══════════════════════════════════════
  // Send one paystub — shared by /:id/send and /bulk/send
  // Returns { ok: true, paystub } or { ok: false, error }
  // ══════════════════════════════════════
  async function sendOnePaystub(userId, paystubId) {
    const { data: paystub, error: fetchErr } = await supabase.from('paystubs')
      .select('*').eq('id', paystubId).eq('user_id', userId).maybeSingle()
    if (fetchErr || !paystub) return { ok: false, error: 'Paystub not found', status: 404 }

    const snapshot = paystub.snapshot_json || {}
    const email = snapshot?.cleaner?.email
    if (!email) {
      await supabase.from('paystubs').update({
        email_status: 'error',
        email_error: 'Team member has no email',
        updated_at: new Date().toISOString(),
      }).eq('id', paystub.id)
      return { ok: false, error: 'Team member has no email address', status: 400, paystubId: paystub.id }
    }

    const html = renderPaystubSummaryHtml(snapshot)
    const text = renderPaystubText(snapshot)
    const period = snapshot.period || {}
    const subject = `Your paystub for ${formatDate(period.start)} – ${formatDate(period.end)}`

    // Generate PDF attachment. If PDF generation fails, fall back to full HTML body
    // so the cleaner still gets a usable paystub.
    let attachments
    let fallbackHtml = html
    try {
      const pdfBuffer = await renderPaystubPdfBuffer(snapshot)
      const safePeriod = `${period.start || 'period'}_${period.end || ''}`.replace(/[^0-9A-Za-z_-]/g, '')
      attachments = [{
        content: pdfBuffer.toString('base64'),
        filename: `paystub_${safePeriod}.pdf`,
        type: 'application/pdf',
        disposition: 'attachment',
      }]
    } catch (pdfErr) {
      logger.error(`[Paystubs] PDF render failed for paystub ${paystub.id}:`, pdfErr.message)
      // Without PDF, send full breakdown inline so nothing is lost.
      fallbackHtml = renderPaystubHtml(snapshot)
      attachments = undefined
    }

    try {
      const sgResult = await notificationEmail.sendInternalEmail(userId, {
        to: email,
        subject,
        html: attachments ? html : fallbackHtml,
        text,
        emailType: 'paystub',
        attachments,
      })
      const messageId = sgResult?.messageId || null

      const prevMeta = paystub.metadata || {}
      const sendCount = (prevMeta.sendCount || 0) + 1

      const { data: updated } = await supabase.from('paystubs').update({
        status: 'sent',
        sent_at: new Date().toISOString(),
        email_to: email,
        email_status: 'sent',
        email_message_id: messageId,
        email_error: null,
        metadata: { ...prevMeta, sendCount, lastSendAt: new Date().toISOString() },
        updated_at: new Date().toISOString(),
      }).eq('id', paystub.id).select().single()

      logger.log(`[Paystubs] Sent paystub ${paystub.id} to ${email} (count=${sendCount})`)
      return { ok: true, paystub: updated }
    } catch (sendErr) {
      const errMsg = sendErr?.response?.body?.errors?.[0]?.message || sendErr.message || 'Send failed'
      await supabase.from('paystubs').update({
        status: 'failed',
        email_status: 'error',
        email_error: errMsg,
        updated_at: new Date().toISOString(),
      }).eq('id', paystub.id)
      logger.error(`[Paystubs] Send error for paystub ${paystub.id}:`, errMsg)
      return { ok: false, error: errMsg, status: 500, paystubId: paystub.id }
    }
  }

  // ══════════════════════════════════════
  // POST /api/paystubs/bulk — generate for many members in one call
  // Body: { teamMemberIds?: number[], periodStart, periodEnd, useBatches?: boolean }
  // - teamMemberIds empty/missing → all active team members for this user
  // - useBatches=true → for each member, look up a matching batch in the period;
  //   if found, link paystub to that batch (idempotent via unique index)
  // ══════════════════════════════════════
  router.post('/bulk', async (req, res) => {
    try {
      const userId = req.user.userId
      const { teamMemberIds, periodStart, periodEnd, useBatches = true } = req.body || {}
      if (!periodStart || !periodEnd) {
        return res.status(400).json({ error: 'periodStart and periodEnd are required' })
      }

      // Resolve member list
      let memberIds = Array.isArray(teamMemberIds) && teamMemberIds.length > 0
        ? teamMemberIds.map(id => parseInt(id)).filter(Boolean)
        : null

      if (!memberIds) {
        const { data: members, error: mErr } = await supabase.from('team_members')
          .select('id').eq('user_id', userId).eq('status', 'active')
        if (mErr) return res.status(500).json({ error: mErr.message })
        memberIds = (members || []).map(m => m.id)
      }

      // Pre-fetch matching batches (one query) when useBatches is true
      let batchByMember = {}
      if (useBatches && memberIds.length > 0) {
        const { data: batches } = await supabase.from('cleaner_payout_batch')
          .select('id, team_member_id, period_start, period_end')
          .eq('user_id', userId)
          .eq('period_start', periodStart)
          .eq('period_end', periodEnd)
          .in('team_member_id', memberIds)
        for (const b of (batches || [])) {
          // Prefer first match per member
          if (!batchByMember[b.team_member_id]) batchByMember[b.team_member_id] = b.id
        }
      }

      const created = []
      const skipped = []
      const errors = []

      for (const memberId of memberIds) {
        try {
          const payoutBatchId = batchByMember[memberId] || null

          // Idempotency: skip if paystub already exists for this batch
          if (payoutBatchId) {
            const { data: existing } = await supabase.from('paystubs')
              .select('id').eq('user_id', userId).eq('payout_batch_id', payoutBatchId).maybeSingle()
            if (existing) {
              skipped.push({ teamMemberId: memberId, reason: 'already exists for batch', paystubId: existing.id })
              continue
            }
          }

          const snapshot = await buildPaystubSnapshot({
            userId, teamMemberId: memberId, periodStart, periodEnd, payoutBatchId,
          })

          // Skip members with zero activity and no batch (nothing to pay)
          const t = snapshot?.totals || {}
          const hasActivity = (t.earnings || 0) + (t.tips || 0) + (t.incentives || 0) + (t.adjustments || 0) + (t.reimbursements || 0) !== 0 || (t.cashCollected || 0) !== 0
          if (!payoutBatchId && !hasActivity) {
            skipped.push({ teamMemberId: memberId, reason: 'no activity in period' })
            continue
          }

          const { data: row, error: insErr } = await supabase.from('paystubs').insert({
            user_id: userId,
            team_member_id: memberId,
            payout_batch_id: payoutBatchId,
            period_start: snapshot.period.start,
            period_end: snapshot.period.end,
            status: 'issued',
            issued_at: new Date().toISOString(),
            snapshot_json: snapshot,
            created_by: userId,
          }).select().single()

          if (insErr) {
            errors.push({ teamMemberId: memberId, error: insErr.message })
            continue
          }
          created.push(row)
        } catch (e) {
          errors.push({ teamMemberId: memberId, error: e.message || 'Unknown error' })
        }
      }

      res.json({
        created,
        skipped,
        errors,
        summary: { createdCount: created.length, skippedCount: skipped.length, errorCount: errors.length },
      })
    } catch (e) {
      logger.error('[Paystubs] Bulk generate error:', e.message)
      res.status(500).json({ error: e.message || 'Failed to bulk generate paystubs' })
    }
  })

  // ══════════════════════════════════════
  // POST /api/paystubs/bulk/send — send many paystubs in one call
  // Body: { paystubIds?: number[], includeSent?: boolean }
  // - paystubIds empty/missing → all paystubs with status in ['issued','failed'] for this user
  //   (if includeSent=true, also includes 'sent' status → resend)
  // ══════════════════════════════════════
  router.post('/bulk/send', async (req, res) => {
    try {
      const userId = req.user.userId
      const { paystubIds, includeSent = false } = req.body || {}

      let ids = Array.isArray(paystubIds) && paystubIds.length > 0
        ? paystubIds.map(id => parseInt(id)).filter(Boolean)
        : null

      if (!ids) {
        const statuses = includeSent ? ['issued', 'failed', 'sent'] : ['issued', 'failed']
        const { data: rows } = await supabase.from('paystubs')
          .select('id').eq('user_id', userId).in('status', statuses)
        ids = (rows || []).map(r => r.id)
      }

      const sent = []
      const skipped = []
      const errors = []

      for (const id of ids) {
        const result = await sendOnePaystub(userId, id)
        if (result.ok) sent.push(result.paystub)
        else if (result.status === 400) skipped.push({ paystubId: id, reason: result.error })
        else errors.push({ paystubId: id, error: result.error })
      }

      res.json({
        sent,
        skipped,
        errors,
        summary: { sentCount: sent.length, skippedCount: skipped.length, errorCount: errors.length },
      })
    } catch (e) {
      logger.error('[Paystubs] Bulk send error:', e.message)
      res.status(500).json({ error: e.message || 'Failed to bulk send paystubs' })
    }
  })

  const sendHandler = async (req, res) => {
    const userId = req.user.userId
    const result = await sendOnePaystub(userId, req.params.id)
    if (result.ok) return res.json(result.paystub)
    return res.status(result.status || 500).json({ error: result.error })
  }

  router.post('/:id/send', sendHandler)
  router.post('/:id/resend', sendHandler)

  // ══════════════════════════════════════
  // GET /api/paystubs/:id/html — printable HTML
  // ══════════════════════════════════════
  router.get('/:id/html', async (req, res) => {
    try {
      const userId = req.user.userId
      const { data: paystub } = await supabase.from('paystubs')
        .select('snapshot_json').eq('id', req.params.id).eq('user_id', userId).maybeSingle()
      if (!paystub) return res.status(404).send('Paystub not found')
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.send(renderPaystubHtml(paystub.snapshot_json || {}))
    } catch (e) {
      res.status(500).send('Error rendering paystub')
    }
  })

  // ══════════════════════════════════════
  // GET /api/paystubs/:id/pdf — downloadable PDF
  // ══════════════════════════════════════
  router.get('/:id/pdf', async (req, res) => {
    try {
      const userId = req.user.userId
      const { data: paystub } = await supabase.from('paystubs')
        .select('snapshot_json, period_start, period_end').eq('id', req.params.id).eq('user_id', userId).maybeSingle()
      if (!paystub) return res.status(404).json({ error: 'Paystub not found' })

      const pdfBuffer = await renderPaystubPdfBuffer(paystub.snapshot_json || {})
      const safePeriod = `${paystub.period_start || 'period'}_${paystub.period_end || ''}`.replace(/[^0-9A-Za-z_-]/g, '')
      res.setHeader('Content-Type', 'application/pdf')
      res.setHeader('Content-Disposition', `attachment; filename="paystub_${safePeriod}.pdf"`)
      res.setHeader('Cache-Control', 'no-cache')
      res.send(pdfBuffer)
    } catch (e) {
      logger.error('[Paystubs] PDF render error:', e.message)
      res.status(500).json({ error: 'Error rendering paystub PDF' })
    }
  })

  // ══════════════════════════════════════
  // DELETE /api/paystubs/:id — delete
  // ══════════════════════════════════════
  router.delete('/:id', async (req, res) => {
    try {
      const userId = req.user.userId
      const { error } = await supabase.from('paystubs').delete()
        .eq('id', req.params.id).eq('user_id', userId)
      if (error) return res.status(500).json({ error: error.message })
      res.json({ success: true })
    } catch (e) {
      logger.error('[Paystubs] Delete error:', e.message)
      res.status(500).json({ error: 'Failed to delete paystub' })
    }
  })

  // Export helpers for unit tests
  router.__helpers = {
    aggregateLedgerEntries,
    renderPaystubHtml,
    renderPaystubSummaryHtml,
    renderPaystubText,
    renderPaystubPdfBuffer,
    escapeHtml,
    formatDate,
  }

  return router
}

// Export helpers statically too for pure-function testing
module.exports.aggregateLedgerEntries = function aggregateLedgerEntries(entries, jobLookup = {}) {
  const totals = {
    earnings: 0, managerSalary: 0, managerCommission: 0,
    tips: 0, incentives: 0, adjustments: 0, reimbursements: 0, cashCollected: 0, netPayout: 0,
  }
  const lineItemsByJob = new Map()
  const managerSalaryItems = []
  const managerCommissionItems = []
  const toNum = (v) => { const n = parseFloat(v); return isNaN(n) ? 0 : n }

  for (const entry of (entries || [])) {
    const amt = toNum(entry.amount)
    const type = (entry.type || '').toLowerCase()
    const meta = entry.metadata || {}
    if (type === 'payout') continue

    if (type === 'earning' && !entry.job_id && (meta.is_manager_salary || meta.is_manager_commission)) {
      if (meta.is_manager_salary) {
        totals.managerSalary += amt
        managerSalaryItems.push({
          date: entry.effective_date || null, hours: toNum(meta.scheduled_hours),
          rate: toNum(meta.hourly_rate), amount: amt, note: entry.note || '',
        })
      } else if (meta.is_manager_commission) {
        totals.managerCommission += amt
        managerCommissionItems.push({
          date: entry.effective_date || null, dayRevenue: toNum(meta.day_revenue),
          commissionPct: toNum(meta.commission_pct), amount: amt, note: entry.note || '',
        })
      }
      continue
    }

    if (type === 'earning') totals.earnings += amt
    else if (type === 'tip') totals.tips += amt
    else if (type === 'incentive') totals.incentives += amt
    else if (type === 'adjustment') totals.adjustments += amt
    else if (type === 'reimbursement') totals.reimbursements += amt
    else if (type === 'cash_collected' || type === 'cash_to_company') totals.cashCollected += amt

    if (entry.job_id) {
      const key = entry.job_id
      if (!lineItemsByJob.has(key)) {
        const job = jobLookup[key] || {}
        lineItemsByJob.set(key, {
          jobId: key, date: job.scheduled_date || null, service: job.service_name || '',
          customerName: job.customer_name || '', hours: toNum(job.hours),
          earning: 0, tip: 0, incentive: 0, reimbursement: 0, cashCollected: 0,
        })
      }
      const item = lineItemsByJob.get(key)
      if (type === 'earning') item.earning += amt
      else if (type === 'tip') item.tip += amt
      else if (type === 'incentive') item.incentive += amt
      else if (type === 'reimbursement') item.reimbursement += amt
      else if (type === 'cash_collected' || type === 'cash_to_company') item.cashCollected += amt
    }
  }

  totals.netPayout =
    totals.earnings + totals.managerSalary + totals.managerCommission +
    totals.tips + totals.incentives + totals.adjustments +
    totals.reimbursements + totals.cashCollected
  for (const k of Object.keys(totals)) totals[k] = parseFloat(totals[k].toFixed(2))

  const byDate = (a, b) => {
    const da = a.date ? new Date(a.date).getTime() : 0
    const db = b.date ? new Date(b.date).getTime() : 0
    return da - db
  }
  const lineItems = Array.from(lineItemsByJob.values()).sort(byDate)
  managerSalaryItems.sort(byDate)
  managerCommissionItems.sort(byDate)
  return { totals, lineItems, managerSalaryItems, managerCommissionItems }
}

module.exports.escapeHtml = function escapeHtml(str) {
  if (str == null) return ''
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}
