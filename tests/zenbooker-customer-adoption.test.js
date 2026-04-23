/**
 * Zenbooker Customer Adoption Tests
 *
 * Verifies that when Zenbooker sync encounters a customer:
 *   - First: match by zenbooker_id (existing ZB customer)
 *   - Else: match by phone (adopt SF-only customer)
 *   - Else: match by email (adopt SF-only customer)
 *   - Else: create new
 *
 * Prevents duplicate customers when a record is created in SF first and later
 * re-booked via Zenbooker. Mirrors the upsertCustomerFromZB logic in zenbooker-sync.js.
 */

// ─────────────────────────────────────────────────────────────
// Pure reimplementation of upsertCustomerFromZB for isolated testing
// ─────────────────────────────────────────────────────────────

function last10(s) {
  const digits = String(s || '').replace(/\D/g, '');
  return digits.slice(-10);
}

// In-memory customer table simulator
function makeDB(initialCustomers = []) {
  const rows = [...initialCustomers];
  let nextId = (rows.reduce((m, r) => Math.max(m, r.id), 0) || 0) + 1;
  return {
    rows,
    findByZb(userId, zbId) {
      return rows.find(r => r.user_id === userId && r.zenbooker_id === zbId) || null;
    },
    findByPhoneLast10(userId, last10Target) {
      if (!last10Target || last10Target.length < 7) return null;
      return rows.find(r =>
        r.user_id === userId &&
        !r.zenbooker_id &&
        r.phone && last10(r.phone) === last10Target
      ) || null;
    },
    findByEmail(userId, email) {
      if (!email) return null;
      const lc = email.toLowerCase();
      return rows.find(r =>
        r.user_id === userId &&
        !r.zenbooker_id &&
        r.email && r.email.toLowerCase() === lc
      ) || null;
    },
    update(id, updates) {
      const r = rows.find(x => x.id === id);
      if (r) Object.assign(r, updates);
      return r;
    },
    insert(row) {
      const inserted = { id: nextId++, ...row };
      rows.push(inserted);
      return inserted;
    },
  };
}

function mapCustomer(zb, userId) {
  const nameParts = (zb.name || '').split(' ');
  const addr = (zb.addresses && zb.addresses[0]) || {};
  return {
    user_id: userId,
    first_name: nameParts[0] || '',
    last_name: nameParts.slice(1).join(' ') || '',
    email: zb.email || null,
    phone: zb.phone || null,
    address: addr.line1 || null,
    city: addr.city || null,
    state: addr.state || null,
    zip_code: addr.postal_code || null,
    zenbooker_id: zb.id,
  };
}

function upsertCustomerFromZB(db, userId, zb) {
  const mapped = mapCustomer(zb, userId);

  // 1. Match by zenbooker_id
  const byZb = db.findByZb(userId, zb.id);
  if (byZb) {
    const updates = {};
    for (const f of ['first_name', 'last_name', 'email', 'phone', 'address', 'city', 'state', 'zip_code']) {
      if (!byZb[f] && mapped[f]) updates[f] = mapped[f];
    }
    if (Object.keys(updates).length) db.update(byZb.id, updates);
    return { id: byZb.id, mode: 'existing_by_zb' };
  }

  // 2. Match by phone
  if (mapped.phone) {
    const p10 = last10(mapped.phone);
    const byPhone = db.findByPhoneLast10(userId, p10);
    if (byPhone) {
      const updates = { zenbooker_id: zb.id };
      for (const f of ['first_name', 'last_name', 'email', 'address', 'city', 'state', 'zip_code']) {
        if (!byPhone[f] && mapped[f]) updates[f] = mapped[f];
      }
      if (!byPhone.phone && mapped.phone) updates.phone = mapped.phone;
      db.update(byPhone.id, updates);
      return { id: byPhone.id, mode: 'adopted_by_phone' };
    }
  }

  // 3. Match by email
  if (mapped.email) {
    const byEmail = db.findByEmail(userId, mapped.email);
    if (byEmail) {
      const updates = { zenbooker_id: zb.id };
      for (const f of ['first_name', 'last_name', 'phone', 'address', 'city', 'state', 'zip_code']) {
        if (!byEmail[f] && mapped[f]) updates[f] = mapped[f];
      }
      db.update(byEmail.id, updates);
      return { id: byEmail.id, mode: 'adopted_by_email' };
    }
  }

  // 4. Insert new
  const inserted = db.insert(mapped);
  return { id: inserted.id, mode: 'created' };
}

// ─────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────

