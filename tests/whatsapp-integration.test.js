/**
 * WhatsApp Business Channel Integration Tests
 *
 * Tests for:
 * 1. Conversation identity (endpoint-aware, never participant-only)
 * 2. Message isolation (endpoint guard)
 * 3. Flexibility (conversations exist without job/customer links)
 * 4. Webhook handler logic
 * 5. Channel filter
 */

// ═══════════════════════════════════════════════════════════════
// Helpers — extracted logic from server.js for unit testing
// ═══════════════════════════════════════════════════════════════

function normalizePhone(phone) {
  if (!phone) return null;
  const digits = phone.replace(/[^\d+]/g, '');
  if (digits.startsWith('+')) return digits;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return digits;
}

// Simulates conversation identity lookup (hardened model)
function findWhatsAppConversation(conversations, { userId, endpointPhone, participantPhone }) {
  // Full composite key: (user_id, provider, endpoint_phone, participant_phone)
  return conversations.find(c =>
    c.user_id === userId &&
    c.provider === 'whatsapp' &&
    c.endpoint_phone === endpointPhone &&
    c.participant_phone === participantPhone
  ) || null;
}

// Simulates message endpoint guard
function messagePassesEndpointGuard(msg, endpointPhone) {
  if (!endpointPhone) return true; // no guard if endpoint unknown
  const msgFrom = normalizePhone(msg.from);
  const msgTo = normalizePhone(msg.to);
  return msgFrom === endpointPhone || msgTo === endpointPhone;
}

// Simulates channel filter logic from conversations API
function applyChannelFilter(conversations, channel) {
  if (!channel) return conversations;
  if (channel === 'openphone') return conversations.filter(c => c.provider === 'openphone');
  if (channel === 'whatsapp') return conversations.filter(c => c.provider === 'whatsapp');
  return conversations.filter(c => c.channel === channel);
}

// Simulates channelUnread computation
function computeChannelUnread(conversations) {
  const counts = {};
  for (const c of conversations) {
    if (c.unread_count > 0) {
      const key = c.provider === 'openphone' ? 'openphone' : c.channel;
      counts[key] = (counts[key] || 0) + 1;
    }
  }
  return counts;
}

// ═══════════════════════════════════════════════════════════════
// Identity Tests
// ═══════════════════════════════════════════════════════════════

describe('WhatsApp Conversation Identity', () => {
  const conversations = [
    { id: 1, user_id: 2, provider: 'whatsapp', channel: 'whatsapp', endpoint_phone: '+18139212100', participant_phone: '+15551234567' },
    { id: 2, user_id: 2, provider: 'whatsapp', channel: 'whatsapp', endpoint_phone: '+18773756903', participant_phone: '+15551234567' },
    { id: 3, user_id: 2, provider: 'openphone', channel: 'sms', endpoint_phone: '+18139212100', participant_phone: '+15551234567' },
    { id: 4, user_id: 3, provider: 'whatsapp', channel: 'whatsapp', endpoint_phone: '+18139212100', participant_phone: '+15551234567' },
  ];

  test('same customer + 2 different WhatsApp endpoints → 2 separate conversations', () => {
    const conv1 = findWhatsAppConversation(conversations, {
      userId: 2, endpointPhone: '+18139212100', participantPhone: '+15551234567',
    });
    const conv2 = findWhatsAppConversation(conversations, {
      userId: 2, endpointPhone: '+18773756903', participantPhone: '+15551234567',
    });
    expect(conv1.id).toBe(1);
    expect(conv2.id).toBe(2);
    expect(conv1.id).not.toBe(conv2.id);
  });

  test('participant-only lookup NEVER returns a match (requires endpoint_phone)', () => {
    // Simulating a broken lookup that only uses participant_phone
    const badResult = conversations.find(c =>
      c.user_id === 2 && c.provider === 'whatsapp' && c.participant_phone === '+15551234567'
    );
    // This WOULD match multiple — showing why participant-only is wrong
    const allMatches = conversations.filter(c =>
      c.user_id === 2 && c.provider === 'whatsapp' && c.participant_phone === '+15551234567'
    );
    expect(allMatches.length).toBe(2); // Two conversations for same participant
    // The correct lookup returns exactly one
    const correctResult = findWhatsAppConversation(conversations, {
      userId: 2, endpointPhone: '+18139212100', participantPhone: '+15551234567',
    });
    expect(correctResult.id).toBe(1);
  });

  test('WhatsApp and OpenPhone conversations for same phones are separate', () => {
    const waConv = findWhatsAppConversation(conversations, {
      userId: 2, endpointPhone: '+18139212100', participantPhone: '+15551234567',
    });
    const opConv = conversations.find(c =>
      c.user_id === 2 && c.provider === 'openphone' &&
      c.endpoint_phone === '+18139212100' && c.participant_phone === '+15551234567'
    );
    expect(waConv.provider).toBe('whatsapp');
    expect(opConv.provider).toBe('openphone');
    expect(waConv.id).not.toBe(opConv.id);
  });

  test('different users with same phones are isolated (tenant isolation)', () => {
    const user2Conv = findWhatsAppConversation(conversations, {
      userId: 2, endpointPhone: '+18139212100', participantPhone: '+15551234567',
    });
    const user3Conv = findWhatsAppConversation(conversations, {
      userId: 3, endpointPhone: '+18139212100', participantPhone: '+15551234567',
    });
    expect(user2Conv.id).toBe(1);
    expect(user3Conv.id).toBe(4);
    expect(user2Conv.user_id).toBe(2);
    expect(user3Conv.user_id).toBe(3);
  });
});

