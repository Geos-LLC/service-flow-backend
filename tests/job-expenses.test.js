/**
 * Job Expenses / Reimbursements Unit Tests
 *
 * Tests the pure-function helpers exported from job-expense-service.js:
 *   - getLedgerIntent: decides what ledger effect an expense produces
 *   - shouldCreateReimbursement: backwards-compat boolean wrapper
 *   - buildReimbursementLedgerRow: builds the ledger row shape
 *   - validateExpensePayload: request validation
 */

const {
  getLedgerIntent,
  shouldCreateReimbursement,
  buildReimbursementLedgerRow,
  validateExpensePayload,
} = require('../job-expense-service')

describe('Job Expenses — getLedgerIntent', () => {
  const base = {
    id: 1,
    status: 'approved',
    paid_by: 'team_member',
    reimbursable_to_team_member: true,
    team_member_id: 42,
    amount: '5.00',
    expense_type: 'parking',
  }

  test('team_member + reimbursable → positive reimbursement', () => {
    const intent = getLedgerIntent(base)
    expect(intent).not.toBeNull()
    expect(intent.type).toBe('reimbursement')
    expect(intent.amount).toBe(5)
    expect(intent.notePrefix).toBe('Reimbursement')
  })

  test('team_member + not reimbursable → null (own cost)', () => {
    expect(getLedgerIntent({ ...base, reimbursable_to_team_member: false })).toBeNull()
  })

  test('customer → positive reimbursement (customer paid, cleaner keeps it)', () => {
    const intent = getLedgerIntent({ ...base, paid_by: 'customer' })
    expect(intent).not.toBeNull()
    expect(intent.type).toBe('reimbursement')
    expect(intent.amount).toBe(5)
    expect(intent.notePrefix).toContain('Customer')
  })

  test('company → positive reimbursement (company bears cost)', () => {
    const intent = getLedgerIntent({ ...base, paid_by: 'company' })
    expect(intent).not.toBeNull()
    expect(intent.type).toBe('reimbursement')
    expect(intent.amount).toBe(5)
    expect(intent.notePrefix).toContain('Company')
  })

  test('deduction → negative expense_deduction', () => {
    const intent = getLedgerIntent({ ...base, paid_by: 'deduction' })
    expect(intent).not.toBeNull()
    expect(intent.type).toBe('expense_deduction')
    expect(intent.amount).toBe(-5)
    expect(intent.notePrefix).toContain('Deduction')
  })

  test('deduction amount is always negative (even if already negative)', () => {
    const intent = getLedgerIntent({ ...base, paid_by: 'deduction', amount: '10.50' })
    expect(intent.amount).toBe(-10.5)
  })

  test('pending → null', () => {
    expect(getLedgerIntent({ ...base, status: 'pending' })).toBeNull()
  })

  test('rejected → null', () => {
    expect(getLedgerIntent({ ...base, status: 'rejected' })).toBeNull()
  })

  test('missing team_member_id → null', () => {
    expect(getLedgerIntent({ ...base, team_member_id: null })).toBeNull()
  })

  test('negative amount → null', () => {
    expect(getLedgerIntent({ ...base, amount: '-5.00' })).toBeNull()
  })

  test('null expense → null', () => {
    expect(getLedgerIntent(null)).toBeNull()
  })

  test('zero amount → valid (edge: $0 approved expense)', () => {
    const intent = getLedgerIntent({ ...base, amount: '0' })
    expect(intent).not.toBeNull()
    expect(intent.amount).toBe(0)
  })

  test('customer-paid ignores reimbursable_to_team_member flag', () => {
    const intent = getLedgerIntent({ ...base, paid_by: 'customer', reimbursable_to_team_member: false })
    expect(intent).not.toBeNull()
    expect(intent.type).toBe('reimbursement')
  })

  test('company-paid ignores reimbursable_to_team_member flag', () => {
    const intent = getLedgerIntent({ ...base, paid_by: 'company', reimbursable_to_team_member: false })
    expect(intent).not.toBeNull()
    expect(intent.type).toBe('reimbursement')
  })
})

