/**
 * F1 (2026-05-20) — `persistConfirmationStatus` unit tests.
 *
 * Replaces the prior inline `supabase.from('jobs').update(...)` calls in
 * server.js POST /api/jobs handler. The old call sites did NOT inspect
 * the `{ error }` object returned by Supabase, so a non-existent column
 * (`confirmation_method`) silently failed and audit columns
 * (`sms_sent`, `sms_phone`, `sms_sid`) were never persisted, even when
 * the underlying SMS WAS sent.
 *
 * Investigation: SF job 142213 on 2026-05-20. See
 * docs/architecture/zb-outbound-command-confirmation.md §1.F and the
 * job-create-contract-discovery follow-up notes.
 */

const { persistConfirmationStatus } = require('../lib/job-confirmation-updater');

function makeSupabase({ error = null, throws = null } = {}) {
  const captured = {};
  return {
    captured,
    from: jest.fn((tbl) => {
      captured.table = tbl;
      return {
        update: jest.fn((patch) => {
          captured.patch = patch;
          return {
            eq: jest.fn(async (col, val) => {
              captured.column = col;
              captured.value = val;
              if (throws) throw throws;
              return { error, data: null };
            }),
          };
        }),
      };
    }),
  };
}

describe('persistConfirmationStatus — success path', () => {
  test('successful SMS update writes sms_sent=true and persists sms_sid', async () => {
    const supabase = makeSupabase();
    const logger = { log: jest.fn(), error: jest.fn() };
    const patch = {
      confirmation_sent: true,
      confirmation_sent_at: '2026-05-20T02:09:55.609Z',
      sms_sent: true,
      sms_sent_at: '2026-05-20T02:09:55.609Z',
      sms_phone: '7272974561',
      sms_sid: 'SM1234567890abcdef',
      sms_failed: false,
      sms_error: null,
    };

    const result = await persistConfirmationStatus(supabase, logger, 142213, patch, 'sms_no_email_success');

    expect(result).toEqual({ ok: true });
    expect(supabase.captured.table).toBe('jobs');
    expect(supabase.captured.column).toBe('id');
    expect(supabase.captured.value).toBe(142213);
    expect(supabase.captured.patch.sms_sent).toBe(true);
    expect(supabase.captured.patch.sms_sid).toBe('SM1234567890abcdef');
    expect(supabase.captured.patch.sms_phone).toBe('7272974561');
    // Critical regression guard: 2026-05-20 root cause was a non-existent
    // column being included in the patch. The new sites must NEVER include
    // it. Callers should not be able to introduce it through the helper.
    expect(supabase.captured.patch).not.toHaveProperty('confirmation_method');
  });

  test('emits a structured success log via logger.log', async () => {
    const supabase = makeSupabase();
    const logger = { log: jest.fn(), error: jest.fn() };

    await persistConfirmationStatus(supabase, logger, 142213, { sms_sent: true }, 'sms_no_email_success');

    expect(logger.log).toHaveBeenCalledWith(
      expect.stringMatching(/\[JobConfirmation\] update ok job=142213 context=sms_no_email_success/)
    );
    expect(logger.error).not.toHaveBeenCalled();
  });

  test('passes patch through verbatim — no key mutation', async () => {
    const supabase = makeSupabase();
    const logger = { log: jest.fn(), error: jest.fn() };
    const patch = { confirmation_sent: true, confirmation_email: 'a@b.com' };

    await persistConfirmationStatus(supabase, logger, 100, patch, 'email_success');

    expect(supabase.captured.patch).toEqual(patch);
  });
});

