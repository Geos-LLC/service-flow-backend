'use strict';

// Phase G — ZenbookerSyncAdapter.
//
// Concrete SyncAdapter implementation for Zenbooker. Does NOT re-implement
// the ZB sync internals — the heavy lifting still lives in zenbooker-sync.js
// (ZB API client, mapping helpers, webhook handlers, reconciliation cron).
// This wrapper exposes the four contract methods so the runtime can treat
// every sync source uniformly:
//
//   pull(ctx)                 — fetch new/updated ZB customers since last sync
//   push(ctx, change)         — mirror SF changes out to ZB (job status, etc.)
//   toIdentityInput(zbRow)    — convert a ZB customer payload into the shape
//                               resolveIdentity expects (source='zenbooker')
//   toCRMPatch(zbRow)         — convert a ZB customer into the customer-table
//                               patch, honoring the ownership_policy
//
// The existing upsertCustomerFromZB in zenbooker-sync.js is the runtime
// execution path; this adapter wraps it so future orchestrators
// (BookingKoala, Google Sheets) plug in via the same interface.

const { OWNERSHIP_POLICIES, assertConforms } = require('../sync-adapter-contract');

function buildZenbookerAdapter({ zenbookerModule } = {}) {
  const adapter = {
    source: 'zenbooker',
    ownership_policy: OWNERSHIP_POLICIES.NEVER_OVERWRITE_USER_EDITS,

    /**
     * pull({ userId, apiKey, since }) — delegates to zenbookerModule.syncCustomers
     * when present (production path). In tests or when the module is absent,
     * returns an empty result without throwing.
     */
    async pull(ctx = {}) {
      if (!zenbookerModule?.syncCustomers) return { fetched: 0 };
      return zenbookerModule.syncCustomers(ctx.userId, ctx.apiKey);
    },

    /**
     * push(ctx, change) — mirrors SF-side changes to ZB.
     * Currently Zenbooker's outbound pipe is its job-status webhook + payment
     * reconcile cron, both living in zenbooker-sync.js. Future adapters will
     * hook here. No-op when absent.
     */
    async push(ctx = {}, change = {}) {
      if (!zenbookerModule?.pushChange) return { pushed: false, reason: 'not_implemented' };
      return zenbookerModule.pushChange(ctx.userId, change);
    },

    /**
     * toIdentityInput(zbCustomer) — shape a ZB customer record for the
     * shared resolveIdentity. Matches the calls already made inside
     * upsertCustomerFromZB; lifted out so other orchestrators (e.g. a
     * future cross-source merge tool) can drive the same transform.
     */
    toIdentityInput(zbCustomer, { userId } = {}) {
      if (!zbCustomer || !zbCustomer.id) return null;
      const firstName = zbCustomer.first_name || zbCustomer.firstName || null;
      const lastName = zbCustomer.last_name || zbCustomer.lastName || null;
      const fullName = [firstName, lastName].filter(Boolean).join(' ').trim() || zbCustomer.name || null;
      return {
        userId,
        source: 'zenbooker',
        externalId: zbCustomer.id,
        phone: zbCustomer.phone || null,
        email: zbCustomer.email || null,
        displayName: fullName,
      };
    },

    /**
     * toCRMPatch(zbCustomer, existing) — produce a customers-table patch
     * under the ownership_policy. With NEVER_OVERWRITE_USER_EDITS, only
     * fields currently null on `existing` are populated.
     *
     * Returns null when there's nothing to patch.
     */
    toCRMPatch(zbCustomer, existing = null) {
      if (!zbCustomer) return null;
      const source = {
        first_name: zbCustomer.first_name || zbCustomer.firstName || null,
        last_name: zbCustomer.last_name || zbCustomer.lastName || null,
        email: zbCustomer.email || null,
        phone: zbCustomer.phone || null,
        address: zbCustomer.service_address?.line1 || zbCustomer.address || null,
        city: zbCustomer.service_address?.city || zbCustomer.city || null,
        state: zbCustomer.service_address?.state || zbCustomer.state || null,
        zip_code: zbCustomer.service_address?.postal_code || zbCustomer.zip_code || null,
        zenbooker_id: zbCustomer.id,
      };
      const patch = {};
      const fillNullsOnly = adapter.ownership_policy !== OWNERSHIP_POLICIES.OVERWRITE;
      for (const [col, val] of Object.entries(source)) {
        if (val == null) continue;
        if (fillNullsOnly) {
          if (!existing || existing[col] == null) patch[col] = val;
        } else {
          patch[col] = val;
        }
      }
      return Object.keys(patch).length === 0 ? null : patch;
    },
  };

  assertConforms(adapter, 'ZenbookerSyncAdapter');
  return adapter;
}

module.exports = { buildZenbookerAdapter };
