/**
 * Deterministic Endpoint Routing — Test Suite
 * Verifies: exact matching, tenant isolation, channel awareness,
 * non-guessing behavior, disconnect/reconnect safety, legacy fallback.
 *
 * These tests simulate the routing pipeline and route registration
 * logic extracted from server.js without requiring a live database.
 */

// ═══════════════════════════════════════════════════════════════
// Simulated database + routing functions (match server.js logic)
// ═══════════════════════════════════════════════════════════════

let endpointRoutes = [];
let conversations = [];
let messages = [];
let calls = [];
let workspaceUsers = [];
let routeIdCounter = 1;

function resetDb() {
  endpointRoutes = [];
  conversations = [];
  messages = [];
  calls = [];
  workspaceUsers = [];
  routeIdCounter = 1;
}

function normalizePhone(phone) {
  if (!phone) return null;
  const digits = phone.replace(/[^\d+]/g, '');
  if (digits.startsWith('+')) return digits;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return digits;
}

function addRoute({ workspaceId, provider, providerAccountId, endpointId, phoneNumber, channel, role, isActive = true, routeSource = 'manual' }) {
  const route = {
    id: routeIdCounter++, workspace_id: workspaceId, provider,
    provider_account_id: providerAccountId || null,
    endpoint_id: endpointId || null,
    phone_number: normalizePhone(phoneNumber),
    channel: channel || 'sms', role: role || null,
    is_active: isActive, route_source: routeSource,
    activated_at: new Date().toISOString(),
    deactivated_at: null,
  };
  endpointRoutes.push(route);
  return route;
}

function addConversation({ userId, sigcoreConversationId, participantPhone }) {
  const conv = { id: conversations.length + 1, user_id: userId, sigcore_conversation_id: sigcoreConversationId, participant_phone: participantPhone, unread_count: 0, last_preview: null, last_event_at: null };
  conversations.push(conv);
  return conv;
}

function addWorkspaceUser({ workspaceId, userId, role = 'owner' }) {
  workspaceUsers.push({ workspace_id: workspaceId, user_id: userId, role, status: 'active' });
}

function registerEndpointRoutes(workspaceId, provider, phoneNumbers, routeSource = 'auto_connect') {
  const registered = [];
  for (const pn of phoneNumbers) {
    const phoneNormalized = normalizePhone(pn.number || pn.phoneNumber);
    const epId = pn.id || pn.phoneNumberId;
    for (const ch of ['sms', 'voice']) {
      if (ch === 'sms' && pn.capabilities?.sms === false) continue;
      if (ch === 'voice' && pn.capabilities?.voice === false) continue;
      // Check existing
      const existing = endpointRoutes.find(r => r.provider === provider && r.endpoint_id === epId && r.channel === ch && r.is_active);
      if (existing) {
        existing.workspace_id = workspaceId;
      } else {
        addRoute({ workspaceId, provider, endpointId: epId, phoneNumber: phoneNormalized, channel: ch, role: 'sigcore_registered_number', isActive: true, routeSource });
      }
      registered.push({ provider, endpointId: epId, channel: ch, phone: phoneNormalized });
    }
  }
  return registered;
}

function deactivateEndpointRoutes(workspaceId, provider) {
  let count = 0;
  endpointRoutes.forEach(r => {
    if (r.workspace_id === workspaceId && r.provider === provider && r.is_active) {
      r.is_active = false;
      r.deactivated_at = new Date().toISOString();
      count++;
    }
  });
  return count;
}

