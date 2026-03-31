/**
 * Tests for the payout batch system
 * Covers: batch creation, mark as paid, delete, adjust-and-rebuild,
 * balance calculations, period filtering, negative balances, and bulk operations.
 */

// ═══════════════════════════════════════════════════════════════
// Simulated payout batch logic (matches server.js behavior)
// ═══════════════════════════════════════════════════════════════

/**
 * Simulate createPayoutBatchForMember — groups unpaid entries in a period
 */
function createPayoutBatch(entries, teamMemberId, periodStart, periodEnd) {
  const unpaid = entries.filter(e =>
    e.team_member_id === teamMemberId &&
    !e.payout_batch_id &&
    e.effective_date >= periodStart &&
    e.effective_date <= periodEnd &&
    e.type !== 'payout'
  );

  if (unpaid.length === 0) {
    return { skipped: true, reason: 'No unpaid entries found for this period' };
  }

  const totalAmount = unpaid.reduce((sum, e) => sum + e.amount, 0);
  const batchId = Math.floor(Math.random() * 10000);

  // Attach entries to batch
  unpaid.forEach(e => { e.payout_batch_id = batchId; });

  return {
    skipped: false,
    batch: {
      id: batchId,
      team_member_id: teamMemberId,
      period_start: periodStart,
      period_end: periodEnd,
      status: 'pending',
      total_amount: parseFloat(totalAmount.toFixed(2))
    },
    entry_count: unpaid.length
  };
}

/**
 * Calculate balance — sum of unpaid entries (no payout_batch_id), optionally filtered by period
 */
function calculateBalance(entries, teamMemberId, startDate, endDate) {
  return entries
    .filter(e =>
      e.team_member_id === teamMemberId &&
      !e.payout_batch_id &&
      e.type !== 'payout' &&
      (!startDate || e.effective_date >= startDate) &&
      (!endDate || e.effective_date <= endDate)
    )
    .reduce((sum, e) => sum + e.amount, 0);
}

/**
 * Delete batch — detach entries, remove payout entries, remove batch
 */
function deleteBatch(entries, batchId) {
  // Detach non-payout entries
  entries.forEach(e => {
    if (e.payout_batch_id === batchId && e.type !== 'payout') {
      e.payout_batch_id = null;
    }
  });
  // Remove payout entries
  const toRemove = entries.filter(e => e.payout_batch_id === batchId && e.type === 'payout');
  toRemove.forEach(e => {
    const idx = entries.indexOf(e);
    if (idx >= 0) entries.splice(idx, 1);
  });
}

/**
 * Mark batch as paid — create a payout entry (negative amount)
 */
function markBatchPaid(entries, batch) {
  batch.status = 'paid';
  batch.paid_at = '2026-03-31';
  entries.push({
    id: Math.floor(Math.random() * 10000) + 90000,
    team_member_id: batch.team_member_id,
    type: 'payout',
    amount: -Math.abs(batch.total_amount),
    effective_date: '2026-03-31',
    payout_batch_id: batch.id
  });
}

// ═══════════════════════════════════════════════════════════════
// Test data helpers
// ═══════════════════════════════════════════════════════════════

function makeEntry(id, memberId, type, amount, date, batchId = null) {
  return { id, team_member_id: memberId, type, amount, effective_date: date, payout_batch_id: batchId };
}

// ═══════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════

