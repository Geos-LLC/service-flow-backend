'use strict';

/**
 * Source-account boundary — Phase 2 backfill helpers (READ-ONLY).
 *
 * Pure classification + report assembly. No supabase calls, no writes.
 * The CLI in scripts/backfill-source-account-dry-run.js wraps these
 * helpers, paginates the data, and prints the report.
 *
 * See docs/security/source-account-boundary-plan.md §9 for the matching
 * rules. Phase 2 produces a report only — Phase 3 will add an --apply
 * mode behind a flag.
 *
 * Buckets:
 *   matched_existing      — conv.provider_account_id already set
 *   matched_inferred      — exactly one provider_account row matches
 *                           the conversation's provider/channel/endpoint
 *                           (or LB's external_business_id) — would be
 *                           stamped in apply mode
 *   ambiguous             — multiple provider_account candidates; do
 *                           not auto-resolve, surface for manual review
 *   unmatched_legacy      — known provider, no provider_account row to
 *                           attribute to (e.g. OpenPhone connections
 *                           that pre-date Phase 1, or providers we don't
 *                           model yet); candidate for legacy_unknown_source
 *   unknown_provider      — provider value the boundary has no opinion
 *                           on (email/sendgrid/connected-email/etc).
 *                           Excluded from account-scoped views by default.
 */

function normalizePhone(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/[^\d+]/g, '');
  if (digits.startsWith('+')) return digits;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return digits || null;
}

const ACCOUNT_PROVIDERS = new Set(['leadbridge', 'openphone', 'whatsapp']);

/**
 * Build an in-memory index of provider_accounts keyed for fast lookup.
 *
 * Returned shape:
 *   {
 *     byId: Map<id, account>,
 *     leadbridgeByUserChannelBusiness: Map<`${user}:${channel}:${businessId}`, account[]>,
 *     openphoneByUserPhone: Map<`${user}:${e164}`, account[]>,
 *     whatsappByUserPhone:  Map<`${user}:${e164}`, account[]>,
 *   }
 *
 * Status is preserved on each account (we report disconnected separately).
 */
function indexProviderAccounts(accounts) {
  const byId = new Map();
  const leadbridgeByUserChannelBusiness = new Map();
  const openphoneByUserPhone = new Map();
  const whatsappByUserPhone = new Map();

  for (const a of (accounts || [])) {
    byId.set(a.id, a);

    if (a.provider === 'leadbridge' && a.external_business_id) {
      const key = `${a.user_id}:${a.channel}:${a.external_business_id}`;
      const arr = leadbridgeByUserChannelBusiness.get(key) || [];
      arr.push(a);
      leadbridgeByUserChannelBusiness.set(key, arr);
    }

    if (a.provider === 'openphone') {
      const phone = normalizePhone(a.metadata?.phoneNumber);
      if (phone) {
        const key = `${a.user_id}:${phone}`;
        const arr = openphoneByUserPhone.get(key) || [];
        arr.push(a);
        openphoneByUserPhone.set(key, arr);
      }
    }

    if (a.provider === 'whatsapp') {
      const phone = normalizePhone(a.external_account_id);
      if (phone) {
        const key = `${a.user_id}:${phone}`;
        const arr = whatsappByUserPhone.get(key) || [];
        arr.push(a);
        whatsappByUserPhone.set(key, arr);
      }
    }
  }

  return { byId, leadbridgeByUserChannelBusiness, openphoneByUserPhone, whatsappByUserPhone };
}

/**
 * Classify a single conversation row.
 *
 * Returns:
 *   {
 *     bucket,              // see file header
 *     matched_account_id,  // FK that would be stamped (or already set)
 *     matched_account_status, // 'active' | 'disconnected' | null
 *     reason,              // short string
 *     provider,            // pass-through for grouping
 *   }
 *
 * NEVER returns matched_account_id != null when bucket === 'ambiguous'
 * — surfaces ambiguous rows for manual review without picking one.
 *
 * NEVER overwrites a non-null provider_account_id — if conv already
 * has one, returns 'matched_existing' with that exact id and trusts
 * the existing FK.
 */
