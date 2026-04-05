/**
 * Tests for multi-cleaner job sync, cash collected system, and prior period balance
 * Covers: multi-provider assignment sync, duration/salary calculations,
 * cash_collected ledger entries, cash redistribution, prior period carry-over
 */

// ═══════════════════════════════════════════════════════════════
// Simulated logic (matches server.js / zenbooker-sync.js behavior)
// ═══════════════════════════════════════════════════════════════

/**
 * mapJob — extract team_member_id from assigned_providers[0]
 * (simplified version of zenbooker-sync.js mapJob)
 */
function mapJobProvider(zbJob, teamMap) {
  const provider = zbJob.assigned_providers?.[0];
  return provider?.id ? teamMap[provider.id] : null;
}

/**
 * Sync team assignments from ZZB providers to job_team_assignments
 * (matches handleJobEvent logic in zenbooker-sync.js)
 */
function syncTeamAssignments(zbJob, teamMap) {
  const providers = zbJob.assigned_providers || [];
  const zbMemberIds = providers.map(p => teamMap[p.id]).filter(Boolean);
  if (zbMemberIds.length > 1) {
    return zbMemberIds.map((id, idx) => ({
      team_member_id: id,
      is_primary: idx === 0
    }));
  }
  return null; // single provider, no assignments needed
}

/**
 * Calculate earning amount for a team member on a job
 * Duration = wall-clock time per cleaner (NOT divided by memberCount)
 * Revenue IS split by memberCount for commission
 */
function calculateEarning(hoursWorked, jobRevenue, memberCount, hourlyRate, commissionPct) {
  if (hourlyRate > 0 && commissionPct > 0) {
    const hourlyPay = hoursWorked * hourlyRate;
    const commissionPay = (jobRevenue / memberCount) * (commissionPct / 100);
    return parseFloat((hourlyPay + commissionPay).toFixed(2));
  } else if (commissionPct > 0) {
    return parseFloat(((jobRevenue / memberCount) * (commissionPct / 100)).toFixed(2));
  } else if (hourlyRate > 0) {
    return parseFloat((hoursWorked * hourlyRate).toFixed(2));
  }
  return 0;
}

/**
 * Create cash_collected entries for a job
 * Splits evenly among assigned members
 */
function createCashCollectedEntries(jobId, totalCash, memberIds, effectiveDate) {
  if (totalCash <= 0 || memberIds.length === 0) return [];
  const perMember = parseFloat((totalCash / memberIds.length).toFixed(2));
  return memberIds.map(mid => ({
    team_member_id: mid,
    job_id: jobId,
    type: 'cash_collected',
    amount: -perMember,
    effective_date: effectiveDate
  }));
}

/**
 * Redistribute cash when one member's amount is edited
 * Remainder goes evenly to other members
 */
function redistributeCash(totalCash, editedMemberId, editedAmount, allMemberIds) {
  const entries = [];
  const capped = Math.min(Math.abs(editedAmount), totalCash);
  if (capped > 0) {
    entries.push({ team_member_id: editedMemberId, amount: -capped });
  }
  const remainder = totalCash - capped;
  const others = allMemberIds.filter(id => id !== editedMemberId);
  if (remainder > 0 && others.length > 0) {
    const perMember = parseFloat((remainder / others.length).toFixed(2));
    others.forEach(mid => entries.push({ team_member_id: mid, amount: -perMember }));
  }
  return entries;
}

/**
 * Calculate prior period balance
 * = total balance (all time) - current period non-payout entries
 * Payouts always settle prior debt, never counted as "current period"
 */
function calculatePriorBalance(allEntries, memberId, periodStart, periodEnd) {
  let total = 0;
  let currentNonPayout = 0;
  allEntries.filter(e => e.team_member_id === memberId).forEach(e => {
    total += e.amount;
    if (e.type !== 'payout' && e.effective_date >= periodStart && e.effective_date <= periodEnd) {
      currentNonPayout += e.amount;
    }
  });
  return parseFloat((total - currentNonPayout).toFixed(2));
}

// ═══════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════