// The 5-step deterministic routing pipeline (matches server.js exactly)
function resolveEndpointRoute({ provider, providerAccountId, endpointId, phoneNumber, channel, conversationId }) {
  const result = { routed: false, workspaceId: null, userId: null, step: null, route: null, ambiguous: false, candidates: [] };

  // Step A: EXACT ENDPOINT MATCH
  if (endpointId && provider && channel) {
    const routes = endpointRoutes.filter(r => r.provider === provider && r.endpoint_id === endpointId && r.channel === channel && r.is_active);
    if (routes.length === 1) {
      const r = routes[0];
      const wsUser = workspaceUsers.find(wu => wu.workspace_id === r.workspace_id && wu.role === 'owner');
      return { routed: true, workspaceId: r.workspace_id, userId: wsUser?.user_id || null, step: 'A', route: r, ambiguous: false, candidates: [] };
    }
    if (routes.length > 1) return { ...result, ambiguous: true, candidates: routes, step: 'A' };
  }

  // Step B: EXACT CONVERSATION MATCH
  if (conversationId) {
    const conv = conversations.find(c => c.sigcore_conversation_id === conversationId);
    if (conv?.user_id) {
      const wsUser = workspaceUsers.find(wu => wu.user_id === conv.user_id);
      return { routed: true, workspaceId: wsUser?.workspace_id || null, userId: conv.user_id, step: 'B', route: null, ambiguous: false, candidates: [] };
    }
  }

  // Step C: REGISTERED INTEGRATION MATCH
  if (providerAccountId && provider) {
    const routes = endpointRoutes.filter(r => r.provider === provider && r.provider_account_id === providerAccountId && r.is_active)
      .sort((a, b) => (b.priority || 0) - (a.priority || 0));
    if (routes.length === 1) {
      const r = routes[0];
      const wsUser = workspaceUsers.find(wu => wu.workspace_id === r.workspace_id && wu.role === 'owner');
      return { routed: true, workspaceId: r.workspace_id, userId: wsUser?.user_id || null, step: 'C', route: r, ambiguous: false, candidates: [] };
    }
    if (routes.length > 1) return { ...result, ambiguous: true, candidates: routes, step: 'C' };
  }

  // Step D: PHONE ASSET FALLBACK (strict — exactly 1)
  if (phoneNumber) {
    const normalized = normalizePhone(phoneNumber);
    if (normalized) {
      const routes = endpointRoutes.filter(r => r.phone_number === normalized && r.is_active)
        .sort((a, b) => (b.priority || 0) - (a.priority || 0));
      if (routes.length === 1) {
        const r = routes[0];
        const wsUser = workspaceUsers.find(wu => wu.workspace_id === r.workspace_id && wu.role === 'owner');
        return { routed: true, workspaceId: r.workspace_id, userId: wsUser?.user_id || null, step: 'D', route: r, ambiguous: false, candidates: [] };
      }
      if (routes.length > 1) return { ...result, ambiguous: true, candidates: routes, step: 'D' };
    }
  }

  // Step E: NO MATCH
  return result;
}

// Simulate webhook ingestion (writes to local DB based on routing)
function processWebhook({ event, payload }) {
  const fromNumber = normalizePhone(payload.fromNumber);
  const toNumber = normalizePhone(payload.toNumber);
  const isInbound = payload.direction === 'inbound' || event.includes('inbound');
  const ourEndpointPhone = isInbound ? toNumber : fromNumber;
  const participantPhone = isInbound ? fromNumber : toNumber;
  const channel = event.includes('call') ? 'voice' : 'sms';

  const routeResult = resolveEndpointRoute({
    provider: 'openphone',
    providerAccountId: payload.providerAccountId,
    endpointId: payload.phoneNumberId,
    phoneNumber: ourEndpointPhone,
    channel,
    conversationId: payload.conversationId,
  });

  if (!routeResult.routed) {
    if (routeResult.ambiguous) return { written: false, reason: 'ambiguous', routeResult };
    // Legacy fallback
    if (payload.metadata?.userId) {
      return { written: true, userId: payload.metadata.userId, reason: 'legacy_fallback', routeResult };
    }
    return { written: false, reason: 'no_route', routeResult };
  }

  // Write to correct workspace
  const userId = routeResult.userId;
  if (event.includes('call')) {
    calls.push({ conversation_id: null, direction: isInbound ? 'in' : 'out', user_id: userId, workspace_id: routeResult.workspaceId });
  } else {
    messages.push({ body: payload.body || '', direction: isInbound ? 'in' : 'out', user_id: userId, workspace_id: routeResult.workspaceId });
  }

  // Update/create conversation
  let conv = conversations.find(c => c.user_id === userId && c.participant_phone === participantPhone);
  if (!conv) {
    conv = { id: conversations.length + 1, user_id: userId, sigcore_conversation_id: payload.conversationId, participant_phone: participantPhone, unread_count: 0, last_preview: null, last_event_at: null };
    conversations.push(conv);
  }
  conv.last_preview = payload.body || (event.includes('call') ? 'Call' : '');
  conv.last_event_at = new Date().toISOString();
  if (isInbound) conv.unread_count++;
  if (payload.conversationId && !conv.sigcore_conversation_id) conv.sigcore_conversation_id = payload.conversationId;

  return { written: true, userId, workspaceId: routeResult.workspaceId, step: routeResult.step, reason: 'deterministic', routeResult };
}


