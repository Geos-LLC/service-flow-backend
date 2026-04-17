/**
 * Connected Email — unit tests for pure modules.
 *
 * Covers: token crypto round-trip, email normalization, reply headers,
 * message guard (inbound/outbound/reject), sync backoff, Gmail parse helpers.
 *
 * No DB, no network — mocks the supabase client only where needed.
 */

process.env.CONNECTED_EMAIL_TOKEN_KEY =
  Buffer.from('a'.repeat(32), 'utf8').toString('base64')

const tokenCrypto = require('../services/connected-email/token-crypto')
const emailUtils = require('../services/connected-email/email-utils')
const normalizer = require('../services/connected-email/message-normalizer')
const syncEngine = require('../services/connected-email/sync-engine')
const gmail = require('../services/connected-email/providers/gmail.provider')

// ──────────────────────────────────────────────
// token-crypto
// ──────────────────────────────────────────────
describe('token-crypto', () => {
  test('round-trip encrypt/decrypt (base64 strings)', () => {
    const { ciphertext, iv, authTag } = tokenCrypto.encrypt('super-secret-token-value')
    expect(typeof ciphertext).toBe('string')
    expect(typeof iv).toBe('string')
    expect(typeof authTag).toBe('string')
    expect(Buffer.from(iv, 'base64').length).toBe(12)
    expect(Buffer.from(authTag, 'base64').length).toBe(16)
    const back = tokenCrypto.decrypt(ciphertext, iv, authTag)
    expect(back).toBe('super-secret-token-value')
  })

  test('decrypt also accepts legacy Buffer inputs', () => {
    const { ciphertext, iv, authTag } = tokenCrypto.encrypt('abc')
    const back = tokenCrypto.decrypt(
      Buffer.from(ciphertext, 'base64'),
      Buffer.from(iv, 'base64'),
      Buffer.from(authTag, 'base64'),
    )
    expect(back).toBe('abc')
  })

  test('null plaintext yields null outputs', () => {
    const r = tokenCrypto.encrypt(null)
    expect(r.ciphertext).toBeNull()
    expect(r.iv).toBeNull()
    expect(r.authTag).toBeNull()
  })

  test('tampered ciphertext fails auth tag', () => {
    const { ciphertext, iv, authTag } = tokenCrypto.encrypt('abc')
    const buf = Buffer.from(ciphertext, 'base64')
    buf[0] = buf[0] ^ 0xff
    const tampered = buf.toString('base64')
    expect(() => tokenCrypto.decrypt(tampered, iv, authTag)).toThrow()
  })

  test('isConfigured returns true when key set', () => {
    expect(tokenCrypto.isConfigured()).toBe(true)
  })
})

// ──────────────────────────────────────────────
// email-utils
// ──────────────────────────────────────────────
describe('email-utils.normalizeEmail', () => {
  test('strips display name', () => {
    expect(emailUtils.normalizeEmail('John Smith <John@Email.com>')).toBe('john@email.com')
  })
  test('lowercases + trims', () => {
    expect(emailUtils.normalizeEmail('  Foo@BAR.com  ')).toBe('foo@bar.com')
  })
  test('rejects invalid', () => {
    expect(emailUtils.normalizeEmail('not-an-email')).toBeNull()
    expect(emailUtils.normalizeEmail('')).toBeNull()
    expect(emailUtils.normalizeEmail(null)).toBeNull()
  })
})

describe('email-utils.normalizeEmailList', () => {
  test('splits a comma-separated header respecting angle brackets', () => {
    const r = emailUtils.normalizeEmailList('Alice <a@x.com>, "Bob, Jr" <b@y.com>, c@z.com')
    expect(r).toEqual(['a@x.com', 'b@y.com', 'c@z.com'])
  })
  test('handles single address', () => {
    expect(emailUtils.normalizeEmailList('solo@x.com')).toEqual(['solo@x.com'])
  })
  test('empty input', () => {
    expect(emailUtils.normalizeEmailList(null)).toEqual([])
  })
})

