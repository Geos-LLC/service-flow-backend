'use strict';

// ZB Cleanup — fixture-based E2E validation. NO NETWORK, NO LIVE DB.
//
// Stubs a Supabase-shaped client with in-memory synthetic data and runs:
//   - READ_ONLY_GUARD synthetic mutation tests
//   - discoverCandidates() against a stub
//   - full classifier orchestration end-to-end on 10 synthetic jobs
//   - summary.json shape + checksum + provenance assembly
//
// All names/phones/emails in fixtures are synthetic placeholders. None of
// the real customer data ever enters this test.

const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

const { wrapClient, wrapBuilder, FORBIDDEN_OPS } =
  require('../lib/zb-cleanup/read-only-guard');
const { classifyJob, CLASSIFIER_VERSION } =
  require('../lib/zb-cleanup/classifier');
const { calculateRiskScore, riskBand } =
  require('../lib/zb-cleanup/risk-score');
const { rowsToCsv } = require('../lib/zb-cleanup/csv');
const { sha256OfFile, sha256OfString } =
  require('../lib/zb-cleanup/checksums');
const {
  discoverCandidates,
  loadUserById,
} = require('../lib/zb-cleanup/tenant-resolver');

// ─── Synthetic Supabase stub ─────────────────────────────────────────
// A minimal in-memory query builder that supports the chains the cleanup
// code uses: .from(t).select(cols).eq().ilike().in().gte().lt().range().
// .order().limit().maybeSingle().  Returns a thenable so `await q`
// resolves to { data, error }.
function makeStub(tables) {
  function builder(table) {
    let rows = [...(tables[table] || [])];
    let single = false;
    let maybeSingle = false;
    const api = {
      select: () => api,
      eq: (col, v) => {
        rows = rows.filter((r) => r[col] === v);
        return api;
      },
      neq: (col, v) => {
        rows = rows.filter((r) => r[col] !== v);
        return api;
      },
      ilike: (col, fragment) => {
        // strip % wildcards and do case-insensitive substring
        const needle = String(fragment).replace(/%/g, '').toLowerCase();
        rows = rows.filter((r) =>
          String(r[col] || '').toLowerCase().includes(needle),
        );
        return api;
      },
      in: (col, list) => {
        const set = new Set(list);
        rows = rows.filter((r) => set.has(r[col]));
        return api;
      },
      gte: (col, v) => {
        rows = rows.filter((r) => r[col] >= v);
        return api;
      },
      lt: (col, v) => {
        rows = rows.filter((r) => r[col] < v);
        return api;
      },
      range: (start, end) => {
        rows = rows.slice(start, end + 1);
        return api;
      },
      order: () => api,
      limit: (n) => {
        rows = rows.slice(0, n);
        return api;
      },
      maybeSingle: () => {
        maybeSingle = true;
        return api;
      },
      single: () => {
        single = true;
        return api;
      },
      then: (resolve) => {
        if (single || maybeSingle) {
          resolve({ data: rows[0] || null, error: null });
        } else {
          resolve({ data: rows, error: null });
        }
      },
      // mutation methods exist so READ_ONLY_GUARD can intercept them
      insert: () => {
        throw new Error('stub: insert called (test fixture, should never run)');
      },
      update: () => {
        throw new Error('stub: update called');
      },
      upsert: () => {
        throw new Error('stub: upsert called');
      },
      delete: () => {
        throw new Error('stub: delete called');
      },
    };
    return api;
  }
  return {
    from: (t) => builder(t),
    rpc: () => {
      throw new Error('stub: rpc called');
    },
  };
}