describe('Payout Batch Creation', () => {
  test('creates batch from unpaid entries in period', () => {
    const entries = [
      makeEntry(1, 100, 'earning', 500, '2026-03-22'),
      makeEntry(2, 100, 'tip', 50, '2026-03-23'),
      makeEntry(3, 100, 'earning', 300, '2026-03-25'),
    ];
    const result = createPayoutBatch(entries, 100, '2026-03-22', '2026-03-28');
    expect(result.skipped).toBe(false);
    expect(result.batch.total_amount).toBe(850);
    expect(result.entry_count).toBe(3);
    expect(result.batch.status).toBe('pending');
  });

  test('skips member with no unpaid entries', () => {
    const entries = [
      makeEntry(1, 100, 'earning', 500, '2026-03-22', 999), // already in batch
    ];
    const result = createPayoutBatch(entries, 100, '2026-03-22', '2026-03-28');
    expect(result.skipped).toBe(true);
  });

  test('skips entries outside period', () => {
    const entries = [
      makeEntry(1, 100, 'earning', 500, '2026-03-15'), // before period
      makeEntry(2, 100, 'earning', 300, '2026-03-30'), // after period
    ];
    const result = createPayoutBatch(entries, 100, '2026-03-22', '2026-03-28');
    expect(result.skipped).toBe(true);
  });

  test('creates negative batch for cash-heavy member', () => {
    const entries = [
      makeEntry(1, 100, 'earning', 65.70, '2026-03-22'),
      makeEntry(2, 100, 'cash_collected', -104.50, '2026-03-22'),
    ];
    const result = createPayoutBatch(entries, 100, '2026-03-22', '2026-03-28');
    expect(result.skipped).toBe(false);
    expect(result.batch.total_amount).toBe(-38.80);
  });

  test('excludes payout-type entries from batch', () => {
    const entries = [
      makeEntry(1, 100, 'earning', 500, '2026-03-22'),
      makeEntry(2, 100, 'payout', -500, '2026-03-22'),
    ];
    const result = createPayoutBatch(entries, 100, '2026-03-22', '2026-03-28');
    expect(result.skipped).toBe(false);
    expect(result.batch.total_amount).toBe(500); // payout entry excluded
    expect(result.entry_count).toBe(1);
  });

  test('attaches entries to batch (sets payout_batch_id)', () => {
    const entries = [
      makeEntry(1, 100, 'earning', 500, '2026-03-22'),
      makeEntry(2, 100, 'tip', 50, '2026-03-23'),
    ];
    const result = createPayoutBatch(entries, 100, '2026-03-22', '2026-03-28');
    expect(entries[0].payout_batch_id).toBe(result.batch.id);
    expect(entries[1].payout_batch_id).toBe(result.batch.id);
  });
});

describe('Balance Calculation', () => {
  test('balance = sum of unpaid entries only', () => {
    const entries = [
      makeEntry(1, 100, 'earning', 500, '2026-03-22'),
      makeEntry(2, 100, 'earning', 300, '2026-03-23', 999), // in batch — excluded
      makeEntry(3, 100, 'tip', 50, '2026-03-24'),
    ];
    expect(calculateBalance(entries, 100)).toBe(550);
  });

  test('balance respects date filter', () => {
    const entries = [
      makeEntry(1, 100, 'earning', 500, '2026-03-22'),
      makeEntry(2, 100, 'earning', 300, '2026-03-25'),
      makeEntry(3, 100, 'earning', 200, '2026-03-30'),
    ];
    expect(calculateBalance(entries, 100, '2026-03-22', '2026-03-28')).toBe(800);
    expect(calculateBalance(entries, 100, '2026-03-29', '2026-04-04')).toBe(200);
    expect(calculateBalance(entries, 100)).toBe(1000); // no filter = all time
  });

  test('balance drops to zero after payout', () => {
    const entries = [
      makeEntry(1, 100, 'earning', 500, '2026-03-22'),
      makeEntry(2, 100, 'tip', 50, '2026-03-23'),
    ];
    expect(calculateBalance(entries, 100)).toBe(550);

    const result = createPayoutBatch(entries, 100, '2026-03-22', '2026-03-28');
    expect(calculateBalance(entries, 100)).toBe(0); // all attached to batch
  });

  test('balance includes cash offsets (negative)', () => {
    const entries = [
      makeEntry(1, 100, 'earning', 500, '2026-03-22'),
      makeEntry(2, 100, 'cash_collected', -180, '2026-03-23'),
    ];
    expect(calculateBalance(entries, 100)).toBe(320);
  });

  test('balance includes adjustments', () => {
    const entries = [
      makeEntry(1, 100, 'earning', 65.70, '2026-03-22'),
      makeEntry(2, 100, 'cash_collected', -104.50, '2026-03-22'),
      makeEntry(3, 100, 'adjustment', 38.80, '2026-03-31'),
    ];
    expect(calculateBalance(entries, 100)).toBeCloseTo(0, 2);
  });

  test('payroll gross != balance net when cash collected', () => {
    const entries = [
      makeEntry(1, 100, 'earning', 4723.92, '2026-03-22'),
      makeEntry(2, 100, 'tip', 126, '2026-03-23'),
      makeEntry(3, 100, 'incentive', 40, '2026-03-24'),
      makeEntry(4, 100, 'cash_collected', -180, '2026-03-25'),
    ];
    const gross = entries.filter(e => ['earning', 'tip', 'incentive'].includes(e.type))
      .reduce((s, e) => s + e.amount, 0);
    const balance = calculateBalance(entries, 100);
    expect(gross).toBe(4889.92);
    expect(balance).toBe(4709.92);
    expect(gross - balance).toBe(180); // cash collected is the difference
  });
});

