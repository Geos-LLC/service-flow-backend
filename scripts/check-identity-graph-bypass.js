#!/usr/bin/env node
'use strict';

/**
 * Identity Graph Bypass Scanner — architectural-hardening CI gate.
 *
 * Stage 1 (current default): dry-run. Reports violations but exits 0.
 * Stage 2 (when promoted via --strict): fails CI on any unexpected match.
 *
 * Scans the codebase for:
 *
 *   (1) Direct writes to graph-owned columns. Each occurrence must be
 *       either inside an authorised writer file OR adjacent to a
 *       `recordTransitionalBypass`/`emitViolation` call.
 *
 *   (2) Transitional-bypass metadata completeness. Each
 *       `recordTransitionalBypass(...)` call must be preceded (within
 *       METADATA_LOOKBACK lines) by a structured comment carrying:
 *           @transitional
 *           @owner:             <team or person>
 *           @retirement-stage:  <enforcement-roadmap stage tag>
 *           @observability:     <how to monitor it in Loki/Grafana>
 *       Missing tags are flagged as warnings — Stage 1: warn only.
 *
 *   (3) Runtime gate adjacency. Each `recordTransitionalBypass(...)` site
 *       must be paired with an adjacent (within GATE_LOOKBACK lines)
 *       `identityWriteGate.evaluateIdentityWrite(...)` call. The gate is
 *       the Stage 3 foundation insertion point. Missing the call today
 *       is a warning, not an error — runtime behavior is unchanged.
 *
 *   (4) Taxonomy classification. Each bypass site SHOULD declare a
 *       runtime violation class via `@violation-class: RV-N` in the
 *       metadata block. See docs/architecture/runtime-violation-taxonomy.md
 *       for the closed set RV-1 through RV-7. Missing is a warning.
 *
 * If a match is neither allowlisted nor instrumented (case 1), or a
 * transitional bypass lacks required metadata (case 2), the scanner
 * reports it. CI failure only when `--strict` is passed.
 *
 * Usage:
 *   node scripts/check-identity-graph-bypass.js              # dry-run (Stage 1)
 *   node scripts/check-identity-graph-bypass.js --strict     # CI gate (Stage 2+)
 *   node scripts/check-identity-graph-bypass.js --json       # machine-readable output
 *
 * Exit codes:
 *   0 — no violations OR dry-run mode regardless of findings
 *   1 — violations found AND --strict was passed
 *
 * See:
 *   docs/architecture/identity-enforcement-roadmap.md (Stage 1 → 2 transition)
 *   docs/architecture/integration-compliance-audit.md (the allowlist + known bypasses)
 *   docs/architecture/transitional-infrastructure-registry.md (canonical list of transitional systems)
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

// ── Transitional-bypass metadata ──────────────────────────────────────
//
// Every `recordTransitionalBypass(...)` call MUST be preceded by a
// structured comment block containing these tags:
//
//   @transitional
//   @owner:            <team or person>
//   @retirement-stage: <stage tag from enforcement roadmap>
//   @observability:    <how this bypass is monitored>
//
// The metadata lives in JS line comments (// or /** */). The scanner walks
// backward up to METADATA_LOOKBACK lines from the
// `recordTransitionalBypass(` call site, collecting any @-tag lines.
//
// Missing or malformed metadata is reported as a warning. The point is
// that transitional code MUST self-identify its owner, retirement plan,
// and observability hook — otherwise it stagnates.

const METADATA_LOOKBACK = 25;
const REQUIRED_METADATA_TAGS = ['@transitional', '@owner', '@retirement-stage', '@observability'];

// Stage 3 foundation tags. Optional today — missing tags produce a warning
// but do not affect metadata_complete (the required-tag check is unchanged).
// See docs/architecture/runtime-violation-taxonomy.md for the RV-N values
// and docs/architecture/runtime-allowlist-design.md for the gate semantics.
const OPTIONAL_METADATA_TAGS = ['@violation-class'];

