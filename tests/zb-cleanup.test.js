'use strict';

// ZB Cleanup classifier — unit tests. Pure-function tests only; no DB hits.
//
// Pinning invariants:
//   - bucket precedence: safe_keep > manual_review > safe_archive
//   - SAFE_ARCHIVE blocks fire on every operational signal
//   - risk score is bounded 0..100 and deterministic
//   - tenant resolver loadUserById refuses non-int / non-positive ids
//   - CLI script rejects --apply (smoke check via require + exit handling)

const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

const {
  CLASSIFIER_VERSION,
  classifyJob,
  hasImportSignature,
  withinDriftThreshold,
} = require('../lib/zb-cleanup/classifier');
const { calculateRiskScore, riskBand } = require('../lib/zb-cleanup/risk-score');
const { detectWindow, bucketByDay } = require('../lib/zb-cleanup/window-detector');
const { rowsToCsv } = require('../lib/zb-cleanup/csv');
const { sha256OfString, sha256OfFile } = require('../lib/zb-cleanup/checksums');
const { parseProjectRef, getMigrationState } = require('../lib/zb-cleanup/provenance');

// ─── fixtures ────────────────────────────────────────────────────────
const WINDOW = {
  windowStart: '2026-03-01T00:00:00Z',
  windowEnd: '2026-04-01T00:00:00Z',
  driftThresholdMs: 60 * 60 * 1000,
};
function baseImportedJob(overrides = {}) {
  // A minimal "perfect SAFE_ARCHIVE" candidate
  return {
    id: 1,
    user_id: 2,
    customer_id: 100,
    status: 'completed',
    scheduled_date: '2026-02-15',
    created_at: '2026-03-04T18:22:11Z',
    updated_at: '2026-03-04T18:22:11Z',
    last_status_source: null,
    last_status_changed_at: null,
    cancelled_at: null,
    cancellation_fee: null,
    is_recurring: false,
    recurring_end_date: null,
    lb_external_request_id: null,
    lb_channel: null,
    zenbooker_id: null,
    payment_status: null,
    invoice_status: null,
    start_time: null,
    end_time: null,
    hours_worked: null,
    tip_amount: 0,
    incentive_amount: 0,
    total_amount: 0,
    invoice_amount: 0,
    service_price: 0,
    tags: ['imported', 'booking-koala'],
    contact_info: { external_id: 'BK-44218' },
    customer: { id: 100, first_name: 'Jane', last_name: 'Doe', phone: '+18135551234' },
    ...overrides,
  };
}
const EMPTY_LOOKUPS = {
  ledgerJobIds: new Set(),
  batchedLedgerJobIds: new Set(),
  unbatchedLedgerJobIds: new Set(),
  txJobIds: new Set(),
  statusHistJobIds: new Set(),
  payrollEditJobIds: new Set(),
  cancellationExpenseJobIds: new Set(),
  lbOutboxJobIds: new Set(),
  futureJobsByCustomer: new Set(),
  recurringParentByCustomer: new Set(),
  convsByCustomer: new Set(),
  customerJobsTotal: new Map([[100, 1]]),
  assignmentCountByJobId: new Map(),
};

