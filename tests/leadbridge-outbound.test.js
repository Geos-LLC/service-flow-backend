/**
 * LeadBridge Outbound — unit tests.
 *
 * Covers the pure pieces of the outbound pipeline that can be tested
 * without a live Postgres:
 *   - status allowlist (§6 defensive filter)
 *   - encryption round-trip (§9)
 *   - payload + signer shape (§7)
 *   - updateJobStatus control flow (same-status no-op, source='leadbridge'
 *     skip, unlinked-job skip, unmapped-status → skipped row, happy path enqueue)
 *   - maybeEmitInsertEvent gating
 *   - backoff schedules on the drainer (§8)
 *
 * The Supabase client is stubbed with a minimal fake that records
 * calls and returns canned data. The real drainer HTTP path is not
 * exercised here — that requires a live LB endpoint and is covered
 * by the Phase 4 dry-run rollout step.
 */

process.env.LEADBRIDGE_OUTBOUND_STATUS_ENABLED = 'true'
process.env.LEADBRIDGE_OUTBOUND_DRY_RUN = 'true'
process.env.SF_INTEGRATION_ENC_KEY = Buffer.alloc(32, 7).toString('base64')

const { isOutboundAllowed, normalizeStatus } = require('../services/lb-outbound-status-map')
const {
  encryptIntegrationSecret,
  decryptIntegrationSecret,
  currentEncKeyVersion,
} = require('../services/lb-encryption')
const {
  buildPayload,
  signRequest,
} = require('../services/lb-outbound-delivery')
const { updateJobStatus, maybeEmitInsertEvent } = require('../services/job-status-service')
const { networkBackoff, deferBackoff, NETWORK_MAX_ATTEMPTS } = require('../workers/leadbridge-outbound-drainer')

// ──────────────────────────────────────────────────────────────────
// Tiny Supabase double — captures writes + serves canned reads.
// Each describe block can mutate `db` between tests; the chaining
// helpers make `.from(...).select(...)` etc. behave like the real
// client well enough for the control-flow tests.
// ──────────────────────────────────────────────────────────────────
function makeFakeSupabase(initialDb = { jobs: [], outbox: [], settings: [] }) {
  const db = {
    jobs: [...(initialDb.jobs || [])],
    outbox: [...(initialDb.outbox || [])],
    settings: [...(initialDb.settings || [])],
    calls: [],
  }

  function tableOps(name) {
    let filter = {}
    let updatePatch = null
    let insertRow = null
    const ops = {
      select: () => ops,
      eq: (k, v) => { filter[k] = v; return ops },
      order: () => ops,
      limit: () => ops,
      maybeSingle: async () => {
        const row = find(name, filter)
        return { data: row || null, error: null }
      },
      single: async () => {
        const row = find(name, filter)
        if (!row) return { data: null, error: { message: 'not found' } }
        return { data: row, error: null }
      },
      update: (patch) => {
        updatePatch = patch
        return {
          eq: (k, v) => {
            filter[k] = v
            return {
              eq: (k2, v2) => {
                filter[k2] = v2
                return applyUpdate()
              },
              then: (resolve) => resolve(applyUpdate()),
            }
          },
          then: (resolve) => resolve(applyUpdate()),
        }
        function applyUpdate() {
          const rows = findAll(name, filter)
          for (const r of rows) Object.assign(r, updatePatch)
          db.calls.push({ op: 'update', table: name, filter, patch: updatePatch })
          return { error: null, data: rows }
        }
      },
      insert: (row) => {
        insertRow = row
        db.calls.push({ op: 'insert', table: name, row })
        return {
          select: () => ({
            single: async () => {
              const inserted = Array.isArray(row) ? row[0] : row
              db[name].push(inserted)
              return { data: inserted, error: null }
            },
          }),
          then: (resolve) => {
            const inserted = Array.isArray(row) ? row[0] : row
            db[name].push(inserted)
            resolve({ data: inserted, error: null })
          },
        }
      },
    }
    return ops
  }

  function find(name, filter) {
    const arr = db[name] || []
    return arr.find((r) => Object.entries(filter).every(([k, v]) => String(r[k]) === String(v)))
  }
  function findAll(name, filter) {
    const arr = db[name] || []
    return arr.filter((r) => Object.entries(filter).every(([k, v]) => String(r[k]) === String(v)))
  }

  return {
    _db: db,
    from: (name) => {
      // map table names to keys in our in-memory store
      const key = name === 'leadbridge_outbound_events' ? 'outbox' :
                  name === 'jobs' ? 'jobs' :
                  name === 'communication_settings' ? 'settings' : name
      if (!db[key]) db[key] = []
      return tableOps(key)
    },
    rpc: async () => ({ data: null, error: null }),
  }
}

