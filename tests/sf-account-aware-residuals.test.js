'use strict';

/**
 * Account-aware residual cleanup (PR D) — classifier unit tests.
 *
 * Pinned behaviors per operator spec:
 *   - 59-row fixture classifies as 9 auto_link / 47 auto_no_match /
 *     3 needs_review / 0 unresolved
 *   - account_id missing → fallback_to_matcher (no override)
 *   - duplicate-phone conflict accounts are not merged (the classifier
 *     treats each account independently — merging is out of scope)
 *   - customer with multiple LB leads resolves through the SAME account
 *   - paid customer + recent + engaged → needs_review
 *     (ACTIVE_ACCOUNT_REENGAGEMENT)
 *   - stale no-revenue account → auto_no_match (SAME_ACCOUNT_SIBLING_LINKED)
 *   - sf_truth_overrides_lost → AUTO_LINK with delivery_path SYNC_APPLY
 *     (never feedback)
 *
 * The classifier is PURE. No mocks needed — every test is a deterministic
 * input → output assertion.
 */

const {
  classifyAccountAware,
  ACCOUNT_CLASSES,
  ACTIONS,
  DELIVERY_PATHS,
  RECENT_DAYS_DEFAULT,
} = require('../lib/sf-account-aware-residuals');

// ─── Fixture builders ──────────────────────────────────────────────────────
const NOW = new Date('2026-06-06T00:00:00Z');

function lbCandidate({ leadId = 'lb-' + Math.random().toString(36).slice(2,8), accountId = 'acct-1', createdAt = NOW, customerName = null } = {}) {
  return { leadId, accountId, createdAt, customerName };
}
function cat(bucket, reason = null, extra = {}) {
  return { bucket, reason, ...extra };
}
function ctx({ customerId = null, paidJobsCount = 0, totalJobsCount = 0, sfLeadIdsInAccount = [], linkedSiblingLbCount = 0, anySiblingLbCount = 0, marketplaceDuplicateSibling = false, customerEngagedOnThread = false, sfLeadInActiveStage = false } = {}) {
  return { customerId, paidJobsCount, totalJobsCount, sfLeadIdsInAccount, linkedSiblingLbCount, anySiblingLbCount, marketplaceDuplicateSibling, customerEngagedOnThread, sfLeadInActiveStage };
}
function classify(lb, c, a, opts = {}) {
  return classifyAccountAware({
    lbCandidate:    lb,
    categorized:    c,
    accountContext: a,
    options:        { now: NOW, ...opts },
  });
}

// ─── 1. account_id missing → fallback_to_matcher ───────────────────────────
describe('account_id missing → fallback to existing matcher', () => {
  test('no accountId on LB lead → UNRESOLVED + FALLBACK_TO_MATCHER', () => {
    const lb = lbCandidate({ accountId: null });
    const cls = classify(lb, cat('would_review', 'cross_inquiry_or_non_lb_sf_lead'), ctx());
    expect(cls.account_class).toBe(ACCOUNT_CLASSES.UNRESOLVED_NO_ACCOUNT_ID);
    expect(cls.action).toBe(ACTIONS.FALLBACK_TO_MATCHER);
    expect(cls.delivery_path).toBeNull();
  });

  test('null lbCandidate → UNRESOLVED', () => {
    const cls = classifyAccountAware({ lbCandidate: null, categorized: cat('would_review'), accountContext: null, options: { now: NOW } });
    expect(cls.account_class).toBe(ACCOUNT_CLASSES.UNRESOLVED_NO_ACCOUNT_ID);
    expect(cls.action).toBe(ACTIONS.FALLBACK_TO_MATCHER);
  });
});