describe('email-utils.buildReplyHeaders', () => {
  test('threads by appending parent Message-ID to References', () => {
    const r = emailUtils.buildReplyHeaders({
      parentMessageId: '<m2@x>',
      parentReferences: '<m0@x> <m1@x>',
    })
    expect(r.inReplyTo).toBe('<m2@x>')
    expect(r.references).toBe('<m0@x> <m1@x> <m2@x>')
  })
  test('no parent → empty', () => {
    expect(emailUtils.buildReplyHeaders({})).toEqual({ inReplyTo: null, references: null })
  })
})

describe('email-utils.makeReplySubject', () => {
  test('adds Re:', () => {
    expect(emailUtils.makeReplySubject('Hi there')).toBe('Re: Hi there')
  })
  test('does not double-add', () => {
    expect(emailUtils.makeReplySubject('Re: already')).toBe('Re: already')
    expect(emailUtils.makeReplySubject('RE: loud')).toBe('RE: loud')
  })
})

// ──────────────────────────────────────────────
// message-normalizer — Phase 6 guard
// ──────────────────────────────────────────────
describe('message-normalizer — mailbox guard', () => {
  const owner = 'agent@company.com'

  test('inbound: owner in recipients → ok', () => {
    const r = normalizer.normalize({
      mailboxOwnerEmail: owner,
      providerMsg: {
        from: 'customer@foo.com',
        to: 'Agent <Agent@Company.com>',
        subject: 'Hi', date: new Date(), id: 'x', threadId: 't',
        messageId: '<a@x>', bodyText: 'hello', bodyHtml: null,
        isSent: false,
      }
    })
    expect(r.ok).toBe(true)
    expect(r.direction).toBe('inbound')
    expect(r.participantEmail).toBe('customer@foo.com')
    expect(r.row.from_email).toBe('customer@foo.com')
  })

  test('outbound: owner is sender → ok', () => {
    const r = normalizer.normalize({
      mailboxOwnerEmail: owner,
      providerMsg: {
        from: 'AGENT@company.com',
        to: 'Customer <cust@foo.com>',
        subject: 'Reply', date: new Date(), id: 'x', threadId: 't',
        messageId: '<b@x>', bodyText: 'thanks', bodyHtml: null,
        isSent: true,
      }
    })
    expect(r.ok).toBe(true)
    expect(r.direction).toBe('outbound')
    expect(r.participantEmail).toBe('cust@foo.com')
  })

  test('guard rejects when owner neither sender nor recipient', () => {
    const r = normalizer.normalize({
      mailboxOwnerEmail: owner,
      providerMsg: {
        from: 'a@x.com', to: 'b@y.com', subject: 's', date: new Date(),
        id: '1', threadId: 't', messageId: '<c@x>', isSent: false,
      }
    })
    expect(r.ok).toBe(false)
    expect(r.reason).toBe(normalizer.GUARD_REJECT_NO_OWNER_MATCH)
  })

  test('self-send resolves to outbound', () => {
    const r = normalizer.normalize({
      mailboxOwnerEmail: owner,
      providerMsg: {
        from: owner, to: owner, subject: 'self', date: new Date(),
        id: '1', threadId: 't', messageId: '<d@x>', isSent: false,
      }
    })
    expect(r.ok).toBe(true)
    expect(r.direction).toBe('outbound')
  })

  test('cc/bcc recipients count for inbound match', () => {
    const r = normalizer.normalize({
      mailboxOwnerEmail: owner,
      providerMsg: {
        from: 'someone@x.com', to: 'other@y.com', cc: `${owner}`,
        subject: 's', date: new Date(), id: '1', threadId: 't',
        messageId: '<e@x>', isSent: false,
      }
    })
    expect(r.ok).toBe(true)
    expect(r.direction).toBe('inbound')
  })
})

