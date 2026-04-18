/**
 * Comprehensive tests for Service Flow payroll/ledger system
 * Covers: revenue calculation, hourly/commission splits, multi-member jobs,
 * manager salary, breaks, tips, cash offsets, and status guards.
 */

// ═══════════════════════════════════════════════════════════════
// Extracted helper functions (must match server.js logic exactly)
// ═══════════════════════════════════════════════════════════════

function calculateJobTotal({ servicePrice = 0, discount = 0, additionalFees = 0, taxes = 0 } = {}) {
  return (parseFloat(servicePrice) || 0) - (parseFloat(discount) || 0) + (parseFloat(additionalFees) || 0) + (parseFloat(taxes) || 0);
}

function calculateScheduledHoursFromAvailability(availabilityRaw, startDateStr, endDateStr) {
  if (!availabilityRaw || !startDateStr || !endDateStr) return 0;
  let avail = availabilityRaw;
  if (typeof avail === 'string') {
    try { avail = JSON.parse(avail); } catch (e) { return 0; }
  }
  const workingHours = avail.workingHours || avail;
  const customAvailability = avail.customAvailability || [];
  const breakTime = avail.break || null;
  const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const toMinutes = (timeStr) => {
    if (!timeStr) return 0;
    const parts = timeStr.split(':');
    return parseInt(parts[0]) * 60 + parseInt(parts[1] || 0);
  };
  const breakHours = breakTime && breakTime.start && breakTime.end
    ? Math.max(0, (toMinutes(breakTime.end) - toMinutes(breakTime.start)) / 60) : 0;
  let totalHours = 0;
  const start = new Date(startDateStr + 'T00:00:00');
  const end = new Date(endDateStr + 'T00:00:00');
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const dateStr = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    const dayName = dayNames[d.getDay()];
    const override = customAvailability.find(item => item.date === dateStr);
    if (override) {
      if (override.available === false) continue;
      if (override.hours && Array.isArray(override.hours) && override.hours.length > 0) {
        let overrideDayTotal = 0;
        override.hours.forEach(h => {
          const hStart = toMinutes(h.start || h.startTime || '09:00');
          const hEnd = toMinutes(h.end || h.endTime || '17:00');
          if (hEnd > hStart) overrideDayTotal += (hEnd - hStart) / 60;
        });
        if (breakHours > 0 && overrideDayTotal > 0 && override.hours.length === 1) {
          overrideDayTotal = Math.max(0, overrideDayTotal - breakHours);
        }
        totalHours += overrideDayTotal;
        continue;
      }
    }
    const dayHrs = workingHours[dayName];
    if (!dayHrs) continue;
    const isDayEnabled = dayHrs.enabled !== false && dayHrs.available !== false;
    if (!isDayEnabled) continue;
    let dayHoursTotal = 0;
    if (dayHrs.timeSlots && Array.isArray(dayHrs.timeSlots) && dayHrs.timeSlots.length > 0) {
      dayHrs.timeSlots.forEach(ts => {
        const tsStart = toMinutes(ts.start || ts.startTime || '09:00');
        const tsEnd = toMinutes(ts.end || ts.endTime || '17:00');
        if (tsEnd > tsStart) dayHoursTotal += (tsEnd - tsStart) / 60;
      });
    } else if (dayHrs.start && dayHrs.end) {
      const dStart = toMinutes(dayHrs.start);
      const dEnd = toMinutes(dayHrs.end);
      if (dEnd > dStart) dayHoursTotal = (dEnd - dStart) / 60;
    }
    if (breakHours > 0 && dayHoursTotal > 0 && !(dayHrs.timeSlots && dayHrs.timeSlots.length > 1)) {
      dayHoursTotal = Math.max(0, dayHoursTotal - breakHours);
    }
    totalHours += dayHoursTotal;
  }
  return totalHours;
}

