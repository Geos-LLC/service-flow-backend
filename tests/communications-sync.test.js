/**
 * Communications Sync Tests
 *
 * Tests for OpenPhone conversation sync, webhook handling,
 * contact name resolution, and conversation identity.
 */

// ── Contact Name Resolution ──

describe('Contact Name Resolution', () => {
  function resolveContactName({ contactName, conversationName, contactNameMap, participantPhone, lastMessage }) {
    // Same priority as server.js sync loop
    let name = contactName || conversationName || (contactNameMap && contactNameMap[participantPhone]) || null;
    if (!name && lastMessage) {
      const msg = lastMessage.toLowerCase();
      if (msg.includes('thumbtack') || msg.includes('thmtk.com')) name = 'Thumbtack';
      else if (msg.includes('[tt]') || msg.includes('[yelp]') || msg.includes('leadbridge')) name = 'LeadBridge';
      else if (msg.includes('yelp')) name = 'Yelp';
      else if (msg.includes('homeadvisor') || msg.includes('angi')) name = 'HomeAdvisor';
    }
    return name;
  }

  test('contactName from Sigcore takes priority', () => {
    expect(resolveContactName({
      contactName: 'Jack Levy',
      conversationName: 'Some Other Name',
      lastMessage: 'Thumbtack lead',
    })).toBe('Jack Levy');
  });

  test('conversationName used when no contactName', () => {
    expect(resolveContactName({
      contactName: null,
      conversationName: 'Thumbtack Miami',
      lastMessage: 'Some message',
    })).toBe('Thumbtack Miami');
  });

  test('contactNameMap used when no direct names', () => {
    expect(resolveContactName({
      contactName: null,
      conversationName: null,
      contactNameMap: { '+15551234567': 'Crystal Jackson' },
      participantPhone: '+15551234567',
    })).toBe('Crystal Jackson');
  });

  test('auto-detect Thumbtack from message', () => {
    expect(resolveContactName({
      contactName: null,
      conversationName: null,
      lastMessage: 'Thumbtack - New direct lead! $189 house cleaning',
    })).toBe('Thumbtack');
  });

  test('auto-detect Thumbtack from thmtk.com link', () => {
    expect(resolveContactName({
      contactName: null,
      conversationName: null,
      lastMessage: 'New Thumbtack opportunity: T. G. thmtk.com/abc123',
    })).toBe('Thumbtack');
  });

  test('auto-detect LeadBridge from [TT] prefix', () => {
    expect(resolveContactName({
      contactName: null,
      conversationName: null,
      lastMessage: '[TT] New lead: Erin Dimeglio, Estimate $229',
    })).toBe('LeadBridge');
  });

  test('auto-detect LeadBridge from [Yelp] prefix', () => {
    expect(resolveContactName({
      contactName: null,
      conversationName: null,
      lastMessage: '[Yelp] New lead: Unknown\nNot specified',
    })).toBe('LeadBridge');
  });

  test('auto-detect Yelp from message', () => {
    expect(resolveContactName({
      contactName: null,
      conversationName: null,
      lastMessage: 'You have a new review on Yelp',
    })).toBe('Yelp');
  });

  test('returns null when no name detectable', () => {
    expect(resolveContactName({
      contactName: null,
      conversationName: null,
      lastMessage: 'Hi, when can you come?',
    })).toBeNull();
  });

  test('returns null when no message at all', () => {
    expect(resolveContactName({
      contactName: null,
      conversationName: null,
      lastMessage: null,
    })).toBeNull();
  });
});

// ── Conversation Identity ──