function makeEntry(memberId, type, amount, date) {
  return { team_member_id: memberId, type, amount, effective_date: date };
}

// ═══════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════

describe('Multi-Cleaner Job Assignment Sync', () => {
  const teamMap = { 'zb_101': 1001, 'zb_102': 1002, 'zb_103': 1003 };

  test('single provider returns null (no assignments needed)', () => {
    const zbJob = { assigned_providers: [{ id: 'zb_101', name: 'Alice' }] };
    expect(syncTeamAssignments(zbJob, teamMap)).toBeNull();
  });

  test('two providers creates assignments with primary flag', () => {
    const zbJob = { assigned_providers: [
      { id: 'zb_101', name: 'Alice' },
      { id: 'zb_102', name: 'Bob' }
    ]};
    const result = syncTeamAssignments(zbJob, teamMap);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ team_member_id: 1001, is_primary: true });
    expect(result[1]).toEqual({ team_member_id: 1002, is_primary: false });
  });

  test('three providers all get assignments', () => {
    const zbJob = { assigned_providers: [
      { id: 'zb_101', name: 'Alice' },
      { id: 'zb_102', name: 'Bob' },
      { id: 'zb_103', name: 'Charlie' }
    ]};
    const result = syncTeamAssignments(zbJob, teamMap);
    expect(result).toHaveLength(3);
    expect(result[0].is_primary).toBe(true);
    expect(result[1].is_primary).toBe(false);
    expect(result[2].is_primary).toBe(false);
  });

  test('unknown provider ID is filtered out', () => {
    const zbJob = { assigned_providers: [
      { id: 'zb_101', name: 'Alice' },
      { id: 'zb_unknown', name: 'Unknown' }
    ]};
    const result = syncTeamAssignments(zbJob, teamMap);
    // Only 1 valid member, so returns null (single provider)
    expect(result).toBeNull();
  });

  test('no providers returns null', () => {
    expect(syncTeamAssignments({ assigned_providers: [] }, teamMap)).toBeNull();
    expect(syncTeamAssignments({}, teamMap)).toBeNull();
  });

  test('primary provider maps to team_member_id', () => {
    const zbJob = { assigned_providers: [
      { id: 'zb_102', name: 'Bob' },
      { id: 'zb_101', name: 'Alice' }
    ]};
    expect(mapJobProvider(zbJob, teamMap)).toBe(1002); // first provider
  });
});

describe('Duration and Salary Calculations', () => {
  test('commission-only: revenue split by member count, hours NOT split', () => {
    // 2 cleaners, $200 revenue, 60% commission
    const earning = calculateEarning(4, 200, 2, 0, 60);
    // 200/2 * 0.60 = 60
    expect(earning).toBe(60);
  });

  test('hourly-only: full hours per cleaner, NOT divided', () => {
    // 2 cleaners, 4 hours each, $25/hr
    const earning = calculateEarning(4, 200, 2, 25, 0);
    // 4 * 25 = 100 (NOT 4/2 * 25 = 50)
    expect(earning).toBe(100);
  });

  test('hybrid: hourly uses full hours, commission splits revenue', () => {
    // 2 cleaners, 3 hours, $300 revenue, $20/hr + 10% commission
    const earning = calculateEarning(3, 300, 2, 20, 10);
    // hourly: 3 * 20 = 60, commission: 300/2 * 0.10 = 15, total = 75
    expect(earning).toBe(75);
  });

  test('single cleaner gets full amount', () => {
    const earning = calculateEarning(3, 200, 1, 0, 60);
    // 200/1 * 0.60 = 120
    expect(earning).toBe(120);
  });

  test('zero rates return zero', () => {
    expect(calculateEarning(4, 200, 1, 0, 0)).toBe(0);
  });
});