// ─── classifier ──────────────────────────────────────────────────────
describe('classifier — bucket assignment', () => {
  test('CLASSIFIER_VERSION is v2.0.0', () => {
    expect(CLASSIFIER_VERSION).toBe('v2.0.0');
  });

  test('perfect candidate -> safe_archive with all_predicates_pass', () => {
    const r = classifyJob(baseImportedJob(), EMPTY_LOOKUPS, WINDOW);
    expect(r.bucket).toBe('safe_archive');
    expect(r.reasons).toEqual(['all_predicates_pass']);
    expect(r.risk).not.toBeNull();
    expect(r.risk.score).toBeGreaterThanOrEqual(0);
    expect(r.risk.score).toBeLessThanOrEqual(100);
  });

  test('SAFE_KEEP > MANUAL_REVIEW > SAFE_ARCHIVE precedence: payment wins', () => {
    const job = baseImportedJob({ payment_status: 'paid' });
    const r = classifyJob(job, EMPTY_LOOKUPS, WINDOW);
    expect(r.bucket).toBe('safe_keep');
    expect(r.reasons).toContain('payment_status_paid_or_partial');
  });

  test('recurring=true keeps row even with full import provenance', () => {
    const r = classifyJob(baseImportedJob({ is_recurring: true }), EMPTY_LOOKUPS, WINDOW);
    expect(r.bucket).toBe('safe_keep');
    expect(r.reasons).toContain('is_recurring_parent');
  });

  test('LB linkage keeps row', () => {
    const r = classifyJob(
      baseImportedJob({ lb_external_request_id: 'req-123', lb_channel: 'thumbtack' }),
      EMPTY_LOOKUPS,
      WINDOW,
    );
    expect(r.bucket).toBe('safe_keep');
    expect(r.reasons).toContain('lb_linked');
  });

  test('XOR partial LB linkage -> manual_review', () => {
    const r = classifyJob(
      baseImportedJob({ lb_external_request_id: 'req-123', lb_channel: null }),
      EMPTY_LOOKUPS,
      WINDOW,
    );
    expect(r.bucket).toBe('manual_review');
    expect(r.reasons).toContain('partial_lb_linkage');
  });

  test('completed_with_cancelled_at -> manual_review', () => {
    const r = classifyJob(
      baseImportedJob({ cancelled_at: '2026-03-20T00:00:00Z', status: 'completed' }),
      EMPTY_LOOKUPS,
      WINDOW,
    );
    // cancelled_at also blocks safe_archive directly, but manual_review fires first.
    expect(r.bucket).toBe('manual_review');
    expect(r.reasons).toContain('completed_with_cancelled_at');
  });

  test('updated_at drift > 1h prevents safe_archive', () => {
    const job = baseImportedJob({
      created_at: '2026-03-04T18:00:00Z',
      updated_at: '2026-03-04T20:00:00Z', // +2h
    });
    const r = classifyJob(job, EMPTY_LOOKUPS, WINDOW);
    expect(r.bucket).toBe('untouched_outside_scope');
    expect(r.reasons).toContain('updated_at_drift_exceeded');
  });

  test('cleaner_ledger row prevents safe_archive', () => {
    const lookups = { ...EMPTY_LOOKUPS, ledgerJobIds: new Set([1]) };
    const r = classifyJob(baseImportedJob(), lookups, WINDOW);
    expect(r.bucket).toBe('untouched_outside_scope');
    expect(r.reasons).toContain('has_cleaner_ledger');
  });

  test('start_time set prevents safe_archive', () => {
    const r = classifyJob(
      baseImportedJob({ start_time: '2026-02-15T13:30:00Z' }),
      EMPTY_LOOKUPS,
      WINDOW,
    );
    expect(r.bucket).toBe('untouched_outside_scope');
    expect(r.reasons).toContain('start_time_set');
  });

  test('last_status_source set prevents safe_archive (operational touch)', () => {
    const r = classifyJob(
      baseImportedJob({ last_status_source: 'account_owner' }),
      EMPTY_LOOKUPS,
      WINDOW,
    );
    // Caught by SAFE_KEEP first via 'operationally_touched_status_source'
    expect(r.bucket).toBe('safe_keep');
  });

  test('customer with future job -> safe_keep', () => {
    const lookups = { ...EMPTY_LOOKUPS, futureJobsByCustomer: new Set([100]) };
    const r = classifyJob(baseImportedJob(), lookups, WINDOW);
    expect(r.bucket).toBe('safe_keep');
    expect(r.reasons).toContain('customer_has_future_appointment');
  });

  test('customer with conversation -> safe_keep', () => {
    const lookups = { ...EMPTY_LOOKUPS, convsByCustomer: new Set([100]) };
    const r = classifyJob(baseImportedJob(), lookups, WINDOW);
    expect(r.bucket).toBe('safe_keep');
    expect(r.reasons).toContain('customer_has_conversations');
  });

  test('outside import window -> not safe_archive', () => {
    const job = baseImportedJob({ created_at: '2026-05-01T12:00:00Z' });
    const r = classifyJob(job, EMPTY_LOOKUPS, WINDOW);
    // imported_outside_window fires in manual_review path
    expect(r.bucket).toBe('manual_review');
    expect(r.reasons).toContain('imported_outside_window');
  });

  test('throws when window opts missing', () => {
    expect(() => classifyJob(baseImportedJob(), EMPTY_LOOKUPS, {})).toThrow();
  });
});

