'use strict';

/**
 * Tests for the identity-graph bypass scanner — specifically the
 * Part 6 transitional-metadata enforcement layer:
 *
 *   - extractMetadataNearby:    pure helper that walks backward from a call site
 *                                and collects @transitional / @owner / @retirement-stage
 *                                / @observability tags.
 *   - scanTransitionalMetadata: returns warning findings when a
 *                                recordTransitionalBypass(...) call is missing
 *                                one or more required metadata tags.
 *
 * The scanner runs warn-only — these tests verify the detection layer; CI
 * gating semantics are tested implicitly (warnings never fail CI, only
 * errors do).
 */

const {
  extractMetadataNearby,
  scanTransitionalMetadata,
  hasRuntimeGateNearby,
  REQUIRED_METADATA_TAGS,
  OPTIONAL_METADATA_TAGS,
  METADATA_LOOKBACK,
  METADATA_SCAN_EXCLUSIONS,
  GATE_LOOKBACK,
} = require('../scripts/check-identity-graph-bypass');

// ── extractMetadataNearby ────────────────────────────────────────────

describe('extractMetadataNearby', () => {
  test('finds all 4 required tags in a full block-comment header', () => {
    const lines = [
      '  /**',
      '   * @transitional',
      '   * @owner:            identity-v5',
      '   * @retirement-stage: stage-2-ci-static',
      '   * @observability:    Loki kind=transitional_bypass',
      '   */',
      '  recordTransitionalBypass(logger, { kind, tenant });',
    ];
    const meta = extractMetadataNearby(lines, 6);
    expect(meta.missing).toEqual([]);
    expect(meta.found.sort()).toEqual([...REQUIRED_METADATA_TAGS].sort());
    expect(meta.detail['@owner']).toBe('identity-v5');
    expect(meta.detail['@retirement-stage']).toBe('stage-2-ci-static');
    expect(meta.detail['@observability']).toMatch(/Loki/);
    expect(meta.detail['@transitional']).toBe(true);
  });

  test('reports missing tags when only @transitional present', () => {
    const lines = [
      '  // @transitional — TODO: add metadata',
      '  recordTransitionalBypass(logger, { kind, tenant });',
    ];
    const meta = extractMetadataNearby(lines, 1);
    expect(meta.found).toEqual(['@transitional']);
    expect(meta.missing.sort()).toEqual(['@observability', '@owner', '@retirement-stage'].sort());
  });

  test('reports all tags missing when no comments above', () => {
    const lines = [
      '  const x = 1;',
      '  recordTransitionalBypass(logger, { kind, tenant });',
    ];
    const meta = extractMetadataNearby(lines, 1);
    expect(meta.found).toEqual([]);
    expect(meta.missing.sort()).toEqual([...REQUIRED_METADATA_TAGS].sort());
  });

  test('walks through code lines (Stage 3 foundation: gate call sits between comment and bypass)', () => {
    // After Stage 3 instrumentation we expect a structure like:
    //
    //   /** @owner: identity-v5 ... */
    //   identityWriteGate.evaluateIdentityWrite({ ... });   ← intervening code
    //   recordTransitionalBypass(logger, { ... });
    //
    // The walker must SEE the comment block above the gate call, not stop at it.
    const lines = [
      '/**',
      ' * @transitional',
      ' * @owner:            identity-v5',
      ' * @retirement-stage: stage-2-ci-static',
      ' * @observability:    Loki kind=transitional_bypass',
      ' */',
      'identityWriteGate.evaluateIdentityWrite({',
      '  tenantId: userId, source: "x:y", target: "leads.x",',
      '  operation: "update", bypassStage: "stage-2-ci-static",',
      '  owner: "identity-v5", logger,',
      '});',
      'recordTransitionalBypass(logger, { kind, tenant });',
    ];
    const meta = extractMetadataNearby(lines, lines.length - 1);
    // All four required tags are found despite the gate call in between.
    expect(meta.missing).toEqual([]);
    expect(meta.found.sort()).toEqual([...REQUIRED_METADATA_TAGS].sort());
  });

  test('tags in code (non-comment) lines are NOT counted', () => {
    // Defensive: even if the literal `@owner:` appears inside a string in
    // a code line, the walker must ignore it because tags only match on
    // comment-shaped lines.
    const lines = [
      'const fake = "@owner: should-not-match";',
      'const real = "@transitional in a string";',
      'recordTransitionalBypass(logger, { kind, tenant });',
    ];
    const meta = extractMetadataNearby(lines, 2);
    expect(meta.found).toEqual([]);
    expect(meta.missing.sort()).toEqual([...REQUIRED_METADATA_TAGS].sort());
  });

  test('walks through blank lines without stopping', () => {
    const lines = [
      '  // @transitional',
      '  // @owner:            identity-v5',
      '',
      '  // @retirement-stage: stage-3-runtime-block',
      '  // @observability:    grafana',
      '  recordTransitionalBypass(logger, { kind, tenant });',
    ];
    const meta = extractMetadataNearby(lines, 5);
    expect(meta.missing).toEqual([]);
  });

  test('respects METADATA_LOOKBACK — tags far above are not counted', () => {
    const lines = [];
    // Put metadata > METADATA_LOOKBACK lines above; pad with blanks/comments.
    lines.push('// @transitional');
    lines.push('// @owner:            x');
    lines.push('// @retirement-stage: y');
    lines.push('// @observability:    z');
    for (let i = 0; i < METADATA_LOOKBACK + 5; i++) lines.push('  // unrelated');
    lines.push('  recordTransitionalBypass(logger, { kind, tenant });');
    const meta = extractMetadataNearby(lines, lines.length - 1);
    // Walker should not reach the tags — all should be missing.
    expect(meta.missing.sort()).toEqual([...REQUIRED_METADATA_TAGS].sort());
  });

  test('captures inline detail for tags with values', () => {
    const lines = [
      '/**',
      ' * @transitional',
      ' * @owner: identity-v5',
      ' * @retirement-stage: stage-4-adapter-only',
      ' * @observability: Loki query',
      ' */',
      'recordTransitionalBypass(logger, { kind, tenant });',
    ];
    const meta = extractMetadataNearby(lines, 6);
    expect(meta.detail['@owner']).toBe('identity-v5');
    expect(meta.detail['@retirement-stage']).toBe('stage-4-adapter-only');
  });

  test('handles edge case: callIdx = 0', () => {
    const lines = ['recordTransitionalBypass(logger, { kind, tenant });'];
    const meta = extractMetadataNearby(lines, 0);
    expect(meta.missing.sort()).toEqual([...REQUIRED_METADATA_TAGS].sort());
  });
});