// ─── READ_ONLY_GUARD synthetic mutation tests ────────────────────────
describe('READ_ONLY_GUARD — synthetic mutation enforcement', () => {
  const stub = makeStub({ jobs: [{ id: 1 }] });
  const guarded = wrapClient(stub);

  test('exports a frozen op list', () => {
    expect([...FORBIDDEN_OPS].sort()).toEqual(
      ['delete', 'insert', 'rpc', 'update', 'upsert'],
    );
  });

  test('SELECT chain works through the guard', async () => {
    const { data, error } = await guarded.from('jobs').select('*');
    expect(error).toBeNull();
    expect(data).toEqual([{ id: 1 }]);
  });

  test.each(['insert', 'update', 'upsert', 'delete'])(
    '.from(table).%s() throws',
    (op) => {
      expect(() => guarded.from('jobs')[op]({ x: 1 })).toThrow(
        /\[READ_ONLY_GUARD\]/,
      );
    },
  );

  test('client.rpc() throws even without a table', () => {
    expect(() => guarded.rpc('some_fn')).toThrow(/\[READ_ONLY_GUARD\]/);
  });

  test('chained mutation after filters still throws', () => {
    expect(() =>
      guarded.from('jobs').select('*').eq('id', 1).update({ x: 1 }),
    ).toThrow(/\[READ_ONLY_GUARD\]/);
  });

  test('error message names the op and table', () => {
    let caught;
    try {
      guarded.from('customers').delete();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    expect(caught.message).toContain('delete');
    expect(caught.message).toContain('customers');
  });
});

// ─── Discovery path with stub ────────────────────────────────────────
describe('discoverCandidates with stubbed Supabase', () => {
  const FIXTURE_USERS = [
    {
      id: 7777,
      email: 'owner@acme.test',
      business_name: 'Acme Co',
      created_at: '2024-01-01',
    },
    {
      id: 7778,
      email: 'admin@fixturetenant.test',
      business_name: 'Fixture Tenant LLC',
      created_at: '2024-02-01',
    },
    {
      id: 7779,
      email: 'unrelated@other.test',
      business_name: 'Other Co',
      created_at: '2024-03-01',
    },
  ];
  const FIXTURE_WORKSPACES = [
    {
      id: 100,
      name: 'Fixture Tenant Workspace',
      owner_user_id: 7778,
    },
  ];

  test('returns candidate list with merged unique user_ids; never auto-selects', async () => {
    const stub = makeStub({
      users: FIXTURE_USERS,
      sf_workspaces: FIXTURE_WORKSPACES,
    });
    const guarded = wrapClient(stub);
    const result = await discoverCandidates(guarded, 'fixture');

    expect(result.alias).toBe('fixture');
    expect(result.by_email.map((u) => u.id).sort()).toEqual([7778]);
    expect(result.by_business_name.map((u) => u.id).sort()).toEqual([7778]);
    expect(result.by_workspace.length).toBe(1);
    expect(result.by_workspace[0].owner.id).toBe(7778);

    // CRITICAL: discovery must return candidates, NEVER pick one.
    expect(result.merged_unique_user_ids).toEqual([7778]);
    expect(result).not.toHaveProperty('selected_user_id');
    expect(result).not.toHaveProperty('user_id');
  });

  test('multi-candidate alias still returns all candidates (caller decides)', async () => {
    const stub = makeStub({
      users: [
        ...FIXTURE_USERS,
        {
          id: 7780,
          email: 'second@fixturetenant.test',
          business_name: 'Fixture Sister Inc',
          created_at: '2024-04-01',
        },
      ],
      sf_workspaces: FIXTURE_WORKSPACES,
    });
    const guarded = wrapClient(stub);
    const result = await discoverCandidates(guarded, 'fixture');
    // Two distinct users now match — caller must decide.
    expect(result.merged_unique_user_ids).toEqual([7778, 7780]);
    // discoverCandidates does NOT prefer a single match even when one is "better".
    expect(result).not.toHaveProperty('selected_user_id');
  });

  test('zero matches yields empty merged list', async () => {
    const stub = makeStub({
      users: [
        {
          id: 1,
          email: 'a@b.test',
          business_name: 'No Match Co',
          created_at: '2024-01-01',
        },
      ],
      sf_workspaces: [],
    });
    const guarded = wrapClient(stub);
    const result = await discoverCandidates(guarded, 'fixture');
    expect(result.merged_unique_user_ids).toEqual([]);
  });
});

// ─── loadUserById strictness ─────────────────────────────────────────
describe('loadUserById — explicit-id only', () => {
  test('throws on non-int id', async () => {
    const stub = makeStub({ users: [] });
    await expect(loadUserById(stub, 'not-a-number')).rejects.toThrow(
      /invalid user_id/,
    );
  });
  test('throws on negative id', async () => {
    const stub = makeStub({ users: [] });
    await expect(loadUserById(stub, -1)).rejects.toThrow(/invalid user_id/);
  });
  test('throws when id not found', async () => {
    const stub = makeStub({ users: [{ id: 1 }] });
    await expect(loadUserById(stub, 42)).rejects.toThrow(/No user found/);
  });
  test('returns user row on exact id match', async () => {
    const stub = makeStub({
      users: [
        {
          id: 42,
          email: 'fixture@example.test',
          business_name: 'Fixture',
          created_at: '2024-01-01',
        },
      ],
    });
    const u = await loadUserById(stub, 42);
    expect(u.id).toBe(42);
  });
});

// ─── Fixture E2E classifier orchestration ────────────────────────────
describe('classifier — full fixture orchestration', () => {
  const WINDOW_START = '2026-03-01T00:00:00Z';
  const WINDOW_END = '2026-04-01T00:00:00Z';

  // Synthetic 10-job dataset covering each bucket. All names, phones,
  // emails, and external_ids are placeholders, NOT real customer data.
  const FIXTURE_JOBS = [
    // 4 perfect SAFE_ARCHIVE candidates (varying risk)
    mkJob({ id: 1, customer_id: 1001, risk: 'high' }),
    mkJob({ id: 2, customer_id: 1002, risk: 'high' }),
    mkJob({
      id: 3,
      customer_id: 1003,
      risk: 'borderline',
      created_at: '2026-03-01T01:00:00Z', // window edge — risk deduction only
      updated_at: '2026-03-01T01:00:00Z', // matches created_at (no drift)
      tags: ['imported'], // missing booking-koala — risk deduction
      contact_info: null, // missing external_id — risk deduction
      // NOTE: don't set total_amount > 0 with service_price = 0 here —
      // that combination is a MANUAL_REVIEW trigger (total_without_service_price).
    }),
    mkJob({
      id: 4,
      customer_id: 1004,
      risk: 'medium',
      tags: ['imported'], // missing booking-koala
    }),
    // SAFE_KEEP: payment_status set
    mkJob({
      id: 5,
      customer_id: 1005,
      payment_status: 'paid',
    }),
    // SAFE_KEEP: customer has future appointment
    mkJob({ id: 6, customer_id: 1006 }),
    // MANUAL_REVIEW: partial LB linkage
    mkJob({
      id: 7,
      customer_id: 1007,
      lb_external_request_id: 'fixture-req-A',
      lb_channel: null,
    }),
    // MANUAL_REVIEW: completed_with_cancelled_at
    mkJob({
      id: 8,
      customer_id: 1008,
      cancelled_at: '2026-03-20T00:00:00Z',
    }),
    // untouched_outside_scope: operational signal (start_time set) —
    // blocks SAFE_ARCHIVE but doesn't trip SAFE_KEEP or MANUAL_REVIEW.
    // (Ledger rows would route to MANUAL_REVIEW via orphan_ledger or
    // SAFE_KEEP via finalized_payout_ledger_exposure — by design.)
    mkJob({
      id: 9,
      customer_id: 1009,
      start_time: '2026-02-15T13:30:00Z',
    }),
    // untouched_outside_scope: drift > 1h
    mkJob({
      id: 10,
      customer_id: 1010,
      created_at: '2026-03-04T18:00:00Z',
      updated_at: '2026-03-04T22:00:00Z',
    }),
  ];

  // No ledger rows in this fixture — see job 9 comment above.
  const lookups = {
    ledgerJobIds: new Set(),
    batchedLedgerJobIds: new Set(),
    unbatchedLedgerJobIds: new Set(),
    txJobIds: new Set(),
    statusHistJobIds: new Set(),
    payrollEditJobIds: new Set(),
    cancellationExpenseJobIds: new Set(),
    lbOutboxJobIds: new Set(),
    futureJobsByCustomer: new Set([1006]),
    recurringParentByCustomer: new Set(),
    convsByCustomer: new Set(),
    customerJobsTotal: new Map(
      FIXTURE_JOBS.map((j) => [j.customer_id, 1]),
    ),
    assignmentCountByJobId: new Map(),
  };

  function mkJob(over) {
    const base = {
      id: over.id,
      user_id: 7777,
      customer_id: over.customer_id,
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
      contact_info: { external_id: 'FIX-' + over.id },
      customer: {
        id: over.customer_id,
        first_name: 'Fixture',
        last_name: 'Customer-' + over.customer_id,
        phone: '+1555010' + String(1000 + over.id).slice(-4),
        email: `fixture${over.id}@example.test`,
      },
    };
    return Object.assign(base, over);
  }

  test('all 10 jobs classify into expected buckets', () => {
    const counts = {
      safe_archive: 0,
      safe_keep: 0,
      manual_review: 0,
      untouched_outside_scope: 0,
    };
    const byId = {};
    for (const job of FIXTURE_JOBS) {
      const r = classifyJob(job, lookups, {
        windowStart: WINDOW_START,
        windowEnd: WINDOW_END,
      });
      counts[r.bucket]++;
      byId[job.id] = r;
    }
    expect(counts).toEqual({
      safe_archive: 4, // jobs 1,2,3,4
      safe_keep: 2, // jobs 5,6
      manual_review: 2, // jobs 7,8
      untouched_outside_scope: 2, // jobs 9,10
    });

    expect(byId[1].bucket).toBe('safe_archive');
    expect(byId[1].risk).not.toBeNull();
    // 95 not 100 — every customer in this fixture has exactly 1 job, so
    // the `customer_only_this_job` deduction (-5) fires for all candidates.
    // Still high_confidence band (>= 90).
    expect(byId[1].risk.score).toBe(95);
    expect(byId[1].risk.deductions).toEqual(['customer_only_this_job']);
    expect(byId[1].risk.band).toBe('high_confidence');

    expect(byId[3].bucket).toBe('safe_archive');
    expect(byId[3].risk.deductions).toEqual(
      expect.arrayContaining([
        'missing_bk_tag',
        'missing_external_id',
        'within_24h_of_window_start',
      ]),
    );
    // 3 deductions of -10 each → score 70 → medium_confidence band
    expect(byId[3].risk.score).toBeLessThanOrEqual(70);
    expect(['medium_confidence', 'borderline']).toContain(byId[3].risk.band);

    expect(byId[5].bucket).toBe('safe_keep');
    expect(byId[5].reasons).toContain('payment_status_paid_or_partial');

    expect(byId[6].bucket).toBe('safe_keep');
    expect(byId[6].reasons).toContain('customer_has_future_appointment');

    expect(byId[7].bucket).toBe('manual_review');
    expect(byId[7].reasons).toContain('partial_lb_linkage');

    expect(byId[8].bucket).toBe('manual_review');
    expect(byId[8].reasons).toContain('completed_with_cancelled_at');

    expect(byId[9].bucket).toBe('untouched_outside_scope');
    expect(byId[9].reasons).toContain('start_time_set');

    expect(byId[10].bucket).toBe('untouched_outside_scope');
    expect(byId[10].reasons).toContain('updated_at_drift_exceeded');
  });

  test('cascade-preview invariants are zero for safe_archive bucket', () => {
    const safeArchive = FIXTURE_JOBS.filter((job) => {
      const r = classifyJob(job, lookups, {
        windowStart: WINDOW_START,
        windowEnd: WINDOW_END,
      });
      return r.bucket === 'safe_archive';
    });
    const cascade = {
      cleaner_ledger: 0,
      job_status_history: 0,
      payroll_edits: 0,
      transactions: 0,
    };
    for (const job of safeArchive) {
      if (lookups.ledgerJobIds.has(job.id)) cascade.cleaner_ledger++;
      if (lookups.statusHistJobIds.has(job.id)) cascade.job_status_history++;
      if (lookups.payrollEditJobIds.has(job.id)) cascade.payroll_edits++;
      if (lookups.txJobIds.has(job.id)) cascade.transactions++;
    }
    expect(cascade).toEqual({
      cleaner_ledger: 0,
      job_status_history: 0,
      payroll_edits: 0,
      transactions: 0,
    });
  });

  test('summary structure assembles correctly', () => {
    const safeArchive = [];
    const safeKeep = [];
    const manualReview = [];
    const untouchedOutsideScope = [];
    for (const job of FIXTURE_JOBS) {
      const r = classifyJob(job, lookups, {
        windowStart: WINDOW_START,
        windowEnd: WINDOW_END,
      });
      const wrapped = {
        job_id: job.id,
        user_id: job.user_id,
        bucket: r.bucket,
        reasons: r.reasons,
        risk: r.risk,
      };
      ({
        safe_archive: safeArchive,
        safe_keep: safeKeep,
        manual_review: manualReview,
        untouched_outside_scope: untouchedOutsideScope,
      })[r.bucket].push(wrapped);
    }

    // Risk score distribution
    const dist = { high_confidence: 0, medium_confidence: 0, borderline: 0 };
    for (const r of safeArchive) {
      if (r.risk) dist[r.risk.band] = (dist[r.risk.band] || 0) + 1;
    }
    expect(dist.high_confidence).toBeGreaterThanOrEqual(2);
    // 4 safe_archive total — sum of bands equals bucket count
    expect(
      dist.high_confidence + dist.medium_confidence + dist.borderline,
    ).toBe(4);

    // Mock summary as the CLI would build it
    const summary = {
      classifier_version: CLASSIFIER_VERSION,
      generated_at: new Date().toISOString(),
      tenant: { user_id: 7777 },
      import_window: { start: WINDOW_START, end: WINDOW_END },
      buckets: {
        safe_archive: { count: safeArchive.length },
        safe_keep: { count: safeKeep.length },
        manual_review: { count: manualReview.length },
        untouched_outside_scope: { count: untouchedOutsideScope.length },
      },
      threshold_guard: { max_archive_rows: 10000, allow_large_batch: false },
      warnings: [],
    };
    expect(summary.classifier_version).toBe('v2.0.0');
    expect(summary.buckets.safe_archive.count).toBe(4);
    expect(summary.buckets.safe_keep.count).toBe(2);
    expect(summary.buckets.manual_review.count).toBe(2);
  });

  test('threshold guard fires when safe_archive exceeds max_archive_rows', () => {
    const safeArchive = [];
    for (const job of FIXTURE_JOBS) {
      const r = classifyJob(job, lookups, {
        windowStart: WINDOW_START,
        windowEnd: WINDOW_END,
      });
      if (r.bucket === 'safe_archive') safeArchive.push(job.id);
    }
    const MAX = 2; // tighter than fixture's 4
    const allowLargeBatch = false;
    const exceeded = safeArchive.length > MAX;
    const warnings = [];
    let exitCode = 0;
    if (exceeded && !allowLargeBatch) {
      warnings.push({
        level: 'HARD_STOP',
        code: 'safe_archive_exceeded_threshold',
        threshold: MAX,
        observed: safeArchive.length,
      });
      exitCode = 3;
    }
    expect(exceeded).toBe(true);
    expect(exitCode).toBe(3);
    expect(warnings[0].level).toBe('HARD_STOP');
    expect(warnings[0].observed).toBe(4);
  });
});

// ─── Output writer fixture: JSON + CSV + checksums + provenance ─────
describe('full output writing flow with synthetic data', () => {
  let tmpDir;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zbc-fixture-'));
  });
  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('writes JSON + CSV files, computes checksums, builds provenance', () => {
    // Synthetic safe_archive payload — placeholder PII only.
    const fixtureSafeArchive = [
      {
        job_id: 1,
        user_id: 7777,
        bucket: 'safe_archive',
        reasons: ['all_predicates_pass'],
        risk: { score: 100, deductions: [], band: 'high_confidence' },
        row: { id: 1, status: 'completed' },
      },
    ];
    const fixtureCsvRows = [
      {
        user_id: 7777,
        phone_last10: '5550101001',
        customer_count: 2,
        customer_ids: [1001, 1002],
        customer_names: ['Fixture A', 'Fixture B'],
        total_jobs_in_cluster: 4,
        last_activity_at: null,
      },
    ];

    const checksums = {};

    // Write JSON
    const jsonAbs = path.join(tmpDir, 'safe-archive.json');
    fs.writeFileSync(jsonAbs, JSON.stringify(fixtureSafeArchive, null, 2));
    checksums['safe-archive.json'] = sha256OfFile(jsonAbs);

    // Write CSV
    const csvAbs = path.join(tmpDir, 'dup-phones.csv');
    fs.writeFileSync(
      csvAbs,
      rowsToCsv(fixtureCsvRows, [
        'user_id',
        'phone_last10',
        'customer_count',
        'customer_ids',
        'customer_names',
        'total_jobs_in_cluster',
        'last_activity_at',
      ]),
    );
    checksums['dup-phones.csv'] = sha256OfFile(csvAbs);

    // Verify shape
    expect(Object.keys(checksums).sort()).toEqual([
      'dup-phones.csv',
      'safe-archive.json',
    ]);
    for (const [name, hash] of Object.entries(checksums)) {
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
      const expected = sha256OfString(
        fs.readFileSync(path.join(tmpDir, name), 'utf8'),
      );
      expect(hash).toBe(expected);
    }

    // Synthetic provenance — without hitting Supabase
    const provenance = {
      project_ref: 'fixture-ref',
      supabase_url: 'https://fixture-ref.supabase.co',
      git: { branch: 'fixture-branch', commit: 'deadbeef', is_dirty: false },
      migration_state: { latest_migration_file: '999_fixture.sql', count: 1 },
      postgres: { server_version: '15.0' },
      generated_by: {
        script_path: 'scripts/zb-cleanup-classify.js',
        classifier_version: CLASSIFIER_VERSION,
        node_version: process.version,
        platform: process.platform,
      },
    };

    const summary = {
      batch_id:
        'zbc_fixture_' + crypto.randomBytes(3).toString('hex'),
      classifier_version: CLASSIFIER_VERSION,
      mode: 'classification',
      tenant: { user_id: 7777 },
      threshold_guard: { max_archive_rows: 10000, allow_large_batch: false },
      output_files: Object.entries(checksums).map(([name, sha256]) => ({
        name,
        sha256,
        bytes: fs.statSync(path.join(tmpDir, name)).size,
      })),
      provenance,
      warnings: [],
    };
    const summaryAbs = path.join(tmpDir, 'summary.json');
    fs.writeFileSync(summaryAbs, JSON.stringify(summary, null, 2));

    // Verify summary integrity
    const reread = JSON.parse(fs.readFileSync(summaryAbs, 'utf8'));
    expect(reread.classifier_version).toBe('v2.0.0');
    expect(reread.output_files).toHaveLength(2);
    expect(reread.output_files.every((f) => f.sha256.length === 64)).toBe(true);
    expect(reread.provenance.generated_by.classifier_version).toBe('v2.0.0');
    expect(reread.provenance.project_ref).toBe('fixture-ref');
    expect(reread.warnings).toEqual([]);

    // None of the written files contain real customer data — sanity check.
    // Tokens built at runtime so this assertion does not put the literal
    // strings in the test file itself.
    const FORBIDDEN_IN_OUTPUT = [
      'spotless' + '.' + 'homes',
      ['ezyh', 'bvsk', 'bwmw', 'gwyd', 'uqpt'].join(''),
    ];
    for (const f of fs.readdirSync(tmpDir)) {
      const content = fs.readFileSync(path.join(tmpDir, f), 'utf8');
      for (const tok of FORBIDDEN_IN_OUTPUT) {
        expect(content.toLowerCase()).not.toContain(tok.toLowerCase());
      }
    }
  });
});

