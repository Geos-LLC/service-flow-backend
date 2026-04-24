const { findCrmMatchByPhone } = require('../lib/openphone-crm-match');
const { shouldOpenPhoneCreateLead } = require('../lib/openphone-ingestion');

// Lightweight mock of the supabase query chain for customers/leads single-row reads.
// Supports: .from(table).select(cols).eq(col, val).ilike(col, val).limit(n).maybeSingle()
function mockSupabaseWithCrm({ customers = [], leads = [] } = {}) {
  function tableChain(rows) {
    const filters = [];
    const chain = {
      select() { return chain; },
      eq(col, val) { filters.push({ op: 'eq', col, val }); return chain; },
      ilike(col, val) {
        // Supabase ILIKE — val is '%last10%'. Strip the %s and lowercase compare.
        const pattern = String(val).replace(/%/g, '').toLowerCase();
        filters.push({ op: 'ilike', col, pattern });
        return chain;
      },
      limit() { return chain; },
      maybeSingle() {
        const match = rows.find(r => filters.every(f => {
          if (f.op === 'eq') return r[f.col] === f.val;
          if (f.op === 'ilike') return String(r[f.col] || '').toLowerCase().includes(f.pattern);
          return true;
        }));
        return Promise.resolve({ data: match || null, error: null });
      },
    };
    return chain;
  }
  return {
    from(tbl) {
      if (tbl === 'customers') return tableChain(customers);
      if (tbl === 'leads') return tableChain(leads);
      if (tbl === 'communication_participant_identities') {
        return {
          update() { return { eq: () => Promise.resolve({ data: [], error: null }) }; },
        };
      }
      throw new Error('mock unknown table ' + tbl);
    },
  };
}

describe('findCrmMatchByPhone', () => {
  test('returns customer match when phone exists in customers', async () => {
    const sb = mockSupabaseWithCrm({
      customers: [{ id: 22860, user_id: 2, phone: '+19043306654' }],
      leads: [],
    });
    const r = await findCrmMatchByPhone(sb, 2, '+19043306654');
    expect(r).toEqual({ type: 'customer', id: 22860, matched_phone: '+19043306654' });
  });

  test('returns lead match when only leads have the phone', async () => {
    const sb = mockSupabaseWithCrm({
      customers: [],
      leads: [{ id: 500, user_id: 2, phone: '+12629305925' }],
    });
    const r = await findCrmMatchByPhone(sb, 2, '+12629305925');
    expect(r.type).toBe('lead');
    expect(r.id).toBe(500);
  });

  test('customer takes precedence when both match (stronger CRM record)', async () => {
    const sb = mockSupabaseWithCrm({
      customers: [{ id: 10, user_id: 2, phone: '2629305925' }],
      leads: [{ id: 500, user_id: 2, phone: '+12629305925' }],
    });
    const r = await findCrmMatchByPhone(sb, 2, '+12629305925');
    expect(r.type).toBe('customer');
    expect(r.id).toBe(10);
  });

  test('returns null when no match in either table', async () => {
    const sb = mockSupabaseWithCrm({ customers: [], leads: [] });
    const r = await findCrmMatchByPhone(sb, 2, '+19999999999');
    expect(r).toEqual({ type: null, id: null, matched_phone: null });
  });

  test('null/empty phone input returns null', async () => {
    const sb = mockSupabaseWithCrm();
    expect(await findCrmMatchByPhone(sb, 2, null)).toEqual({ type: null, id: null, matched_phone: null });
    expect(await findCrmMatchByPhone(sb, 2, '')).toEqual({ type: null, id: null, matched_phone: null });
    expect(await findCrmMatchByPhone(sb, 2, '123')).toEqual({ type: null, id: null, matched_phone: null });
  });

  test('tenant-scoped: does not match another tenant\'s customer by same phone', async () => {
    const sb = mockSupabaseWithCrm({
      customers: [{ id: 99, user_id: 20, phone: '+12629305925' }],
      leads: [],
    });
    const r = await findCrmMatchByPhone(sb, 2, '+12629305925');
    expect(r.type).toBeNull();
  });

  test('accepts last-10 input and matches E.164-stored customer phones', async () => {
    const sb = mockSupabaseWithCrm({
      customers: [{ id: 10, user_id: 2, phone: '+12629305925' }],
    });
    const r = await findCrmMatchByPhone(sb, 2, '2629305925');
    expect(r.type).toBe('customer');
    expect(r.id).toBe(10);
  });
});

