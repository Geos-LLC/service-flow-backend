/**
 * PR-S1.5 — Stripe Connect onboarding idempotency tests.
 *
 * Two strategies (consistent with the rest of the suite):
 *   1. Source-level invariants — assert server.js shape directly:
 *      - exactly ONE registration of /api/stripe/connect/{account-link, account-status}
 *      - no `req.user.id` reads inside Connect handlers
 *      - no `user_billing.stripe_connect_account_id` references in backend
 *      - the surviving handler emits the 4 branch tags
 *      - the surviving handler returns the stable response shape keys
 *
 *   2. Behavioral tests — an in-process Express harness that mirrors the
 *      handler's 4-branch logic with mocked Stripe SDK + mocked Supabase.
 *      Verifies CASE_1..CASE_4 routing, reused/created flags, response shape,
 *      and (importantly) the race regression documented for future PR.
 */

const fs = require('fs');
const path = require('path');
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const SERVER_SRC = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

// ─────────────────────────────────────────────────────────────────
// Section 1 — Source-level invariants
// ─────────────────────────────────────────────────────────────────

describe('PR-S1.5 — source invariants on Connect routes', () => {
  test('exactly ONE registration of POST /api/stripe/connect/account-link', () => {
    const matches = SERVER_SRC.match(/app\.post\(\s*'\/api\/stripe\/connect\/account-link'/g) || [];
    expect(matches.length).toBe(1);
  });

  test('exactly ONE registration of GET /api/stripe/connect/account-status', () => {
    const matches = SERVER_SRC.match(/app\.get\(\s*'\/api\/stripe\/connect\/account-status'/g) || [];
    expect(matches.length).toBe(1);
  });

  test('no `req.user.id` references in Connect handlers', () => {
    // Locate the Connect handler region (from its declaration to the next
    // `app.<verb>(` two routes later) and assert req.user.id is absent.
    const linkIdx = SERVER_SRC.indexOf("app.post('/api/stripe/connect/account-link'");
    const webhookIdx = SERVER_SRC.indexOf("app.post('/api/stripe/connect/webhook'");
    expect(linkIdx).toBeGreaterThan(0);
    expect(webhookIdx).toBeGreaterThan(linkIdx);
    const connectRegion = SERVER_SRC.slice(linkIdx, webhookIdx);
    // Allow `req.user.userId` (JWT) but reject `req.user.id` (the bug).
    expect(connectRegion).not.toMatch(/req\.user\.id(?!\w)/);
  });

  test('no code references to `user_billing.stripe_connect_account_id` (comments allowed)', () => {
    // The broken column was in the deleted block; this is a regression guard
    // so the column never silently sneaks back into the codebase.
    //
    // Strict pattern: a Supabase from('user_billing') call followed by a
    // select/upsert/update that touches the column. Excludes commentary
    // (lines starting with // or inside /* */).
    const lines = SERVER_SRC.split('\n');
    let inBlockComment = false;
    const offenders = [];
    let userBillingScope = false;
    let userBillingScopeLine = 0;
    lines.forEach((rawLine, idx) => {
      const lineNum = idx + 1;
      const line = rawLine;
      const trimmed = line.trim();
      // Skip pure comment lines and block-comment ranges
      if (inBlockComment) {
        if (trimmed.includes('*/')) inBlockComment = false;
        return;
      }
      if (trimmed.startsWith('/*')) { if (!trimmed.includes('*/')) inBlockComment = true; return; }
      if (trimmed.startsWith('//')) return;

      // Track multi-line .from('user_billing') statement scope
      if (/\.from\(\s*['"]user_billing['"]\s*\)/.test(line)) {
        userBillingScope = true;
        userBillingScopeLine = lineNum;
      }
      // Reset scope at statement-terminating tokens
      if (userBillingScope && /;\s*$/.test(line)) {
        userBillingScope = false;
      }

      if (userBillingScope && /stripe_connect_account_id/.test(line)) {
        offenders.push({ line: lineNum, scopeStart: userBillingScopeLine, text: line.trim().slice(0, 120) });
      }
    });
    expect(offenders).toEqual([]);
  });

  test('handler emits the 4 branch tags', () => {
    expect(SERVER_SRC).toMatch(/CASE_1_CREATE/);
    expect(SERVER_SRC).toMatch(/CASE_2_RESUME_PENDING/);
    expect(SERVER_SRC).toMatch(/CASE_3_ACCOUNT_UPDATE/);
    expect(SERVER_SRC).toMatch(/CASE_4_RECREATE_INVALID/);
  });

  test('handler returns stable response shape { url, accountId, status }', () => {
    // The literal `res.json({ url: accountLink.url, accountId, status })` is
    // the canonical return statement. Pattern-match it.
    expect(SERVER_SRC).toMatch(/res\.json\(\{\s*url:\s*accountLink\.url\s*,\s*accountId\s*,\s*status\s*\}\)/);
  });

  test('no AccountLink URL or key material in branch log lines', () => {
    // Find the [Connect account-link] structured log and assert it doesn't
    // include "accountLink.url" or "stripeSecretKey" / "STRIPE_SECRET_KEY".
    const lines = SERVER_SRC.split('\n');
    const offenders = lines
      .map((l, i) => ({ l, i: i + 1 }))
      .filter(({ l }) =>
        /\[Connect account-link\]/.test(l) &&
        /(accountLink\.url|stripeSecretKey|STRIPE_SECRET_KEY)/.test(l)
      );
    expect(offenders).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────
// Section 2 — Behavioral tests (4 cases + race regression)
// ─────────────────────────────────────────────────────────────────

function buildHarness({ jwtSecret = 'test-secret', initialDbRow = null, stripeOverrides = {}, selectDelayMs = 0 } = {}) {
  const app = express();
  app.use(express.json());

  // Mock state
  let dbRow = initialDbRow;
  const log = [];
  const logger = {
    log: (msg) => log.push(msg),
    warn: (msg) => log.push(`WARN ${msg}`),
    error: (msg) => log.push(`ERROR ${msg}`),
  };
  const stripeCalls = [];
  const mockStripe = {
    accounts: {
      retrieve: stripeOverrides.retrieve || (async (id) => ({ id, charges_enabled: false, details_submitted: false })),
      create: stripeOverrides.create || (async () => {
        const id = `acct_new_${stripeCalls.filter(c => c.op === 'create').length + 1}`;
        return { id, charges_enabled: false, details_submitted: false };
      }),
    },
    accountLinks: {
      create: stripeOverrides.linkCreate || (async ({ account, type }) => ({
        url: `https://stripe.com/setup/${account}/${type}/${Date.now()}/${Math.random()}`,
      })),
    },
  };
  // Wrap to record calls
  const recordingStripe = {
    accounts: {
      retrieve: async (id) => { stripeCalls.push({ op: 'retrieve', id }); return mockStripe.accounts.retrieve(id); },
      create: async (params) => { const r = await mockStripe.accounts.create(params); stripeCalls.push({ op: 'create', id: r.id }); return r; },
    },
    accountLinks: {
      create: async (args) => { const r = await mockStripe.accountLinks.create(args); stripeCalls.push({ op: 'linkCreate', account: args.account, type: args.type, url: r.url }); return r; },
    },
  };

  const supabase = {
    from: (table) => ({
      select: () => ({
        eq: () => ({
          single: async () => {
            // Optional delay so concurrent requests genuinely interleave at the
            // event-loop level — required to reproduce the production race in
            // a pure-JS in-memory harness (no network/DB latency otherwise).
            if (selectDelayMs > 0) await new Promise(r => setTimeout(r, selectDelayMs));
            if (table === 'users' && dbRow) return { data: dbRow };
            return { data: null };
          },
        }),
      }),
      update: (patch) => ({
        eq: async () => {
          dbRow = { ...(dbRow || {}), ...patch };
          return { error: null };
        },
      }),
    }),
  };

  function authenticateToken(req, res, next) {
    const token = (req.headers['authorization'] || '').split(' ')[1];
    if (!token) return res.status(401).json({ error: 'No token' });
    try { req.user = jwt.verify(token, jwtSecret); next(); }
    catch { return res.status(401).json({ error: 'Invalid token' }); }
  }

  // Inlined harness handler mirroring the production handler logic.
  // Keep this in sync with server.js — the source-invariant tests above
  // assert the production handler emits the same branch tags and shape.
  app.post('/api/stripe/connect/account-link', authenticateToken, async (req, res) => {
    try {
      const userId = req.user.userId;
      const stripe = recordingStripe;

      const { data: existing } = await supabase.from('users').select().eq().single();
      let accountId = existing?.stripe_connect_account_id || null;
      let status = null;
      let branch = null;
      let reused = false;
      let created = false;

      let stripeAccount = null;
      if (accountId) {
        try { stripeAccount = await stripe.accounts.retrieve(accountId); }
        catch (e) {
          logger.warn(`[Connect account-link] stored accountId=${accountId} not retrievable from Stripe (${e.code || e.message}); will create fresh`);
          accountId = null;
        }
      }

      if (!accountId) {
        branch = stripeAccount === null && existing?.stripe_connect_account_id
          ? 'CASE_4_RECREATE_INVALID'
          : 'CASE_1_CREATE';
        const newAccount = await stripe.accounts.create({
          type: 'express', country: 'US', email: req.user.email,
          capabilities: { card_payments: { requested: true }, transfers: { requested: true } },
        });
        accountId = newAccount.id;
        status = 'pending';
        created = true;
        await supabase.from('users').update({ stripe_connect_account_id: accountId, stripe_connect_status: status }).eq();
      } else {
        reused = true;
        const isActive = !!(stripeAccount && stripeAccount.charges_enabled);
        status = isActive ? 'active' : 'pending';
        branch = isActive ? 'CASE_3_ACCOUNT_UPDATE' : 'CASE_2_RESUME_PENDING';
      }

      const linkType = status === 'active' ? 'account_update' : 'account_onboarding';
      const accountLink = await stripe.accountLinks.create({ account: accountId, type: linkType });

      logger.log(`[Connect account-link] branch=${branch} userId=${userId} accountId=${accountId} reused=${reused} created=${created} linkType=${linkType}`);

      return res.json({ url: accountLink.url, accountId, status });
    } catch (error) {
      logger.error(`[Connect account-link] unexpected error: ${error.message}`);
      return res.status(500).json({ error: error.message });
    }
  });

  return {
    app,
    sign: (payload) => jwt.sign(payload, jwtSecret, { expiresIn: '5m' }),
    log,
    stripeCalls,
    getDbRow: () => dbRow,
  };
}

describe('PR-S1.5 — CASE_1_CREATE (no existing account)', () => {
  test('creates a new account, persists it, returns stable shape', async () => {
    const h = buildHarness({ initialDbRow: null });
    const token = h.sign({ userId: 42, email: 'op@test' });
    const res = await request(h.app).post('/api/stripe/connect/account-link').set('Authorization', `Bearer ${token}`).send({});
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('url');
    expect(res.body).toHaveProperty('accountId');
    expect(res.body).toHaveProperty('status', 'pending');
    expect(res.body.accountId).toMatch(/^acct_/);
    expect(h.stripeCalls.find(c => c.op === 'create')).toBeDefined();
    expect(h.stripeCalls.find(c => c.op === 'linkCreate')?.type).toBe('account_onboarding');
    expect(h.getDbRow()).toMatchObject({ stripe_connect_account_id: res.body.accountId, stripe_connect_status: 'pending' });
    expect(h.log.some(l => l.includes('branch=CASE_1_CREATE'))).toBe(true);
    expect(h.log.some(l => l.includes(`accountId=${res.body.accountId}`))).toBe(true);
    expect(h.log.some(l => l.includes('reused=false'))).toBe(true);
    expect(h.log.some(l => l.includes('created=true'))).toBe(true);
  });
});

describe('PR-S1.5 — CASE_2_RESUME_PENDING (existing pending account)', () => {
  test('reuses account, no new create, returns same accountId, account_onboarding link', async () => {
    const h = buildHarness({
      initialDbRow: { stripe_connect_account_id: 'acct_existing_pending', stripe_connect_status: 'pending' },
      stripeOverrides: { retrieve: async (id) => ({ id, charges_enabled: false, details_submitted: false }) },
    });
    const token = h.sign({ userId: 42, email: 'op@test' });
    const res = await request(h.app).post('/api/stripe/connect/account-link').set('Authorization', `Bearer ${token}`).send({});
    expect(res.status).toBe(200);
    expect(res.body.accountId).toBe('acct_existing_pending');
    expect(res.body.status).toBe('pending');
    expect(h.stripeCalls.find(c => c.op === 'create')).toBeUndefined(); // NO new account created
    expect(h.stripeCalls.filter(c => c.op === 'retrieve').length).toBe(1);
    expect(h.stripeCalls.find(c => c.op === 'linkCreate')?.type).toBe('account_onboarding');
    expect(h.log.some(l => l.includes('branch=CASE_2_RESUME_PENDING'))).toBe(true);
    expect(h.log.some(l => l.includes('reused=true'))).toBe(true);
  });
});

describe('PR-S1.5 — CASE_3_ACCOUNT_UPDATE (existing active account)', () => {
  test('reuses account, generates account_update link', async () => {
    const h = buildHarness({
      initialDbRow: { stripe_connect_account_id: 'acct_existing_active', stripe_connect_status: 'active' },
      stripeOverrides: { retrieve: async (id) => ({ id, charges_enabled: true, details_submitted: true }) },
    });
    const token = h.sign({ userId: 42, email: 'op@test' });
    const res = await request(h.app).post('/api/stripe/connect/account-link').set('Authorization', `Bearer ${token}`).send({});
    expect(res.body.accountId).toBe('acct_existing_active');
    expect(res.body.status).toBe('active');
    expect(h.stripeCalls.find(c => c.op === 'create')).toBeUndefined();
    expect(h.stripeCalls.find(c => c.op === 'linkCreate')?.type).toBe('account_update');
    expect(h.log.some(l => l.includes('branch=CASE_3_ACCOUNT_UPDATE'))).toBe(true);
  });
});

describe('PR-S1.5 — CASE_4_RECREATE_INVALID (stored id no longer on Stripe)', () => {
  test('treats retrieve-failure as no-existing and creates fresh account', async () => {
    const h = buildHarness({
      initialDbRow: { stripe_connect_account_id: 'acct_deleted_on_stripe', stripe_connect_status: 'pending' },
      stripeOverrides: {
        retrieve: async () => {
          const err = new Error('No such account');
          err.code = 'resource_missing';
          throw err;
        },
      },
    });
    const token = h.sign({ userId: 42, email: 'op@test' });
    const res = await request(h.app).post('/api/stripe/connect/account-link').set('Authorization', `Bearer ${token}`).send({});
    expect(res.body.accountId).not.toBe('acct_deleted_on_stripe');
    expect(res.body.accountId).toMatch(/^acct_/);
    expect(h.stripeCalls.find(c => c.op === 'create')).toBeDefined();
    expect(h.log.some(l => l.includes('not retrievable from Stripe'))).toBe(true);
    expect(h.log.some(l => l.includes('branch=CASE_4_RECREATE_INVALID'))).toBe(true);
    expect(h.getDbRow().stripe_connect_account_id).toBe(res.body.accountId);
  });
});

describe('PR-S1.5 — reconnect-after-disconnect (DB row cleared by disconnect)', () => {
  test('after disconnect cleared the column, next click hits CASE_1_CREATE', async () => {
    const h = buildHarness({ initialDbRow: { stripe_connect_account_id: null, stripe_connect_status: 'disconnected' } });
    const token = h.sign({ userId: 42, email: 'op@test' });
    const res = await request(h.app).post('/api/stripe/connect/account-link').set('Authorization', `Bearer ${token}`).send({});
    expect(res.status).toBe(200);
    expect(res.body.accountId).toMatch(/^acct_/);
    expect(h.stripeCalls.find(c => c.op === 'create')).toBeDefined();
    expect(h.log.some(l => l.includes('branch=CASE_1_CREATE'))).toBe(true);
  });
});

describe('PR-S1.5 — concurrent double-click regression doc test', () => {
  // Documents current race behavior. PR-S1.5 does NOT implement true row-level
  // locking — that's intentionally out of scope. This test exists so future
  // PRs improving idempotency under concurrency can be detected (and so the
  // current behavior is explicit).
  test('two concurrent CASE_1 paths can race and produce two Stripe accounts (KNOWN, accepted)', async () => {
    // selectDelayMs forces the two requests to BOTH observe the empty initial
    // state before either writes back — without it, the JS event loop happens
    // to serialize the in-memory mock and the race never manifests.
    // A second delay on stripe.accounts.create() prevents R1 from completing
    // its DB-write before R2's select resolves (otherwise R2 would see R1's
    // write and hit CASE_2 instead of racing).
    let createCalls = 0;
    const h = buildHarness({
      initialDbRow: null,
      selectDelayMs: 25,
      stripeOverrides: {
        create: async () => {
          createCalls += 1;
          const id = `acct_race_${createCalls}`;
          await new Promise(r => setTimeout(r, 50));
          return { id, charges_enabled: false, details_submitted: false };
        },
      },
    });
    const token = h.sign({ userId: 42, email: 'op@test' });
    const [r1, r2] = await Promise.all([
      request(h.app).post('/api/stripe/connect/account-link').set('Authorization', `Bearer ${token}`).send({}),
      request(h.app).post('/api/stripe/connect/account-link').set('Authorization', `Bearer ${token}`).send({}),
    ]);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    // Both calls observed the same initial state (no DB row) and both took
    // CASE_1_CREATE. The DB row ends up with whichever id was written last.
    // Both Stripe accounts exist on the platform side — race surface to fix
    // in a follow-up PR (row-level lock or upsert-with-version-check).
    const createCount = h.stripeCalls.filter(c => c.op === 'create').length;
    expect(createCount).toBe(2);
    expect(r1.body.accountId).not.toBe(r2.body.accountId);
    // The final DB state has one of the two accountIds (race-winner).
    expect([r1.body.accountId, r2.body.accountId]).toContain(h.getDbRow().stripe_connect_account_id);
    // After the race resolves, ANY subsequent serial request hits CASE 2 or
    // CASE 3 (the survivor in DB). Verify by making a third call and
    // checking it does NOT create a new account.
    const stripeCallCountBefore3rdCall = h.stripeCalls.filter(c => c.op === 'create').length;
    const r3 = await request(h.app).post('/api/stripe/connect/account-link').set('Authorization', `Bearer ${token}`).send({});
    expect(r3.status).toBe(200);
    expect(h.stripeCalls.filter(c => c.op === 'create').length).toBe(stripeCallCountBefore3rdCall); // unchanged
    expect(h.log.some(l => /branch=CASE_(2|3)/.test(l))).toBe(true);
  });
});
