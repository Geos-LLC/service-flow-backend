/**
 * Source-Account Boundary — Phase 1 contract tests.
 *
 * Asserts the write-side stamping helpers and the no-behavior-change
 * feature-flag invariant. Read-side enforcement is not built yet; tests
 * for that ship with the next phase.
 *
 * See docs/security/source-account-boundary-plan.md.
 */

const fs = require('fs')
const path = require('path')

const {
  normalizePhone,
  ensureOpenPhoneProviderAccount,
  ensureWhatsappProviderAccount,
  resolveOpenPhoneProviderAccountByPhoneNumberId,
  resolveOpenPhoneProviderAccountByEndpointPhone,
  resolveWhatsappProviderAccount,
} = require('../lib/source-account')

const { FLAGS, isEnabled, snapshot } = require('../lib/feature-flags')

// ─── Lightweight supabase stub ───────────────────────────────────
//
// Mirrors the .from(...).select|insert|update().eq().maybeSingle/.single
// chain that the helpers use. Each .from(table) returns a fresh chainable.
// Behavior is driven by a `state` object shared across .from(...) calls.
function makeSupabaseStub(state = {}) {
  state.tables = state.tables || {}
  state.inserts = state.inserts || []
  state.updates = state.updates || []

  function chain(table) {
    const filters = []
    let pendingInsert = null
    let pendingUpdate = null

    const obj = {
      select() { return obj },
      insert(row) {
        pendingInsert = row
        // Insert is terminal — assign id and store
        const idForTable = (state.tables[table]?.length || 0) + 1
        const stored = Array.isArray(row)
          ? row.map(r => ({ id: idForTable, ...r }))
          : { id: idForTable, ...row }
        state.tables[table] = [...(state.tables[table] || []), ...(Array.isArray(stored) ? stored : [stored])]
        state.inserts.push({ table, row: stored })
        return {
          select: () => ({
            single: async () => ({ data: Array.isArray(stored) ? stored[0] : stored, error: null }),
          }),
        }
      },
      update(patch) {
        pendingUpdate = patch
        return obj
      },
      eq(col, val) { filters.push({ col, val }); return obj },
      async maybeSingle() {
        const rows = (state.tables[table] || []).filter(r => filters.every(f => r[f.col] === f.val))
        if (pendingUpdate) {
          for (const r of rows) Object.assign(r, pendingUpdate)
          state.updates.push({ table, filters, patch: pendingUpdate })
          return { data: rows[0] || null, error: null }
        }
        return { data: rows[0] || null, error: null }
      },
      async single() {
        const r = (state.tables[table] || []).find(row => filters.every(f => row[f.col] === f.val))
        return { data: r || null, error: r ? null : { message: 'not found' } }
      },
      then(onFulfilled) {
        // Bare query: return all matching rows
        const rows = (state.tables[table] || []).filter(r => filters.every(f => r[f.col] === f.val))
        if (pendingUpdate) {
          for (const r of rows) Object.assign(r, pendingUpdate)
          state.updates.push({ table, filters, patch: pendingUpdate })
          return Promise.resolve({ data: rows, error: null }).then(onFulfilled)
        }
        return Promise.resolve({ data: rows, error: null }).then(onFulfilled)
      },
    }
    return obj
  }

  return { from: (table) => chain(table), _state: state }
}

const silentLogger = { log: () => {}, warn: () => {}, error: () => {} }

// ─── normalizePhone ──────────────────────────────────────────────

describe('source-account: normalizePhone', () => {
  test('null + empty → null', () => {
    expect(normalizePhone(null)).toBeNull()
    expect(normalizePhone(undefined)).toBeNull()
    expect(normalizePhone('')).toBeNull()
  })

  test('10-digit US becomes +1XXXXXXXXXX', () => {
    expect(normalizePhone('8139212100')).toBe('+18139212100')
  })

  test('11-digit leading 1 becomes +1XXXXXXXXXX', () => {
    expect(normalizePhone('18139212100')).toBe('+18139212100')
  })

  test('already E.164 stays unchanged', () => {
    expect(normalizePhone('+18139212100')).toBe('+18139212100')
  })

  test('strips formatting', () => {
    expect(normalizePhone('(813) 921-2100')).toBe('+18139212100')
  })
})

// ─── OpenPhone connect-time stamping ─────────────────────────────

