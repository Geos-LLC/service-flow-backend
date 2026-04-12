/**
 * Job Expenses / Reimbursements Module (Loosely Coupled)
 *
 * Mount: app.use('/api', require('./job-expense-service')(supabase, logger))
 * Remove: delete this file + remove the line above = zero breakage
 *
 * Tracks cleaner out-of-pocket expenses (parking, tolls, supplies) and
 * reimburses them through the existing payroll/ledger system.
 *
 * Architecture:
 *   - job_expenses is the source of truth for expense records
 *   - Approving an expense creates an idempotent cleaner_ledger entry of type
 *     'reimbursement' with metadata.source_type='job_expense', source_id=expense.id
 *   - Partial unique index on the DB enforces one ledger row per source_id
 *   - Payroll/paystub/payout read the ledger as usual — reimbursements flow
 *     through without special-case logic in those modules
 *
 * Business rules:
 *   - Only creates a ledger row when: paid_by=team_member + reimbursable + approved + has team_member_id
 *   - Reject after approve → delete ledger row (if unbatched)
 *   - Delete approved expense → delete ledger row (if unbatched)
 *   - Edit amount on approved + batched → 409, cannot modify settled history
 */

const express = require('express')

module.exports = (supabase, logger) => {
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
  // Auth is applied per-route below (NOT router.use) to avoid intercepting
  // other /api/* routes like /api/auth/signin and /api/health.

  // ══════════════════════════════════════════════════════════════
  // Validation helpers
  // ══════════════════════════════════════════════════════════════
  const VALID_EXPENSE_TYPES = ['parking', 'toll', 'supplies', 'other']
  const VALID_PAID_BY = ['company', 'team_member', 'customer']

  function validateExpensePayload(body) {
    const errors = []
    if (!body.expense_type || !VALID_EXPENSE_TYPES.includes(body.expense_type)) {
      errors.push(`expense_type must be one of: ${VALID_EXPENSE_TYPES.join(', ')}`)
    }
    const amt = parseFloat(body.amount)
    if (isNaN(amt) || amt < 0) {
      errors.push('amount must be a non-negative number')
    }
    if (body.paid_by && !VALID_PAID_BY.includes(body.paid_by)) {
      errors.push(`paid_by must be one of: ${VALID_PAID_BY.join(', ')}`)
    }
    return errors
  }

  // ══════════════════════════════════════════════════════════════
  // Idempotent ledger sync
  // ══════════════════════════════════════════════════════════════

  /**
   * Sync the reimbursement ledger entry for an expense.
   * Pure idempotent: calling this multiple times with the same approved expense
   * results in exactly one ledger row. Matches by metadata.source_id.
   *
   * Returns { action: 'created'|'updated'|'skipped'|'locked', ledgerId?, reason? }
   */
  async function syncReimbursementLedger(expense, userId) {
    // Only reimbursable team-member expenses in approved state create ledger entries
    if (!expense.reimbursable_to_team_member) return { action: 'skipped', reason: 'not_reimbursable' }
    if (expense.paid_by !== 'team_member') return { action: 'skipped', reason: 'paid_by_not_team_member' }
    if (expense.status !== 'approved') return { action: 'skipped', reason: 'not_approved' }
    if (!expense.team_member_id) return { action: 'skipped', reason: 'no_team_member' }

    // Use the job's scheduled_date so the reimbursement falls in the same payroll period
    let effectiveDate = (expense.approved_at || new Date().toISOString()).split('T')[0]
    if (expense.job_id) {
      const { data: job } = await supabase.from('jobs').select('scheduled_date').eq('id', expense.job_id).maybeSingle()
      if (job?.scheduled_date) effectiveDate = String(job.scheduled_date).split('T')[0].split(' ')[0]
    }

    // Check for existing ledger row by metadata.source_id (idempotency key)
    const { data: existing } = await supabase.from('cleaner_ledger')
      .select('id, payout_batch_id, amount')
      .eq('type', 'reimbursement')
      .eq('metadata->>source_type', 'job_expense')
      .eq('metadata->>source_id', String(expense.id))
      .maybeSingle()

    const row = {
      user_id: userId,
      team_member_id: expense.team_member_id,
      job_id: expense.job_id,
      type: 'reimbursement',
      amount: parseFloat(expense.amount),
      effective_date: effectiveDate,
      note: `Reimbursement: ${expense.expense_type}${expense.description ? ' — ' + expense.description : ''}`,
      metadata: { source_type: 'job_expense', source_id: String(expense.id), expense_type: expense.expense_type },
      created_by: userId,
    }

    if (existing) {
      // If already settled in a payout batch, we cannot modify the historical row.
      // Admin must handle via a separate adjustment entry.
      if (existing.payout_batch_id) {
        return { action: 'locked', ledgerId: existing.id, reason: 'already_in_payout_batch' }
      }
      // Only update if something actually changed
      if (parseFloat(existing.amount) === row.amount) {
        return { action: 'skipped', ledgerId: existing.id, reason: 'unchanged' }
      }
      const { error } = await supabase.from('cleaner_ledger').update(row).eq('id', existing.id)
      if (error) throw new Error(`Ledger update failed: ${error.message}`)
      return { action: 'updated', ledgerId: existing.id }
    }

    const { data: inserted, error } = await supabase.from('cleaner_ledger').insert(row).select('id').single()
    if (error) throw new Error(`Ledger insert failed: ${error.message}`)
    return { action: 'created', ledgerId: inserted.id }
  }

  /**
   * Remove the reimbursement ledger entry for an expense.
   * Only deletes if not yet included in a settled payout batch.
   */
  async function removeReimbursementLedger(expenseId) {
    const { data: existing } = await supabase.from('cleaner_ledger')
      .select('id, payout_batch_id')
      .eq('type', 'reimbursement')
      .eq('metadata->>source_type', 'job_expense')
      .eq('metadata->>source_id', String(expenseId))
      .maybeSingle()

    if (!existing) return { action: 'skipped', reason: 'not_found' }
    if (existing.payout_batch_id) return { action: 'locked', reason: 'already_in_payout_batch' }

    const { error } = await supabase.from('cleaner_ledger').delete().eq('id', existing.id)
    if (error) throw new Error(`Ledger delete failed: ${error.message}`)
    return { action: 'removed', ledgerId: existing.id }
  }

  // ══════════════════════════════════════
  // GET /api/jobs/:jobId/expenses — list
  // ══════════════════════════════════════
  router.get('/jobs/:jobId/expenses', authenticateToken, async (req, res) => {
    try {
      const userId = req.user.userId
      const jobId = parseInt(req.params.jobId)
      if (isNaN(jobId)) return res.status(400).json({ error: 'Invalid job ID' })

      const { data, error } = await supabase.from('job_expenses')
        .select('*, team_members(id, first_name, last_name)')
        .eq('user_id', userId)
        .eq('job_id', jobId)
        .order('created_at', { ascending: false })

      if (error) return res.status(500).json({ error: error.message })
      res.json({ expenses: data || [] })
    } catch (e) {
      logger.error('[JobExpenses] List error:', e.message)
      res.status(500).json({ error: 'Failed to list expenses' })
    }
  })

  // ══════════════════════════════════════
  // POST /api/jobs/:jobId/expenses — create
  // ══════════════════════════════════════
  router.post('/jobs/:jobId/expenses', authenticateToken, async (req, res) => {
    try {
      const userId = req.user.userId
      const jobId = parseInt(req.params.jobId)
      if (isNaN(jobId)) return res.status(400).json({ error: 'Invalid job ID' })

      const errors = validateExpensePayload(req.body)
      if (errors.length > 0) return res.status(400).json({ error: errors.join('; ') })

      // Verify job exists and belongs to user
      const { data: job } = await supabase.from('jobs').select('id').eq('id', jobId).eq('user_id', userId).maybeSingle()
      if (!job) return res.status(404).json({ error: 'Job not found' })

      const row = {
        user_id: userId,
        job_id: jobId,
        team_member_id: req.body.team_member_id ? parseInt(req.body.team_member_id) : null,
        expense_type: req.body.expense_type,
        description: req.body.description || null,
        amount: parseFloat(req.body.amount),
        paid_by: req.body.paid_by || 'team_member',
        customer_billable: !!req.body.customer_billable,
        reimbursable_to_team_member: req.body.reimbursable_to_team_member !== false,
        status: 'pending',
        note: req.body.note || null,
        created_by: userId,
      }

      const { data: created, error } = await supabase.from('job_expenses').insert(row).select().single()
      if (error) return res.status(500).json({ error: error.message })
      res.json(created)
    } catch (e) {
      logger.error('[JobExpenses] Create error:', e.message)
      res.status(500).json({ error: 'Failed to create expense' })
    }
  })

  // ══════════════════════════════════════
  // PATCH /api/job-expenses/:id — edit
  // ══════════════════════════════════════
  router.patch('/job-expenses/:id', authenticateToken, async (req, res) => {
    try {
      const userId = req.user.userId
      const id = parseInt(req.params.id)
      if (isNaN(id)) return res.status(400).json({ error: 'Invalid expense ID' })

      const { data: existing } = await supabase.from('job_expenses')
        .select('*').eq('id', id).eq('user_id', userId).maybeSingle()
      if (!existing) return res.status(404).json({ error: 'Expense not found' })

      // If approved + batched, refuse to edit financial fields
      if (existing.status === 'approved') {
        const { data: ledgerRow } = await supabase.from('cleaner_ledger')
          .select('payout_batch_id')
          .eq('type', 'reimbursement')
          .eq('metadata->>source_type', 'job_expense')
          .eq('metadata->>source_id', String(id))
          .maybeSingle()
        if (ledgerRow?.payout_batch_id && req.body.amount !== undefined && parseFloat(req.body.amount) !== parseFloat(existing.amount)) {
          return res.status(409).json({ error: 'Cannot modify amount — reimbursement already settled in a payout batch. Create an adjustment instead.' })
        }
      }

      // Build update payload (allow partial update)
      const update = { updated_at: new Date().toISOString() }
      const allowed = ['expense_type', 'description', 'amount', 'paid_by', 'customer_billable', 'reimbursable_to_team_member', 'note', 'team_member_id']
      for (const k of allowed) {
        if (req.body[k] !== undefined) update[k] = req.body[k]
      }
      if (update.amount !== undefined) update.amount = parseFloat(update.amount)
      if (update.team_member_id !== undefined && update.team_member_id !== null) update.team_member_id = parseInt(update.team_member_id)

      // Validate partial
      const merged = { ...existing, ...update }
      const errors = validateExpensePayload(merged)
      if (errors.length > 0) return res.status(400).json({ error: errors.join('; ') })

      const { data: updated, error } = await supabase.from('job_expenses').update(update).eq('id', id).select().single()
      if (error) return res.status(500).json({ error: error.message })

      // If approved, re-sync ledger (idempotent)
      if (updated.status === 'approved') {
        try { await syncReimbursementLedger(updated, userId) } catch (e) {
          logger.error('[JobExpenses] Ledger re-sync error:', e.message)
        }
      }

      res.json(updated)
    } catch (e) {
      logger.error('[JobExpenses] Update error:', e.message)
      res.status(500).json({ error: 'Failed to update expense' })
    }
  })

  // ══════════════════════════════════════
  // POST /api/job-expenses/:id/approve
  // ══════════════════════════════════════
  router.post('/job-expenses/:id/approve', authenticateToken, async (req, res) => {
    try {
      const userId = req.user.userId
      const id = parseInt(req.params.id)
      if (isNaN(id)) return res.status(400).json({ error: 'Invalid expense ID' })

      const { data: existing } = await supabase.from('job_expenses')
        .select('*').eq('id', id).eq('user_id', userId).maybeSingle()
      if (!existing) return res.status(404).json({ error: 'Expense not found' })

      if (existing.status === 'approved') {
        // Already approved — re-sync ledger (idempotent) and return current state
        try { await syncReimbursementLedger(existing, userId) } catch (e) { /* non-fatal */ }
        return res.json(existing)
      }

      const { data: updated, error } = await supabase.from('job_expenses').update({
        status: 'approved',
        approved_at: new Date().toISOString(),
        approved_by: userId,
        updated_at: new Date().toISOString(),
      }).eq('id', id).select().single()
      if (error) return res.status(500).json({ error: error.message })

      // Create ledger entry
      try {
        const result = await syncReimbursementLedger(updated, userId)
        logger.log(`[JobExpenses] Approved expense ${id}: ledger ${result.action} (${result.ledgerId || 'n/a'})`)
      } catch (e) {
        logger.error(`[JobExpenses] Ledger sync error after approve ${id}: ${e.message}`)
        // Expense approval succeeds even if ledger fails — admin can retry
      }

      res.json(updated)
    } catch (e) {
      logger.error('[JobExpenses] Approve error:', e.message)
      res.status(500).json({ error: 'Failed to approve expense' })
    }
  })

  // ══════════════════════════════════════
  // POST /api/job-expenses/:id/reject
  // ══════════════════════════════════════
  router.post('/job-expenses/:id/reject', authenticateToken, async (req, res) => {
    try {
      const userId = req.user.userId
      const id = parseInt(req.params.id)
      if (isNaN(id)) return res.status(400).json({ error: 'Invalid expense ID' })

      const { data: existing } = await supabase.from('job_expenses')
        .select('*').eq('id', id).eq('user_id', userId).maybeSingle()
      if (!existing) return res.status(404).json({ error: 'Expense not found' })

      // Try to remove ledger row first (if previously approved)
      let ledgerResult = { action: 'skipped' }
      if (existing.status === 'approved') {
        try {
          ledgerResult = await removeReimbursementLedger(id)
          if (ledgerResult.action === 'locked') {
            return res.status(409).json({ error: 'Cannot reject — reimbursement already settled in a payout batch. Create a compensating adjustment instead.' })
          }
        } catch (e) {
          logger.error(`[JobExpenses] Ledger removal error on reject ${id}: ${e.message}`)
        }
      }

      const { data: updated, error } = await supabase.from('job_expenses').update({
        status: 'rejected',
        updated_at: new Date().toISOString(),
      }).eq('id', id).select().single()
      if (error) return res.status(500).json({ error: error.message })

      logger.log(`[JobExpenses] Rejected expense ${id}: ledger ${ledgerResult.action}`)
      res.json(updated)
    } catch (e) {
      logger.error('[JobExpenses] Reject error:', e.message)
      res.status(500).json({ error: 'Failed to reject expense' })
    }
  })

  // ══════════════════════════════════════
  // DELETE /api/job-expenses/:id
  // ══════════════════════════════════════
  router.delete('/job-expenses/:id', authenticateToken, async (req, res) => {
    try {
      const userId = req.user.userId
      const id = parseInt(req.params.id)
      if (isNaN(id)) return res.status(400).json({ error: 'Invalid expense ID' })

      const { data: existing } = await supabase.from('job_expenses')
        .select('*').eq('id', id).eq('user_id', userId).maybeSingle()
      if (!existing) return res.status(404).json({ error: 'Expense not found' })

      // Try to remove ledger row first (if approved)
      if (existing.status === 'approved') {
        try {
          const result = await removeReimbursementLedger(id)
          if (result.action === 'locked') {
            return res.status(409).json({ error: 'Cannot delete — reimbursement already settled in a payout batch. Create a compensating adjustment instead.' })
          }
        } catch (e) {
          logger.error(`[JobExpenses] Ledger removal error on delete ${id}: ${e.message}`)
        }
      }

      const { error } = await supabase.from('job_expenses').delete().eq('id', id)
      if (error) return res.status(500).json({ error: error.message })

      logger.log(`[JobExpenses] Deleted expense ${id}`)
      res.json({ success: true })
    } catch (e) {
      logger.error('[JobExpenses] Delete error:', e.message)
      res.status(500).json({ error: 'Failed to delete expense' })
    }
  })

  return router
}

