'use strict';

/**
 * Source-account boundary — Phase 4 read-side visibility helpers.
 *
 * Pure-ish helpers (loadDisconnectedAccountIds is the one I/O touch
 * point — kept here so the read paths can stay terse).
 *
 * Visibility rules when SOURCE_ACCOUNT_BOUNDARY_ENFORCED is on:
 *
 *   Normal "all communications" view:
 *     SHOW: provider_account_id IS NULL                  (legacy + gmail/outlook)
 *     SHOW: provider_account_id → status = 'active'      (live LB/OP/WA)
 *     HIDE: provider_account_id → status != 'active'     (disconnected source)
 *
 *   Account/source-scoped view (?accountId=X):
 *     The existing .eq('provider_account_id', X) filter already excludes
 *     null and unrelated accounts. The disconnected-account hide above
 *     stacks on top so a request for a disconnected account returns
 *     empty, which is the desired behavior.
 *
 *   Detail / send endpoints:
 *     A single conversation that would be hidden from the list is
 *     treated as "not available" — detail returns 404, send returns
 *     409 with reason='source_account_disconnected'.
 *
 * What this module does NOT do:
 *   - Set hidden_at on any row (no writes).
 *   - Touch identities.
 *   - Read or write the SOURCE_ACCOUNT_BOUNDARY_ENFORCED flag itself —
 *     the flag check lives at the call site so each endpoint can decide
 *     whether to spend the lookup.
 */

/**
 * Pull every non-active provider_account row for a tenant. Returns a Set
 * of ids. Small table (one row per connected provider per phone), so a
 * single SELECT is fine; no pagination needed at typical scale.
 *
 * Uses a focused SELECT so the read path doesn't pay for unneeded
 * columns when this is the only thing it cares about.
 */
async function loadDisconnectedAccountIds(supabase, userId) {
  if (!supabase || !userId) return new Set();
  const { data, error } = await supabase
    .from('communication_provider_accounts')
    .select('id, status')
    .eq('user_id', userId)
    .neq('status', 'active');
  if (error) throw new Error(`loadDisconnectedAccountIds: ${error.message}`);
  return new Set((data || []).map(r => r.id));
}

/**
 * Look up the status of a single provider_account row. Returns one of
 * 'active' | 'disconnected' | 'paused' | 'error' | <other> | null.
 * Used by the detail + send paths to decide between 200 / 404 / 409.
 */
async function getProviderAccountStatus(supabase, accountId) {
  if (!supabase || !accountId) return null;
  const { data } = await supabase
    .from('communication_provider_accounts')
    .select('status')
    .eq('id', accountId)
    .maybeSingle();
  return data?.status || null;
}

/**
 * Pure decision: should this conversation be hidden from the normal
 * all-communications view under the boundary rules?
 *
 *   conv.provider_account_id IS NULL  → false (visible — legacy/email)
 *   conv.provider_account_id ∈ disconnectedSet → true (hidden)
 *   else → false (visible — has FK to active account)
 */
function isConversationHiddenByBoundary(conv, disconnectedAccountIds) {
  if (!conv) return false;
  if (conv.provider_account_id == null) return false;
  return disconnectedAccountIds.has(conv.provider_account_id);
}

/**
 * Filter an array of conversation rows in-place semantics (returns new array).
 * Pure — caller decides whether to invoke based on the flag.
 */
function filterVisibleConversations(conversations, disconnectedAccountIds) {
  if (!Array.isArray(conversations)) return [];
  if (!disconnectedAccountIds || disconnectedAccountIds.size === 0) return conversations;
  return conversations.filter(c => !isConversationHiddenByBoundary(c, disconnectedAccountIds));
}

/**
 * Hiding-reason string for logs. Helpful when investigating "where did
 * my conversation go" support tickets after the flag flips.
 */
function getHidingReason(conv, disconnectedAccountIds) {
  if (!conv) return null;
  if (conv.provider_account_id == null) return null;
  if (disconnectedAccountIds.has(conv.provider_account_id)) {
    return `source_account_disconnected (account_id=${conv.provider_account_id})`;
  }
  return null;
}

module.exports = {
  loadDisconnectedAccountIds,
  getProviderAccountStatus,
  isConversationHiddenByBoundary,
  filterVisibleConversations,
  getHidingReason,
};
