'use strict';

// LeadBridge linkage resolver — single source of truth for "given a
// customer, find the LB lead the next job should inherit linkage from."
//
// This module replaces the older lib/lb-job-linkage.js (kept exported
// for back-compat; new callers should use this one). The contract:
//
//   resolveLbLinkage(supabase, {userId, customerId, explicit?, logger?})
//     → { link, result, reason, leadId?, candidates? }
//
//   link    canonical 4-field linkage object (nulls when not_linked)
//   result  'linked' | 'not_linked' | 'review_required'
//   reason  see REASONS below — stable enum for logs/metrics
//
// Invariant (the system contract):
//
//   If an SF job is being created for a customer whose identity graph
//   contains exactly one LB-linked converted lead, THEN the job's
//   lb_external_request_id + lb_channel MUST be populated before any
//   outbound status logic runs.
//
//   If the linkage chain is ambiguous, the resolver MUST NOT guess.
//   It returns result='review_required' with a specific reason; the
//   caller writes the job without linkage and surfaces the reason via
//   the [LBLinkage] structured log + metrics.
//
// Resolution strategies (tried in order, first match wins):
//
//   1. explicit          caller passed lb_external_request_id in the
//                        request body (LB→SF inbound path knows the
//                        linkage directly).
//   2. lead_match        leads WHERE converted_customer_id = customerId
//                        AND lb_external_request_id IS NOT NULL,
//                        returning exactly one distinct external id.
//   3. identity_lead     identity.sf_customer_id = customerId AND
//                        identity.sf_lead_id points at an LB-linked
//                        lead, AND that linkage is consistent with any
//                        leads.converted_customer_id result.
//
// Ambiguity branches (always result='review_required'):
//
//   multiple_lb_leads             > 1 distinct external_request_id
//                                 across leads for this customer.
//   ambiguity_identity_disagrees  lead_match returns one id but identity
//                                 points at a DIFFERENT lead.
//   duplicate_customer            > 1 identity rows for the same
//                                 customer pointing at different
//                                 sf_lead_ids.
//
// Constraints (per the system requirements):
//
//   - NO phone-only matching. Linkage is found via converted_customer_id
//     OR the identity-graph, never by joining phones across customers.
//   - NO silent overwrites. If a job is being created with an explicit
//     linkage AND the customer's identity points elsewhere, we surface
//     the conflict but accept the explicit value (caller knows best).
//   - Tenant-scoped. Every query filters by userId.

const ALLOWED_CHANNELS = new Set(['thumbtack', 'yelp']);

const REASONS = Object.freeze({
  EXPLICIT: 'explicit',
  LEAD_MATCH: 'lead_match',
  IDENTITY_LEAD_MATCH: 'identity_lead_match',
  CUSTOMER_ACQUISITION_MATCH: 'customer_acquisition_match',
  NO_CUSTOMER: 'no_customer',
  NO_LB_LEAD: 'no_lb_lead',
  MULTIPLE_LB_LEADS: 'multiple_lb_leads',
  AMBIGUITY_IDENTITY_DISAGREES: 'ambiguity_identity_disagrees',
  DUPLICATE_CUSTOMER: 'duplicate_customer',
  HOUSEHOLD_PHONE_RISK: 'household_phone_risk',
  CUSTOMER_WITHOUT_IDENTITY: 'customer_without_identity',
  ERROR: 'error',
});

const EMPTY_LINK = Object.freeze({
  lb_external_request_id: null,
  lb_channel: null,
  lb_business_id: null,
  lb_provider_account_id: null,
});

function nullsLink() {
  return { ...EMPTY_LINK };
}

function resultFor(reason) {
  switch (reason) {
    case REASONS.EXPLICIT:
    case REASONS.LEAD_MATCH:
    case REASONS.IDENTITY_LEAD_MATCH:
    case REASONS.CUSTOMER_ACQUISITION_MATCH:
      return 'linked';
    case REASONS.MULTIPLE_LB_LEADS:
    case REASONS.AMBIGUITY_IDENTITY_DISAGREES:
    case REASONS.DUPLICATE_CUSTOMER:
    case REASONS.HOUSEHOLD_PHONE_RISK:
      return 'review_required';
    default:
      return 'not_linked';
  }
}

