// Account-aware residual cleanup (PR D).
//
// READS account_id (populated by PR C apply backfill) and overrides the
// existing matcher's residual-class categorization for FOUR residual
// classes only:
//
//   1. cross_inquiry_or_non_lb_sf_lead     (would_review / Step 4)
//   2. already_reconciled_customer         (would_skip / tiered-picker)
//   3. sf_truth_overrides_lost             (would_link / SF-connected rule)
//   4. would_link rows with exact ext_req  (would_link / skip_use_apply_path)
//
// Every other categorize() output is OUT OF SCOPE — the existing matcher's
// behavior is preserved exactly. The classifier `out_of_scope` return is
// the explicit signal for "fall back to existing matcher".
//
// Hard safety guarantees:
//   - This module does NOT call attachLbLink.
//   - It does NOT write Lead.status / sfJobOutcome.
//   - It does NOT mutate jobs / customers / leads via this code path.
//   - The classifier is PURE (no I/O). The single I/O surface is
//     `getAccountContextForLb`, which reads from public.accounts +
//     public.customers + public.jobs + public.leads + LB Lead.
//
// Delivery routing:
//   auto_link      → existing runHistoricalSyncApply (SF + LB writes)
//   auto_no_match  → existing runHistoricalFeedbackApply (LB-only)
//   needs_review   → existing runHistoricalFeedbackApply (LB-only)
//
// Dry-run is read-only and always safe.

'use strict';

const {
  fetchCandidates,
} = require('./lb-historical-sync-client');
const {
  resolveLbUserId,
  resolveSyncStatuses,
  categorizeByMatchType,
  lbLeadToMatcherInput,
  SCOPE_PENDING_ONLY,
  VALID_SYNC_SCOPES,
  MAX_LEADS_DEFAULT,
  MAX_LEADS_HARD_CAP,
} = require('./sf-historical-sync-orchestrator');
const { findHistoricalMatchType } = require('./lb-lead-link-matcher');

// ─── Account-aware classes the classifier may emit ─────────────────────────
const ACCOUNT_CLASSES = Object.freeze({
  // auto_link
  SAME_INQUIRY:                       'same_inquiry',
  EXISTING_CUSTOMER_NO_PIN:           'existing_customer_no_pin',          // sf_truth_overrides_lost-like
  // auto_no_match
  EXISTING_CUSTOMER_PINNED:           'existing_customer_pinned',          // already_reconciled_customer family
  SAME_ACCOUNT_SIBLING_LINKED:        'same_account_sibling_linked',       // cross_inquiry where sibling is already linked
  MARKETPLACE_DUPLICATE:              'marketplace_duplicate',             // sibling within ±5 min
  // needs_review
  ACTIVE_ACCOUNT_REENGAGEMENT:        'active_account_reengagement',       // recent + engaged + active SF pipeline / paid customer
  SF_LEAD_ORPHAN:                     'sf_lead_orphan',                    // SF lead exists, no LB sibling, no customer
  SAME_ACCOUNT_NEW_INQUIRY_UNCERTAIN: 'same_account_new_inquiry_uncertain',
  // unresolved
  UNRESOLVED_NO_ACCOUNT_ID:           'unresolved_no_account_id',
  // fallback
  OUT_OF_SCOPE:                       'out_of_scope',
});

const ACTIONS = Object.freeze({
  AUTO_LINK:            'auto_link',
  AUTO_NO_MATCH:        'auto_no_match',
  NEEDS_REVIEW:         'needs_review',
  FALLBACK_TO_MATCHER:  'fallback_to_matcher',
});

const DELIVERY_PATHS = Object.freeze({
  SYNC_APPLY:    'sync_apply',
  FEEDBACK:      'feedback',
  NONE:          null,
});

const RECENT_DAYS_DEFAULT = 90;
const DUPLICATE_WINDOW_SECONDS = 300;     // ±5 minutes for "marketplace duplicate"