// ──────────────────────────────────────────────
// sync-engine.backoffDelay
// ──────────────────────────────────────────────
describe('sync-engine.backoffDelay', () => {
  test('grows exponentially', () => {
    const a = syncEngine.backoffDelay(0)
    const b = syncEngine.backoffDelay(3)
    expect(b).toBeGreaterThan(a)
  })
  test('caps at one hour', () => {
    expect(syncEngine.backoffDelay(99)).toBeLessThanOrEqual(60 * 60 * 1000)
  })
})

// ──────────────────────────────────────────────
// gmail provider — pure parser
// ──────────────────────────────────────────────
describe('gmail.parseMessage', () => {
  test('extracts headers + text body', () => {
    const raw = {
      id: 'g1', threadId: 't1', internalDate: String(Date.now()),
      labelIds: ['INBOX'],
      payload: {
        headers: [
          { name: 'From', value: 'Alice <alice@x.com>' },
          { name: 'To', value: 'Bob <bob@y.com>' },
          { name: 'Subject', value: 'Hello' },
          { name: 'Message-ID', value: '<msg1@x>' },
          { name: 'In-Reply-To', value: '<parent@x>' },
        ],
        mimeType: 'text/plain',
        body: { data: Buffer.from('hi there').toString('base64') },
      },
      snippet: 'hi there',
    }
    const p = gmail.parseMessage(raw)
    expect(p.subject).toBe('Hello')
    expect(p.messageId).toBe('<msg1@x>')
    expect(p.inReplyTo).toBe('<parent@x>')
    expect(p.from).toBe('Alice <alice@x.com>')
    expect(p.bodyText).toBe('hi there')
    expect(p.isSent).toBe(false)
  })

  test('detects SENT label', () => {
    const raw = {
      id: 'g2', threadId: 't2', internalDate: String(Date.now()),
      labelIds: ['SENT'],
      payload: { headers: [{ name: 'From', value: 'me@x' }], body: {} },
      snippet: '',
    }
    expect(gmail.parseMessage(raw).isSent).toBe(true)
  })

  test('walks multipart for html + text', () => {
    const raw = {
      id: 'g3', threadId: 't3', internalDate: String(Date.now()), labelIds: [],
      payload: {
        headers: [{ name: 'Subject', value: 's' }],
        parts: [
          { mimeType: 'text/plain', body: { data: Buffer.from('plain').toString('base64') } },
          { mimeType: 'text/html', body: { data: Buffer.from('<p>html</p>').toString('base64') } },
        ],
      },
      snippet: '',
    }
    const p = gmail.parseMessage(raw)
    expect(p.bodyText).toBe('plain')
    expect(p.bodyHtml).toBe('<p>html</p>')
  })
})

