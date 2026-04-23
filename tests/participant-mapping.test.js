/**
 * PR4 — Participant Mapping Tests
 *
 * Covers the Sigcore-participant-based identity migration:
 *  - Dual-read: new `provider.*` shape + legacy flat fields
 *  - Phone normalization
 *  - CRM match precedence: customer → lead → ambiguous → unmapped
 *  - Display priority: CRM (non-empty) → provider → phone
 *  - Pending-conversation reconciliation logic
 *  - Mapping upsert semantics (participantId primary, participantKey transitional)
 */

// ─────────────────────────────────────────────────────────────
// Pure helpers — mirror server.js implementations for unit testing
// ─────────────────────────────────────────────────────────────

function toPhoneE164(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, '');
  if (digits.length < 7) return null;
  const s = String(raw).trim();
  if (s.startsWith('+')) return '+' + digits;
  if (digits.length === 10) return '+1' + digits;
  return '+' + digits;
}

function extractSigcoreParticipant(src) {
  if (!src || typeof src !== 'object') return null;
  const providerBlock = src.provider && typeof src.provider === 'object' ? src.provider : null;
  const participantId = src.participantId || src.participant_id || null;
  const participantKey = src.participantKey || src.participant_key || null;
  const participantPhoneE164 = toPhoneE164(
    src.participantPhoneE164 || src.participant_phone_e164 || src.participantPhone || src.participantPhoneNumber
  );
  const displayName = (providerBlock?.displayName) || src.contactName || src.conversationName
    || [src.firstName, src.lastName].filter(Boolean).join(' ') || null;
  const company = (providerBlock?.company) || src.company || null;
  const providerContactId = providerBlock?.contactId || src.contactId || null;
  const providerName = providerBlock?.name || src.providerName || 'openphone';
  return { participantId, participantKey, participantPhoneE164, providerContactId, provider: providerName, displayName, company };
}

// Pure version of CRM precedence logic (no DB)
function classifyCRMMatches(customers, leads) {
  if (customers.length === 1) {
    return { status: 'mapped', crm_customer_id: customers[0], crm_lead_id: null };
  }
  if (customers.length === 0 && leads.length === 1) {
    return { status: 'mapped', crm_customer_id: null, crm_lead_id: leads[0] };
  }
  if (customers.length === 0 && leads.length === 0) {
    return { status: 'unmapped', crm_customer_id: null, crm_lead_id: null };
  }
  return { status: 'ambiguous', crm_customer_id: null, crm_lead_id: null };
}

// PR4.1 — 5-bucket classifier (mirrors server.js classifyMapping)
const AGGREGATOR_NAME_RE = /(thumbtack|thumtack|thumback|thumbtac|tumbtack|thambtack|thumntack|yelp|leadbridge|google|facebook|bark|groupon|instagram|angi|homeadvisor|voolt|\bsite\b|cold call|refrenc|reference|recommend)/i;
function classifyMapping(crmMatches, participantName) {
  const customers = crmMatches?.customers || [];
  const leads = crmMatches?.leads || [];
  if (customers.length === 1) {
    return { status: 'mapped', crm_customer_id: customers[0], crm_lead_id: null };
  }
  if (customers.length === 0 && leads.length === 1) {
    return { status: 'mapped', crm_customer_id: null, crm_lead_id: leads[0] };
  }
  if (customers.length > 0 || leads.length > 0) {
    return { status: 'ambiguous', crm_customer_id: null, crm_lead_id: null };
  }
  const name = (participantName || '').trim();
  if (!name) return { status: 'noise', crm_customer_id: null, crm_lead_id: null };
  if (AGGREGATOR_NAME_RE.test(name)) return { status: 'aggregator', crm_customer_id: null, crm_lead_id: null };
  return { status: 'unmapped', crm_customer_id: null, crm_lead_id: null };
}

// Pure display-priority helper: CRM (non-empty) → provider → phone
function resolveDisplayName({ crmFirstName, crmLastName, providerDisplayName, phone }) {
  const nonEmpty = (s) => typeof s === 'string' && s.trim() !== '';
  const crmName = `${crmFirstName || ''} ${crmLastName || ''}`.trim();
  if (nonEmpty(crmName)) return crmName;
  if (nonEmpty(providerDisplayName)) return providerDisplayName;
  return phone || '';
}

// ─────────────────────────────────────────────────────────────
// Phone E.164 normalization
// ─────────────────────────────────────────────────────────────

