/**
 * P0 — Notification Recipient Integrity unit tests.
 *
 * Covers the 8 cases per the audit spec:
 *   - customer phone exists (no collision) → ok
 *   - customer phone missing → skipped
 *   - cleaner phone exists (no collision) → ok
 *   - fallback chain (multiple resolutions) → never tested as "fallback" today; tested as "no fallback exists" guard
 *   - wrong recipient branch (customer-facing resolves to team_member phone) → violation
 *   - cross-tenant path (other-tenant phone collisions ignored) → no violation
 *   - cached stale data (NORMALIZATION — last-10-digit) → catches +1 / formatting variation
 *   - multiple assigned members (multiple team_member rows with same phone) → still detects collision
 *
 * Plus log emitter shape tests (Loki-searchable format).
 */

const {
  VALID_INTENTS,
  normalizePhone,
  maskPhone,
  auditRecipientIntegrity,
  checkKeepSeparateBypass,
  emitNotificationRecipientLog,
  emitRecipientIntegrityViolation,
} = require('../lib/sms-recipient-integrity');

// ────────────────────────────────────────────────────────────────────
// normalizePhone — last-10-digit normalization
// ────────────────────────────────────────────────────────────────────

describe('normalizePhone', () => {
  test('strips +1 prefix', () => { expect(normalizePhone('+17272974561')).toBe('7272974561'); });
  test('strips formatting (parentheses, dashes, spaces)', () => {
    expect(normalizePhone('(727) 297-4561')).toBe('7272974561');
    expect(normalizePhone('727-297-4561')).toBe('7272974561');
    expect(normalizePhone('727 297 4561')).toBe('7272974561');
  });
  test('returns last 10 of long input', () => { expect(normalizePhone('001-727-297-4561')).toBe('7272974561'); });
  test('returns short input as-is', () => { expect(normalizePhone('911')).toBe('911'); });
  test('null/empty → null', () => {
    expect(normalizePhone(null)).toBeNull();
    expect(normalizePhone(undefined)).toBeNull();
    expect(normalizePhone('')).toBeNull();
    expect(normalizePhone('abc')).toBeNull();
  });
});

describe('maskPhone', () => {
  test('shows only last 2 digits', () => { expect(maskPhone('7272974561')).toBe('***61'); });
  test('handles formatted input', () => { expect(maskPhone('(727) 297-4561')).toBe('***61'); });
  test('null → "null"', () => { expect(maskPhone(null)).toBe('null'); });
  test('very short → "***"', () => { expect(maskPhone('5')).toBe('***'); });
});

// ────────────────────────────────────────────────────────────────────
// auditRecipientIntegrity — the eight required cases
// ────────────────────────────────────────────────────────────────────

function makeSupabase({
  teamPhones = [],
  customerPhones = [],
  identityConflicts = [],     // rows of {id, normalized_phone, status, resolution, resolved_at}
  error = null,
  throws = null,
} = {}) {
  return {
    from: jest.fn((tbl) => {
      // identity_conflicts uses a deeper chain: .select().eq().eq().eq().eq().order().limit()
      // The mock applies all eq() filters so tests verify the production
      // query semantics (resolution=keep_separate AND status=resolved).
      if (tbl === 'identity_conflicts') {
        const filters = [];
        const chain = {
          eq: jest.fn(function (col, val) { filters.push([col, val]); return chain; }),
          order: jest.fn(function () { return chain; }),
          limit: jest.fn(async function () {
            if (throws) throw throws;
            if (error) return { data: null, error };
            // Apply every eq() filter to the seed data.
            const filtered = (identityConflicts || []).filter((row) =>
              filters.every(([col, val]) => row[col] === val || (col === 'workspace_id'))
            );
            return { data: filtered, error: null };
          }),
        };
        return { select: jest.fn(() => chain) };
      }
      // team_members / customers chain (existing): .select().eq().not()
      return {
        select: jest.fn(() => ({
          eq: jest.fn(() => ({
            not: jest.fn(async () => {
              if (throws) throw throws;
              if (error) return { data: null, error };
              if (tbl === 'team_members') return { data: teamPhones, error: null };
              if (tbl === 'customers') return { data: customerPhones, error: null };
              return { data: [], error: null };
            }),
          })),
        })),
      };
    }),
  };
}

