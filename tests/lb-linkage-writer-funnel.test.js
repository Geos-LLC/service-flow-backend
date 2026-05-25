/**
 * Writer-funnel test for LB linkage invariant.
 *
 * Source-text scan that fails the build if any new `from('jobs').insert(...)`
 * site is added without a nearby (within 50 lines above) call to
 * `resolveLbLinkage(` or `linkageFromParentJob(`.
 *
 * Why source-text: same precedent as status-writer-funnel — a runtime
 * test would need a live DB, but the invariant is structural ("every
 * jobs INSERT must consult the resolver"), so a static grep catches
 * the bypass at PR time. No false negatives — the test scans the entire
 * tree minus the explicit allowlist below.
 *
 * To add a new exemption, document why in the inline comment and add
 * the file to ALLOWED_INSERT_SITES.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// Files allowed to call `.from('jobs').insert(...)` without first
// calling the resolver. Keep this list minimal and well-justified.
const ALLOWED_INSERT_SITES = new Set([
  // test-sync.js is a developer tool, not prod code (not require'd by server.js)
  'test-sync.js',
]);

const SKIP_DIRS = new Set(['node_modules', 'tests', '__tests__', '.git', 'dist', 'build', 'uploads', 'docs', 'migrations', 'scripts', 'lib/zb-cleanup']);
const SKIP_EXT_OK = new Set(['.js', '.cjs', '.mjs']);

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(path.join(dir, entry.name), out);
    } else if (entry.isFile() && SKIP_EXT_OK.has(path.extname(entry.name))) {
      if (entry.name.endsWith('.test.js') || entry.name.endsWith('.spec.js')) continue;
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

// Match `.from('jobs').insert(...` (the open paren is enough — the
// argument shape varies).
const INSERT_RE = /\.from\(\s*['"`]jobs['"`]\s*\)\s*\.insert\s*\(/g;
const RESOLVER_RE = /\bresolveLbLinkage\s*\(|\blinkageFromParentJob\s*\(/;
const LOOKBACK_LINES = 50;

function findInsertSites(file) {
  const src = fs.readFileSync(file, 'utf8');
  const lines = src.split(/\r?\n/);
  const violations = [];
  for (let i = 0; i < lines.length; i++) {
    if (!INSERT_RE.test(lines[i])) continue;
    INSERT_RE.lastIndex = 0;
    const lookback = lines.slice(Math.max(0, i - LOOKBACK_LINES), i + 1).join('\n');
    if (!RESOLVER_RE.test(lookback)) {
      violations.push({ line: i + 1, snippet: lines[i].trim().slice(0, 140) });
    }
  }
  return violations;
}

describe('LB linkage writer-funnel — system invariant', () => {
  const files = walk(ROOT);
  const offenders = [];

  for (const f of files) {
    const rel = path.relative(ROOT, f).replace(/\\/g, '/');
    if (ALLOWED_INSERT_SITES.has(rel)) continue;
    const violations = findInsertSites(f);
    if (violations.length > 0) {
      offenders.push({ file: rel, violations });
    }
  }

  test('every jobs.insert call is preceded by a resolveLbLinkage / linkageFromParentJob call within 50 lines', () => {
    if (offenders.length > 0) {
      const msg = offenders.map((o) =>
        `\n  ${o.file}:\n    ` + o.violations.map((v) => `line ${v.line}: ${v.snippet}`).join('\n    ')
      ).join('');
      throw new Error(`LB linkage invariant violated — jobs.insert without resolver call:\n${msg}\n\nAdd a resolveLbLinkage(...) call before the INSERT, OR add the file to ALLOWED_INSERT_SITES in this test with justification.`);
    }
    expect(offenders).toHaveLength(0);
  });
});