// ──────────────────────────────────────────────
// Multi-mailbox identity isolation (uses a mocked supabase)
// ──────────────────────────────────────────────
describe('conversation-identity — multi-mailbox isolation', () => {
  const { resolveConversation } = require('../services/connected-email/conversation-identity')

  function makeSupabaseMock(rowsByEndpoint) {
    const created = []
    return {
      created,
      from(table) {
        if (table !== 'communication_conversations') throw new Error('unexpected table ' + table)
        let currentFilters = {}
        const builder = {
          select() { return builder },
          eq(col, val) { currentFilters[col] = val; return builder },
          is(col, val) { currentFilters[col] = val; return builder },
          limit() { return builder },
          maybeSingle: async () => {
            const match = rowsByEndpoint.find(r =>
              r.endpoint_email === currentFilters.endpoint_email &&
              r.participant_email === currentFilters.participant_email
            )
            return { data: match || null }
          },
          insert(row) {
            created.push(row)
            return {
              select() { return {
                single: async () => ({ data: { id: 'new-' + created.length } }),
              }}
            }
          },
          update() { return { eq: () => Promise.resolve({}) } },
        }
        return builder
      },
    }
  }

  test('same participant, different endpoints → 2 conversations', async () => {
    const supabase = makeSupabaseMock([])
    const a = await resolveConversation(supabase, {
      userId: 1, provider: 'gmail',
      endpointEmail: 'mailbox1@company.com',
      participantEmail: 'customer@x.com',
      threadId: 't1',
    })
    const b = await resolveConversation(supabase, {
      userId: 1, provider: 'gmail',
      endpointEmail: 'mailbox2@company.com',
      participantEmail: 'customer@x.com',
      threadId: 't1',
    })
    expect(a.isNew).toBe(true)
    expect(b.isNew).toBe(true)
    expect(supabase.created.length).toBe(2)
    expect(supabase.created[0].endpoint_email).toBe('mailbox1@company.com')
    expect(supabase.created[1].endpoint_email).toBe('mailbox2@company.com')
  })

  test('same participant, same endpoint → 1 conversation (reuse)', async () => {
    const supabase = makeSupabaseMock([
      { id: 'existing-1', endpoint_email: 'mailbox1@company.com', participant_email: 'customer@x.com' },
    ])
    const r = await resolveConversation(supabase, {
      userId: 1, provider: 'gmail',
      endpointEmail: 'mailbox1@company.com',
      participantEmail: 'customer@x.com',
      threadId: 't1',
    })
    expect(r.isNew).toBe(false)
    expect(r.conversationId).toBe('existing-1')
  })
})

// ──────────────────────────────────────────────
// Outlook delegated mailbox — mailboxPrefix
// ──────────────────────────────────────────────
describe('outlook.mailboxPrefix', () => {
  const { mailboxPrefix } = require('../services/connected-email/providers/outlook.provider')

  test('null → /me (primary mailbox)', () => {
    expect(mailboxPrefix(null)).toBe('/me')
    expect(mailboxPrefix(undefined)).toBe('/me')
    expect(mailboxPrefix('')).toBe('/me')
  })

  test('email → /users/{email} (delegated, unencoded UPN)', () => {
    expect(mailboxPrefix('sales@spotless.homes')).toBe('/users/sales@spotless.homes')
  })
})

// ──────────────────────────────────────────────
// Guard with shared mailbox: ownerEmail = target, not auth
// ──────────────────────────────────────────────
describe('message-normalizer — delegated mailbox guard', () => {
  test('inbound to shared mailbox (not auth user) → ok', () => {
    const r = normalizer.normalize({
      mailboxOwnerEmail: 'sales@spotless.homes', // target (shared)
      providerMsg: {
        from: 'customer@outside.com',
        to: 'sales@spotless.homes',
        subject: 'Quote', date: new Date(), id: 'x', threadId: 't',
        messageId: '<f@x>', bodyText: 'hi', isSent: false,
      }
    })
    expect(r.ok).toBe(true)
    expect(r.direction).toBe('inbound')
    expect(r.participantEmail).toBe('customer@outside.com')
  })

  test('guard rejects when auth user (kate@) is recipient but target (sales@) is not', () => {
    const r = normalizer.normalize({
      mailboxOwnerEmail: 'sales@spotless.homes', // target
      providerMsg: {
        from: 'customer@outside.com',
        to: 'kate@spotless.homes', // auth user, NOT target
        subject: 'Hi', date: new Date(), id: 'x', threadId: 't',
        messageId: '<g@x>', bodyText: 'hi', isSent: false,
      }
    })
    expect(r.ok).toBe(false)
  })

  test('outbound from shared mailbox → sender must be target', () => {
    const r = normalizer.normalize({
      mailboxOwnerEmail: 'sales@spotless.homes',
      providerMsg: {
        from: 'sales@spotless.homes',
        to: 'customer@outside.com',
        subject: 'Reply', date: new Date(), id: 'x', threadId: 't',
        messageId: '<h@x>', bodyText: 'thanks', isSent: true,
      }
    })
    expect(r.ok).toBe(true)
    expect(r.direction).toBe('outbound')
    expect(r.participantEmail).toBe('customer@outside.com')
  })
})
