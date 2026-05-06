'use strict';

/**
 * Source-account boundary — Phase 3A planner (pure functions).
 *
 * Decides which `communication_provider_accounts` rows would need to
 * exist for currently-connected OpenPhone + WhatsApp users so the rest
 * of the boundary work has FK targets to stamp on. Phase 1 only created
 * rows on *new* connect; Phase 3A backfills the existing connections
 * that pre-date Phase 1.
 *
 * No supabase calls here. The CLI in
 * scripts/source-account-provision-provider-accounts.js loads the data,
 * passes it through these planners, and (in --apply mode) calls the
 * existing ensure* helpers from lib/source-account.js to perform the
 * idempotent upsert.
 *
 * Scope guards:
 *   - LeadBridge accounts are NEVER returned in plans (planner emits
 *     only OP + WA actions). LB has its own connect-time row creator
 *     and must not be touched here.
 *   - Phone-only attribution is forbidden. A WhatsApp setting with a
 *     blank phone is reported as `skip`, never guessed.
 *   - A missing OpenPhone phoneNumberId is reported as `skip`, never
 *     synthesized.
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
 * Plan OpenPhone provider_account rows for one user.
 *
 * @param {number} userId
 * @param {Array} cachedPhoneNumbers — communication_settings.cached_phone_numbers
 *                                     (from Sigcore /integrations/openphone/numbers)
 * @param {Array} existingPaRows     — current OP rows for this user, any status
 *
 * Returns one plan entry per cached phone number:
 *   { action: 'create_openphone' | 'reuse_openphone' | 'skip_openphone',
 *     user_id, external_account_id?, phone_number?, display_name?,
 *     existing_id?, existing_status?, reason? }
 */
function planOpenPhoneAccountsForUser(userId, cachedPhoneNumbers, existingPaRows) {
  const plans = [];
  const opRows = (existingPaRows || []).filter(r => r.provider === 'openphone');
  const byExternalId = new Map(opRows.map(r => [String(r.external_account_id), r]));

  for (const pn of (cachedPhoneNumbers || [])) {
    const externalAccountId = pn?.id || pn?.phoneNumberId;
    const phoneNumber = normalizePhone(pn?.number || pn?.phoneNumber);

    if (!externalAccountId) {
      // Spec: "missing phoneNumberId is reported, not guessed"
      plans.push({
        action: 'skip_openphone',
        user_id: userId,
        phone_number: phoneNumber,
        reason: 'missing phoneNumberId in cached_phone_numbers entry',
      });
      continue;
    }

    const existing = byExternalId.get(String(externalAccountId));
    if (existing) {
      plans.push({
        action: 'reuse_openphone',
        user_id: userId,
        external_account_id: String(externalAccountId),
        phone_number: phoneNumber,
        existing_id: existing.id,
        existing_status: existing.status || null,
      });
      continue;
    }

    plans.push({
      action: 'create_openphone',
      user_id: userId,
      external_account_id: String(externalAccountId),
      phone_number: phoneNumber,
      display_name: pn?.name || (phoneNumber ? `OpenPhone ${phoneNumber}` : `OpenPhone ${externalAccountId}`),
    });
  }

  return plans;
}

/**
 * Plan a WhatsApp provider_account row for one user.
 *
 * Returns a single plan entry (WhatsApp is one row per user/phone today).
 */
function planWhatsappAccountForUser(userId, whatsappPhoneNumber, existingPaRows) {
  const phone = normalizePhone(whatsappPhoneNumber);
  if (!phone) {
    return {
      action: 'skip_whatsapp',
      user_id: userId,
      phone_number: null,
      reason: 'whatsapp_phone_number missing or unparseable',
    };
  }
  const existing = (existingPaRows || []).find(r =>
    r.provider === 'whatsapp' && normalizePhone(r.external_account_id) === phone
  );
  if (existing) {
    return {
      action: 'reuse_whatsapp',
      user_id: userId,
      phone_number: phone,
      existing_id: existing.id,
      existing_status: existing.status || null,
    };
  }
  return {
    action: 'create_whatsapp',
    user_id: userId,
    phone_number: phone,
    display_name: `WhatsApp ${phone}`,
  };
}

/**
 * Aggregate a list of plans into the report shape printed by the CLI.
 */
function aggregatePlans(plans, opts = {}) {
  const sampleSize = opts.sampleSize ?? 10;
  const counts = {
    create_openphone: 0, reuse_openphone: 0, skip_openphone: 0,
    create_whatsapp: 0, reuse_whatsapp: 0, skip_whatsapp: 0,
  };
  const samples = {
    create_openphone: [], reuse_openphone: [], skip_openphone: [],
    create_whatsapp: [], reuse_whatsapp: [], skip_whatsapp: [],
  };
  const usersScanned = new Set();

  for (const p of plans) {
    counts[p.action] = (counts[p.action] || 0) + 1;
    if (samples[p.action].length < sampleSize) samples[p.action].push(p);
    if (p.user_id != null) usersScanned.add(p.user_id);
  }

  // Surface inconsistencies that operators should review:
  //   - settings says connected, but a row exists with status='disconnected'
  //     → reuse will reactivate it. Flag in the report.
  const reactivations = plans.filter(p =>
    (p.action === 'reuse_openphone' || p.action === 'reuse_whatsapp')
    && p.existing_status && p.existing_status !== 'active'
  );

  return {
    users_scanned: usersScanned.size,
    counts,
    samples,
    inconsistencies: {
      reactivations: reactivations.length,
      reactivation_samples: reactivations.slice(0, sampleSize),
    },
  };
}

module.exports = {
  normalizePhone,
  planOpenPhoneAccountsForUser,
  planWhatsappAccountForUser,
  aggregatePlans,
};