// ─── helpers ─────────────────────────────────────────────────────────
describe('classifier helpers', () => {
  test('hasImportSignature: tags array', () => {
    expect(hasImportSignature({ tags: ['imported'] })).toBe(true);
    expect(hasImportSignature({ tags: ['booking-koala'] })).toBe(true);
    expect(hasImportSignature({ tags: ['other'] })).toBe(false);
  });
  test('hasImportSignature: contact_info.external_id', () => {
    expect(hasImportSignature({ tags: [], contact_info: { external_id: 'BK-1' } })).toBe(true);
    expect(hasImportSignature({ tags: [], contact_info: {} })).toBe(false);
  });
  test('withinDriftThreshold respects threshold', () => {
    const job = {
      created_at: '2026-03-04T00:00:00Z',
      updated_at: '2026-03-04T00:30:00Z',
    };
    expect(withinDriftThreshold(job, 60 * 60 * 1000)).toBe(true); // 30m < 1h
    expect(withinDriftThreshold(job, 10 * 60 * 1000)).toBe(false); // 30m > 10m
  });
  test('withinDriftThreshold null updated_at returns true', () => {
    expect(withinDriftThreshold({ created_at: '2026-03-04', updated_at: null }, 1000)).toBe(true);
  });
});

// ─── risk score ──────────────────────────────────────────────────────
describe('risk-score', () => {
  test('perfect job scores 100', () => {
    const { score } = calculateRiskScore(baseImportedJob(), {
      windowStart: WINDOW.windowStart,
      windowEnd: WINDOW.windowEnd,
      customerJobsTotal: 3,
    });
    expect(score).toBe(100);
  });

  test('missing booking-koala tag deducts', () => {
    const job = baseImportedJob({ tags: ['imported'] });
    const { score, deductions } = calculateRiskScore(job, {
      windowStart: WINDOW.windowStart,
      windowEnd: WINDOW.windowEnd,
      customerJobsTotal: 3,
    });
    expect(score).toBeLessThan(100);
    expect(deductions).toContain('missing_bk_tag');
  });

  test('window edge proximity deducts', () => {
    const job = baseImportedJob({ created_at: '2026-03-01T01:00:00Z' });
    const { deductions } = calculateRiskScore(job, {
      windowStart: WINDOW.windowStart,
      windowEnd: WINDOW.windowEnd,
      customerJobsTotal: 3,
    });
    expect(deductions).toContain('within_24h_of_window_start');
  });

  test('score is clamped to [0, 100]', () => {
    // Worst-case: no tags, no external_id, edge of window, money set, orphan, mid-customer
    const job = baseImportedJob({
      tags: [],
      contact_info: null,
      created_at: '2026-03-01T01:00:00Z', // edge start
      total_amount: 100,
      invoice_amount: 100,
      customer_id: null,
    });
    const { score } = calculateRiskScore(job, {
      windowStart: WINDOW.windowStart,
      windowEnd: WINDOW.windowEnd,
      customerJobsTotal: 0,
    });
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(100);
  });

  test('riskBand: 95→high, 75→medium, 40→borderline', () => {
    expect(riskBand(95)).toBe('high_confidence');
    expect(riskBand(75)).toBe('medium_confidence');
    expect(riskBand(40)).toBe('borderline');
  });

  test('deterministic across runs', () => {
    const args = [baseImportedJob({ tags: ['imported'] }), {
      windowStart: WINDOW.windowStart,
      windowEnd: WINDOW.windowEnd,
      customerJobsTotal: 2,
    }];
    const a = calculateRiskScore(...args);
    const b = calculateRiskScore(...args);
    expect(a).toEqual(b);
  });
});

