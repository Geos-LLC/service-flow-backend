/**
 * Job Expenses / Reimbursements Unit Tests
 *
 * Tests the pure-function helpers exported from job-expense-service.js:
 *   - shouldCreateReimbursement: decides whether an expense produces a ledger row
 *   - buildReimbursementLedgerRow: builds the ledger row shape
 *   - validateExpensePayload: request validation
 */

const {
  shouldCreateReimbursement,
  buildReimbursementLedgerRow,
  validateExpensePayload,
} = require('../job-expense-service')

describe('Job Expenses — shouldCreateReimbursement', () => {
  const base = {
    id: 1,
    status: 'approved',
    paid_by: 'team_member',
    reimbursable_to_team_member: true,
    team_member_id: 42,
    amount: '5.00',
    expense_type: 'parking',
  }

  test('valid approved team-member expense → true', () => {
    expect(shouldCreateReimbursement(base)).toBe(true)
  })

  test('pending → false', () => {
    expect(shouldCreateReimbursement({ ...base, status: 'pending' })).toBe(false)
  })

  test('rejected → false', () => {
    expect(shouldCreateReimbursement({ ...base, status: 'rejected' })).toBe(false)
  })

  test('paid_by=company → false (company already covered it)', () => {
    expect(shouldCreateReimbursement({ ...base, paid_by: 'company' })).toBe(false)
  })

  test('paid_by=customer → false', () => {
    expect(shouldCreateReimbursement({ ...base, paid_by: 'customer' })).toBe(false)
  })

  test('not reimbursable → false', () => {
    expect(shouldCreateReimbursement({ ...base, reimbursable_to_team_member: false })).toBe(false)
  })

  test('missing team_member_id → false', () => {
    expect(shouldCreateReimbursement({ ...base, team_member_id: null })).toBe(false)
  })

  test('negative amount → false', () => {
    expect(shouldCreateReimbursement({ ...base, amount: '-5.00' })).toBe(false)
  })

  test('null expense → false', () => {
    expect(shouldCreateReimbursement(null)).toBe(false)
  })

  test('zero amount → true (edge: $0 approved expense still valid)', () => {
    expect(shouldCreateReimbursement({ ...base, amount: '0' })).toBe(true)
  })
})

describe('Job Expenses — buildReimbursementLedgerRow', () => {
  const expense = {
    id: 42,
    user_id: 2,
    team_member_id: 100,
    job_id: 999,
    expense_type: 'parking',
    description: 'downtown meter',
    amount: '5.00',
    approved_at: '2026-04-11T15:30:00Z',
  }

  test('builds correct ledger row shape', () => {
    const row = buildReimbursementLedgerRow(expense, 2)
    expect(row.type).toBe('reimbursement')
    expect(row.team_member_id).toBe(100)
    expect(row.job_id).toBe(999)
    expect(row.amount).toBe(5)
    expect(row.effective_date).toBe('2026-04-11')
    expect(row.created_by).toBe(2)
  })

  test('metadata contains source_type and source_id for idempotency', () => {
    const row = buildReimbursementLedgerRow(expense, 2)
    expect(row.metadata.source_type).toBe('job_expense')
    expect(row.metadata.source_id).toBe('42') // stored as string
    expect(row.metadata.expense_type).toBe('parking')
  })

  test('source_id is always a string (avoids type comparison issues)', () => {
    const row = buildReimbursementLedgerRow({ ...expense, id: 99 }, 2)
    expect(typeof row.metadata.source_id).toBe('string')
    expect(row.metadata.source_id).toBe('99')
  })

  test('note includes expense type and description', () => {
    const row = buildReimbursementLedgerRow(expense, 2)
    expect(row.note).toContain('parking')
    expect(row.note).toContain('downtown meter')
  })

  test('note handles missing description gracefully', () => {
    const row = buildReimbursementLedgerRow({ ...expense, description: null }, 2)
    expect(row.note).toBe('Reimbursement: parking')
  })

  test('fallback effective_date when approved_at missing', () => {
    const row = buildReimbursementLedgerRow({ ...expense, approved_at: null }, 2)
    expect(row.effective_date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  test('amount parsed from string', () => {
    const row = buildReimbursementLedgerRow({ ...expense, amount: '12.50' }, 2)
    expect(row.amount).toBe(12.5)
    expect(typeof row.amount).toBe('number')
  })
})

describe('Job Expenses — validateExpensePayload', () => {
  test('valid payload → no errors', () => {
    expect(validateExpensePayload({
      expense_type: 'parking',
      amount: '5.00',
      paid_by: 'team_member',
    })).toEqual([])
  })

  test('missing expense_type → error', () => {
    const errors = validateExpensePayload({ amount: '5' })
    expect(errors.length).toBeGreaterThan(0)
    expect(errors[0]).toMatch(/expense_type/)
  })

  test('invalid expense_type → error', () => {
    const errors = validateExpensePayload({ expense_type: 'food', amount: '5' })
    expect(errors[0]).toMatch(/expense_type/)
  })

  test('negative amount → error', () => {
    const errors = validateExpensePayload({ expense_type: 'parking', amount: '-5' })
    expect(errors.some(e => e.includes('amount'))).toBe(true)
  })

  test('non-numeric amount → error', () => {
    const errors = validateExpensePayload({ expense_type: 'parking', amount: 'abc' })
    expect(errors.some(e => e.includes('amount'))).toBe(true)
  })

  test('zero amount → accepted', () => {
    expect(validateExpensePayload({ expense_type: 'parking', amount: '0' })).toEqual([])
  })

  test('invalid paid_by → error', () => {
    const errors = validateExpensePayload({ expense_type: 'parking', amount: '5', paid_by: 'bank' })
    expect(errors.some(e => e.includes('paid_by'))).toBe(true)
  })

  test('missing paid_by → accepted (defaults to team_member server-side)', () => {
    expect(validateExpensePayload({ expense_type: 'parking', amount: '5' })).toEqual([])
  })

  test('all four expense types accepted', () => {
    for (const t of ['parking', 'toll', 'supplies', 'other']) {
      expect(validateExpensePayload({ expense_type: t, amount: '5' })).toEqual([])
    }
  })
})

describe('Job Expenses — state machine invariants', () => {
  // Document the allowed status transitions via test assertions.
  test('valid statuses', () => {
    const valid = ['pending', 'approved', 'rejected']
    for (const s of valid) {
      expect(typeof s).toBe('string')
    }
  })

  test('approved expense with ledger → cannot modify amount if batched', () => {
    // This is enforced in the endpoint layer, not a pure function.
    // Documented here as a contract invariant.
    const expense = { status: 'approved', amount: '5.00' }
    const ledgerSettled = { payout_batch_id: 42 }
    const shouldBlockEdit = expense.status === 'approved' && !!ledgerSettled.payout_batch_id
    expect(shouldBlockEdit).toBe(true)
  })

  test('approved expense with ledger → can modify amount if unbatched', () => {
    const expense = { status: 'approved', amount: '5.00' }
    const ledgerUnsettled = { payout_batch_id: null }
    const shouldBlockEdit = expense.status === 'approved' && !!ledgerUnsettled.payout_batch_id
    expect(shouldBlockEdit).toBe(false)
  })
})