// ─── 2. would_link + sf_truth_overrides_lost → sync_apply ──────────────────
describe('sf_truth_overrides_lost routes to sync apply, not feedback', () => {
  test('account has paid jobs → AUTO_LINK + SYNC_APPLY', () => {
    const lb = lbCandidate();
    const cls = classify(lb, cat('would_link', 'sf_truth_overrides_lost'), ctx({ customerId: 22949, paidJobsCount: 1 }));
    expect(cls.account_class).toBe(ACCOUNT_CLASSES.EXISTING_CUSTOMER_NO_PIN);
    expect(cls.action).toBe(ACTIONS.AUTO_LINK);
    expect(cls.delivery_path).toBe(DELIVERY_PATHS.SYNC_APPLY);
    expect(cls.delivery_path).not.toBe(DELIVERY_PATHS.FEEDBACK);
  });

  test('account has no paid jobs → needs_review (uncertain, surfaces for operator)', () => {
    const lb = lbCandidate();
    const cls = classify(lb, cat('would_link', 'sf_truth_overrides_lost'), ctx({ paidJobsCount: 0 }));
    expect(cls.action).toBe(ACTIONS.NEEDS_REVIEW);
    expect(cls.delivery_path).toBe(DELIVERY_PATHS.FEEDBACK);
  });

  test('would_link with no specific reason → SAME_INQUIRY + AUTO_LINK', () => {
    const lb = lbCandidate();
    const cls = classify(lb, cat('would_link', null), ctx({ paidJobsCount: 1 }));
    expect(cls.account_class).toBe(ACCOUNT_CLASSES.SAME_INQUIRY);
    expect(cls.action).toBe(ACTIONS.AUTO_LINK);
    expect(cls.delivery_path).toBe(DELIVERY_PATHS.SYNC_APPLY);
  });
});

// ─── 3. already_reconciled_customer ────────────────────────────────────────
describe('already_reconciled_customer', () => {
  test('stale + not engaged → REPEAT_INQUIRY_SAME_ACCOUNT (LB_TERMINAL_SKIPPED, not no_match)', () => {
    const lb = lbCandidate({ createdAt: new Date('2025-03-01T00:00:00Z') });
    const cls = classify(lb, cat('would_skip', 'already_reconciled_customer'), ctx({ paidJobsCount: 3 }));
    expect(cls.account_class).toBe(ACCOUNT_CLASSES.EXISTING_CUSTOMER_PINNED);
    expect(cls.action).toBe(ACTIONS.REPEAT_INQUIRY_SAME_ACCOUNT);
    expect(cls.delivery_path).toBe(DELIVERY_PATHS.LB_TERMINAL_SKIPPED);
    expect(cls.lb_terminal_reason).toBe('repeat_inquiry_same_account');
  });

  test('paid customer + recent + engaged → needs_review (ACTIVE_ACCOUNT_REENGAGEMENT)', () => {
    const lb = lbCandidate({ createdAt: new Date('2026-04-01T00:00:00Z') });   // 66 days before NOW
    const cls = classify(lb, cat('would_skip', 'already_reconciled_customer'), ctx({ paidJobsCount: 1, customerEngagedOnThread: true }));
    expect(cls.account_class).toBe(ACCOUNT_CLASSES.ACTIVE_ACCOUNT_REENGAGEMENT);
    expect(cls.action).toBe(ACTIONS.NEEDS_REVIEW);
    expect(cls.delivery_path).toBe(DELIVERY_PATHS.FEEDBACK);
  });

  test('recent but no engagement → REPEAT_INQUIRY_SAME_ACCOUNT', () => {
    const lb = lbCandidate({ createdAt: new Date('2026-05-01T00:00:00Z') });
    const cls = classify(lb, cat('would_skip', 'already_reconciled_customer'), ctx({ paidJobsCount: 1, customerEngagedOnThread: false }));
    expect(cls.action).toBe(ACTIONS.REPEAT_INQUIRY_SAME_ACCOUNT);
  });

  test('engaged but stale → REPEAT_INQUIRY_SAME_ACCOUNT', () => {
    const lb = lbCandidate({ createdAt: new Date('2024-12-01T00:00:00Z') });
    const cls = classify(lb, cat('would_skip', 'already_reconciled_customer'), ctx({ paidJobsCount: 1, customerEngagedOnThread: true }));
    expect(cls.action).toBe(ACTIONS.REPEAT_INQUIRY_SAME_ACCOUNT);
  });
});