describe('auditRecipientIntegrity — Case 1: customer phone exists (no collision) → ok', () => {
  test('customer-facing send to unique phone passes', async () => {
    const supabase = makeSupabase({
      teamPhones: [{ id: 2623, phone: '2483462681' }],   // different phone
      customerPhones: [{ id: 23468, phone: '7272974561' }],
    });
    const r = await auditRecipientIntegrity(supabase, {
      userId: 2, intent: 'customer_facing', recipient: '7272974561',
    });
    expect(r.verdict).toBe('ok');
  });
});

describe('auditRecipientIntegrity — Case 2: customer phone missing → skipped', () => {
  test('no recipient → skipped (caller handles upstream)', async () => {
    const supabase = makeSupabase();
    const r = await auditRecipientIntegrity(supabase, {
      userId: 2, intent: 'customer_facing', recipient: null,
    });
    expect(r.verdict).toBe('skipped');
    expect(r.reason).toBe('no_recipient');
  });
});

describe('auditRecipientIntegrity — Case 3: cleaner phone exists (no collision) → ok', () => {
  test('cleaner-facing send to unique phone passes', async () => {
    const supabase = makeSupabase({
      teamPhones: [{ id: 2623, phone: '2483462681' }],
      customerPhones: [{ id: 23468, phone: '7272974561' }],
    });
    const r = await auditRecipientIntegrity(supabase, {
      userId: 2, intent: 'cleaner_facing', recipient: '2483462681',
    });
    expect(r.verdict).toBe('ok');
  });
});

describe('auditRecipientIntegrity — Case 4: fallback chain', () => {
  test('audit is positional on the FINAL resolved recipient — no fallback structure passed in', async () => {
    // SF has no recipient fallback chain (audit confirmed). The integrity
    // check operates on the post-resolution phone only. Test that the
    // helper does not invent fallbacks of its own.
    const supabase = makeSupabase({ teamPhones: [], customerPhones: [] });
    const r = await auditRecipientIntegrity(supabase, {
      userId: 2, intent: 'customer_facing', recipient: '5555550199',
    });
    expect(r.verdict).toBe('ok');
    expect(r.reason).toBe('no_collision');
  });
});

describe('auditRecipientIntegrity — Case 5: WRONG recipient branch → violation', () => {
  test('customer-facing send hitting a team_member phone is BLOCKED', async () => {
    const supabase = makeSupabase({
      teamPhones: [{ id: 2649, first_name: 'Tetiana', last_name: 'V', phone: '7272974561' }],
    });
    const r = await auditRecipientIntegrity(supabase, {
      userId: 2, intent: 'customer_facing', recipient: '7272974561',
    });
    expect(r.verdict).toBe('violation');
    expect(r.reason).toBe('customer_facing_resolved_to_team_member_phone');
    expect(r.collision).toEqual({ table: 'team_members', id: 2649, phone: '7272974561' });
  });

  test('cleaner-facing send hitting a customer phone is BLOCKED', async () => {
    const supabase = makeSupabase({
      customerPhones: [{ id: 23468, phone: '2483462681' }],
    });
    const r = await auditRecipientIntegrity(supabase, {
      userId: 2, intent: 'cleaner_facing', recipient: '2483462681',
    });
    expect(r.verdict).toBe('violation');
    expect(r.reason).toBe('cleaner_facing_resolved_to_customer_phone');
    expect(r.collision.id).toBe(23468);
  });

  test('phone format variation still detected (+1, dashes, parentheses)', async () => {
    const supabase = makeSupabase({
      teamPhones: [{ id: 2649, phone: '+1 (727) 297-4561' }],
    });
    const r = await auditRecipientIntegrity(supabase, {
      userId: 2, intent: 'customer_facing', recipient: '7272974561',
    });
    expect(r.verdict).toBe('violation');
  });
});