describe('Delete Batch', () => {
  test('deleting batch makes entries unpaid again', () => {
    const entries = [
      makeEntry(1, 100, 'earning', 500, '2026-03-22'),
      makeEntry(2, 100, 'tip', 50, '2026-03-23'),
    ];
    const result = createPayoutBatch(entries, 100, '2026-03-22', '2026-03-28');
    const batchId = result.batch.id;

    expect(calculateBalance(entries, 100)).toBe(0);
    deleteBatch(entries, batchId);
    expect(calculateBalance(entries, 100)).toBe(550); // back to unpaid
  });

  test('deleting paid batch removes payout entry and restores balance', () => {
    const entries = [
      makeEntry(1, 100, 'earning', 500, '2026-03-22'),
    ];
    const result = createPayoutBatch(entries, 100, '2026-03-22', '2026-03-28');
    markBatchPaid(entries, result.batch);

    expect(entries.length).toBe(2); // original + payout entry
    deleteBatch(entries, result.batch.id);
    expect(entries.length).toBe(1); // payout entry removed
    expect(calculateBalance(entries, 100)).toBe(500);
  });
});

describe('Adjust and Rebuild Batch', () => {
  test('adjustment zeroes out negative batch after rebuild', () => {
    const entries = [
      makeEntry(1, 100, 'earning', 65.70, '2024-12-23'),
      makeEntry(2, 100, 'cash_collected', -104.50, '2024-12-23'),
    ];

    // Create batch — total is -38.80
    const result = createPayoutBatch(entries, 100, '2024-01-01', '2026-03-21');
    expect(result.batch.total_amount).toBe(-38.80);
    markBatchPaid(entries, result.batch);

    // Simulate adjust-and-rebuild: add adjustment, delete batch, recreate
    const adjustmentAmount = 38.80;
    entries.push(makeEntry(99, 100, 'adjustment', adjustmentAmount, '2026-03-31'));

    // Delete old batch
    deleteBatch(entries, result.batch.id);

    // Rebuild with extended period (includes today for adjustment)
    const rebuilt = createPayoutBatch(entries, 100, '2024-01-01', '2026-03-31');
    expect(rebuilt.skipped).toBe(false);
    expect(rebuilt.batch.total_amount).toBeCloseTo(0, 2);
  });

  test('adjustment period must extend to today to include it', () => {
    // Test with old period — adjustment excluded
    const entries1 = [
      makeEntry(1, 100, 'earning', 65.70, '2024-12-23'),
      makeEntry(2, 100, 'cash_collected', -104.50, '2024-12-23'),
      makeEntry(99, 100, 'adjustment', 38.80, '2026-03-31'),
    ];
    const oldPeriod = createPayoutBatch(entries1, 100, '2024-01-01', '2026-03-21');
    expect(oldPeriod.batch.total_amount).toBe(-38.80); // adjustment excluded

    // Test with extended period — adjustment included
    const entries2 = [
      makeEntry(1, 100, 'earning', 65.70, '2024-12-23'),
      makeEntry(2, 100, 'cash_collected', -104.50, '2024-12-23'),
      makeEntry(99, 100, 'adjustment', 38.80, '2026-03-31'),
    ];
    const newPeriod = createPayoutBatch(entries2, 100, '2024-01-01', '2026-03-31');
    expect(newPeriod.batch.total_amount).toBeCloseTo(0, 2);
  });
});

