'use strict';

/**
 * P1.4 (Synchronization Constitution §0 P3 / §6.10) — tenant resolution for
 * whatsapp.status.change events.
 *
 * Before P1.4 the inline handler did this:
 *   const { data: settings } = await supabase.from('communication_settings')
 *     .select('user_id, whatsapp_connected')
 *     .or('whatsapp_connected.eq.true,whatsapp_phone_number.neq.null')
 *     .limit(1).maybeSingle();
 *
 * That is a global scan: it picks an arbitrary user with WhatsApp connected
 * and updates their row, regardless of which tenant the status change
 * actually belonged to. With two tenants both having WhatsApp connected, a
 * status event for tenant B's phone could flip tenant A's `whatsapp_connected`
 * to `false`. The audit (D11) tagged this as HIGH.
 *
 * Resolution order (first match wins):
 *
 *   1. **HMAC-verified userId** from `X-Sigcore-Signature` — the outer
 *      webhook handler computes this. When present it is the strongest
 *      possible scope (Sigcore signed the event with the per-tenant secret).
 *      A cross-tenant defense layer runs: if HMAC says user A but the phone
 *      is already claimed by user B in `communication_settings`, the event
 *      is dropped with a `cross_tenant_mismatch` audit.
 *
 *   2. **Deterministic endpoint-route lookup** on the phone — the same
 *      pipeline used for inbound WhatsApp messages. Only applied when
 *      verifiedUserId is null (e.g. SIGCORE_WEBHOOK_HMAC_REQUIRED OFF
 *      in dev/staging).
 *
 *   3. **Phone-claim lookup** in `communication_settings` — defense in
 *      depth. When exactly one user owns this phone, attribute the event
 *      to them. Ambiguous (>1 claimants) → drop.
 *
 *   4. No match → drop with `no_tenant` audit. The event is NOT applied
 *      to anyone (no global scan, no "first available user" fallback).
 *
 * Return shape (deterministic; tests pin every outcome):
 *   { ok: true,  userId: number, resolutionPath: 'hmac' | 'route:A' | 'route:D' | 'phone_claim' }
 *   { ok: false, outcome: 'drop_cross_tenant_mismatch' | 'drop_phone_claim_ambiguous' | 'drop_no_tenant', ... }
 */

async function resolveWhatsAppStatusTenant(supabase, { verifiedUserId, phoneNumber, resolveEndpointRoute }) {
  // ── Step 1: HMAC-verified userId is authoritative when present ─────────
  if (verifiedUserId) {
    if (phoneNumber) {
      const { data: claim } = await supabase.from('communication_settings')
        .select('user_id')
        .eq('whatsapp_phone_number', phoneNumber)
        .maybeSingle();
      if (claim && claim.user_id !== verifiedUserId) {
        return {
          ok: false,
          outcome: 'drop_cross_tenant_mismatch',
          hmac_user_id: verifiedUserId,
          phone_owner_user_id: claim.user_id,
        };
      }
    }
    return { ok: true, userId: verifiedUserId, resolutionPath: 'hmac' };
  }

  // ── Step 2: deterministic endpoint-route lookup ────────────────────────
  if (phoneNumber && typeof resolveEndpointRoute === 'function') {
    const routeResult = await resolveEndpointRoute({
      provider: 'whatsapp',
      phoneNumber,
      channel: 'whatsapp',
      endpointId: `wa_${phoneNumber}`,
    });
    if (routeResult?.routed && routeResult.userId) {
      return {
        ok: true,
        userId: routeResult.userId,
        resolutionPath: `route:${routeResult.step || 'X'}`,
      };
    }
  }

  // ── Step 3: phone-claim defense-in-depth lookup ────────────────────────
  if (phoneNumber) {
    const { data: claimedBy } = await supabase.from('communication_settings')
      .select('user_id')
      .eq('whatsapp_phone_number', phoneNumber)
      .limit(2);
    if (claimedBy?.length === 1) {
      return { ok: true, userId: claimedBy[0].user_id, resolutionPath: 'phone_claim' };
    }
    if (claimedBy?.length > 1) {
      return {
        ok: false,
        outcome: 'drop_phone_claim_ambiguous',
        matched_count: claimedBy.length,
      };
    }
  }

  // ── Step 4: no scope, no update ────────────────────────────────────────
  return {
    ok: false,
    outcome: 'drop_no_tenant',
    reason: !phoneNumber ? 'no_phone_and_no_hmac' : 'phone_not_claimed_and_unrouted',
  };
}

module.exports = { resolveWhatsAppStatusTenant };
