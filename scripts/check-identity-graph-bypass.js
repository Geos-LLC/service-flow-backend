#!/usr/bin/env node
'use strict';

/**
 * Identity Graph Bypass Scanner — architectural-hardening CI gate.
 *
 * Stage 1 (current default): dry-run. Reports violations but exits 0.
 * Stage 2 (when promoted via --strict): fails CI on any unexpected match.
 *
 * Scans the codebase for direct writes to graph-owned columns and asserts
 * each occurrence is either:
 *   1. Inside an authorised writer file (allowlist by file path).
 *   2. Adjacent to a `recordTransitionalBypass(...)` or `emitViolation(...)`
 *      call within a small line window.
 *
 * If a match is neither allowlisted nor instrumented, it's a NEW unauthorised
 * direct write — the kind of code that has historically caused identity
 * graph drift.
 *
 * Usage:
 *   node scripts/check-identity-graph-bypass.js              # dry-run (Stage 1)
 *   node scripts/check-identity-graph-bypass.js --strict     # CI gate (Stage 2)
 *   node scripts/check-identity-graph-bypass.js --json       # machine-readable output
 *
 * Exit codes:
 *   0 — no violations OR dry-run mode regardless of findings
 *   1 — violations found AND --strict was passed
 *
 * See:
 *   docs/architecture/identity-enforcement-roadmap.md (Stage 1 → 2 transition)
 *   docs/architecture/integration-compliance-audit.md (the allowlist + known bypasses)
 *   docs/architecture/new-integration-requirements.md (what NEW integrations must do)
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// ── Patterns we treat as graph-owned write targets ────────────────────
//
// Each pattern maps a column-write to the table that owns it. The scanner
// only flags a match if it's inside an .update({...}) or .insert({...})
// call on the matching table — this filters false positives from outbound
// queue rows, response payloads, and aggregation accumulators that happen
// to use the same field names.

const PATTERNS = [
  { name: 'leads.converted_customer_id',                            table: 'leads',                                  re: /converted_customer_id\s*:/ },
  { name: 'leads.parent_lead_id',                                   table: 'leads',                                  re: /parent_lead_id\s*:/ },
  { name: 'leads.lead_origin_type',                                 table: 'leads',                                  re: /lead_origin_type\s*:/ },
  { name: 'communication_participant_identities.sf_lead_id',        table: 'communication_participant_identities',  re: /sf_lead_id\s*:\s*[^,}\s]+/ },
  { name: 'communication_participant_identities.sf_customer_id',    table: 'communication_participant_identities',  re: /sf_customer_id\s*:\s*[^,}\s]+/ },
  { name: 'communication_participant_identities.last_hydrated_by',  table: 'communication_participant_identities',  re: /last_hydrated_by\s*:/ },
];

// Maximum lines to scan backward to find the enclosing supabase.from('TABLE')
// call. Most identity / lead writes are 2–10 lines long; 20 is safe.
const FROM_LOOKBACK = 20;

/**
 * Walk backward from `matchIdx` to find the most recent supabase.from('<table>')
 * call. Returns the table name, or null if none found within FROM_LOOKBACK.
 *
 * This is the key false-positive filter: a field named `sf_customer_id` in a
 * `zb_outbound_commands` row builder is NOT a graph-table write, even though
 * the column name matches.
 */