// --- The 4 scenarios the user asked for — verified via decision-helper composition ---
//
// The composition is:
//   shouldOpenPhoneCreateLead → decision.create
//     if false → skip
//     if true  → findCrmMatchByPhone; if match, link; else create
//
// Orchestrator lives in server.js; here we verify the two pure pieces produce
// the correct instruction set for each scenario.

describe('scenario — floater + phone matches existing customer → should link, not create', () => {
  test('decision says create, CRM lookup finds customer → orchestrator must link', async () => {
    const identity = { id: 1, sf_lead_id: null, sf_customer_id: null, leadbridge_contact_id: null, normalized_phone: '9043306654' };
    const d = shouldOpenPhoneCreateLead({
      identity,
      canonicalSource: 'Google Tampa',
      participantName: 'Real Person',
    });
    expect(d.create).toBe(true); // pure decision says yes

    const sb = mockSupabaseWithCrm({
      customers: [{ id: 22860, user_id: 2, phone: '+19043306654' }],
    });
    const r = await findCrmMatchByPhone(sb, 2, identity.normalized_phone);
    expect(r.type).toBe('customer');
    expect(r.id).toBe(22860);
    // Orchestrator: on customer match, link identity.sf_customer_id = 22860,
    // do NOT create. Covered by integration in server.js.
  });
});

describe('scenario — floater + phone matches existing lead → should link, not create', () => {
  test('decision says create, CRM lookup finds lead → orchestrator must link', async () => {
    const identity = { id: 1, sf_lead_id: null, sf_customer_id: null, leadbridge_contact_id: null, normalized_phone: '2629305925' };
    const d = shouldOpenPhoneCreateLead({
      identity,
      canonicalSource: 'Google Tampa',
      participantName: 'Linda Mau',
    });
    expect(d.create).toBe(true);

    const sb = mockSupabaseWithCrm({
      customers: [],
      leads: [{ id: 500, user_id: 2, phone: '+12629305925' }],
    });
    const r = await findCrmMatchByPhone(sb, 2, identity.normalized_phone);
    expect(r.type).toBe('lead');
    expect(r.id).toBe(500);
  });
});

describe('scenario — non-LB floater with no CRM match → create lead', () => {
  test('decision says create, CRM lookup returns null → orchestrator creates', async () => {
    const identity = { id: 1, sf_lead_id: null, sf_customer_id: null, leadbridge_contact_id: null, normalized_phone: '9176750713' };
    const d = shouldOpenPhoneCreateLead({
      identity,
      canonicalSource: 'Google Tampa',
      participantName: 'Jacob',
    });
    expect(d.create).toBe(true);
    expect(d.note).toBe('openphone_direct');

    const sb = mockSupabaseWithCrm({ customers: [], leads: [] });
    const r = await findCrmMatchByPhone(sb, 2, identity.normalized_phone);
    expect(r.type).toBeNull();
    // Orchestrator proceeds to lead creation.
  });
});

describe('scenario — floater with missing company → skip (no CRM lookup needed)', () => {
  test('decision says skip → orchestrator returns null without CRM lookup', () => {
    const identity = { id: 1, sf_lead_id: null, sf_customer_id: null, normalized_phone: '9043306654' };
    const d = shouldOpenPhoneCreateLead({
      identity,
      canonicalSource: null, // no mapped source → missing company
      participantName: 'Jill Sirick',
    });
    expect(d.create).toBe(false);
    expect(d.reason).toBe('no_canonical_source');
    // Orchestrator skips CRM lookup entirely when decision is false.
  });
});

describe('scenario — Thumbtack (LB-owned) + NO leadbridge_contact_id → LB-recovery path', () => {
  test('decision says create (LB recovery), CRM lookup may still find match', async () => {
    const identity = { id: 1, sf_lead_id: null, sf_customer_id: null, leadbridge_contact_id: null, normalized_phone: '2629305925' };
    const d = shouldOpenPhoneCreateLead({
      identity,
      canonicalSource: 'Thumbtack Tampa',
      participantName: 'Linda Mau',
    });
    expect(d.create).toBe(true);
    expect(d.note).toBe('openphone_lb_recovery');

    // Even LB-recovery path must go through CRM phone lookup before creating.
    const sb = mockSupabaseWithCrm({
      customers: [{ id: 12345, user_id: 2, phone: '+12629305925' }],
    });
    const r = await findCrmMatchByPhone(sb, 2, identity.normalized_phone);
    expect(r.type).toBe('customer');
    // Even though LB-recovery "wanted" to create a lead, the CRM match wins:
    // orchestrator links the customer instead.
  });
});
