'use strict';

/**
 * ZB Outbound — payload + insert + intent-hash helpers.
 *
 * Phase A scaffolding: producers are NOT yet wired into application code.
 * This module provides the pure functions a producer would call. The
 * drainer (workers/zb-outbound-drainer.js) consumes the rows this writes.
 *
 * Design refs:
 *   - zb-outbound-command-confirmation.md §3.1 (schema)
 *   - §3.6.1 (pre-flight fingerprint — primary retry safety)
 *   - §3.7 (origin metadata)
 *   - §4.4 (diff semantics for list-shaped commands)
 *   - §6.7 (source_revision field set)
 *   - §6.8 (supersession)
 *
 * Invariants enforced here:
 *   - event_id is uuidv7 (sortable)
 *   - payload_json frozen at insert
 *   - intent_hash computed over the *projected post-state* (§4.4)
 *   - source_revision computed over current ZB-side fingerprint
 *   - command_type → field_group mapping is the single source of truth
 */

const crypto = require('crypto');

const ENABLED = () => String(process.env.ZB_OUTBOUND_ENABLED || 'false').toLowerCase() === 'true';
const DRY_RUN = () => String(process.env.ZB_OUTBOUND_DRY_RUN || 'true').toLowerCase() === 'true';
const FROZEN = () => String(process.env.ZB_OUTBOUND_GLOBAL_FREEZE || 'true').toLowerCase() === 'true';

// command_type → field_group (design §6.9)
const FIELD_GROUP = Object.freeze({
  'job.create':            'create',
  'job.reschedule':        'schedule',
  'job.assign_providers':  'assignment',
  'job.cancel':            'lifecycle',
  'customer.upsert':       'customer',
});

const ALLOWED_COMMAND_TYPES = Object.freeze(Object.keys(FIELD_GROUP));

const VALID_ORIGINS = Object.freeze(['user', 'automation', 'api', 'reconcile', 'migration']);

// uuidv7 — same shape as lb-outbound-delivery uses.
function uuidv7() {
  const timeMs = Date.now();
  const timeHex = timeMs.toString(16).padStart(12, '0');
  const rand = crypto.randomBytes(10);
  rand[0] = (rand[0] & 0x0f) | 0x70;
  rand[2] = (rand[2] & 0x3f) | 0x80;
  return (
    timeHex.slice(0, 8) + '-' +
    timeHex.slice(8, 12) + '-' +
    rand.slice(0, 2).toString('hex') + '-' +
    rand.slice(2, 4).toString('hex') + '-' +
    rand.slice(4, 10).toString('hex')
  );
}

// Canonical-JSON hash for fingerprints and intent_hash.
// Sort object keys; arrays preserved in their canonical order
// (caller is responsible for pre-sorting lists per §6.7).
function canonicalHash(obj) {
  const canon = JSON.stringify(obj, Object.keys(obj).sort());
  return crypto.createHash('sha256').update(canon).digest('hex').slice(0, 16);
}

/**
 * Compute the source_revision fingerprint for the relevant field set
 * given a command_type and a current ZB resource snapshot.
 *
 * Per design §6.7. The returned object is BOTH:
 *   - the value stored in source_revision column (jsonb)
 *   - the input to canonicalHash for intent_hash comparison
 */
function computeSourceRevision(commandType, zbResource) {
  if (!zbResource || typeof zbResource !== 'object') {
    return {};
  }
  switch (commandType) {
    case 'job.reschedule':
      return {
        start_date: zbResource.start_date || null,
        status: zbResource.status || null,
        canceled: !!zbResource.canceled,
      };
    case 'job.assign_providers':
      return {
        assigned_providers: (zbResource.assigned_providers || [])
          .map((p) => (typeof p === 'string' ? p : p && p.id))
          .filter(Boolean)
          .sort(),
        status: zbResource.status || null,
        canceled: !!zbResource.canceled,
      };
    case 'job.cancel':
      return {
        status: zbResource.status || null,
        canceled: !!zbResource.canceled,
      };
    case 'job.create':
    case 'customer.upsert':
      return {};
    default:
      return {};
  }
}

/**
 * Project the post-mutation state from (pre-state, payload).
 * Used to compute intent_hash per §4.4.
 *
 * For diff-shaped commands (assign_providers), apply the diff.
 * For atomic mutations (reschedule, cancel), the post-state is the
 * payload's intended value.
 */
