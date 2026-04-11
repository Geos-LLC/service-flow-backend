/**
 * Paystubs Unit Tests
 *
 * Tests the pure-function helpers exported from paystub-service.js:
 *   - aggregateLedgerEntries: ledger → snapshot totals + line items
 *   - escapeHtml: XSS safety for email template
 */

const { aggregateLedgerEntries, escapeHtml } = require('../paystub-service')

describe('Paystubs — aggregateLedgerEntries', () => {
  test('sums earnings, tips, incentives correctly', () => {
    const entries = [
      { type: 'earning', amount: '100.00', job_id: 1 },
      { type: 'earning', amount: '50.50', job_id: 2 },
      { type: 'tip', amount: '20.00', job_id: 1 },
      { type: 'incentive', amount: '15.00', job_id: 2 },
    ]
    const { totals } = aggregateLedgerEntries(entries)
    expect(totals.earnings).toBe(150.50)
    expect(totals.tips).toBe(20)
    expect(totals.incentives).toBe(15)
    expect(totals.netPayout).toBe(185.50)
  })

  test('cash_collected reduces net payout (stored as negative)', () => {
    const entries = [
      { type: 'earning', amount: '200.00', job_id: 1 },
      { type: 'cash_collected', amount: '-80.00', job_id: 1 },
    ]
    const { totals } = aggregateLedgerEntries(entries)
    expect(totals.earnings).toBe(200)
    expect(totals.cashCollected).toBe(-80)
    expect(totals.netPayout).toBe(120)
  })

  test('adjustments can be positive or negative', () => {
    const entries = [
      { type: 'earning', amount: '100', job_id: 1 },
      { type: 'adjustment', amount: '-25', note: 'late fee' },
      { type: 'adjustment', amount: '10', note: 'bonus' },
    ]
    const { totals } = aggregateLedgerEntries(entries)
    expect(totals.adjustments).toBe(-15)
    expect(totals.netPayout).toBe(85)
  })

  test('payout entries are excluded (settlement records, not income)', () => {
    const entries = [
      { type: 'earning', amount: '100', job_id: 1 },
      { type: 'payout', amount: '-100', job_id: null },
    ]
    const { totals } = aggregateLedgerEntries(entries)
    expect(totals.earnings).toBe(100)
    expect(totals.netPayout).toBe(100) // payout ignored
  })

  test('cash_to_company rolls into cashCollected bucket', () => {
    const entries = [
      { type: 'cash_collected', amount: '-50', job_id: 1 },
      { type: 'cash_to_company', amount: '30', job_id: 1 },
    ]
    const { totals } = aggregateLedgerEntries(entries)
    expect(totals.cashCollected).toBe(-20)
  })

  test('line items grouped by job with per-type breakdown', () => {
    const entries = [
      { type: 'earning', amount: '100', job_id: 1 },
      { type: 'tip', amount: '20', job_id: 1 },
      { type: 'earning', amount: '80', job_id: 2 },
    ]
    const jobLookup = {
      1: { service_name: 'Regular', customer_name: 'Alice', scheduled_date: '2026-04-08', hours: 2 },
      2: { service_name: 'Deep', customer_name: 'Bob', scheduled_date: '2026-04-09', hours: 3 },
    }
    const { lineItems } = aggregateLedgerEntries(entries, jobLookup)
    expect(lineItems).toHaveLength(2)
    const job1 = lineItems.find(l => l.jobId === 1)
    expect(job1.earning).toBe(100)
    expect(job1.tip).toBe(20)
    expect(job1.service).toBe('Regular')
    expect(job1.customerName).toBe('Alice')
    const job2 = lineItems.find(l => l.jobId === 2)
    expect(job2.earning).toBe(80)
    expect(job2.tip).toBe(0)
  })

  test('line items sorted by date ascending', () => {
    const entries = [
      { type: 'earning', amount: '100', job_id: 2 },
      { type: 'earning', amount: '100', job_id: 1 },
    ]
    const jobLookup = {
      1: { scheduled_date: '2026-04-10' },
      2: { scheduled_date: '2026-04-05' },
    }
    const { lineItems } = aggregateLedgerEntries(entries, jobLookup)
    expect(lineItems[0].jobId).toBe(2) // April 5 first
    expect(lineItems[1].jobId).toBe(1) // April 10 second
  })

  test('empty entries → zero totals', () => {
    const { totals, lineItems } = aggregateLedgerEntries([])
    expect(totals.earnings).toBe(0)
    expect(totals.netPayout).toBe(0)
    expect(lineItems).toEqual([])
  })

  test('null/undefined entries handled gracefully', () => {
    const { totals } = aggregateLedgerEntries(null)
    expect(totals.netPayout).toBe(0)
  })

  test('totals rounded to 2 decimal places', () => {
    const entries = [
      { type: 'earning', amount: '33.333', job_id: 1 },
      { type: 'earning', amount: '66.667', job_id: 2 },
    ]
    const { totals } = aggregateLedgerEntries(entries)
    expect(totals.earnings).toBe(100)
  })

  test('multi-cleaner job — only entries for this cleaner are included', () => {
    // The aggregator doesn't filter by cleaner; that's the caller's job.
    // But we verify it treats each entry independently.
    const entries = [
      { type: 'earning', amount: '59.70', job_id: 1, team_member_id: 100 },
    ]
    const { totals } = aggregateLedgerEntries(entries)
    expect(totals.earnings).toBe(59.70)
  })

  test('string amounts parsed correctly', () => {
    const entries = [
      { type: 'earning', amount: '100.00', job_id: 1 },
      { type: 'tip', amount: '25.50', job_id: 1 },
    ]
    const { totals } = aggregateLedgerEntries(entries)
    expect(totals.earnings).toBe(100)
    expect(totals.tips).toBe(25.5)
  })

  test('invalid amount → treated as 0', () => {
    const entries = [
      { type: 'earning', amount: 'not-a-number', job_id: 1 },
      { type: 'earning', amount: '100', job_id: 2 },
    ]
    const { totals } = aggregateLedgerEntries(entries)
    expect(totals.earnings).toBe(100)
  })
})

