'use strict';

/**
 * Source-account boundary helpers — Phase 1 (write-side stamping only).
 *
 * Today only LeadBridge writes to communication_provider_accounts. This
 * module gives the OpenPhone and WhatsApp connect/sync paths the same
 * shape so disconnect can flip status uniformly later.
 *
 * No read-side enforcement here — the read-side gate stays behind
 * SOURCE_ACCOUNT_BOUNDARY_ENFORCED in lib/feature-flags.js.
 *
 * See docs/security/source-account-boundary-plan.md.
 */

function normalizePhone(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/[^\d+]/g, '');
  if (digits.startsWith('+')) return digits;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return digits || null;
}

/**
 * Upsert a communication_provider_accounts row for an OpenPhone phone.
 *
 * One row per phone number (one OpenPhone tenant typically owns many
 * numbers). external_account_id = Sigcore's phoneNumberId, which is
 * stable across syncs.
 *
 * Returns the row's id, or null if the input is unusable.
 */
async function ensureOpenPhoneProviderAccount(supabase, logger, userId, phoneNumberObj) {
  if (!supabase || !userId || !phoneNumberObj) return null;

  const externalAccountId = phoneNumberObj.id || phoneNumberObj.phoneNumberId;
  const number = normalizePhone(phoneNumberObj.number || phoneNumberObj.phoneNumber);
  if (!externalAccountId) return null;

  const displayName = phoneNumberObj.name
    || (number ? `OpenPhone ${number}` : `OpenPhone ${externalAccountId}`);

  // Find existing
  const { data: existing } = await supabase.from('communication_provider_accounts')
    .select('id, status')
    .eq('user_id', userId)
    .eq('provider', 'openphone')
    .eq('channel', 'openphone')
    .eq('external_account_id', externalAccountId)
    .maybeSingle();

  if (existing) {
    // Reactivate on reconnect, refresh display name + metadata
    const updates = {
      display_name: displayName,
      status: 'active',
      metadata: {
        phoneNumber: number,
        symbol: phoneNumberObj.symbol || null,
        capabilities: phoneNumberObj.capabilities || null,
      },
      updated_at: new Date().toISOString(),
    };
    await supabase.from('communication_provider_accounts').update(updates).eq('id', existing.id);
    return existing.id;
  }

  const { data: created, error } = await supabase.from('communication_provider_accounts').insert({
    user_id: userId,
    provider: 'openphone',
    channel: 'openphone',
    external_account_id: String(externalAccountId),
    display_name: displayName,
    status: 'active',
    metadata: {
      phoneNumber: number,
      symbol: phoneNumberObj.symbol || null,
      capabilities: phoneNumberObj.capabilities || null,
    },
  }).select('id').single();

  if (error) {
    if (logger?.warn) logger.warn(`[SourceAccount] OP upsert error: ${error.message}`);
    return null;
  }
  return created?.id || null;
}

/**
 * Upsert a communication_provider_accounts row for a WhatsApp connection.
 * One row per connected WhatsApp number per user.
 */
async function ensureWhatsappProviderAccount(supabase, logger, userId, phoneNumber) {
  if (!supabase || !userId) return null;
  const normalized = normalizePhone(phoneNumber);
  if (!normalized) return null;

  const { data: existing } = await supabase.from('communication_provider_accounts')
    .select('id')
    .eq('user_id', userId)
    .eq('provider', 'whatsapp')
    .eq('channel', 'whatsapp')
    .eq('external_account_id', normalized)
    .maybeSingle();

  if (existing) {
    await supabase.from('communication_provider_accounts').update({
      display_name: `WhatsApp ${normalized}`,
      status: 'active',
      metadata: { phoneNumber: normalized },
      updated_at: new Date().toISOString(),
    }).eq('id', existing.id);
    return existing.id;
  }

  const { data: created, error } = await supabase.from('communication_provider_accounts').insert({
    user_id: userId,
    provider: 'whatsapp',
    channel: 'whatsapp',
    external_account_id: normalized,
    display_name: `WhatsApp ${normalized}`,
    status: 'active',
    metadata: { phoneNumber: normalized },
  }).select('id').single();

  if (error) {
    if (logger?.warn) logger.warn(`[SourceAccount] WhatsApp upsert error: ${error.message}`);
    return null;
  }
  return created?.id || null;
}

/**
 * Look up the OpenPhone provider_accounts row id for a given Sigcore
 * phoneNumberId. Used by the OP sync write-path to stamp conversations
 * + messages without a second connect call.
 */
async function resolveOpenPhoneProviderAccountByPhoneNumberId(supabase, userId, phoneNumberId) {
  if (!supabase || !userId || !phoneNumberId) return null;
  const { data } = await supabase.from('communication_provider_accounts')
    .select('id')
    .eq('user_id', userId)
    .eq('provider', 'openphone')
    .eq('external_account_id', String(phoneNumberId))
    .maybeSingle();
  return data?.id || null;
}

/**
 * Look up the OpenPhone provider_accounts row id for a given endpoint
 * phone (E.164). Used by the OP webhook write-path where we only have
 * the phone, not the phoneNumberId.
 */
async function resolveOpenPhoneProviderAccountByEndpointPhone(supabase, userId, endpointPhone) {
  if (!supabase || !userId || !endpointPhone) return null;
  const normalized = normalizePhone(endpointPhone);
  if (!normalized) return null;

  // metadata->>phoneNumber is the canonical write key from
  // ensureOpenPhoneProviderAccount above.
  const { data } = await supabase.from('communication_provider_accounts')
    .select('id, metadata')
    .eq('user_id', userId)
    .eq('provider', 'openphone');

  if (!data?.length) return null;
  const hit = data.find(r => normalizePhone(r.metadata?.phoneNumber) === normalized);
  return hit?.id || null;
}

/**
 * Look up the WhatsApp provider_accounts row id for the given user's
 * connected WhatsApp endpoint phone. There is at most one per user
 * today, so the endpoint phone is the natural key.
 */
async function resolveWhatsappProviderAccount(supabase, userId, endpointPhone) {
  if (!supabase || !userId) return null;
  const normalized = normalizePhone(endpointPhone);
  if (!normalized) return null;
  const { data } = await supabase.from('communication_provider_accounts')
    .select('id')
    .eq('user_id', userId)
    .eq('provider', 'whatsapp')
    .eq('external_account_id', normalized)
    .maybeSingle();
  return data?.id || null;
}

module.exports = {
  normalizePhone,
  ensureOpenPhoneProviderAccount,
  ensureWhatsappProviderAccount,
  resolveOpenPhoneProviderAccountByPhoneNumberId,
  resolveOpenPhoneProviderAccountByEndpointPhone,
  resolveWhatsappProviderAccount,
};