function classifyConversation(conv, accountIndex) {
  const provider = conv.provider || null;

  // (1) Existing FK — never overwrite. Trust the writer.
  if (conv.provider_account_id) {
    const acct = accountIndex.byId.get(conv.provider_account_id);
    return {
      bucket: 'matched_existing',
      matched_account_id: conv.provider_account_id,
      matched_account_status: acct?.status || null,
      reason: acct ? `existing FK → ${acct.provider}/${acct.channel}` : 'existing FK (account row missing)',
      provider,
    };
  }

  // (2) Provider not in scope of source-account model.
  if (!provider || !ACCOUNT_PROVIDERS.has(provider)) {
    return {
      bucket: 'unknown_provider',
      matched_account_id: null,
      matched_account_status: null,
      reason: `provider '${provider || 'null'}' is not gated by the source-account boundary`,
      provider,
    };
  }

  // (3) Provider-specific inferred match.
  if (provider === 'leadbridge') {
    if (!conv.external_business_id) {
      return {
        bucket: 'unmatched_legacy',
        matched_account_id: null,
        matched_account_status: null,
        reason: 'LB conv with no external_business_id and no FK',
        provider,
      };
    }
    const key = `${conv.user_id}:${conv.channel}:${conv.external_business_id}`;
    const candidates = accountIndex.leadbridgeByUserChannelBusiness.get(key) || [];
    return resolveCandidates(candidates, provider, 'LB by user+channel+business_id');
  }

  if (provider === 'openphone') {
    const phone = normalizePhone(conv.endpoint_phone);
    if (!phone) {
      return {
        bucket: 'unmatched_legacy',
        matched_account_id: null,
        matched_account_status: null,
        reason: 'OpenPhone conv with no endpoint_phone — cannot infer account',
        provider,
      };
    }
    const key = `${conv.user_id}:${phone}`;
    const candidates = accountIndex.openphoneByUserPhone.get(key) || [];
    return resolveCandidates(candidates, provider, 'OpenPhone by user+endpoint_phone');
  }

  if (provider === 'whatsapp') {
    const phone = normalizePhone(conv.endpoint_phone);
    if (!phone) {
      return {
        bucket: 'unmatched_legacy',
        matched_account_id: null,
        matched_account_status: null,
        reason: 'WhatsApp conv with no endpoint_phone — cannot infer account',
        provider,
      };
    }
    const key = `${conv.user_id}:${phone}`;
    const candidates = accountIndex.whatsappByUserPhone.get(key) || [];
    return resolveCandidates(candidates, provider, 'WhatsApp by user+endpoint_phone');
  }

  // Unreachable — ACCOUNT_PROVIDERS gate above ensures we're in {LB, OP, WA}.
  return {
    bucket: 'unknown_provider',
    matched_account_id: null,
    matched_account_status: null,
    reason: `unhandled provider '${provider}'`,
    provider,
  };
}

function resolveCandidates(candidates, provider, reasonPrefix) {
  if (candidates.length === 0) {
    return {
      bucket: 'unmatched_legacy',
      matched_account_id: null,
      matched_account_status: null,
      reason: `${reasonPrefix} → no provider_account row`,
      provider,
    };
  }
  if (candidates.length === 1) {
    return {
      bucket: 'matched_inferred',
      matched_account_id: candidates[0].id,
      matched_account_status: candidates[0].status || null,
      reason: `${reasonPrefix} → 1 candidate`,
      provider,
    };
  }
  return {
    bucket: 'ambiguous',
    matched_account_id: null,
    matched_account_status: null,
    reason: `${reasonPrefix} → ${candidates.length} candidates: ${candidates.map(c => c.id).join(',')}`,
    provider,
  };
}

/**
 * Build an aggregate report from classified conversations.
 *
 * @param {Array<{conv, classification}>} classified — one entry per conversation
 * @param {Object} childCounts — { messagesByConvId: Map, callsByConvId: Map }
 *                                Total child rows that would inherit per parent.
 * @param {Object} opts — { sampleSize: number, providerAccounts: Array }
 */
