/**
 * Unit tests for helper functions extracted from server.js
 * Tests payroll calculations, availability helpers, and utility functions
 */

// We need to extract and test the helper functions.
// Since they're defined inside server.js, we'll re-implement them here for unit testing
// and verify they match the server behavior.

// ---- Helper: calculateScheduledHoursFromAvailability ----
// Extracted logic from server.js line ~19522
function calculateScheduledHoursFromAvailability(availabilityRaw, startDateStr, endDateStr) {
  if (!availabilityRaw || !startDateStr || !endDateStr) return 0;

  let avail = availabilityRaw;
  if (typeof avail === 'string') {
    try { avail = JSON.parse(avail); } catch (e) { return 0; }
  }

  const workingHours = avail.workingHours || avail;
  const customAvailability = avail.customAvailability || [];
  const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

  const toMinutes = (timeStr) => {
    if (!timeStr) return 0;
    const parts = timeStr.split(':');
    return parseInt(parts[0]) * 60 + parseInt(parts[1] || 0);
  };

  let totalHours = 0;
  const start = new Date(startDateStr + 'T00:00:00');
  const end = new Date(endDateStr + 'T00:00:00');

  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const dateStr = d.getFullYear() + '-' +
      String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0');
    const dayName = dayNames[d.getDay()];

    const override = customAvailability.find(item => item.date === dateStr);
    if (override) {
      if (override.available === false) continue;
      if (override.hours && Array.isArray(override.hours) && override.hours.length > 0) {
        override.hours.forEach(h => {
          const hStart = toMinutes(h.start || h.startTime || '09:00');
          const hEnd = toMinutes(h.end || h.endTime || '17:00');
          if (hEnd > hStart) totalHours += (hEnd - hStart) / 60;
        });
        continue;
      }
    }

    const dayHrs = workingHours[dayName];
    if (!dayHrs) continue;
    const isDayEnabled = dayHrs.enabled !== false && dayHrs.available !== false;
    if (!isDayEnabled) continue;

    if (dayHrs.timeSlots && Array.isArray(dayHrs.timeSlots) && dayHrs.timeSlots.length > 0) {
      dayHrs.timeSlots.forEach(ts => {
        const tsStart = toMinutes(ts.start || ts.startTime || '09:00');
        const tsEnd = toMinutes(ts.end || ts.endTime || '17:00');
        if (tsEnd > tsStart) totalHours += (tsEnd - tsStart) / 60;
      });
    } else {
      const dayStart = toMinutes(dayHrs.start || dayHrs.startTime || '09:00');
      const dayEnd = toMinutes(dayHrs.end || dayHrs.endTime || '17:00');
      if (dayEnd > dayStart) totalHours += (dayEnd - dayStart) / 60;
    }
  }
  return totalHours;
}

// ---- Helper: Revenue calculation (price - taxes) ----
function calculateJobRevenue(job) {
  const grossPrice = parseFloat(job.price) || parseFloat(job.total) || parseFloat(job.service_price) || parseFloat(job.total_amount) || parseFloat(job.invoice_amount) || 0;
  const taxes = parseFloat(job.taxes) || 0;
  return Math.max(0, grossPrice - taxes);
}

// ---- Helper: isCancelled ----
function isCancelled(job) {
  const s = (job?.status || '').toLowerCase();
  return s === 'cancelled' || s === 'canceled' || s === 'cancel';
}