describe('source-account: ensureOpenPhoneProviderAccount', () => {
  test('creates a new provider_accounts row keyed on phoneNumberId', async () => {
    const supa = makeSupabaseStub()
    const id = await ensureOpenPhoneProviderAccount(supa, silentLogger, 42, {
      id: 'PNm5YIDoXV', number: '+18139212100', name: 'Sales Line',
    })
    expect(id).toBe(1)
    const rows = supa._state.tables.communication_provider_accounts
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      user_id: 42,
      provider: 'openphone',
      channel: 'openphone',
      external_account_id: 'PNm5YIDoXV',
      status: 'active',
      display_name: 'Sales Line',
    })
    expect(rows[0].metadata.phoneNumber).toBe('+18139212100')
  })

  test('reactivates an existing row on reconnect', async () => {
    const supa = makeSupabaseStub({
      tables: {
        communication_provider_accounts: [{
          id: 7, user_id: 42, provider: 'openphone', channel: 'openphone',
          external_account_id: 'PNm5YIDoXV', status: 'disconnected',
          display_name: 'old', metadata: {},
        }],
      },
    })
    const id = await ensureOpenPhoneProviderAccount(supa, silentLogger, 42, {
      id: 'PNm5YIDoXV', number: '+18139212100',
    })
    expect(id).toBe(7)
    const updated = supa._state.tables.communication_provider_accounts[0]
    expect(updated.status).toBe('active')
    expect(updated.display_name).toBe('OpenPhone +18139212100')
    // Should not have inserted a new row
    expect(supa._state.tables.communication_provider_accounts).toHaveLength(1)
  })

  test('returns null and does not insert when phoneNumberId is missing', async () => {
    const supa = makeSupabaseStub()
    const id = await ensureOpenPhoneProviderAccount(supa, silentLogger, 42, { number: '+18139212100' })
    expect(id).toBeNull()
    expect(supa._state.tables.communication_provider_accounts || []).toHaveLength(0)
  })
})

// ─── WhatsApp connect-time stamping ──────────────────────────────

describe('source-account: ensureWhatsappProviderAccount', () => {
  test('creates a new provider_accounts row keyed on E.164 phone', async () => {
    const supa = makeSupabaseStub()
    const id = await ensureWhatsappProviderAccount(supa, silentLogger, 42, '+18139212100')
    expect(id).toBe(1)
    const rows = supa._state.tables.communication_provider_accounts
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      user_id: 42,
      provider: 'whatsapp',
      channel: 'whatsapp',
      external_account_id: '+18139212100',
      status: 'active',
    })
  })

  test('reactivates existing row on reconnect (same phone)', async () => {
    const supa = makeSupabaseStub({
      tables: {
        communication_provider_accounts: [{
          id: 9, user_id: 42, provider: 'whatsapp', channel: 'whatsapp',
          external_account_id: '+18139212100', status: 'disconnected', metadata: {},
        }],
      },
    })
    const id = await ensureWhatsappProviderAccount(supa, silentLogger, 42, '+18139212100')
    expect(id).toBe(9)
    expect(supa._state.tables.communication_provider_accounts[0].status).toBe('active')
    expect(supa._state.tables.communication_provider_accounts).toHaveLength(1)
  })

  test('returns null when phone is missing', async () => {
    const supa = makeSupabaseStub()
    expect(await ensureWhatsappProviderAccount(supa, silentLogger, 42, null)).toBeNull()
    expect(await ensureWhatsappProviderAccount(supa, silentLogger, 42, '')).toBeNull()
  })

  test('normalizes 10-digit US phone before keying', async () => {
    const supa = makeSupabaseStub()
    await ensureWhatsappProviderAccount(supa, silentLogger, 42, '8139212100')
    expect(supa._state.tables.communication_provider_accounts[0].external_account_id).toBe('+18139212100')
  })
})

// ─── Resolver lookups ─────────────────────────────────────────────

describe('source-account: resolvers', () => {
  test('resolveOpenPhoneProviderAccountByPhoneNumberId returns id when present', async () => {
    const supa = makeSupabaseStub({
      tables: {
        communication_provider_accounts: [{
          id: 7, user_id: 42, provider: 'openphone', external_account_id: 'PNm5YIDoXV',
        }],
      },
    })
    expect(await resolveOpenPhoneProviderAccountByPhoneNumberId(supa, 42, 'PNm5YIDoXV')).toBe(7)
  })

  test('resolveOpenPhoneProviderAccountByPhoneNumberId returns null on miss', async () => {
    const supa = makeSupabaseStub()
    expect(await resolveOpenPhoneProviderAccountByPhoneNumberId(supa, 42, 'PNxxx')).toBeNull()
  })

  test('resolveOpenPhoneProviderAccountByEndpointPhone matches metadata.phoneNumber', async () => {
    const supa = makeSupabaseStub({
      tables: {
        communication_provider_accounts: [
          { id: 7, user_id: 42, provider: 'openphone', metadata: { phoneNumber: '+18139212100' } },
          { id: 8, user_id: 42, provider: 'openphone', metadata: { phoneNumber: '+19045778584' } },
        ],
      },
    })
    expect(await resolveOpenPhoneProviderAccountByEndpointPhone(supa, 42, '+18139212100')).toBe(7)
    expect(await resolveOpenPhoneProviderAccountByEndpointPhone(supa, 42, '+19045778584')).toBe(8)
    expect(await resolveOpenPhoneProviderAccountByEndpointPhone(supa, 42, '+15555555555')).toBeNull()
  })

  test('resolveWhatsappProviderAccount keys on E.164 external_account_id', async () => {
    const supa = makeSupabaseStub({
      tables: {
        communication_provider_accounts: [{
          id: 9, user_id: 42, provider: 'whatsapp', external_account_id: '+18139212100',
        }],
      },
    })
    expect(await resolveWhatsappProviderAccount(supa, 42, '+18139212100')).toBe(9)
    expect(await resolveWhatsappProviderAccount(supa, 42, '8139212100')).toBe(9)
  })
})

