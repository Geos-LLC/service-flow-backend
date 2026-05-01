/**
 * Persistence-of-skip-reason test for POST /lead-status.
 *
 * Exists because the original column name (`error`) silently failed
 * the UPDATE — the happy path didn't touch it, so 887 tests passed
 * yet skip-path observability was broken in production. This test
 * pins the real column name (`processing_error`) by driving a request
 * through the actual router and asserting the captured update payload.
 *
 * If someone renames the column or the field again, this fails.
 */

process.env.JWT_SECRET = 'lb-lead-status-webhook-test-secret-32b!!'
process.env.LEADBRIDGE_OUTBOUND_STATUS_ENABLED = 'false'

const express = require('express')
const request = require('supertest')
const crypto = require('crypto')
const { encryptIntegrationSecret, currentEncKeyVersion } = require('../services/lb-encryption')

const SUB_SECRET = 'a'.repeat(64) // any HMAC-shaped string is fine
const TEST_USER_ID = 42

function makeSupabaseStub({ webhookExistingForId = null, jobs = [] } = {}) {
  const calls = { updates: [], inserts: [] }

  function commSettingsBuilder() {
    const state = { eqMatchedUserId: false }
    const b = {
      select: () => b,
      not: () => b,
      eq: (col, val) => {
        if (col === 'user_id' && val === TEST_USER_ID) state.eqMatchedUserId = true
        return b
      },
      maybeSingle: async () => ({ data: null }),
      // Promise resolution for .select(...).not(...) terminal — supabase-js
      // resolves the chain when awaited; we mimic by exposing `then`.
      then(resolve) {
        resolve({
          data: [{
            user_id: TEST_USER_ID,
            leadbridge_lead_status_subscription_id: 'sub_test',
            leadbridge_lead_status_encrypted_secret: encryptIntegrationSecret(SUB_SECRET),
            leadbridge_lead_status_secret_key_version: currentEncKeyVersion(),
          }],
        })
      },
      // .update(...).eq(...) — capture and resolve
      update(patch) {
        calls.updates.push({ table: 'communication_settings', patch })
        return {
          eq: () => Promise.resolve({ data: null, error: null }),
        }
      },
    }
    return b
  }

  function webhookEventsBuilder() {
    const b = {
      _isInsert: false,
      _insertRow: null,
      select() { return b },
      eq() { return b },
      maybeSingle: async () => ({ data: webhookExistingForId, error: null }),
      single: async () => {
        if (b._isInsert) return { data: { id: 'webhook_evt_id' }, error: null }
        return { data: null, error: null }
      },
      insert(row) {
        calls.inserts.push({ table: 'communication_webhook_events', row })
        b._isInsert = true
        b._insertRow = row
        return b
      },
      update(patch) {
        calls.updates.push({ table: 'communication_webhook_events', patch })
        return {
          eq: () => Promise.resolve({ data: null, error: null }),
        }
      },
    }
    return b
  }

  function jobsBuilder() {
    const b = {
      select: () => b,
      eq: () => b,
      limit: async () => ({ data: jobs, error: null }),
    }
    return b
  }

  return {
    from(table) {
      if (table === 'communication_settings') return commSettingsBuilder()
      if (table === 'communication_webhook_events') return webhookEventsBuilder()
      if (table === 'jobs') return jobsBuilder()
      throw new Error(`Unexpected supabase.from(${table})`)
    },
    _calls: calls,
  }
}

function buildApp(supabase) {
  const app = express()
  app.use(express.json({
    verify: (req, _res, buf) => { if (buf?.length) req.rawBody = buf },
  }))
  const logger = { log() {}, warn() {}, error() {}, debug() {} }
  app.use('/api/integrations/leadbridge', require('../leadbridge-service')(supabase, logger))
  return app
}

function signedPost(app, payloadObj) {
  const body = JSON.stringify(payloadObj)
  const ts = Math.floor(Date.now() / 1000).toString()
  const sig = crypto.createHmac('sha256', SUB_SECRET).update(`${ts}.${body}`).digest('hex')
  return request(app)
    .post('/api/integrations/leadbridge/lead-status')
    .set('Content-Type', 'application/json')
    .set('X-LB-Signature', sig)
    .set('X-LB-Timestamp', ts)
    .set('X-LB-Event', 'lead.status_changed')
    .send(body)
}