// ── scanTransitionalMetadata ─────────────────────────────────────────

describe('scanTransitionalMetadata', () => {
  test('returns no METADATA findings when all required tags present (gate-missing warning still expected without an adjacent gate call)', () => {
    const lines = [
      '/**',
      ' * @transitional',
      ' * @owner: identity-v5',
      ' * @retirement-stage: stage-2',
      ' * @observability: loki',
      ' * @violation-class: RV-2',
      ' */',
      'identityWriteGate.evaluateIdentityWrite({ source: "x" });',
      'recordTransitionalBypass(logger, { kind, tenant });',
    ];
    const findings = scanTransitionalMetadata('lib/some-file.js', lines);
    expect(findings).toEqual([]);
  });

  test('emits one METADATA warning per call site with missing metadata (kind-scoped)', () => {
    const lines = [
      'recordTransitionalBypass(logger, { kind, tenant });',
      '',
      '// @transitional only',
      'recordTransitionalBypass(logger, { kind, tenant });',
    ];
    const metadataFindings = scanTransitionalMetadata('lib/some-file.js', lines)
      .filter(f => f.kind === 'metadata');
    expect(metadataFindings.length).toBe(2);
    expect(metadataFindings[0].severity).toBe('warning');
    expect(metadataFindings[0].kind).toBe('metadata');
    expect(metadataFindings[0].file).toBe('lib/some-file.js');
    expect(metadataFindings[0].line).toBe(1);
  });

  test('warning describes which tags are missing', () => {
    const lines = [
      '// @transitional',
      '// @owner: identity-v5',
      'recordTransitionalBypass(logger, { kind, tenant });',
    ];
    const metadataFindings = scanTransitionalMetadata('lib/foo.js', lines)
      .filter(f => f.kind === 'metadata');
    expect(metadataFindings.length).toBe(1);
    expect(metadataFindings[0].missing.sort()).toEqual(['@observability', '@retirement-stage'].sort());
    expect(metadataFindings[0].found.sort()).toEqual(['@owner', '@transitional'].sort());
    expect(metadataFindings[0].reason).toMatch(/missing required metadata tags/);
  });

  test('skips excluded files (scanner itself + helper)', () => {
    const lines = [
      '// helper file with references to the name in strings',
      'recordTransitionalBypass(logger, { kind, tenant });',
    ];
    for (const exclusion of METADATA_SCAN_EXCLUSIONS) {
      expect(scanTransitionalMetadata(exclusion, lines)).toEqual([]);
    }
  });

  test('skips lines where the name appears inside a string literal', () => {
    const lines = [
      "expect(line).toMatch(/recordTransitionalBypass\\(/);",
      "console.log('recordTransitionalBypass(logger, ...)');",
    ];
    const findings = scanTransitionalMetadata('lib/foo.js', lines);
    expect(findings).toEqual([]);
  });

  test('skips lines that are comments (docstrings mentioning the name)', () => {
    const lines = [
      '// recordTransitionalBypass(logger, ...) — see the docs',
      ' * recordTransitionalBypass(logger, ...) example',
    ];
    const findings = scanTransitionalMetadata('lib/foo.js', lines);
    expect(findings).toEqual([]);
  });

  test('NOT a false positive: well-formed bypass with gate + taxonomy produces zero findings', () => {
    const lines = [
      'function doIt() {',
      '  /**',
      '   * @transitional — old direct write, being phased out',
      '   * @owner:            identity-v5',
      '   * @retirement-stage: stage-3-runtime-block',
      '   * @observability:    Loki kind=transitional_bypass',
      '   * @violation-class:  RV-2',
      '   */',
      '  identityWriteGate.evaluateIdentityWrite({ source: "x" });',
      '  recordTransitionalBypass(logger, { kind, tenant, source });',
      '}',
    ];
    const findings = scanTransitionalMetadata('server.js', lines);
    expect(findings).toEqual([]);
  });

  test('detects multiple call sites in one file independently (kind-scoped to metadata)', () => {
    // Sites must be > METADATA_LOOKBACK lines apart so the bare site's
    // lookback does not reach the complete site's tags. The walker now
    // walks through code lines (only matches on comment lines), bounded
    // by METADATA_LOOKBACK — see extractMetadataNearby docstring.
    const lines = [
      '// @transitional',
      '// @owner: x',
      '// @retirement-stage: y',
      '// @observability: z',
      '// @violation-class: RV-2',
      'identityWriteGate.evaluateIdentityWrite({ source: "a" });',
      'recordTransitionalBypass(logger, { kind: "a" });',                  // line 7 — complete site
    ];
    // Padding to push the bare site beyond METADATA_LOOKBACK from any tag above.
    for (let i = 0; i < METADATA_LOOKBACK + 5; i++) lines.push('');
    lines.push('function other() {');
    lines.push('  recordTransitionalBypass(logger, { kind: "b" });');     // bare site
    lines.push('}');
    const metadataFindings = scanTransitionalMetadata('server.js', lines)
      .filter(f => f.kind === 'metadata');
    expect(metadataFindings.length).toBe(1);
    expect(metadataFindings[0].missing.sort()).toEqual([...REQUIRED_METADATA_TAGS].sort());
  });
});