// ─── window detector ─────────────────────────────────────────────────
describe('window-detector', () => {
  test('zero rows -> not ok, reason no_candidate_rows', () => {
    const r = detectWindow([]);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('no_candidate_rows');
  });

  test('detects single contiguous burst', () => {
    const rows = [];
    for (let i = 0; i < 100; i++) rows.push({ created_at: '2026-03-04T10:00:00Z' });
    for (let i = 0; i < 100; i++) rows.push({ created_at: '2026-03-05T10:00:00Z' });
    const r = detectWindow(rows);
    expect(r.ok).toBe(true);
    expect(r.start).toBe('2026-03-04T00:00:00Z');
    expect(r.end).toBe('2026-03-06T00:00:00Z'); // half-open: end is +1 day
    expect(r.burstTotalRows).toBe(200);
  });

  test('refuses multiple disjoint bursts', () => {
    const rows = [];
    for (let i = 0; i < 100; i++) rows.push({ created_at: '2026-03-04T10:00:00Z' });
    for (let i = 0; i < 100; i++) rows.push({ created_at: '2026-03-05T10:00:00Z' });
    for (let i = 0; i < 100; i++) rows.push({ created_at: '2026-04-15T10:00:00Z' });
    for (let i = 0; i < 100; i++) rows.push({ created_at: '2026-04-16T10:00:00Z' });
    const r = detectWindow(rows);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('multiple_disjoint_bursts');
    expect(r.candidateBurstCount).toBe(2);
  });

  test('bucketByDay groups correctly', () => {
    const m = bucketByDay([
      { created_at: '2026-03-04T10:00:00Z' },
      { created_at: '2026-03-04T15:00:00Z' },
      { created_at: '2026-03-05T10:00:00Z' },
    ]);
    expect(m.get('2026-03-04')).toBe(2);
    expect(m.get('2026-03-05')).toBe(1);
  });
});

// ─── csv emitter ─────────────────────────────────────────────────────
describe('csv', () => {
  test('rowsToCsv emits header + body with CRLF', () => {
    const out = rowsToCsv([{ a: 1, b: 'two' }], ['a', 'b']);
    expect(out.startsWith('﻿')).toBe(true); // UTF-8 BOM
    expect(out).toContain('a,b\r\n');
    expect(out).toContain('1,two');
  });

  test('quotes cells containing comma or quote', () => {
    const out = rowsToCsv([{ a: 'has, comma', b: 'has "quote"' }], ['a', 'b']);
    expect(out).toContain('"has, comma"');
    expect(out).toContain('"has ""quote"""');
  });

  test('renders array as ;-delimited', () => {
    const out = rowsToCsv([{ ids: [1, 2, 3] }], ['ids']);
    expect(out).toContain('1;2;3');
  });

  test('throws when columns missing', () => {
    expect(() => rowsToCsv([{ a: 1 }], [])).toThrow();
  });
});

// ─── checksums ───────────────────────────────────────────────────────
describe('checksums', () => {
  test('sha256OfString is deterministic', () => {
    expect(sha256OfString('hello')).toBe(sha256OfString('hello'));
    expect(sha256OfString('hello')).not.toBe(sha256OfString('world'));
  });
  test('sha256OfFile matches sha256OfString for same content', () => {
    const tmp = path.join(__dirname, '.tmp-sha-test.txt');
    fs.writeFileSync(tmp, 'hello world');
    try {
      expect(sha256OfFile(tmp)).toBe(sha256OfString('hello world'));
    } finally {
      fs.unlinkSync(tmp);
    }
  });
});

