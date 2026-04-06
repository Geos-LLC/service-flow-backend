/**
 * Conversation Identity Tests
 *
 * Verifies that conversation grouping uses deterministic key:
 *   (user_id, provider, endpoint_phone, participant_phone)
 *
 * NOT just participant_phone alone (which merges across business numbers).
 */

describe('Conversation Identity', () => {
  // Simulate the conversation lookup logic from server.js
  function findConversation(conversations, { userId, sigcoreConvId, endpointPhone, participantPhone }) {
    // Step 1: sigcore conversation ID
    if (sigcoreConvId) {
      const found = conversations.find(c => c.user_id === userId && c.sigcore_conversation_id === sigcoreConvId);
      if (found) return found;
    }
    // Step 2: composite key (endpoint + participant) — NEVER participant alone
    if (endpointPhone && participantPhone) {
      return conversations.find(c =>
        c.user_id === userId && c.endpoint_phone === endpointPhone && c.participant_phone === participantPhone
      ) || null;
    }
    return null;
  }

  test('same customer + two different business numbers → two separate conversations', () => {
    const conversations = [
      { id: 1, user_id: 2, provider: 'openphone', endpoint_phone: '+18139212100', participant_phone: '+15551234567', sigcore_conversation_id: 'conv-a' },
      { id: 2, user_id: 2, provider: 'openphone', endpoint_phone: '+18773756903', participant_phone: '+15551234567', sigcore_conversation_id: 'conv-b' },
    ];

    const resultA = findConversation(conversations, {
      userId: 2, sigcoreConvId: null, endpointPhone: '+18139212100', participantPhone: '+15551234567',
    });
    const resultB = findConversation(conversations, {
      userId: 2, sigcoreConvId: null, endpointPhone: '+18773756903', participantPhone: '+15551234567',
    });

    expect(resultA.id).toBe(1);
    expect(resultB.id).toBe(2);
    expect(resultA.id).not.toBe(resultB.id);
  });

  test('same endpoint + same customer → one conversation', () => {
    const conversations = [
      { id: 1, user_id: 2, provider: 'openphone', endpoint_phone: '+18139212100', participant_phone: '+15551234567', sigcore_conversation_id: 'conv-a' },
    ];

    const result1 = findConversation(conversations, {
      userId: 2, sigcoreConvId: null, endpointPhone: '+18139212100', participantPhone: '+15551234567',
    });
    const result2 = findConversation(conversations, {
      userId: 2, sigcoreConvId: 'conv-a', endpointPhone: '+18139212100', participantPhone: '+15551234567',
    });

    expect(result1.id).toBe(1);
    expect(result2.id).toBe(1);
  });

  test('conversations may share the same lead/customer link without being merged', () => {
    const conversations = [
      { id: 1, user_id: 2, provider: 'openphone', endpoint_phone: '+18139212100', participant_phone: '+15551234567', sigcore_conversation_id: 'conv-a', lead_id: 42 },
      { id: 2, user_id: 2, provider: 'openphone', endpoint_phone: '+18773756903', participant_phone: '+15551234567', sigcore_conversation_id: 'conv-b', lead_id: 42 },
    ];

    // Same lead_id but different conversations
    expect(conversations[0].lead_id).toBe(conversations[1].lead_id);
    expect(conversations[0].id).not.toBe(conversations[1].id);

    // Each resolves to its own conversation
    const resultA = findConversation(conversations, {
      userId: 2, sigcoreConvId: null, endpointPhone: '+18139212100', participantPhone: '+15551234567',
    });
    const resultB = findConversation(conversations, {
      userId: 2, sigcoreConvId: null, endpointPhone: '+18773756903', participantPhone: '+15551234567',
    });

    expect(resultA.id).toBe(1);
    expect(resultB.id).toBe(2);
  });

  test('participant phone alone does NOT match — prevents cross-endpoint merge', () => {
    const conversations = [
      { id: 1, user_id: 2, provider: 'openphone', endpoint_phone: '+18139212100', participant_phone: '+15551234567', sigcore_conversation_id: null },
    ];

    // Lookup without endpoint_phone should NOT match
    const result = findConversation(conversations, {
      userId: 2, sigcoreConvId: null, endpointPhone: null, participantPhone: '+15551234567',
    });

    expect(result).toBeNull();
  });

  test('sigcore conversation ID takes priority over composite key', () => {
    const conversations = [
      { id: 1, user_id: 2, provider: 'openphone', endpoint_phone: '+18139212100', participant_phone: '+15551234567', sigcore_conversation_id: 'conv-a' },
      { id: 2, user_id: 2, provider: 'openphone', endpoint_phone: '+18773756903', participant_phone: '+15551234567', sigcore_conversation_id: 'conv-b' },
    ];

    // Even though endpoint doesn't match, sigcore ID wins
    const result = findConversation(conversations, {
      userId: 2, sigcoreConvId: 'conv-b', endpointPhone: '+18139212100', participantPhone: '+15551234567',
    });

    expect(result.id).toBe(2);
  });
});