describe('auditRecipientIntegrity — Case 6: cross-tenant path (other tenant phones ignored)', () => {
  test('audit query is scoped to userId — collisions in other tenants do not trigger', async () => {
    // The mock returns whatever is provided; tenant scoping is enforced by
    // the .eq('user_id', userId) in the helper. Test that the userId is
    // passed and the result respects it.
    const supabase = {
      from: jest.fn((tbl) => ({
        select: jest.fn(() => ({
          eq: jest.fn((col, val) => {
            expect(col).toBe('user_id');
            expect(val).toBe(2);
            return {
              not: jest.fn(async () => ({ data: [], error: null })),
            };
          }),
        })),
      })),
    };
    const r = await auditRecipientIntegrity(supabase, {
      userId: 2, intent: 'customer_facing', recipient: '7272974561',
    });
    expect(r.verdict).toBe('ok');
  });
});

describe('auditRecipientIntegrity — Case 7: cached stale data (normalization defends)', () => {
  test('phone stored with country code but recipient supplied without → collision still detected', async () => {
    const supabase = makeSupabase({
      teamPhones: [{ id: 2649, phone: '17272974561' }],   // stored with leading "1"
    });
    const r = await auditRecipientIntegrity(supabase, {
      userId: 2, intent: 'customer_facing', recipient: '7272974561',  // sent without
    });
    expect(r.verdict).toBe('violation');
  });

  test('phone stored as +1 (727) 297-4561 collides with raw 7272974561', async () => {
    const supabase = makeSupabase({
      teamPhones: [{ id: 2649, phone: '+1 (727) 297-4561' }],
    });
    const r = await auditRecipientIntegrity(supabase, {
      userId: 2, intent: 'customer_facing', recipient: '7272974561',
    });
    expect(r.verdict).toBe('violation');
  });
});

describe('auditRecipientIntegrity — Case 8: multiple assigned members / multiple rows', () => {
  test('multiple team_members rows: any collision triggers violation', async () => {
    const supabase = makeSupabase({
      teamPhones: [
        { id: 2623, phone: '2483462681' },
        { id: 2649, phone: '7272974561' },    // ← collision target
        { id: 2673, phone: '5555550199' },
      ],
    });
    const r = await auditRecipientIntegrity(supabase, {
      userId: 2, intent: 'customer_facing', recipient: '7272974561',
    });
    expect(r.verdict).toBe('violation');
    expect(r.collision.id).toBe(2649);
  });

  test('multiple customer rows on the same number (P-03 risk pattern)', async () => {
    // Real-world data from 2026-05-20 audit: phone 2483462681 appears
    // on 3 customer rows. Cleaner-facing audit must still flag it.
    const supabase = makeSupabase({
      customerPhones: [
        { id: 1001, phone: '2483462681' },
        { id: 1002, phone: '2483462681' },
        { id: 1003, phone: '2483462681' },
      ],
    });
    const r = await auditRecipientIntegrity(supabase, {
      userId: 2, intent: 'cleaner_facing', recipient: '2483462681',
    });
    expect(r.verdict).toBe('violation');
  });
});

// ────────────────────────────────────────────────────────────────────
// Defensive: fail-open on lookup error, no throw on bad input
// ────────────────────────────────────────────────────────────────────

