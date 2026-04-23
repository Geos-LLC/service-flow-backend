'use strict';

// Phase G — BookingKoalaSyncAdapter (STUB).
//
// Conformance template for the next sync source. Nothing is wired to this
// file yet; it exists so the shape of a new sync adapter is obvious and so
// the contract test covers it at rest.
//
// To productionize BookingKoala:
//   1. Add a 'bookingkoala' entry to lib/source-registry.js:
//        priority: 4 (after ZB),
//        is_sync_adapter: true,
//        affects_identity_priority: false,
//        external_id_columns: ['bookingkoala_customer_id']
//   2. Add a migration that adds bookingkoala_customer_id to
//      communication_participant_identities + partial unique index.
//   3. Extend SOURCE_TO_EXTERNAL_COLUMNS in lib/identity-resolver.js.
//   4. Implement pull()/push() against the BookingKoala API. The
//      toIdentityInput() and toCRMPatch() stubs below already have the
//      right shape — just replace field mappings.
//   5. Delete the `not_implemented` guards in this file.

const { OWNERSHIP_POLICIES, assertConforms } = require('../sync-adapter-contract');

const NOT_IMPLEMENTED = { implemented: false, reason: 'bookingkoala_adapter_stub' };

function buildBookingKoalaAdapter() {
  const adapter = {
    source: 'bookingkoala',
    ownership_policy: OWNERSHIP_POLICIES.NEVER_OVERWRITE_USER_EDITS,

    async pull() { return NOT_IMPLEMENTED; },
    async push() { return NOT_IMPLEMENTED; },

    toIdentityInput(bkCustomer, { userId } = {}) {
      if (!bkCustomer || !bkCustomer.id) return null;
      const fullName = [bkCustomer.first_name, bkCustomer.last_name].filter(Boolean).join(' ').trim() || null;
      return {
        userId,
        source: 'bookingkoala',
        externalId: bkCustomer.id,
        phone: bkCustomer.phone || null,
        email: bkCustomer.email || null,
        displayName: fullName,
      };
    },

    toCRMPatch(bkCustomer, existing = null) {
      if (!bkCustomer) return null;
      const source = {
        first_name: bkCustomer.first_name || null,
        last_name: bkCustomer.last_name || null,
        email: bkCustomer.email || null,
        phone: bkCustomer.phone || null,
        bookingkoala_customer_id: bkCustomer.id,
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

  // NOTE: assertConforms will fail if 'bookingkoala' is not yet in
  // source-registry.js. The stub test disables the registry check until
  // the entry is added; swap to assertSourceIsSyncAdapter on rollout.
  assertConforms(adapter, 'BookingKoalaSyncAdapter');
  return adapter;
}

module.exports = { buildBookingKoalaAdapter };