// ─── Anti-leak guard ─────────────────────────────────────────────────
// Pinned identifiers are constructed at runtime via String.fromCharCode
// so this test file itself never contains the literal strings it
// forbids — otherwise the test would fail self-referentially.
describe('fixture isolation', () => {
  test('test fixtures use only synthetic data', () => {
    const thisFile = fs.readFileSync(__filename, 'utf8');

    // Build the forbidden tokens at runtime — file does NOT contain them literally.
    const FORBIDDEN_TOKENS = [
      'spotless' + '.' + 'homes',
      ['ezyh', 'bvsk', 'bwmw', 'gwyd', 'uqpt'].join(''),
    ];
    for (const tok of FORBIDDEN_TOKENS) {
      // Strip occurrences inside our own runtime-built constants and
      // count remaining literal hits — must be zero.
      const stripped = thisFile.replace(/FORBIDDEN_TOKENS[\s\S]*?\]\;/, '');
      expect({ token: tok, hits: (stripped.match(new RegExp(tok, 'gi')) || []).length })
        .toEqual({ token: tok, hits: 0 });
    }

    // Phones in fixtures must be in the 555 reserved test range
    const phones = thisFile.match(/\+1\d{10}/g) || [];
    for (const p of phones) {
      expect(p.startsWith('+1555')).toBe(true);
    }
  });
});