// ── hasRuntimeGateNearby (Stage 3 foundation) ────────────────────────

describe('hasRuntimeGateNearby', () => {
  test('returns true when gate call sits directly above bypass', () => {
    const lines = [
      'identityWriteGate.evaluateIdentityWrite({ source: "x" });',
      'recordTransitionalBypass(logger, { kind });',
    ];
    expect(hasRuntimeGateNearby(lines, 1)).toBe(true);
  });

  test('returns true when gate call sits within GATE_LOOKBACK lines above', () => {
    const lines = ['identityWriteGate.evaluateIdentityWrite({ source: "x" });'];
    // Pad with blank lines so the gate is GATE_LOOKBACK - 1 lines away.
    for (let i = 0; i < GATE_LOOKBACK - 1; i++) lines.push('');
    lines.push('recordTransitionalBypass(logger, { kind });');
    expect(hasRuntimeGateNearby(lines, lines.length - 1)).toBe(true);
  });

  test('returns false when no gate call within window', () => {
    const lines = [
      'const x = 1;',
      'recordTransitionalBypass(logger, { kind });',
    ];
    expect(hasRuntimeGateNearby(lines, 1)).toBe(false);
  });

  test('returns false when gate is too far above (beyond GATE_LOOKBACK)', () => {
    const lines = ['identityWriteGate.evaluateIdentityWrite({ source: "x" });'];
    for (let i = 0; i < GATE_LOOKBACK + 5; i++) lines.push('');
    lines.push('recordTransitionalBypass(logger, { kind });');
    expect(hasRuntimeGateNearby(lines, lines.length - 1)).toBe(false);
  });

  test('ignores gate-name mentions inside string literals', () => {
    const lines = [
      'logger.log("identityWriteGate.evaluateIdentityWrite was not called");',
      'recordTransitionalBypass(logger, { kind });',
    ];
    expect(hasRuntimeGateNearby(lines, 1)).toBe(false);
  });

  test('ignores gate-name mentions inside comments', () => {
    const lines = [
      '// We do not call identityWriteGate.evaluateIdentityWrite here',
      'recordTransitionalBypass(logger, { kind });',
    ];
    expect(hasRuntimeGateNearby(lines, 1)).toBe(false);
  });
});

// ── New warning kinds (Stage 3 foundation) ───────────────────────────

