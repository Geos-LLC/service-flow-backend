/**
 * Phase A contract test — command build + dedup invariants.
 *
 * Scope:
 *   - buildCommandRow validates payload per command_type
 *   - intent_hash is deterministic over projected post-state (§4.4)
 *   - same input → same intent_hash (idempotency at the hash layer)
 *   - assign_providers diff body REQUIRED; assigned_providers replacement FORBIDDEN
 *   - origin defaulted to 'user'; rejects invalid origin
 *   - event_id is unique per call (uuidv7 monotonic)
 */

const {
  buildCommandRow,
  validatePayload,
  computeSourceRevision,
  projectPostState,
  canonicalHash,
  ALLOWED_COMMAND_TYPES,
} = require('../lib/zb-outbound-delivery');

describe('buildCommandRow validation', () => {
  test('rejects unknown command_type', () => {
    expect(() => buildCommandRow({
      user_id: 'u1', command_type: 'job.unknown', payload: {}, source_revision: {},
    })).toThrow(/unknown command_type/);
  });

  test('rejects invalid origin', () => {
    expect(() => buildCommandRow({
      user_id: 'u1', command_type: 'job.cancel', payload: {}, source_revision: {}, origin: 'bogus',
    })).toThrow(/invalid origin/);
  });

  test('job.assign_providers requires {assign, unassign, notify} diff', () => {
    const r = validatePayload('job.assign_providers', { assigned_providers: ['p1'] });
    expect(r.ok).toBe(false);
    expect(r.errors.join('; ')).toMatch(/assigned_providers replacement array forbidden/);
  });

  test('job.assign_providers accepts diff body', () => {
    const r = validatePayload('job.assign_providers', { assign: ['p2'], unassign: ['p1'], notify: false });
    expect(r.ok).toBe(true);
  });

  test('job.reschedule requires start_date', () => {
    expect(validatePayload('job.reschedule', {}).ok).toBe(false);
    expect(validatePayload('job.reschedule', { start_date: '2026-06-01T10:00:00Z' }).ok).toBe(true);
  });

  test('customer.upsert requires name', () => {
    expect(validatePayload('customer.upsert', {}).ok).toBe(false);
    expect(validatePayload('customer.upsert', { name: 'X' }).ok).toBe(true);
  });

  test('valid build → row + intent_hash + post_state', () => {
    const r = buildCommandRow({
      user_id: 'u1',
      command_type: 'job.assign_providers',
      sf_job_id: 'sf-99',
      zenbooker_id: 'zb-99',
      payload: { assign: ['p2'], unassign: ['p1'], notify: false },
      source_revision: { assigned_providers: ['p1'], status: 'scheduled', canceled: false },
      requested_by_user_id: 'u1',
    });
    expect(r.row.command_type).toBe('job.assign_providers');
    expect(r.row.field_group).toBe('assignment');
    expect(r.row.origin).toBe('user');
    expect(r.row.state).toBe('pending');
    expect(r.intent_hash).toBeDefined();
    expect(r.post_state.assigned_providers).toEqual(['p2']); // p1 removed, p2 added
    expect(r.row.event_id).toMatch(/^zboe_/);
  });
});

describe('intent_hash determinism + projection', () => {
  test('same diff → same intent_hash', () => {
    const a = buildCommandRow({
      user_id: 'u1', command_type: 'job.assign_providers', sf_job_id: 'j1',
      payload: { assign: ['p2'], unassign: ['p1'], notify: false },
      source_revision: { assigned_providers: ['p1'], status: 'scheduled', canceled: false },
    });
    const b = buildCommandRow({
      user_id: 'u1', command_type: 'job.assign_providers', sf_job_id: 'j1',
      payload: { assign: ['p2'], unassign: ['p1'], notify: false },
      source_revision: { assigned_providers: ['p1'], status: 'scheduled', canceled: false },
    });
    expect(a.intent_hash).toBe(b.intent_hash);
    // event_id differs (uuidv7 distinct)
    expect(a.row.event_id).not.toBe(b.row.event_id);
  });

  test('different diffs converging to same post-state hash equally (§4.4)', () => {
    // From [p1, p2] → diff "unassign p1" → [p2]
    const a = projectPostState('job.assign_providers',
      { assigned_providers: ['p1', 'p2'], status: 'scheduled', canceled: false },
      { assign: [], unassign: ['p1'], notify: false });
    // From [p1] → diff "unassign p1, assign p2" → [p2]
    const b = projectPostState('job.assign_providers',
      { assigned_providers: ['p1'], status: 'scheduled', canceled: false },
      { assign: ['p2'], unassign: ['p1'], notify: false });
    expect(a.assigned_providers).toEqual(['p2']);
    expect(b.assigned_providers).toEqual(['p2']);
    expect(canonicalHash(a)).toBe(canonicalHash(b));
  });

  test('computeSourceRevision sorts assigned_providers (canonical)', () => {
    const rev = computeSourceRevision('job.assign_providers', {
      assigned_providers: [{ id: 'p2' }, { id: 'p1' }],
      status: 'scheduled',
      canceled: false,
    });
    expect(rev.assigned_providers).toEqual(['p1', 'p2']);
  });

  test('ALLOWED_COMMAND_TYPES is exactly the 5 Phase 1 commands', () => {
    expect(ALLOWED_COMMAND_TYPES.slice().sort()).toEqual([
      'customer.upsert', 'job.assign_providers', 'job.cancel', 'job.create', 'job.reschedule',
    ]);
  });
});