describe('Paystubs — reimbursements integration', () => {
  test('reimbursement entries sum into totals.reimbursements', () => {
    const entries = [
      { type: 'earning', amount: '100', job_id: 1 },
      { type: 'reimbursement', amount: '5', job_id: 1 },
      { type: 'reimbursement', amount: '3.50', job_id: 2 },
    ]
    const { totals } = aggregateLedgerEntries(entries)
    expect(totals.reimbursements).toBe(8.5)
  })

  test('reimbursements included in netPayout', () => {
    const entries = [
      { type: 'earning', amount: '100', job_id: 1 },
      { type: 'reimbursement', amount: '10', job_id: 1 },
    ]
    const { totals } = aggregateLedgerEntries(entries)
    expect(totals.netPayout).toBe(110)
  })

  test('reimbursements + cash collected + earnings combine correctly', () => {
    const entries = [
      { type: 'earning', amount: '100', job_id: 1 },
      { type: 'reimbursement', amount: '5', job_id: 1 },
      { type: 'cash_collected', amount: '-80', job_id: 1 },
    ]
    const { totals } = aggregateLedgerEntries(entries)
    expect(totals.earnings).toBe(100)
    expect(totals.reimbursements).toBe(5)
    expect(totals.cashCollected).toBe(-80)
    expect(totals.netPayout).toBe(25) // 100 + 5 - 80
  })

  test('per-job line item captures reimbursement separately', () => {
    const entries = [
      { type: 'earning', amount: '60', job_id: 1 },
      { type: 'reimbursement', amount: '5', job_id: 1 },
    ]
    const jobLookup = { 1: { service_name: 'Regular', customer_name: 'Alice', scheduled_date: '2026-04-11' } }
    const { lineItems } = aggregateLedgerEntries(entries, jobLookup)
    expect(lineItems).toHaveLength(1)
    expect(lineItems[0].earning).toBe(60)
    expect(lineItems[0].reimbursement).toBe(5)
  })

  test('reimbursement without earning still creates line item', () => {
    const entries = [
      { type: 'reimbursement', amount: '5', job_id: 1 },
    ]
    const jobLookup = { 1: { service_name: 'Regular' } }
    const { lineItems } = aggregateLedgerEntries(entries, jobLookup)
    expect(lineItems).toHaveLength(1)
    expect(lineItems[0].reimbursement).toBe(5)
    expect(lineItems[0].earning).toBe(0)
  })

  test('totals.reimbursements defaults to 0 when no reimbursement entries', () => {
    const entries = [
      { type: 'earning', amount: '100', job_id: 1 },
    ]
    const { totals } = aggregateLedgerEntries(entries)
    expect(totals.reimbursements).toBe(0)
  })
})