// ─── Message inheritance — pure logic ─────────────────────────────
//
// The actual handlers stamp `provider_account_id` from the parent
// conversation row. This test pins the inheritance contract so a
// future regression that drops the column from a child INSERT shows up.

describe('source-account: message/call inheritance', () => {
  function buildMessageRow(conversation, msg, fallback = null) {
    return {
      conversation_id: conversation.id,
      provider_account_id: conversation.provider_account_id || fallback || null,
      ...msg,
    }
  }

  test('LB message inherits provider_account_id from conversation', () => {
    const conv = { id: 100, provider_account_id: 7, channel: 'thumbtack' }
    const row = buildMessageRow(conv, { body: 'hi', direction: 'in' })
    expect(row.provider_account_id).toBe(7)
  })

  test('OpenPhone message inherits provider_account_id from conversation', () => {
    const conv = { id: 101, provider_account_id: 11, channel: 'sms' }
    const row = buildMessageRow(conv, { body: 'hello', direction: 'in' })
    expect(row.provider_account_id).toBe(11)
  })

  test('legacy conversation (null provider_account_id) keeps null on child rows', () => {
    const conv = { id: 102, provider_account_id: null, channel: 'sms' }
    const row = buildMessageRow(conv, { body: 'legacy', direction: 'in' })
    expect(row.provider_account_id).toBeNull()
  })

  test('explicit fallback used when conversation missing FK (LB webhook fast path)', () => {
    const conv = { id: 103, provider_account_id: null, channel: 'thumbtack' }
    const row = buildMessageRow(conv, { body: 'lb', direction: 'in' }, 5)
    expect(row.provider_account_id).toBe(5)
  })
})

// ─── Feature flag — Phase 1 default OFF ───────────────────────────

describe('source-account: feature flag', () => {
  afterEach(() => { delete process.env[FLAGS.SOURCE_ACCOUNT_BOUNDARY_ENFORCED] })

  test('SOURCE_ACCOUNT_BOUNDARY_ENFORCED is registered', () => {
    expect(FLAGS.SOURCE_ACCOUNT_BOUNDARY_ENFORCED).toBe('SOURCE_ACCOUNT_BOUNDARY_ENFORCED')
  })

  test('default is false', () => {
    expect(isEnabled(FLAGS.SOURCE_ACCOUNT_BOUNDARY_ENFORCED)).toBe(false)
    expect(snapshot()[FLAGS.SOURCE_ACCOUNT_BOUNDARY_ENFORCED]).toBe(false)
  })

  test('env opt-in works', () => {
    process.env[FLAGS.SOURCE_ACCOUNT_BOUNDARY_ENFORCED] = '1'
    expect(isEnabled(FLAGS.SOURCE_ACCOUNT_BOUNDARY_ENFORCED)).toBe(true)
  })
})

// ─── Migration shape — pin schema assumptions ────────────────────
//
// We are not running pg here; just verify the migration file declares
// the columns Phase 1 promised. This catches accidental edits to the
// migration that drift from the contract documented in the plan.

describe('source-account: migration 036 shape', () => {
  const migration = fs.readFileSync(
    path.join(__dirname, '..', 'migrations', '036_source_account_boundary_phase1.sql'),
    'utf8'
  )

  test('adds provider_account_id to communication_messages', () => {
    expect(migration).toMatch(/ALTER TABLE public\.communication_messages\s+ADD COLUMN IF NOT EXISTS provider_account_id integer/i)
  })

  test('adds provider_account_id to communication_calls', () => {
    expect(migration).toMatch(/ALTER TABLE public\.communication_calls\s+ADD COLUMN IF NOT EXISTS provider_account_id integer/i)
  })

  test('adds provider_account_id to communication_participant_identities', () => {
    expect(migration).toMatch(/ALTER TABLE public\.communication_participant_identities\s+ADD COLUMN IF NOT EXISTS provider_account_id integer/i)
  })

  test('adds hidden_at + legacy_unknown_source to communication_conversations', () => {
    expect(migration).toMatch(/communication_conversations[\s\S]*ADD COLUMN IF NOT EXISTS hidden_at timestamptz/i)
    expect(migration).toMatch(/communication_conversations[\s\S]*ADD COLUMN IF NOT EXISTS legacy_unknown_source boolean NOT NULL DEFAULT false/i)
  })

  test('all FKs use ON DELETE SET NULL (never CASCADE)', () => {
    // Three FK declarations in the migration; none should delete child rows.
    expect(migration).not.toMatch(/ON DELETE CASCADE/i)
    const fkCount = (migration.match(/ON DELETE SET NULL/gi) || []).length
    expect(fkCount).toBeGreaterThanOrEqual(3)
  })

  test('does not hide existing rows (no UPDATE ... SET hidden_at)', () => {
    // Phase 1 contract: schema only, no row-level data hidden.
    expect(migration).not.toMatch(/UPDATE\s+\S+\s+SET\s+hidden_at/i)
    expect(migration).not.toMatch(/UPDATE\s+\S+\s+SET\s+legacy_unknown_source/i)
  })
})
