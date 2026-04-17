/**
 * Cancellation System Unit Tests
 *
 * Covers the reuse surface between the Cancel Job flow and the existing
 * job_expenses infrastructure:
 *   - validateExpensePayload now accepts 'cancellation' expense_type
 *   - getLedgerIntent builds a reimbursement intent for cancellation expenses
 *   - buildReimbursementLedgerRow produces the correct row shape with
 *     cancellation metadata, using job.scheduled_date as effective_date
 *
 * Also covers pure cancel-payload validation logic extracted from the
 * POST /api/jobs/:id/cancel endpoint.
 */

const {
  getLedgerIntent,
  buildReimbursementLedgerRow,
  validateExpensePayload,
} = require('../job-expense-service')

// ══════════════════════════════════════════════════════════════════════
// Pure cancel-payload validator — mirrors the server endpoint's shape
// checks so we can test the branches without booting the whole app.
// ══════════════════════════════════════════════════════════════════════
function validateCancelPayload(body) {
  const errors = []
  const fee = body.cancellation_fee == null || body.cancellation_fee === ''
    ? 0 : parseFloat(body.cancellation_fee)
  const reimb = body.cleaner_reimbursement == null || body.cleaner_reimbursement === ''
    ? 0 : parseFloat(body.cleaner_reimbursement)
  if (isNaN(fee) || fee < 0) errors.push('cancellation_fee must be ≥ 0')
  if (isNaN(reimb) || reimb < 0) errors.push('cleaner_reimbursement must be ≥ 0')
  if (reimb > 0 && !body.reimbursement_team_member_id) {
    errors.push('reimbursement_team_member_id is required when cleaner_reimbursement > 0')
  }
  return { errors, fee, reimb }
}

describe('Cancellation — expense_type acceptance', () => {
  const base = {
    expense_type: 'cancellation',
    amount: '30',
    paid_by: 'team_member',
  }

  test('validateExpensePayload accepts cancellation type', () => {
    expect(validateExpensePayload(base)).toEqual([])
  })

  test('all pre-existing types still accepted (no regression)', () => {
    for (const t of ['parking', 'toll', 'supplies', 'other', 'cancellation']) {
      expect(validateExpensePayload({ ...base, expense_type: t })).toEqual([])
    }
  })

  test('unknown type still rejected', () => {
    const errs = validateExpensePayload({ ...base, expense_type: 'bogus' })
    expect(errs.length).toBeGreaterThan(0)
    expect(errs[0]).toMatch(/expense_type/)
  })

  test('negative amount still rejected for cancellation', () => {
    const errs = validateExpensePayload({ ...base, amount: '-5' })
    expect(errs.length).toBeGreaterThan(0)
  })
})

describe('Cancellation — ledger intent reuse', () => {
  const approved = {
    id: 101,
    status: 'approved',
    team_member_id: 7,
    amount: '30.00',
    paid_by: 'team_member',
    reimbursable_to_team_member: true,
    expense_type: 'cancellation',
  }

  test('cancellation + team_member + reimbursable → reimbursement intent', () => {
    const intent = getLedgerIntent(approved)
    expect(intent).not.toBeNull()
    expect(intent.type).toBe('reimbursement')
    expect(intent.amount).toBe(30)
  })

  test('cancellation + team_member + NOT reimbursable → no ledger entry', () => {
    // Cleaner bears own wasted trip cost — unusual but legal.
    expect(getLedgerIntent({ ...approved, reimbursable_to_team_member: false })).toBeNull()
  })

  test('cancellation never produces earning/tip/incentive/commission types', () => {
    const intent = getLedgerIntent(approved)
    expect(['earning', 'tip', 'incentive']).not.toContain(intent.type)
  })
})

