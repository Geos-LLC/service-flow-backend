/**
 * F2 (2026-05-20) — POST /api/jobs response shape regression guard.
 *
 * Root cause (investigation of SF job 142213, 2026-05-20): the handler
 * had two unconditional `res.json` calls on the success path — an
 * early `res.json({ success: true, ..., job: result })` and a later
 * canonical `res.status(201).json({ ..., job: createdJob[0], warnings })`.
 * Both fired on every successful creation; the second call threw
 * `ERR_HTTP_HEADERS_SENT`. The outer catch then tried `res.status(500)`,
 * which also crashed, surfacing as an unhandled rejection.
 *
 * This guard locks the POST /api/jobs success path to **exactly one**
 * response and the canonical 201 shape so any future re-introduction
 * of a duplicate path fails CI before it can ship.
 *
 * Strategy: static analysis of server.js text. Full integration of the
 * handler via supertest would require booting the entire app
 * (auth + Supabase + Twilio + LB + ZB outbound modules) — heavier than
 * the bug warrants. The static guards are sufficient to prevent
 * recurrence of the exact pattern that broke.
 */

const fs = require('fs');
const path = require('path');

const SERVER_SRC = fs.readFileSync(path.resolve(__dirname, '..', 'server.js'), 'utf8');

/**
 * Slice the source code containing the POST /api/jobs handler so the
 * regexes below don't false-positive on unrelated endpoints.
 *
 * Boundary: from `app.post('/api/jobs',` to the next top-level
 * `app.post(`, `app.get(`, `app.patch(`, `app.delete(`, or `app.put(`.
 */
// Strip JavaScript single-line and multi-line comments from source so the
// structural regexes below don't match comment-embedded code references
// like the F2 documentation comment that explains the removed legacy
// response. Naive but safe enough for this test.
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')      // multi-line comments
    .replace(/^\s*\/\/.*$/gm, '')           // full-line single comments
    .replace(/([^:'"`])\/\/.*$/gm, '$1');   // trailing single comments (skip URLs `http://`)
}

function extractPostJobsHandler(src) {
  // Start: `app.post('/api/jobs', ...)` exactly — quote terminator after
  // the path so we don't pick up `/api/jobs/:id/claim`, etc.
  const startMatch = src.match(/app\.post\(\s*['"]\/api\/jobs['"]\s*,/);
  if (!startMatch) throw new Error('Could not locate POST /api/jobs handler in server.js');
  const start = startMatch.index;

  // End: the next anchored route after this handler is
  // `app.patch('/api/jobs/:id/status', ...)`.
  const remainder = src.slice(start + startMatch[0].length);
  const endMatch = remainder.match(/app\.patch\(\s*['"]\/api\/jobs\/:id\/status['"]/);
  const end = endMatch
    ? start + startMatch[0].length + endMatch.index
    : src.length;
  return stripComments(src.slice(start, end));
}

describe('POST /api/jobs — response shape (F2 regression guard)', () => {
  const handler = extractPostJobsHandler(SERVER_SRC);

  test('handler exists in server.js', () => {
    expect(handler.length).toBeGreaterThan(0);
    expect(handler).toMatch(/app\.post\(\s*['"]\/api\/jobs['"]/);
  });

  test('the legacy "success: true ... job: result" response is gone', () => {
    // The 2026-05-20 incident response: res.json({ success: true, message: 'Job created successfully', job: result })
    // Any line containing both `success: true` and `job: result` together is the legacy shape.
    expect(handler).not.toMatch(/res\.json\(\s*\{\s*success:\s*true[\s\S]{0,200}job:\s*result\s*\}/);
  });

  test('the canonical 201 response is present', () => {
    // The keeper: res.status(201).json({ message, job: createdJob[0], warnings })
    expect(handler).toMatch(/res\.status\(\s*201\s*\)\.json\(/);
  });

  test('success path emits exactly ONE response (no duplicate res.json before the 201)', () => {
    // Find every res.json / res.status(...).json on the success path.
    // We allow:
    //   - the canonical res.status(201).json(...)
    //   - the early-return res.status(500).json(...) inside `if (insertError)`
    //   - the early-return res.status(500).json(...) inside `if (fetchError)`
    //   - the outer catch's res.status(500).json(...)
    // We disallow ANY OTHER res.json or res.status(2XX).json — only one
    // success response shape may exist.
    const responseCalls = [];
    const re = /res\.(?:status\(\s*(\d+)\s*\)\.)?json\(/g;
    let m;
    while ((m = re.exec(handler)) !== null) {
      const status = m[1] ? parseInt(m[1], 10) : 200;
      responseCalls.push({ status, index: m.index });
    }
    const successResponses = responseCalls.filter((c) => c.status >= 200 && c.status < 300);
    expect(successResponses).toHaveLength(1);
    expect(successResponses[0].status).toBe(201);
  });

  test('no ERR_HTTP_HEADERS_SENT pattern: success response not followed by additional unguarded res.X', () => {
    // After the 201 response, the function should end (close braces only).
    // No further `res.X(...)` calls should appear AFTER res.status(201).json
    // in the handler text.
    const idx201 = handler.search(/res\.status\(\s*201\s*\)\.json\(/);
    expect(idx201).toBeGreaterThan(0);
    const after = handler.slice(idx201);
    // Allow the outer catch's res.status(500) which is conditional on a
    // thrown exception in the success path — that's safe.
    const stray = after.match(/res\.json\(/g) || [];
    expect(stray).toHaveLength(0);
  });
});