// ─── 4. cross_inquiry_or_non_lb_sf_lead ────────────────────────────────────
describe('cross_inquiry_or_non_lb_sf_lead', () => {
  test('marketplace duplicate sibling → MARKETPLACE_DUPLICATE (LB_TERMINAL_SKIPPED, not no_match)', () => {
    const lb = lbCandidate({ createdAt: new Date('2025-09-04T20:02:49Z') });
    const cls = classify(lb, cat('would_review', 'cross_inquiry_or_non_lb_sf_lead'), ctx({ marketplaceDuplicateSibling: true, anySiblingLbCount: 1 }));
    expect(cls.account_class).toBe(ACCOUNT_CLASSES.MARKETPLACE_DUPLICATE);
    expect(cls.action).toBe(ACTIONS.MARKETPLACE_DUPLICATE);
    expect(cls.delivery_path).toBe(DELIVERY_PATHS.LB_TERMINAL_SKIPPED);
    expect(cls.lb_terminal_reason).toBe('marketplace_duplicate');
  });

  test('linked sibling, no customer → REPEAT_INQUIRY_SAME_ACCOUNT (LB_TERMINAL_SKIPPED)', () => {
    const lb = lbCandidate({ createdAt: new Date('2025-01-28T00:00:00Z') });   // stale
    const cls = classify(lb, cat('would_review', 'cross_inquiry_or_non_lb_sf_lead'), ctx({ linkedSiblingLbCount: 1, paidJobsCount: 0 }));
    expect(cls.account_class).toBe(ACCOUNT_CLASSES.SAME_ACCOUNT_SIBLING_LINKED);
    expect(cls.action).toBe(ACTIONS.REPEAT_INQUIRY_SAME_ACCOUNT);
    expect(cls.delivery_path).toBe(DELIVERY_PATHS.LB_TERMINAL_SKIPPED);
  });

  test('paid customer + recent + engaged → needs_review', () => {
    const lb = lbCandidate({ createdAt: new Date('2026-04-01T00:00:00Z') });
    const cls = classify(lb, cat('would_review', 'cross_inquiry_or_non_lb_sf_lead'), ctx({ paidJobsCount: 1, customerEngagedOnThread: true }));
    expect(cls.account_class).toBe(ACCOUNT_CLASSES.ACTIVE_ACCOUNT_REENGAGEMENT);
    expect(cls.action).toBe(ACTIONS.NEEDS_REVIEW);
  });

  test('SF orphan (no customer, no sibling, only SF lead) → needs_review (SF_LEAD_ORPHAN)', () => {
    const lb = lbCandidate({ createdAt: new Date('2026-03-02T00:00:00Z') });
    const cls = classify(lb, cat('would_review', 'cross_inquiry_or_non_lb_sf_lead'), ctx({ sfLeadIdsInAccount: ['lead-1'], linkedSiblingLbCount: 0, paidJobsCount: 0 }));
    expect(cls.account_class).toBe(ACCOUNT_CLASSES.SF_LEAD_ORPHAN);
    expect(cls.action).toBe(ACTIONS.NEEDS_REVIEW);
  });

  test('paid customer + stale → REPEAT_INQUIRY_SAME_ACCOUNT (EXISTING_CUSTOMER_PINNED)', () => {
    const lb = lbCandidate({ createdAt: new Date('2025-01-01T00:00:00Z') });
    const cls = classify(lb, cat('would_review', 'cross_inquiry_or_non_lb_sf_lead'), ctx({ paidJobsCount: 13, customerEngagedOnThread: true }));
    expect(cls.action).toBe(ACTIONS.REPEAT_INQUIRY_SAME_ACCOUNT);
  });
});