describe('Zenbooker customer adoption — prevents duplicates when SF has customer first', () => {
  test('zenbooker_id match → reuses existing customer (no duplicate)', () => {
    const db = makeDB([
      { id: 100, user_id: 2, first_name: 'Jessica', last_name: 'Pringle', phone: '9046511243', zenbooker_id: 'zb-abc' },
    ]);
    const result = upsertCustomerFromZB(db, 2, {
      id: 'zb-abc', name: 'Jessica Pringle', phone: '9046511243',
    });
    expect(result.mode).toBe('existing_by_zb');
    expect(result.id).toBe(100);
    expect(db.rows).toHaveLength(1); // no duplicate
  });

  test('SF-only customer with matching phone → adopted, zenbooker_id assigned', () => {
    // Scenario: user created Jessica in SF; then booked her again via ZB
    const db = makeDB([
      { id: 100, user_id: 2, first_name: 'Jessica', last_name: 'Pringle', phone: '9046511243', zenbooker_id: null },
    ]);
    const result = upsertCustomerFromZB(db, 2, {
      id: 'zb-new', name: 'Jessica Pringle', phone: '9046511243',
      addresses: [{ line1: '12450 Biscayne Boulevard' }],
    });
    expect(result.mode).toBe('adopted_by_phone');
    expect(result.id).toBe(100);
    expect(db.rows).toHaveLength(1); // adopted, no new row
    // zenbooker_id now set on the adopted row
    expect(db.rows[0].zenbooker_id).toBe('zb-new');
    // Missing fields filled in
    expect(db.rows[0].address).toBe('12450 Biscayne Boulevard');
  });

  test('phone match is last-10-digits (ignores +1 and formatting)', () => {
    const db = makeDB([
      { id: 100, user_id: 2, first_name: 'Jessica', phone: '9046511243', zenbooker_id: null },
    ]);
    const result = upsertCustomerFromZB(db, 2, {
      id: 'zb-new', name: 'Jessica P', phone: '+19046511243', // E.164 format
    });
    expect(result.mode).toBe('adopted_by_phone');
    expect(result.id).toBe(100);
  });

  test('different phone → no adoption, creates new', () => {
    const db = makeDB([
      { id: 100, user_id: 2, first_name: 'Jessica', phone: '9046511243', zenbooker_id: null },
    ]);
    const result = upsertCustomerFromZB(db, 2, {
      id: 'zb-new', name: 'Different Person', phone: '5551234567',
    });
    expect(result.mode).toBe('created');
    expect(result.id).toBe(101);
    expect(db.rows).toHaveLength(2);
  });

  test('email adoption when phone is missing', () => {
    const db = makeDB([
      { id: 100, user_id: 2, first_name: 'Nancy', email: 'nancy@example.com', phone: null, zenbooker_id: null },
    ]);
    const result = upsertCustomerFromZB(db, 2, {
      id: 'zb-new', name: 'Nancy H', email: 'nancy@example.com',
    });
    expect(result.mode).toBe('adopted_by_email');
    expect(result.id).toBe(100);
    expect(db.rows[0].zenbooker_id).toBe('zb-new');
  });

  test('email match is case-insensitive', () => {
    const db = makeDB([
      { id: 100, user_id: 2, email: 'Nancy@Example.com', zenbooker_id: null },
    ]);
    const result = upsertCustomerFromZB(db, 2, {
      id: 'zb-new', name: 'Nancy H', email: 'nancy@example.com',
    });
    expect(result.mode).toBe('adopted_by_email');
  });

  test('phone takes precedence over email when both match different records', () => {
    const db = makeDB([
      { id: 100, user_id: 2, phone: '9046511243', zenbooker_id: null },
      { id: 101, user_id: 2, email: 'j@example.com', zenbooker_id: null },
    ]);
    const result = upsertCustomerFromZB(db, 2, {
      id: 'zb-new', phone: '9046511243', email: 'j@example.com',
    });
    expect(result.mode).toBe('adopted_by_phone');
    expect(result.id).toBe(100);
  });

  test('does NOT adopt a customer that already has a different zenbooker_id', () => {
    // Another ZB customer owns this phone already — must create a new record
    const db = makeDB([
      { id: 100, user_id: 2, phone: '9046511243', zenbooker_id: 'zb-other' },
    ]);
    const result = upsertCustomerFromZB(db, 2, {
      id: 'zb-new', phone: '9046511243',
    });
    expect(result.mode).toBe('created');
    expect(db.rows).toHaveLength(2);
  });

  test('existing_by_zb fills in missing fields without overwriting', () => {
    const db = makeDB([
      { id: 100, user_id: 2, first_name: 'Jessica', last_name: 'Pringle',
        phone: '9046511243', email: null, address: null, zenbooker_id: 'zb-abc' },
    ]);
    upsertCustomerFromZB(db, 2, {
      id: 'zb-abc', name: 'Jessica Pringle',
      phone: '9046511243', email: 'j@example.com',
      addresses: [{ line1: '123 Main' }],
    });
    // Missing email + address filled in
    expect(db.rows[0].email).toBe('j@example.com');
    expect(db.rows[0].address).toBe('123 Main');
    // Existing phone preserved
    expect(db.rows[0].phone).toBe('9046511243');
  });

  test('tenant isolation — same phone in different tenant is NOT adopted', () => {
    const db = makeDB([
      { id: 100, user_id: 99, phone: '9046511243', zenbooker_id: null }, // different tenant
    ]);
    const result = upsertCustomerFromZB(db, 2, {
      id: 'zb-new', phone: '9046511243',
    });
    expect(result.mode).toBe('created');
    expect(result.id).toBe(101);
    expect(db.rows).toHaveLength(2);
  });

  test('phone adoption updates missing address even when preserving existing fields', () => {
    const db = makeDB([
      { id: 100, user_id: 2, first_name: 'Jessica', last_name: 'P.',
        phone: '9046511243', email: null, address: null, city: null, state: null,
        zenbooker_id: null },
    ]);
    upsertCustomerFromZB(db, 2, {
      id: 'zb-new', name: 'Jessica Pringle Full Name',  // SF has shorter first_name
      phone: '9046511243', email: 'j@example.com',
      addresses: [{ line1: '123 Main', city: 'Jacksonville', state: 'FL' }],
    });
    // First name NOT overwritten (SF had 'Jessica')
    expect(db.rows[0].first_name).toBe('Jessica');
    // last_name NOT overwritten (SF had 'P.')
    expect(db.rows[0].last_name).toBe('P.');
    // Missing fields filled in
    expect(db.rows[0].email).toBe('j@example.com');
    expect(db.rows[0].address).toBe('123 Main');
    expect(db.rows[0].city).toBe('Jacksonville');
    expect(db.rows[0].state).toBe('FL');
  });

  test('idempotent — re-processing the same ZB customer does not duplicate', () => {
    const db = makeDB();
    const zb = { id: 'zb-abc', name: 'Jessica Pringle', phone: '9046511243' };
    // First call: creates
    const r1 = upsertCustomerFromZB(db, 2, zb);
    expect(r1.mode).toBe('created');
    // Second call: matches by zenbooker_id
    const r2 = upsertCustomerFromZB(db, 2, zb);
    expect(r2.mode).toBe('existing_by_zb');
    expect(r2.id).toBe(r1.id);
    // Third call: same, no new records
    upsertCustomerFromZB(db, 2, zb);
    expect(db.rows).toHaveLength(1);
  });

  // ─────────────────────────────────────────────────────────────
  // Regression: the actual dup pattern the user reported
  // ─────────────────────────────────────────────────────────────

  test('Jessica Pringle scenario — SF customer first, then ZB sync', () => {
    // Step 1: user books Jessica in SF manually
    const db = makeDB([
      { id: 23429, user_id: 2, first_name: 'Jessica', last_name: 'Pringle',
        phone: '9046511243', address: '12450 Biscayne Blvd, Jacksonville, FL 32218, США',
        zenbooker_id: null },
    ]);
    // Step 2: user books her again via ZB; ZB sync pulls the customer
    const result = upsertCustomerFromZB(db, 2, {
      id: '1776498319609x317643613367959550',
      name: 'Jessica Pringle',
      phone: '9046511243',
      addresses: [{ line1: '12450 Biscayne Boulevard' }],
    });
    // Adopted, not duplicated
    expect(result.mode).toBe('adopted_by_phone');
    expect(result.id).toBe(23429);
    expect(db.rows).toHaveLength(1);
    expect(db.rows[0].zenbooker_id).toBe('1776498319609x317643613367959550');
  });

  test('Nancy H scenario — no phone, adopted by email', () => {
    const db = makeDB([
      { id: 23425, user_id: 2, first_name: 'Nancy', last_name: 'H.',
        phone: null, email: 'leadsapi+0fa44886bb074984a1bf9f84e0ac831f@messaging.yelp.com',
        zenbooker_id: null },
    ]);
    const result = upsertCustomerFromZB(db, 2, {
      id: 'zb-nancy',
      name: 'Nancy H',
      phone: null,
      email: 'leadsapi+0fa44886bb074984a1bf9f84e0ac831f@messaging.yelp.com',
    });
    expect(result.mode).toBe('adopted_by_email');
    expect(result.id).toBe(23425);
    expect(db.rows).toHaveLength(1);
  });
});
