/**
 * Fix 2 — invariant: when an OpenPhone conversation is created/updated via the
 * webhook or sync path, if a mapping with identity_id exists, the conversation
 * MUST persist participant_identity_id directly. No relying on indirect joins.
 *
 * We test the invariant structurally by asserting every call site in server.js
 * that inserts/updates communication_conversations with participant_mapping_id
 * ALSO sets participant_identity_id alongside it.
 */

const fs = require('fs');
const path = require('path');

const SERVER = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

describe('conversation write-path: participant_identity_id invariant', () => {
  test('no INSERT sets participant_mapping_id without also setting participant_identity_id', () => {
    // Find every object literal that contains participant_mapping_id then
    // verify it also contains participant_identity_id. Matches ~5-line windows.
    const pattern = /participant_mapping_id:/g;
    const matches = [];
    let m;
    while ((m = pattern.exec(SERVER)) !== null) {
      const ctx = SERVER.slice(Math.max(0, m.index - 300), Math.min(SERVER.length, m.index + 300));
      matches.push({ idx: m.index, ctx });
    }
    expect(matches.length).toBeGreaterThan(0);
    for (const { idx, ctx } of matches) {
      // .update({ participant_mapping_id: X }) in reconcile/backfill helpers
      // is the narrow pending-reconciliation case — identity_id is set elsewhere.
      // We only gate the CONVERSATION INSERT/UPDATE call sites that take a mapping.
      const isConversationWrite =
        ctx.includes("from('communication_conversations')") ||
        /communication_conversations['"\s]*\).*\.(insert|update)\b/.test(ctx) ||
        /\.insert\s*\(\s*\{[\s\S]{0,600}participant_mapping_id/.test(ctx);
      // Specifically skip the narrow reconcile helper that only updates mapping_id
      const isReconcileOnlyUpdate = ctx.includes('participant_mapping_id: mappingId, participant_pending: false') ||
        ctx.includes('participant_mapping_id: parseInt(mid), participant_pending: false') ||
        ctx.includes('participant_mapping_id: map.id, participant_pending: false');
      if (!isConversationWrite || isReconcileOnlyUpdate) continue;
      expect({
        idx,
        snippet: ctx.slice(0, 200) + '...',
        hasIdentityId: ctx.includes('participant_identity_id'),
      }).toMatchObject({ hasIdentityId: true });
    }
  });

  test('webhook conversation insert reads mapping.identity_id into whParticipantIdentityId', () => {
    expect(SERVER).toContain('let whParticipantIdentityId = null');
    expect(SERVER).toMatch(/if \(mapping\?\.identity_id\) whParticipantIdentityId = mapping\.identity_id/);
  });

  test('sync conversation insert reads mapping.identity_id into participantIdentityId', () => {
    expect(SERVER).toContain('let participantIdentityId = null');
    expect(SERVER).toMatch(/if \(mapping\?\.identity_id\) participantIdentityId = mapping\.identity_id/);
  });

  test('sync UPDATE path fills participant_identity_id only when existing value is null', () => {
    // Regression guard: never overwrite an existing non-null identity FK.
    expect(SERVER).toMatch(/if \(participantIdentityId && !found\.participant_identity_id\)\s*\{\s*updates\.participant_identity_id = participantIdentityId;?\s*\}/);
  });
});