// ─── 5. Stale no-revenue account with linked sibling → REPEAT_INQUIRY ──────
describe('stale no-revenue account → REPEAT_INQUIRY_SAME_ACCOUNT (not no_match)', () => {
  test('cross_inquiry, no customer, linked sibling, ≥6 months old', () => {
    const lb = lbCandidate({ createdAt: new Date('2024-12-30T00:00:00Z') });
    const cls = classify(lb, cat('would_review', 'cross_inquiry_or_non_lb_sf_lead'), ctx({ linkedSiblingLbCount: 1, paidJobsCount: 0 }));
    expect(cls.action).toBe(ACTIONS.REPEAT_INQUIRY_SAME_ACCOUNT);
    expect(cls.delivery_path).toBe(DELIVERY_PATHS.LB_TERMINAL_SKIPPED);
    // The known-account-non-primary-inquiry contract: NEVER no_match
    expect(cls.action).not.toBe(ACTIONS.NO_MATCH);
  });

  test('cross_inquiry + zero siblings + zero customer + no SF lead → needs_review (SF_LEAD_ORPHAN)', () => {
    const lb = lbCandidate({ createdAt: new Date('2025-08-15T00:00:00Z') });
    const cls = classify(lb, cat('would_review', 'cross_inquiry_or_non_lb_sf_lead'), ctx({ linkedSiblingLbCount: 0, paidJobsCount: 0, sfLeadIdsInAccount: [] }));
    expect(cls.action).toBe(ACTIONS.NEEDS_REVIEW);
  });
});

// ─── 6. Customer with multiple LB leads — same account ─────────────────────
describe('customer with multiple LB leads resolves through same account', () => {
  test('two LB candidates with same accountId both classify against same Account context', () => {
    const sharedAccountId = '6e349e13-f167-446e-8932-699eaad8354d';
    const ctx1 = ctx({ customerId: 22949, paidJobsCount: 1, anySiblingLbCount: 1 });
    const lb1 = lbCandidate({ leadId: 'lb-A', accountId: sharedAccountId, createdAt: new Date('2025-07-09T00:00:00Z') });
    const lb2 = lbCandidate({ leadId: 'lb-B', accountId: sharedAccountId, createdAt: new Date('2026-03-30T00:00:00Z') });

    const r1 = classify(lb1, cat('would_link', 'sf_truth_overrides_lost'), ctx1);
    const r2 = classify(lb2, cat('would_skip', 'already_reconciled_customer'), ctx1);

    expect(r1.account_class).toBe(ACCOUNT_CLASSES.EXISTING_CUSTOMER_NO_PIN);
    expect(r1.action).toBe(ACTIONS.AUTO_LINK);
    // lb2 is recent (~67d) but customerEngagedOnThread is false by default
    // → repeat_inquiry_same_account (LB-safe terminal, not no_match)
    expect(r2.action).toBe(ACTIONS.REPEAT_INQUIRY_SAME_ACCOUNT);
    expect(r2.delivery_path).toBe(DELIVERY_PATHS.LB_TERMINAL_SKIPPED);

    // If lb2 also engaged → becomes reengagement
    const ctx2 = { ...ctx1, customerEngagedOnThread: true };
    const r2b = classify(lb2, cat('would_skip', 'already_reconciled_customer'), ctx2);
    expect(r2b.account_class).toBe(ACCOUNT_CLASSES.ACTIVE_ACCOUNT_REENGAGEMENT);
    expect(r2b.action).toBe(ACTIONS.NEEDS_REVIEW);
  });
});

// ─── 7. Duplicate-phone conflict accounts are NOT merged ───────────────────
describe('duplicate phone conflict accounts are not merged', () => {
  test('two LB leads on two different Accounts that share a phone classify independently', () => {
    // Account A has paying customer; Account B is fresh
    const lbAcctA = lbCandidate({ leadId: 'lb-X', accountId: 'acct-A', createdAt: new Date('2025-08-15T00:00:00Z') });
    const lbAcctB = lbCandidate({ leadId: 'lb-Y', accountId: 'acct-B', createdAt: new Date('2026-04-10T00:00:00Z') });

    const ctxA = ctx({ customerId: 99, paidJobsCount: 5, linkedSiblingLbCount: 1 });
    const ctxB = ctx({ customerId: null, paidJobsCount: 0, linkedSiblingLbCount: 0, sfLeadIdsInAccount: ['lead-Y'] });

    const rA = classify(lbAcctA, cat('would_review', 'cross_inquiry_or_non_lb_sf_lead'), ctxA);
    const rB = classify(lbAcctB, cat('would_review', 'cross_inquiry_or_non_lb_sf_lead'), ctxB);

    // Same phone conflict is invisible to the classifier (which only sees
    // per-Account context). Both rows get their own decision.
    expect(rA.action).toBe(ACTIONS.REPEAT_INQUIRY_SAME_ACCOUNT);
    expect(rB.action).toBe(ACTIONS.NEEDS_REVIEW);
    // No merge, no cross-talk.
  });
});