// ══════════════════════════════════════════════════════════════
// Pure helpers exported for unit testing
// ══════════════════════════════════════════════════════════════

/**
 * Decide whether a given expense should produce a reimbursement ledger row.
 * Pure function — no DB. Used by tests and by the service module.
 */
module.exports.shouldCreateReimbursement = function shouldCreateReimbursement(expense) {
  if (!expense) return false
  if (!expense.reimbursable_to_team_member) return false
  if (expense.paid_by !== 'team_member') return false
  if (expense.status !== 'approved') return false
  if (!expense.team_member_id) return false
  const amt = parseFloat(expense.amount)
  if (isNaN(amt) || amt < 0) return false
  return true
}

/**
 * Build the ledger row for an expense. Pure function.
 */
module.exports.buildReimbursementLedgerRow = function buildReimbursementLedgerRow(expense, userId, jobScheduledDate) {
  const effectiveDate = jobScheduledDate
    ? String(jobScheduledDate).split('T')[0].split(' ')[0]
    : (expense.approved_at || new Date().toISOString()).split('T')[0]
  return {
    user_id: userId,
    team_member_id: expense.team_member_id,
    job_id: expense.job_id,
    type: 'reimbursement',
    amount: parseFloat(expense.amount),
    effective_date: effectiveDate,
    note: `Reimbursement: ${expense.expense_type}${expense.description ? ' — ' + expense.description : ''}`,
    metadata: {
      source_type: 'job_expense',
      source_id: String(expense.id),
      expense_type: expense.expense_type,
    },
    created_by: userId,
  }
}

/**
 * Validate expense payload. Returns array of error messages (empty = valid).
 */
module.exports.validateExpensePayload = function validateExpensePayload(body) {
  const errors = []
  const types = ['parking', 'toll', 'supplies', 'other']
  const paidByOptions = ['company', 'team_member', 'customer']
  if (!body.expense_type || !types.includes(body.expense_type)) {
    errors.push(`expense_type must be one of: ${types.join(', ')}`)
  }
  const amt = parseFloat(body.amount)
  if (isNaN(amt) || amt < 0) {
    errors.push('amount must be a non-negative number')
  }
  if (body.paid_by && !paidByOptions.includes(body.paid_by)) {
    errors.push(`paid_by must be one of: ${paidByOptions.join(', ')}`)
  }
  return errors
}
