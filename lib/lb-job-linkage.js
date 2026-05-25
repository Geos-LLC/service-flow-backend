'use strict';

// Lead → job LB-linkage propagation.
//
// When the SF UI creates a job, the only stable identity it carries is
// `customer_id`. The originating lead — if any — sits on the other side
// of `leads.converted_customer_id = customer_id`. This module resolves
// that join and returns the LB linkage to stamp on the job INSERT.
//
// Invariants (do not relax without coordinating with the audit notes):
//
//   1. Single-result rule — we only return linkage when EXACTLY one
//      lead matches. If two leads for this customer carry different
//      lb_external_request_id values (duplicate-customer-merge), we
//      refuse to guess and log an ambiguity warning. The job is created
//      WITHOUT LB linkage in that case; backfill can resolve it later.
//
//   2. Tenant scope — every query is scoped by user_id. There is no
//      path from one tenant's customer to another tenant's lead.
//
//   3. Explicit-override wins — if the caller passed lb_external_request_id
//      and lb_channel in the request body directly, those win and no
//      lead lookup is performed. Used by the LB→SF inbound path that
//      already knows the linkage.
//
//   4. Read-only — this helper NEVER writes. It returns the linkage; the
//      caller decides whether to merge it into the INSERT payload.

const ALLOWED_CHANNELS = new Set(['thumbtack', 'yelp']);

/**
 * Resolve LB linkage to stamp on a new job.
 *
 * @param {object} supabase
 * @param {object} args
 * @param {string|number} args.userId           Tenant scope (required).
 * @param {string|number|null} args.customerId  Customer the job is for; null is allowed (returns no_customer).
 * @param {object} [args.explicit]              Optional explicit override carried in the request body.
 *   { lb_external_request_id?: string, lb_channel?: 'thumbtack'|'yelp',
 *     lb_business_id?: string, lb_provider_account_id?: number }
 * @param {object} [args.logger]                Optional logger; falls back to console.
 *
 * @returns {Promise<{
 *   link: { lb_external_request_id: string|null,
 *           lb_channel: string|null,
 *           lb_business_id: string|null,
 *           lb_provider_account_id: number|null },
 *   reason: 'explicit' | 'lead_match' | 'no_customer' | 'no_lead' | 'lead_unlinked' | 'ambiguous_leads' | 'error',
 *   leadId?: number|null
 * }>}
 */
async function resolveLbLinkageForNewJob(supabase, { userId, customerId, explicit, logger }) {
  const log = logger || console;
  const empty = {
    lb_external_request_id: null,
    lb_channel: null,
    lb_business_id: null,
    lb_provider_account_id: null,
  };

  // 1. Explicit override path — caller already knows the linkage.
  if (explicit && (explicit.lb_external_request_id || explicit.lb_channel)) {
    const chan = explicit.lb_channel ? String(explicit.lb_channel) : null;
    if (chan && !ALLOWED_CHANNELS.has(chan)) {
      log.warn(`[LB Linkage] explicit lb_channel='${chan}' rejected — not in {thumbtack,yelp}; treating as null`);
    }
    let acctId = null;
    if (explicit.lb_provider_account_id != null) {
      const n = Number(explicit.lb_provider_account_id);
      acctId = Number.isFinite(n) ? n : null;
    }
    return {
      link: {
        lb_external_request_id:
          explicit.lb_external_request_id != null ? String(explicit.lb_external_request_id) : null,
        lb_channel: chan && ALLOWED_CHANNELS.has(chan) ? chan : null,
        lb_business_id: explicit.lb_business_id != null ? String(explicit.lb_business_id) : null,
        lb_provider_account_id: acctId,
      },
      reason: 'explicit',
    };
  }

  if (userId == null) return { link: empty, reason: 'no_customer' };
  if (customerId == null) return { link: empty, reason: 'no_customer' };

  // 2. Look up the lead(s) for this customer. We expect exactly one in the
  //    happy path; multiple linked leads is a duplicate-customer signal.
  let leads;
  try {
    const { data, error } = await supabase
      .from('leads')
      .select('id, lb_external_request_id, lb_channel, lb_business_id, lb_provider_account_id')
      .eq('user_id', userId)
      .eq('converted_customer_id', customerId)
      .limit(5);
    if (error) {
      log.warn(`[LB Linkage] Lead lookup error user=${userId} customer=${customerId}: ${error.message}`);
      return { link: empty, reason: 'error' };
    }
    leads = data || [];
  } catch (e) {
    log.warn(`[LB Linkage] Lead lookup threw user=${userId} customer=${customerId}: ${e && e.message}`);
    return { link: empty, reason: 'error' };
  }

  if (leads.length === 0) {
    return { link: empty, reason: 'no_lead' };
  }

  // 3. Filter to LB-linked leads (non-null external request id).
  const linked = leads.filter((l) => l.lb_external_request_id != null);
  if (linked.length === 0) {
    return { link: empty, reason: 'lead_unlinked', leadId: leads[0].id };
  }

  // 4. Multiple LB-linked leads for the same customer with DIFFERENT
  //    external_request_ids → ambiguous. Refuse to guess.
  if (linked.length > 1) {
    const distinct = new Set(linked.map((l) => `${l.lb_external_request_id}|${l.lb_channel || ''}`));
    if (distinct.size > 1) {
      log.warn(
        `[LB Linkage] ambiguous_leads user=${userId} customer=${customerId} ` +
        `lead_ids=[${linked.map((l) => l.id).join(',')}] ` +
        `external_ids=[${linked.map((l) => l.lb_external_request_id).join(',')}] — refusing to attach`
      );
      return { link: empty, reason: 'ambiguous_leads' };
    }
    // Multiple linked leads agree on the same external_request_id+channel.
    // Treat as single match (the dedup index will tolerate this).
  }

  const winner = linked[0];
  return {
    link: {
      lb_external_request_id: winner.lb_external_request_id,
      lb_channel: winner.lb_channel,
      lb_business_id: winner.lb_business_id || null,
      lb_provider_account_id: winner.lb_provider_account_id ?? null,
    },
    reason: 'lead_match',
    leadId: winner.id,
  };
}

module.exports = {
  resolveLbLinkageForNewJob,
  ALLOWED_CHANNELS,
};