// ─── 8. Out-of-scope buckets fall through to existing matcher ──────────────
describe('out-of-scope categorize results fall through', () => {
  test.each([
    ['lead_only_match', null],
    ['would_skip', 'no_match'],
    ['would_skip', 'low_confidence'],
    ['would_skip', 'multiple_candidates'],
    ['would_skip', 'customer_match_no_job'],
    ['would_skip', 'lb_already_pinned_to_different_job'],
    ['would_skip', 'sf_job_linked_to_different_lb_lead'],
    ['matcher_error', 'matcher_error'],
    ['already_linked', null],
  ])('bucket=%s reason=%s → OUT_OF_SCOPE + FALLBACK_TO_MATCHER', (bucket, reason) => {
    const lb = lbCandidate();
    const cls = classify(lb, cat(bucket, reason), ctx({ paidJobsCount: 5 }));
    expect(cls.account_class).toBe(ACCOUNT_CLASSES.OUT_OF_SCOPE);
    expect(cls.action).toBe(ACTIONS.FALLBACK_TO_MATCHER);
    expect(cls.delivery_path).toBeNull();
  });
});

// ─── 9. The 59-row fixture: 9 / 3 / 43 / 4 / 0 (new 5-bucket taxonomy) ─────
//
// Synthetic fixture that mirrors the breakdown from the unified second-pass
// analysis under the LB-safe terminal taxonomy. Pinned counts:
//   AUTO_LINK                    : 9
//   NEEDS_REVIEW                 : 3
//   REPEAT_INQUIRY_SAME_ACCOUNT  : 43
//   MARKETPLACE_DUPLICATE        : 4
//   NO_MATCH                     : 0
//   unresolved                   : 0
describe('59-row residual fixture classifies to 9 / 3 / 43 / 4 / 0', () => {
  // Builds the 59 rows. Source: unified-pass analysis.
  function build59() {
    const rows = [];

    // 7 sf_truth_overrides_lost (auto_link) — customers with paid jobs
    for (let i = 0; i < 7; i++) {
      rows.push({
        lb:   lbCandidate({ leadId: 'sf_truth_' + i, accountId: 'acct_sftruth_' + i, createdAt: new Date('2025-05-01T00:00:00Z') }),
        cat:  cat('would_link', 'sf_truth_overrides_lost'),
        ctx:  ctx({ customerId: 1000 + i, paidJobsCount: 1 + (i % 3) }),
      });
    }
    // 2 ordinary would_link (auto_link)
    for (let i = 0; i < 2; i++) {
      rows.push({
        lb:   lbCandidate({ leadId: 'would_link_' + i, accountId: 'acct_wl_' + i, createdAt: new Date('2026-03-01T00:00:00Z') }),
        cat:  cat('would_link', null),
        ctx:  ctx({ customerId: 2000 + i, paidJobsCount: 1 }),
      });
    }
    // 11 already_reconciled_customer (all auto_no_match) — stale or not engaged
    for (let i = 0; i < 11; i++) {
      rows.push({
        lb:   lbCandidate({ leadId: 'arc_' + i, accountId: 'acct_arc_' + i, createdAt: new Date('2025-05-' + String(10 + i).padStart(2, '0') + 'T00:00:00Z') }),
        cat:  cat('would_skip', 'already_reconciled_customer'),
        ctx:  ctx({ customerId: 3000 + i, paidJobsCount: 2 + (i % 4), customerEngagedOnThread: false }),
      });
    }
    // 39 cross_inquiry_or_non_lb_sf_lead: 36 auto_no_match (stale + linked sibling) + 3 needs_review (orphan)
    // (32 stale_dead with linked sibling + 4 marketplace_duplicate + 3 orphan)
    for (let i = 0; i < 32; i++) {
      rows.push({
        lb:   lbCandidate({ leadId: 'cinq_stale_' + i, accountId: 'acct_cinq_stale_' + i, createdAt: new Date('2025-01-' + String(1 + (i % 28)).padStart(2, '0') + 'T00:00:00Z') }),
        cat:  cat('would_review', 'cross_inquiry_or_non_lb_sf_lead'),
        ctx:  ctx({ linkedSiblingLbCount: 1, anySiblingLbCount: 1, paidJobsCount: 0 }),
      });
    }
    for (let i = 0; i < 4; i++) {
      rows.push({
        lb:   lbCandidate({ leadId: 'cinq_dup_' + i, accountId: 'acct_cinq_dup_' + i, createdAt: new Date('2025-09-04T20:02:49Z') }),
        cat:  cat('would_review', 'cross_inquiry_or_non_lb_sf_lead'),
        ctx:  ctx({ marketplaceDuplicateSibling: true, anySiblingLbCount: 1, paidJobsCount: 0 }),
      });
    }
    for (let i = 0; i < 3; i++) {
      rows.push({
        lb:   lbCandidate({ leadId: 'cinq_orphan_' + i, accountId: 'acct_cinq_orphan_' + i, createdAt: new Date('2026-03-02T00:00:00Z') }),
        cat:  cat('would_review', 'cross_inquiry_or_non_lb_sf_lead'),
        ctx:  ctx({ sfLeadIdsInAccount: ['sflead_' + i], linkedSiblingLbCount: 0, paidJobsCount: 0 }),
      });
    }
    return rows;
  }

  test('counts match exactly 9 / 3 / 43 / 4 / 0', () => {
    const rows = build59();
    expect(rows.length).toBe(59);

    const tally = {
      auto_link:                   0,
      needs_review:                0,
      repeat_inquiry_same_account: 0,
      marketplace_duplicate:       0,
      no_match:                    0,
      unresolved:                  0,
      fallback:                    0,
    };
    for (const r of rows) {
      const cls = classify(r.lb, r.cat, r.ctx);
      if (cls.action === ACTIONS.AUTO_LINK)                          tally.auto_link++;
      else if (cls.action === ACTIONS.NEEDS_REVIEW)                  tally.needs_review++;
      else if (cls.action === ACTIONS.REPEAT_INQUIRY_SAME_ACCOUNT)   tally.repeat_inquiry_same_account++;
      else if (cls.action === ACTIONS.MARKETPLACE_DUPLICATE)         tally.marketplace_duplicate++;
      else if (cls.action === ACTIONS.NO_MATCH)                      tally.no_match++;
      else if (cls.action === ACTIONS.FALLBACK_TO_MATCHER) {
        if (cls.account_class === ACCOUNT_CLASSES.UNRESOLVED_NO_ACCOUNT_ID) tally.unresolved++;
        else tally.fallback++;
      }
    }

    expect(tally.auto_link).toBe(9);
    expect(tally.needs_review).toBe(3);
    expect(tally.repeat_inquiry_same_account).toBe(43);
    expect(tally.marketplace_duplicate).toBe(4);
    expect(tally.no_match).toBe(0);
    expect(tally.unresolved).toBe(0);
    expect(tally.fallback).toBe(0);
  });

  test('all auto_link rows route via SYNC_APPLY, never FEEDBACK', () => {
    const rows = build59();
    for (const r of rows) {
      const cls = classify(r.lb, r.cat, r.ctx);
      if (cls.action === ACTIONS.AUTO_LINK) {
        expect(cls.delivery_path).toBe(DELIVERY_PATHS.SYNC_APPLY);
        expect(cls.delivery_path).not.toBe(DELIVERY_PATHS.FEEDBACK);
      }
    }
  });

  test('all needs_review rows route via FEEDBACK', () => {
    const rows = build59();
    for (const r of rows) {
      const cls = classify(r.lb, r.cat, r.ctx);
      if (cls.action === ACTIONS.NEEDS_REVIEW) {
        expect(cls.delivery_path).toBe(DELIVERY_PATHS.FEEDBACK);
      }
    }
  });

  test('all repeat_inquiry_same_account + marketplace_duplicate rows route via LB_TERMINAL_SKIPPED (never FEEDBACK/no_match)', () => {
    const rows = build59();
    for (const r of rows) {
      const cls = classify(r.lb, r.cat, r.ctx);
      if (cls.action === ACTIONS.REPEAT_INQUIRY_SAME_ACCOUNT || cls.action === ACTIONS.MARKETPLACE_DUPLICATE) {
        expect(cls.delivery_path).toBe(DELIVERY_PATHS.LB_TERMINAL_SKIPPED);
        // critical: known-Account non-primary inquiries are NEVER no_match
        expect(cls.action).not.toBe(ACTIONS.NO_MATCH);
      }
    }
  });

  test('lb_terminal_reason is populated for LB_TERMINAL_SKIPPED rows', () => {
    const rows = build59();
    for (const r of rows) {
      const cls = classify(r.lb, r.cat, r.ctx);
      if (cls.delivery_path === DELIVERY_PATHS.LB_TERMINAL_SKIPPED) {
        expect(cls.lb_terminal_reason).toBeTruthy();
        expect(['repeat_inquiry_same_account', 'marketplace_duplicate']).toContain(cls.lb_terminal_reason);
      }
    }
  });
});