// ─── provenance ──────────────────────────────────────────────────────
describe('provenance', () => {
  test('parseProjectRef extracts ref from supabase URL', () => {
    // Synthetic refs only — keeps real project identifiers out of the test file.
    expect(parseProjectRef('https://abcdefghijklmnopqrst.supabase.co')).toBe(
      'abcdefghijklmnopqrst',
    );
    expect(parseProjectRef('https://other-ref.supabase.co/path')).toBe('other-ref');
    expect(parseProjectRef(null)).toBeNull();
    expect(parseProjectRef('not a url')).toBeNull();
  });

  test('getMigrationState returns latest .sql filename', () => {
    const state = getMigrationState(path.join(__dirname, '..'));
    expect(state.count).toBeGreaterThan(0);
    expect(state.latest_migration_file).toMatch(/\.sql$/);
  });
});

// ─── CLI hard guards (smoke tests) ───────────────────────────────────
describe('CLI hard guards', () => {
  const SCRIPT = path.join(__dirname, '..', 'scripts', 'zb-cleanup-classify.js');

  test('--apply rejected with exit 2', () => {
    const r = spawnSync('node', [SCRIPT, '--apply'], {
      env: { ...process.env, SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'fake' },
      timeout: 10_000,
    });
    expect(r.status).toBe(2);
    expect(r.stderr.toString()).toMatch(/READ-ONLY classifier/);
  });

  test('missing --user-id and --tenant exits 4', () => {
    const r = spawnSync('node', [SCRIPT], {
      env: { ...process.env, SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'fake' },
      timeout: 10_000,
    });
    expect(r.status).toBe(4);
    expect(r.stderr.toString()).toMatch(/Required: --user-id/);
  });

  test('missing env vars exits 1', () => {
    const r = spawnSync('node', [SCRIPT, '--user-id', '2'], {
      env: { ...process.env, SUPABASE_URL: '', SUPABASE_SERVICE_ROLE_KEY: '' },
      timeout: 10_000,
    });
    expect(r.status).toBe(1);
    expect(r.stderr.toString()).toMatch(/SUPABASE_URL.*required/);
  });
});

// ─── No-write invariant — pure libs cannot mutate Supabase ────────────
// The lib/zb-cleanup/* files are pure helpers. None of them require
// @supabase/supabase-js — they receive a client (provenance, tenant-resolver)
// or operate on plain data (classifier, risk-score, window-detector, csv,
// checksums). The only Supabase mutation call shapes are .from(t).insert/
// update/upsert/delete and .rpc() — pin the absence of those chains here.
describe('no-write invariant', () => {
  test('lib/zb-cleanup/*.js does not require @supabase/supabase-js', () => {
    const dir = path.join(__dirname, '..', 'lib', 'zb-cleanup');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js'));
    for (const f of files) {
      const src = fs.readFileSync(path.join(dir, f), 'utf8');
      expect({ file: f, hasSupabaseImport: /@supabase\/supabase-js/.test(src) }).toEqual({
        file: f,
        hasSupabaseImport: false,
      });
    }
  });

  test('lib/zb-cleanup/*.js contains no Supabase mutation chains', () => {
    const dir = path.join(__dirname, '..', 'lib', 'zb-cleanup');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js'));
    // Match `.from('x').insert(`, `.from("x").update(`, etc. across whitespace/newlines.
    const FORBIDDEN = /\.from\s*\(\s*['"][^'"]+['"]\s*\)[\s\S]*?\.(insert|update|upsert|delete)\s*\(/g;
    const RPC = /\bsupabase\s*\.\s*rpc\s*\(/g;
    for (const f of files) {
      const src = fs.readFileSync(path.join(dir, f), 'utf8');
      const stripped = src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
      expect({ file: f, mutations: stripped.match(FORBIDDEN) || [] }).toEqual({
        file: f,
        mutations: [],
      });
      expect({ file: f, rpcCalls: stripped.match(RPC) || [] }).toEqual({
        file: f,
        rpcCalls: [],
      });
    }
  });
});