// ──────────────────────────────────────────────────────────────────
// Strategy 1: explicit override from caller
// ──────────────────────────────────────────────────────────────────
function explicitLink(explicit, logger) {
  if (!explicit) return null;
  if (!explicit.lb_external_request_id && !explicit.lb_channel) return null;
  const chan = explicit.lb_channel ? String(explicit.lb_channel) : null;
  if (chan && !ALLOWED_CHANNELS.has(chan)) {
    logger.warn(`[LBLinkage] action=explicit_channel_dropped channel='${chan}' reason=not_in_thumbtack_yelp`);
  }
  let acctId = null;
  if (explicit.lb_provider_account_id != null) {
    const n = Number(explicit.lb_provider_account_id);
    acctId = Number.isFinite(n) ? n : null;
  }
  return {
    lb_external_request_id:
      explicit.lb_external_request_id != null ? String(explicit.lb_external_request_id) : null,
    lb_channel: chan && ALLOWED_CHANNELS.has(chan) ? chan : null,
    lb_business_id: explicit.lb_business_id != null ? String(explicit.lb_business_id) : null,
    lb_provider_account_id: acctId,
  };
}

// ──────────────────────────────────────────────────────────────────
// Strategy 2: leads.converted_customer_id chain
// ──────────────────────────────────────────────────────────────────
async function fetchLeadsForCustomer(supabase, userId, customerId) {
  const { data, error } = await supabase
    .from('leads')
    .select('id, user_id, converted_customer_id, lb_external_request_id, lb_channel, lb_business_id, lb_provider_account_id')
    .eq('user_id', userId)
    .eq('converted_customer_id', customerId)
    .limit(10);
  if (error) throw error;
  return data || [];
}

// ──────────────────────────────────────────────────────────────────
// Strategy 3: identity-graph
// ──────────────────────────────────────────────────────────────────
async function fetchIdentitiesForCustomer(supabase, userId, customerId) {
  const { data, error } = await supabase
    .from('communication_participant_identities')
    .select('id, user_id, sf_customer_id, sf_lead_id')
    .eq('user_id', userId)
    .eq('sf_customer_id', customerId)
    .limit(10);
  if (error) throw error;
  return data || [];
}