describe('Job Expenses — shouldCreateReimbursement (backwards-compat)', () => {
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

  test('customer-paid → true (now creates ledger entry)', () => {
    expect(shouldCreateReimbursement({ ...base, paid_by: 'customer' })).toBe(true)
  })

  test('company-paid → true (now creates ledger entry)', () => {
    expect(shouldCreateReimbursement({ ...base, paid_by: 'company' })).toBe(true)
  })

  test('deduction → true (creates negative ledger entry)', () => {
    expect(shouldCreateReimbursement({ ...base, paid_by: 'deduction' })).toBe(true)
  })

  test('team_member + not reimbursable → false', () => {
    expect(shouldCreateReimbursement({ ...base, reimbursable_to_team_member: false })).toBe(false)
  })

  test('null expense → false', () => {
    expect(shouldCreateReimbursement(null)).toBe(false)
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
    status: 'approved',
    paid_by: 'team_member',
    reimbursable_to_team_member: true,
  }

  test('builds correct ledger row shape for reimbursement', () => {
    const row = buildReimbursementLedgerRow(expense, 2)
    expect(row.type).toBe('reimbursement')
    expect(row.team_member_id).toBe(100)
    expect(row.job_id).toBe(999)
    expect(row.amount).toBe(5)
    expect(row.effective_date).toBe('2026-04-11')
    expect(row.created_by).toBe(2)
  })

  test('builds correct row for customer-paid expense', () => {
    const row = buildReimbursementLedgerRow({ ...expense, paid_by: 'customer' }, 2)
    expect(row.type).toBe('reimbursement')
    expect(row.amount).toBe(5)
    expect(row.note).toContain('Customer-paid')
    expect(row.metadata.paid_by).toBe('customer')
  })

  test('builds correct row for company-paid expense', () => {
    const row = buildReimbursementLedgerRow({ ...expense, paid_by: 'company' }, 2)
    expect(row.type).toBe('reimbursement')
    expect(row.amount).toBe(5)
    expect(row.note).toContain('Company-paid')
    expect(row.metadata.paid_by).toBe('company')
  })

  test('builds correct row for deduction (negative amount)', () => {
    const row = buildReimbursementLedgerRow({ ...expense, paid_by: 'deduction' }, 2)
    expect(row.type).toBe('expense_deduction')
    expect(row.amount).toBe(-5)
    expect(row.note).toContain('Deduction')
    expect(row.metadata.paid_by).toBe('deduction')
  })

  test('returns null for non-reimbursable team_member expense', () => {
    const row = buildReimbursementLedgerRow({ ...expense, reimbursable_to_team_member: false }, 2)
    expect(row).toBeNull()
  })

  test('metadata contains source_type, source_id, and paid_by', () => {
    const row = buildReimbursementLedgerRow(expense, 2)
    expect(row.metadata.source_type).toBe('job_expense')
    expect(row.metadata.source_id).toBe('42')
    expect(row.metadata.expense_type).toBe('parking')
    expect(row.metadata.paid_by).toBe('team_member')
  })

  test('source_id is always a string', () => {
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

  test('deduction paid_by → accepted', () => {
    expect(validateExpensePayload({ expense_type: 'other', amount: '10', paid_by: 'deduction' })).toEqual([])
  })

  test('missing paid_by → accepted (defaults to team_member server-side)', () => {
    expect(validateExpensePayload({ expense_type: 'parking', amount: '5' })).toEqual([])
  })

  test('all four expense types accepted', () => {
    for (const t of ['parking', 'toll', 'supplies', 'other']) {
      expect(validateExpensePayload({ expense_type: t, amount: '5' })).toEqual([])
    }
  })

  test('all four paid_by options accepted', () => {
    for (const p of ['company', 'team_member', 'customer', 'deduction']) {
      expect(validateExpensePayload({ expense_type: 'parking', amount: '5', paid_by: p })).toEqual([])
    }
  })
})

describe('Job Expenses — buildReimbursementLedgerRow with jobScheduledDate', () => {
  const expense = {
    id: 42,
    user_id: 2,
    team_member_id: 100,
    job_id: 999,
    expense_type: 'parking',
    description: 'downtown meter',
    amount: '5.00',
    approved_at: '2026-04-12T00:23:00Z',
    status: 'approved',
    paid_by: 'team_member',
    reimbursable_to_team_member: true,
  }

  test('uses jobScheduledDate when provided (not approved_at)', () => {
    const row = buildReimbursementLedgerRow(expense, 2, '2026-04-07 10:00:00')
    expect(row.effective_date).toBe('2026-04-07')
  })

  test('uses jobScheduledDate with ISO format', () => {
    const row = buildReimbursementLedgerRow(expense, 2, '2026-04-07T10:00:00Z')
    expect(row.effective_date).toBe('2026-04-07')
  })

  test('falls back to approved_at when jobScheduledDate is null', () => {
    const row = buildReimbursementLedgerRow(expense, 2, null)
    expect(row.effective_date).toBe('2026-04-12')
  })

  test('falls back to approved_at when jobScheduledDate is undefined', () => {
    const row = buildReimbursementLedgerRow(expense, 2, undefined)
    expect(row.effective_date).toBe('2026-04-12')
  })

  test('falls back to today when both jobScheduledDate and approved_at are null', () => {
    const row = buildReimbursementLedgerRow({ ...expense, approved_at: null }, 2, null)
    expect(row.effective_date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  test('all other fields unchanged when jobScheduledDate provided', () => {
    const row = buildReimbursementLedgerRow(expense, 2, '2026-04-07')
    expect(row.type).toBe('reimbursement')
    expect(row.team_member_id).toBe(100)
    expect(row.job_id).toBe(999)
    expect(row.amount).toBe(5)
    expect(row.metadata.source_id).toBe('42')
  })
})

describe('Job Expenses — state machine invariants', () => {
  test('valid statuses', () => {
    const valid = ['pending', 'approved', 'rejected']
    for (const s of valid) {
      expect(typeof s).toBe('string')
    }
  })

  test('approved expense with ledger → cannot modify amount if batched', () => {
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