// ──────────────────────────────────────────────────────────────────
describe('status allowlist (§6)', () => {
  test('accepts canonical completed / cancelled / pending', () => {
    for (const s of ['completed', 'cancelled', 'pending', 'confirmed', 'in-progress']) {
      expect(isOutboundAllowed(s)).toBe(true)
    }
  })
  test('accepts both underscore + hyphen variants', () => {
    expect(isOutboundAllowed('in_progress')).toBe(true)
    expect(isOutboundAllowed('in-progress')).toBe(true)
    expect(isOutboundAllowed('en-route')).toBe(true)
    expect(isOutboundAllowed('en_route')).toBe(true)
  })
  test('rejects empty, null, unknown', () => {
    expect(isOutboundAllowed('')).toBe(false)
    expect(isOutboundAllowed(null)).toBe(false)
    expect(isOutboundAllowed(undefined)).toBe(false)
    expect(isOutboundAllowed('wobble')).toBe(false)
  })
  test('normalizeStatus trims + lowercases', () => {
    expect(normalizeStatus('  Completed  ')).toBe('completed')
  })
})

// ──────────────────────────────────────────────────────────────────
describe('encryption (§9)', () => {
  test('round-trips a secret', () => {
    const secret = 'whsec_abc123_super_secret_value'
    const ct = encryptIntegrationSecret(secret)
    expect(ct).not.toContain(secret)
    expect(ct.startsWith('v')).toBe(true)
    expect(decryptIntegrationSecret(ct)).toBe(secret)
  })

  test('tampered ciphertext fails auth', () => {
    const secret = 'whsec_another_secret'
    const ct = encryptIntegrationSecret(secret)
    // Corrupt the last byte of the ciphertext segment.
    const parts = ct.split(':')
    const bad = Buffer.from(parts[3], 'base64')
    bad[bad.length - 1] ^= 0xff
    parts[3] = bad.toString('base64')
    expect(() => decryptIntegrationSecret(parts.join(':'))).toThrow()
  })

  test('currentEncKeyVersion returns a positive int', () => {
    expect(currentEncKeyVersion()).toBeGreaterThan(0)
  })
})

// ──────────────────────────────────────────────────────────────────
describe('payload + signer (§7)', () => {
  const actor = { type: 'account_owner', id: 42, display_name: 'Alice' }
  const job = {
    id: 100,
    user_id: 'u1',
    lb_external_request_id: 'req_tt_1',
    lb_channel: 'thumbtack',
    scheduled_date: '2026-04-20',
    customer_name: 'Bob',
    invoice_amount: 300,
  }

  test('frozen payload has required fields + canonicalized status', () => {
    const p = buildPayload({ job, oldStatus: 'pending', newStatus: 'Completed', actor })
    expect(p.event_id).toMatch(/^evt_/)
    expect(p.event_type).toBe('job.status_changed')
    expect(p.source).toBe('service_flow')
    expect(p.sf_job_id).toBe('100')
    expect(p.external_request_id).toBe('req_tt_1')
    expect(p.channel).toBe('thumbtack')
    expect(p.status.previous).toBe('pending')
    expect(p.status.new).toBe('completed')
    expect(p.actor).toMatchObject({ type: 'account_owner', id: 42 })
  })

  test('signature is deterministic for (secret, ts, body)', () => {
    const body = JSON.stringify({ x: 1 })
    const s1 = signRequest('secret', body, '1700')
    const s2 = signRequest('secret', body, '1700')
    const s3 = signRequest('other', body, '1700')
    expect(s1).toBe(s2)
    expect(s1).not.toBe(s3)
    expect(s1).toMatch(/^sha256=[a-f0-9]{64}$/)
  })
})