// Window (in lines) before a `recordTransitionalBypass(...)` call within
// which a paired `identityWriteGate.evaluateIdentityWrite(...)` call must
// appear. Same magnitude as METADATA_LOOKBACK so the comment block and the
// two calls all live within one "site" of source.
const GATE_LOOKBACK = 30;

function extractMetadataNearby(lines, callIdx) {
  // Walk backward up to METADATA_LOOKBACK lines from the bypass call.
  //
  // We do NOT stop at the first non-comment line anymore: the Stage 3
  // foundation puts an `identityWriteGate.evaluateIdentityWrite(...)`
  // call BETWEEN the comment block and the `recordTransitionalBypass(...)`
  // call (so the comment + gate + emit form one logical site). Stopping
  // at the gate call would erase the comment block.
  //
  // Safety: tags (`@transitional`, `@owner`, etc.) are only matched on
  // comment-shaped lines (`//`, `*`, `/*`) or the call line itself, so
  // unrelated code lines do NOT contribute false positives. The walker
  // is bounded by METADATA_LOOKBACK to prevent picking up tags from a
  // neighbouring site.
  const found = new Set();
  const detail = {};
  const allTags = [...REQUIRED_METADATA_TAGS, ...OPTIONAL_METADATA_TAGS];
  for (let i = callIdx; i >= Math.max(0, callIdx - METADATA_LOOKBACK); i--) {
    const line = lines[i] || '';
    const trimmed = line.trim();
    // Tags can ONLY appear on comment lines (or the call line itself).
    // Other lines (gate call args, blank lines, code) are walked through
    // but contribute no matches.
    const isCommentish = trimmed === '' || /^(\/\/|\*|\/\*)/.test(trimmed) || i === callIdx;
    if (!isCommentish) continue;
    for (const tag of allTags) {
      if (trimmed.includes(tag)) {
        found.add(tag);
        // Capture inline value, e.g. "@owner: identity-v5" → "identity-v5"
        const m = trimmed.match(new RegExp(tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*:\\s*([^*]+?)(?:\\s*\\*\\/|$)'));
        if (m && m[1]) detail[tag] = m[1].trim();
        else if (tag === '@transitional') detail[tag] = true;
      }
    }
  }
  const missing = REQUIRED_METADATA_TAGS.filter(t => !found.has(t));
  const missingOptional = OPTIONAL_METADATA_TAGS.filter(t => !found.has(t));
  return { found: Array.from(found), missing, missingOptional, detail };
}

/**
 * Scan backward from a `recordTransitionalBypass` call to see if a paired
 * `identityWriteGate.evaluateIdentityWrite` call exists within GATE_LOOKBACK
 * lines (typically immediately above, inside the same site).
 *
 * Stage 3 foundation: every transitional bypass should also run the runtime
 * gate so we have a future insertion point for hard refusal. Missing the
 * gate today is a warning, not an error.
 */
function hasRuntimeGateNearby(lines, callIdx) {
  const start = Math.max(0, callIdx - GATE_LOOKBACK);
  for (let i = callIdx - 1; i >= start; i--) {
    const line = lines[i] || '';
    if (/identityWriteGate\.evaluateIdentityWrite\s*\(/.test(line)) {
      // Skip mentions inside string literals or comment lines (same
      // protections we use for recordTransitionalBypass detection).
      if (/['"`].*identityWriteGate\.evaluateIdentityWrite.*['"`]/.test(line)) continue;
      if (/^\s*(\/\/|\*)/.test(line)) continue;
      return true;
    }
  }
  return false;
}

/**
 * Scan a file for `recordTransitionalBypass(` calls and verify metadata.
 * Returns an array of metadata findings (warning-level).
 */
// Files where `recordTransitionalBypass` legitimately appears in string
// literals, regex patterns, or helper documentation — NOT as an actual call
// site. Skipping these prevents false positives.
const METADATA_SCAN_EXCLUSIONS = new Set([
  'lib/identity-graph-violation.js',       // the helper definition itself
  'scripts/check-identity-graph-bypass.js',// this scanner — references the name in regex/docs
]);

function scanTransitionalMetadata(rel, lines) {
  if (METADATA_SCAN_EXCLUSIONS.has(rel)) return [];
  const findings = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Must be an actual invocation, not a string/regex/comment mention.
    if (!/recordTransitionalBypass\s*\(/.test(line)) continue;
    // Skip if appears inside a string literal (quoted name) — e.g. test
    // assertions like expect(...).toContain('recordTransitionalBypass').
    if (/['"`].*recordTransitionalBypass.*['"`]/.test(line)) continue;
    // Skip comment lines that document the name.
    if (/^\s*(\/\/|\*)/.test(line)) continue;
    const meta = extractMetadataNearby(lines, i);

    // Existing check — required metadata tags.
    if (meta.missing.length > 0) {
      findings.push({
        severity: 'warning',
        kind: 'metadata',
        file: rel,
        line: i + 1,
        missing: meta.missing,
        found: meta.found,
        reason: `transitional bypass missing required metadata tags: ${meta.missing.join(', ')}`,
      });
    }

    // Stage 3 foundation — runtime gate call must be adjacent.
    if (!hasRuntimeGateNearby(lines, i)) {
      findings.push({
        severity: 'warning',
        kind: 'runtime_gate_missing',
        file: rel,
        line: i + 1,
        reason: 'transitional bypass site missing adjacent identityWriteGate.evaluateIdentityWrite(...) call (Stage 3 foundation)',
      });
    }

    // Stage 3 foundation — taxonomy classification tag (@violation-class: RV-N).
    if (meta.missingOptional && meta.missingOptional.includes('@violation-class')) {
      findings.push({
        severity: 'warning',
        kind: 'taxonomy_classification_missing',
        file: rel,
        line: i + 1,
        reason: 'transitional bypass site missing @violation-class tag (RV-1 through RV-7 — see runtime-violation-taxonomy.md)',
      });
    }
  }
  return findings;
}

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

    let text;
    try { text = fs.readFileSync(abs, 'utf8'); }
    catch (_) { continue; }

    const lines = text.split(/\r?\n/);

    // Case 2 — transitional-bypass metadata completeness. Runs on every file
    // (including authorised writers, since recordTransitionalBypass can show
    // up anywhere a transitional bypass lives). Skipped only for the helper
    // itself (handled inside scanTransitionalMetadata).
    for (const f of scanTransitionalMetadata(rel, lines)) findings.push(f);

    // Case 1 — direct-write detection. Skipped inside authorised writers,
    // since those files own the writes by design.
    if (isInsideAuthorisedWriter(rel)) continue;

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
            kind: 'direct_write',
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
          kind: 'direct_write',
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
  const errors   = findings.filter(f => f.severity === 'error');
  const warnings = findings.filter(f => f.severity === 'warning');

  if (json) {
    process.stdout.write(JSON.stringify({
      strict,
      findings,
      summary: {
        total: findings.length,
        errors: errors.length,
        warnings: warnings.length,
        by_pattern: findings.reduce((m, f) => f.pattern ? ((m[f.pattern] = (m[f.pattern] || 0) + 1), m) : m, {}),
        by_kind: findings.reduce((m, f) => ((m[f.kind || 'unknown'] = (m[f.kind || 'unknown'] || 0) + 1), m), {}),
        by_file: findings.reduce((m, f) => ((m[f.file] = (m[f.file] || 0) + 1), m), {}),
      },
    }, null, 2));
    process.stdout.write('\n');
  } else {
    if (findings.length === 0) {
      console.log('[identity-graph-bypass] OK — no direct writes outside authorised writers and all transitional bypasses are well-documented.');
    } else {
      if (errors.length > 0) {
        console.log(`[identity-graph-bypass] ${errors.length} ERROR(s) — direct writes to graph-owned surfaces:`);
        for (const f of errors) {
          console.log(`  ${f.file}:${f.line}  pattern=${f.pattern}`);
          console.log(`    ${f.code}`);
          console.log(`    reason: ${f.reason}`);
        }
        console.log('');
        console.log('Remediation (errors):');
        console.log('  - If the write should go through an authorised writer:');
        console.log('      use setIdentityCustomer/setIdentityLead/projectIdentityToCRM/applyLeadCustomerLink');
        console.log('  - If the write is a known transitional bypass:');
        console.log('      add recordTransitionalBypass({kind,target,source,reason}) within',
          ADJACENCY, 'lines before the write,');
        console.log('      AND document it in docs/architecture/integration-compliance-audit.md §2.');
        console.log('  - If you are adding a new integration:');
        console.log('      see docs/architecture/new-integration-requirements.md');
        console.log('');
      }
      if (warnings.length > 0) {
        console.log(`[identity-graph-bypass] ${warnings.length} WARNING(s) — transitional bypasses missing governance / runtime instrumentation:`);
        for (const f of warnings) {
          if (f.kind === 'metadata') {
            console.log(`  ${f.file}:${f.line}  [metadata] missing=${(f.missing || []).join(',')}  found=${(f.found || []).join(',') || '(none)'}`);
          } else if (f.kind === 'runtime_gate_missing') {
            console.log(`  ${f.file}:${f.line}  [runtime_gate_missing]`);
          } else if (f.kind === 'taxonomy_classification_missing') {
            console.log(`  ${f.file}:${f.line}  [taxonomy_classification_missing]`);
          } else {
            console.log(`  ${f.file}:${f.line}  [${f.kind || 'warning'}]`);
          }
          console.log(`    reason: ${f.reason}`);
        }
        console.log('');
        console.log('Remediation (warnings): add a structured comment block immediately above');
        console.log('  the recordTransitionalBypass(...) call AND an adjacent gate call, e.g.:');
        console.log('');
        console.log('    /**');
        console.log('     * @transitional');
        console.log('     * @owner:            identity-v5');
        console.log('     * @retirement-stage: stage-2-ci-static');
        console.log('     * @observability:    Loki {service_name="service-flow-backend"} |~ "IdentityGraphViolation" | json | kind="transitional_bypass"');
        console.log('     * @violation-class:  RV-2');
        console.log('     */');
        console.log('    identityWriteGate.evaluateIdentityWrite({');
        console.log('      tenantId: userId, source: "file:function", target: "table.column",');
        console.log('      operation: "update", bypassStage: "stage-2-ci-static",');
        console.log('      owner: "identity-v5", violationClass: "RV-2", logger,');
        console.log('    });');
        console.log('    recordTransitionalBypass(logger, { kind: ..., tenant, target, source, reason });');
        console.log('');
        console.log('  See: docs/architecture/transitional-infrastructure-registry.md');
        console.log('       docs/architecture/runtime-violation-taxonomy.md');
      }
    }
  }

  // Warnings are advisory only — they never fail CI, even with --strict.
  // Only direct-write errors gate CI when --strict is passed.
  if (strict && errors.length > 0) process.exit(1);
  process.exit(0);
}

// Only auto-run as a script (skip when required from tests).
if (require.main === module) {
  main();
}

module.exports = {
  // Constants exposed for tests
  METADATA_LOOKBACK,
  REQUIRED_METADATA_TAGS,
  OPTIONAL_METADATA_TAGS,
  METADATA_SCAN_EXCLUSIONS,
  ADJACENCY,
  GATE_LOOKBACK,
  PATTERNS,
  AUTHORIZED_WRITER_FILES,
  TRANSITIONAL_BYPASS_FILES,
  // Pure helpers exposed for tests
  extractMetadataNearby,
  scanTransitionalMetadata,
  hasRuntimeGateNearby,
  findEnclosingTable,
  isInsideWriteCall,
};