// ─── Pure classifier ───────────────────────────────────────────────────────
//
// Input contract:
//
//   lbCandidate          — LB candidate row (camelCase, from fetchCandidates).
//                          MUST include accountId; classifier returns
//                          UNRESOLVED_NO_ACCOUNT_ID otherwise.
//   categorized          — categorizeByMatchType() return value for this row
//                          (so the existing matcher's decision is the
//                          baseline; we override only the 4 residual classes).
//   accountContext       — return value from getAccountContextForLb().
//   options              — { recentDaysThreshold = 90, now = new Date() }
//
// Output:
//
//   {
//     account_class:   one of ACCOUNT_CLASSES,
//     action:          one of ACTIONS,
//     delivery_path:   one of DELIVERY_PATHS,
//     reason:          short human-readable explanation,
//   }
//
// Hard rule: this function is pure. No I/O. Reproducible from inputs alone.
function classifyAccountAware({ lbCandidate, categorized, accountContext, options }) {
  const opts = options || {};
  const recentDaysThreshold = Number.isFinite(opts.recentDaysThreshold)
    ? opts.recentDaysThreshold
    : RECENT_DAYS_DEFAULT;
  const now = opts.now instanceof Date ? opts.now : new Date();

  if (!lbCandidate) {
    return {
      account_class: ACCOUNT_CLASSES.UNRESOLVED_NO_ACCOUNT_ID,
      action:        ACTIONS.FALLBACK_TO_MATCHER,
      delivery_path: DELIVERY_PATHS.NONE,
      reason:        'no lbCandidate',
    };
  }
  if (!lbCandidate.accountId) {
    return {
      account_class: ACCOUNT_CLASSES.UNRESOLVED_NO_ACCOUNT_ID,
      action:        ACTIONS.FALLBACK_TO_MATCHER,
      delivery_path: DELIVERY_PATHS.NONE,
      reason:        'LB lead has no account_id — falling back to existing matcher',
    };
  }

  // Per spec: only override these 4 residual classes. Everything else stays
  // with the existing matcher.
  const bucket = categorized && categorized.bucket;
  const reason = categorized && categorized.reason;

  // ── (1) would_link rows ────────────────────────────────────────────────
  if (bucket === 'would_link') {
    // sf_truth_overrides_lost: SF customer is the authoritative truth.
    // If the account has a paying customer, this row links via sync apply.
    if (reason === 'sf_truth_overrides_lost') {
      if (accountContext && accountContext.paidJobsCount > 0) {
        return {
          account_class: ACCOUNT_CLASSES.EXISTING_CUSTOMER_NO_PIN,
          action:        ACTIONS.AUTO_LINK,
          delivery_path: DELIVERY_PATHS.SYNC_APPLY,
          reason:        'Account has ' + accountContext.paidJobsCount +
                         ' paid completed job(s) and no LB pin yet — link via sync apply',
        };
      }
      // sf_truth_overrides_lost without paid jobs is unusual; surface for review.
      return {
        account_class: ACCOUNT_CLASSES.SAME_ACCOUNT_NEW_INQUIRY_UNCERTAIN,
        action:        ACTIONS.NEEDS_REVIEW,
        delivery_path: DELIVERY_PATHS.FEEDBACK,
        reason:        'sf_truth_overrides_lost but Account has no paid completed jobs',
      };
    }

    // would_link with no specific reason — the matcher would have routed via
    // sync apply already; treat as same_inquiry candidate.
    return {
      account_class: ACCOUNT_CLASSES.SAME_INQUIRY,
      action:        ACTIONS.AUTO_LINK,
      delivery_path: DELIVERY_PATHS.SYNC_APPLY,
      reason:        'would_link routed via sync apply path',
    };
  }

  // ── (2) already_reconciled_customer ───────────────────────────────────
  if (reason === 'already_reconciled_customer') {
    const ageDays = lbAgeDays(lbCandidate, now);
    const customerEngaged = !!(accountContext && accountContext.customerEngagedOnThread);
    const isRecent = ageDays != null && ageDays <= recentDaysThreshold;
    const acctHasPaid = accountContext && accountContext.paidJobsCount > 0;

    if (isRecent && customerEngaged && acctHasPaid) {
      return {
        account_class: ACCOUNT_CLASSES.ACTIVE_ACCOUNT_REENGAGEMENT,
        action:        ACTIONS.NEEDS_REVIEW,
        delivery_path: DELIVERY_PATHS.FEEDBACK,
        reason:        'Existing paid customer with recent (' + Math.round(ageDays) +
                       'd) engaged inquiry — possible recurring-service opportunity',
      };
    }
    return {
      account_class: ACCOUNT_CLASSES.EXISTING_CUSTOMER_PINNED,
      action:        ACTIONS.AUTO_NO_MATCH,
      delivery_path: DELIVERY_PATHS.FEEDBACK,
      reason:        'Reconciled customer; sibling LB lead holds the pin and this row is stale or not engaged',
    };
  }

  // ── (3) cross_inquiry_or_non_lb_sf_lead ───────────────────────────────
  if (reason === 'cross_inquiry_or_non_lb_sf_lead') {
    const ageDays = lbAgeDays(lbCandidate, now);
    const customerEngaged = !!(accountContext && accountContext.customerEngagedOnThread);
    const isRecent = ageDays != null && ageDays <= recentDaysThreshold;
    const siblingLinked = accountContext && accountContext.linkedSiblingLbCount > 0;
    const siblingMarketplaceDup = accountContext && accountContext.marketplaceDuplicateSibling;
    const acctHasPaid = accountContext && accountContext.paidJobsCount > 0;

    if (siblingMarketplaceDup) {
      return {
        account_class: ACCOUNT_CLASSES.MARKETPLACE_DUPLICATE,
        action:        ACTIONS.AUTO_NO_MATCH,
        delivery_path: DELIVERY_PATHS.FEEDBACK,
        reason:        'sibling LB lead created within ' + DUPLICATE_WINDOW_SECONDS + 's — platform duplicate',
      };
    }
    if (acctHasPaid) {
      // Recent + engaged paid-customer cross-inquiry → reengagement
      if (isRecent && customerEngaged) {
        return {
          account_class: ACCOUNT_CLASSES.ACTIVE_ACCOUNT_REENGAGEMENT,
          action:        ACTIONS.NEEDS_REVIEW,
          delivery_path: DELIVERY_PATHS.FEEDBACK,
          reason:        'Paid customer with recent (' + Math.round(ageDays) + 'd) engaged inquiry',
        };
      }
      return {
        account_class: ACCOUNT_CLASSES.EXISTING_CUSTOMER_PINNED,
        action:        ACTIONS.AUTO_NO_MATCH,
        delivery_path: DELIVERY_PATHS.FEEDBACK,
        reason:        'Account has paid customer; this LB row is a stale or non-engaged repeat inquiry',
      };
    }
    if (siblingLinked) {
      return {
        account_class: ACCOUNT_CLASSES.SAME_ACCOUNT_SIBLING_LINKED,
        action:        ACTIONS.AUTO_NO_MATCH,
        delivery_path: DELIVERY_PATHS.FEEDBACK,
        reason:        'sibling LB lead already linked to SF; this row is the un-linked twin',
      };
    }
    // No paid customer, no linked sibling — surface for operator.
    return {
      account_class: ACCOUNT_CLASSES.SF_LEAD_ORPHAN,
      action:        ACTIONS.NEEDS_REVIEW,
      delivery_path: DELIVERY_PATHS.FEEDBACK,
      reason:        'cross_inquiry with no linked sibling and no paid customer — operator review',
    };
  }

  // Not a residual class. Fall back to the existing matcher (no override).
  return {
    account_class: ACCOUNT_CLASSES.OUT_OF_SCOPE,
    action:        ACTIONS.FALLBACK_TO_MATCHER,
    delivery_path: DELIVERY_PATHS.NONE,
    reason:        'categorize bucket=' + bucket + ' reason=' + reason + ' — out of PR D scope',
  };
}