describe('Bulk Payout for All Members', () => {
  test('creates batches for all members with entries', () => {
    const entries = [
      makeEntry(1, 100, 'earning', 500, '2026-03-22'),
      makeEntry(2, 200, 'earning', 300, '2026-03-23'),
      makeEntry(3, 300, 'earning', 0, '2026-03-24'), // zero — still creates batch
    ];
    const memberIds = [100, 200, 300, 400]; // 400 has no entries
    const results = { created: [], skipped: [] };

    for (const mid of memberIds) {
      const result = createPayoutBatch(entries, mid, '2024-01-01', '2026-12-31');
      if (result.skipped) results.skipped.push(mid);
      else results.created.push({ id: mid, total: result.batch.total_amount });
    }

    expect(results.created.length).toBe(3);
    expect(results.skipped).toEqual([400]);
  });

  test('includes inactive members with entries', () => {
    const entries = [
      makeEntry(1, 100, 'earning', 500, '2026-03-22'),  // active
      makeEntry(2, 200, 'earning', 300, '2025-06-01'),  // inactive but has entries
    ];
    const members = [
      { id: 100, status: 'active' },
      { id: 200, status: 'inactive' },
      { id: 300, status: 'inactive' }, // no entries
    ];

    const results = [];
    for (const m of members) {
      const result = createPayoutBatch(entries, m.id, '2024-01-01', '2026-12-31');
      if (!result.skipped) results.push({ id: m.id, status: m.status, total: result.batch.total_amount });
    }

    expect(results.length).toBe(2);
    expect(results.find(r => r.id === 200).status).toBe('inactive');
  });
});

describe('Pay Period Alignment', () => {
  test('weekly periods Sun-Sat with start_day=0', () => {
    // Simulates getQuickRange logic
    const startDay = 0; // Sunday
    const today = new Date('2026-03-31T12:00:00'); // Tuesday
    const dow = today.getDay(); // 2

    const diff = (dow - startDay + 7) % 7; // 2
    const thisStart = new Date(today);
    thisStart.setDate(thisStart.getDate() - diff); // Mar 29 (Sun)
    const thisEnd = new Date(thisStart);
    thisEnd.setDate(thisEnd.getDate() + 6); // Apr 4 (Sat)

    const prevStart = new Date(thisStart);
    prevStart.setDate(prevStart.getDate() - 7); // Mar 22 (Sun)
    const prevEnd = new Date(thisStart);
    prevEnd.setDate(prevEnd.getDate() - 1); // Mar 28 (Sat)

    expect(thisStart.toISOString().split('T')[0]).toBe('2026-03-29');
    expect(thisEnd.toISOString().split('T')[0]).toBe('2026-04-04');
    expect(prevStart.toISOString().split('T')[0]).toBe('2026-03-22');
    expect(prevEnd.toISOString().split('T')[0]).toBe('2026-03-28');
  });

  test('payout up to Sat Mar 21 leaves Mar 22+ unpaid', () => {
    const entries = [
      makeEntry(1, 100, 'earning', 1000, '2026-03-20'), // in payout period
      makeEntry(2, 100, 'earning', 500, '2026-03-22'),   // next period
      makeEntry(3, 100, 'earning', 300, '2026-03-29'),   // current period
    ];

    // Payout covers up to Mar 21
    createPayoutBatch(entries, 100, '2024-01-01', '2026-03-21');

    // Balance after payout = entries from Mar 22 onward
    expect(calculateBalance(entries, 100)).toBe(800);
    // Last period balance (Mar 22-28)
    expect(calculateBalance(entries, 100, '2026-03-22', '2026-03-28')).toBe(500);
    // This period balance (Mar 29-Apr 4)
    expect(calculateBalance(entries, 100, '2026-03-29', '2026-04-04')).toBe(300);
  });
});