function findEnclosingTable(lines, matchIdx) {
  const start = Math.max(0, matchIdx - FROM_LOOKBACK);
  for (let i = matchIdx; i >= start; i--) {
    const m = lines[i].match(/\.from\(\s*['"]([\w_]+)['"]\s*\)/);
    if (m) return m[1];
  }
  return null;
}

/**
 * Detect whether the match line is inside an .update({...}) or .insert({...})
 * call (the actual write operations). Helper to distinguish a column write
 * from a column read or a field name appearing in a different shape.
 *
 * Looks backward up to FROM_LOOKBACK lines for `.update(` or `.insert(`.
 */
function isInsideWriteCall(lines, matchIdx) {
  const start = Math.max(0, matchIdx - FROM_LOOKBACK);
  for (let i = matchIdx; i >= start; i--) {
    // If we encounter a response/return boundary BEFORE finding .update(),
    // the match is in a non-write context (response payload, return value).
    // Boundary patterns:
    //   res.json( / res.send( — Express response builder
    //   return                 — function return value
    //   } before the match     — closes an earlier object expression
    if (i < matchIdx) {
      if (/\bres\.(json|send|status)\s*\(/.test(lines[i])) return false;
      if (/^\s*return\b/.test(lines[i])) return false;
    }
    if (/\.(update|insert|upsert)\s*\(/.test(lines[i])) return true;
    // Stop scanning if we hit a function boundary or .select( call (those mean
    // we walked past the write context).
    if (/^\s*(async\s+)?function\s/.test(lines[i])) return false;
    if (/\.select\s*\(/.test(lines[i])) return false;
  }
  return false;
}

// ── Files we scan ─────────────────────────────────────────────────────

const SCAN_DIRS = ['lib', 'scripts', '.'];
const SCAN_EXT = '.js';

// ── Allowlist: authorised writer files ────────────────────────────────
//
// Direct writes inside these files are EXPECTED (they ARE the authorised
// writers). The scanner skips matches inside them.

const AUTHORIZED_WRITER_FILES = new Set([
  'lib/identity-linker.js',         // setIdentityCustomer / setIdentityLead / projectIdentityToCRM / applyLeadCustomerLink / attemptScoringFallback
  'lib/identity-resolver.js',        // resolveIdentity (writes identity row only — no CRM projection)
  'leadbridge-service.js',           // createLeadFromLB / createChildLeadFromLB / enrichLeadFromLB
  'lib/identity-reconciliation-engine.js',  // engine never writes — but may contain patterns in plan-decision strings
  'lib/identity-graph-violation.js', // the emitter itself + violation kind strings
]);

// ── Allowlist: file paths where direct writes are EXPECTED but flagged ─
//
// These are the documented transitional bypasses from
// integration-compliance-audit.md §2. They must be instrumented with
// recordTransitionalBypass / emitViolation (verified by adjacency check below).

const TRANSITIONAL_BYPASS_FILES = new Set([
  'server.js',                       // maybeCreateLeadFromOpenPhone + merge_duplicate_customers
  'lib/identity-backfill.js',        // historic backfill apply-mode
]);

// ── Allowlist: test + scripts that read patterns but don't write ──────

const TEST_FILES_PREFIX = ['tests/', 'test/'];
const NON_WRITING_SCRIPTS = new Set([
  // Phase 1 review-packet generator — reads + writes its own JSON output, doesn't write to graph tables.
  'scripts/phase1-review-packet.js',
  // Read-only audit
  'scripts/phase1-dryrun-repair.js',
]);

// ── Adjacency check ───────────────────────────────────────────────────
//
// A direct-write match is "instrumented" if there's a
// recordTransitionalBypass( or emitViolation( call within `ADJACENCY` lines
// of the match (looking backward from the match line).

const ADJACENCY = 12;

const INSTRUMENTATION_RES = [
  /recordTransitionalBypass\s*\(/,
  /emitViolation\s*\(/,
];

// ── Helpers ──────────────────────────────────────────────────────────

function relpath(abs) {
  return path.relative(ROOT, abs).replace(/\\/g, '/');
}

function walk(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch (_) { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '.git' || e.name === 'coverage') continue;
      walk(full, out);
    } else if (e.isFile() && full.endsWith(SCAN_EXT)) {
      out.push(full);
    }
  }
  return out;
}

function isInsideAuthorisedWriter(rel) {
  return AUTHORIZED_WRITER_FILES.has(rel);
}

function isInsideTransitionalBypass(rel) {
  return TRANSITIONAL_BYPASS_FILES.has(rel);
}

function isTestFile(rel) {
  return TEST_FILES_PREFIX.some(p => rel.startsWith(p));
}

function isNonWritingScript(rel) {
  return NON_WRITING_SCRIPTS.has(rel);
}

function hasInstrumentationNearby(lines, matchIdx) {
  const start = Math.max(0, matchIdx - ADJACENCY);
  for (let i = start; i <= matchIdx; i++) {
    if (INSTRUMENTATION_RES.some(re => re.test(lines[i]))) return true;
  }
  return false;
}

// ── Scan ──────────────────────────────────────────────────────────────

function scan() {
  const findings = [];
  const files = new Set();
  for (const d of SCAN_DIRS) {
    walk(path.join(ROOT, d), Array.from(files)).forEach(f => files.add(f));
  }

  for (const abs of files) {
    const rel = relpath(abs);

    if (isAuxFile(rel)) continue;
    if (isTestFile(rel)) continue;
    if (isNonWritingScript(rel)) continue;
    if (isInsideAuthorisedWriter(rel)) continue;

    let text;
    try { text = fs.readFileSync(abs, 'utf8'); }
    catch (_) { continue; }

    const lines = text.split(/\r?\n/);

    for (const { name, table, re } of PATTERNS) {
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // Skip comments + doc-block lines
        if (/^\s*(\/\/|\*|#)/.test(line)) continue;
        if (!re.test(line)) continue;

        // Context filter — only flag if this match is inside an
        // .update({...}) / .insert({...}) call on the matching table.
        // Filters false positives from outbound queue rows, response
        // payload builders, aggregation accumulators, etc.
        const enclosingTable = findEnclosingTable(lines, i);
        if (enclosingTable !== table) continue;            // wrong table → ignore
        if (!isInsideWriteCall(lines, i)) continue;        // read, not write → ignore

        const instrumented = hasInstrumentationNearby(lines, i);
        const transitional = isInsideTransitionalBypass(rel);

        if (transitional && instrumented) continue;       // documented + instrumented → OK
        if (transitional && !instrumented) {
          findings.push({
            severity: 'error',
            file: rel,
            line: i + 1,
            pattern: name,
            code: line.trim().slice(0, 100),
            reason: 'transitional bypass site without recordTransitionalBypass/emitViolation adjacent',
          });
          continue;
        }
        // Not transitional, not authorised — a genuine new bypass.
        findings.push({
          severity: 'error',
          file: rel,
          line: i + 1,
          pattern: name,
          code: line.trim().slice(0, 100),
          reason: 'direct write to graph-owned surface outside authorised writers',
        });
      }
    }
  }

  return findings;
}

function isAuxFile(rel) {
  // skip migrations + json files + dist + coverage
  if (rel.startsWith('migrations/')) return true;
  if (rel.startsWith('node_modules/')) return true;
  if (rel.startsWith('coverage/')) return true;
  if (rel.startsWith('dist/')) return true;
  if (rel.startsWith('docs/')) return true;
  return false;
}

// ── Output ────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  const strict = args.includes('--strict');
  const json = args.includes('--json');

  const findings = scan();

  if (json) {
    process.stdout.write(JSON.stringify({
      strict,
      findings,
      summary: {
        total: findings.length,
        by_pattern: findings.reduce((m, f) => ((m[f.pattern] = (m[f.pattern] || 0) + 1), m), {}),
        by_file: findings.reduce((m, f) => ((m[f.file] = (m[f.file] || 0) + 1), m), {}),
      },
    }, null, 2));
    process.stdout.write('\n');
  } else {
    if (findings.length === 0) {
      console.log('[identity-graph-bypass] No direct writes to graph-owned surfaces outside authorised writers.');
    } else {
      console.log(`[identity-graph-bypass] ${findings.length} potential violation(s):`);
      for (const f of findings) {
        console.log(`  ${f.file}:${f.line}  pattern=${f.pattern}`);
        console.log(`    ${f.code}`);
        console.log(`    reason: ${f.reason}`);
      }
      console.log('');
      console.log('Remediation:');
      console.log('  - If the write should go through an authorised writer:');
      console.log('      use setIdentityCustomer/setIdentityLead/projectIdentityToCRM/applyLeadCustomerLink');
      console.log('  - If the write is a known transitional bypass:');
      console.log('      add recordTransitionalBypass({kind,target,source,reason}) within',
        ADJACENCY, 'lines before the write,');
      console.log('      AND document it in docs/architecture/integration-compliance-audit.md §2.');
      console.log('  - If you are adding a new integration:');
      console.log('      see docs/architecture/new-integration-requirements.md');
    }
  }

  if (strict && findings.length > 0) process.exit(1);
  process.exit(0);
}

main();