function projectPostState(commandType, sourceRevision, payload) {
  switch (commandType) {
    case 'job.reschedule':
      return {
        start_date: payload && payload.start_date,
        status: sourceRevision.status,
        canceled: sourceRevision.canceled,
      };
    case 'job.assign_providers': {
      // payload is { assign: [...], unassign: [...], notify: bool }
      const current = new Set(sourceRevision.assigned_providers || []);
      (payload && payload.unassign || []).forEach((id) => current.delete(id));
      (payload && payload.assign || []).forEach((id) => current.add(id));
      return {
        assigned_providers: Array.from(current).sort(),
        status: sourceRevision.status,
        canceled: sourceRevision.canceled,
      };
    }
    case 'job.cancel':
      return {
        status: 'cancelled',
        canceled: true,
      };
    case 'job.create':
    case 'customer.upsert':
      return payload || {};
    default:
      return {};
  }
}

/**
 * Validate payload shape per command_type. Returns { ok, errors }.
 * Enforces design §4.4 diff invariant for list-shaped mutations.
 */
function validatePayload(commandType, payload) {
  const errors = [];
  if (!payload || typeof payload !== 'object') {
    return { ok: false, errors: ['payload must be an object'] };
  }

  switch (commandType) {
    case 'job.create':
      if (!payload.customer_id && !payload.customer) errors.push('customer_id or customer required');
      if (!payload.start_date && !payload.timeslot && !payload.timeslot_id) {
        errors.push('start_date / timeslot / timeslot_id required');
      }
      if (!Array.isArray(payload.services) || payload.services.length === 0) {
        errors.push('services array required');
      }
      break;

    case 'job.reschedule':
      if (!payload.start_date) errors.push('start_date required');
      break;

    case 'job.assign_providers':
      // §4.4 diff invariant
      if (!Array.isArray(payload.assign)) errors.push('assign array required');
      if (!Array.isArray(payload.unassign)) errors.push('unassign array required');
      if (typeof payload.notify !== 'boolean') errors.push('notify boolean required');
      // Flat replacement arrays are explicitly forbidden
      if ('assigned_providers' in payload) {
        errors.push('assigned_providers replacement array forbidden — use {assign, unassign, notify} diff per §4.4');
      }
      break;

    case 'job.cancel':
      // body is mostly empty; cancellation_reason is SF-side only per design §1.1
      break;

    case 'customer.upsert':
      if (!payload.name) errors.push('name required');
      break;

    default:
      errors.push(`unknown command_type: ${commandType}`);
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Build a complete row for insert. Pure — no I/O.
 *
 * Returns { row, intent_hash, post_state_fingerprint } so the caller
 * can write the row AND inspect what was computed.
 */
function buildCommandRow({
  user_id,
  command_type,
  sf_job_id,
  sf_customer_id,
  zenbooker_id,
  payload,
  source_revision,
  requested_by_user_id,
  requested_by_actor,
  origin,
}) {
  if (!ALLOWED_COMMAND_TYPES.includes(command_type)) {
    throw new Error(`buildCommandRow: unknown command_type=${command_type}`);
  }
  const o = origin || 'user';
  if (!VALID_ORIGINS.includes(o)) {
    throw new Error(`buildCommandRow: invalid origin=${o}`);
  }

  const validation = validatePayload(command_type, payload);
  if (!validation.ok) {
    throw new Error(`buildCommandRow: invalid payload for ${command_type}: ${validation.errors.join(', ')}`);
  }

  const event_id = `zboe_${uuidv7()}`;
  const post_state = projectPostState(command_type, source_revision || {}, payload);
  const intent_hash = canonicalHash(post_state);
  const field_group = FIELD_GROUP[command_type];

  return {
    row: {
      event_id,
      user_id,
      command_type,
      sf_job_id: sf_job_id != null ? String(sf_job_id) : null,
      sf_customer_id: sf_customer_id != null ? String(sf_customer_id) : null,
      zenbooker_id: zenbooker_id || null,
      payload_json: payload,
      source_revision: source_revision || {},
      intent_hash,
      state: 'pending',
      attempts: 0,
      next_attempt_at: new Date().toISOString(),
      requested_at: new Date().toISOString(),
      requested_by_user_id: requested_by_user_id || null,
      requested_by_actor: requested_by_actor || { type: 'system' },
      field_group,
      origin: o,
    },
    intent_hash,
    post_state,
  };
}

module.exports = {
  // pure helpers
  uuidv7,
  canonicalHash,
  computeSourceRevision,
  projectPostState,
  validatePayload,
  buildCommandRow,
  // constants
  ALLOWED_COMMAND_TYPES,
  FIELD_GROUP,
  VALID_ORIGINS,
  // flags
  ENABLED,
  DRY_RUN,
  FROZEN,
};
