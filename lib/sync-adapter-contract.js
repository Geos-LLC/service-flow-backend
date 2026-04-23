'use strict';

// Phase G — Sync-adapter contract.
//
// A SyncAdapter is a bidirectional mirror for an external customer-of-record
// system (Zenbooker today; BookingKoala / Google Sheets next). It is NOT an
// identity authority. All adapters:
//
//   - run their matches through the shared identity-resolver (source='zenbooker'
//     or another registered sync source) — never directly enrich identities
//   - receive resolveIdentity result and apply CRM business rules
//   - fill nulls only on CRM entities (leads / customers) — never overwrite
//     user-edited fields
//   - declare their ownership_policy so runtime knows how aggressively the
//     adapter may overwrite external values
//
// Ownership policies (hierarchy of conservatism):
//
//   'never_overwrite_user_edits' — adopt existing SF row, fill nulls only.
//                                   Default for sync sources where SF is truth.
//   'fill_nulls'                  — similar to above; alias for readability.
//   'overwrite'                   — adapter may rewrite non-null SF fields.
//                                   Use ONLY when the external system is
//                                   authoritative (rare; not used today).
//
// A correct SyncAdapter implementation exposes this interface. Contract tests
// (tests/sync-adapter-contract.test.js) assert conformance of every adapter.

const OWNERSHIP_POLICIES = Object.freeze({
  NEVER_OVERWRITE_USER_EDITS: 'never_overwrite_user_edits',
  FILL_NULLS: 'fill_nulls',
  OVERWRITE: 'overwrite',
});

const REQUIRED_METHODS = Object.freeze([
  'pull',
  'push',
  'toIdentityInput',
  'toCRMPatch',
]);

const REQUIRED_FIELDS = Object.freeze([
  'source',               // string — must match a registered sync source in lib/source-registry.js
  'ownership_policy',     // one of OWNERSHIP_POLICIES.*
]);

/**
 * Validate an adapter instance/factory output against the contract.
 * Throws descriptive errors rather than returning booleans — intended to
 * be called at startup so misconfigured adapters fail loudly.
 *
 * @param {object} adapter  — the adapter object/instance
 * @param {string} name     — human-readable adapter name (for errors)
 */
function assertConforms(adapter, name = 'adapter') {
  if (!adapter || typeof adapter !== 'object') {
    throw new Error(`[SyncAdapterContract] ${name}: must be an object`);
  }

  for (const field of REQUIRED_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(adapter, field)) {
      throw new Error(`[SyncAdapterContract] ${name}: missing required field "${field}"`);
    }
  }

  if (typeof adapter.source !== 'string' || adapter.source.trim() === '') {
    throw new Error(`[SyncAdapterContract] ${name}: field "source" must be a non-empty string`);
  }

  const validPolicies = Object.values(OWNERSHIP_POLICIES);
  if (!validPolicies.includes(adapter.ownership_policy)) {
    throw new Error(
      `[SyncAdapterContract] ${name}: ownership_policy must be one of ${JSON.stringify(validPolicies)}; ` +
      `got "${adapter.ownership_policy}"`
    );
  }

  for (const method of REQUIRED_METHODS) {
    if (typeof adapter[method] !== 'function') {
      throw new Error(`[SyncAdapterContract] ${name}: missing required method "${method}()"`);
    }
  }
}

/**
 * Convenience: build a "source registry check" to ensure the adapter's
 * `source` matches a source registered in lib/source-registry.js with
 * sync_adapter: true and affects_identity_priority: false.
 */
function assertSourceIsSyncAdapter(adapter, sourceRegistry, name = 'adapter') {
  const entry = sourceRegistry[adapter.source];
  if (!entry) {
    throw new Error(`[SyncAdapterContract] ${name}: source "${adapter.source}" is not in the registry`);
  }
  if (!entry.is_sync_adapter) {
    throw new Error(
      `[SyncAdapterContract] ${name}: source "${adapter.source}" is registered but is_sync_adapter=false`
    );
  }
  if (entry.affects_identity_priority) {
    throw new Error(
      `[SyncAdapterContract] ${name}: source "${adapter.source}" must have affects_identity_priority=false`
    );
  }
}

module.exports = {
  OWNERSHIP_POLICIES,
  REQUIRED_METHODS,
  REQUIRED_FIELDS,
  assertConforms,
  assertSourceIsSyncAdapter,
};
