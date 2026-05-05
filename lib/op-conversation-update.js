'use strict';

// Names that aggregator/source platforms attach to incoming leads. These are
// NOT real contact names — if Sigcore has nothing else, we treat them as
// "no signal" (clear), not as a name we should pin onto the SF row. Mirrors
// AGGREGATOR_NAME_RE in server.js but kept inline so the helper stays pure.
const AGGREGATOR_NAME_RE = /(thumbtack|thumtack|thumback|thumbtac|tumbtack|thambtack|thumntack|yelp|leadbridge|google|facebook|bark|groupon|instagram|angi|homeadvisor|voolt|yellow ?pages|yellowpages|\bsite\b|cold call|refrenc|reference|recommend)/i;

const isAggregatorName = (s) => typeof s === 'string' && AGGREGATOR_NAME_RE.test(s);

// Pure helpers that decide how to update SF's communication_conversations row
// from a Sigcore conversation payload. Extracted from the OP sync path so the
// "value present / null / absent" semantics can be unit-tested in isolation.
//
// Sigcore's response shape per conversation:
//   {
//     participantPhone, contactName?, conversationName?,
//     provider?: { contactId, displayName, company } | null,
//     company?, firstName?, lastName?, ...
//   }
//
// Field-state semantics SF must respect:
//   value present (non-empty)  → set this value
//   value null or empty string → clear this value (operator deleted it in OP)
//   key absent in payload      → unknown / leave SF's existing value alone

/**
 * Decide what to write to communication_conversations.company.
 *
 * @param {object} sigcoreConv  the conversation object from Sigcore
 * @param {object} foundRow     the existing SF row (must have .company)
 * @returns {{ shouldUpdate: boolean, value: string|null }}
 */
function computeCompanyUpdate(sigcoreConv, foundRow) {
  const providerBlock = sigcoreConv?.provider;
  // Field-state precedence: provider.company beats legacy conv.company.
  let raw;
  if (providerBlock && Object.prototype.hasOwnProperty.call(providerBlock, 'company')) {
    raw = providerBlock.company;
  } else if (sigcoreConv && Object.prototype.hasOwnProperty.call(sigcoreConv, 'company')) {
    raw = sigcoreConv.company;
  } else {
    return { shouldUpdate: false, value: null }; // absent → leave alone
  }
  // Normalize "" → null so downstream filters (company IS NULL) match the same.
  const value = (raw === '' || raw == null) ? null : raw;
  return {
    shouldUpdate: value !== foundRow.company,
    value,
  };
}

/**
 * Decide what to write to communication_conversations.participant_name.
 *
 * Two cases lead to a write:
 *   A. We have a non-empty contactName from any source → set it.
 *   B. Sigcore explicitly confirms the OP contact is gone (provider block
 *      present with all of contactId/displayName/company null) AND no
 *      conversation-level fallback name exists → clear participant_name.
 * Otherwise leave the existing value alone.
 *
 * @param {object} sigcoreConv  the conversation object from Sigcore
 * @param {object} foundRow     the existing SF row (must have .participant_name)
 * @param {string|null} [crossRefName]  optional cross-reference map lookup
 * @returns {{ shouldUpdate: boolean, value: string|null, reason: string }}
 */
function computeNameUpdate(sigcoreConv, foundRow, crossRefName = null) {
  const providerBlock = sigcoreConv?.provider;
  const providerDisplay = providerBlock?.displayName ?? null;
  const convContactName = sigcoreConv?.contactName ?? null;
  const sigcoreFullName =
    [sigcoreConv?.firstName, sigcoreConv?.lastName].filter(Boolean).join(' ') || null;
  const conversationName = sigcoreConv?.conversationName ?? null;

  // Drop aggregator/source labels from any fallback. "Yellow Pages",
  // "Thumbtack Tampa", "Yelp", etc. are platform names, not contact names —
  // pinning them as participant_name pollutes the Need-Attention list. The
  // provider block's displayName is the operator's authoritative input, so
  // trust that even if it matches an aggregator pattern (operator may have
  // intentionally tagged the contact "Thumbtack S" in OpenPhone).
  const cleanContactName = isAggregatorName(convContactName) ? null : convContactName;
  const cleanFullName = isAggregatorName(sigcoreFullName) ? null : sigcoreFullName;
  const cleanConvName = isAggregatorName(conversationName) ? null : conversationName;
  const cleanCrossRef = isAggregatorName(crossRefName) ? null : crossRefName;

  const computedName =
    providerDisplay || cleanContactName || cleanFullName || cleanConvName || cleanCrossRef || null;

  if (computedName) {
    return computedName !== foundRow.participant_name
      ? { shouldUpdate: true, value: computedName, reason: 'set_from_sigcore' }
      : { shouldUpdate: false, value: computedName, reason: 'unchanged' };
  }

  // Conservative clear: only when ALL signals from Sigcore are explicitly null
  // (after aggregator filtering) AND providerBlock confirms the snapshot has
  // no contact attached.
  const contactDeletedInOp =
    providerBlock != null
    && providerBlock.displayName == null
    && providerBlock.contactId == null
    && providerBlock.company == null
    && cleanContactName == null
    && cleanFullName == null
    && cleanConvName == null
    && cleanCrossRef == null;

  if (contactDeletedInOp && foundRow.participant_name != null) {
    return { shouldUpdate: true, value: null, reason: 'op_contact_deleted' };
  }

  return { shouldUpdate: false, value: null, reason: 'no_signal' };
}

/**
 * Categorize a row from a Sigcore conversation payload for reporting.
 *
 *   op_active           — contact exists in OP, has at least one populated provider.* field
 *   op_company_cleared  — contact exists, provider.company explicitly null/empty, displayName present
 *   op_deleted          — provider block present with all fields null (snapshot was nulled by deletion-detect)
 *   op_unresolved       — no provider block at all (phone never mapped to an OP contact)
 */
function classifyConversationSyncStatus(sigcoreConv) {
  const p = sigcoreConv?.provider;
  if (!p) return 'op_unresolved';
  const hasContactId = p.contactId != null;
  const hasName = p.displayName != null && p.displayName !== '';
  const hasCompany = p.company != null && p.company !== '';
  if (!hasContactId && !hasName && !hasCompany) return 'op_deleted';
  if (hasContactId && !hasCompany && hasName) return 'op_company_cleared';
  return 'op_active';
}

module.exports = {
  computeCompanyUpdate,
  computeNameUpdate,
  classifyConversationSyncStatus,
};