describe('persistConfirmationStatus — update failure path', () => {
  test('Supabase column-missing error → ok=false + structured logger.error', async () => {
    const supabase = makeSupabase({
      error: { code: '42703', message: 'column "confirmation_method" does not exist' },
    });
    const logger = { log: jest.fn(), error: jest.fn() };

    const result = await persistConfirmationStatus(supabase, logger, 142213, {
      confirmation_method: 'sms', // (only here to make the test explicit; helper passes verbatim)
    }, 'sms_no_email_success');

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/confirmation_method.*does not exist/);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringMatching(/\[JobConfirmation\] update failed job=142213 context=sms_no_email_success error=column "confirmation_method" does not exist/)
    );
    expect(logger.log).not.toHaveBeenCalled();
  });

  test('Supabase generic error → ok=false + logger.error', async () => {
    const supabase = makeSupabase({ error: { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' } });
    const logger = { log: jest.fn(), error: jest.fn() };

    const result = await persistConfirmationStatus(supabase, logger, 142213, { sms_sent: true }, 'sms_no_email_success');

    expect(result.ok).toBe(false);
    expect(logger.error).toHaveBeenCalled();
  });

  test('thrown exception → ok=false + logger.error (NEVER throws)', async () => {
    const supabase = makeSupabase({ throws: new Error('connection refused') });
    const logger = { log: jest.fn(), error: jest.fn() };

    const result = await persistConfirmationStatus(supabase, logger, 142213, { sms_sent: true }, 'sms_no_email_success');

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/connection refused/);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringMatching(/\[JobConfirmation\] update threw job=142213 context=sms_no_email_success error=connection refused/)
    );
  });
});

describe('persistConfirmationStatus — input validation', () => {
  test('missing supabase → ok=false + logger.error (no throw)', async () => {
    const logger = { log: jest.fn(), error: jest.fn() };
    const result = await persistConfirmationStatus(null, logger, 142213, { sms_sent: true }, 'x');
    expect(result.ok).toBe(false);
    expect(result.error).toBe('invalid_input');
    expect(logger.error).toHaveBeenCalled();
  });

  test('missing jobId → ok=false', async () => {
    const supabase = makeSupabase();
    const logger = { log: jest.fn(), error: jest.fn() };
    const result = await persistConfirmationStatus(supabase, logger, null, { sms_sent: true }, 'x');
    expect(result.ok).toBe(false);
  });

  test('missing patch → ok=false', async () => {
    const supabase = makeSupabase();
    const logger = { log: jest.fn(), error: jest.fn() };
    const result = await persistConfirmationStatus(supabase, logger, 142213, null, 'x');
    expect(result.ok).toBe(false);
  });

  test('context defaults to "unspecified" when omitted', async () => {
    const supabase = makeSupabase();
    const logger = { log: jest.fn(), error: jest.fn() };
    await persistConfirmationStatus(supabase, logger, 142213, { sms_sent: true });
    expect(logger.log).toHaveBeenCalledWith(expect.stringMatching(/context=unspecified/));
  });
});

describe('persistConfirmationStatus — defensive logging', () => {
  test('does not crash when logger is missing', async () => {
    const supabase = makeSupabase();
    const r = await persistConfirmationStatus(supabase, null, 142213, { sms_sent: true }, 'x');
    expect(r.ok).toBe(true);
  });

  test('does not crash when logger has no log/error methods', async () => {
    const supabase = makeSupabase({ error: { message: 'oops' } });
    const r = await persistConfirmationStatus(supabase, {}, 142213, { sms_sent: true }, 'x');
    expect(r.ok).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────
// Static guard: server.js must NOT contain `confirmation_method` in any
// jobs.update payload — that column does not exist on jobs and was the
// 2026-05-20 silent-failure root cause.
// ────────────────────────────────────────────────────────────────────

describe('server.js — confirmation_method regression guard', () => {
  test('server.js no longer uses confirmation_method as an update key', () => {
    const fs = require('fs');
    const path = require('path');
    const serverPath = path.resolve(__dirname, '..', 'server.js');
    const src = fs.readFileSync(serverPath, 'utf8');
    // Match `confirmation_method:` (object key usage) but allow it to
    // appear in code comments / commit-message-style strings explaining
    // the removal.
    expect(src).not.toMatch(/confirmation_method\s*:/);
  });
});