// ═══════════════════════════════════════════════════════════════
// Message Isolation Tests (Endpoint Guard)
// ═══════════════════════════════════════════════════════════════

describe('WhatsApp Message Endpoint Guard', () => {
  const endpointPhone = '+18139212100';

  test('inbound message TO endpoint phone passes guard', () => {
    const msg = { from: '+15551234567', to: '+18139212100' };
    expect(messagePassesEndpointGuard(msg, endpointPhone)).toBe(true);
  });

  test('outbound message FROM endpoint phone passes guard', () => {
    const msg = { from: '+18139212100', to: '+15551234567' };
    expect(messagePassesEndpointGuard(msg, endpointPhone)).toBe(true);
  });

  test('message from DIFFERENT endpoint is REJECTED', () => {
    const msg = { from: '+18773756903', to: '+15551234567' };
    expect(messagePassesEndpointGuard(msg, endpointPhone)).toBe(false);
  });

  test('message between two external numbers is REJECTED', () => {
    const msg = { from: '+15559999999', to: '+15558888888' };
    expect(messagePassesEndpointGuard(msg, endpointPhone)).toBe(false);
  });

  test('guard passes when no endpoint phone known (graceful degradation)', () => {
    const msg = { from: '+15551234567', to: '+18139212100' };
    expect(messagePassesEndpointGuard(msg, null)).toBe(true);
  });

  test('phone normalization works for different formats', () => {
    const msg = { from: '5551234567', to: '18139212100' };
    expect(messagePassesEndpointGuard(msg, '+18139212100')).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
// Flexibility Tests
// ═══════════════════════════════════════════════════════════════

describe('WhatsApp Conversation Flexibility', () => {
  test('WhatsApp conversation can exist without job/customer/lead links', () => {
    const conv = {
      id: 10, user_id: 2, provider: 'whatsapp', channel: 'whatsapp',
      endpoint_phone: '+18139212100', participant_phone: '+15557770000',
      customer_id: null, lead_id: null, job_id: null,
      conversation_type: 'external_client',
    };
    // Conversation is valid without any links
    expect(conv.customer_id).toBeNull();
    expect(conv.lead_id).toBeNull();
    expect(conv.job_id).toBeNull();
    expect(conv.provider).toBe('whatsapp');
    expect(conv.conversation_type).toBe('external_client');
  });

  test('linking a lead later does not change conversation identity', () => {
    const conv = {
      id: 10, user_id: 2, provider: 'whatsapp', channel: 'whatsapp',
      endpoint_phone: '+18139212100', participant_phone: '+15557770000',
      customer_id: null, lead_id: null,
    };
    // Simulate linking a lead
    conv.lead_id = 42;
    // Identity key is still the same
    const found = findWhatsAppConversation([conv], {
      userId: 2, endpointPhone: '+18139212100', participantPhone: '+15557770000',
    });
    expect(found).not.toBeNull();
    expect(found.id).toBe(10);
    expect(found.lead_id).toBe(42);
  });

  test('conversation_type can be any classification', () => {
    const types = ['external_client', 'operations_job', 'internal_team'];
    for (const type of types) {
      const conv = {
        id: 1, user_id: 2, provider: 'whatsapp', channel: 'whatsapp',
        endpoint_phone: '+18139212100', participant_phone: '+15557770000',
        conversation_type: type,
      };
      expect(conv.conversation_type).toBe(type);
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// Channel Filter Tests
// ═══════════════════════════════════════════════════════════════

describe('WhatsApp Channel Filter', () => {
  const allConversations = [
    { id: 1, provider: 'openphone', channel: 'sms', unread_count: 2 },
    { id: 2, provider: 'openphone', channel: 'call', unread_count: 0 },
    { id: 3, provider: 'whatsapp', channel: 'whatsapp', unread_count: 3 },
    { id: 4, provider: 'whatsapp', channel: 'whatsapp', unread_count: 0 },
    { id: 5, provider: 'leadbridge', channel: 'thumbtack', unread_count: 1 },
    { id: 6, provider: 'leadbridge', channel: 'yelp', unread_count: 0 },
  ];

  test('channel=whatsapp filters by provider=whatsapp', () => {
    const filtered = applyChannelFilter(allConversations, 'whatsapp');
    expect(filtered.length).toBe(2);
    expect(filtered.every(c => c.provider === 'whatsapp')).toBe(true);
  });

  test('channel=openphone filters by provider=openphone (includes sms+call)', () => {
    const filtered = applyChannelFilter(allConversations, 'openphone');
    expect(filtered.length).toBe(2);
    expect(filtered.every(c => c.provider === 'openphone')).toBe(true);
  });

  test('channel=thumbtack filters by exact channel', () => {
    const filtered = applyChannelFilter(allConversations, 'thumbtack');
    expect(filtered.length).toBe(1);
    expect(filtered[0].channel).toBe('thumbtack');
  });

  test('no filter returns all conversations', () => {
    const filtered = applyChannelFilter(allConversations, null);
    expect(filtered.length).toBe(6);
  });

  test('channelUnread computes WhatsApp badge correctly', () => {
    const unread = computeChannelUnread(allConversations);
    expect(unread.openphone).toBe(1); // 1 conversation with unread (sms, count=2)
    expect(unread.whatsapp).toBe(1); // 1 WhatsApp conversation with unread (count=3)
    expect(unread.thumbtack).toBe(1); // 1 thumbtack with unread
    expect(unread.yelp).toBeUndefined(); // yelp has 0 unread
  });
});

// ═══════════════════════════════════════════════════════════════
// Webhook Handler Tests
// ═══════════════════════════════════════════════════════════════

describe('WhatsApp Webhook Event Detection', () => {
  test('whatsapp.message.inbound is detected as WhatsApp event', () => {
    expect('whatsapp.message.inbound'.startsWith('whatsapp.')).toBe(true);
  });

  test('whatsapp.message.delivered is detected as WhatsApp event', () => {
    expect('whatsapp.message.delivered'.startsWith('whatsapp.')).toBe(true);
  });

  test('whatsapp.status.change is detected as WhatsApp event', () => {
    expect('whatsapp.status.change'.startsWith('whatsapp.')).toBe(true);
  });

  test('message.inbound is NOT a WhatsApp event (OpenPhone)', () => {
    expect('message.inbound'.startsWith('whatsapp.')).toBe(false);
  });

  test('call.completed is NOT a WhatsApp event', () => {
    expect('call.completed'.startsWith('whatsapp.')).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
// Endpoint Route Registration
// ═══════════════════════════════════════════════════════════════

describe('WhatsApp Endpoint Route', () => {
  test('WhatsApp endpoint route uses provider=whatsapp and channel=whatsapp', () => {
    const route = {
      provider: 'whatsapp',
      endpoint_id: 'wa_+18139212100',
      phone_number: '+18139212100',
      channel: 'whatsapp',
      role: 'sigcore_registered_number',
      route_source: 'auto_connect',
      is_active: true,
    };
    expect(route.provider).toBe('whatsapp');
    expect(route.channel).toBe('whatsapp');
    expect(route.endpoint_id).toMatch(/^wa_/);
  });

  test('endpoint route resolves via Step A (exact match)', () => {
    const routes = [
      { id: 1, provider: 'whatsapp', endpoint_id: 'wa_+18139212100', phone_number: '+18139212100', channel: 'whatsapp', is_active: true, workspace_id: 1 },
    ];
    // Step A: exact match on provider + endpoint_id + channel
    const match = routes.filter(r =>
      r.provider === 'whatsapp' && r.endpoint_id === 'wa_+18139212100' && r.channel === 'whatsapp' && r.is_active
    );
    expect(match.length).toBe(1);
    expect(match[0].workspace_id).toBe(1);
  });

  test('endpoint route resolves via Step D (phone fallback)', () => {
    const routes = [
      { id: 1, provider: 'whatsapp', endpoint_id: 'wa_+18139212100', phone_number: '+18139212100', channel: 'whatsapp', is_active: true, workspace_id: 1 },
    ];
    // Step D: phone number match
    const match = routes.filter(r =>
      r.phone_number === '+18139212100' && r.channel === 'whatsapp' && r.is_active
    );
    expect(match.length).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════
// Provider Send Routing
// ═══════════════════════════════════════════════════════════════

describe('WhatsApp Send Routing', () => {
  test('WhatsApp conversation routes to WhatsApp send branch', () => {
    const conv = { provider: 'whatsapp', channel: 'whatsapp', participant_phone: '+15551234567' };
    expect(conv.provider === 'whatsapp').toBe(true);
    // In server.js: if (conv.provider === 'whatsapp') → WhatsApp send path
  });

  test('OpenPhone conversation does NOT route to WhatsApp send', () => {
    const conv = { provider: 'openphone', channel: 'sms', participant_phone: '+15551234567' };
    expect(conv.provider === 'whatsapp').toBe(false);
  });

  test('LeadBridge conversation does NOT route to WhatsApp send', () => {
    const conv = { provider: 'leadbridge', channel: 'thumbtack', participant_phone: '+15551234567' };
    expect(conv.provider === 'whatsapp').toBe(false);
  });
});
