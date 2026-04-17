#!/usr/bin/env node
/**
 * CI guard — MERGE-BLOCKING check for direct `jobs.status` writes.
 *
 * Plan: JOB_STATUS_SYNC_TO_LB.md §4
 *
 * This script fails the build when any file outside
 *   services/job-status-service.js
 * contains a direct Supabase mutation of jobs.status:
 *   supabase.from('jobs').update({ status: ... })
 * or the raw-SQL equivalent:
 *   UPDATE jobs SET status
 *
 * Why this matters: the centralized write path is what (a) stamps
 * `last_status_source` for loop prevention, (b) inserts the outbox
 * row that LB uses to learn about the change. A bypass silently
 * loses events — there's no way to audit something that was never
 * recorded. Catching it at PR time is the only reliable defense.
 *
 * EXEMPTION: a line may opt out with the literal marker
 *   // lb-status-guard: allow <reason>
 * on the SAME line or the LINE ABOVE the offending code. The reason
 * is mandatory and must be explicit in the PR review.
 *
 * Run: `node scripts/check-job-status-writes.js`
 * Hook into CI via package.json:
 *   "guard:status": "node scripts/check-job-status-writes.js"
 */

'use strict'

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const ALLOW_FILE = path.relative(ROOT, path.join('services', 'job-status-service.js')).replace(/\\/g, '/')
const ALLOW_MARK = /\/\/\s*lb-status-guard:\s*allow\s+.+/

// Patterns we block. Both are conservative — tuned to catch the two
// real Supabase-client + raw-SQL shapes that appear in the repo.
// Multiline:
//   .update({  \n    status: ...
// Multiline objects are detected via a flat regex on joined lines.
const PATTERNS = [
  // supabase.from('jobs').update({ ..., status: ... })
  { name: 'supabase-update', re: /from\s*\(\s*['"`]jobs['"`]\s*\)\s*\.update\s*\(\s*\{[^}]*\bstatus\b\s*:/s },
  // UPDATE jobs SET status = ...  (case-insensitive)
  { name: 'raw-sql', re: /UPDATE\s+jobs\s+SET\s+[^;]*\bstatus\b\s*=/i },
]

// Skip build/vendor/lock folders + the approved service + this script.
const SKIP_DIRS = new Set(['node_modules', 'uploads', 'tests', '__tests__', '.git', 'dist', 'build'])
const SKIP_FILES = new Set([
  ALLOW_FILE,
  path.relative(ROOT, __filename).replace(/\\/g, '/'),
])
// Read-only SQL migrations + test fixtures are allowed — they don't
// run in app code paths. Anything *.sql or *.test.js is skipped.
const SKIP_EXT = new Set(['.md', '.sql', '.json', '.lock', '.log'])

function walk(dir, out = []) {
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      walk(full, out)
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name)
      if (SKIP_EXT.has(ext)) continue
      if (!['.js', '.ts', '.mjs', '.cjs'].includes(ext)) continue
      if (entry.name.endsWith('.test.js') || entry.name.endsWith('.spec.js')) continue
      out.push(full)
    }
  }
  return out
}

function check(file) {
  const rel = path.relative(ROOT, file).replace(/\\/g, '/')
  if (SKIP_FILES.has(rel)) return []

  const source = fs.readFileSync(file, 'utf8')
  const lines = source.split(/\r?\n/)
  const violations = []

  // Simple line-by-line scan with a small look-back window so we can
  // catch the exempt marker. For multi-line .update({...status:...})
  // we join the next 6 lines so the regex sees the object body.
  const WINDOW = 6
  for (let i = 0; i < lines.length; i++) {
    const joined = lines.slice(i, i + WINDOW).join('\n')
    for (const { name, re } of PATTERNS) {
      if (!re.test(joined)) continue
      // Check for exemption on this line or the one above.
      const here = lines[i] || ''
      const prev = lines[i - 1] || ''
      if (ALLOW_MARK.test(here) || ALLOW_MARK.test(prev)) break
      violations.push({ file: rel, line: i + 1, pattern: name, snippet: here.trim().slice(0, 140) })
      break // one violation per hit — no double-count
    }
  }
  return violations
}

function main() {
  const files = walk(ROOT)
  const all = []
  for (const f of files) {
    try {
      for (const v of check(f)) all.push(v)
    } catch (e) {
      console.warn(`[status-guard] Skipped ${f}: ${e.message}`)
    }
  }

  if (all.length === 0) {
    console.log(`[status-guard] OK — no direct jobs.status writes detected outside ${ALLOW_FILE}.`)
    process.exit(0)
  }

  console.error('[status-guard] FAIL — direct jobs.status writes found.')
  console.error('Route every write through updateJobStatus in services/job-status-service.js,')
  console.error('or add an inline exemption: // lb-status-guard: allow <reason>')
  console.error('')
  for (const v of all) {
    console.error(`  ${v.file}:${v.line}  [${v.pattern}]  ${v.snippet}`)
  }
  process.exit(1)
}

if (require.main === module) main()

module.exports = { check, walk, PATTERNS }