describe('Conversation Identity', () => {
  function findConversation(conversations, { userId, sigcoreConvId, endpointPhone, participantPhone }) {
    if (sigcoreConvId) {
      const found = conversations.find(c => c.user_id === userId && c.sigcore_conversation_id === sigcoreConvId);
      if (found) return found;
    }
    if (endpointPhone && participantPhone) {
      return conversations.find(c =>
        c.user_id === userId && c.endpoint_phone === endpointPhone && c.participant_phone === participantPhone
      ) || null;
    }
    return null;
  }

  test('same customer + two different business numbers → two separate conversations', () => {
    const conversations = [
      { id: 1, user_id: 2, endpoint_phone: '+18139212100', participant_phone: '+15551234567', sigcore_conversation_id: 'conv-a' },
      { id: 2, user_id: 2, endpoint_phone: '+18773756903', participant_phone: '+15551234567', sigcore_conversation_id: 'conv-b' },
    ];

    const resultA = findConversation(conversations, { userId: 2, endpointPhone: '+18139212100', participantPhone: '+15551234567' });
    const resultB = findConversation(conversations, { userId: 2, endpointPhone: '+18773756903', participantPhone: '+15551234567' });

    expect(resultA.id).toBe(1);
    expect(resultB.id).toBe(2);
  });

  test('same endpoint + same customer → one conversation', () => {
    const conversations = [
      { id: 1, user_id: 2, endpoint_phone: '+18139212100', participant_phone: '+15551234567', sigcore_conversation_id: 'conv-a' },
    ];

    const result1 = findConversation(conversations, { userId: 2, endpointPhone: '+18139212100', participantPhone: '+15551234567' });
    const result2 = findConversation(conversations, { userId: 2, sigcoreConvId: 'conv-a', endpointPhone: '+18139212100', participantPhone: '+15551234567' });

    expect(result1.id).toBe(1);
    expect(result2.id).toBe(1);
  });

  test('participant phone alone does NOT match', () => {
    const conversations = [
      { id: 1, user_id: 2, endpoint_phone: '+18139212100', participant_phone: '+15551234567' },
    ];

    const result = findConversation(conversations, { userId: 2, endpointPhone: null, participantPhone: '+15551234567' });
    expect(result).toBeNull();
  });

  test('sigcore conversation ID takes priority', () => {
    const conversations = [
      { id: 1, user_id: 2, endpoint_phone: '+18139212100', participant_phone: '+15551234567', sigcore_conversation_id: 'conv-a' },
      { id: 2, user_id: 2, endpoint_phone: '+18773756903', participant_phone: '+15551234567', sigcore_conversation_id: 'conv-b' },
    ];

    const result = findConversation(conversations, { userId: 2, sigcoreConvId: 'conv-b', endpointPhone: '+18139212100', participantPhone: '+15551234567' });
    expect(result.id).toBe(2);
  });

  test('conversations may share same lead without merging', () => {
    const conversations = [
      { id: 1, user_id: 2, endpoint_phone: '+18139212100', participant_phone: '+15551234567', lead_id: 42 },
      { id: 2, user_id: 2, endpoint_phone: '+18773756903', participant_phone: '+15551234567', lead_id: 42 },
    ];

    expect(conversations[0].lead_id).toBe(conversations[1].lead_id);
    expect(conversations[0].id).not.toBe(conversations[1].id);
  });
});

// ── Webhook Routing ──