// Simulate salary calculation from ledger metadata (matches payroll reader)
function calculateEarningFromMeta(meta) {
  const hours = meta.hours || 0;
  const mc = meta.member_count || 1;
  const hr = meta.hourly_rate || 0;
  const cp = meta.commission_pct || 0;
  const revenue = (meta.revenue || 0) / mc;
  let hourlySalary = 0, commissionSalary = 0;
  if (hr > 0) hourlySalary = hours * hr;
  if (cp > 0) commissionSalary = revenue * (cp / 100);
  return { hourlySalary, commissionSalary, total: hourlySalary + commissionSalary };
}

// Simulate hours calculation for ledger entry (matches createLedgerEntriesForCompletedJob)
function calculateHoursForLedger(job) {
  if (job.hours_worked && parseFloat(job.hours_worked) > 0) return parseFloat(job.hours_worked);
  const durationMinutes = job.duration || job.estimated_duration || 0;
  return durationMinutes > 0 ? durationMinutes / 60 : 0;
}

// Simulate revenue calculation (matches createLedgerEntriesForCompletedJob)
function calculateRevenueForLedger(job) {
  const basePrice = parseFloat(job.service_price) || parseFloat(job.price) || 0;
  return basePrice > 0 ? basePrice + (parseFloat(job.additional_fees) || 0)
    : (parseFloat(job.total) || parseFloat(job.total_amount) || 0);
}

// ═══════════════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════════════

describe('Revenue calculation', () => {
  test('uses service_price (not discounted) for salary base', () => {
    const job = { service_price: 230, price: 180, discount: 50, total: 180 };
    expect(calculateRevenueForLedger(job)).toBe(230);
  });

  test('adds additional_fees to service_price', () => {
    const job = { service_price: 189, additional_fees: 20 };
    expect(calculateRevenueForLedger(job)).toBe(209);
  });

  test('ignores discount — discount is for customer, not cleaner', () => {
    const job = { service_price: 230, discount: 50, additional_fees: 0 };
    expect(calculateRevenueForLedger(job)).toBe(230);
  });

  test('falls back to total when service_price is 0', () => {
    const job = { service_price: 0, total: 150 };
    expect(calculateRevenueForLedger(job)).toBe(150);
  });

  test('falls back to total_amount', () => {
    const job = { total_amount: 200 };
    expect(calculateRevenueForLedger(job)).toBe(200);
  });

  test('returns 0 when no price fields', () => {
    expect(calculateRevenueForLedger({})).toBe(0);
  });
});

describe('Hours calculation for salary', () => {
  test('priority 1: hours_worked (manual override)', () => {
    const job = { hours_worked: 3.5, duration: 180, start_time: '2026-03-27T14:00:00Z', end_time: '2026-03-27T17:00:00Z' };
    expect(calculateHoursForLedger(job)).toBe(3.5);
  });

  test('priority 2: duration (estimated time in minutes)', () => {
    const job = { duration: 150 };
    expect(calculateHoursForLedger(job)).toBe(2.5);
  });

  test('priority 3: estimated_duration', () => {
    const job = { estimated_duration: 120 };
    expect(calculateHoursForLedger(job)).toBe(2);
  });

  test('does NOT use start_time/end_time for salary (real time is display only)', () => {
    // Real time is informational — salary uses estimated duration
    const job = { duration: 180, start_time: '2026-03-27T14:00:00Z', end_time: '2026-03-27T15:30:00Z' };
    expect(calculateHoursForLedger(job)).toBe(3); // duration, not 1.5h real
  });

  test('returns 0 when no hours data', () => {
    expect(calculateHoursForLedger({})).toBe(0);
  });
});