// ──────────────────────────────────────────────────────────────────
describe('updateJobStatus control flow (§4)', () => {
  function seed({ status = 'pending', linked = true } = {}) {
    const job = {
      id: 1,
      user_id: 'u1',
      status,
      lb_external_request_id: linked ? 'req_1' : null,
      lb_channel: linked ? 'thumbtack' : null,
      scheduled_date: '2026-04-20',
      customer_name: 'Bob',
      invoice_amount: 200,
    }
    return makeFakeSupabase({ jobs: [job] })
  }

  test('same-status is a no-op — no outbox row, no UPDATE', async () => {
    const s = seed({ status: 'completed' })
    const res = await updateJobStatus(s, {
      jobId: 1, userId: 'u1', newStatus: 'completed',
      source: 'account_owner', actor: { type: 'account_owner', id: 1 },
    })
    expect(res.changed).toBe(false)
    expect(res.outboundAction).toBe('no_change')
    expect(s._db.outbox.length).toBe(0)
  })

  test('source=leadbridge skips outbox entirely (loop prevention)', async () => {
    const s = seed({ status: 'pending' })
    const res = await updateJobStatus(s, {
      jobId: 1, userId: 'u1', newStatus: 'completed',
      source: 'leadbridge', actor: { type: 'system', id: null },
    })
    expect(res.changed).toBe(true)
    expect(res.outboundAction).toBe('skipped_loop')
    expect(s._db.outbox.length).toBe(0)
    // but the status UPDATE still happened, with marker
    expect(s._db.jobs[0].status).toBe('completed')
    expect(s._db.jobs[0].last_status_source).toBe('leadbridge')
  })

  test('unlinked job — no outbox row', async () => {
    const s = seed({ status: 'pending', linked: false })
    const res = await updateJobStatus(s, {
      jobId: 1, userId: 'u1', newStatus: 'completed',
      source: 'account_owner', actor: { type: 'account_owner', id: 1 },
    })
    expect(res.outboundAction).toBe('skipped_not_linked')
    expect(s._db.outbox.length).toBe(0)
  })

  test('unmapped status creates a terminal skipped row', async () => {
    const s = seed({ status: 'pending' })
    const res = await updateJobStatus(s, {
      jobId: 1, userId: 'u1', newStatus: 'totally_invented_status',
      source: 'account_owner', actor: { type: 'account_owner', id: 1 },
    })
    expect(res.outboundAction).toBe('skipped_unmapped')
    expect(s._db.outbox.length).toBe(1)
    expect(s._db.outbox[0].state).toBe('skipped_unmapped_status')
    expect(s._db.outbox[0].terminal_at).toBeTruthy()
  })

  test('happy path — pending row enqueued with frozen payload', async () => {
    const s = seed({ status: 'pending' })
    const res = await updateJobStatus(s, {
      jobId: 1, userId: 'u1', newStatus: 'completed',
      source: 'account_owner', actor: { type: 'account_owner', id: 1, display_name: 'Alice' },
    })
    expect(res.outboundAction).toBe('enqueued')
    expect(s._db.outbox.length).toBe(1)
    const row = s._db.outbox[0]
    expect(row.state).toBe('pending')
    expect(row.event_id).toMatch(/^evt_/)
    expect(row.payload_json.status.new).toBe('completed')
    expect(row.payload_json.status.previous).toBe('pending')
    expect(row.payload_json.external_request_id).toBe('req_1')
  })

  test('rejects unknown source values', async () => {
    const s = seed()
    await expect(updateJobStatus(s, {
      jobId: 1, userId: 'u1', newStatus: 'completed',
      source: 'not_a_source',
    })).rejects.toThrow(/invalid source/)
  })
})

// ──────────────────────────────────────────────────────────────────
describe('maybeEmitInsertEvent (§5)', () => {
  test('no emit when LB identity is missing', async () => {
    const s = makeFakeSupabase()
    const result = await maybeEmitInsertEvent(s, {
      id: 7, user_id: 'u1', status: 'pending',
      lb_external_request_id: null, lb_channel: null,
    }, { type: 'account_owner' })
    expect(result.action).toBe('skipped_not_linked')
    expect(s._db.outbox.length).toBe(0)
  })

  test('no emit when status is outside the allowlist', async () => {
    const s = makeFakeSupabase()
    const result = await maybeEmitInsertEvent(s, {
      id: 7, user_id: 'u1', status: 'bogus',
      lb_external_request_id: 'r1', lb_channel: 'thumbtack',
    }, { type: 'account_owner' })
    expect(result.action).toBe('skipped_unmapped')
    expect(s._db.outbox.length).toBe(0)
  })

  test('emits one pending row on LB-linked, allowlisted insert', async () => {
    const s = makeFakeSupabase()
    const result = await maybeEmitInsertEvent(s, {
      id: 7, user_id: 'u1', status: 'pending',
      lb_external_request_id: 'r1', lb_channel: 'thumbtack',
    }, { type: 'account_owner' })
    expect(result.action).toBe('enqueued')
    expect(s._db.outbox.length).toBe(1)
    expect(s._db.outbox[0].payload_json.status.previous).toBeNull()
  })
})

