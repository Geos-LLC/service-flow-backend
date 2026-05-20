/**
 * F3 (2026-05-20) — confirmation/SMS flow observability regression guard.
 *
 * Root cause (investigation of SF job 142213, 2026-05-20): the entire
 * confirmation flow in POST /api/jobs used plain `console.log` and
 * `console.error` (with emoji prefixes). The platform's Loki forwarder
 * only ships `logger.X()` output — so SMS sends and their outcomes were
 * INVISIBLE in production observability. Combined with F1 (silent UPDATE
 * failure on `confirmation_method`), the SMS pipeline had zero forensic
 * trail despite actually delivering messages.
 *
 * This guard pins the confirmation block in server.js to:
 *   - ZERO console.log / console.error / console.warn calls
 *   - structured logger.X calls with the `[JobConfirmation]` prefix
 *
 * The prefix convention matches the rest of the codebase (`[Territory
 * resolver]`, `[ZB Outbound]`, `[Zenbooker]`, etc.) so a single Loki
 * filter `|~ "JobConfirmation"` surfaces all confirmation activity.
 */

const fs = require('fs');
const path = require('path');

const SERVER_SRC = fs.readFileSync(path.resolve(__dirname, '..', 'server.js'), 'utf8');

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/([^:'"`])\/\/.*$/gm, '$1');
}

/**
 * Slice the confirmation block: from `// Send automatic confirmation if customer has email`
 * to the closing brace of its outer `if (result.customer_id) {` block.
 *
 * Anchored by the comment line that introduces the block + the F2
 * documentation comment that immediately follows the block.
 */
function extractConfirmationBlock(src) {
  const startMatch = src.match(/\/\/ Send automatic confirmation if customer has email/);
  if (!startMatch) throw new Error('Could not locate confirmation block start in server.js');
  const start = startMatch.index;
  // The F2 comment now sits between the confirmation block and the
  // team-assignments section. Use it as the end anchor.
  const remainder = src.slice(start);
  const endMatch = remainder.match(/\/\/ F2 \(2026-05-20\): legacy/);
  if (!endMatch) throw new Error('Could not locate F2 anchor (confirmation block end) in server.js');
  return src.slice(start, start + endMatch.index);
}

describe('confirmation block — F3 observability regression guard', () => {
  const block = extractConfirmationBlock(SERVER_SRC);
  const blockStripped = stripComments(block);

  test('confirmation block exists', () => {
    expect(block.length).toBeGreaterThan(0);
  });

  test('zero console.log / console.error / console.warn in the confirmation block', () => {
    // Use the comment-stripped version so commit-message-style explanations
    // referencing the old console calls don't false-positive.
    expect(blockStripped).not.toMatch(/console\.log\(/);
    expect(blockStripped).not.toMatch(/console\.error\(/);
    expect(blockStripped).not.toMatch(/console\.warn\(/);
  });

  test('uses structured logger.log calls', () => {
    expect(blockStripped).toMatch(/logger\.log\(/);
  });

  test('uses structured logger.error calls for failure paths', () => {
    expect(blockStripped).toMatch(/logger\.error\(/);
  });

  test('every log line uses the [JobConfirmation] prefix (Loki-searchable)', () => {
    // Find every logger.{log,error,warn,debug}(...) call in the stripped
    // block and verify each contains `[JobConfirmation]` in its first
    // string argument.
    const callsWithoutPrefix = [];
    const re = /logger\.(log|error|warn|debug)\(([^)]*)\)/g;
    let m;
    while ((m = re.exec(blockStripped)) !== null) {
      const args = m[2];
      if (!/\[JobConfirmation\]/.test(args)) {
        callsWithoutPrefix.push(m[0].slice(0, 120));
      }
    }
    expect(callsWithoutPrefix).toEqual([]);
  });

  test('SMS success path emits a structured log line', () => {
    expect(blockStripped).toMatch(/\[JobConfirmation\][^']*✅[^']*SMS sent/);
  });

  test('SMS failure path emits a structured error line', () => {
    expect(blockStripped).toMatch(/logger\.error\([^)]*SMS sending failed/);
  });

  test('email success path emits a structured log line', () => {
    expect(blockStripped).toMatch(/\[JobConfirmation\][^']*✅[^']*email sent/);
  });

  test('email failure path emits a structured error line', () => {
    expect(blockStripped).toMatch(/logger\.error\([^)]*Error sending automatic confirmation email/);
  });
});

// ────────────────────────────────────────────────────────────────────
// Helper-side: persistConfirmationStatus emits the same structured
// prefix so a single Loki query surfaces both inline and helper logs.
// (Covered in detail by tests/job-confirmation-updater.test.js — this
// is the cross-reference sanity check.)
// ────────────────────────────────────────────────────────────────────

describe('persistConfirmationStatus — log prefix consistency', () => {
  const { persistConfirmationStatus } = require('../lib/job-confirmation-updater');

  function makeSupabase({ error = null } = {}) {
    return {
      from: jest.fn(() => ({
        update: jest.fn(() => ({
          eq: jest.fn(async () => ({ error, data: null })),
        })),
      })),
    };
  }

  test('success log uses [JobConfirmation] prefix', async () => {
    const supabase = makeSupabase();
    const logger = { log: jest.fn(), error: jest.fn() };
    await persistConfirmationStatus(supabase, logger, 142213, { sms_sent: true }, 'sms_no_email_success');
    expect(logger.log).toHaveBeenCalledWith(expect.stringMatching(/^\[JobConfirmation\]/));
  });

  test('error log uses [JobConfirmation] prefix', async () => {
    const supabase = makeSupabase({ error: { message: 'oops' } });
    const logger = { log: jest.fn(), error: jest.fn() };
    await persistConfirmationStatus(supabase, logger, 142213, { sms_sent: true }, 'sms_no_email_success');
    expect(logger.error).toHaveBeenCalledWith(expect.stringMatching(/^\[JobConfirmation\]/));
  });
});
