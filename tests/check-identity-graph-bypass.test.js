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
  REQUIRED_METADATA_TAGS,
  METADATA_LOOKBACK,
  METADATA_SCAN_EXCLUSIONS,
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

  test('stops walking at first non-comment, non-blank line', () => {
    // The @owner is "blocked" by the const line — the walker stops above the call.
    const lines = [
      '  // @owner:            identity-v5',
      '  const x = 1;',
      '  recordTransitionalBypass(logger, { kind, tenant });',
    ];
    const meta = extractMetadataNearby(lines, 2);
    expect(meta.found).toEqual([]);
    expect(meta.missing).toContain('@owner');
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
  test('returns no findings when all metadata present', () => {
    const lines = [
      '/**',
      ' * @transitional',
      ' * @owner: identity-v5',
      ' * @retirement-stage: stage-2',
      ' * @observability: loki',
      ' */',
      'recordTransitionalBypass(logger, { kind, tenant });',
    ];
    const findings = scanTransitionalMetadata('lib/some-file.js', lines);
    expect(findings).toEqual([]);
  });

  test('returns one warning per call site with missing metadata', () => {
    const lines = [
      'recordTransitionalBypass(logger, { kind, tenant });',
      '',
      '// @transitional only',
      'recordTransitionalBypass(logger, { kind, tenant });',
    ];
    const findings = scanTransitionalMetadata('lib/some-file.js', lines);
    expect(findings.length).toBe(2);
    expect(findings[0].severity).toBe('warning');
    expect(findings[0].kind).toBe('metadata');
    expect(findings[0].file).toBe('lib/some-file.js');
    expect(findings[0].line).toBe(1);
  });

  test('warning describes which tags are missing', () => {
    const lines = [
      '// @transitional',
      '// @owner: identity-v5',
      'recordTransitionalBypass(logger, { kind, tenant });',
    ];
    const findings = scanTransitionalMetadata('lib/foo.js', lines);
    expect(findings.length).toBe(1);
    expect(findings[0].missing.sort()).toEqual(['@observability', '@retirement-stage'].sort());
    expect(findings[0].found.sort()).toEqual(['@owner', '@transitional'].sort());
    expect(findings[0].reason).toMatch(/missing required metadata tags/);
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

  test('NOT a false positive: well-formed bypass produces zero findings', () => {
    const lines = [
      'function doIt() {',
      '  /**',
      '   * @transitional — old direct write, being phased out',
      '   * @owner:            identity-v5',
      '   * @retirement-stage: stage-3-runtime-block',
      '   * @observability:    Loki kind=transitional_bypass',
      '   */',
      '  recordTransitionalBypass(logger, { kind, tenant, source });',
      '}',
    ];
    const findings = scanTransitionalMetadata('server.js', lines);
    expect(findings).toEqual([]);
  });

  test('detects multiple call sites in one file independently', () => {
    const lines = [
      '// @transitional',
      '// @owner: x',
      '// @retirement-stage: y',
      '// @observability: z',
      'recordTransitionalBypass(logger, { kind: "a" });',                 // 4 — complete
      '',
      'function other() {',
      '  recordTransitionalBypass(logger, { kind: "b" });',               // 7 — bare
      '}',
    ];
    const findings = scanTransitionalMetadata('server.js', lines);
    expect(findings.length).toBe(1);
    expect(findings[0].line).toBe(8);
    expect(findings[0].missing.sort()).toEqual([...REQUIRED_METADATA_TAGS].sort());
  });
});

// ── Integration smoke test against actual repo ───────────────────────

describe('scanner against live repo', () => {
  test('current repo has zero metadata warnings (all 7 instrumented sites are well-documented)', () => {
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