// ─── 10. Recency threshold respects options.recentDaysThreshold ────────────
describe('recency threshold is configurable', () => {
  test('default 90d: 89d-old + engaged + paid → reengagement', () => {
    const lb = lbCandidate({ createdAt: new Date('2026-03-10T00:00:00Z') });   // 88 days before NOW
    const cls = classify(lb, cat('would_skip', 'already_reconciled_customer'), ctx({ paidJobsCount: 1, customerEngagedOnThread: true }));
    expect(cls.action).toBe(ACTIONS.NEEDS_REVIEW);
  });

  test('default 90d: 91d-old + engaged + paid → REPEAT_INQUIRY_SAME_ACCOUNT (not no_match)', () => {
    const lb = lbCandidate({ createdAt: new Date('2026-03-07T00:00:00Z') });   // 91d before NOW
    const cls = classify(lb, cat('would_skip', 'already_reconciled_customer'), ctx({ paidJobsCount: 1, customerEngagedOnThread: true }));
    expect(cls.action).toBe(ACTIONS.REPEAT_INQUIRY_SAME_ACCOUNT);
    expect(cls.action).not.toBe(ACTIONS.NO_MATCH);
  });

  test('threshold=120d: 100d-old + engaged + paid → reengagement', () => {
    const lb = lbCandidate({ createdAt: new Date('2026-02-26T00:00:00Z') });   // 100d before NOW
    const cls = classify(lb, cat('would_skip', 'already_reconciled_customer'), ctx({ paidJobsCount: 1, customerEngagedOnThread: true }), { recentDaysThreshold: 120 });
    expect(cls.action).toBe(ACTIONS.NEEDS_REVIEW);
  });
});