describe('auditRecipientIntegrity — fail-open semantics', () => {
  test('supabase lookup error → verdict=ok (fail open) + logger.warn', async () => {
    const supabase = makeSupabase({ error: { message: 'db hiccup' } });
    const logger = { warn: jest.fn() };
    const r = await auditRecipientIntegrity(supabase, {
      userId: 2, intent: 'customer_facing', recipient: '7272974561', logger,
    });
    expect(r.verdict).toBe('ok');
    expect(r.reason).toBe('lookup_error');
    expect(logger.warn).toHaveBeenCalled();
  });

  test('exception → verdict=ok (fail open)', async () => {
    const supabase = makeSupabase({ throws: new Error('boom') });
    const r = await auditRecipientIntegrity(supabase, {
      userId: 2, intent: 'customer_facing', recipient: '7272974561',
    });
    expect(r.verdict).toBe('ok');
  });

  test('no intent → skipped (legacy callers continue working)', async () => {
    const supabase = makeSupabase({ teamPhones: [{ id: 1, phone: '7272974561' }] });
    const r = await auditRecipientIntegrity(supabase, {
      userId: 2, recipient: '7272974561',  // no intent
    });
    expect(r.verdict).toBe('skipped');
    expect(r.reason).toBe('no_intent');
  });

  test('external_caller_supplied intent → skipped (role-exclusivity not enforced)', async () => {
    const supabase = makeSupabase({ teamPhones: [{ id: 1, phone: '7272974561' }] });
    const r = await auditRecipientIntegrity(supabase, {
      userId: 2, intent: 'external_caller_supplied', recipient: '7272974561',
    });
    expect(r.verdict).toBe('skipped');
    expect(r.reason).toBe('intent_not_role_scoped');
  });
});

// ────────────────────────────────────────────────────────────────────
// Log emitters — Loki-searchable shape
// ────────────────────────────────────────────────────────────────────

describe('emitNotificationRecipientLog', () => {
  test('emits structured log with all required fields', () => {
    const logger = { log: jest.fn() };
    emitNotificationRecipientLog(logger, {
      message_type: 'job_confirmation_no_email_sms',
      resolved_phone: '7272974561',
      source: 'customers.phone',
      fallback_depth: 0,
      customer_id: 23468,
      team_member_id: null,
      job_id: 142215,
      workspace_id: 2,
      twilio_sid: 'SM123',
      path: 'P-01',
    });
    const msg = logger.log.mock.calls[0][0];
    expect(msg).toMatch(/^\[NotificationRecipient\]/);
    expect(msg).toMatch(/message_type=job_confirmation_no_email_sms/);
    expect(msg).toMatch(/resolved_phone=\*\*\*61/);   // masked
    expect(msg).toMatch(/source=customers\.phone/);
    expect(msg).toMatch(/fallback_depth=0/);
    expect(msg).toMatch(/customer_id=23468/);
    expect(msg).toMatch(/team_member_id=null/);
    expect(msg).toMatch(/job_id=142215/);
    expect(msg).toMatch(/workspace_id=2/);
    expect(msg).toMatch(/twilio_sid=SM123/);
    expect(msg).toMatch(/path=P-01/);
  });

  test('phone is always masked (never raw in log)', () => {
    const logger = { log: jest.fn() };
    emitNotificationRecipientLog(logger, { resolved_phone: '7272974561' });
    const msg = logger.log.mock.calls[0][0];
    expect(msg).not.toMatch(/7272974561/);
    expect(msg).toMatch(/\*\*\*61/);
  });

  test('result + error are included when present', () => {
    const logger = { log: jest.fn() };
    emitNotificationRecipientLog(logger, {
      message_type: 'x', resolved_phone: '7272974561',
      result: 'success', twilio_sid: 'SM999',
    });
    expect(logger.log.mock.calls[0][0]).toMatch(/result=success/);
  });

  test('does not crash when logger is missing', () => {
    expect(() => emitNotificationRecipientLog(null, {})).not.toThrow();
    expect(() => emitNotificationRecipientLog({}, {})).not.toThrow();
  });
});