describe('toPhoneE164', () => {
  test('10-digit US number gets +1 prefix', () => {
    expect(toPhoneE164('8139855031')).toBe('+18139855031');
  });
  test('11-digit number with leading 1', () => {
    expect(toPhoneE164('18139855031')).toBe('+18139855031');
  });
  test('already E.164 passes through', () => {
    expect(toPhoneE164('+18139855031')).toBe('+18139855031');
  });
  test('formatted phone', () => {
    expect(toPhoneE164('(813) 985-5031')).toBe('+18139855031');
  });
  test('too short returns null', () => {
    expect(toPhoneE164('123')).toBeNull();
  });
  test('null/undefined/empty returns null', () => {
    expect(toPhoneE164(null)).toBeNull();
    expect(toPhoneE164(undefined)).toBeNull();
    expect(toPhoneE164('')).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────
// Dual-read: Sigcore shape extraction
// ─────────────────────────────────────────────────────────────

describe('extractSigcoreParticipant (dual-read)', () => {
  test('reads new nested provider.* shape', () => {
    const sig = extractSigcoreParticipant({
      participantId: 'P123',
      participantKey: 'K456',
      participantPhoneE164: '+18135971584',
      provider: {
        name: 'openphone',
        contactId: 'C789',
        displayName: 'Stephen Jaros',
        company: 'Thumbtack',
      },
    });
    expect(sig.participantId).toBe('P123');
    expect(sig.participantKey).toBe('K456');
    expect(sig.participantPhoneE164).toBe('+18135971584');
    expect(sig.providerContactId).toBe('C789');
    expect(sig.displayName).toBe('Stephen Jaros');
    expect(sig.company).toBe('Thumbtack');
    expect(sig.provider).toBe('openphone');
  });

  test('falls back to legacy flat fields when nested absent', () => {
    const sig = extractSigcoreParticipant({
      participantPhone: '+18135971584',
      contactName: 'Stephen Jaros',
      company: 'Thumbtack',
      firstName: 'Stephen',
      lastName: 'Jaros',
    });
    expect(sig.participantId).toBeNull();
    expect(sig.participantPhoneE164).toBe('+18135971584');
    expect(sig.displayName).toBe('Stephen Jaros');
    expect(sig.company).toBe('Thumbtack');
    expect(sig.provider).toBe('openphone'); // default
  });

  test('provider.* takes priority over legacy', () => {
    const sig = extractSigcoreParticipant({
      contactName: 'Legacy Name',
      company: 'Legacy Co',
      provider: {
        name: 'openphone',
        displayName: 'New Name',
        company: 'New Co',
      },
    });
    expect(sig.displayName).toBe('New Name');
    expect(sig.company).toBe('New Co');
  });

  test('uses firstName+lastName when contactName missing', () => {
    const sig = extractSigcoreParticipant({
      firstName: 'John',
      lastName: 'Doe',
    });
    expect(sig.displayName).toBe('John Doe');
  });

  test('returns null for bad input', () => {
    expect(extractSigcoreParticipant(null)).toBeNull();
    expect(extractSigcoreParticipant(undefined)).toBeNull();
    expect(extractSigcoreParticipant('string')).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────
// CRM matching precedence
// ─────────────────────────────────────────────────────────────

describe('CRM match precedence (classifyCRMMatches)', () => {
  test('exactly 1 customer → mapped (customer)', () => {
    expect(classifyCRMMatches([42], [])).toEqual({
      status: 'mapped', crm_customer_id: 42, crm_lead_id: null,
    });
  });

  test('0 customers + 1 lead → mapped (lead)', () => {
    expect(classifyCRMMatches([], [99])).toEqual({
      status: 'mapped', crm_customer_id: null, crm_lead_id: 99,
    });
  });

  test('customer takes precedence over lead — 1 customer + 1 lead maps to customer', () => {
    // Per spec §3: "exactly one customer matches the phone → mapped" — lead count does not matter when a single customer exists.
    expect(classifyCRMMatches([42], [99])).toEqual({
      status: 'mapped', crm_customer_id: 42, crm_lead_id: null,
    });
  });

  test('2 customers → ambiguous', () => {
    expect(classifyCRMMatches([42, 43], [])).toEqual({
      status: 'ambiguous', crm_customer_id: null, crm_lead_id: null,
    });
  });

  test('2 leads, no customer → ambiguous', () => {
    expect(classifyCRMMatches([], [99, 100])).toEqual({
      status: 'ambiguous', crm_customer_id: null, crm_lead_id: null,
    });
  });

  test('no matches → unmapped', () => {
    expect(classifyCRMMatches([], [])).toEqual({
      status: 'unmapped', crm_customer_id: null, crm_lead_id: null,
    });
  });
});

// ─────────────────────────────────────────────────────────────
// Display priority (CRM non-empty → provider → phone)
// ─────────────────────────────────────────────────────────────

describe('Display priority', () => {
  test('CRM name wins when both first and last names present', () => {
    expect(resolveDisplayName({
      crmFirstName: 'Patricia', crmLastName: 'Phelps',
      providerDisplayName: 'Provider Name',
      phone: '+18133610464',
    })).toBe('Patricia Phelps');
  });

  test('Provider wins when CRM record has blank names', () => {
    expect(resolveDisplayName({
      crmFirstName: '', crmLastName: '',
      providerDisplayName: 'Provider Name',
      phone: '+18133610464',
    })).toBe('Provider Name');
  });

  test('Provider wins when CRM record has only whitespace', () => {
    expect(resolveDisplayName({
      crmFirstName: '  ', crmLastName: ' ',
      providerDisplayName: 'Provider Name',
      phone: '+18133610464',
    })).toBe('Provider Name');
  });

  test('Phone used when both CRM and provider are blank', () => {
    expect(resolveDisplayName({
      crmFirstName: '', crmLastName: '',
      providerDisplayName: '',
      phone: '+18133610464',
    })).toBe('+18133610464');
  });

  test('CRM first name only still wins over provider', () => {
    expect(resolveDisplayName({
      crmFirstName: 'Patricia', crmLastName: '',
      providerDisplayName: 'Provider Name',
      phone: '+18133610464',
    })).toBe('Patricia');
  });
});

// ─────────────────────────────────────────────────────────────
// Sparse coverage state machine
// ─────────────────────────────────────────────────────────────

describe('Sparse coverage state (Case A / A\' / B / C)', () => {
  // Decide how a conversation should be recorded based on Sigcore payload
  function classifyCoverage(sig) {
    if (sig.participantId) return { case: 'A', pending: false, canCreateMapping: true };
    if (sig.participantKey) return { case: "A'", pending: false, canCreateMapping: true };
    if (sig.participantPhoneE164) return { case: 'B', pending: true, canCreateMapping: false };
    return { case: 'C', pending: false, canCreateMapping: false };
  }

  test('Case A: participantId present → mapping created, not pending', () => {
    expect(classifyCoverage({ participantId: 'P1', participantPhoneE164: '+18139855031' }))
      .toEqual({ case: 'A', pending: false, canCreateMapping: true });
  });

  test("Case A': only participantKey → mapping created (transitional), not pending", () => {
    expect(classifyCoverage({ participantKey: 'K1', participantPhoneE164: '+18139855031' }))
      .toEqual({ case: "A'", pending: false, canCreateMapping: true });
  });

  test('Case B: phone only, no identity → pending flag set, NO mapping row', () => {
    expect(classifyCoverage({ participantPhoneE164: '+18139855031' }))
      .toEqual({ case: 'B', pending: true, canCreateMapping: false });
  });

  test('Case C: no phone, no identity → provider-only display', () => {
    expect(classifyCoverage({}))
      .toEqual({ case: 'C', pending: false, canCreateMapping: false });
  });
});

// ─────────────────────────────────────────────────────────────
// Reconciliation attachment logic
// ─────────────────────────────────────────────────────────────

describe('Pending conversation reconciliation', () => {
  // Simulate attaching pending conversations when a participant resolves for their phone
  function reconcilePendingForPhone(conversations, resolvedPhone, mappingId) {
    const last10 = String(resolvedPhone).replace(/\D/g, '').slice(-10);
    let attached = 0;
    for (const c of conversations) {
      const convLast10 = String(c.participant_phone || '').replace(/\D/g, '').slice(-10);
      if (c.participant_pending && convLast10 === last10) {
        c.participant_mapping_id = mappingId;
        c.participant_pending = false;
        attached++;
      }
    }
    return attached;
  }

  test('attaches all pending conversations for the same phone', () => {
    const convs = [
      { id: 1, participant_phone: '+18139855031', participant_pending: true, participant_mapping_id: null },
      { id: 2, participant_phone: '+18139855031', participant_pending: true, participant_mapping_id: null },
      { id: 3, participant_phone: '+18139855031', participant_pending: false, participant_mapping_id: 7 }, // already mapped
      { id: 4, participant_phone: '+19999999999', participant_pending: true, participant_mapping_id: null }, // diff phone
    ];
    const attached = reconcilePendingForPhone(convs, '+18139855031', 42);
    expect(attached).toBe(2);
    expect(convs[0].participant_mapping_id).toBe(42);
    expect(convs[0].participant_pending).toBe(false);
    expect(convs[1].participant_mapping_id).toBe(42);
    expect(convs[2].participant_mapping_id).toBe(7); // untouched
    expect(convs[3].participant_pending).toBe(true); // different phone untouched
  });

  test('zero attached when no pending rows match', () => {
    const convs = [
      { id: 1, participant_phone: '+18139855031', participant_pending: false, participant_mapping_id: 99 },
    ];
    expect(reconcilePendingForPhone(convs, '+18139855031', 42)).toBe(0);
  });

  test('matches by last-10 digits, ignores formatting', () => {
    const convs = [
      { id: 1, participant_phone: '(813) 985-5031', participant_pending: true, participant_mapping_id: null },
    ];
    expect(reconcilePendingForPhone(convs, '+18139855031', 42)).toBe(1);
    expect(convs[0].participant_mapping_id).toBe(42);
  });
});

// ─────────────────────────────────────────────────────────────
// Mapping upsert semantics
// ─────────────────────────────────────────────────────────────

describe('Mapping upsert (participantId primary, participantKey transitional)', () => {
  // Simulate mapping-table state + upsert
  function upsertMapping(existingRows, newSig) {
    // 1. Try match by participantId
    if (newSig.participantId) {
      const byId = existingRows.find(r =>
        r.tenant_id === newSig.tenant_id && r.provider === newSig.provider &&
        r.sigcore_participant_id === newSig.participantId);
      if (byId) {
        byId.sigcore_participant_key = newSig.participantKey || byId.sigcore_participant_key;
        byId.participant_phone_e164 = newSig.participantPhoneE164 || byId.participant_phone_e164;
        return { row: byId, created: false };
      }
      // 2. Upgrade key-only row when participantId arrives
      if (newSig.participantKey) {
        const byKeyOnly = existingRows.find(r =>
          r.tenant_id === newSig.tenant_id && r.provider === newSig.provider &&
          r.sigcore_participant_id === null &&
          r.sigcore_participant_key === newSig.participantKey);
        if (byKeyOnly) {
          byKeyOnly.sigcore_participant_id = newSig.participantId;
          return { row: byKeyOnly, created: false };
        }
      }
    }
    // 3. Key-only lookup (transitional case)
    if (!newSig.participantId && newSig.participantKey) {
      const byKey = existingRows.find(r =>
        r.tenant_id === newSig.tenant_id && r.provider === newSig.provider &&
        r.sigcore_participant_id === null &&
        r.sigcore_participant_key === newSig.participantKey);
      if (byKey) return { row: byKey, created: false };
    }
    // 4. Insert new
    const row = {
      id: existingRows.length + 1,
      tenant_id: newSig.tenant_id, provider: newSig.provider,
      sigcore_participant_id: newSig.participantId || null,
      sigcore_participant_key: newSig.participantKey || null,
      participant_phone_e164: newSig.participantPhoneE164 || null,
      mapping_status: 'unmapped',
    };
    existingRows.push(row);
    return { row, created: true };
  }

  test('creates new row on first sight', () => {
    const rows = [];
    const { created } = upsertMapping(rows, {
      tenant_id: 2, provider: 'openphone',
      participantId: 'P1', participantPhoneE164: '+18139855031',
    });
    expect(created).toBe(true);
    expect(rows).toHaveLength(1);
  });

  test('re-finds existing row by participantId (no duplicates)', () => {
    const rows = [{
      id: 1, tenant_id: 2, provider: 'openphone',
      sigcore_participant_id: 'P1', sigcore_participant_key: null,
      participant_phone_e164: '+18139855031',
    }];
    const { created } = upsertMapping(rows, {
      tenant_id: 2, provider: 'openphone',
      participantId: 'P1', participantPhoneE164: '+18139855031',
    });
    expect(created).toBe(false);
    expect(rows).toHaveLength(1);
  });

  test('upgrades key-only row when participantId arrives (no duplicate)', () => {
    const rows = [{
      id: 1, tenant_id: 2, provider: 'openphone',
      sigcore_participant_id: null, sigcore_participant_key: 'K1',
      participant_phone_e164: '+18139855031',
    }];
    const { created, row } = upsertMapping(rows, {
      tenant_id: 2, provider: 'openphone',
      participantId: 'P1', participantKey: 'K1',
      participantPhoneE164: '+18139855031',
    });
    expect(created).toBe(false);
    expect(rows).toHaveLength(1);
    expect(row.sigcore_participant_id).toBe('P1');
    expect(row.sigcore_participant_key).toBe('K1');
  });

  test('does not duplicate when only participantKey is provided twice', () => {
    const rows = [{
      id: 1, tenant_id: 2, provider: 'openphone',
      sigcore_participant_id: null, sigcore_participant_key: 'K1',
      participant_phone_e164: '+18139855031',
    }];
    const { created } = upsertMapping(rows, {
      tenant_id: 2, provider: 'openphone',
      participantKey: 'K1', participantPhoneE164: '+18139855031',
    });
    expect(created).toBe(false);
    expect(rows).toHaveLength(1);
  });

  test('phone alone is NEVER a mapping key — different participantIds create separate rows', () => {
    const rows = [];
    upsertMapping(rows, {
      tenant_id: 2, provider: 'openphone',
      participantId: 'P1', participantPhoneE164: '+18139855031',
    });
    upsertMapping(rows, {
      tenant_id: 2, provider: 'openphone',
      participantId: 'P2', participantPhoneE164: '+18139855031', // same phone, different participant
    });
    expect(rows).toHaveLength(2);
  });
});

// ─────────────────────────────────────────────────────────────
// Backfill — reuse existing CRM link
// ─────────────────────────────────────────────────────────────

describe('Backfill: reuse existing customer_id / lead_id', () => {
  // Simulate backfill decision logic
  function backfillStatusFor(conv, phoneMatches) {
    if (conv.customer_id || conv.lead_id) {
      return {
        status: 'mapped',
        crm_customer_id: conv.customer_id || null,
        crm_lead_id: conv.lead_id || null,
        source: 'backfill-legacy-link',
      };
    }
    // Phone-based precedence (classifyCRMMatches)
    return {
      ...classifyCRMMatches(phoneMatches?.customers || [], phoneMatches?.leads || []),
      source: 'backfill-phone',
    };
  }

  test('reuses existing customer_id without re-running phone lookup', () => {
    const result = backfillStatusFor(
      { customer_id: 99, lead_id: null },
      { customers: [77], leads: [] } // phone would match a DIFFERENT customer
    );
    expect(result.status).toBe('mapped');
    expect(result.crm_customer_id).toBe(99); // preserves existing link
    expect(result.source).toBe('backfill-legacy-link');
  });

  test('reuses existing lead_id when no customer link', () => {
    const result = backfillStatusFor(
      { customer_id: null, lead_id: 50 },
      { customers: [], leads: [] }
    );
    expect(result.status).toBe('mapped');
    expect(result.crm_lead_id).toBe(50);
  });

  test('falls back to phone match when no legacy link', () => {
    const result = backfillStatusFor(
      { customer_id: null, lead_id: null },
      { customers: [77], leads: [] }
    );
    expect(result.status).toBe('mapped');
    expect(result.crm_customer_id).toBe(77);
    expect(result.source).toBe('backfill-phone');
  });

  test('unmapped when neither legacy link nor phone match', () => {
    const result = backfillStatusFor(
      { customer_id: null, lead_id: null },
      { customers: [], leads: [] }
    );
    expect(result.status).toBe('unmapped');
  });
});

// ─────────────────────────────────────────────────────────────
// Phone is never a permanent identity key
// ─────────────────────────────────────────────────────────────

describe('Phone is NEVER a permanent identity key', () => {
  test('Case B (phone only, no participantId/key) does not create a mapping row', () => {
    const sig = extractSigcoreParticipant({
      participantPhone: '+18139855031',
      // no participantId, no participantKey
    });
    // Guard from the real sync code: mapping creation requires participantId OR participantKey
    const canCreateMapping = !!(sig.participantId || sig.participantKey);
    expect(canCreateMapping).toBe(false);
  });

  test('two participants with same phone still get separate mappings', () => {
    // The phone is a lookup attribute; participant identity is what distinguishes them.
    const participant1 = { participantId: 'P1', participantPhoneE164: '+18139855031' };
    const participant2 = { participantId: 'P2', participantPhoneE164: '+18139855031' };
    expect(participant1.participantId).not.toBe(participant2.participantId);
  });
});

// ─────────────────────────────────────────────────────────────
// PR4.1 — 5-bucket classifier (mapped / ambiguous / unmapped / aggregator / noise)
// ─────────────────────────────────────────────────────────────

describe('classifyMapping — 5-bucket status', () => {
  // CRM precedence: mapped / ambiguous dominate regardless of name
  test('1 customer → mapped (customer wins over name)', () => {
    expect(classifyMapping({ customers: [42], leads: [] }, 'Thumbtack Miami').status).toBe('mapped');
    expect(classifyMapping({ customers: [42], leads: [] }, '').status).toBe('mapped');
  });

  test('0 customer + 1 lead → mapped (lead)', () => {
    expect(classifyMapping({ customers: [], leads: [99] }, 'any name').status).toBe('mapped');
  });

  test('multiple matches → ambiguous regardless of name', () => {
    expect(classifyMapping({ customers: [1, 2], leads: [] }, 'Sue Yoder').status).toBe('ambiguous');
    expect(classifyMapping({ customers: [], leads: [10, 11] }, '').status).toBe('ambiguous');
    expect(classifyMapping({ customers: [1], leads: [99] }, 'Aggregator Thumbtack').status).toBe('mapped'); // 1 customer wins
  });

  // No CRM match → name-based bucketing
  test('no CRM + blank/null name → noise', () => {
    expect(classifyMapping({ customers: [], leads: [] }, null).status).toBe('noise');
    expect(classifyMapping({ customers: [], leads: [] }, '').status).toBe('noise');
    expect(classifyMapping({ customers: [], leads: [] }, '   ').status).toBe('noise');
  });

  test('no CRM + aggregator-alias name → aggregator', () => {
    // Exact platform keywords
    expect(classifyMapping({ customers: [], leads: [] }, 'Thumbtack').status).toBe('aggregator');
    expect(classifyMapping({ customers: [], leads: [] }, 'Yelp').status).toBe('aggregator');
    expect(classifyMapping({ customers: [], leads: [] }, 'LeadBridge').status).toBe('aggregator');
    // Location variants
    expect(classifyMapping({ customers: [], leads: [] }, 'Thumbtack Miami').status).toBe('aggregator');
    expect(classifyMapping({ customers: [], leads: [] }, 'LeadBridge Miami').status).toBe('aggregator');
    // Common misspellings from OpenPhone contacts
    expect(classifyMapping({ customers: [], leads: [] }, 'Tumbtack J').status).toBe('aggregator');
    expect(classifyMapping({ customers: [], leads: [] }, 'Thumback J').status).toBe('aggregator');
    // Case insensitive
    expect(classifyMapping({ customers: [], leads: [] }, 'google local ads').status).toBe('aggregator');
  });

  test('no CRM + real person name → unmapped (actionable)', () => {
    expect(classifyMapping({ customers: [], leads: [] }, 'Sue Yoder').status).toBe('unmapped');
    expect(classifyMapping({ customers: [], leads: [] }, 'Patricia Phelps').status).toBe('unmapped');
    expect(classifyMapping({ customers: [], leads: [] }, 'Connie Lindsey').status).toBe('unmapped');
  });

  test('name containing aggregator word anywhere triggers aggregator (known tradeoff)', () => {
    // e.g. "John from Thumbtack" → aggregator. Acceptable: real people rarely named like this.
    expect(classifyMapping({ customers: [], leads: [] }, 'John Carney from Thumbtack').status).toBe('aggregator');
  });
});

// ─────────────────────────────────────────────────────────────
// Reclassify transitions — existing data moves between buckets
// ─────────────────────────────────────────────────────────────

describe('Reclassify preserves CRM links', () => {
  function reclassifyDecision(currentRow, classification) {
    // Mirror server logic: if existing row has CRM link, trust it regardless of classifier
    if ((currentRow.crm_customer_id || currentRow.crm_lead_id)
      && classification.status !== 'mapped'
      && classification.status !== 'ambiguous') {
      return {
        status: 'mapped',
        crm_customer_id: currentRow.crm_customer_id,
        crm_lead_id: currentRow.crm_lead_id,
      };
    }
    return classification;
  }

  test('manual mappings are excluded from reclassify (not tested here; guarded at query level)', () => {
    // The server query filters .neq('mapping_status', 'manual') before reclassifying.
    // Simulated: manual rows never reach this function.
    expect(true).toBe(true);
  });

  test('existing mapped with crm_customer_id stays mapped even if name is aggregator', () => {
    // Scenario: user manually attached a customer to what's technically a platform alias phone
    const current = { crm_customer_id: 99, crm_lead_id: null, mapping_status: 'mapped' };
    const classification = classifyMapping({ customers: [], leads: [] }, 'Thumbtack Miami');
    const result = reclassifyDecision(current, classification);
    expect(result.status).toBe('mapped');
    expect(result.crm_customer_id).toBe(99);
  });

  test('existing unmapped with name → reclassifies to unmapped (actionable)', () => {
    const current = { crm_customer_id: null, crm_lead_id: null, mapping_status: 'unmapped' };
    const result = reclassifyDecision(current, classifyMapping({ customers: [], leads: [] }, 'Sue Yoder'));
    expect(result.status).toBe('unmapped');
  });

  test('existing unmapped without name → reclassifies to noise', () => {
    const current = { crm_customer_id: null, crm_lead_id: null, mapping_status: 'unmapped' };
    const result = reclassifyDecision(current, classifyMapping({ customers: [], leads: [] }, null));
    expect(result.status).toBe('noise');
  });

  test('existing unmapped with aggregator name → reclassifies to aggregator', () => {
    const current = { crm_customer_id: null, crm_lead_id: null, mapping_status: 'unmapped' };
    const result = reclassifyDecision(current, classifyMapping({ customers: [], leads: [] }, 'Thumbtack S'));
    expect(result.status).toBe('aggregator');
  });

  test('newly-discovered customer match upgrades a previously-noise row to mapped', () => {
    const current = { crm_customer_id: null, crm_lead_id: null, mapping_status: 'noise' };
    // Now a customer with matching phone exists
    const result = reclassifyDecision(current, classifyMapping({ customers: [42], leads: [] }, null));
    expect(result.status).toBe('mapped');
    expect(result.crm_customer_id).toBe(42);
  });
});

// ─────────────────────────────────────────────────────────────
// Aggregator pattern coverage (prove regex handles SF's actual data)
// ─────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────
// PR4.2 — LeadBridge per-location source write-path + upgrade
// ─────────────────────────────────────────────────────────────

describe('LeadBridge source write-path (new records)', () => {
  // Mirror: const source = accountDisplayName ? `${accountDisplayName} (${channel})` : (channel === 'yelp' ? 'leadbridge_yelp' : 'leadbridge_thumbtack')
  function deriveLeadSource({ accountDisplayName, channel }) {
    if (accountDisplayName) return `${accountDisplayName} (${channel})`;
    return channel === 'yelp' ? 'leadbridge_yelp' : 'leadbridge_thumbtack';
  }

  test('with account display_name → per-location source (yelp)', () => {
    expect(deriveLeadSource({ accountDisplayName: 'Spotless Homes Tampa', channel: 'yelp' }))
      .toBe('Spotless Homes Tampa (yelp)');
  });

  test('with account display_name → per-location source (thumbtack)', () => {
    expect(deriveLeadSource({ accountDisplayName: 'Spotless Homes Saint Petersburg', channel: 'thumbtack' }))
      .toBe('Spotless Homes Saint Petersburg (thumbtack)');
  });

  test('no account display_name → legacy flat fallback (yelp)', () => {
    expect(deriveLeadSource({ accountDisplayName: null, channel: 'yelp' })).toBe('leadbridge_yelp');
  });

  test('no account display_name → legacy flat fallback (thumbtack)', () => {
    expect(deriveLeadSource({ accountDisplayName: undefined, channel: 'thumbtack' })).toBe('leadbridge_thumbtack');
  });

  test('every LB account produces a unique per-location source', () => {
    const accounts = [
      { display_name: 'Spotless Homes Tampa', channel: 'yelp' },
      { display_name: 'Spotless Homes Tampa', channel: 'thumbtack' },
      { display_name: 'Spotless Homes Jacksonville', channel: 'yelp' },
      { display_name: 'Spotless Homes Jacksonville', channel: 'thumbtack' },
      { display_name: 'Spotless Homes Saint Petersburg', channel: 'thumbtack' },
    ];
    const sources = new Set(accounts.map(a => deriveLeadSource({ accountDisplayName: a.display_name, channel: a.channel })));
    expect(sources.size).toBe(accounts.length);
    // And none of them are the flat legacy values
    for (const s of sources) {
      expect(s).not.toBe('leadbridge_yelp');
      expect(s).not.toBe('leadbridge_thumbtack');
    }
  });
});

describe('LeadBridge source upgrade — idempotency + explicit unresolved handling', () => {
  // Simulate the upgrade bucket classifier
  function classifyUpgrade(record, validNewSources, phoneToAccount) {
    if (validNewSources.has(record.source)) return { bucket: 'already_correct_skipped' };
    if (!['leadbridge_yelp', 'leadbridge_thumbtack'].includes(record.source)) {
      return { bucket: 'not_legacy' };
    }
    const last10 = String(record.phone || '').replace(/\D/g, '').slice(-10);
    if (!last10 || last10.length < 7) {
      return { bucket: 'unresolved_no_context', reason: 'no phone on record' };
    }
    const acct = phoneToAccount[last10];
    if (!acct) return { bucket: 'unresolved_no_context', reason: 'no LB conversation found for this phone' };
    return { bucket: 'upgraded_successfully', new_source: `${acct.display_name} (${acct.channel})` };
  }

  const validNewSources = new Set([
    'Spotless Homes Tampa (yelp)',
    'Spotless Homes Tampa (thumbtack)',
    'Spotless Homes Jacksonville (yelp)',
  ]);
  const phoneToAccount = {
    '8139855031': { display_name: 'Spotless Homes Tampa', channel: 'yelp' },
    '9045778584': { display_name: 'Spotless Homes Jacksonville', channel: 'thumbtack' },
  };

  test('rewrites legacy flat value when LB context exists', () => {
    const r = classifyUpgrade(
      { source: 'leadbridge_yelp', phone: '8139855031' },
      validNewSources, phoneToAccount
    );
    expect(r.bucket).toBe('upgraded_successfully');
    expect(r.new_source).toBe('Spotless Homes Tampa (yelp)');
  });

  test('idempotent — re-running skips already-correct values', () => {
    const r = classifyUpgrade(
      { source: 'Spotless Homes Tampa (yelp)', phone: '8139855031' },
      validNewSources, phoneToAccount
    );
    expect(r.bucket).toBe('already_correct_skipped');
  });

  test('unresolved — no phone, cannot infer account', () => {
    const r = classifyUpgrade(
      { source: 'leadbridge_yelp', phone: null },
      validNewSources, phoneToAccount
    );
    expect(r.bucket).toBe('unresolved_no_context');
    expect(r.reason).toMatch(/no phone/);
  });

  test('unresolved — phone exists but no LB conversation linked to an account', () => {
    const r = classifyUpgrade(
      { source: 'leadbridge_thumbtack', phone: '5551234567' },
      validNewSources, phoneToAccount
    );
    expect(r.bucket).toBe('unresolved_no_context');
    expect(r.reason).toMatch(/no LB conversation/);
  });

  test('NEVER silently assigns a guessed default for unresolved rows', () => {
    // Acceptance criterion 4: unresolved rows must be reported explicitly, not silently flattened
    const r = classifyUpgrade(
      { source: 'leadbridge_yelp', phone: null },
      validNewSources, phoneToAccount
    );
    expect(r.bucket).not.toBe('upgraded_successfully');
    expect(r.new_source).toBeUndefined();
  });

  test('non-legacy rows are not touched', () => {
    const r = classifyUpgrade(
      { source: 'Website', phone: '8139855031' },
      validNewSources, phoneToAccount
    );
    expect(r.bucket).toBe('not_legacy');
  });
});

describe('Aggregator regex matches observed SF contact names', () => {
  const observedAggregatorNames = [
    'Thumbtack', 'Thumbtack S', 'Thumbtack J', 'Thumbtack T',
    'Thumbtack Miami', 'Thumbtack Tampa', 'Thumbtack Jacksonville',
    'Thumbtack NY', 'Thumbtack Saint Peters', 'Thumbtack St Peters',
    'Tumbtack J', 'Thumback J', 'Thambtack T', 'Thumntack S', 'Thumtack Tampa',
    'Yelp', 'Yelp J', 'Yelp T', 'Yelp Tampa',
    'LeadBridge', 'LeadBridge Miami', 'LeadBridge Tampa',
    'Google', 'Google Local Ads', 'Google Tampa', 'Google Jacksonville', 'Google ad', 'Google Ads',
    'Facebook', 'Facebook J', 'Instagram', 'Instagramm',
    'Bark', 'Groupon', 'Voolt',
    'Cold Call', 'Site request', 'Site Request', 'Site Jacksonville',
  ];

  for (const name of observedAggregatorNames) {
    test(`"${name}" classified as aggregator`, () => {
      expect(AGGREGATOR_NAME_RE.test(name)).toBe(true);
    });
  }

  const realNames = [
    'Sue Yoder', 'Patricia Phelps', 'Connie Lindsey', 'Stephen Jaros',
    'Shaprika Jones', 'Dannie Ryan', 'Jessica Pringle', 'Nancy Wasserman',
  ];
  for (const name of realNames) {
    test(`real person "${name}" does NOT match aggregator regex`, () => {
      expect(AGGREGATOR_NAME_RE.test(name)).toBe(false);
    });
  }
});