function buildReport(classified, childCounts = {}, opts = {}) {
  const sampleSize = opts.sampleSize ?? 10;
  const messagesByConvId = childCounts.messagesByConvId || new Map();
  const callsByConvId = childCounts.callsByConvId || new Map();

  const buckets = {
    matched_existing: 0,
    matched_inferred: 0,
    ambiguous: 0,
    unmatched_legacy: 0,
    unknown_provider: 0,
  };

  // Per-bucket sample IDs (cap at sampleSize to keep report readable).
  const samples = {
    matched_existing: [],
    matched_inferred: [],
    ambiguous: [],
    unmatched_legacy: [],
    unknown_provider: [],
  };

  // Per-provider rollup, useful for "what does the distribution look like by provider?"
  const byProvider = {};

  // What gets hidden when SOURCE_ACCOUNT_BOUNDARY_ENFORCED flips on.
  // Two distinct sources of hiding:
  //   1. matched_existing or matched_inferred → account is currently disconnected
  //   2. unmatched_legacy / unknown_provider → would be marked legacy_unknown_source
  //      and dropped from account-scoped views (per plan §8)
  let wouldHideDisconnected = 0;
  let wouldHideLegacyUnknown = 0;
  const hideSamples = { disconnected: [], legacy_unknown: [] };

  // Child-row propagation if Phase 3 applies the inferred matches.
  let childMessagesPropagated = 0;
  let childCallsPropagated = 0;

  for (const { conv, classification } of classified) {
    const b = classification.bucket;
    buckets[b] = (buckets[b] || 0) + 1;

    if (samples[b].length < sampleSize) {
      samples[b].push({
        id: conv.id,
        user_id: conv.user_id,
        provider: conv.provider,
        channel: conv.channel,
        endpoint_phone: conv.endpoint_phone || null,
        external_business_id: conv.external_business_id || null,
        external_lead_id: conv.external_lead_id || null,
        matched_account_id: classification.matched_account_id,
        matched_account_status: classification.matched_account_status,
        reason: classification.reason,
      });
    }

    const provKey = conv.provider || 'null';
    byProvider[provKey] = byProvider[provKey] || {
      matched_existing: 0, matched_inferred: 0, ambiguous: 0,
      unmatched_legacy: 0, unknown_provider: 0,
    };
    byProvider[provKey][b]++;

    // Disconnected-account hide (only counts where we know the account).
    if ((b === 'matched_existing' || b === 'matched_inferred')
        && classification.matched_account_status
        && classification.matched_account_status !== 'active') {
      wouldHideDisconnected++;
      if (hideSamples.disconnected.length < sampleSize) {
        hideSamples.disconnected.push({
          id: conv.id, user_id: conv.user_id, provider: conv.provider,
          matched_account_id: classification.matched_account_id,
          status: classification.matched_account_status,
        });
      }
    }

    // Legacy-unknown hide.
    if (b === 'unmatched_legacy' || b === 'unknown_provider') {
      wouldHideLegacyUnknown++;
      if (hideSamples.legacy_unknown.length < sampleSize) {
        hideSamples.legacy_unknown.push({
          id: conv.id, user_id: conv.user_id, provider: conv.provider,
          channel: conv.channel, reason: classification.reason,
        });
      }
    }

    // Child propagation count — only for inferred matches Phase 3 would apply.
    // matched_existing already has the FK, no propagation needed.
    if (b === 'matched_inferred') {
      childMessagesPropagated += messagesByConvId.get(conv.id) || 0;
      childCallsPropagated += callsByConvId.get(conv.id) || 0;
    }
  }

  // Disconnected-account count (separate from would-hide — counts active+disconnected
  // accounts in the sample so the operator can see the underlying state).
  const accountStatusBreakdown = {};
  for (const a of (opts.providerAccounts || [])) {
    const k = `${a.provider}/${a.status || 'unknown'}`;
    accountStatusBreakdown[k] = (accountStatusBreakdown[k] || 0) + 1;
  }

  return {
    generated_at: new Date().toISOString(),
    mode: 'dry-run',
    total_conversations: classified.length,
    buckets,
    by_provider: byProvider,
    would_hide_when_enforced: {
      disconnected_account: wouldHideDisconnected,
      legacy_unknown_source: wouldHideLegacyUnknown,
      total: wouldHideDisconnected + wouldHideLegacyUnknown,
    },
    apply_mode_propagation_estimate: {
      child_messages_inheriting: childMessagesPropagated,
      child_calls_inheriting: childCallsPropagated,
    },
    provider_accounts_status: accountStatusBreakdown,
    samples,
    hide_samples: hideSamples,
  };
}

module.exports = {
  normalizePhone,
  indexProviderAccounts,
  classifyConversation,
  buildReport,
};