describe('emitRecipientIntegrityViolation', () => {
  test('emits structured error log with collision metadata', () => {
    const logger = { error: jest.fn() };
    emitRecipientIntegrityViolation(logger, {
      message_type: 'job_confirmation_no_email_sms',
      intent: 'customer_facing',
      resolved_phone: '7272974561',
      source: 'customers.phone',
      reason: 'customer_facing_resolved_to_team_member_phone',
      customer_id: 23468,
      team_member_id: null,
      collision_table: 'team_members',
      collision_id: 2649,
      job_id: 142215,
      workspace_id: 2,
      path: 'P-01',
    });
    const msg = logger.error.mock.calls[0][0];
    expect(msg).toMatch(/^\[RecipientIntegrityViolation\]/);
    expect(msg).toMatch(/intent=customer_facing/);
    expect(msg).toMatch(/reason=customer_facing_resolved_to_team_member_phone/);
    expect(msg).toMatch(/collision_table=team_members/);
    expect(msg).toMatch(/collision_id=2649/);
    expect(msg).toMatch(/action=blocked/);
  });

  test('phone is masked in violation log too', () => {
    const logger = { error: jest.fn() };
    emitRecipientIntegrityViolation(logger, { resolved_phone: '7272974561' });
    expect(logger.error.mock.calls[0][0]).not.toMatch(/7272974561/);
  });

  test('does not crash when logger.error is missing', () => {
    expect(() => emitRecipientIntegrityViolation(null, {})).not.toThrow();
    expect(() => emitRecipientIntegrityViolation({ log: () => {} }, {})).not.toThrow();
  });
});

// ────────────────────────────────────────────────────────────────────
// P0.1.1 (2026-05-21) — `keep_separate` bypass
// When the operator has explicitly resolved a conflict with
// resolution='keep_separate' in identity_conflicts, that's consent;
// subsequent SMS to that phone goes through with audit trail.
// ────────────────────────────────────────────────────────────────────

