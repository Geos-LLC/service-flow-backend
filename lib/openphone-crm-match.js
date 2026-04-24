'use strict';

// Pre-create CRM phone lookup for OpenPhone conditional lead creation.
//
// Reason: an OP floater identity can have sf_lead_id / sf_customer_id = NULL
// even though a customer with the same phone ALREADY exists in SF (manual
// entry / legacy record that was never linked to an identity). Creating a
// new lead for that person would be a duplicate in CRM.
//
// This helper does a fresh phone lookup against customers.phone and
// leads.phone AFTER shouldOpenPhoneCreateLead returns create=true, so the
// orchestrator can link the identity instead of inserting a fresh lead.
//
// Precedence: customer > lead (if both match, prefer customer since it's
// the stronger CRM record).

const { normalizePhone } = require('./name-normalize');

/**
 * @param {object} supabase     — supabase-js client
 * @param {number} userId       — tenant id
 * @param {string} phone        — E.164, last-10, or any format (normalized here)
 * @returns {Promise<{ type: 'customer'|'lead'|null, id: number|null, matched_phone: string|null }>}
 */
async function findCrmMatchByPhone(supabase, userId, phone) {
  const last10 = normalizePhone(phone);
  if (!last10 || last10.length < 7) {
    return { type: null, id: null, matched_phone: null };
  }
  const frag = `%${last10}%`;

  // Customer first — stronger signal.
  const { data: customer } = await supabase.from('customers')
    .select('id, phone')
    .eq('user_id', userId).ilike('phone', frag)
    .limit(1).maybeSingle();
  if (customer?.id) {
    return { type: 'customer', id: customer.id, matched_phone: customer.phone };
  }

  // Lead fallback.
  const { data: lead } = await supabase.from('leads')
    .select('id, phone')
    .eq('user_id', userId).ilike('phone', frag)
    .limit(1).maybeSingle();
  if (lead?.id) {
    return { type: 'lead', id: lead.id, matched_phone: lead.phone };
  }

  return { type: null, id: null, matched_phone: null };
}

module.exports = { findCrmMatchByPhone };