// ──────────────────────────────────────────────────────────────────
describe('drainer backoff schedules (§8)', () => {
  test('networkBackoff follows the spec: 0, 10, 60, 600, 3600', () => {
    expect(networkBackoff(1)).toBe(0)
    expect(networkBackoff(2)).toBe(10)
    expect(networkBackoff(3)).toBe(60)
    expect(networkBackoff(4)).toBe(600)
    expect(networkBackoff(5)).toBe(3600)
  })

  test('NETWORK_MAX_ATTEMPTS is 5 (DLQ at 6)', () => {
    expect(NETWORK_MAX_ATTEMPTS).toBe(5)
  })

  test('deferBackoff for no-subscription starts at 1h, caps at 4h', () => {
    expect(deferBackoff(1)).toBe(3600)
    expect(deferBackoff(2)).toBe(7200)
    expect(deferBackoff(3)).toBe(10800)
    expect(deferBackoff(4)).toBe(14400)
    expect(deferBackoff(10)).toBe(14400) // capped
  })
})

// ──────────────────────────────────────────────────────────────────
// Drainer response handling — exercises processRow against a mocked
// axios so we cover every branch of §5 Drainer + §8 Idempotency.
//
// processRow expects a fake supabase that supports:
//   - getLbOutboundSubscription (reads communication_settings)
//   - update on leadbridge_outbound_events
//   - update on communication_settings (touchLastEventAt)
// The makeFakeSupabase double above already covers the table writes;
// here we extend with a settings row + axios mock so we can drive
// each response code.
// ──────────────────────────────────────────────────────────────────

jest.mock('axios')
const axios = require('axios')

const { processRow, verbForState } = require('../workers/leadbridge-outbound-drainer')
const { encryptIntegrationSecret: encrypt2 } = require('../services/lb-encryption')

function seedDrainerFixture({ subscriptionPresent = true } = {}) {
  const settings = subscriptionPresent ? [{
    user_id: 'u1',
    leadbridge_connected: true,
    leadbridge_outbound_subscription_id: 'sub_test',
    leadbridge_outbound_encrypted_secret: encrypt2('whsec_drainer_secret'),
    leadbridge_outbound_secret_key_version: 1,
    leadbridge_outbound_webhook_url: 'https://lb.example/api/v1/integrations/service-flow/job-status',
    leadbridge_outbound_events: ['job.status_changed'],
    leadbridge_outbound_registered_at: '2026-04-17T12:00:00Z',
    leadbridge_outbound_last_event_at: null,
  }] : []
  const outbox = [{
    id: 'row-1',
    event_id: 'evt_drainer_1',
    user_id: 'u1',
    sf_job_id: '99',
    event_type: 'job.status_changed',
    payload_json: {
      event_id: 'evt_drainer_1',
      event_type: 'job.status_changed',
      occurred_at: new Date().toISOString(),
      source: 'service_flow',
      sf_job_id: '99',
      external_request_id: 'req_99',
      channel: 'thumbtack',
      status: { new: 'completed', previous: 'pending' },
      actor: { type: 'account_owner', id: 1 },
      job: {},
      raw: {},
    },
    state: 'sending',
    attempts: 0,
  }]
  return makeFakeSupabase({ jobs: [], outbox, settings })
}