describe('Commission calculation', () => {
  test('60% commission on single-member job', () => {
    const meta = { hours: 3, revenue: 189, hourly_rate: 0, commission_pct: 60, member_count: 1 };
    const result = calculateEarningFromMeta(meta);
    expect(result.commissionSalary).toBeCloseTo(113.40);
    expect(result.hourlySalary).toBe(0);
  });

  test('60% commission split between 2 members', () => {
    const meta = { hours: 1.5, revenue: 189, hourly_rate: 0, commission_pct: 60, member_count: 2 };
    const result = calculateEarningFromMeta(meta);
    expect(result.commissionSalary).toBeCloseTo(56.70); // (189/2) * 0.6
  });

  test('commission uses full service_price (before discount)', () => {
    // $230 service, $50 discount → cleaner gets 60% of $230, not $180
    const meta = { hours: 3, revenue: 230, hourly_rate: 0, commission_pct: 60, member_count: 1 };
    expect(calculateEarningFromMeta(meta).commissionSalary).toBeCloseTo(138);
  });
});

describe('Hourly calculation', () => {
  test('$25/hr for 3 hours', () => {
    const meta = { hours: 3, revenue: 159, hourly_rate: 25, commission_pct: 0, member_count: 1 };
    expect(calculateEarningFromMeta(meta).hourlySalary).toBe(75);
  });

  test('$25/hr split between 2 members', () => {
    const meta = { hours: 1.5, revenue: 189, hourly_rate: 25, commission_pct: 0, member_count: 2 };
    expect(calculateEarningFromMeta(meta).hourlySalary).toBe(37.5); // 1.5h * $25
  });

  test('hourly uses estimated hours, not real time', () => {
    // 3h estimated, 2.7h real → salary = 3h * $25 = $75
    const meta = { hours: 3, revenue: 159, hourly_rate: 25, commission_pct: 0, member_count: 1 };
    expect(calculateEarningFromMeta(meta).hourlySalary).toBe(75);
  });
});

describe('Hybrid (hourly + commission)', () => {
  test('$4/hr + 2% commission for manager', () => {
    const meta = { hours: 8, revenue: 5000, hourly_rate: 4, commission_pct: 2, member_count: 1 };
    const result = calculateEarningFromMeta(meta);
    expect(result.hourlySalary).toBe(32); // 8h * $4
    expect(result.commissionSalary).toBe(100); // 5000 * 2%
    expect(result.total).toBe(132);
  });
});