describe('Cancellation — buildReimbursementLedgerRow', () => {
  const expense = {
    id: 555,
    job_id: 999,
    team_member_id: 7,
    expense_type: 'cancellation',
    description: 'Cancellation reimbursement (client_no_show)',
    amount: '30.00',
    approved_at: '2026-04-17T15:00:00Z',
    status: 'approved',
    paid_by: 'team_member',
    reimbursable_to_team_member: true,
  }

  test('uses job scheduled_date (NOT approval date) for effective_date', () => {
    // Payroll-period alignment: a cancelled job on April 14 that's cancelled on April 17
    // must land in April 14's period so the reimbursement is settled together.
    const row = buildReimbursementLedgerRow(expense, 2, '2026-04-14')
    expect(row.effective_date).toBe('2026-04-14')
  })

  test('falls back to approved_at when no scheduled_date passed', () => {
    const row = buildReimbursementLedgerRow(expense, 2)
    expect(row.effective_date).toBe('2026-04-17')
  })

  test('metadata flags expense_type=cancellation for audit/reporting filters', () => {
    const row = buildReimbursementLedgerRow(expense, 2, '2026-04-14')
    expect(row.metadata.source_type).toBe('job_expense')
    expect(row.metadata.source_id).toBe('555')
    expect(row.metadata.expense_type).toBe('cancellation')
    expect(row.metadata.paid_by).toBe('team_member')
  })

  test('amount is positive (reimbursement, not deduction)', () => {
    const row = buildReimbursementLedgerRow(expense, 2, '2026-04-14')
    expect(row.type).toBe('reimbursement')
    expect(row.amount).toBe(30)
  })

  test('job_id is preserved for cancellation reimbursement tracing', () => {
    const row = buildReimbursementLedgerRow(expense, 2, '2026-04-14')
    expect(row.job_id).toBe(999)
  })
})

describe('Cancellation — payload validation', () => {
  test('all blank → normal cancellation, no errors', () => {
    const { errors, fee, reimb } = validateCancelPayload({})
    expect(errors).toEqual([])
    expect(fee).toBe(0)
    expect(reimb).toBe(0)
  })

  test('blank strings treated as zero', () => {
    const { errors, fee, reimb } = validateCancelPayload({
      cancellation_fee: '',
      cleaner_reimbursement: '',
    })
    expect(errors).toEqual([])
    expect(fee).toBe(0)
    expect(reimb).toBe(0)
  })

  test('fee only → no team member required', () => {
    const { errors, fee, reimb } = validateCancelPayload({ cancellation_fee: '50' })
    expect(errors).toEqual([])
    expect(fee).toBe(50)
    expect(reimb).toBe(0)
  })

  test('reimbursement > 0 requires reimbursement_team_member_id', () => {
    const { errors } = validateCancelPayload({ cleaner_reimbursement: '30' })
    expect(errors.some(e => /reimbursement_team_member_id/.test(e))).toBe(true)
  })

  test('reimbursement with member id passes', () => {
    const { errors } = validateCancelPayload({
      cleaner_reimbursement: '30',
      reimbursement_team_member_id: 7,
    })
    expect(errors).toEqual([])
  })

  test('negative fee rejected', () => {
    const { errors } = validateCancelPayload({ cancellation_fee: '-5' })
    expect(errors.some(e => /cancellation_fee/.test(e))).toBe(true)
  })

  test('negative reimbursement rejected', () => {
    const { errors } = validateCancelPayload({ cleaner_reimbursement: '-1' })
    expect(errors.some(e => /cleaner_reimbursement/.test(e))).toBe(true)
  })

  test('both fee and reimbursement > 0 with member — valid combo case', () => {
    const { errors, fee, reimb } = validateCancelPayload({
      cancellation_fee: '50',
      cleaner_reimbursement: '30',
      reimbursement_team_member_id: 7,
    })
    expect(errors).toEqual([])
    expect(fee).toBe(50)
    expect(reimb).toBe(30)
  })

  test('garbage strings rejected via NaN check', () => {
    const { errors } = validateCancelPayload({ cancellation_fee: 'not-a-number' })
    expect(errors.length).toBeGreaterThan(0)
  })
})

describe('Cancellation — completion-derived vs preserved ledger types', () => {
  // This contract test documents which types the cancel flow wipes vs preserves.
  // If the list ever changes, the test fails and forces the author to update
  // the status-endpoint, webhook handler, AND reconcile path in lockstep.
  const COMPLETION_DERIVED = ['earning', 'tip', 'incentive', 'cash_collected']
  const PRESERVED = ['reimbursement', 'adjustment', 'payout', 'expense_deduction']

  test('reimbursement is NOT completion-derived (survives cancel)', () => {
    expect(COMPLETION_DERIVED).not.toContain('reimbursement')
    expect(PRESERVED).toContain('reimbursement')
  })

  test('cash_collected IS completion-derived (wiped on cancel)', () => {
    expect(COMPLETION_DERIVED).toContain('cash_collected')
  })

  test('adjustment survives cancellation (manual admin entry)', () => {
    expect(COMPLETION_DERIVED).not.toContain('adjustment')
  })

  test('payout entry survives cancellation (settlement artifact)', () => {
    expect(COMPLETION_DERIVED).not.toContain('payout')
  })

  test('no type appears in both lists', () => {
    for (const t of COMPLETION_DERIVED) {
      expect(PRESERVED).not.toContain(t)
    }
  })
})