describe('auditRecipientIntegrity — keep_separate bypass', () => {
  test('collision exists + keep_separate resolved → verdict=ok, reason=bypassed_by_keep_separate', async () => {
    const supabase = makeSupabase({
      teamPhones: [{ id: 2623, phone: '2483462681' }],
      identityConflicts: [{
        id: 1, normalized_phone: '2483462681', status: 'resolved',
        resolution: 'keep_separate', resolved_at: '2026-05-21T08:00:00Z',
      }],
    });
    const r = await auditRecipientIntegrity(supabase, {
      userId: 2, intent: 'customer_facing', recipient: '2483462681',
    });
    expect(r.verdict).toBe('ok');
    expect(r.reason).toBe('bypassed_by_keep_separate');
    expect(r.collision).toBeDefined();
    expect(r.bypass.conflict_id).toBe(1);
  });

  test('collision exists + resolution=ignore → still violation (no consent)', async () => {
    const supabase = makeSupabase({
      teamPhones: [{ id: 2623, phone: '2483462681' }],
      identityConflicts: [{
        id: 1, normalized_phone: '2483462681', status: 'resolved',
        resolution: 'ignore', resolved_at: '2026-05-21T08:00:00Z',
      }],
    });
    const r = await auditRecipientIntegrity(supabase, {
      userId: 2, intent: 'customer_facing', recipient: '2483462681',
    });
    // resolution='ignore' is NOT consent — only keep_separate bypasses.
    // The bypass query filters resolution='keep_separate' so this returns no row.
    expect(r.verdict).toBe('violation');
  });

  test('collision exists + status=open → still violation', async () => {
    const supabase = makeSupabase({
      teamPhones: [{ id: 2623, phone: '2483462681' }],
      identityConflicts: [{
        id: 1, normalized_phone: '2483462681', status: 'open',
        resolution: null, resolved_at: null,
      }],
    });
    const r = await auditRecipientIntegrity(supabase, {
      userId: 2, intent: 'customer_facing', recipient: '2483462681',
    });
    expect(r.verdict).toBe('violation');
  });

  test('no collision + keep_separate row exists → verdict=ok (bypass not needed)', async () => {
    const supabase = makeSupabase({
      teamPhones: [],
      identityConflicts: [{
        id: 1, normalized_phone: '2483462681', status: 'resolved',
        resolution: 'keep_separate',
      }],
    });
    const r = await auditRecipientIntegrity(supabase, {
      userId: 2, intent: 'customer_facing', recipient: '2483462681',
    });
    expect(r.verdict).toBe('ok');
    expect(r.reason).toBe('no_collision');
  });

  test('keep_separate bypass is tenant-scoped (workspace_id filter)', async () => {
    // The mock's bypass chain accepts any sequence of .eq() calls and
    // returns the same identityConflicts dataset. We verify the actual
    // helper applies the .eq('workspace_id', userId) constraint by
    // inspecting the chain's eq mock.
    const eqCalls = [];
    const supabase = {
      from: jest.fn((tbl) => {
        if (tbl === 'identity_conflicts') {
          const chain = {
            eq: jest.fn(function (col, val) {
              eqCalls.push([col, val]);
              return chain;
            }),
            order: jest.fn(function () { return chain; }),
            limit: jest.fn(async () => ({ data: [], error: null })),
          };
          return { select: jest.fn(() => chain) };
        }
        return {
          select: jest.fn(() => ({
            eq: jest.fn(() => ({
              not: jest.fn(async () => ({ data: [{ id: 1, phone: '2483462681' }], error: null })),
            })),
          })),
        };
      }),
    };
    await auditRecipientIntegrity(supabase, {
      userId: 2, intent: 'customer_facing', recipient: '2483462681',
    });
    // Verify the bypass query applied workspace_id=2 + the right phone +
    // status=resolved + resolution=keep_separate
    expect(eqCalls).toEqual(expect.arrayContaining([
      ['workspace_id', 2],
      ['normalized_phone', '2483462681'],
      ['status', 'resolved'],
      ['resolution', 'keep_separate'],
    ]));
  });
});

describe('checkKeepSeparateBypass — direct unit tests', () => {
  test('returns found=true when matching keep_separate row exists', async () => {
    const supabase = makeSupabase({
      identityConflicts: [{
        id: 18, normalized_phone: '2483462681',
        status: 'resolved', resolution: 'keep_separate',
        resolved_at: '2026-05-21T12:00:00Z',
      }],
    });
    const r = await checkKeepSeparateBypass(supabase, 2, '2483462681');
    expect(r.found).toBe(true);
    expect(r.conflictId).toBe(18);
    expect(r.resolvedAt).toBe('2026-05-21T12:00:00Z');
  });

  test('returns found=false when no matching row', async () => {
    const supabase = makeSupabase({ identityConflicts: [] });
    const r = await checkKeepSeparateBypass(supabase, 2, '2483462681');
    expect(r.found).toBe(false);
  });

  test('fail-open on supabase error', async () => {
    const supabase = makeSupabase({ error: { message: 'db hiccup' } });
    const logger = { warn: jest.fn() };
    const r = await checkKeepSeparateBypass(supabase, 2, '2483462681', logger);
    expect(r.found).toBe(false);
    expect(logger.warn).toHaveBeenCalled();
  });

  test('fail-open on throw', async () => {
    const supabase = makeSupabase({ throws: new Error('boom') });
    const r = await checkKeepSeparateBypass(supabase, 2, '2483462681');
    expect(r.found).toBe(false);
  });
});

describe('VALID_INTENTS export', () => {
  test('lists the five canonical intents', () => {
    expect(VALID_INTENTS).toEqual([
      'customer_facing',
      'cleaner_facing',
      'external_caller_supplied',
      'conversation_reply',
      'system_test',
    ]);
  });
});