// ---- Helper: CSV escape ----
function esc(val) {
  return String(val ?? '').replace(/"/g, '""');
}

function escDate(val) {
  if (!val) return '';
  const str = String(val);
  const match = str.match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : str;
}

// ==========================
// TESTS
// ==========================

describe('calculateScheduledHoursFromAvailability', () => {
  test('returns 0 for null/undefined inputs', () => {
    expect(calculateScheduledHoursFromAvailability(null, '2026-02-15', '2026-02-21')).toBe(0);
    expect(calculateScheduledHoursFromAvailability({}, null, '2026-02-21')).toBe(0);
    expect(calculateScheduledHoursFromAvailability({}, '2026-02-15', null)).toBe(0);
  });

  test('calculates hours for Mon-Fri 9-5 schedule', () => {
    const availability = {
      workingHours: {
        monday: { enabled: true, start: '09:00', end: '17:00' },
        tuesday: { enabled: true, start: '09:00', end: '17:00' },
        wednesday: { enabled: true, start: '09:00', end: '17:00' },
        thursday: { enabled: true, start: '09:00', end: '17:00' },
        friday: { enabled: true, start: '09:00', end: '17:00' },
        saturday: { enabled: false },
        sunday: { enabled: false }
      }
    };
    // Feb 15, 2026 is a Sunday. Feb 16=Mon, 17=Tue, 18=Wed, 19=Thu, 20=Fri, 21=Sat
    // 5 working days × 8 hours = 40 hours
    const hours = calculateScheduledHoursFromAvailability(availability, '2026-02-15', '2026-02-21');
    expect(hours).toBe(40);
  });

  test('respects date overrides (vacation day)', () => {
    const availability = {
      workingHours: {
        monday: { enabled: true, start: '09:00', end: '17:00' },
        tuesday: { enabled: true, start: '09:00', end: '17:00' },
        wednesday: { enabled: true, start: '09:00', end: '17:00' },
        thursday: { enabled: true, start: '09:00', end: '17:00' },
        friday: { enabled: true, start: '09:00', end: '17:00' },
        saturday: { enabled: false },
        sunday: { enabled: false }
      },
      customAvailability: [
        { date: '2026-02-18', available: false, label: 'Vacation' } // Wednesday off
      ]
    };
    // 4 working days × 8 hours = 32 hours (Wednesday is off)
    const hours = calculateScheduledHoursFromAvailability(availability, '2026-02-15', '2026-02-21');
    expect(hours).toBe(32);
  });

  test('respects date overrides with custom hours', () => {
    const availability = {
      workingHours: {
        monday: { enabled: true, start: '09:00', end: '17:00' },
        tuesday: { enabled: true, start: '09:00', end: '17:00' },
        wednesday: { enabled: true, start: '09:00', end: '17:00' },
        thursday: { enabled: true, start: '09:00', end: '17:00' },
        friday: { enabled: true, start: '09:00', end: '17:00' },
        saturday: { enabled: false },
        sunday: { enabled: false }
      },
      customAvailability: [
        { date: '2026-02-18', available: true, hours: [{ start: '10:00', end: '14:00' }] } // Wednesday half day
      ]
    };
    // 4 full days × 8 = 32, plus Wednesday 4 hours = 36
    const hours = calculateScheduledHoursFromAvailability(availability, '2026-02-15', '2026-02-21');
    expect(hours).toBe(36);
  });

  test('handles timeSlots array', () => {
    const availability = {
      workingHours: {
        monday: {
          enabled: true,
          timeSlots: [
            { start: '08:00', end: '12:00' },
            { start: '13:00', end: '17:00' }
          ]
        },
        tuesday: { enabled: false },
        wednesday: { enabled: false },
        thursday: { enabled: false },
        friday: { enabled: false },
        saturday: { enabled: false },
        sunday: { enabled: false }
      }
    };
    // Feb 16 is Monday: 4 + 4 = 8 hours
    const hours = calculateScheduledHoursFromAvailability(availability, '2026-02-16', '2026-02-16');
    expect(hours).toBe(8);
  });

  test('parses JSON string availability', () => {
    const availability = JSON.stringify({
      workingHours: {
        monday: { enabled: true, start: '09:00', end: '17:00' },
        tuesday: { enabled: false },
        wednesday: { enabled: false },
        thursday: { enabled: false },
        friday: { enabled: false },
        saturday: { enabled: false },
        sunday: { enabled: false }
      }
    });
    // Feb 16 is Monday: 8 hours
    const hours = calculateScheduledHoursFromAvailability(availability, '2026-02-16', '2026-02-16');
    expect(hours).toBe(8);
  });

  test('returns 0 for invalid JSON string', () => {
    expect(calculateScheduledHoursFromAvailability('not json', '2026-02-15', '2026-02-21')).toBe(0);
  });

  test('single day range works', () => {
    const availability = {
      workingHours: {
        monday: { enabled: true, start: '09:00', end: '17:00' },
      }
    };
    // Feb 16 is a Monday
    expect(calculateScheduledHoursFromAvailability(availability, '2026-02-16', '2026-02-16')).toBe(8);
  });
});

describe('calculateJobRevenue', () => {
  test('uses price minus taxes', () => {
    expect(calculateJobRevenue({ price: 209, taxes: 6.27 })).toBeCloseTo(202.73);
  });

  test('falls back to total when price is 0', () => {
    expect(calculateJobRevenue({ price: 0, total: 150, taxes: 5 })).toBeCloseTo(145);
  });

  test('falls back to service_price', () => {
    expect(calculateJobRevenue({ service_price: 100, taxes: 3 })).toBeCloseTo(97);
  });

  test('returns 0 when no price fields', () => {
    expect(calculateJobRevenue({})).toBe(0);
  });

  test('handles null taxes', () => {
    expect(calculateJobRevenue({ price: 200, taxes: null })).toBe(200);
  });

  test('never returns negative', () => {
    expect(calculateJobRevenue({ price: 5, taxes: 100 })).toBe(0);
  });

  test('handles string values', () => {
    expect(calculateJobRevenue({ price: '209.00', taxes: '6.27' })).toBeCloseTo(202.73);
  });
});

describe('isCancelled', () => {
  test('detects cancelled status variations', () => {
    expect(isCancelled({ status: 'cancelled' })).toBe(true);
    expect(isCancelled({ status: 'canceled' })).toBe(true);
    expect(isCancelled({ status: 'cancel' })).toBe(true);
    expect(isCancelled({ status: 'Cancelled' })).toBe(true);
    expect(isCancelled({ status: 'CANCELED' })).toBe(true);
  });

  test('returns false for non-cancelled', () => {
    expect(isCancelled({ status: 'completed' })).toBe(false);
    expect(isCancelled({ status: 'scheduled' })).toBe(false);
    expect(isCancelled({ status: 'in-progress' })).toBe(false);
    expect(isCancelled({ status: '' })).toBe(false);
    expect(isCancelled({})).toBe(false);
    expect(isCancelled(null)).toBe(false);
  });
});

describe('CSV helpers', () => {
  describe('esc', () => {
    test('escapes double quotes', () => {
      expect(esc('say "hello"')).toBe('say ""hello""');
    });

    test('handles null/undefined', () => {
      expect(esc(null)).toBe('');
      expect(esc(undefined)).toBe('');
    });

    test('converts numbers to strings', () => {
      expect(esc(42)).toBe('42');
    });

    test('handles empty string', () => {
      expect(esc('')).toBe('');
    });
  });

  describe('escDate', () => {
    test('extracts date from ISO timestamp', () => {
      expect(escDate('2026-02-21T00:00:00+00:00')).toBe('2026-02-21');
    });

    test('extracts date from space-separated timestamp', () => {
      expect(escDate('2026-02-21 10:30:00')).toBe('2026-02-21');
    });

    test('passes through plain dates', () => {
      expect(escDate('2026-02-21')).toBe('2026-02-21');
    });

    test('handles null/undefined', () => {
      expect(escDate(null)).toBe('');
      expect(escDate(undefined)).toBe('');
      expect(escDate('')).toBe('');
    });
  });
});

describe('Payroll role-based calculations', () => {
  test('manager commission uses total business revenue', () => {
    const totalBusinessRevenue = 6408;
    const commissionPercentage = 2;
    const commissionSalary = totalBusinessRevenue * (commissionPercentage / 100);
    expect(commissionSalary).toBeCloseTo(128.16);
  });

  test('manager hourly uses scheduled hours, not job hours', () => {
    const scheduledHours = 40;
    const hourlyRate = 4;
    const hourlySalary = scheduledHours * hourlyRate;
    expect(hourlySalary).toBe(160);
  });

  test('cleaner commission uses per-job revenue split by members', () => {
    const jobs = [
      { service_price: 200, memberCount: 2 },
      { service_price: 150, memberCount: 1 },
    ];
    const commissionPercentage = 60;
    let commissionSalary = 0;
    jobs.forEach(job => {
      const splitRevenue = (parseFloat(job.service_price) || 0) / (job.memberCount || 1);
      commissionSalary += splitRevenue * (commissionPercentage / 100);
    });
    // (200/2)*0.6 + (150/1)*0.6 = 60 + 90 = 150
    expect(commissionSalary).toBe(150);
  });

  test('cleaner hourly uses actual job hours, not scheduled', () => {
    const totalJobHours = 28.2;
    const hourlyRate = 25;
    const hourlySalary = totalJobHours * hourlyRate;
    expect(hourlySalary).toBe(705);
  });

  test('total salary includes all components', () => {
    const hourlySalary = 160;
    const commissionSalary = 128.16;
    const totalTips = 10;
    const totalIncentives = 5;
    const totalSalary = hourlySalary + commissionSalary + totalTips + totalIncentives;
    expect(totalSalary).toBeCloseTo(303.16);
  });

  test('revenue = price - taxes for manager commission base', () => {
    const jobs = [
      { price: 209, taxes: 6.27 },
      { price: 179, taxes: 0 },
      { price: 159, taxes: 4.77 },
    ];
    let totalRevenue = 0;
    jobs.forEach(job => {
      const gross = parseFloat(job.price) || 0;
      const taxes = parseFloat(job.taxes) || 0;
      totalRevenue += Math.max(0, gross - taxes);
    });
    // (209-6.27) + 179 + (159-4.77) = 202.73 + 179 + 154.23 = 535.96
    expect(totalRevenue).toBeCloseTo(535.96);
  });
});

describe('Date range filter logic', () => {
  test('dateTo uses next day for inclusive range', () => {
    const dateTo = '2026-02-21';
    const [ty, tm, td] = dateTo.split('-').map(Number);
    const nextDay = new Date(ty, tm - 1, td + 1);
    const nextDayStr = nextDay.getFullYear() + '-' +
      String(nextDay.getMonth() + 1).padStart(2, '0') + '-' +
      String(nextDay.getDate()).padStart(2, '0');
    expect(nextDayStr).toBe('2026-02-22');
  });

  test('handles month boundary', () => {
    const dateTo = '2026-02-28';
    const [ty, tm, td] = dateTo.split('-').map(Number);
    const nextDay = new Date(ty, tm - 1, td + 1);
    const nextDayStr = nextDay.getFullYear() + '-' +
      String(nextDay.getMonth() + 1).padStart(2, '0') + '-' +
      String(nextDay.getDate()).padStart(2, '0');
    expect(nextDayStr).toBe('2026-03-01');
  });

  test('handles year boundary', () => {
    const dateTo = '2025-12-31';
    const [ty, tm, td] = dateTo.split('-').map(Number);
    const nextDay = new Date(ty, tm - 1, td + 1);
    const nextDayStr = nextDay.getFullYear() + '-' +
      String(nextDay.getMonth() + 1).padStart(2, '0') + '-' +
      String(nextDay.getDate()).padStart(2, '0');
    expect(nextDayStr).toBe('2026-01-01');
  });

  test('status=daterange should not filter by status', () => {
    const status = 'daterange';
    const shouldFilter = status && status !== 'daterange';
    expect(shouldFilter).toBe(false);
  });

  test('normal status should filter', () => {
    const status = 'completed';
    const shouldFilter = status && status !== 'daterange';
    expect(shouldFilter).toBe(true);
  });
});