describe('POST /lead-status — skip-reason persistence', () => {
  test('no_matching_job: writes processing_error="no_matching_job", processed=true', async () => {
    const supabase = makeSupabaseStub({ jobs: [] })
    const app = buildApp(supabase)

    const res = await signedPost(app, {
      event_id: 'evt_test_no_job',
      event_type: 'lead.status_changed',
      thread: { external_lead_id: 'EXT_DOES_NOT_EXIST' },
      channel: 'thumbtack',
      lead: { status: 'scheduled' },
    })

    expect(res.status).toBe(200)
    expect(res.body).toEqual(expect.objectContaining({ ok: true, action: 'skipped_no_job' }))

    // Audit trail: the webhook_events row got marked processed AND carries
    // the skip reason in processing_error (NOT in some other column).
    const webhookUpdates = supabase._calls.updates.filter(u => u.table === 'communication_webhook_events')
    expect(webhookUpdates.length).toBeGreaterThanOrEqual(1)
    const patch = webhookUpdates[webhookUpdates.length - 1].patch
    expect(patch.processed).toBe(true)
    expect(patch.processed_at).toEqual(expect.any(String))
    expect(patch.processing_error).toBe('no_matching_job')
    // Belt-and-suspenders: the wrong field name must NOT be present.
    expect(patch).not.toHaveProperty('error')
  })

  test('no_external_lead_id: writes processing_error="no_external_lead_id"', async () => {
    const supabase = makeSupabaseStub()
    const app = buildApp(supabase)

    const res = await signedPost(app, {
      event_id: 'evt_test_no_ext',
      event_type: 'lead.status_changed',
      thread: {}, // no external_lead_id
      channel: 'thumbtack',
      lead: { status: 'scheduled' },
    })

    expect(res.status).toBe(200)
    expect(res.body.action).toBe('skipped_no_external_lead_id')

    const webhookUpdates = supabase._calls.updates.filter(u => u.table === 'communication_webhook_events')
    const patch = webhookUpdates[webhookUpdates.length - 1].patch
    expect(patch.processing_error).toBe('no_external_lead_id')
    expect(patch).not.toHaveProperty('error')
  })

  test('skipped_no_job_equivalent: LB status with no SF mapping persists reason', async () => {
    const supabase = makeSupabaseStub()
    const app = buildApp(supabase)

    const res = await signedPost(app, {
      event_id: 'evt_test_no_map',
      event_type: 'lead.status_changed',
      thread: { external_lead_id: 'EXT' },
      channel: 'thumbtack',
      lead: { status: 'contacted' }, // mapped to null
    })

    expect(res.status).toBe(200)
    expect(res.body.action).toBe('skipped')

    const webhookUpdates = supabase._calls.updates.filter(u => u.table === 'communication_webhook_events')
    const patch = webhookUpdates[webhookUpdates.length - 1].patch
    expect(patch.processing_error).toMatch(/^skipped_/)
    expect(patch).not.toHaveProperty('error')
  })

  test('ambiguous_job: persists reason when 2+ jobs share external_lead_id', async () => {
    const supabase = makeSupabaseStub({
      jobs: [
        { id: 1, status: 'pending', lb_external_request_id: 'EXT', lb_channel: 'thumbtack' },
        { id: 2, status: 'pending', lb_external_request_id: 'EXT', lb_channel: 'thumbtack' },
      ],
    })
    const app = buildApp(supabase)

    const res = await signedPost(app, {
      event_id: 'evt_test_ambig',
      event_type: 'lead.status_changed',
      thread: { external_lead_id: 'EXT' },
      channel: 'thumbtack',
      lead: { status: 'scheduled' },
    })

    expect(res.status).toBe(200)
    expect(res.body.action).toBe('skipped_ambiguous')

    const webhookUpdates = supabase._calls.updates.filter(u => u.table === 'communication_webhook_events')
    const patch = webhookUpdates[webhookUpdates.length - 1].patch
    expect(patch.processing_error).toBe('ambiguous_job')
    expect(patch).not.toHaveProperty('error')
  })
})