function lbAgeDays(lbCandidate, now) {
  const created = lbCandidate.createdAt || lbCandidate.created_at || null;
  if (!created) return null;
  const t = new Date(created);
  if (isNaN(+t)) return null;
  return (now - t) / 86400000;
}

// ─── Account context fetcher ───────────────────────────────────────────────
//
// Reads from SF Supabase + LB Prisma. NO writes. Returns the inputs the
// classifier needs.
//
// Args:
//   supabase                   — SF Supabase client (service-role recommended)
//   args.accountId             — UUID string (lb_lead.accountId)
//   args.tenantId              — int, for tenant scope
//   args.lbLeadId              — string (this row's LB lead id)
//   args.lbPrisma              — LB PrismaClient (for sibling lookup + thread msgs)
//   args.lbLeadCreatedAt       — Date | string (for marketplace-duplicate check)
//   args.now                   — optional Date for tests
//
// Returns:
//   {
//     accountId, customerId, paidJobsCount, totalJobsCount,
//     sfLeadIdsInAccount, sfLeadInActiveStage,
//     linkedSiblingLbCount, anySiblingLbCount,
//     marketplaceDuplicateSibling, customerEngagedOnThread,
//   }
async function getAccountContextForLb(supabase, args) {
  const { accountId, tenantId, lbLeadId, lbPrisma, lbLeadCreatedAt } = args || {};
  if (!accountId) {
    return {
      accountId: null, customerId: null,
      paidJobsCount: 0, totalJobsCount: 0,
      sfLeadIdsInAccount: [], sfLeadInActiveStage: false,
      linkedSiblingLbCount: 0, anySiblingLbCount: 0,
      marketplaceDuplicateSibling: false, customerEngagedOnThread: false,
    };
  }

  // SF customer (1:1)
  let customer = null;
  let paidJobsCount = 0, totalJobsCount = 0;
  {
    const { data } = await supabase
      .from('customers')
      .select('id, account_id')
      .eq('account_id', accountId)
      .eq('user_id', tenantId)
      .maybeSingle();
    if (data) customer = data;
  }
  if (customer) {
    const { data: jobs } = await supabase
      .from('jobs')
      .select('id, status, payment_status')
      .eq('customer_id', customer.id);
    totalJobsCount = (jobs || []).length;
    paidJobsCount  = (jobs || []).filter(j => j.status === 'completed' && j.payment_status === 'paid').length;
  }

  // SF leads in the account
  let sfLeadIdsInAccount = [];
  let sfLeadInActiveStage = false;
  {
    const { data } = await supabase
      .from('leads')
      .select('id, stage_id')
      .eq('account_id', accountId)
      .eq('user_id', tenantId);
    sfLeadIdsInAccount = (data || []).map(d => d.id);
    if (sfLeadIdsInAccount.length > 0) {
      // Active stage = anything other than 'Lost' / 'Won' (rough heuristic;
      // exact stage table lookup is overkill for this scope).
      const stageIds = (data || []).map(d => d.stage_id).filter(Boolean);
      if (stageIds.length > 0) {
        const { data: stages } = await supabase
          .from('lead_stages')
          .select('id, name')
          .in('id', stageIds);
        sfLeadInActiveStage = (stages || []).some(s => {
          const name = String(s.name || '').toLowerCase();
          return name && name !== 'lost' && name !== 'won' && name !== 'closed';
        });
      }
    }
  }

  // LB siblings — count linked, and check ±5 min for marketplace duplicate
  let linkedSiblingLbCount = 0;
  let anySiblingLbCount    = 0;
  let marketplaceDuplicateSibling = false;
  if (lbPrisma) {
    const siblings = await lbPrisma.lead.findMany({
      where: { accountId, NOT: { id: lbLeadId || '' } },
      select: { id: true, syncStatus: true, createdAt: true, businessId: true },
    });
    anySiblingLbCount = siblings.length;
    linkedSiblingLbCount = siblings.filter(s => s.syncStatus === 'linked' || s.syncStatus === 'lead_linked').length;
    if (lbLeadCreatedAt) {
      const thisT = new Date(lbLeadCreatedAt).getTime();
      marketplaceDuplicateSibling = siblings.some(s => {
        if (!s.createdAt) return false;
        const dt = Math.abs(thisT - new Date(s.createdAt).getTime()) / 1000;
        return dt < DUPLICATE_WINDOW_SECONDS;
      });
    }
  }

  // Customer-engaged-on-thread is a Prisma message lookup; expensive to
  // compute for every row. For the dry-run report we lazy-compute via an
  // optional caller-supplied flag, or default false.
  const customerEngagedOnThread = !!(args.customerEngagedOnThread === true);

  return {
    accountId,
    customerId:               customer && customer.id,
    paidJobsCount,
    totalJobsCount,
    sfLeadIdsInAccount,
    sfLeadInActiveStage,
    linkedSiblingLbCount,
    anySiblingLbCount,
    marketplaceDuplicateSibling,
    customerEngagedOnThread,
  };
}