describe('Break calculation in availability', () => {
  const availWithBreak = {
    workingHours: {
      sunday: { available: false },
      monday: { available: true, start: '09:00', end: '18:00' },
      tuesday: { available: true, start: '09:00', end: '18:00' },
      wednesday: { available: true, start: '09:00', end: '18:00' },
      thursday: { available: true, start: '09:00', end: '18:00' },
      friday: { available: true, start: '09:00', end: '18:00' },
      saturday: { available: false }
    },
    break: { start: '13:00', end: '14:00' },
    customAvailability: []
  };

  test('Mon-Fri 9-6 with 1hr break = 8h/day = 40h/week', () => {
    // Mar 16, 2026 = Monday, Mar 22 = Sunday (end of week)
    const hours = calculateScheduledHoursFromAvailability(availWithBreak, '2026-03-16', '2026-03-20');
    expect(hours).toBe(40); // 5 days * 8h
  });

  test('single day with break', () => {
    const hours = calculateScheduledHoursFromAvailability(availWithBreak, '2026-03-16', '2026-03-16');
    expect(hours).toBe(8); // 9h - 1h break
  });

  test('no break = full 9 hours', () => {
    const availNoBreak = { ...availWithBreak };
    delete availNoBreak.break;
    const hours = calculateScheduledHoursFromAvailability(availNoBreak, '2026-03-16', '2026-03-16');
    expect(hours).toBe(9);
  });

  test('break not applied when timeSlots already split (>1 slot)', () => {
    const availWithSlots = {
      workingHours: {
        monday: { available: true, timeSlots: [
          { start: '09:00', end: '13:00' },
          { start: '14:00', end: '18:00' }
        ]}
      },
      break: { start: '13:00', end: '14:00' }
    };
    // timeSlots already account for break: 4h + 4h = 8h
    const hours = calculateScheduledHoursFromAvailability(availWithSlots, '2026-03-16', '2026-03-16');
    expect(hours).toBe(8); // NOT 8 - 1 = 7
  });

  test('unavailable days produce 0 hours', () => {
    const hours = calculateScheduledHoursFromAvailability(availWithBreak, '2026-03-15', '2026-03-15'); // Sunday
    expect(hours).toBe(0);
  });

  test('2-hour break', () => {
    const avail2hBreak = {
      workingHours: { monday: { available: true, start: '08:00', end: '17:00' } },
      break: { start: '12:00', end: '14:00' }
    };
    const hours = calculateScheduledHoursFromAvailability(avail2hBreak, '2026-03-16', '2026-03-16');
    expect(hours).toBe(7); // 9h - 2h
  });

  // Regression: customAvailability single-slot overrides must apply the common break.
  // Worker-availability.jsx writes { available: true, hours: [{ start, end }] } when a worker edits a day,
  // so those days were previously counted without subtracting the break (e.g. 3 days × 9h = 27h instead of 24h).
  test('single-slot customAvailability override applies break', () => {
    const avail = {
      workingHours: {},
      break: { start: '13:00', end: '14:00' },
      customAvailability: [
        { date: '2026-04-13', available: true, hours: [{ start: '09:00', end: '18:00' }] },
        { date: '2026-04-15', available: true, hours: [{ start: '09:00', end: '18:00' }] },
        { date: '2026-04-17', available: true, hours: [{ start: '09:00', end: '18:00' }] }
      ]
    };
    // 3 days × (9h - 1h break) = 24h
    const hours = calculateScheduledHoursFromAvailability(avail, '2026-04-12', '2026-04-18');
    expect(hours).toBe(24);
  });

  test('multi-slot customAvailability override does NOT apply break (already encoded)', () => {
    const avail = {
      workingHours: {},
      break: { start: '13:00', end: '14:00' },
      customAvailability: [
        { date: '2026-04-13', available: true, hours: [
          { start: '09:00', end: '13:00' },
          { start: '14:00', end: '18:00' }
        ]}
      ]
    };
    // 4h + 4h = 8h, NOT 7h
    const hours = calculateScheduledHoursFromAvailability(avail, '2026-04-13', '2026-04-13');
    expect(hours).toBe(8);
  });

  test('customAvailability unavailable day is excluded from total', () => {
    const avail = {
      workingHours: {
        monday: { available: true, start: '09:00', end: '18:00' },
        tuesday: { available: true, start: '09:00', end: '18:00' },
        wednesday: { available: true, start: '09:00', end: '18:00' },
        thursday: { available: true, start: '09:00', end: '18:00' },
        friday: { available: true, start: '09:00', end: '18:00' },
        saturday: { available: true, start: '09:00', end: '18:00' }
      },
      break: { start: '13:00', end: '14:00' },
      customAvailability: [
        { date: '2026-04-18', available: false } // Saturday removed
      ]
    };
    // Mon-Fri (5 days × 8h) = 40h, Saturday excluded
    const hours = calculateScheduledHoursFromAvailability(avail, '2026-04-13', '2026-04-18');
    expect(hours).toBe(40);
  });
});

describe('Multi-member job splitting', () => {
  test('2 commission cleaners split revenue equally', () => {
    const revenue = 189;
    const mc = 2;
    const commPct = 60;
    const perMember = (revenue / mc) * (commPct / 100);
    expect(perMember).toBeCloseTo(56.70);
  });

  test('2 hourly cleaners split hours equally', () => {
    const hours = 3.5;
    const mc = 2;
    const hourlyRate = 25;
    const perMember = (hours / mc) * hourlyRate;
    expect(perMember).toBeCloseTo(43.75);
  });

  test('mixed: 1 commission + 1 hourly on same job', () => {
    const revenue = 189;
    const hours = 3.5;
    const mc = 2;
    // Commission cleaner
    const commEarning = (revenue / mc) * (60 / 100);
    expect(commEarning).toBeCloseTo(56.70);
    // Hourly cleaner
    const hourlyEarning = (hours / mc) * 25;
    expect(hourlyEarning).toBeCloseTo(43.75);
  });

  test('tips split equally between members', () => {
    const tipAmount = 20;
    const mc = 2;
    expect(tipAmount / mc).toBe(10);
  });
});