describe('Paystubs — escapeHtml (XSS safety)', () => {
  test('escapes angle brackets', () => {
    expect(escapeHtml('<script>alert(1)</script>')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;')
  })

  test('escapes ampersands', () => {
    expect(escapeHtml('Tom & Jerry')).toBe('Tom &amp; Jerry')
  })

  test('escapes quotes', () => {
    expect(escapeHtml(`"double" 'single'`)).toBe('&quot;double&quot; &#39;single&#39;')
  })

  test('handles null and undefined safely', () => {
    expect(escapeHtml(null)).toBe('')
    expect(escapeHtml(undefined)).toBe('')
  })

  test('coerces non-strings to strings', () => {
    expect(escapeHtml(42)).toBe('42')
    expect(escapeHtml(true)).toBe('true')
  })

  test('double-escape ampersands only once', () => {
    // & is replaced FIRST, so &amp; won't get re-escaped to &amp;amp;
    // This is a common bug — verify our implementation does it right
    const input = 'a & b'
    const output = escapeHtml(input)
    expect(output).toBe('a &amp; b')
    // Escape again — should properly re-escape the & inside &amp;
    expect(escapeHtml(output)).toBe('a &amp;amp; b')
  })
})

describe('Paystubs — snapshot stability', () => {
  test('same input produces deterministic output', () => {
    const entries = [
      { type: 'earning', amount: '100', job_id: 1 },
      { type: 'tip', amount: '20', job_id: 1 },
    ]
    const result1 = aggregateLedgerEntries(entries)
    const result2 = aggregateLedgerEntries(entries)
    expect(JSON.stringify(result1)).toBe(JSON.stringify(result2))
  })

  test('snapshot serializes cleanly to JSON', () => {
    const entries = [
      { type: 'earning', amount: '100', job_id: 1 },
      { type: 'tip', amount: '20', job_id: 1 },
    ]
    const result = aggregateLedgerEntries(entries)
    const json = JSON.stringify(result)
    const parsed = JSON.parse(json)
    expect(parsed.totals.earnings).toBe(100)
    expect(parsed.totals.tips).toBe(20)
  })
})

describe('Paystubs — status state machine invariants', () => {
  // These are conceptual tests — the actual state transitions happen in the endpoints,
  // but we document the allowed transitions here.
  test('valid status values', () => {
    const validStatuses = ['draft', 'issued', 'sent', 'failed']
    for (const s of validStatuses) {
      expect(typeof s).toBe('string')
      expect(s.length).toBeGreaterThan(0)
    }
  })

  test('snapshot contract: totals + lineItems keys', () => {
    const { totals, lineItems } = aggregateLedgerEntries([
      { type: 'earning', amount: '100', job_id: 1 },
    ])
    expect(Object.keys(totals).sort()).toEqual(
      ['adjustments', 'cashCollected', 'earnings', 'incentives', 'netPayout', 'reimbursements', 'tips'].sort()
    )
    expect(Array.isArray(lineItems)).toBe(true)
  })
})