describe('scanTransitionalMetadata — runtime gate + taxonomy warnings', () => {
  test('emits runtime_gate_missing when bypass has no adjacent gate call', () => {
    const lines = [
      '/**',
      ' * @transitional',
      ' * @owner: identity-v5',
      ' * @retirement-stage: stage-2-ci-static',
      ' * @observability: loki',
      ' * @violation-class: RV-2',
      ' */',
      'recordTransitionalBypass(logger, { kind });',
    ];
    const findings = scanTransitionalMetadata('lib/some-file.js', lines);
    const gate = findings.find(f => f.kind === 'runtime_gate_missing');
    expect(gate).toBeDefined();
    expect(gate.severity).toBe('warning');
    expect(gate.file).toBe('lib/some-file.js');
  });

  test('does NOT emit runtime_gate_missing when gate call is adjacent', () => {
    const lines = [
      '/**',
      ' * @transitional',
      ' * @owner: identity-v5',
      ' * @retirement-stage: stage-2-ci-static',
      ' * @observability: loki',
      ' * @violation-class: RV-2',
      ' */',
      'identityWriteGate.evaluateIdentityWrite({ source: "x" });',
      'recordTransitionalBypass(logger, { kind });',
    ];
    const findings = scanTransitionalMetadata('lib/some-file.js', lines);
    expect(findings.find(f => f.kind === 'runtime_gate_missing')).toBeUndefined();
  });

  test('emits taxonomy_classification_missing when @violation-class absent', () => {
    const lines = [
      '/**',
      ' * @transitional',
      ' * @owner: identity-v5',
      ' * @retirement-stage: stage-2-ci-static',
      ' * @observability: loki',
      ' */',
      'identityWriteGate.evaluateIdentityWrite({ source: "x" });',
      'recordTransitionalBypass(logger, { kind });',
    ];
    const findings = scanTransitionalMetadata('lib/some-file.js', lines);
    const taxonomy = findings.find(f => f.kind === 'taxonomy_classification_missing');
    expect(taxonomy).toBeDefined();
    expect(taxonomy.severity).toBe('warning');
  });

  test('does NOT emit taxonomy_classification_missing when @violation-class present', () => {
    const lines = [
      '/**',
      ' * @transitional',
      ' * @owner: identity-v5',
      ' * @retirement-stage: stage-2-ci-static',
      ' * @observability: loki',
      ' * @violation-class: RV-2',
      ' */',
      'identityWriteGate.evaluateIdentityWrite({ source: "x" });',
      'recordTransitionalBypass(logger, { kind });',
    ];
    const findings = scanTransitionalMetadata('lib/some-file.js', lines);
    expect(findings.find(f => f.kind === 'taxonomy_classification_missing')).toBeUndefined();
  });

  test('all new warnings are severity=warning (never error)', () => {
    // A bypass with no metadata at all generates: 1 metadata + 1 runtime_gate + 1 taxonomy.
    const lines = ['recordTransitionalBypass(logger, { kind });'];
    const findings = scanTransitionalMetadata('lib/some-file.js', lines);
    expect(findings.length).toBeGreaterThanOrEqual(3);
    for (const f of findings) expect(f.severity).toBe('warning');
  });

  test('OPTIONAL_METADATA_TAGS includes @violation-class', () => {
    expect(OPTIONAL_METADATA_TAGS).toContain('@violation-class');
  });

  test('@violation-class missing does NOT affect required-tag list', () => {
    // Even with @violation-class absent, REQUIRED tags can still be complete.
    const lines = [
      '/**',
      ' * @transitional',
      ' * @owner: identity-v5',
      ' * @retirement-stage: stage-2-ci-static',
      ' * @observability: loki',
      ' */',
      'recordTransitionalBypass(logger, { kind });',
    ];
    const meta = extractMetadataNearby(lines, lines.length - 1);
    expect(meta.missing).toEqual([]);                          // required complete
    expect(meta.missingOptional).toContain('@violation-class'); // optional missing
  });
});

// ── Integration smoke test against actual repo ───────────────────────

describe('scanner against live repo', () => {
  test('current repo has zero warnings (all 7 instrumented sites carry metadata + gate + taxonomy)', () => {
    const { execSync } = require('child_process');
    const path = require('path');
    const out = execSync(
      `node "${path.join(__dirname, '..', 'scripts', 'check-identity-graph-bypass.js')}" --json`,
      { cwd: path.join(__dirname, '..'), encoding: 'utf8' }
    );
    const parsed = JSON.parse(out);
    const warnings = parsed.findings.filter(f => f.severity === 'warning');
    const errors   = parsed.findings.filter(f => f.severity === 'error');
    expect(errors).toEqual([]);
    expect(warnings).toEqual([]);
  });
});