describe('drainer processRow — response handling (§5)', () => {
  const ORIGINAL_DRY_RUN = process.env.LEADBRIDGE_OUTBOUND_DRY_RUN
  beforeAll(() => { process.env.LEADBRIDGE_OUTBOUND_DRY_RUN = 'false' })
  afterAll(() => { process.env.LEADBRIDGE_OUTBOUND_DRY_RUN = ORIGINAL_DRY_RUN })
  beforeEach(() => { axios.mockReset() })

  test('200 → state=sent, result from body', async () => {
    const s = seedDrainerFixture()
    axios.mockResolvedValueOnce({ status: 200, data: { result: 'applied' } })
    const row = s._db.outbox[0]
    await processRow({ supabase: s, logger: { log: () => {}, error: () => {}, warn: () => {} }, row })
    expect(s._db.outbox[0].state).toBe('sent')
    expect(s._db.outbox[0].result).toBe('applied')
    expect(s._db.outbox[0].terminal_at).toBeTruthy()
  })

  test('409 → state=sent, result=duplicate (LB idempotency hit)', async () => {
    const s = seedDrainerFixture()
    axios.mockResolvedValueOnce({ status: 409, data: { error: 'duplicate event_id' } })
    await processRow({ supabase: s, logger: { log: () => {}, error: () => {}, warn: () => {} }, row: s._db.outbox[0] })
    expect(s._db.outbox[0].state).toBe('sent')
    expect(s._db.outbox[0].result).toBe('duplicate')
  })

  test('422 → state=skipped_unmapped_status (allowlist drift)', async () => {
    const s = seedDrainerFixture()
    axios.mockResolvedValueOnce({ status: 422, data: { error: 'unmapped status' } })
    await processRow({ supabase: s, logger: { log: () => {}, error: () => {}, warn: () => {} }, row: s._db.outbox[0] })
    expect(s._db.outbox[0].state).toBe('skipped_unmapped_status')
    expect(s._db.outbox[0].terminal_at).toBeTruthy()
  })

  test('400 → state=dlq (hard error, no retry)', async () => {
    const s = seedDrainerFixture()
    axios.mockResolvedValueOnce({ status: 400, data: 'bad request' })
    await processRow({ supabase: s, logger: { log: () => {}, error: () => {}, warn: () => {} }, row: s._db.outbox[0] })
    expect(s._db.outbox[0].state).toBe('dlq')
  })

  test('5xx → state=pending (retryable), attempts++', async () => {
    const s = seedDrainerFixture()
    axios.mockResolvedValueOnce({ status: 503, data: 'gateway' })
    await processRow({ supabase: s, logger: { log: () => {}, error: () => {}, warn: () => {} }, row: s._db.outbox[0] })
    expect(s._db.outbox[0].state).toBe('pending')
    expect(s._db.outbox[0].attempts).toBe(1)
    expect(s._db.outbox[0].next_attempt_at).toBeTruthy()
  })

  test('network error → state=pending (retryable), then DLQ after MAX', async () => {
    const s = seedDrainerFixture()
    axios.mockRejectedValueOnce(Object.assign(new Error('ECONNRESET'), { code: 'ECONNRESET' }))
    await processRow({ supabase: s, logger: { log: () => {}, error: () => {}, warn: () => {} }, row: s._db.outbox[0] })
    expect(s._db.outbox[0].state).toBe('pending')
    expect(s._db.outbox[0].last_error).toMatch(/ECONNRESET/)

    // Now bump attempts to MAX and re-process — should land in DLQ.
    s._db.outbox[0].attempts = 5
    s._db.outbox[0].state = 'sending' // simulate re-claim
    axios.mockRejectedValueOnce(Object.assign(new Error('ECONNRESET'), { code: 'ECONNRESET' }))
    await processRow({ supabase: s, logger: { log: () => {}, error: () => {}, warn: () => {} }, row: s._db.outbox[0] })
    expect(s._db.outbox[0].state).toBe('dlq')
  })

  test('no subscription → defer (NOT terminal), defer_reason set', async () => {
    const s = seedDrainerFixture({ subscriptionPresent: false })
    await processRow({ supabase: s, logger: { log: () => {}, error: () => {}, warn: () => {} }, row: s._db.outbox[0] })
    expect(s._db.outbox[0].state).toBe('pending')
    expect(s._db.outbox[0].defer_reason).toBe('no_outbound_subscription')
    // axios should not have been called
    expect(axios).not.toHaveBeenCalled()
  })
})

// ──────────────────────────────────────────────────────────────────
describe('verbForState log mapping (§7)', () => {
  test('maps every spec\'d transition', () => {
    expect(verbForState('sent', 'applied')).toBe('event sent')
    expect(verbForState('sent', 'duplicate')).toBe('event duplicate')
    expect(verbForState('dlq')).toBe('dlq')
    expect(verbForState('skipped_unmapped_status')).toBe('skipped_unmapped_status')
    expect(verbForState('pending')).toBe('retry')
  })
})

// ──────────────────────────────────────────────────────────────────
describe('SF → LB status mapping coverage (§3)', () => {
  // §3 of "Finalize ServiceFlow → LeadBridge Sync" enumerates the SF
  // statuses that LB can accept. SF's allowlist must include every
  // one of them — narrowing the allowlist is a regression that would
  // silently drop events as `skipped_unmapped_status` even though LB
  // would have happily accepted them.
  const SPEC_REQUIRED_STATUSES = [
    'pending', 'confirmed', 'rescheduled',
    'en-route', 'started', 'in-progress',
    'completed', 'paid', 'done',
    'cancelled',
    'no-show',
    'archived',
    'lost',
  ]

  test.each(SPEC_REQUIRED_STATUSES)('"%s" is in SF allowlist', (s) => {
    expect(isOutboundAllowed(s)).toBe(true)
  })
})