// ─── Dry-run runner ────────────────────────────────────────────────────────
//
// Fetches LB pending candidates, runs them through the existing matcher,
// then applies account-aware overrides for the 4 residual classes. Returns
// a structured report. Always read-only.
//
// PR D ships ONLY the dry-run path. Apply is a separate, gated next step.
async function runAccountAwareResidualCleanupDryRun(supabase, args) {
  if (!supabase || typeof supabase.from !== 'function') {
    throw new Error('runAccountAwareResidualCleanupDryRun: supabase required');
  }
  if (!args || args.tenantId == null) {
    return { ok: false, status: 400, error: 'invalid_arguments', detail: 'tenantId required' };
  }
  const tenantId = Number(args.tenantId);
  const limit    = Math.min(
    Number.isFinite(args.maxLeads) ? args.maxLeads : MAX_LEADS_DEFAULT,
    MAX_LEADS_HARD_CAP,
  );
  const syncScope    = VALID_SYNC_SCOPES.includes(args.syncScope) ? args.syncScope : SCOPE_PENDING_ONLY;
  const syncStatuses = resolveSyncStatuses({ syncStatuses: args.syncStatuses, syncScope });
  const logger = args.logger || { log() {}, warn() {}, error() {} };
  const lbPrisma = args.lbPrisma || null;
  const now      = args.now instanceof Date ? args.now : new Date();
  const recentDaysThreshold = Number.isFinite(args.recentDaysThreshold)
    ? args.recentDaysThreshold
    : RECENT_DAYS_DEFAULT;

  const lookup = await resolveLbUserId(supabase, tenantId);
  if (!lookup.ok) {
    return { ok: false, status: lookup.status, error: lookup.error, detail: lookup.detail || null };
  }
  const lbUserId = lookup.lbUserId;

  const page = await fetchCandidates({
    lbUserId, syncStatuses, status: args.status, limit,
    httpClient: args.httpClient, now: args.now,
  });
  if (!page.ok) {
    return { ok: false, status: page.status || 502, error: page.reason || 'lb_fetch_failed', detail: page.error_description || null };
  }

  const candidates = Array.isArray(page.candidates) ? page.candidates : [];
  const classified = [];
  const tally = {
    auto_link:           { sync_apply: 0 },
    auto_no_match:       { feedback:   0 },
    needs_review:        { feedback:   0 },
    fallback_to_matcher: { none:       0 },
  };

  for (const lbCandidate of candidates) {
    let matchTypeResult;
    try {
      matchTypeResult = await findHistoricalMatchType(supabase, {
        userId: tenantId,
        input:  lbLeadToMatcherInput(lbCandidate),
      });
    } catch (e) {
      classified.push({
        lb_lead_id:    lbCandidate.leadId,
        account_id:    lbCandidate.accountId || null,
        bucket:        'matcher_error',
        reason:        'matcher_error',
        account_class: ACCOUNT_CLASSES.OUT_OF_SCOPE,
        action:        ACTIONS.FALLBACK_TO_MATCHER,
        delivery_path: DELIVERY_PATHS.NONE,
        error:         e && e.message,
      });
      tally.fallback_to_matcher.none++;
      continue;
    }

    const categorized = categorizeByMatchType({ lbCandidate, matchTypeResult });
    let accountContext = null;
    if (lbCandidate.accountId) {
      try {
        accountContext = await getAccountContextForLb(supabase, {
          accountId:        lbCandidate.accountId,
          tenantId,
          lbLeadId:         lbCandidate.leadId,
          lbPrisma,
          lbLeadCreatedAt:  lbCandidate.createdAt || lbCandidate.created_at,
        });
      } catch (e) {
        try { logger.warn(`[account-aware] tenant=${tenantId} lead=${lbCandidate.leadId} account-context fetch failed: ${e && e.message}`); } catch (_) {}
      }
    }

    const cls = classifyAccountAware({
      lbCandidate,
      categorized,
      accountContext,
      options: { recentDaysThreshold, now },
    });

    classified.push({
      lb_lead_id:        lbCandidate.leadId,
      lb_customer_name:  lbCandidate.customerName || null,
      account_id:        lbCandidate.accountId || null,
      bucket:            categorized && categorized.bucket,
      reason:            categorized && categorized.reason,
      account_class:     cls.account_class,
      action:            cls.action,
      delivery_path:     cls.delivery_path,
      account_class_reason: cls.reason,
      account_context: accountContext && {
        customerId:                 accountContext.customerId,
        paidJobsCount:              accountContext.paidJobsCount,
        totalJobsCount:             accountContext.totalJobsCount,
        sfLeadIdsInAccount:         accountContext.sfLeadIdsInAccount,
        sfLeadInActiveStage:        accountContext.sfLeadInActiveStage,
        linkedSiblingLbCount:       accountContext.linkedSiblingLbCount,
        anySiblingLbCount:          accountContext.anySiblingLbCount,
        marketplaceDuplicateSibling: accountContext.marketplaceDuplicateSibling,
      },
    });

    if (cls.action === ACTIONS.AUTO_LINK)            tally.auto_link.sync_apply++;
    else if (cls.action === ACTIONS.AUTO_NO_MATCH)   tally.auto_no_match.feedback++;
    else if (cls.action === ACTIONS.NEEDS_REVIEW)    tally.needs_review.feedback++;
    else                                              tally.fallback_to_matcher.none++;
  }

  const unresolved = classified.filter(c => c.account_class === ACCOUNT_CLASSES.UNRESOLVED_NO_ACCOUNT_ID).length;

  return {
    ok:               true,
    phase:            'account_aware_residual_cleanup_dryrun',
    summary: {
      lb_user_id:     lbUserId,
      tenant_id:      tenantId,
      fetched_from_lb: candidates.length,
      requested_limit: limit,
      sync_scope:     syncScope,
      sync_statuses:  syncStatuses.slice(),
      tally,
      unresolved,
    },
    classified,
    dry_run:          true,
  };
}

module.exports = {
  classifyAccountAware,
  getAccountContextForLb,
  runAccountAwareResidualCleanupDryRun,
  ACCOUNT_CLASSES,
  ACTIONS,
  DELIVERY_PATHS,
  RECENT_DAYS_DEFAULT,
  DUPLICATE_WINDOW_SECONDS,
};