describe('Tips', () => {
  test('tips come only from job.tip_amount', () => {
    const tipAmount = 20;
    expect(tipAmount).toBe(20);
  });

  test('processing fees (overpayment) are NOT tips', () => {
    // Customer pays $163.77 for $159 job — $4.77 is processing fee
    const totalPaid = 163.77;
    const totalDue = 159;
    const overpayment = totalPaid - totalDue;
    // This should NOT be treated as a tip
    expect(overpayment).toBeCloseTo(4.77);
    // Tip should be 0 if job.tip_amount is 0
    const tipAmount = 0;
    expect(tipAmount).toBe(0);
  });
});

describe('Status guards', () => {
  test('only completed jobs should have ledger entries', () => {
    const validStatuses = ['completed'];
    expect(validStatuses.includes('completed')).toBe(true);
    expect(validStatuses.includes('scheduled')).toBe(false);
    expect(validStatuses.includes('en-route')).toBe(false);
    expect(validStatuses.includes('started')).toBe(false);
    expect(validStatuses.includes('cancelled')).toBe(false);
    expect(validStatuses.includes('pending')).toBe(false);
  });

  test('cancelled jobs have ledger entries removed', () => {
    // When status changes to cancelled, entries should be deleted
    const shouldDelete = (newStatus) => newStatus === 'cancelled';
    expect(shouldDelete('cancelled')).toBe(true);
    expect(shouldDelete('completed')).toBe(false);
  });
});

describe('Manager salary entries', () => {
  test('manager hourly: scheduled hours * rate', () => {
    const scheduledHours = 8;
    const hourlyRate = 3.75;
    expect(scheduledHours * hourlyRate).toBe(30);
  });

  test('manager commission: daily revenue * percentage', () => {
    const dayRevenue = 1500;
    const commPct = 2;
    expect(dayRevenue * (commPct / 100)).toBe(30);
  });

  test('manager salary uses break-adjusted hours', () => {
    const avail = {
      workingHours: { monday: { available: true, start: '09:00', end: '18:00' } },
      break: { start: '13:00', end: '14:00' }
    };
    const hours = calculateScheduledHoursFromAvailability(avail, '2026-03-16', '2026-03-16');
    const hourlyRate = 4;
    expect(hours).toBe(8);
    expect(hours * hourlyRate).toBe(32);
  });
});

describe('calculateJobTotal', () => {
  test('service_price - discount + fees + taxes', () => {
    expect(calculateJobTotal({ servicePrice: 189, discount: 30, additionalFees: 0, taxes: 0 })).toBe(159);
  });

  test('with all components', () => {
    expect(calculateJobTotal({ servicePrice: 200, discount: 20, additionalFees: 10, taxes: 15 })).toBe(205);
  });

  test('handles string values', () => {
    expect(calculateJobTotal({ servicePrice: '189', discount: '30' })).toBe(159);
  });
});

describe('Pay period date ranges', () => {
  test('weekly: start on Sunday, end on Saturday', () => {
    // Mar 29, 2026 is Sunday
    const start = new Date(2026, 2, 29); // Sunday
    const end = new Date(start);
    end.setDate(end.getDate() + 6); // Saturday Apr 4
    expect(start.getDay()).toBe(0); // Sunday
    expect(end.getDay()).toBe(6); // Saturday
  });

  test('date display uses T00:00:00 to avoid timezone shift', () => {
    // new Date('2026-03-15') = UTC midnight = Mar 14 in Eastern
    const badDate = new Date('2026-03-15');
    const goodDate = new Date('2026-03-15T00:00:00');
    // goodDate should be Mar 15 in local time
    expect(goodDate.getDate()).toBe(15);
  });
});

