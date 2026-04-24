const {
  VALID_ACTIONS,
  SOURCE_TO_EXTERNAL_COL,
  validateResolveRequest,
  buildMergePatch,
  buildCreateFromAmbiguity,
  buildAmbiguityAuditPatch,
} = require('../lib/ambiguity-resolver');

function mkAmbig(over = {}) {
  return {
    id: 100,
    user_id: 2,
    source: 'openphone',
    attempted_external_id: 'OP-EXT',
    attempted_phone: '2629305925',
    attempted_name: 'Linda Mau',
    attempted_normalized_name: 'linda mau',
    candidate_identity_ids: [500, 501],
    reason: 'phone_name_conflict_or_multi',
    status: 'open',
    ...over,
  };
}

describe('validateResolveRequest', () => {
  test('rejects null ambiguity', () => {
    expect(() => validateResolveRequest(null, { action: 'merge_into', target_identity_id: 1 })).toThrow('not found');
  });
  test('rejects when already resolved', () => {
    expect(() => validateResolveRequest(mkAmbig({ status: 'resolved' }), { action: 'abandon' })).toThrow('already resolved');
  });
  test('rejects when abandoned', () => {
    expect(() => validateResolveRequest(mkAmbig({ status: 'abandoned' }), { action: 'abandon' })).toThrow('already abandoned');
  });
  test('allows re-resolution of auto_merged_weak entries', () => {
    expect(() => validateResolveRequest(mkAmbig({ status: 'auto_merged_weak' }), { action: 'abandon' })).not.toThrow();
  });
  test('rejects unknown action', () => {
    expect(() => validateResolveRequest(mkAmbig(), { action: 'nuke' })).toThrow('invalid action');
  });
  test('merge_into requires integer target_identity_id', () => {
    expect(() => validateResolveRequest(mkAmbig(), { action: 'merge_into' })).toThrow('integer target_identity_id');
    expect(() => validateResolveRequest(mkAmbig(), { action: 'merge_into', target_identity_id: '500' })).toThrow('integer');
  });
  test('merge_into rejects target not in candidate list', () => {
    expect(() => validateResolveRequest(mkAmbig(), { action: 'merge_into', target_identity_id: 999 }))
      .toThrow('not in candidate list');
  });
  test('merge_into accepts target in candidate list', () => {
    expect(() => validateResolveRequest(mkAmbig(), { action: 'merge_into', target_identity_id: 500 })).not.toThrow();
  });
  test('create_new + abandon do not require target_identity_id', () => {
    expect(() => validateResolveRequest(mkAmbig(), { action: 'create_new' })).not.toThrow();
    expect(() => validateResolveRequest(mkAmbig(), { action: 'abandon' })).not.toThrow();
  });
});

describe('buildMergePatch — fill nulls only, never overwrite', () => {
  test('fills source-specific external ID when target lacks it', () => {
    const target = { id: 500, openphone_contact_id: null, normalized_phone: '2629305925', display_name: 'Linda Mau' };
    const patch = buildMergePatch(target, mkAmbig({ source: 'openphone', attempted_external_id: 'OP-123' }));
    expect(patch.openphone_contact_id).toBe('OP-123');
    expect(patch.normalized_phone).toBeUndefined(); // target already has
    expect(patch.display_name).toBeUndefined(); // target already has
    expect(patch.identity_priority_source).toBe('manual');
    expect(patch.status).toBeUndefined(); // status is a constrained enum — manual flag lives on priority_source
  });
  test('does NOT overwrite existing external ID', () => {
    const target = { id: 500, openphone_contact_id: 'OP-EXISTING' };
    const patch = buildMergePatch(target, mkAmbig({ attempted_external_id: 'OP-NEW' }));
    expect(patch?.openphone_contact_id).toBeUndefined();
  });
  test('zenbooker source → writes to zenbooker_customer_id', () => {
    const target = { id: 500 };
    const patch = buildMergePatch(target, mkAmbig({ source: 'zenbooker', attempted_external_id: 'ZB-1' }));
    expect(patch.zenbooker_customer_id).toBe('ZB-1');
  });
  test('leadbridge source → writes to leadbridge_contact_id', () => {
    const target = { id: 500 };
    const patch = buildMergePatch(target, mkAmbig({ source: 'leadbridge', attempted_external_id: 'LB-1' }));
    expect(patch.leadbridge_contact_id).toBe('LB-1');
  });
  test('fills null phone / name fields on target', () => {
    const target = { id: 500, normalized_phone: null, display_name: null, normalized_name: null };
    const patch = buildMergePatch(target, mkAmbig());
    expect(patch.normalized_phone).toBe('2629305925');
    expect(patch.display_name).toBe('Linda Mau');
    expect(patch.normalized_name).toBe('linda mau');
  });
  test('sticky manual tag always set on identity_priority_source', () => {
    const target = { id: 500, status: 'resolved_lead', identity_priority_source: 'openphone', openphone_contact_id: 'X', normalized_phone: 'Y', display_name: 'Z', normalized_name: 'z' };
    const patch = buildMergePatch(target, mkAmbig());
    // Nothing to fill but priority_source still flips to manual.
    expect(patch?.identity_priority_source).toBe('manual');
  });
  test('no-op if everything already populated and priority_source already manual', () => {
    const target = {
      id: 500, status: 'resolved_lead', identity_priority_source: 'manual',
      openphone_contact_id: 'OP-EXT',
      normalized_phone: '2629305925', display_name: 'Linda Mau', normalized_name: 'linda mau',
    };
    expect(buildMergePatch(target, mkAmbig())).toBeNull();
  });
});

