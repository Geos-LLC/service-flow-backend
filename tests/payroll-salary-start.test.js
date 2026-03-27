/**
 * Tests for payroll salary_start_date behavior.
 *
 * Bug: Zenbooker sync creates team members without salary_start_date,
 * so the DB default (CURRENT_DATE) kicks in — setting it to the sync date.
 * This means payroll excludes all jobs before the sync date, breaking
 * "previous period" calculations entirely.
 *
 * Fix:
 * 1. syncTeamMembers should set salary_start_date to null (or earliest job date)
 *    so the payroll filter doesn't exclude historical jobs.
 * 2. Existing team members with salary_start_date = sync date need correction.
 */

// ---- Extracted payroll filter logic (from server.js ~20377) ----
function filterJobsForMember(jobs, memberSalaryStartDate) {
  const memberSalaryStartRaw = memberSalaryStartDate
    ? String(memberSalaryStartDate).split('T')[0].split(' ')[0]
    : null;

  return jobs.filter(j => {
    if (!j) return false;
    const s = (j.status || '').toLowerCase();
    if (s === 'cancelled' || s === 'canceled' || s === 'cancel') return false;
    if (memberSalaryStartRaw && j.scheduled_date) {
      const jobDate = String(j.scheduled_date).split('T')[0].split(' ')[0];
      if (jobDate < memberSalaryStartRaw) return false;
    }
    return true;
  });
}

// ---- Extracted mapTeamMember (from zenbooker-sync.js) ----
// Before fix:
function mapTeamMemberBefore(zb, userId) {
  const nameParts = (zb.name || '').split(' ')
  return {
    user_id: userId,
    first_name: nameParts[0] || '',
    last_name: nameParts.slice(1).join(' ') || '',
    email: zb.email || '',
    phone: zb.phone || null,
    zenbooker_id: zb.id,
    // NOTE: no salary_start_date → DB default = CURRENT_DATE
  }
}

// After fix:
function mapTeamMemberAfter(zb, userId) {
  const nameParts = (zb.name || '').split(' ')
  return {
    user_id: userId,
    first_name: nameParts[0] || '',
    last_name: nameParts.slice(1).join(' ') || '',
    email: zb.email || '',
    phone: zb.phone || null,
    zenbooker_id: zb.id,
    salary_start_date: null, // Explicit null overrides DB default
  }
}

// ==========================
// TESTS
// ==========================

describe('Payroll salary_start_date filter', () => {
  const marchJobs = [
    { id: 1, scheduled_date: '2026-03-01 10:00:00', status: 'completed', service_price: 139 },
    { id: 2, scheduled_date: '2026-03-10 09:00:00', status: 'completed', service_price: 179 },
    { id: 3, scheduled_date: '2026-03-20 14:00:00', status: 'completed', service_price: 209 },
    { id: 4, scheduled_date: '2026-03-25 10:00:00', status: 'completed', service_price: 159 },
    { id: 5, scheduled_date: '2026-03-27 10:00:00', status: 'scheduled', service_price: 139 },
  ];

  test('BUG: salary_start_date=2026-03-26 (sync date) excludes all previous period jobs', () => {
    // This is the bug: salary_start_date defaults to sync date (2026-03-26)
    const filtered = filterJobsForMember(marchJobs, '2026-03-26');
    // Only jobs on or after 2026-03-26 pass — that's just 1 out of 5
    expect(filtered.length).toBe(1);
    expect(filtered[0].id).toBe(5);
  });

  test('FIX: salary_start_date=null includes all non-cancelled jobs', () => {
    // With null salary_start_date, no date filter applied
    const filtered = filterJobsForMember(marchJobs, null);
    expect(filtered.length).toBe(5);
  });

  test('FIX: salary_start_date=undefined includes all non-cancelled jobs', () => {
    const filtered = filterJobsForMember(marchJobs, undefined);
    expect(filtered.length).toBe(5);
  });

  test('cancelled jobs still excluded regardless of salary_start_date', () => {
    const jobsWithCancelled = [
      ...marchJobs,
      { id: 6, scheduled_date: '2026-03-28 10:00:00', status: 'cancelled', service_price: 100 },
    ];
    const filtered = filterJobsForMember(jobsWithCancelled, null);
    expect(filtered.length).toBe(5); // cancelled one excluded
    expect(filtered.every(j => j.status !== 'cancelled')).toBe(true);
  });

  test('legitimate salary_start_date (set by user) still works', () => {
    // If user intentionally sets salary_start_date to March 15, jobs before that are excluded
    const filtered = filterJobsForMember(marchJobs, '2026-03-15');
    expect(filtered.length).toBe(3); // Mar 20, 25, 27
    expect(filtered.map(j => j.id)).toEqual([3, 4, 5]);
  });
});

describe('mapTeamMember salary_start_date', () => {
  const zbTeamMember = {
    id: 'zb_123',
    name: 'John Doe',
    email: 'john@example.com',
    phone: '+1234567890',
  };

  test('BUG: old mapTeamMember does not set salary_start_date (DB default = today)', () => {
    const mapped = mapTeamMemberBefore(zbTeamMember, 2);
    expect(mapped.salary_start_date).toBeUndefined();
    // When inserted into DB, salary_start_date defaults to CURRENT_DATE
    // This causes all historical jobs to be excluded from payroll
  });

  test('FIX: new mapTeamMember explicitly sets salary_start_date to null', () => {
    const mapped = mapTeamMemberAfter(zbTeamMember, 2);
    expect(mapped.salary_start_date).toBeNull();
    // Explicit null overrides DB default, so no date filtering applied
  });

  test('mapped fields are correct', () => {
    const mapped = mapTeamMemberAfter(zbTeamMember, 2);
    expect(mapped.user_id).toBe(2);
    expect(mapped.first_name).toBe('John');
    expect(mapped.last_name).toBe('Doe');
    expect(mapped.email).toBe('john@example.com');
    expect(mapped.phone).toBe('+1234567890');
    expect(mapped.zenbooker_id).toBe('zb_123');
  });
});