// ═══════════════════════════════════════════════════════════════
// Test Group 1 — Route Registration
// ═══════════════════════════════════════════════════════════════

describe('Route Registration', () => {
  beforeEach(resetDb);

  test('1. creates SMS and voice routes for number with both capabilities', () => {
    const phoneNumbers = [{ id: 'PNm5YIDoXV', number: '+18139212100', capabilities: { sms: true, voice: true } }];
    const routes = registerEndpointRoutes(1, 'openphone', phoneNumbers, 'auto_connect');

    expect(routes).toHaveLength(2);
    const smsRoute = endpointRoutes.find(r => r.channel === 'sms');
    const voiceRoute = endpointRoutes.find(r => r.channel === 'voice');
    expect(smsRoute).toBeDefined();
    expect(voiceRoute).toBeDefined();
    expect(smsRoute.workspace_id).toBe(1);
    expect(smsRoute.provider).toBe('openphone');
    expect(smsRoute.endpoint_id).toBe('PNm5YIDoXV');
    expect(smsRoute.is_active).toBe(true);
    expect(voiceRoute.endpoint_id).toBe('PNm5YIDoXV');
  });

  test('2. creates only voice route when number does not support SMS', () => {
    const phoneNumbers = [{ id: 'PNAXBSP9M6', number: '+18773756903', capabilities: { sms: false, voice: true } }];
    registerEndpointRoutes(1, 'openphone', phoneNumbers);

    const smsRoutes = endpointRoutes.filter(r => r.channel === 'sms');
    const voiceRoutes = endpointRoutes.filter(r => r.channel === 'voice');
    expect(smsRoutes).toHaveLength(0);
    expect(voiceRoutes).toHaveLength(1);
    expect(voiceRoutes[0].phone_number).toBe('+18773756903');
  });

  test('3. disconnect deactivates all routes for workspace/provider', () => {
    registerEndpointRoutes(1, 'openphone', [
      { id: 'PNm5YIDoXV', number: '+18139212100', capabilities: { sms: true, voice: true } },
    ]);
    expect(endpointRoutes.filter(r => r.is_active)).toHaveLength(2);

    deactivateEndpointRoutes(1, 'openphone');
    expect(endpointRoutes.filter(r => r.is_active)).toHaveLength(0);
    expect(endpointRoutes.filter(r => !r.is_active)).toHaveLength(2);
  });

  test('4. reconnect re-registers without creating duplicates', () => {
    registerEndpointRoutes(1, 'openphone', [
      { id: 'PNm5YIDoXV', number: '+18139212100', capabilities: { sms: true, voice: true } },
    ]);
    deactivateEndpointRoutes(1, 'openphone');
    registerEndpointRoutes(1, 'openphone', [
      { id: 'PNm5YIDoXV', number: '+18139212100', capabilities: { sms: true, voice: true } },
    ]);

    const activeRoutes = endpointRoutes.filter(r => r.is_active);
    expect(activeRoutes).toHaveLength(2);
    // No duplicate active rows for same key
    const smsActive = activeRoutes.filter(r => r.channel === 'sms' && r.endpoint_id === 'PNm5YIDoXV');
    expect(smsActive).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════════════
// Test Group 2 — Deterministic Resolver
// ═══════════════════════════════════════════════════════════════

describe('Deterministic Resolver', () => {
  beforeEach(() => {
    resetDb();
    addWorkspaceUser({ workspaceId: 1, userId: 100 });
    addWorkspaceUser({ workspaceId: 2, userId: 200 });
  });

  test('5. step A exact endpoint match resolves immediately', () => {
    addRoute({ workspaceId: 1, provider: 'openphone', endpointId: 'PNm5YIDoXV', phoneNumber: '+18139212100', channel: 'sms' });

    const result = resolveEndpointRoute({ provider: 'openphone', endpointId: 'PNm5YIDoXV', phoneNumber: '+18139212100', channel: 'sms' });
    expect(result.routed).toBe(true);
    expect(result.workspaceId).toBe(1);
    expect(result.userId).toBe(100);
    expect(result.step).toBe('A');
    expect(result.ambiguous).toBe(false);
  });

  test('6. step A distinguishes SMS and voice on same endpoint', () => {
    addRoute({ workspaceId: 1, provider: 'openphone', endpointId: 'PNm5YIDoXV', phoneNumber: '+18139212100', channel: 'sms' });
    addRoute({ workspaceId: 1, provider: 'openphone', endpointId: 'PNm5YIDoXV', phoneNumber: '+18139212100', channel: 'voice' });

    const smsResult = resolveEndpointRoute({ provider: 'openphone', endpointId: 'PNm5YIDoXV', channel: 'sms' });
    const voiceResult = resolveEndpointRoute({ provider: 'openphone', endpointId: 'PNm5YIDoXV', channel: 'voice' });

    expect(smsResult.route.channel).toBe('sms');
    expect(voiceResult.route.channel).toBe('voice');
    expect(smsResult.step).toBe('A');
    expect(voiceResult.step).toBe('A');
  });

  test('7. resolver does not use phone alone when exact endpoint exists', () => {
    addRoute({ workspaceId: 1, provider: 'openphone', endpointId: 'PNm5YIDoXV', phoneNumber: '+18139212100', channel: 'sms' });
    // Same phone linked to workspace 2 via different endpoint
    addRoute({ workspaceId: 2, provider: 'openphone', endpointId: 'PNother', phoneNumber: '+18139212100', channel: 'sms' });

    const result = resolveEndpointRoute({ provider: 'openphone', endpointId: 'PNm5YIDoXV', phoneNumber: '+18139212100', channel: 'sms' });
    expect(result.routed).toBe(true);
    expect(result.workspaceId).toBe(1);
    expect(result.step).toBe('A');
  });

  test('8. resolver returns unresolved when exact route is missing', () => {
    const result = resolveEndpointRoute({ provider: 'openphone', endpointId: 'PNunknown', channel: 'sms' });
    expect(result.routed).toBe(false);
    expect(result.step).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════
// Test Group 3 — Conversation Continuity
// ═══════════════════════════════════════════════════════════════

describe('Conversation Continuity', () => {
  beforeEach(() => {
    resetDb();
    addWorkspaceUser({ workspaceId: 1, userId: 100 });
    addWorkspaceUser({ workspaceId: 2, userId: 200 });
  });

  test('9. exact conversation match routes follow-up to existing workspace', () => {
    addConversation({ userId: 100, sigcoreConversationId: 'conv-abc-123', participantPhone: '+15551234567' });

    const result = resolveEndpointRoute({ provider: 'openphone', conversationId: 'conv-abc-123', channel: 'sms' });
    expect(result.routed).toBe(true);
    expect(result.userId).toBe(100);
    expect(result.step).toBe('B');
    expect(result.ambiguous).toBe(false);
  });

  test('10. existing conversation overrides phone ambiguity', () => {
    // Phone linked to BOTH workspaces
    addRoute({ workspaceId: 1, provider: 'openphone', phoneNumber: '+15551234567', channel: 'sms' });
    addRoute({ workspaceId: 2, provider: 'openphone', phoneNumber: '+15551234567', channel: 'sms' });
    // But conversation exists for workspace 1
    addConversation({ userId: 100, sigcoreConversationId: 'conv-abc-123', participantPhone: '+15551234567' });

    const result = resolveEndpointRoute({ provider: 'openphone', conversationId: 'conv-abc-123', phoneNumber: '+15551234567', channel: 'sms' });
    expect(result.routed).toBe(true);
    expect(result.userId).toBe(100);
    expect(result.step).toBe('B');
    expect(result.ambiguous).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
// Test Group 4 — Provider Account / Integration Scope
// ═══════════════════════════════════════════════════════════════

describe('Provider Account Scope', () => {
  beforeEach(() => {
    resetDb();
    addWorkspaceUser({ workspaceId: 1, userId: 100 });
    addWorkspaceUser({ workspaceId: 2, userId: 200 });
  });

  test('11. provider account match resolves within correct integration', () => {
    addRoute({ workspaceId: 1, provider: 'openphone', providerAccountId: 'acc-W1', phoneNumber: '+18139212100', channel: 'sms' });
    addRoute({ workspaceId: 2, provider: 'openphone', providerAccountId: 'acc-W2', phoneNumber: '+18139212100', channel: 'sms' });

    const result = resolveEndpointRoute({ provider: 'openphone', providerAccountId: 'acc-W1', phoneNumber: '+18139212100', channel: 'sms' });
    expect(result.routed).toBe(true);
    expect(result.workspaceId).toBe(1);
    expect(result.step).toBe('C');
  });

  test('12. provider account match before phone fallback', () => {
    addRoute({ workspaceId: 1, provider: 'openphone', providerAccountId: 'acc-W1', phoneNumber: '+18139212100', channel: 'sms' });
    addRoute({ workspaceId: 2, provider: 'openphone', phoneNumber: '+18139212100', channel: 'sms' }); // no account, same phone

    // With provider_account_id → Step C wins
    const result = resolveEndpointRoute({ provider: 'openphone', providerAccountId: 'acc-W1', phoneNumber: '+18139212100', channel: 'sms' });
    expect(result.step).toBe('C');
    expect(result.workspaceId).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════
// Test Group 5 — Phone Asset Fallback
// ═══════════════════════════════════════════════════════════════

describe('Phone Asset Fallback', () => {
  beforeEach(() => {
    resetDb();
    addWorkspaceUser({ workspaceId: 1, userId: 100 });
    addWorkspaceUser({ workspaceId: 2, userId: 200 });
  });

  test('13. phone fallback works with exactly one eligible candidate', () => {
    addRoute({ workspaceId: 1, provider: 'openphone', phoneNumber: '+18139212100', channel: 'sms' });

    const result = resolveEndpointRoute({ provider: 'openphone', phoneNumber: '+18139212100', channel: 'sms' });
    expect(result.routed).toBe(true);
    expect(result.workspaceId).toBe(1);
    expect(result.step).toBe('D');
    expect(result.ambiguous).toBe(false);
  });

  test('14. phone fallback does NOT auto-route with multiple candidates', () => {
    addRoute({ workspaceId: 1, provider: 'openphone', phoneNumber: '+18139212100', channel: 'sms' });
    addRoute({ workspaceId: 2, provider: 'openphone', phoneNumber: '+18139212100', channel: 'sms' });

    const result = resolveEndpointRoute({ provider: 'openphone', phoneNumber: '+18139212100', channel: 'sms' });
    expect(result.routed).toBe(false);
    expect(result.ambiguous).toBe(true);
    expect(result.step).toBe('D');
    expect(result.candidates).toHaveLength(2);
  });

  test('15. inactive routes are ignored during phone fallback', () => {
    addRoute({ workspaceId: 1, provider: 'openphone', phoneNumber: '+18139212100', channel: 'sms', isActive: true });
    addRoute({ workspaceId: 2, provider: 'openphone', phoneNumber: '+18139212100', channel: 'sms', isActive: false });

    const result = resolveEndpointRoute({ provider: 'openphone', phoneNumber: '+18139212100', channel: 'sms' });
    expect(result.routed).toBe(true);
    expect(result.workspaceId).toBe(1);
    expect(result.ambiguous).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
// Test Group 6 — Webhook Ingestion
// ═══════════════════════════════════════════════════════════════

describe('Webhook Ingestion', () => {
  beforeEach(() => {
    resetDb();
    addWorkspaceUser({ workspaceId: 1, userId: 100 });
    addWorkspaceUser({ workspaceId: 2, userId: 200 });
    addRoute({ workspaceId: 1, provider: 'openphone', endpointId: 'PNm5YIDoXV', phoneNumber: '+18139212100', channel: 'sms' });
    addRoute({ workspaceId: 1, provider: 'openphone', endpointId: 'PNm5YIDoXV', phoneNumber: '+18139212100', channel: 'voice' });
  });

  test('16. inbound SMS creates message in correct workspace', () => {
    const result = processWebhook({
      event: 'message.inbound',
      payload: { direction: 'inbound', fromNumber: '+15551234567', toNumber: '+18139212100', phoneNumberId: 'PNm5YIDoXV', body: 'Hello!', conversationId: 'conv-1' },
    });

    expect(result.written).toBe(true);
    expect(result.workspaceId).toBe(1);
    expect(result.step).toBe('A');
    expect(result.reason).toBe('deterministic');
    expect(messages).toHaveLength(1);
    expect(messages[0].user_id).toBe(100);
    expect(messages[0].workspace_id).toBe(1);
    expect(conversations).toHaveLength(1);
    expect(conversations[0].unread_count).toBe(1);
  });

  test('17. inbound call creates call record in correct workspace', () => {
    const result = processWebhook({
      event: 'call.inbound',
      payload: { direction: 'inbound', fromNumber: '+15551234567', toNumber: '+18139212100', phoneNumberId: 'PNm5YIDoXV', conversationId: 'conv-call-1' },
    });

    expect(result.written).toBe(true);
    expect(result.workspaceId).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0].workspace_id).toBe(1);
  });

  test('18. unresolved webhook does NOT create records in wrong workspace', () => {
    const result = processWebhook({
      event: 'message.inbound',
      payload: { direction: 'inbound', fromNumber: '+15551234567', toNumber: '+19999999999', phoneNumberId: 'PNunknown', body: 'Wrong place' },
    });

    expect(result.written).toBe(false);
    expect(result.reason).toBe('no_route');
    expect(messages).toHaveLength(0);
    expect(conversations).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════
// Test Group 7 — Cross-Tenant Isolation
// ═══════════════════════════════════════════════════════════════

describe('Cross-Tenant Isolation', () => {
  beforeEach(() => {
    resetDb();
    addWorkspaceUser({ workspaceId: 1, userId: 100 }); // Spotless Homes
    addWorkspaceUser({ workspaceId: 2, userId: 200 }); // Lavanda
    addRoute({ workspaceId: 1, provider: 'openphone', endpointId: 'PNm5YIDoXV', phoneNumber: '+18139212100', channel: 'sms' });
    addRoute({ workspaceId: 2, provider: 'openphone', endpointId: 'PNlavanda', phoneNumber: '+16193938869', channel: 'sms' });
  });

  test('19. event for workspace A never appears in workspace B', () => {
    processWebhook({
      event: 'message.inbound',
      payload: { direction: 'inbound', fromNumber: '+15551234567', toNumber: '+18139212100', phoneNumberId: 'PNm5YIDoXV', body: 'For Spotless', conversationId: 'conv-spotless' },
    });

    // Workspace A (Spotless) gets the message
    expect(messages.filter(m => m.workspace_id === 1)).toHaveLength(1);
    // Workspace B (Lavanda) gets nothing
    expect(messages.filter(m => m.workspace_id === 2)).toHaveLength(0);
    expect(conversations.filter(c => c.user_id === 200)).toHaveLength(0);
  });

  test('20. duplicate phone across workspaces does not cause leakage', () => {
    // Same phone linked to BOTH — but exact endpoint only for workspace 1
    addRoute({ workspaceId: 2, provider: 'openphone', phoneNumber: '+18139212100', channel: 'sms' }); // extra phone link to W2

    const result = processWebhook({
      event: 'message.inbound',
      payload: { direction: 'inbound', fromNumber: '+15551234567', toNumber: '+18139212100', phoneNumberId: 'PNm5YIDoXV', body: 'Test', conversationId: 'conv-test' },
    });

    // Exact endpoint match wins (Step A) — goes to workspace 1
    expect(result.workspaceId).toBe(1);
    expect(result.step).toBe('A');
    expect(messages.filter(m => m.workspace_id === 2)).toHaveLength(0);
  });

  test('21. ambiguous same-phone case is blocked, not guessed', () => {
    // Both workspaces have same phone, no exact endpoint in payload
    addRoute({ workspaceId: 1, provider: 'twilio', phoneNumber: '+15559999999', channel: 'sms' });
    addRoute({ workspaceId: 2, provider: 'twilio', phoneNumber: '+15559999999', channel: 'sms' });

    const result = processWebhook({
      event: 'message.inbound',
      payload: { direction: 'inbound', fromNumber: '+15551234567', toNumber: '+15559999999', body: 'Ambiguous' },
    });

    expect(result.written).toBe(false);
    expect(result.reason).toBe('ambiguous');
    expect(messages).toHaveLength(0);
    expect(conversations).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════
// Test Group 8 — Legacy Fallback
// ═══════════════════════════════════════════════════════════════

describe('Legacy Fallback', () => {
  beforeEach(() => {
    resetDb();
    addWorkspaceUser({ workspaceId: 1, userId: 100 });
    addRoute({ workspaceId: 1, provider: 'openphone', endpointId: 'PNm5YIDoXV', phoneNumber: '+18139212100', channel: 'sms' });
  });

  test('22. legacy fallback NOT used when deterministic route exists', () => {
    const result = processWebhook({
      event: 'message.inbound',
      payload: { direction: 'inbound', fromNumber: '+15551234567', toNumber: '+18139212100', phoneNumberId: 'PNm5YIDoXV', body: 'Test', metadata: { userId: 999 } },
    });

    expect(result.reason).toBe('deterministic');
    expect(result.userId).toBe(100); // from route, NOT from metadata.userId=999
  });

  test('23. legacy fallback resolves when no route exists', () => {
    const result = processWebhook({
      event: 'message.inbound',
      payload: { direction: 'inbound', fromNumber: '+15551234567', toNumber: '+19999999999', phoneNumberId: 'PNunknown', body: 'Test', metadata: { userId: 42 } },
    });

    expect(result.written).toBe(true);
    expect(result.reason).toBe('legacy_fallback');
    expect(result.userId).toBe(42);
  });

  test('24. once routes registered, legacy fallback becomes unused', () => {
    // First: no route → fallback
    const result1 = processWebhook({
      event: 'message.inbound',
      payload: { direction: 'inbound', fromNumber: '+15551234567', toNumber: '+19998887777', phoneNumberId: 'PNnew', body: 'Before', metadata: { userId: 42 } },
    });
    expect(result1.reason).toBe('legacy_fallback');

    // Register route
    addRoute({ workspaceId: 1, provider: 'openphone', endpointId: 'PNnew', phoneNumber: '+19998887777', channel: 'sms' });

    // Now: deterministic
    const result2 = processWebhook({
      event: 'message.inbound',
      payload: { direction: 'inbound', fromNumber: '+15551234567', toNumber: '+19998887777', phoneNumberId: 'PNnew', body: 'After', metadata: { userId: 42 } },
    });
    expect(result2.reason).toBe('deterministic');
    expect(result2.workspaceId).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════
// Test Group 9 — Admin/CRUD Route Management
// ═══════════════════════════════════════════════════════════════

describe('Route Management', () => {
  beforeEach(() => {
    resetDb();
    addWorkspaceUser({ workspaceId: 1, userId: 100 });
  });

  test('25. manual route creation adds deterministic route', () => {
    const route = addRoute({ workspaceId: 1, provider: 'twilio', endpointId: 'PN_twilio_123', phoneNumber: '+15551112222', channel: 'sms', routeSource: 'manual' });

    const result = resolveEndpointRoute({ provider: 'twilio', endpointId: 'PN_twilio_123', channel: 'sms' });
    expect(result.routed).toBe(true);
    expect(result.workspaceId).toBe(1);
    expect(result.route.route_source).toBe('manual');
  });

  test('26. deactivated route is removed from candidate set', () => {
    addRoute({ workspaceId: 1, provider: 'openphone', endpointId: 'PNtest', phoneNumber: '+15553334444', channel: 'sms' });
    expect(resolveEndpointRoute({ provider: 'openphone', endpointId: 'PNtest', channel: 'sms' }).routed).toBe(true);

    // Deactivate
    endpointRoutes.find(r => r.endpoint_id === 'PNtest').is_active = false;
    expect(resolveEndpointRoute({ provider: 'openphone', endpointId: 'PNtest', channel: 'sms' }).routed).toBe(false);
  });

  test('27. duplicate deterministic key prevented', () => {
    addRoute({ workspaceId: 1, provider: 'openphone', endpointId: 'PNdup', channel: 'sms' });
    // registerEndpointRoutes reuses existing instead of creating duplicate
    registerEndpointRoutes(1, 'openphone', [{ id: 'PNdup', number: '+15551234567', capabilities: { sms: true, voice: false } }]);

    const active = endpointRoutes.filter(r => r.endpoint_id === 'PNdup' && r.channel === 'sms' && r.is_active);
    expect(active).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════════════
// Test Group 10 — CRM Linkage
// ═══════════════════════════════════════════════════════════════

describe('CRM Linkage', () => {
  beforeEach(() => {
    resetDb();
    addWorkspaceUser({ workspaceId: 1, userId: 100 });
    addRoute({ workspaceId: 1, provider: 'openphone', endpointId: 'PNm5YIDoXV', phoneNumber: '+18139212100', channel: 'sms' });
  });

  test('28. inbound message stored under correct workspace with conversation', () => {
    processWebhook({
      event: 'message.inbound',
      payload: { direction: 'inbound', fromNumber: '+15551234567', toNumber: '+18139212100', phoneNumberId: 'PNm5YIDoXV', body: 'I need cleaning', conversationId: 'conv-crm-1' },
    });

    expect(conversations).toHaveLength(1);
    expect(conversations[0].user_id).toBe(100);
    expect(conversations[0].participant_phone).toBe('+15551234567');
    expect(conversations[0].sigcore_conversation_id).toBe('conv-crm-1');
    expect(messages).toHaveLength(1);
    expect(messages[0].workspace_id).toBe(1);
  });

  test('29. unmatched message routes to correct workspace without false link', () => {
    processWebhook({
      event: 'message.inbound',
      payload: { direction: 'inbound', fromNumber: '+19999999999', toNumber: '+18139212100', phoneNumberId: 'PNm5YIDoXV', body: 'Unknown sender', conversationId: 'conv-unknown' },
    });

    expect(messages).toHaveLength(1);
    expect(messages[0].workspace_id).toBe(1);
    expect(conversations).toHaveLength(1);
    expect(conversations[0].user_id).toBe(100);
    // No false customer assignment — just the conversation with phone number
    expect(conversations[0].participant_phone).toBe('+19999999999');
  });
});