describe('Webhook Routing - Channel Filter', () => {
  // Simulates Step D routing logic
  function stepDRoute(routes, phoneNumber, channel) {
    let filtered = routes.filter(r => r.phone_number === phoneNumber && r.is_active);
    if (channel) filtered = filtered.filter(r => r.channel === channel);

    if (filtered.length === 1) return { routed: true, route: filtered[0], ambiguous: false };
    if (filtered.length > 1) return { routed: false, ambiguous: true, candidates: filtered };

    // Fallback: any channel
    if (channel) {
      const any = routes.filter(r => r.phone_number === phoneNumber && r.is_active);
      if (any.length === 1) return { routed: true, route: any[0], ambiguous: false };
    }

    return { routed: false, ambiguous: false };
  }

  const routes = [
    { id: 11, phone_number: '+18139212100', channel: 'sms', workspace_id: 1, is_active: true },
    { id: 12, phone_number: '+18139212100', channel: 'voice', workspace_id: 1, is_active: true },
    { id: 10, phone_number: '+18773756903', channel: 'voice', workspace_id: 1, is_active: true },
  ];

  test('SMS message routes to SMS route (not AMBIGUOUS)', () => {
    const result = stepDRoute(routes, '+18139212100', 'sms');
    expect(result.routed).toBe(true);
    expect(result.ambiguous).toBe(false);
    expect(result.route.id).toBe(11);
  });

  test('voice call routes to voice route (not AMBIGUOUS)', () => {
    const result = stepDRoute(routes, '+18139212100', 'voice');
    expect(result.routed).toBe(true);
    expect(result.ambiguous).toBe(false);
    expect(result.route.id).toBe(12);
  });

  test('single-channel phone routes without ambiguity', () => {
    const result = stepDRoute(routes, '+18773756903', 'voice');
    expect(result.routed).toBe(true);
    expect(result.route.id).toBe(10);
  });

  test('unknown phone returns not routed', () => {
    const result = stepDRoute(routes, '+15551234567', 'sms');
    expect(result.routed).toBe(false);
    expect(result.ambiguous).toBe(false);
  });
});

// ── Message Endpoint Guard ──

describe('Message Endpoint Guard', () => {
  function shouldAttachMessage(endpointPhone, msgFrom, msgTo) {
    if (endpointPhone && msgFrom !== endpointPhone && msgTo !== endpointPhone) {
      return false; // Cross-tenant message
    }
    return true;
  }

  test('outbound message from our number — attach', () => {
    expect(shouldAttachMessage('+18139212100', '+18139212100', '+15551234567')).toBe(true);
  });

  test('inbound message to our number — attach', () => {
    expect(shouldAttachMessage('+18139212100', '+15551234567', '+18139212100')).toBe(true);
  });

  test('LeadBridge message from different number — skip', () => {
    expect(shouldAttachMessage('+18139212100', '+19045778584', '+15551234567')).toBe(false);
  });

  test('no endpoint phone — allow (legacy)', () => {
    expect(shouldAttachMessage(null, '+19045778584', '+15551234567')).toBe(true);
  });
});

// ── Phone Number Filtering ──

describe('Phone Number Filtering', () => {
  function filterOurConversations(convs, ourPhones, ourPhoneIds) {
    return convs.filter(c => {
      const convPhone = c.phoneNumber;
      const convPnId = c.phoneNumberId;
      return ourPhones.includes(convPhone) || ourPhoneIds.includes(convPnId);
    });
  }

  const allConvs = [
    { phoneNumber: '+18139212100', phoneNumberId: 'PNm5YIDoXV', participantPhone: '+15551234567' },
    { phoneNumber: '+18773756903', phoneNumberId: 'PNAXBSP9M6', participantPhone: '+15559876543' },
    { phoneNumber: '+16193938869', phoneNumberId: 'PNother1', participantPhone: '+15551111111' }, // LeadBridge
    { phoneNumber: '+12064663099', phoneNumberId: 'PNother2', participantPhone: '+15552222222' }, // Another tenant
  ];

  const ourPhones = ['+18139212100', '+18773756903'];
  const ourPhoneIds = ['PNm5YIDoXV', 'PNAXBSP9M6'];

  test('filters to only our phone numbers', () => {
    const filtered = filterOurConversations(allConvs, ourPhones, ourPhoneIds);
    expect(filtered.length).toBe(2);
    expect(filtered[0].phoneNumber).toBe('+18139212100');
    expect(filtered[1].phoneNumber).toBe('+18773756903');
  });

  test('excludes other tenants phone numbers', () => {
    const filtered = filterOurConversations(allConvs, ourPhones, ourPhoneIds);
    expect(filtered.find(c => c.phoneNumber === '+16193938869')).toBeUndefined();
    expect(filtered.find(c => c.phoneNumber === '+12064663099')).toBeUndefined();
  });
});
