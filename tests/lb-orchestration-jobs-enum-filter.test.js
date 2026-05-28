'use strict';

/**
 * Static-scan regression: SF jobs.status enum filter safety.
 *
 * The job_status Postgres enum contains:
 *   pending, confirmed, in-progress, completed, cancelled, scheduled,
 *   en-route, started, complete, late, rescheduled, paid
 *
 * It does NOT contain:
 *   canceled (American spelling), no-show, no_show, archived, lost
 *
 * If any orchestration query passes one of those non-enum strings to
 * a PostgREST .in(...) or .not(..., 'in', ...) clause on the jobs
 * table, Postgres rejects the entire query with:
 *   invalid input value for enum job_status: "canceled"
 *
 * This bug killed the orchestration /availability call in the staging
 * round-trip (2026-05-28). Fixed in:
 *   - lib/lb-orchestration-availability.js  (fetchOverlappingJobs)
 *   - lib/lb-orchestration-handlers.js      (booking-request overlap re-check)
 *
 * This static scan asserts the bug doesn't sneak back in.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// Strings that are NOT in the job_status enum. Any orchestration query
// using one of these on the `jobs` table will hard-fail at Postgres.
const INVALID_ENUM_LABELS = ['canceled', 'no-show', 'no_show', 'archived', 'lost'];

const ORCHESTRATION_QUERY_FILES = [
  'lib/lb-orchestration-availability.js',
  'lib/lb-orchestration-handlers.js',
];

describe('SF jobs.status enum filter safety (regression for 2026-05-28 staging bug)', () => {
  for (const rel of ORCHESTRATION_QUERY_FILES) {
    test(`${rel} contains no invalid job_status enum labels in status filters`, () => {
      const full = path.join(ROOT, rel);
      const src  = fs.readFileSync(full, 'utf8');

      // Filter status-related lines so the comment block describing
      // the enum doesn't trigger a false positive on its mentions.
      // We specifically scan lines that look like a PostgREST filter
      // call: .in(...) / .not(..., 'in', ...) / .eq('status', ...) /
      // .neq('status', ...).
      const lines = src.split(/\r?\n/);
      const filterLineRegex = /\.(in|not|eq|neq)\s*\(/;
      const offenders = [];
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!filterLineRegex.test(line)) continue;
        for (const bad of INVALID_ENUM_LABELS) {
          // Match the literal as a quoted string token to avoid false
          // positives on substrings of valid words.
          const re = new RegExp(`['"\`]${bad}['"\`]|[\\(,\\s]${bad}[,\\)]`);
          if (re.test(line)) {
            offenders.push({ line: i + 1, label: bad, snippet: line.trim().slice(0, 140) });
          }
        }
      }
      if (offenders.length) {
        const msg = offenders.map((o) => `  line ${o.line} uses invalid enum '${o.label}': ${o.snippet}`).join('\n');
        throw new Error(`Invalid job_status enum labels in PostgREST status filter in ${rel}:\n${msg}\n\nValid enum: pending, confirmed, in-progress, completed, cancelled, scheduled, en-route, started, complete, late, rescheduled, paid`);
      }
      expect(offenders).toHaveLength(0);
    });
  }

  test('valid enum reference: "cancelled" (British) IS in both files', () => {
    // Sanity: confirms the fix is in place (we filter against the
    // CORRECT spelling).
    for (const rel of ORCHESTRATION_QUERY_FILES) {
      const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      expect(src).toMatch(/['"`]cancelled['"`]/);
    }
  });
});