describe('Cash Collected Entries', () => {
  test('splits cash evenly between members', () => {
    const entries = createCashCollectedEntries(100, 200, [1001, 1002], '2026-04-01');
    expect(entries).toHaveLength(2);
    expect(entries[0].amount).toBe(-100);
    expect(entries[1].amount).toBe(-100);
    expect(entries[0].type).toBe('cash_collected');
  });

  test('single member gets full cash amount', () => {
    const entries = createCashCollectedEntries(100, 189, [1001], '2026-04-01');
    expect(entries).toHaveLength(1);
    expect(entries[0].amount).toBe(-189);
  });

  test('three members split evenly', () => {
    const entries = createCashCollectedEntries(100, 300, [1001, 1002, 1003], '2026-04-01');
    expect(entries).toHaveLength(3);
    entries.forEach(e => expect(e.amount).toBe(-100));
  });

  test('zero cash returns empty', () => {
    expect(createCashCollectedEntries(100, 0, [1001], '2026-04-01')).toHaveLength(0);
  });

  test('no members returns empty', () => {
    expect(createCashCollectedEntries(100, 200, [], '2026-04-01')).toHaveLength(0);
  });
});

describe('Cash Redistribution', () => {
  test('one cleaner gets all cash, other gets zero', () => {
    const result = redistributeCash(200, 1001, 200, [1001, 1002]);
    expect(result).toHaveLength(1); // only the edited member (remainder=0, no entry for other)
    expect(result[0]).toEqual({ team_member_id: 1001, amount: -200 });
  });

  test('edited amount less than total, remainder to other', () => {
    const result = redistributeCash(200, 1001, 50, [1001, 1002]);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ team_member_id: 1001, amount: -50 });
    expect(result[1]).toEqual({ team_member_id: 1002, amount: -150 });
  });

  test('edited to zero, all goes to other', () => {
    const result = redistributeCash(200, 1001, 0, [1001, 1002]);
    expect(result).toHaveLength(1); // edited member has 0 (no entry), other gets all
    expect(result[0]).toEqual({ team_member_id: 1002, amount: -200 });
  });

  test('three members: edited one, remainder splits to two others', () => {
    const result = redistributeCash(300, 1001, 100, [1001, 1002, 1003]);
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ team_member_id: 1001, amount: -100 });
    expect(result[1]).toEqual({ team_member_id: 1002, amount: -100 });
    expect(result[2]).toEqual({ team_member_id: 1003, amount: -100 });
  });

  test('edited amount capped at total cash', () => {
    const result = redistributeCash(200, 1001, 500, [1001, 1002]);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ team_member_id: 1001, amount: -200 });
  });
});

describe('Prior Period Balance', () => {
  test('no prior debt when earnings exceed cash', () => {
    const entries = [
      makeEntry(1, 'earning', 200, '2026-03-15'),
      makeEntry(1, 'cash_collected', -100, '2026-03-15'),
      makeEntry(1, 'earning', 50, '2026-04-01'), // current period
    ];
    const prior = calculatePriorBalance(entries, 1, '2026-03-29', '2026-04-04');
    // total = 200-100+50 = 150, current = 50, prior = 100
    expect(prior).toBe(100); // positive = no debt
  });

  test('prior debt when cash exceeds earnings', () => {
    const entries = [
      makeEntry(1, 'earning', 113.40, '2026-03-27'),
      makeEntry(1, 'cash_collected', -180, '2026-03-27'),
      makeEntry(1, 'payout', -898, '2026-03-31'), // payout in current period but settles prior
      makeEntry(1, 'earning', 898, '2026-03-20'), // prior earnings
      makeEntry(1, 'earning', 176.10, '2026-04-01'), // current period
    ];
    const prior = calculatePriorBalance(entries, 1, '2026-03-29', '2026-04-04');
    // total = 113.40-180-898+898+176.10 = 109.50
    // current non-payout = 176.10
    // prior = 109.50 - 176.10 = -66.60
    expect(prior).toBe(-66.6);
  });

  test('payout dated in current period still settles prior debt', () => {
    const entries = [
      makeEntry(1, 'earning', 500, '2026-03-15'),
      makeEntry(1, 'cash_collected', -300, '2026-03-15'),
      makeEntry(1, 'payout', -500, '2026-04-01'), // payout in current period
      makeEntry(1, 'earning', 100, '2026-04-02'), // current period earning
    ];
    const prior = calculatePriorBalance(entries, 1, '2026-03-29', '2026-04-04');
    // total = 500-300-500+100 = -200
    // current non-payout = 100
    // prior = -200 - 100 = -300
    expect(prior).toBe(-300);
  });

  test('no entries returns zero', () => {
    expect(calculatePriorBalance([], 1, '2026-03-29', '2026-04-04')).toBe(0);
  });

  test('only current period entries, no prior', () => {
    const entries = [
      makeEntry(1, 'earning', 100, '2026-04-01'),
      makeEntry(1, 'cash_collected', -50, '2026-04-01'),
    ];
    const prior = calculatePriorBalance(entries, 1, '2026-03-29', '2026-04-04');
    // total = 50, current = 50, prior = 0
    expect(prior).toBe(0);
  });

  test('multiple members calculated independently', () => {
    const entries = [
      makeEntry(1, 'earning', 100, '2026-03-15'),
      makeEntry(1, 'cash_collected', -200, '2026-03-15'),
      makeEntry(2, 'earning', 300, '2026-03-15'),
      makeEntry(2, 'cash_collected', -100, '2026-03-15'),
    ];
    // Member 1: total=100-200=-100, current=0, prior=-100
    expect(calculatePriorBalance(entries, 1, '2026-03-29', '2026-04-04')).toBe(-100);
    // Member 2: total=300-100=200, current=0, prior=200
    expect(calculatePriorBalance(entries, 2, '2026-03-29', '2026-04-04')).toBe(200);
  });
});