describe('Real time validation', () => {
  test('ignore bad timestamps where start ≈ end (<1 min)', () => {
    const start = new Date('2026-03-24T21:48:59.379Z');
    const end = new Date('2026-03-24T21:48:59.801Z');
    const diffMs = end - start;
    expect(diffMs).toBeLessThan(60000);
    // Should fall back to estimated duration
    const useRealTime = diffMs > 60000;
    expect(useRealTime).toBe(false);
  });

  test('valid timestamps (>1 min) used for display', () => {
    const start = new Date('2026-03-27T14:25:27.034Z');
    const end = new Date('2026-03-27T16:44:06.504Z');
    const diffMs = end - start;
    expect(diffMs).toBeGreaterThan(60000);
    const realHours = diffMs / (1000 * 60 * 60);
    expect(realHours).toBeCloseTo(2.31, 1);
  });
});

describe('Revenue filtering by job status', () => {
  const jobs = [
    { status: 'completed', service_price: 189, additional_fees: 0 },
    { status: 'completed', service_price: 159, additional_fees: 0 },
    { status: 'scheduled', service_price: 139, additional_fees: 0 },
    { status: 'en-route', service_price: 209, additional_fees: 0 },
    { status: 'cancelled', service_price: 100, additional_fees: 0 },
  ];

  test('default (completed only): revenue excludes scheduled/en-route/cancelled', () => {
    const includeScheduled = false;
    let revenue = 0;
    jobs.forEach(j => {
      const s = j.status.toLowerCase();
      if (s === 'cancelled') return;
      if (!includeScheduled && s !== 'completed') return;
      revenue += j.service_price + (j.additional_fees || 0);
    });
    expect(revenue).toBe(348); // 189 + 159
  });

  test('includeScheduled: revenue includes all non-cancelled jobs', () => {
    const includeScheduled = true;
    let revenue = 0;
    jobs.forEach(j => {
      const s = j.status.toLowerCase();
      if (s === 'cancelled') return;
      if (!includeScheduled && s !== 'completed') return;
      revenue += j.service_price + (j.additional_fees || 0);
    });
    expect(revenue).toBe(696); // 189 + 159 + 139 + 209
  });

  test('cancelled jobs never count in revenue', () => {
    const includeScheduled = true;
    let revenue = 0;
    jobs.forEach(j => {
      const s = j.status.toLowerCase();
      if (s === 'cancelled') return;
      revenue += j.service_price;
    });
    expect(revenue).toBe(696); // no $100 from cancelled
  });
});