// Strategy 4: customer-level acquisition lookup (migration 054).
// Returns the linkage object when the customer record carries
// acquisition_external_request_id, OR null if the customer is unknown to LB.
async function fetchCustomerAcquisition(supabase, userId, customerId) {
  if (customerId == null) return null;
  const { data, error } = await supabase
    .from('customers')
    .select('id, user_id, acquisition_source, acquisition_channel, acquisition_business_id, acquisition_external_request_id, acquisition_at')
    .eq('user_id', userId)
    .eq('id', customerId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  if (data.acquisition_source !== 'leadbridge') return null;
  if (data.acquisition_external_request_id == null) return null;
  return data;
}

async function fetchLeadById(supabase, userId, leadId) {
  if (leadId == null) return null;
  const { data, error } = await supabase
    .from('leads')
    .select('id, user_id, lb_external_request_id, lb_channel, lb_business_id, lb_provider_account_id')
    .eq('user_id', userId)
    .eq('id', leadId)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

function leadToLink(lead) {
  if (!lead || lead.lb_external_request_id == null) return null;
  return {
    lb_external_request_id: lead.lb_external_request_id,
    lb_channel: lead.lb_channel,
    lb_business_id: lead.lb_business_id || null,
    lb_provider_account_id: lead.lb_provider_account_id ?? null,
  };
}

function distinctLinkKeys(leads) {
  const set = new Set();
  for (const l of leads) {
    if (l.lb_external_request_id != null) {
      set.add(`${l.lb_external_request_id}|${l.lb_channel || ''}`);
    }
  }
  return set;
}

// ──────────────────────────────────────────────────────────────────
// Main resolver
// ──────────────────────────────────────────────────────────────────
async function resolveLbLinkage(supabase, args) {
  const logger = args.logger || console;
  const { userId, customerId, explicit } = args;

  // 1. Explicit override path.
  const ex = explicitLink(explicit, logger);
  if (ex) {
    return { link: ex, result: 'linked', reason: REASONS.EXPLICIT };
  }

  if (userId == null) {
    return { link: nullsLink(), result: 'not_linked', reason: REASONS.NO_CUSTOMER };
  }
  if (customerId == null) {
    return { link: nullsLink(), result: 'not_linked', reason: REASONS.NO_CUSTOMER };
  }

  let leads;
  let identities;
  try {
    [leads, identities] = await Promise.all([
      fetchLeadsForCustomer(supabase, userId, customerId),
      fetchIdentitiesForCustomer(supabase, userId, customerId),
    ]);
  } catch (e) {
    logger.warn(`[LBLinkage] action=lookup_failed user=${userId} customer=${customerId} error=${e?.message}`);
    return { link: nullsLink(), result: 'not_linked', reason: REASONS.ERROR };
  }

  // 2. Lead-side analysis — converted_customer_id chain.
  const linkedLeads = leads.filter((l) => l.lb_external_request_id != null);
  const leadKeys = distinctLinkKeys(linkedLeads);

  if (leadKeys.size > 1) {
    logger.warn(
      `[LBLinkage] action=ambiguous user=${userId} customer=${customerId} ` +
      `reason=multiple_lb_leads lead_ids=[${linkedLeads.map((l) => l.id).join(',')}] ` +
      `external_ids=[${linkedLeads.map((l) => l.lb_external_request_id).join(',')}]`
    );
    return {
      link: nullsLink(),
      result: 'review_required',
      reason: REASONS.MULTIPLE_LB_LEADS,
      candidates: linkedLeads.map((l) => ({
        lead_id: l.id,
        external_request_id: l.lb_external_request_id,
        channel: l.lb_channel,
      })),
    };
  }

  // 3. Identity-side analysis — duplicate-customer detection first.
  if (identities.length > 1) {
    const distinctLeadIds = new Set(
      identities.filter((i) => i.sf_lead_id != null).map((i) => String(i.sf_lead_id))
    );
    if (distinctLeadIds.size > 1) {
      logger.warn(
        `[LBLinkage] action=ambiguous user=${userId} customer=${customerId} ` +
        `reason=duplicate_customer identity_ids=[${identities.map((i) => i.id).join(',')}] ` +
        `sf_lead_ids=[${[...distinctLeadIds].join(',')}]`
      );
      return {
        link: nullsLink(),
        result: 'review_required',
        reason: REASONS.DUPLICATE_CUSTOMER,
        candidates: identities.map((i) => ({ identity_id: i.id, sf_lead_id: i.sf_lead_id })),
      };
    }
  }

  const identity = identities[0] || null;

  // 4. Cross-check lead_match vs identity_lead.
  if (linkedLeads.length === 1 && identity?.sf_lead_id != null) {
    if (String(identity.sf_lead_id) !== String(linkedLeads[0].id)) {
      logger.warn(
        `[LBLinkage] action=ambiguous user=${userId} customer=${customerId} ` +
        `reason=ambiguity_identity_disagrees ` +
        `lead_match=${linkedLeads[0].id} identity_lead=${identity.sf_lead_id}`
      );
      return {
        link: nullsLink(),
        result: 'review_required',
        reason: REASONS.AMBIGUITY_IDENTITY_DISAGREES,
        candidates: [
          { lead_id: linkedLeads[0].id, source: 'converted_customer_id' },
          { lead_id: identity.sf_lead_id, source: 'identity_graph' },
        ],
      };
    }
  }

  // 5. Strategy 2 — single lead via converted_customer_id.
  if (linkedLeads.length >= 1) {
    const winner = linkedLeads[0];
    return {
      link: leadToLink(winner),
      result: 'linked',
      reason: REASONS.LEAD_MATCH,
      leadId: winner.id,
    };
  }

  // 6. Strategy 3 — identity-graph fallback. The customer's identity may
  //    point at a lead whose converted_customer_id wasn't set (legacy
  //    conversion path that skipped the back-pointer). We accept this
  //    only when the identity is unambiguous.
  if (identity?.sf_lead_id != null) {
    let lead;
    try {
      lead = await fetchLeadById(supabase, userId, identity.sf_lead_id);
    } catch (e) {
      logger.warn(`[LBLinkage] action=lookup_failed_identity user=${userId} customer=${customerId} error=${e?.message}`);
      return { link: nullsLink(), result: 'not_linked', reason: REASONS.ERROR };
    }
    const link = leadToLink(lead);
    if (link) {
      return {
        link,
        result: 'linked',
        reason: REASONS.IDENTITY_LEAD_MATCH,
        leadId: lead.id,
      };
    }
  }

  // 7. Strategy 4 — customer-level acquisition (migration 054). Reads
  //    customers.acquisition_external_request_id directly. This is the
  //    recurring-customer model: a customer was acquired via LB
  //    (write-once at first contact), and every subsequent job for that
  //    customer can inherit the attribution without each lead getting
  //    its own SF row. Resolver gates on `acquisition_source='leadbridge'`
  //    so we never accidentally re-attribute a ZB-acquired customer.
  try {
    const cust = await fetchCustomerAcquisition(supabase, userId, customerId);
    if (cust) {
      return {
        link: {
          lb_external_request_id: cust.acquisition_external_request_id,
          lb_channel: cust.acquisition_channel,
          lb_business_id: cust.acquisition_business_id,
          lb_provider_account_id: null,
        },
        result: 'linked',
        reason: REASONS.CUSTOMER_ACQUISITION_MATCH,
        customerId,
      };
    }
  } catch (e) {
    logger.warn(`[LBLinkage] action=lookup_failed_acquisition user=${userId} customer=${customerId} error=${e?.message}`);
    // Don't return error here — fall through to no_lb_lead path. The
    // customer-acquisition lookup is the last strategy, so an error means
    // we simply couldn't reach Strategy 4. The caller's behavior should
    // be the same as if no row existed.
  }

  // 8. No linkage — distinguish "customer has no identity at all" from
  //    "customer has identity but no LB lead". The two outcomes log the
  //    same result='not_linked' but different reason for observability.
  if (identities.length === 0) {
    return {
      link: nullsLink(),
      result: 'not_linked',
      reason: REASONS.CUSTOMER_WITHOUT_IDENTITY,
    };
  }
  return { link: nullsLink(), result: 'not_linked', reason: REASONS.NO_LB_LEAD };
}

// ──────────────────────────────────────────────────────────────────
// Convenience helpers
// ──────────────────────────────────────────────────────────────────

// Pulls linkage off an existing job row (for duplicate / recurring
// child paths where the parent already has linkage). Returns nulls if
// the parent has no linkage. Treats this as `explicit` — the parent
// is the authoritative source.
function linkageFromParentJob(parent) {
  if (!parent) return null;
  if (parent.lb_external_request_id == null) return null;
  return {
    lb_external_request_id: parent.lb_external_request_id,
    lb_channel: parent.lb_channel || null,
    lb_business_id: parent.lb_business_id || null,
    lb_provider_account_id: parent.lb_provider_account_id ?? null,
  };
}

// Write-once helper for `customers.acquisition_*` (migration 054).
// Sets the columns ONLY when acquisition_external_request_id is currently
// NULL. Never overwrites a prior attribution — the original acquisition
// wins. Returns { ok, wrote } so the caller can log/observe.
//
// Inputs:
//   supabase, userId, customerId
//   link = { lb_external_request_id, lb_channel, lb_business_id, acquired_at }
//
// Safety: tenant-scoped, write-once at SQL level. No outbound side effects.
async function setCustomerAcquisitionIfMissing(supabase, userId, customerId, link) {
  if (!link || !link.lb_external_request_id) return { ok: true, wrote: false, reason: 'no_link' };
  if (userId == null || customerId == null) return { ok: true, wrote: false, reason: 'no_ids' };
  const update = {
    acquisition_source: 'leadbridge',
    acquisition_channel: link.lb_channel || null,
    acquisition_business_id: link.lb_business_id || null,
    acquisition_external_request_id: String(link.lb_external_request_id),
    acquisition_at: link.acquired_at || new Date().toISOString(),
  };
  const { data, error } = await supabase
    .from('customers')
    .update(update)
    .eq('id', customerId)
    .eq('user_id', userId)
    .is('acquisition_external_request_id', null)
    .select('id')
    .maybeSingle();
  if (error) return { ok: false, wrote: false, error: error.message };
  return { ok: true, wrote: !!data };
}

// Emits the canonical [LBLinkage] log line. ONE line per job-create
// resolution attempt. Counter increments happen in lb-linkage-metrics.
function logResolution(logger, args) {
  const { jobId, customerId, result, reason, leadId, link } = args;
  const ext = link?.lb_external_request_id || null;
  const chan = link?.lb_channel || null;
  logger.log(
    `[LBLinkage] action=resolve_for_job` +
    ` job_id=${jobId ?? 'null'}` +
    ` customer_id=${customerId ?? 'null'}` +
    ` lead_id=${leadId ?? 'null'}` +
    ` result=${result}` +
    ` reason=${reason}` +
    ` external_request_id=${ext ?? 'null'}` +
    ` channel=${chan ?? 'null'}`
  );
}

module.exports = {
  resolveLbLinkage,
  linkageFromParentJob,
  logResolution,
  setCustomerAcquisitionIfMissing,
  fetchCustomerAcquisition,
  REASONS,
  ALLOWED_CHANNELS,
  EMPTY_LINK,
};