// ─── 11. Safety surface: no SYNC_APPLY path for already_reconciled_customer ─
describe('safety: already_reconciled_customer NEVER routes to SYNC_APPLY', () => {
  test('all combinations of recency + engagement + paid_jobs', () => {
    const inputs = [
      { paidJobsCount: 0, customerEngagedOnThread: false, days: 5 },
      { paidJobsCount: 0, customerEngagedOnThread: true,  days: 5 },
      { paidJobsCount: 1, customerEngagedOnThread: false, days: 5 },
      { paidJobsCount: 1, customerEngagedOnThread: true,  days: 5 },
      { paidJobsCount: 5, customerEngagedOnThread: true,  days: 365 },
      { paidJobsCount: 0, customerEngagedOnThread: false, days: 365 },
    ];
    for (const inp of inputs) {
      const lb = lbCandidate({ createdAt: new Date(NOW.getTime() - inp.days * 86400000) });
      const cls = classify(lb, cat('would_skip', 'already_reconciled_customer'), ctx({ paidJobsCount: inp.paidJobsCount, customerEngagedOnThread: inp.customerEngagedOnThread }));
      expect(cls.delivery_path).not.toBe(DELIVERY_PATHS.SYNC_APPLY);
    }
  });
});

// ─── 13. Safety surface: known-Account residuals NEVER route to NO_MATCH ───
describe('safety: known-Account residuals NEVER classify as NO_MATCH', () => {
  test('already_reconciled_customer never returns NO_MATCH (any signal combo)', () => {
    const combos = [
      ctx({ paidJobsCount: 0 }),
      ctx({ paidJobsCount: 1 }),
      ctx({ paidJobsCount: 1, customerEngagedOnThread: true }),
      ctx({ paidJobsCount: 5, customerEngagedOnThread: true }),
    ];
    for (const a of combos) {
      const lb = lbCandidate({ createdAt: new Date('2025-06-01T00:00:00Z') });
      const cls = classify(lb, cat('would_skip', 'already_reconciled_customer'), a);
      expect(cls.action).not.toBe(ACTIONS.NO_MATCH);
    }
  });

  test('cross_inquiry with any Account anchor never returns NO_MATCH', () => {
    const combos = [
      ctx({ linkedSiblingLbCount: 1 }),
      ctx({ paidJobsCount: 1 }),
      ctx({ paidJobsCount: 1, customerEngagedOnThread: true }),
      ctx({ marketplaceDuplicateSibling: true }),
      ctx({ sfLeadIdsInAccount: ['x'] }),
    ];
    for (const a of combos) {
      const lb = lbCandidate({ createdAt: new Date('2025-06-01T00:00:00Z') });
      const cls = classify(lb, cat('would_review', 'cross_inquiry_or_non_lb_sf_lead'), a);
      expect(cls.action).not.toBe(ACTIONS.NO_MATCH);
    }
  });

  test('marketplace_duplicate carries lb_terminal_reason="marketplace_duplicate"', () => {
    const lb = lbCandidate({ createdAt: new Date('2025-09-04T20:02:49Z') });
    const cls = classify(lb, cat('would_review', 'cross_inquiry_or_non_lb_sf_lead'), ctx({ marketplaceDuplicateSibling: true }));
    expect(cls.action).toBe(ACTIONS.MARKETPLACE_DUPLICATE);
    expect(cls.delivery_path).toBe(DELIVERY_PATHS.LB_TERMINAL_SKIPPED);
    expect(cls.lb_terminal_reason).toBe('marketplace_duplicate');
  });

  test('repeat_inquiry_same_account carries lb_terminal_reason="repeat_inquiry_same_account"', () => {
    const lb = lbCandidate({ createdAt: new Date('2025-01-01T00:00:00Z') });
    const cls = classify(lb, cat('would_review', 'cross_inquiry_or_non_lb_sf_lead'), ctx({ linkedSiblingLbCount: 1 }));
    expect(cls.action).toBe(ACTIONS.REPEAT_INQUIRY_SAME_ACCOUNT);
    expect(cls.delivery_path).toBe(DELIVERY_PATHS.LB_TERMINAL_SKIPPED);
    expect(cls.lb_terminal_reason).toBe('repeat_inquiry_same_account');
  });
});

// ─── 12. Safety surface: cross_inquiry NEVER routes to SYNC_APPLY ──────────
describe('safety: cross_inquiry_or_non_lb_sf_lead NEVER routes to SYNC_APPLY', () => {
  test('any combination of signals', () => {
    const combos = [
      ctx({ marketplaceDuplicateSibling: true }),
      ctx({ linkedSiblingLbCount: 1 }),
      ctx({ paidJobsCount: 1 }),
      ctx({ paidJobsCount: 1, customerEngagedOnThread: true }),
      ctx({ sfLeadIdsInAccount: ['x'] }),
      ctx({}),
    ];
    for (const a of combos) {
      const lb = lbCandidate({ createdAt: new Date('2025-09-01T00:00:00Z') });
      const cls = classify(lb, cat('would_review', 'cross_inquiry_or_non_lb_sf_lead'), a);
      expect(cls.delivery_path).not.toBe(DELIVERY_PATHS.SYNC_APPLY);
    }
  });
});