describe('buildCreateFromAmbiguity — new identity from attempted data', () => {
  test('creates a row with source-specific external ID + manual tag', () => {
    const row = buildCreateFromAmbiguity(mkAmbig({ source: 'openphone', attempted_external_id: 'OP-42' }));
    expect(row.openphone_contact_id).toBe('OP-42');
    expect(row.normalized_phone).toBe('2629305925');
    expect(row.display_name).toBe('Linda Mau');
    expect(row.status).toBe('unresolved_floating'); // valid enum value; sticky flag is on priority_source
    expect(row.identity_priority_source).toBe('manual');
    expect(row.source_confidence).toBe('manual');
  });
  test('zenbooker source also gets manual priority (operator-created)', () => {
    const row = buildCreateFromAmbiguity(mkAmbig({ source: 'zenbooker', attempted_external_id: 'ZB-1' }));
    expect(row.identity_priority_source).toBe('manual');
    expect(row.zenbooker_customer_id).toBe('ZB-1');
  });
  test('returns null when no source signals at all', () => {
    expect(buildCreateFromAmbiguity(mkAmbig({
      attempted_external_id: null, attempted_phone: null, attempted_name: null, attempted_normalized_name: null,
    }))).toBeNull();
  });
  test('works with just a phone (no external id, no name)', () => {
    const row = buildCreateFromAmbiguity(mkAmbig({
      attempted_external_id: null, attempted_name: null, attempted_normalized_name: null,
    }));
    expect(row).not.toBeNull();
    expect(row.normalized_phone).toBe('2629305925');
    expect(row.display_name).toBeNull();
  });
});

describe('buildAmbiguityAuditPatch — audit trail', () => {
  test('merge_into audit', () => {
    const p = buildAmbiguityAuditPatch({ action: 'merge_into', resolvedBy: 2, resolvedIdentityId: 500 });
    expect(p.status).toBe('resolved');
    expect(p.resolved_by).toBe(2);
    expect(p.resolved_identity_id).toBe(500);
    expect(p.resolved_at).toBeDefined();
  });
  test('create_new audit', () => {
    const p = buildAmbiguityAuditPatch({ action: 'create_new', resolvedBy: 2, resolvedIdentityId: 999 });
    expect(p.status).toBe('resolved');
    expect(p.resolved_identity_id).toBe(999);
  });
  test('abandon audit — no resolved_identity_id needed', () => {
    const p = buildAmbiguityAuditPatch({ action: 'abandon', resolvedBy: 2 });
    expect(p.status).toBe('abandoned');
    expect(p.resolved_identity_id).toBeNull();
  });
});

describe('constants', () => {
  test('VALID_ACTIONS covers exactly three actions', () => {
    expect(VALID_ACTIONS).toEqual(['merge_into', 'create_new', 'abandon']);
  });
  test('SOURCE_TO_EXTERNAL_COL covers all three logical sources', () => {
    expect(Object.keys(SOURCE_TO_EXTERNAL_COL).sort()).toEqual(['leadbridge', 'openphone', 'zenbooker']);
  });
});