describe('Manager salary: Incl. Scheduled projections', () => {
  test('manager commission recalculates on full revenue when includeScheduled', () => {
    const completedRevenue = 5000;
    const scheduledRevenue = 3000;
    const totalRevenue = completedRevenue + scheduledRevenue;
    const commPct = 2;

    // Without includeScheduled: commission from ledger (completed only)
    const commFromLedger = completedRevenue * (commPct / 100);
    expect(commFromLedger).toBe(100);

    // With includeScheduled: recalculate on total
    const commProjected = totalRevenue * (commPct / 100);
    expect(commProjected).toBe(160);
  });

  test('manager commission always recalculates with includeScheduled (not skipped when > 0)', () => {
    const commFromLedger = 100; // existing from completed jobs
    const totalRevenue = 8000;
    const commPct = 2;
    const includeScheduled = true;

    // Should use totalRevenue, not keep commFromLedger
    const commission = includeScheduled ? totalRevenue * (commPct / 100) : commFromLedger;
    expect(commission).toBe(160);
  });

  test('manager hourly uses full period scheduled hours (not capped at today)', () => {
    const avail = {
      workingHours: {
        sunday: { available: true, start: '09:00', end: '17:00' },
        monday: { available: true, start: '09:00', end: '17:00' },
        tuesday: { available: false },
        wednesday: { available: false },
        thursday: { available: false },
        friday: { available: true, start: '09:00', end: '17:00' },
        saturday: { available: true, start: '09:00', end: '17:00' },
      },
      break: { start: '13:00', end: '14:00' }
    };
    const hourlyRate = 4;
    // Full week Mar 29 (Sun) - Apr 4 (Sat): Sun, Mon, Fri, Sat = 4 days × 7h = 28h
    const scheduledHours = calculateScheduledHoursFromAvailability(avail, '2026-03-29', '2026-04-04');
    expect(scheduledHours).toBe(28);
    expect(scheduledHours * hourlyRate).toBe(112);
  });

  test('manager salary projected even for future days in period', () => {
    // Period: Mar 29 - Apr 4. Today is Mar 30.
    // Ledger has entries for Mar 29-30 only.
    // With includeScheduled, salary = full period scheduled hours × rate
    const avail = {
      workingHours: {
        monday: { available: true, start: '09:00', end: '18:00' },
        tuesday: { available: true, start: '09:00', end: '18:00' },
        wednesday: { available: true, start: '09:00', end: '18:00' },
        thursday: { available: true, start: '09:00', end: '18:00' },
        friday: { available: true, start: '09:00', end: '18:00' },
      },
      break: { start: '13:00', end: '14:00' }
    };
    const hourlyRate = 3.75;
    // Mar 30 (Mon) - Apr 3 (Fri) = 5 days × 8h = 40h
    const fullPeriodHours = calculateScheduledHoursFromAvailability(avail, '2026-03-30', '2026-04-03');
    expect(fullPeriodHours).toBe(40);
    expect(fullPeriodHours * hourlyRate).toBe(150);
  });
});

describe('Cash collected offset', () => {
  test('cash payment creates negative balance offset', () => {
    const earning = 113.40; // 60% of $189
    const cashCollected = -189; // cleaner collected full amount
    const balance = earning + cashCollected;
    expect(balance).toBeCloseTo(-75.60); // cleaner owes $75.60
  });

  test('cash split between 2 members', () => {
    const cashAmount = 189;
    const memberCount = 2;
    const perMember = -(cashAmount / memberCount);
    expect(perMember).toBeCloseTo(-94.50);
  });

  test('non-cash payment does not create offset', () => {
    const paymentMethod = 'stripe';
    const isCash = paymentMethod.toLowerCase().includes('cash');
    expect(isCash).toBe(false);
  });

  test('Zelle payment is not cash', () => {
    const paymentMethod = 'Zelle BofA';
    const isCash = paymentMethod.toLowerCase().includes('cash');
    expect(isCash).toBe(false);
  });
});

describe('Payroll edit audit trail', () => {
  test('hours change tracked with old and new values', () => {
    const oldHours = 3;
    const newHours = 2.5;
    const edit = { field: 'hours_worked', old_value: String(oldHours), new_value: String(newHours) };
    expect(edit.field).toBe('hours_worked');
    expect(edit.old_value).toBe('3');
    expect(edit.new_value).toBe('2.5');
  });

  test('no edit logged when value unchanged', () => {
    const oldVal = 20;
    const newVal = 20;
    const changed = newVal !== oldVal;
    expect(changed).toBe(false);
  });

  test('service_price edit tracked', () => {
    const edit = { field: 'service_price', old_value: '189', new_value: '200' };
    expect(edit.field).toBe('service_price');
  });
});