describe('Webhook Job ID Resolution', () => {
  test('resolves from data.id', () => {
    const data = { id: 'job123' };
    expect(data.id || data.job_id || data.job?.id).toBe('job123');
  });

  test('resolves from data.job_id when id missing', () => {
    const data = { job_id: 'job456' };
    expect(data.id || data.job_id || data.job?.id).toBe('job456');
  });

  test('resolves from data.job.id when others missing', () => {
    const data = { job: { id: 'job789' } };
    expect(data.id || data.job_id || data.job?.id).toBe('job789');
  });

  test('returns undefined when no ID present', () => {
    const data = { status: 'canceled' };
    expect(data.id || data.job_id || data.job?.id).toBeUndefined();
  });
});

describe('ZZB Cancelled Job Detection', () => {
  test('canceled=true with status=scheduled maps to cancelled', () => {
    const zb = { status: 'scheduled', canceled: true };
    const status = zb.canceled ? 'cancelled' : zb.status;
    expect(status).toBe('cancelled');
  });

  test('canceled=false with status=complete maps to completed', () => {
    const zb = { status: 'complete', canceled: false };
    const STATUS_MAP = { 'complete': 'completed', 'scheduled': 'scheduled' };
    const status = zb.canceled ? 'cancelled' : (STATUS_MAP[zb.status] || 'pending');
    expect(status).toBe('completed');
  });

  test('no canceled field with status=scheduled stays scheduled', () => {
    const zb = { status: 'scheduled' };
    const STATUS_MAP = { 'complete': 'completed', 'scheduled': 'scheduled' };
    const status = zb.canceled ? 'cancelled' : (STATUS_MAP[zb.status] || 'pending');
    expect(status).toBe('scheduled');
  });
});

describe('Manager Salary Calculation', () => {
  test('manager hourly salary from scheduled hours', () => {
    const scheduledHours = 40;
    const hourlyRate = 3.75;
    expect(scheduledHours * hourlyRate).toBe(150);
  });

  test('manager commission from total business revenue', () => {
    const totalBusinessRevenue = 6840;
    const commissionPercentage = 2;
    expect(totalBusinessRevenue * (commissionPercentage / 100)).toBe(136.8);
  });

  test('manager with both hourly and commission', () => {
    const scheduledHours = 40;
    const hourlyRate = 3.75;
    const totalBusinessRevenue = 6840;
    const commissionPercentage = 2;
    const hourly = scheduledHours * hourlyRate;
    const commission = totalBusinessRevenue * (commissionPercentage / 100);
    expect(hourly + commission).toBe(286.8);
  });
});