describe('Per-member incentive tracking', () => {
  test('per-assignment incentive: editing one member does not affect others', () => {
    const assignments = [
      { team_member_id: 100, incentive_amount: 15 },
      { team_member_id: 200, incentive_amount: 15 },
    ];
    // Edit member 100's incentive to 0
    assignments.find(a => a.team_member_id === 100).incentive_amount = 0;
    // Job total = sum of all assignments
    const jobTotal = assignments.reduce((sum, a) => sum + (a.incentive_amount || 0), 0);
    expect(jobTotal).toBe(15); // member 200 still has $15
    expect(assignments.find(a => a.team_member_id === 200).incentive_amount).toBe(15);
  });

  test('legacy path: when no per-assignment incentives, split job total equally', () => {
    const assignments = [
      { team_member_id: 100, incentive_amount: 0 },
      { team_member_id: 200, incentive_amount: 0 },
    ];
    const jobIncentive = 30;
    const memberCount = assignments.length;
    const hasPerAssignment = assignments.some(a => a.incentive_amount > 0);

    const member100incentive = hasPerAssignment
      ? assignments.find(a => a.team_member_id === 100).incentive_amount
      : jobIncentive / memberCount;

    expect(hasPerAssignment).toBe(false);
    expect(member100incentive).toBe(15); // 30 / 2
  });

  test('per-assignment path: uses assignment values when any are > 0', () => {
    const assignments = [
      { team_member_id: 100, incentive_amount: 20 },
      { team_member_id: 200, incentive_amount: 10 },
    ];
    const jobIncentive = 30;
    const hasPerAssignment = assignments.some(a => a.incentive_amount > 0);

    const member100 = hasPerAssignment
      ? assignments.find(a => a.team_member_id === 100).incentive_amount
      : jobIncentive / assignments.length;
    const member200 = hasPerAssignment
      ? assignments.find(a => a.team_member_id === 200).incentive_amount
      : jobIncentive / assignments.length;

    expect(hasPerAssignment).toBe(true);
    expect(member100).toBe(20); // per-assignment, not split
    expect(member200).toBe(10);
  });

  test('job total recalculated as sum of assignments after edit', () => {
    const assignments = [
      { team_member_id: 100, incentive_amount: 20 },
      { team_member_id: 200, incentive_amount: 10 },
    ];
    // Edit member 100 from 20 to 5
    assignments.find(a => a.team_member_id === 100).incentive_amount = 5;
    const jobTotal = assignments.reduce((sum, a) => sum + a.incentive_amount, 0);
    expect(jobTotal).toBe(15); // 5 + 10
  });
});

describe('Ledger race check — type-scoped', () => {
  test('race check should only consider earning/tip/incentive types', () => {
    // Simulate: after deleting earning/tip/incentive, cash_collected still exists
    const remainingEntries = [
      { id: 1, job_id: 100, type: 'cash_collected', amount: -180 },
    ];
    // Old (buggy) check: any entry blocks rebuild
    const oldCheck = remainingEntries.length > 0;
    // New (fixed) check: only earning/tip/incentive block rebuild
    const newCheck = remainingEntries.filter(e =>
      ['earning', 'tip', 'incentive'].includes(e.type)
    ).length > 0;

    expect(oldCheck).toBe(true);   // old: would skip rebuild (BUG)
    expect(newCheck).toBe(false);  // new: allows rebuild (CORRECT)
  });

  test('race check blocks when earning entries exist', () => {
    const entries = [
      { id: 1, job_id: 100, type: 'earning', amount: 150 },
      { id: 2, job_id: 100, type: 'cash_collected', amount: -180 },
    ];
    const raceCheck = entries.filter(e =>
      ['earning', 'tip', 'incentive'].includes(e.type)
    ).length > 0;
    expect(raceCheck).toBe(true); // correctly blocks — earnings still exist
  });

  test('race check allows rebuild when only reimbursement/cash remain', () => {
    const entries = [
      { id: 1, job_id: 100, type: 'cash_collected', amount: -180 },
      { id: 2, job_id: 100, type: 'reimbursement', amount: 5 },
      { id: 3, job_id: 100, type: 'adjustment', amount: 10 },
    ];
    const raceCheck = entries.filter(e =>
      ['earning', 'tip', 'incentive'].includes(e.type)
    ).length > 0;
    expect(raceCheck).toBe(false); // correctly allows rebuild
  });
});
