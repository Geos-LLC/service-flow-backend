/**
 * LeadBridge Integration Module (Loosely Coupled)
 *
 * Mount: app.use('/api/integrations/leadbridge', require('./leadbridge-service')(supabase, logger))
 * Remove: delete this file + remove the line above = zero breakage
 *
 * Phase A: Communication layer only.
 *   - Connect/disconnect LB account
 *   - Sync conversations + messages from LB
 *   - Receive webhook events from LB
 *   - Generic send via LB
 *
 * Does NOT depend on CRM leads/customers module.
 * Does NOT call Thumbtack/Yelp APIs directly — LB is the proxy.
 */

const express = require('express')
const axios = require('axios')
const crypto = require('crypto')

const {
  encryptIntegrationSecret,
  decryptIntegrationSecret,
  currentEncKeyVersion,
} = require('./services/lb-encryption')

const { resolveIdentity } = require('./lib/identity-resolver')
const { FLAGS, isEnabled, isEnabledForTenant } = require('./lib/feature-flags')
const { setIdentityLead, setIdentityCustomer } = require('./lib/identity-linker')
const { makeAdapter: makeLbEngineAdapter } = require('./lib/lb-engine-adapter')
const { authenticateWebhook } = require('./lib/webhook-signature')
const { pickLBSource, pickLBSources, pickLbLink, buildEnrichLeadPatch, assertCreateLeadInvariant, assertCreateChildLeadInvariant } = require('./lib/lb-ingestion')
const { setCustomerAcquisitionIfMissing } = require('./lib/lb-linkage-resolver')
const { loadSourceMappings } = require('./lib/integration-sync-orchestrator')
const { mapLbToSfStatus, isKnownLbStatus, normalizeLbStatus } = require('./services/lb-inbound-status-map')
const { updateJobStatus } = require('./services/job-status-service')
const { getLinkageHealth } = require('./lib/lb-linkage-health')
const { reconcileTenantWithLb } = require('./lib/lb-reconcile')
const { runAttributionRecovery } = require('./lib/lb-attribution-recovery')
const { buildSemanticSummary, buildEntitySemanticState } = require('./lib/lb-semantic-summary')
// Phase 2B — LB orchestration (additive, feature-flagged)
// S2: switch the 4 endpoints to (a) auth dispatcher (user JWT OR
// orchestration token), and (b) layered enablement (env override OR
// connection-state + active credential). With zero credentials and
// empty env, behavior is identical to today (403 for valid user JWT).
const { makeRequireOrchestrationEnabled } = require('./lib/lb-orchestration-feature-flag')
const { makeOrchestrationAuthDispatcher } = require('./lib/lb-orchestration-auth')
const {
  makeAvailabilityHandler,
  makeBookingRequestHandler,
  makeBookingCancelHandler,
  makeHandoffHandler,
} = require('./lib/lb-orchestration-handlers')
const { setCustomerAcquisitionIfMissing: _setCustomerAcquisitionIfMissing2B } = require('./lib/lb-linkage-resolver')
const { updateJobStatus: _updateJobStatus2B } = require('./services/job-status-service')
// S4 — OAuth handshake + provisioning payload.
const lbOrchClients   = require('./lib/lb-orchestration-clients')
const lbOrchOauthCodes = require('./lib/lb-orchestration-oauth-codes')
const lbOrchHandshake  = require('./lib/lb-orchestration-handshake')
const { buildProvisioningPayload } = require('./lib/lb-orchestration-provisioning-payload')
const { attachCredentialToCode } = lbOrchOauthCodes
// R1B — LB-facing pull-style credential refresh.
const { performRefresh: orchPerformRefresh } = lbOrchHandshake
// Direct (email/password) orchestration provisioning — supersedes the
// OAuth browser-redirect path for tenant-driven Connect. See
// lib/lb-orchestration-direct-provision.js for the contract.
const lbOrchDirectProvision = require('./lib/lb-orchestration-direct-provision')
// Migration-060 — LB-initiated historical lead link.
const lbLeadLinkMatcher = require('./lib/lb-lead-link-matcher')
const lbLeadLinkAttacher = require('./lib/lb-lead-link-attacher')
const lbLeadLinkBulk = require('./lib/lb-lead-link-bulk')
// SF-driven historical sync (Phase 1: dry-run-only).
const sfHistoricalSyncOrchestrator = require('./lib/sf-historical-sync-orchestrator')

const LB_BASE = process.env.LEADBRIDGE_URL || 'https://thumbtack-bridge-production.up.railway.app/api'

// In-memory sync progress per user
const syncProgress = {}

// Outbound subscription fields — kept in one place so we never miss
// one when clearing / reading. The outbound layer is a second
// direction of THIS integration, not a separate entity.
const OUTBOUND_COLUMNS = [
  'leadbridge_outbound_subscription_id',
  'leadbridge_outbound_encrypted_secret',
  'leadbridge_outbound_secret_key_version',
  'leadbridge_outbound_webhook_url',
  'leadbridge_outbound_events',
  'leadbridge_outbound_registered_at',
  'leadbridge_outbound_last_event_at',
]

// Lead-status (LB → SF inbound) subscription fields. Symmetric to
// OUTBOUND_COLUMNS but tied to LB's CrmWebhookSubscription model
// (POST /v1/integrations/webhooks) rather than the SF-specific
// /v1/integrations/service-flow/subscribe endpoint.
const LEAD_STATUS_COLUMNS = [
  'leadbridge_lead_status_subscription_id',
  'leadbridge_lead_status_encrypted_secret',
  'leadbridge_lead_status_secret_key_version',
  'leadbridge_lead_status_webhook_url',
  'leadbridge_lead_status_events',
  'leadbridge_lead_status_registered_at',
  'leadbridge_lead_status_last_event_at',
]

// Inbound /webhooks subscription fields — added by migration 037 (PR-2).
// The older /api/integrations/leadbridge/webhooks endpoint received events
// without a stored per-user secret; PR-2 registers a CrmWebhookSubscription
// pointing at it so we can verify HMAC the same way /lead-status does.
const INBOUND_COLUMNS = [
  'leadbridge_inbound_subscription_id',
  'leadbridge_inbound_encrypted_secret',
  'leadbridge_inbound_secret_key_version',
  'leadbridge_inbound_webhook_url',
  'leadbridge_inbound_events',
  'leadbridge_inbound_registered_at',
  'leadbridge_inbound_last_event_at',
]

// LB subscribe path — see geos-leadbridge/plans/2026-04-17-job-sync-sf-lb.md.
// LB_BASE already includes /api; the shipped contract is versioned under /v1.
const LB_SUBSCRIBE_PATH = '/v1/integrations/service-flow/subscribe'
const LB_SF_INBOUND_PATH = '/v1/integrations/service-flow/job-status'

// LB CrmWebhookSubscription path — used for the LB→SF lead.status_changed
// direction. Contract: { name, webhookUrl, events, secret? } →
// { success, subscription: { id, name, webhookUrl, events, isActive, secret } }
const LB_LEAD_STATUS_SUBSCRIBE_PATH = '/v1/integrations/webhooks'

// SF endpoint LB will POST lead.status_changed events to. Built off
// RAILWAY_PUBLIC_DOMAIN with a hard-coded prod fallback (same pattern
// the WhatsApp + auth flows use).
const SF_LEAD_STATUS_INBOUND_PATH = '/api/integrations/leadbridge/lead-status'

// SF endpoint for the older v1 inbound integration (thread/message
// events). PR-2: register a CrmWebhookSubscription pointing at this
// URL so LB signs deliveries with a known secret.
const SF_INBOUND_WEBHOOK_PATH = '/api/integrations/leadbridge/webhooks'

// Default events for the inbound subscription. LB's CrmWebhookSubscription
// supports a fixed set; this list mirrors what the older /webhooks route
// already handles in this file (thread.message.received, lead.created).
const INBOUND_EVENT_TYPES = [
  'thread.message.received',
  'thread.message.sent',
  'lead.created',
  'lead.updated',
]

function sfPublicBaseUrl() {
  const domain = process.env.RAILWAY_PUBLIC_DOMAIN
  if (domain) return `https://${domain}`
  return process.env.SF_PUBLIC_BASE_URL || 'https://service-flow-backend-production-4568.up.railway.app'
}

// HMAC tolerance window (seconds) for X-LB-Timestamp replay protection.
const LEAD_STATUS_TS_TOLERANCE_S = 5 * 60

module.exports = (supabase, logger) => {
  const router = express.Router()

  // ══════════════════════════════════════
  // Auth middleware — reuse the app's JWT
  // ══════════════════════════════════════
  const authenticateToken = async (req, res, next) => {
    const authHeader = req.headers['authorization']
    const token = authHeader && authHeader.split(' ')[1]
    if (!token) return res.status(401).json({ error: 'No token provided' })
    try {
      const jwt = require('jsonwebtoken')
      const decoded = jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key')
      req.user = decoded
      next()
    } catch {
      return res.status(401).json({ error: 'Invalid token' })
    }
  }

  // ══════════════════════════════════════
  // Helpers
  // ══════════════════════════════════════

  // Make authenticated request to LeadBridge
  async function lbRequest(method, path, token, data = null) {
    const t = Date.now()
    const config = {
      method,
      url: `${LB_BASE}${path}`,
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      timeout: 30000,
    }
    if (data) config.data = data
    const res = await axios(config)
    logger.log(`[LB] ${method} ${path.substring(0, 80)} → ${res.status} (${Date.now() - t}ms)`)
    return res
  }

  // Get LB settings for a user
  async function getLbSettings(userId) {
    const { data } = await supabase.from('communication_settings')
      .select('leadbridge_connected, leadbridge_integration_token, leadbridge_user_id, leadbridge_connected_at')
      .eq('user_id', userId).maybeSingle()
    return data
  }

  // Normalize phone to E.164
  function normalizePhone(phone) {
    if (!phone) return null
    const digits = phone.replace(/[^\d+]/g, '')
    if (digits.startsWith('+')) return digits
    if (digits.length === 10) return `+1${digits}`
    if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`
    return digits
  }

  // ══════════════════════════════════════
  // Location Resolution Service
  //
  // Shared by webhook handler AND sync handler — single code path.
  // Never called from two different implementations.
  //
  // Resolution order (explicit, no fuzzy matching):
  //   1. Exact: provider_account_id + external_location_id → sf_location_id
  //   2. Account fallback: provider_account_id with mapping_type='account_level' → sf_location_id
  //   3. Unresolved: { locationId: null, resolution: 'unresolved' }
  //
  // Returns: { locationId: number|null, resolution: string, locationName: string|null }
  // ══════════════════════════════════════

  async function resolveConversationLocation({ providerAccountId, externalLocationId, externalBusinessId }) {
    if (!providerAccountId) {
      return { locationId: null, resolution: 'no_account', locationName: null }
    }

    // Step 1: Exact match — provider account + external location ID
    if (externalLocationId) {
      const { data: exact } = await supabase
        .from('communication_account_location_mappings')
        .select('sf_location_id, external_location_name')
        .eq('provider_account_id', providerAccountId)
        .eq('external_location_id', externalLocationId)
        .eq('is_active', true)
        .maybeSingle()

      if (exact) {
        // Fetch location name
        const { data: loc } = await supabase
          .from('territories').select('name')
          .eq('id', exact.sf_location_id).maybeSingle()

        return {
          locationId: exact.sf_location_id,
          resolution: 'exact',
          locationName: loc?.name || exact.external_location_name || null,
        }
      }
    }

    // Step 2: Account-level fallback — provider account mapped to exactly 1 location
    const { data: accountMappings } = await supabase
      .from('communication_account_location_mappings')
      .select('sf_location_id, external_location_name')
      .eq('provider_account_id', providerAccountId)
      .eq('mapping_type', 'account_level')
      .eq('is_active', true)

    if (accountMappings?.length === 1) {
      const mapping = accountMappings[0]
      const { data: loc } = await supabase
        .from('territories').select('name')
        .eq('id', mapping.sf_location_id).maybeSingle()

      return {
        locationId: mapping.sf_location_id,
        resolution: 'account_fallback',
        locationName: loc?.name || mapping.external_location_name || null,
      }
    }

    // Step 3: Unresolved — no mapping found (valid state)
    // Conversation will still be stored and displayed with "Unassigned Location" badge
    return { locationId: null, resolution: 'unresolved', locationName: null }
  }

  // Get or create participant identity.
  // Behavior split:
  //   IDENTITY_RESOLVER_LEADBRIDGE flag ON  → route through shared lib/identity-resolver.
  //                                            Ambiguous result → null (caller skips CRM work).
  //   flag OFF (default)                    → legacy phone+lb_contact_id upsert (unchanged).
  async function upsertParticipantIdentity(userId, { phone, email, displayName, lbContactId, channel }) {
    if (isEnabled(FLAGS.IDENTITY_RESOLVER_LEADBRIDGE)) {
      const result = await resolveIdentity(supabase, {
        userId,
        source: 'leadbridge',
        externalId: lbContactId,
        phone,
        email,
        displayName,
      })
      if (result.status === 'ambiguous') {
        logger.warn(`[LB] Ambiguous identity for lbContactId=${lbContactId} reason=${result.reason} candidates=${result.candidates.join(',')}`)
        return null
      }
      if (result.status === 'error') {
        logger.error(`[LB] Identity resolver error: ${result.error}`)
        return null
      }
      return result.identity
    }

    // Legacy path (unchanged) — lb_contact_id OR phone-alone upsert.
    const normalized = normalizePhone(phone)
    let identity = null
    if (lbContactId) {
      const { data } = await supabase.from('communication_participant_identities')
        .select('*').eq('user_id', userId).eq('leadbridge_contact_id', lbContactId).maybeSingle()
      identity = data
    }
    if (!identity && normalized) {
      const { data } = await supabase.from('communication_participant_identities')
        .select('*').eq('user_id', userId).eq('normalized_phone', normalized).maybeSingle()
      identity = data
    }

    if (identity) {
      const updates = { updated_at: new Date().toISOString() }
      if (displayName && !identity.display_name) updates.display_name = displayName
      if (normalized && !identity.normalized_phone) updates.normalized_phone = normalized
      if (email && !identity.email) updates.email = email
      if (lbContactId && !identity.leadbridge_contact_id) updates.leadbridge_contact_id = lbContactId
      if (Object.keys(updates).length > 1) {
        await supabase.from('communication_participant_identities').update(updates).eq('id', identity.id)
      }
      return identity
    }

    const { data: created, error } = await supabase.from('communication_participant_identities').insert({
      user_id: userId,
      normalized_phone: normalized,
      email: email || null,
      display_name: displayName || null,
      leadbridge_contact_id: lbContactId || null,
      source_channel: channel || 'leadbridge',
      source_confidence: 'auto',
    }).select().single()

    if (error) { logger.error('[LB] Identity insert error:', error.message); return null }
    return created
  }

  // ══════════════════════════════════════
  // LB Lead Ingestion — split create/enrich with HARD INVARIANT
  //
  //   resolveOrCreateLead(identity, input)
  //     if identity.sf_lead_id      → enrichLeadFromLB (NEVER creates)
  //     elif identity.sf_customer_id → enrichCustomerFromLB (NEVER creates lead)
  //     else find existing CRM by phone
  //       found customer/lead → link identity + enrich
  //       none found          → createLeadFromLB
  //
  //   createLeadFromLB asserts identity.sf_lead_id IS NULL before running.
  //   enrichLeadFromLB fills nulls only + upgrades legacy flat LB source
  //   to per-location source. Never overwrites user-edited fields.
  // ══════════════════════════════════════

  async function enrichLeadFromLB(userId, leadId, input) {
    // source_raw + lb_* are opportunistically filled by buildEnrichLeadPatch on
    // rows missing them; non-null lb_external_request_id is never overwritten.
    const { data: existing } = await supabase.from('leads')
      .select('id, source, source_raw, email, lb_external_request_id, lb_channel, lb_business_id, lb_provider_account_id')
      .eq('id', leadId).eq('user_id', userId).maybeSingle()
    if (!existing) return

    // Mismatch detection — if the incoming payload carries a *different*
    // non-null LB external id than what's already on the row, that is a
    // data-quality signal (duplicate-customer-merge upstream, or a
    // misrouted webhook). Log and drop. Same-value or null incoming is
    // handled silently by buildEnrichLeadPatch.
    const link = pickLbLink(input)
    if (
      link.lb_external_request_id != null &&
      existing.lb_external_request_id != null &&
      String(link.lb_external_request_id) !== String(existing.lb_external_request_id)
    ) {
      logger.warn(
        `[LB Lead] lb_linkage_mismatch lead=${leadId} user=${userId} ` +
        `existing=${existing.lb_external_request_id}/${existing.lb_channel || ''} ` +
        `incoming=${link.lb_external_request_id}/${link.lb_channel || ''} — dropped (fill-nulls-only)`
      )
    }

    const patch = buildEnrichLeadPatch({ existing, input })
    if (!patch) return
    await supabase.from('leads').update(patch).eq('id', leadId)
  }

  async function createLeadFromLB(userId, identity, input) {
    const { channel, customerName, customerPhone, customerEmail, message, accountDisplayName, sourceMappingsLookup } = input
    assertCreateLeadInvariant(identity)

    const { data: pipeline } = await supabase.from('lead_pipelines')
      .select('id').eq('user_id', userId).eq('is_default', true).maybeSingle()
    if (!pipeline) { logger.warn('[LB Lead] No default pipeline for user', userId); return null }

    const { data: stages } = await supabase.from('lead_stages')
      .select('id, name, position').eq('pipeline_id', pipeline.id).order('position', { ascending: true })
    if (!stages?.length) { logger.warn('[LB Lead] No stages in default pipeline', pipeline.id); return null }

    let stage = stages[0]
    const eventType = message ? 'first_reply_sent' : 'lead_received'
    const { data: rule } = await supabase.from('lead_stage_automation_rules')
      .select('target_stage_id').eq('user_id', userId).eq('event_type', eventType)
      .eq('enabled', true).in('channel', [channel, 'all']).limit(1).maybeSingle()

    if (rule) {
      const matchedStage = stages.find(s => s.id === rule.target_stage_id)
      if (matchedStage) stage = matchedStage
    } else {
      const contactedStage = stages.find(s => s.name === 'Contacted' || s.position === 1)
      const newLeadStage = stages.find(s => s.name === 'New Lead' || s.position === 0)
      stage = (message && contactedStage) ? contactedStage : (newLeadStage || stages[0])
    }

    const nameParts = (customerName || '').trim().split(/\s+/)
    const firstName = nameParts[0] || null
    const lastName = nameParts.slice(1).join(' ') || null
    const normalized = normalizePhone(customerPhone)
    // Two-field attribution (migration 050): canonical → leads.source,
    // raw → leads.source_raw. Falls back to raw on both when no mapping.
    const { source, source_raw } = pickLBSources({ accountDisplayName, channel, sourceMappingsLookup })

    // Phase 0.5: lead_origin_type written at create time.
    // reactivation = identity already has a customer (returning customer)
    // first_touch = no prior CRM link
    const isReactivation = !!identity.sf_customer_id
    const leadOriginType = isReactivation ? 'reactivation' : 'first_touch'

    // Migration 051 — LB linkage captured at create-time. These are the
    // ground truth for SF→LB propagation: the lead carries the LB external
    // request id forward through customer conversion and job creation. When
    // the caller didn't pass an explicit lbExternalRequestId, these are NULL
    // and the lead behaves like any other SF-native lead (no outbound).
    const lbLink = pickLbLink(input)

    const { data: newLead, error } = await supabase.from('leads').insert({
      user_id: userId,
      pipeline_id: pipeline.id,
      stage_id: stage.id,
      first_name: firstName,
      last_name: lastName,
      phone: normalized || null,
      email: customerEmail || null,
      source,
      source_raw,
      notes: message ? message.substring(0, 500) : null,
      lead_origin_type: leadOriginType,
      lb_external_request_id: lbLink.lb_external_request_id,
      lb_channel: lbLink.lb_channel,
      lb_business_id: lbLink.lb_business_id,
      lb_provider_account_id: lbLink.lb_provider_account_id,
    }).select().single()

    if (error) { logger.error('[LB Lead] Create error:', error.message); return null }

    // Route through canonical setter — projection fires automatically if
    // identity already has sf_customer_id from a prior ZB sync.
    await setIdentityLead(supabase, logger, {
      userId,
      identityId: identity.id,
      leadId: newLead.id,
      identitySnapshot: identity,
      policy: {
        resolvedBy: 'automatic',
        resolutionReason: 'identity_graph_projection',
        source: 'leadbridge',
        allowStageMove: false,
      },
    })

    logger.log(`[LB Lead] Created lead ${newLead.id} for ${customerName} (source="${source}" raw="${source_raw}") origin=${leadOriginType} lb_external_request_id=${lbLink.lb_external_request_id || 'null'} lb_channel=${lbLink.lb_channel || 'null'}`)
    return { type: isReactivation ? 'reactivation_lead' : 'new_lead', id: newLead.id, created: true, action: isReactivation ? 'reactivation' : 'created' }
  }

  // Phase 0.5 — child lead create. Records a repeat LB acquisition for an
  // identity that already has sf_lead_id. The new row is an attribution /
  // history record: it does NOT participate in pipeline lifecycle, does NOT
  // trigger stage automation, does NOT update the identity row.
  //
  // Identity-graph stability invariant: this function MUST NOT call
  // setIdentityLead / setIdentityCustomer. Identity.sf_lead_id continues
  // to point at the canonical lead.
  //
  // Communication invariant: conversations belong to the identity, not the
  // child lead. No conversation-attach work happens here.
  async function createChildLeadFromLB(userId, parentLeadId, identity, input) {
    const { channel, customerName, customerPhone, customerEmail, message, accountDisplayName, sourceMappingsLookup } = input
    // Fetch parent for invariant checks + pipeline/stage snapshot.
    const { data: parent } = await supabase.from('leads')
      .select('id, user_id, parent_lead_id, pipeline_id, stage_id, source')
      .eq('id', parentLeadId).eq('user_id', userId).maybeSingle()

    try {
      assertCreateChildLeadInvariant(parent, userId)
    } catch (e) {
      // Confidence-downgrade protection: surface as conflict log, refuse child create.
      // Caller should fall back to legacy enrich (or skip) — never auto-collapse.
      logger.warn(`[LeadCardinalityConflict] tenant=${userId} parent=${parentLeadId} reason=${e.message}`)
      return null
    }

    const nameParts = (customerName || '').trim().split(/\s+/)
    const firstName = nameParts[0] || null
    const lastName = nameParts.slice(1).join(' ') || null
    const normalized = normalizePhone(customerPhone)
    // Two-field attribution — child rows preserve their own attribution
    // separate from the canonical (acquisition history, not pipeline state).
    const { source, source_raw } = pickLBSources({ accountDisplayName, channel, sourceMappingsLookup })

    // Stage inheritance: snapshot the canonical's stage at create time.
    // Children do not transition; they remain at this snapshot forever.
    // Pipeline inheritance: same pipeline as parent.
    //
    // LB linkage (migration 051) — child rows preserve their OWN LB
    // attribution, not the parent's. The child represents a new repeat
    // acquisition event; its externalRequestId/channel/businessId are
    // distinct from the parent's. SF→LB outbound for jobs created from
    // child leads (rare, since jobs typically reference parents) will
    // therefore emit to the child's externalRequestId, which is the
    // correct LB-side target for that acquisition.
    const lbLink = pickLbLink(input)

    const { data: newChild, error } = await supabase.from('leads').insert({
      user_id: userId,
      parent_lead_id: parent.id,
      pipeline_id: parent.pipeline_id,
      stage_id: parent.stage_id,
      first_name: firstName,
      last_name: lastName,
      phone: normalized || null,
      email: customerEmail || null,
      source,
      source_raw,
      notes: message ? message.substring(0, 500) : null,
      lead_origin_type: 'repeat_acquisition',
      lb_external_request_id: lbLink.lb_external_request_id,
      lb_channel: lbLink.lb_channel,
      lb_business_id: lbLink.lb_business_id,
      lb_provider_account_id: lbLink.lb_provider_account_id,
    }).select().single()

    if (error) {
      logger.error(`[LB Lead] Child create error: ${error.message}`)
      return null
    }

    // Structured log — counters derived in Loki.
    logger.log(`[LeadCardinality] event=child_created tenant=${userId} parent=${parent.id} child=${newChild.id} identity=${identity.id} source="${source}" raw="${source_raw}" channel=${channel || 'unknown'}`)

    return newChild
  }

  async function resolveOrCreateLead(userId, identity, input) {
    if (!identity) return null
    const { customerPhone } = input

    // Identity already tied to a lead.
    if (identity.sf_lead_id) {
      // Phase 0.5: when child-leads flag ON, preserve repeat acquisition as
      // a child lead (parent_lead_id = canonical). When OFF, legacy enrich.
      if (isEnabledForTenant(FLAGS.LEAD_CARDINALITY_CHILD_LEADS, userId)) {
        const child = await createChildLeadFromLB(userId, identity.sf_lead_id, identity, input)
        if (child) {
          return { type: 'child_lead', id: child.id, parent_lead_id: identity.sf_lead_id, created: true, action: 'child_acquisition' }
        }
        // Child create failed (e.g., invariant violation) — fall through to legacy enrich.
      }
      await enrichLeadFromLB(userId, identity.sf_lead_id, input)
      return { type: 'lead', id: identity.sf_lead_id, created: false, action: 'enriched' }
    }

    // Identity already tied to a customer.
    // Phase 0.5: when child-leads flag ON, create a NEW canonical lead and
    // tag it as 'reactivation'. The projection layer auto-links it to the
    // existing customer via setIdentityLead → projectIdentityToCRM. Identity
    // graph is unchanged (same identity row, new sf_lead_id pointer).
    // When flag OFF, legacy: suppress lead.
    if (identity.sf_customer_id) {
      // Migration 054 — stamp customer.acquisition_* write-once. If the
      // customer already has an acquisition recorded, this is a no-op.
      // If they don't, we record this LB lead as their first acquisition
      // source for recurring-customer analytics + Strategy-4 resolver.
      const link = pickLbLink(input)
      if (link.lb_external_request_id) {
        try {
          await setCustomerAcquisitionIfMissing(supabase, userId, identity.sf_customer_id, {
            ...link,
            acquired_at: input.lbCreatedAt || new Date().toISOString(),
          })
        } catch (e) {
          logger.warn(`[LB Lead] setCustomerAcquisitionIfMissing failed cust=${identity.sf_customer_id}: ${e?.message}`)
        }
      }
      if (isEnabledForTenant(FLAGS.LEAD_CARDINALITY_CHILD_LEADS, userId)) {
        // Note: assertCreateLeadInvariant inside createLeadFromLB will throw
        // if identity.sf_lead_id is set (it isn't here), so this is safe.
        const newLead = await createLeadFromLB(userId, identity, input)
        if (newLead) {
          return { type: 'reactivation_lead', id: newLead.id, created: true, action: 'reactivation' }
        }
      }
      return { type: 'customer', id: identity.sf_customer_id, created: false, action: 'identity_already_customer' }
    }

    // Try to find existing CRM entity by phone (legacy behavior preserved).
    // Identity-graph writes route through setters → projection fires when
    // both sides become populated.
    const last10 = normalizePhone(customerPhone)?.slice(-10)
    if (last10 && last10.length >= 7) {
      const { data: customer } = await supabase.from('customers')
        .select('id').eq('user_id', userId).ilike('phone', `%${last10}%`).limit(1).maybeSingle()
      if (customer) {
        await setIdentityCustomer(supabase, logger, {
          userId,
          identityId: identity.id,
          customerId: customer.id,
          identitySnapshot: identity,
          policy: {
            resolvedBy: 'automatic',
            resolutionReason: 'identity_graph_projection',
            source: 'leadbridge',
            allowStageMove: false,
          },
        })
        // Migration 054 — write-once customer acquisition stamp. Closes
        // the historical leak: pre-PR, this branch silently linked the
        // identity but never recorded that the customer was LB-acquired.
        const link = pickLbLink(input)
        if (link.lb_external_request_id) {
          try {
            await setCustomerAcquisitionIfMissing(supabase, userId, customer.id, {
              ...link,
              acquired_at: input.lbCreatedAt || new Date().toISOString(),
            })
          } catch (e) {
            logger.warn(`[LB Lead] setCustomerAcquisitionIfMissing (phone-match) failed cust=${customer.id}: ${e?.message}`)
          }
        }
        return { type: 'customer', id: customer.id, created: false, action: 'linked_customer' }
      }

      const { data: existingLead } = await supabase.from('leads')
        .select('id').eq('user_id', userId).ilike('phone', `%${last10}%`).limit(1).maybeSingle()
      if (existingLead) {
        await setIdentityLead(supabase, logger, {
          userId,
          identityId: identity.id,
          leadId: existingLead.id,
          identitySnapshot: identity,
          policy: {
            resolvedBy: 'automatic',
            resolutionReason: 'identity_graph_projection',
            source: 'leadbridge',
            allowStageMove: false,
          },
        })
        await enrichLeadFromLB(userId, existingLead.id, input)
        return { type: 'lead', id: existingLead.id, created: false, action: 'linked_enriched' }
      }
    }

    // No existing CRM entity → create lead.
    return await createLeadFromLB(userId, identity, input)
  }

  // ══════════════════════════════════════
  // Stage 2 — LB engine adapter
  //
  // Binds lib/identity-reconciliation-engine to the LB writer closures
  // defined above. The webhook handler and runLbSync each gain ONE
  // guarded branch that calls resolveOrCreateLeadViaEngine when the
  // RECONCILIATION_ENGINE_LEADBRIDGE prerequisite chain is satisfied
  // for the tenant; otherwise legacy path runs unchanged + a rate-limited
  // warn is emitted on prerequisite-miss.
  //
  // See docs/architecture/stage-2-leadbridge-adapter-plan.md.
  // ══════════════════════════════════════

  const lbEngineAdapter = makeLbEngineAdapter({
    supabase,
    logger,
    executors: {
      createLeadFromLB,
      createChildLeadFromLB,
      enrichLeadFromLB,
      setIdentityLead,
      setIdentityCustomer,
    },
  })

  // ══════════════════════════════════════
  // Lead Stage Automation Engine
  //
  // Checks automation rules and advances the lead to the
  // target stage for the given event. Only advances forward
  // (never moves a lead backwards in the pipeline).
  //
  // Events:
  //   lead_received       — new lead from TT/Yelp
  //   first_reply_sent    — agent sends first outbound message
  //   conversation_ongoing — further messages after first reply
  //   proposal_sent       — quote/proposal sent
  //   job_created         — job created, optionally convert to customer
  // ══════════════════════════════════════

  async function progressLeadStage(userId, leadId, eventType, channel) {
    if (!leadId || !eventType) return

    try {
      // Get the lead's current stage
      const { data: lead } = await supabase.from('leads')
        .select('id, stage_id, converted_customer_id').eq('id', leadId).eq('user_id', userId).maybeSingle()
      if (!lead || lead.converted_customer_id) return // Already converted, skip

      // Get the current stage position
      const { data: currentStage } = await supabase.from('lead_stages')
        .select('id, position').eq('id', lead.stage_id).maybeSingle()

      // Find matching rule: try channel-specific first, then 'all'
      let rule = null
      const { data: channelRule } = await supabase.from('lead_stage_automation_rules')
        .select('*').eq('user_id', userId).eq('channel', channel).eq('event_type', eventType)
        .eq('enabled', true).maybeSingle()
      rule = channelRule

      if (!rule) {
        const { data: allRule } = await supabase.from('lead_stage_automation_rules')
          .select('*').eq('user_id', userId).eq('channel', 'all').eq('event_type', eventType)
          .eq('enabled', true).maybeSingle()
        rule = allRule
      }

      if (!rule) return // No rule for this event

      // Get target stage position
      const { data: targetStage } = await supabase.from('lead_stages')
        .select('id, position, name').eq('id', rule.target_stage_id).maybeSingle()
      if (!targetStage) return

      // Only advance forward (never move backwards)
      if (currentStage && targetStage.position <= currentStage.position) return

      // Update lead stage
      await supabase.from('leads').update({
        stage_id: targetStage.id,
        updated_at: new Date().toISOString(),
      }).eq('id', leadId)

      logger.log(`[LB Stage] Lead ${leadId}: ${eventType} → ${targetStage.name} (stage ${targetStage.position})`)

      // Auto-convert to customer if rule says so
      if (rule.auto_convert_to_customer && eventType === 'job_created') {
        // This would trigger the existing lead→customer conversion flow
        // For now just log — full conversion wired in Phase C
        logger.log(`[LB Stage] Lead ${leadId}: marked for auto-conversion to customer`)
      }
    } catch (e) {
      logger.warn(`[LB Stage] Error progressing lead ${leadId}: ${e.message}`)
    }
  }

  // Upsert conversation from LB data
  async function upsertConversation(userId, { provider, channel, externalConvId, externalLeadId,
    participantPhone, participantName, identityId, providerAccountId, lastMessage, lastActivity,
    externalLocationId, externalBusinessId, externalLocationName }) {

    // Resolve location via shared service
    const location = await resolveConversationLocation({
      providerAccountId,
      externalLocationId,
      externalBusinessId,
    })

    // Find existing by external_conversation_id
    let conv = null
    if (externalConvId) {
      const { data } = await supabase.from('communication_conversations')
        .select('*').eq('user_id', userId).eq('provider', provider)
        .eq('channel', channel).eq('external_conversation_id', externalConvId).maybeSingle()
      conv = data
    }
    // Fallback: find by external_lead_id
    if (!conv && externalLeadId) {
      const { data } = await supabase.from('communication_conversations')
        .select('*').eq('user_id', userId).eq('provider', provider)
        .eq('channel', channel).eq('external_lead_id', externalLeadId).maybeSingle()
      conv = data
    }

    if (conv) {
      const updates = { updated_at: new Date().toISOString() }
      if (lastMessage) updates.last_preview = lastMessage.substring(0, 200)
      if (lastActivity) updates.last_event_at = lastActivity
      if (participantName && !conv.participant_name) updates.participant_name = participantName
      if (identityId && !conv.participant_identity_id) updates.participant_identity_id = identityId
      if (providerAccountId && !conv.provider_account_id) updates.provider_account_id = providerAccountId
      if (externalConvId && !conv.external_conversation_id) updates.external_conversation_id = externalConvId
      if (externalLeadId && !conv.external_lead_id) updates.external_lead_id = externalLeadId
      // Location fields — always update raw, update resolved only if newly resolved
      if (externalLocationId) updates.external_location_id = externalLocationId
      if (externalBusinessId) updates.external_business_id = externalBusinessId
      if (externalLocationName) updates.external_location_name = externalLocationName
      if (location.locationId && !conv.sf_location_id) updates.sf_location_id = location.locationId
      await supabase.from('communication_conversations').update(updates).eq('id', conv.id)
      return { ...conv, ...updates, _locationResolution: location.resolution }
    }

    // Create new
    const { data: created, error } = await supabase.from('communication_conversations').insert({
      user_id: userId,
      provider,
      channel,
      external_conversation_id: externalConvId || null,
      external_lead_id: externalLeadId || null,
      participant_phone: normalizePhone(participantPhone),
      participant_name: participantName || null,
      participant_identity_id: identityId || null,
      provider_account_id: providerAccountId || null,
      last_preview: lastMessage ? lastMessage.substring(0, 200) : null,
      last_event_at: lastActivity || new Date().toISOString(),
      unread_count: 0,
      sync_state: 'synced',
      // Location fields
      sf_location_id: location.locationId,
      external_location_id: externalLocationId || null,
      external_business_id: externalBusinessId || null,
      external_location_name: externalLocationName || null,
    }).select().single()

    if (error) { logger.error('[LB] Conv insert error:', error.message); return null }
    return created
  }

  // ══════════════════════════════════════
  // POST /connect — Connect LeadBridge
  // ══════════════════════════════════════
  router.post('/connect', authenticateToken, async (req, res) => {
    try {
      const userId = req.user.userId
      const { email, password } = req.body
      if (!email || !password) return res.status(400).json({ error: 'Email and password required' })

      // 1. Authenticate with LeadBridge
      let lbToken, lbUserId
      try {
        const loginRes = await lbRequest('POST', '/auth/login', null, { email, password })
        // LB returns { user: { id, email, ... }, token: "jwt..." }
        lbToken = loginRes.data?.token
        lbUserId = loginRes.data?.user?.id
        if (!lbToken) return res.status(422).json({ error: 'LeadBridge login failed — no token returned' })
      } catch (e) {
        const msg = e.response?.data?.message || e.message
        // Use 422 not 401 — the SF auth is valid, LB credentials are wrong
        // 401 would trigger the frontend interceptor to redirect to SF login
        return res.status(422).json({ error: `LeadBridge login failed: ${msg}` })
      }

      // 2. Fetch connected accounts
      let accounts = []
      try {
        const acctRes = await lbRequest('GET', '/v1/platforms/saved-accounts', lbToken)
        // LB returns { count, accounts: [...] }
        accounts = acctRes.data?.accounts || []
      } catch (e) {
        logger.warn('[LB] Failed to fetch accounts:', e.message)
      }

      // 3. Store connection in communication_settings
      await supabase.from('communication_settings').upsert({
        user_id: userId,
        leadbridge_connected: true,
        leadbridge_integration_token: lbToken,
        leadbridge_user_id: lbUserId,
        leadbridge_connected_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }, { onConflict: 'user_id' })

      // 4. Create provider accounts for each LB account
      for (const acct of accounts) {
        // LB SavedAccount: { id, platform, businessId, businessName, emailHint, imageUrl, webhookId, tokenDead, ... }
        const platform = (acct.platform || 'thumbtack').toLowerCase()
        const channel = platform
        const externalId = acct.id  // LB saved account UUID
        const businessId = acct.businessId
        const name = acct.businessName || `${platform} Account`

        // Upsert: find existing or create
        const { data: existing } = await supabase.from('communication_provider_accounts')
          .select('id').eq('user_id', userId).eq('provider', 'leadbridge')
          .eq('channel', channel).eq('external_account_id', externalId).maybeSingle()

        if (existing) {
          await supabase.from('communication_provider_accounts').update({
            display_name: name, status: 'active',
            webhook_status: acct.webhookId ? 'active' : 'pending',
            metadata: { platform, businessId, imageUrl: acct.imageUrl, tokenDead: acct.tokenDead },
          }).eq('id', existing.id)
        } else {
          await supabase.from('communication_provider_accounts').insert({
            user_id: userId,
            provider: 'leadbridge',
            channel,
            external_account_id: externalId,
            external_business_id: businessId,
            display_name: name,
            account_email: acct.emailHint || email,
            status: 'active',
            webhook_status: acct.webhookId ? 'active' : 'pending',
            webhook_id: acct.webhookId,
            metadata: { platform, businessId, imageUrl: acct.imageUrl, tokenDead: acct.tokenDead },
          })
        }
      }

      // 5. Register SF as LB's outbound subscription target.
      //    This adds the SECOND DIRECTION of the same integration
      //    (SF → LB job-status delivery). Failure here MUST NOT fail
      //    the connect flow — LB ingest still works without outbound.
      //    We surface the outcome in the response so the UI can flag
      //    partial success and the user knows to reconnect if needed.
      const outboundResult = await registerOutboundSubscription(userId, lbToken)
      if (outboundResult.registered) {
        logger.log(`[LB] Outbound subscription registered for user ${userId} — sub_id=${outboundResult.subscriptionId}`)
      } else {
        logger.warn(`[LB] Outbound subscription NOT registered for user ${userId}: ${outboundResult.reason}`)
      }

      // 6. Register LB → SF lead.status_changed subscription via the
      //    CrmWebhookSubscription endpoint. This is the THIRD leg of
      //    the same integration — separate from the SF-specific
      //    /service-flow/subscribe used in step 5. Same failure
      //    semantics: never break connect, surface the error so the
      //    UI can prompt for reconnect.
      const leadStatusResult = await registerLeadStatusSubscription(userId, lbToken)
      if (leadStatusResult.registered) {
        logger.log(`[LB] Lead-status subscription registered for user ${userId} — sub_id=${leadStatusResult.subscriptionId}`)
      } else {
        logger.warn(`[LB] Lead-status subscription NOT registered for user ${userId}: ${leadStatusResult.reason}`)
      }

      // 7. PR-2: Register inbound /webhooks subscription so LB signs
      //    thread/lead events with a known secret. Without this, the
      //    older /webhooks endpoint receives unsigned events that we
      //    can't authenticate. Same failure semantics — never break
      //    connect; existing event flow works unsigned until the
      //    LB_INBOUND_HMAC_REQUIRED flag is enforced.
      const inboundResult = await registerInboundSubscription(userId, lbToken)
      if (inboundResult.registered) {
        logger.log(`[LB] Inbound subscription registered for user ${userId} — sub_id=${inboundResult.subscriptionId}`)
      } else {
        logger.warn(`[LB] Inbound subscription NOT registered for user ${userId}: ${inboundResult.reason}`)
      }

      // Phase 2C — Orchestration provisioning (server-to-server).
      // After the legacy connect succeeds, run the new SF→LB direct
      // provisioning chain: verify-credentials → mint SF cred → LB
      // provision → store webhook + enable + enqueue connection.connected.
      //
      // Email/password are forwarded to LB ONCE for verify-credentials
      // and never logged or persisted. On any failure here we surface
      // `orchestration_status='failed'` in the response so the UI can
      // show a Retry banner. The legacy lead-sync path above remains
      // committed regardless — message ingest keeps working.
      let orchestration = { status: 'not_attempted' }
      try {
        // Lookup tenant info for the LB provisioning payload metadata.
        const { data: sfUser } = await supabase.from('users').select('first_name,last_name,email,business_name').eq('id', userId).maybeSingle()
        const sfTenantName = sfUser
          ? (sfUser.business_name || [sfUser.first_name, sfUser.last_name].filter(Boolean).join(' ') || sfUser.email)
          : null
        const sfTenantEmail = sfUser ? sfUser.email : null

        const dp = await lbOrchDirectProvision.performDirectProvision(supabase, {
          tenantId:    userId,
          lbEmail:     email,
          lbPassword:  password,
          tenantName:  sfTenantName,
          tenantEmail: sfTenantEmail,
          createdBy:   'connect_direct',
          logger,
        })
        if (dp.ok) {
          orchestration = {
            status:           'connected',
            credential_id:    dp.credential.credentialId,
            token_prefix:     dp.credential.tokenPrefix,
            kid:              dp.credential.kid,
            issued_at:        dp.credential.issuedAt,
            expires_at:       dp.credential.expiresAt,
            lb_account_id:    dp.lbAccountId,
            lb_account_name:  dp.lbAccountName,
            subscription_id:  dp.subscriptionId,
            event_id:         dp.event_id,
            event_enqueued:   dp.event_enqueued,
          }
        } else {
          orchestration = {
            status:            'failed',
            reason:            dp.reason,
            step:              dp.step,
            http_status:       dp.status || null,
            error_description: dp.errorDescription || null,
          }
        }
      } catch (e) {
        logger.error(`[LB] /connect direct-provision threw: ${e && e.message}`)
        orchestration = { status: 'failed', reason: 'unexpected_error', step: 'provision' }
      }

      logger.log(`[LB] Connected for user ${userId}, ${accounts.length} accounts`)
      res.json({
        success: true,
        accounts,
        userId: lbUserId,
        direction_inbound: {
          active: true,
          accounts: accounts.length,
          subscription: {
            active: inboundResult.registered,
            subscription_id: inboundResult.subscriptionId || null,
            registered_at: inboundResult.registeredAt || null,
            webhook_url: inboundResult.webhookUrl || null,
            error: inboundResult.registered ? null : inboundResult.reason,
          },
        },
        direction_outbound: {
          active: outboundResult.registered,
          subscription_id: outboundResult.subscriptionId || null,
          registered_at: outboundResult.registeredAt || null,
          error: outboundResult.registered ? null : outboundResult.reason,
        },
        direction_lead_status: {
          active: leadStatusResult.registered,
          subscription_id: leadStatusResult.subscriptionId || null,
          registered_at: leadStatusResult.registeredAt || null,
          webhook_url: leadStatusResult.webhookUrl || null,
          error: leadStatusResult.registered ? null : leadStatusResult.reason,
        },
        // Phase 2C — orchestration provisioning result.
        // status: 'connected' | 'failed' | 'not_attempted'.
        orchestration,
        reconnect_required:
          !outboundResult.registered ||
          !leadStatusResult.registered ||
          !inboundResult.registered,
      })
    } catch (error) {
      logger.error('[LB] Connect error:', error.message)
      res.status(500).json({ error: 'Failed to connect LeadBridge' })
    }
  })

  // ══════════════════════════════════════
  // Outbound subscription helpers (§2a, §2c, §2d of plan)
  //
  // Note: LB's /subscribe is idempotent for the same user — "rotating"
  // the outbound secret just means calling it again, so /reconnect
  // below simply reuses this helper with the current stored LB token.
  // ══════════════════════════════════════

  async function registerOutboundSubscription(userId, lbToken) {
    try {
      const subRes = await lbRequest('POST', LB_SUBSCRIBE_PATH, lbToken, {
        name: 'Service Flow',
        sourceInstance: process.env.SF_INSTANCE || 'sf-prod',
        events: ['job.status_changed'],
      })

      const body = subRes?.data || {}
      const sub = body.subscription || body
      if (!body.success && !sub?.id) {
        return { registered: false, reason: `bad_response: ${JSON.stringify(body).slice(0, 200)}` }
      }
      if (!sub?.secret) {
        return { registered: false, reason: 'no_secret_returned' }
      }

      const encryptedSecret = encryptIntegrationSecret(sub.secret)
      const registeredAt = new Date().toISOString()
      const webhookUrl = sub.webhookUrl || `${LB_BASE}${LB_SF_INBOUND_PATH}`

      const { error: upErr } = await supabase.from('communication_settings').update({
        leadbridge_outbound_subscription_id: sub.id,
        leadbridge_outbound_encrypted_secret: encryptedSecret,
        leadbridge_outbound_secret_key_version: currentEncKeyVersion(),
        leadbridge_outbound_webhook_url: webhookUrl,
        leadbridge_outbound_events: sub.events || ['job.status_changed'],
        leadbridge_outbound_registered_at: registeredAt,
        updated_at: new Date().toISOString(),
      }).eq('user_id', userId)
      if (upErr) return { registered: false, reason: `db_update_failed: ${upErr.message}` }

      return {
        registered: true,
        subscriptionId: sub.id,
        registeredAt,
        events: sub.events || ['job.status_changed'],
      }
    } catch (e) {
      return { registered: false, reason: `subscribe_error: ${e.response?.status || ''} ${e.message}` }
    }
  }

  async function clearOutboundSubscription(userId) {
    const patch = { updated_at: new Date().toISOString() }
    for (const col of OUTBOUND_COLUMNS) patch[col] = null
    await supabase.from('communication_settings').update(patch).eq('user_id', userId)
  }

  // ══════════════════════════════════════
  // Lead-status (LB → SF) subscription helpers — symmetric to the
  // outbound (SF → LB) ones above, but use LB's CrmWebhookSubscription
  // contract:
  //   POST /v1/integrations/webhooks  body: { name, webhookUrl, events, secret? }
  //   →    { success, subscription: { id, name, webhookUrl, events, isActive, secret } }
  //
  // Idempotent on (userId, direction='outbound', webhookUrl) on the LB
  // side, so calling /reconnect simply rotates the secret. Failure
  // here MUST NOT fail the connect flow — inbound message ingest
  // remains functional without lead.status_changed delivery.
  // ══════════════════════════════════════

  async function registerLeadStatusSubscription(userId, lbToken) {
    try {
      const webhookUrl = `${sfPublicBaseUrl()}${SF_LEAD_STATUS_INBOUND_PATH}`
      const subRes = await lbRequest('POST', LB_LEAD_STATUS_SUBSCRIBE_PATH, lbToken, {
        name: 'Service Flow lead-status',
        webhookUrl,
        events: ['lead.status_changed'],
        metadata: {
          sf_instance: process.env.SF_INSTANCE || 'sf-prod',
          purpose: 'lead-status-sync',
        },
      })

      const body = subRes?.data || {}
      const sub = body.subscription || body
      if (!body.success && !sub?.id) {
        return { registered: false, reason: `bad_response: ${JSON.stringify(body).slice(0, 200)}` }
      }
      if (!sub?.secret) {
        // LB only returns the secret on the first create. If we get an
        // upsert response without a secret, the caller must rotate via
        // /reconnect to obtain one — without the secret we cannot
        // verify incoming signatures.
        return { registered: false, reason: 'no_secret_returned' }
      }

      const encryptedSecret = encryptIntegrationSecret(sub.secret)
      const registeredAt = new Date().toISOString()

      const { error: upErr } = await supabase.from('communication_settings').update({
        leadbridge_lead_status_subscription_id: sub.id,
        leadbridge_lead_status_encrypted_secret: encryptedSecret,
        leadbridge_lead_status_secret_key_version: currentEncKeyVersion(),
        leadbridge_lead_status_webhook_url: sub.webhookUrl || webhookUrl,
        leadbridge_lead_status_events: sub.events || ['lead.status_changed'],
        leadbridge_lead_status_registered_at: registeredAt,
        updated_at: new Date().toISOString(),
      }).eq('user_id', userId)
      if (upErr) return { registered: false, reason: `db_update_failed: ${upErr.message}` }

      return {
        registered: true,
        subscriptionId: sub.id,
        registeredAt,
        webhookUrl: sub.webhookUrl || webhookUrl,
        events: sub.events || ['lead.status_changed'],
      }
    } catch (e) {
      return { registered: false, reason: `subscribe_error: ${e.response?.status || ''} ${e.message}` }
    }
  }

  async function clearLeadStatusSubscription(userId) {
    const patch = { updated_at: new Date().toISOString() }
    for (const col of LEAD_STATUS_COLUMNS) patch[col] = null
    await supabase.from('communication_settings').update(patch).eq('user_id', userId)
  }

  // ══════════════════════════════════════
  // Inbound /webhooks subscription helpers — PR-2.
  // Registers a CrmWebhookSubscription pointing at the older
  // /api/integrations/leadbridge/webhooks endpoint so events arrive
  // with a verifiable HMAC signature. Same shape as registerLeadStatus
  // above — the /webhooks vs /lead-status distinction is just two
  // separate subscriptions per user.
  //
  // Failure must NOT break /connect: existing users keep working with
  // unsigned events until the LB_INBOUND_HMAC_REQUIRED flag is flipped.
  // ══════════════════════════════════════
  async function registerInboundSubscription(userId, lbToken) {
    try {
      const webhookUrl = `${sfPublicBaseUrl()}${SF_INBOUND_WEBHOOK_PATH}`
      const subRes = await lbRequest('POST', LB_LEAD_STATUS_SUBSCRIBE_PATH, lbToken, {
        name: 'Service Flow inbound',
        webhookUrl,
        events: INBOUND_EVENT_TYPES,
        metadata: {
          sf_instance: process.env.SF_INSTANCE || 'sf-prod',
          purpose: 'inbound-thread-events',
        },
      })

      const body = subRes?.data || {}
      const sub = body.subscription || body
      if (!body.success && !sub?.id) {
        return { registered: false, reason: `bad_response: ${JSON.stringify(body).slice(0, 200)}` }
      }
      if (!sub?.secret) {
        return { registered: false, reason: 'no_secret_returned' }
      }

      const encryptedSecret = encryptIntegrationSecret(sub.secret)
      const registeredAt = new Date().toISOString()

      const { error: upErr } = await supabase.from('communication_settings').update({
        leadbridge_inbound_subscription_id: sub.id,
        leadbridge_inbound_encrypted_secret: encryptedSecret,
        leadbridge_inbound_secret_key_version: currentEncKeyVersion(),
        leadbridge_inbound_webhook_url: sub.webhookUrl || webhookUrl,
        leadbridge_inbound_events: sub.events || INBOUND_EVENT_TYPES,
        leadbridge_inbound_registered_at: registeredAt,
        updated_at: new Date().toISOString(),
      }).eq('user_id', userId)
      if (upErr) return { registered: false, reason: `db_update_failed: ${upErr.message}` }

      return {
        registered: true,
        subscriptionId: sub.id,
        registeredAt,
        webhookUrl: sub.webhookUrl || webhookUrl,
        events: sub.events || INBOUND_EVENT_TYPES,
      }
    } catch (e) {
      return { registered: false, reason: `subscribe_error: ${e.response?.status || ''} ${e.message}` }
    }
  }

  async function clearInboundSubscription(userId) {
    const patch = { updated_at: new Date().toISOString() }
    for (const col of INBOUND_COLUMNS) patch[col] = null
    await supabase.from('communication_settings').update(patch).eq('user_id', userId)
  }

  async function buildIntegrationStatus(userId) {
    const settings = await getLbSettings(userId)
    const connected = Boolean(settings?.leadbridge_connected)
    if (!connected) {
      return {
        leadbridge_connected: false,
        direction_inbound: { active: false, accounts: 0 },
        direction_outbound: { active: false },
        direction_lead_status: { active: false },
        reconnect_required: false,
      }
    }

    const { count: accountCount } = await supabase
      .from('communication_provider_accounts')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId).eq('provider', 'leadbridge').eq('status', 'active')

    const { data: subRow } = await supabase
      .from('communication_settings')
      .select([
        'leadbridge_outbound_subscription_id',
        'leadbridge_outbound_registered_at',
        'leadbridge_outbound_last_event_at',
        'leadbridge_lead_status_subscription_id',
        'leadbridge_lead_status_registered_at',
        'leadbridge_lead_status_last_event_at',
        'leadbridge_inbound_subscription_id',
        'leadbridge_inbound_registered_at',
        'leadbridge_inbound_last_event_at',
      ].join(','))
      .eq('user_id', userId).maybeSingle()

    const outboundActive = Boolean(subRow?.leadbridge_outbound_subscription_id)
    const leadStatusActive = Boolean(subRow?.leadbridge_lead_status_subscription_id)
    const inboundSubActive = Boolean(subRow?.leadbridge_inbound_subscription_id)

    // Backlog + deferral signal — drives the "reconnect required" flag
    // when events are piling up because the user has not re-registered
    // outbound since Phase 6 rollout.
    const { count: deferredCount } = await supabase
      .from('leadbridge_outbound_events')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId).eq('state', 'pending').eq('defer_reason', 'no_outbound_subscription')

    const { count: backlogCount } = await supabase
      .from('leadbridge_outbound_events')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId).eq('state', 'pending')

    return {
      leadbridge_connected: true,
      direction_inbound: {
        active: true,
        accounts: accountCount || 0,
        // PR-2: per-user subscription that gives us a verifiable HMAC on
        // inbound /webhooks deliveries. Falsey when migration 037 hasn't
        // been backfilled yet — flag enforcement is unsafe until true.
        subscription: {
          active: inboundSubActive,
          subscription_id: subRow?.leadbridge_inbound_subscription_id || null,
          registered_at: subRow?.leadbridge_inbound_registered_at || null,
          last_event_at: subRow?.leadbridge_inbound_last_event_at || null,
        },
      },
      direction_outbound: {
        active: outboundActive,
        subscription_id: subRow?.leadbridge_outbound_subscription_id || null,
        registered_at: subRow?.leadbridge_outbound_registered_at || null,
        last_event_at: subRow?.leadbridge_outbound_last_event_at || null,
        backlog: backlogCount || 0,
      },
      direction_lead_status: {
        active: leadStatusActive,
        subscription_id: subRow?.leadbridge_lead_status_subscription_id || null,
        registered_at: subRow?.leadbridge_lead_status_registered_at || null,
        last_event_at: subRow?.leadbridge_lead_status_last_event_at || null,
      },
      reconnect_required: !outboundActive || !leadStatusActive || !inboundSubActive || (deferredCount || 0) > 0,
    }
  }

  // ══════════════════════════════════════
  // GET /status — Connection status
  // ══════════════════════════════════════
  router.get('/status', authenticateToken, async (req, res) => {
    try {
      const settings = await getLbSettings(req.user.userId)
      if (!settings?.leadbridge_connected) {
        return res.json({ connected: false, accounts: [] })
      }

      const { data: accounts } = await supabase.from('communication_provider_accounts')
        .select('*').eq('user_id', req.user.userId).eq('provider', 'leadbridge').eq('status', 'active')

      res.json({
        connected: true,
        connectedAt: settings.leadbridge_connected_at,
        accounts: (accounts || []).map(a => ({
          id: a.id,
          channel: a.channel,
          displayName: a.display_name,
          externalAccountId: a.external_account_id,
          externalBusinessId: a.external_business_id,
          lastSyncedAt: a.last_synced_at,
          webhookStatus: a.webhook_status,
        })),
      })
    } catch (error) {
      res.status(500).json({ error: 'Failed to fetch LeadBridge status' })
    }
  })

  // ══════════════════════════════════════
  // GET /accounts — List connected accounts
  // ══════════════════════════════════════
  router.get('/accounts', authenticateToken, async (req, res) => {
    try {
      const { data } = await supabase.from('communication_provider_accounts')
        .select('*').eq('user_id', req.user.userId).eq('provider', 'leadbridge')
      res.json({ accounts: data || [] })
    } catch (error) {
      res.status(500).json({ error: 'Failed to fetch accounts' })
    }
  })

  // ══════════════════════════════════════
  // DELETE /disconnect — Disconnect LeadBridge
  // ══════════════════════════════════════
  router.delete('/disconnect', authenticateToken, async (req, res) => {
    try {
      const userId = req.user.userId

      // S4 — Orchestration disconnect first.
      // performDisconnect snapshots the webhook config, enqueues a
      // `connection.revoked` event with that snapshot, revokes
      // credentials, then clears the orchestration webhook fields.
      // Runs in this order so the drainer can deliver the revoked
      // event using the captured config even after the settings row
      // is cleared.
      let orchestrationDisconnect = null
      try {
        const orchRes = await lbOrchHandshake.performDisconnect(supabase, {
          userId,
          actor:  'user',
          reason: 'user_initiated',
          logger,
        })
        orchestrationDisconnect = {
          revoked_count:  orchRes.revoked_count || 0,
          event_id:       orchRes.event_id || null,
          event_enqueued: !!orchRes.event_enqueued,
        }
      } catch (e) {
        logger.warn(`[LB] /disconnect orchestration teardown failed user=${userId}: ${e.message}`)
        orchestrationDisconnect = { error: 'orchestration_teardown_failed' }
      }

      // Deactivate provider accounts (existing LB integration teardown).
      await supabase.from('communication_provider_accounts')
        .update({ status: 'disconnected', updated_at: new Date().toISOString() })
        .eq('user_id', userId).eq('provider', 'leadbridge')

      // Clear settings — BOTH directions of the integration. Any
      // outbox rows still in 'pending' for this user are left alone:
      // the drainer will keep deferring them with
      // defer_reason='no_outbound_subscription' on the long backoff
      // until the user reconnects (or the per-row DLQ cap fires).
      // (performDisconnect above already cleared the orchestration
      // webhook fields + lb_orchestration_enabled_at + leadbridge_connected.
      // This UPDATE clears the legacy subscription columns.)
      const patch = {
        leadbridge_connected: false,
        leadbridge_integration_token: null,
        leadbridge_user_id: null,
        updated_at: new Date().toISOString(),
      }
      for (const col of OUTBOUND_COLUMNS) patch[col] = null
      for (const col of LEAD_STATUS_COLUMNS) patch[col] = null
      for (const col of INBOUND_COLUMNS) patch[col] = null
      await supabase.from('communication_settings').update(patch).eq('user_id', userId)

      logger.log(`[LB] Disconnected for user ${userId} (all directions cleared, orch=${JSON.stringify(orchestrationDisconnect)})`)
      res.json({
        success: true,
        direction_inbound: { active: false, accounts: 0, subscription: { active: false } },
        direction_outbound: { active: false },
        direction_lead_status: { active: false },
        orchestration: orchestrationDisconnect,
      })
    } catch (error) {
      res.status(500).json({ error: 'Failed to disconnect LeadBridge' })
    }
  })

  // ══════════════════════════════════════
  // POST /reconnect — re-register outbound subscription without full
  // disconnect/connect. Rotates the HMAC secret (LB issues a new one).
  // See §2c of the plan.
  // ══════════════════════════════════════
  router.post('/reconnect', authenticateToken, async (req, res) => {
    try {
      const userId = req.user.userId
      const settings = await getLbSettings(userId)
      if (!settings?.leadbridge_connected || !settings.leadbridge_integration_token) {
        return res.status(400).json({ error: 'LeadBridge not connected — run /connect first' })
      }
      const lbToken = settings.leadbridge_integration_token
      const outbound = await registerOutboundSubscription(userId, lbToken)
      // Lead-status + inbound: rotate alongside outbound so a single
      // reconnect refreshes ALL THREE HMAC secrets. We don't fail the
      // request if only lead-status / inbound fails — outbound is the
      // higher-priority leg. The PR-2 inbound subscription is the
      // operator-driven backfill path: existing users invoke /reconnect
      // to populate leadbridge_inbound_* before LB_INBOUND_HMAC_REQUIRED
      // can be flipped on.
      const leadStatus = await registerLeadStatusSubscription(userId, lbToken)
      const inbound = await registerInboundSubscription(userId, lbToken)

      if (!outbound.registered) {
        return res.status(502).json({
          error: 'Failed to register outbound subscription',
          reason: outbound.reason,
          lead_status_reason: leadStatus.registered ? null : leadStatus.reason,
          inbound_reason: inbound.registered ? null : inbound.reason,
        })
      }
      res.json({
        success: true,
        direction_outbound: {
          active: true,
          subscription_id: outbound.subscriptionId,
          registered_at: outbound.registeredAt,
        },
        direction_lead_status: {
          active: leadStatus.registered,
          subscription_id: leadStatus.subscriptionId || null,
          registered_at: leadStatus.registeredAt || null,
          error: leadStatus.registered ? null : leadStatus.reason,
        },
        direction_inbound_subscription: {
          active: inbound.registered,
          subscription_id: inbound.subscriptionId || null,
          registered_at: inbound.registeredAt || null,
          webhook_url: inbound.webhookUrl || null,
          error: inbound.registered ? null : inbound.reason,
        },
      })
    } catch (error) {
      logger.error('[LB] Reconnect error:', error.message)
      res.status(500).json({ error: 'Failed to reconnect LeadBridge' })
    }
  })

  // ══════════════════════════════════════
  // GET / — integration status (both directions).
  //
  // Mounted at /api/integrations/leadbridge, so this responds to
  // GET /api/integrations/leadbridge. Response payload follows §2e
  // of the plan so the UI can render reconnect CTAs / backlogs.
  // ══════════════════════════════════════
  router.get('/', authenticateToken, async (req, res) => {
    try {
      const status = await buildIntegrationStatus(req.user.userId)
      res.json(status)
    } catch (error) {
      logger.error('[LB] Integration status error:', error.message)
      res.status(500).json({ error: 'Failed to fetch integration status' })
    }
  })

  // ══════════════════════════════════════
  // GET /linkage-health — operator-facing proof the LB↔SF lifecycle
  // chain is wired. Returns the eight numbers the audit doc calls out:
  //   - lb-origin leads total / linked / converted
  //   - lb-linked jobs / missing-linkage-with-customer / recoverable
  //   - outbound queue (pending/sent/dlq/skipped_unmapped/last_event_at)
  //   - in-process linkage counters (jobs_created_with_lb_linkage etc.)
  //
  // Read-only. Tenant-scoped via authenticateToken → req.user.userId.
  // ══════════════════════════════════════
  router.get('/linkage-health', authenticateToken, async (req, res) => {
    try {
      const health = await getLinkageHealth(supabase, req.user.userId)
      res.json(health)
    } catch (error) {
      logger.error('[LB] linkage-health error:', error.message)
      res.status(500).json({ error: 'Failed to fetch linkage health' })
    }
  })

  // ══════════════════════════════════════
  // Phase 1.5 — semantic observability
  //
  // GET /semantic-summary
  //   Tenant-wide diagnostic showing attribution / operational lifecycle /
  //   LB conversation as separate concepts. READ-ONLY. No LB API calls.
  //   No mutations. Cross-domain comparison counts (cross_domain_difference,
  //   not_applicable_to_lb, marketplace_only_lead) require a live LB pull
  //   and are surfaced via /sync?mode=dryRun instead.
  //
  // GET /entity/:type/:id/semantic-state
  //   Per-entity diagnostic — type ∈ {job, lead, customer}. Returns the
  //   classification, SF/ZB/LB state, and whether the entity should sync
  //   to LB. No mutations. No outbound events.
  // ══════════════════════════════════════
  router.get('/semantic-summary', authenticateToken, async (req, res) => {
    try {
      const summary = await buildSemanticSummary(supabase, req.user.userId)
      res.json(summary)
    } catch (error) {
      logger.error('[LB] semantic-summary error:', error.message)
      res.status(500).json({ error: 'Failed to build semantic summary' })
    }
  })

  router.get('/entity/:type/:id/semantic-state', authenticateToken, async (req, res) => {
    try {
      const { type, id } = req.params
      if (!['job', 'lead', 'customer'].includes(type)) {
        return res.status(400).json({ error: `type must be one of job|lead|customer, got '${type}'` })
      }
      const numericId = Number(id)
      if (!Number.isFinite(numericId) || numericId <= 0) {
        return res.status(400).json({ error: `id must be a positive integer, got '${id}'` })
      }
      const state = await buildEntitySemanticState(supabase, req.user.userId, type, numericId)
      if (!state.found) return res.status(404).json({ error: `${type} ${id} not found`, ...state })
      res.json(state)
    } catch (error) {
      logger.error('[LB] entity semantic-state error:', error.message)
      res.status(500).json({ error: 'Failed to build entity semantic state' })
    }
  })

  // ══════════════════════════════════════
  // Phase 2B — LB orchestration endpoints (additive, feature-flagged)
  //
  // S2: each route runs auth dispatcher (user JWT or sfo_v1 token) then
  // layered enablement (env override or connection-state + live cred).
  // With zero credentials and empty env, behavior is identical to today
  // (valid user JWT → 403 orchestration_not_enabled_for_tenant).
  // Old sync/reconcile flows are completely untouched.
  // ══════════════════════════════════════
  const orchAvailabilityHandler = makeAvailabilityHandler({ supabase, logger })
  const orchBookingRequestHandler = makeBookingRequestHandler({
    supabase, logger, setCustomerAcquisitionIfMissing: _setCustomerAcquisitionIfMissing2B,
  })
  const orchBookingCancelHandler = makeBookingCancelHandler({
    supabase, logger,
    updateJobStatus: (args) => _updateJobStatus2B(supabase, args),
  })
  const orchHandoffHandler = makeHandoffHandler({ supabase, logger })

  const orchAuthDispatcher = makeOrchestrationAuthDispatcher({
    authenticateToken, supabase, logger,
  })
  const layeredRequireOrchestrationEnabled = makeRequireOrchestrationEnabled({ supabase })

  router.get('/orchestration/availability',
    orchAuthDispatcher, layeredRequireOrchestrationEnabled, orchAvailabilityHandler)
  router.post('/orchestration/booking-request',
    orchAuthDispatcher, layeredRequireOrchestrationEnabled, orchBookingRequestHandler)
  router.post('/orchestration/booking-cancel',
    orchAuthDispatcher, layeredRequireOrchestrationEnabled, orchBookingCancelHandler)
  router.post('/orchestration/handoff',
    orchAuthDispatcher, layeredRequireOrchestrationEnabled, orchHandoffHandler)

  // ══════════════════════════════════════
  // POST /orchestration/match-candidates
  // GET  /orchestration/job-status
  // POST /orchestration/attach-lb-link
  //
  // LB-initiated historical lead link (migration 060). Lets LB find an
  // existing SF customer/job that matches a historical LB lead and
  // attach LB identifiers to it without overwriting in flight.
  //
  // All three use the orchestration bearer dispatcher + layered
  // enablement, same as the other LB-callable routes.
  // ══════════════════════════════════════
  router.post('/orchestration/match-candidates',
    orchAuthDispatcher, layeredRequireOrchestrationEnabled,
    async (req, res) => {
      if (!req.user || req.user.userId == null) {
        return res.status(401).json({ error: 'invalid_orchestration_token' })
      }
      const body = req.body || {}
      try {
        const out = await lbLeadLinkMatcher.findMatchCandidates(supabase, {
          userId: req.user.userId,
          input: {
            lb_lead_id:             body.lb_lead_id             || null,
            lb_external_request_id: body.lb_external_request_id || null,
            lb_channel:             body.lb_channel             || null,
            lb_business_id:         body.lb_business_id         || null,
            customer_phone:         body.customer_phone         || null,
            customer_email:         body.customer_email         || null,
            customer_name:          body.customer_name          || null,
            lead_created_at:        body.lead_created_at        || null,
          },
        })
        // Single-line audit log, no PII (only counts + the LB identifiers
        // we received, which are LB-internal not customer PII).
        logger.log(`[lb-link/match] tenant=${req.user.userId} lb_lead=${body.lb_lead_id || '-'} candidates=${out.match_count}`)
        return res.json({ ok: true, ...out })
      } catch (e) {
        logger.error(`[lb-link/match] tenant=${req.user.userId} error: ${e && e.message}`)
        return res.status(500).json({ ok: false, error: 'internal_error' })
      }
    })

  router.get('/orchestration/job-status',
    orchAuthDispatcher, layeredRequireOrchestrationEnabled,
    async (req, res) => {
      if (!req.user || req.user.userId == null) {
        return res.status(401).json({ error: 'invalid_orchestration_token' })
      }
      const sfJobIdRaw = req.query.sf_job_id
      const extReqId   = req.query.external_request_id
      if (!sfJobIdRaw && !extReqId) {
        return res.status(400).json({ error: 'invalid_arguments', detail: 'sf_job_id or external_request_id required' })
      }

      try {
        let q = supabase.from('jobs')
          .select('id, user_id, status, payment_status, payment_date, scheduled_date, total_amount, invoice_amount, lb_external_request_id, lb_channel, lb_business_id, lb_lead_id, last_status_changed_at, created_at')
          .eq('user_id', req.user.userId)
          .limit(1)
        if (sfJobIdRaw) q = q.eq('id', sfJobIdRaw)
        else            q = q.eq('lb_external_request_id', extReqId)

        const { data: job, error } = await q.maybeSingle()
        if (error)  return res.status(503).json({ error: 'db_error' })
        if (!job)   return res.status(404).json({ error: 'job_not_found' })

        return res.json({
          ok: true,
          sf_job_id:               job.id,
          lb_external_request_id:  job.lb_external_request_id || null,
          lb_channel:              job.lb_channel             || null,
          lb_business_id:          job.lb_business_id         || null,
          lb_lead_id:              job.lb_lead_id             || null,
          status:                  job.status,
          payment_status:          job.payment_status         || null,
          payment_date:            job.payment_date           || null,
          scheduled_date:          job.scheduled_date         || null,
          amount:                  job.invoice_amount != null ? Number(job.invoice_amount)
                                   : job.total_amount   != null ? Number(job.total_amount)
                                   : null,
          last_status_changed_at:  job.last_status_changed_at || null,
        })
      } catch (e) {
        logger.error(`[lb-link/status] tenant=${req.user.userId} error: ${e && e.message}`)
        return res.status(500).json({ error: 'internal_error' })
      }
    })

  router.post('/orchestration/attach-lb-link',
    orchAuthDispatcher, layeredRequireOrchestrationEnabled,
    async (req, res) => {
      if (!req.user || req.user.userId == null) {
        return res.status(401).json({ error: 'invalid_orchestration_token' })
      }
      const body = req.body || {}
      try {
        const out = await lbLeadLinkAttacher.attachLbLink(supabase, {
          userId: req.user.userId,
          input: {
            sf_job_id:              body.sf_job_id,
            lb_external_request_id: body.lb_external_request_id,
            lb_channel:             body.lb_channel,
            lb_business_id:         body.lb_business_id || null,
            lb_lead_id:             body.lb_lead_id || null,
            match_confidence:       body.match_confidence || null,
            match_signals:          Array.isArray(body.match_signals) ? body.match_signals : [],
            force_overwrite:        body.force_overwrite === true,
          },
        })
        if (!out.ok) {
          logger.warn(`[lb-link/attach] tenant=${req.user.userId} sf_job=${body.sf_job_id || '-'} error=${out.error} status=${out.status}`)
          return res.status(out.status || 400).json(out)
        }
        logger.log(`[lb-link/attach] tenant=${req.user.userId} sf_job=${out.sf_job_id} action=${out.action} synthetic_event=${out.synthetic_status_event_id} enqueued=${out.synthetic_status_event_enqueued}`)
        return res.json(out)
      } catch (e) {
        logger.error(`[lb-link/attach] tenant=${req.user.userId} error: ${e && e.message}`)
        return res.status(500).json({ ok: false, error: 'internal_error' })
      }
    })

  // ══════════════════════════════════════
  // POST /orchestration/bulk-reconcile
  //
  // Automatic historical reconciliation. LB sends a batch of leads (up
  // to 50 per call). SF runs the matcher per-lead; for any lead with
  // exactly one unambiguous high-confidence candidate, SF auto-attaches
  // (writes audit row, updates the SF job, enqueues synthetic
  // job.status_changed). Ambiguous / low-confidence / multi-candidate /
  // already-linked-to-different-id leads come back as `needs_review`
  // with the candidate list so LB can drive a manual attach.
  //
  // Body:
  //   { leads: [{ lb_lead_id, lb_external_request_id, lb_channel,
  //               lb_business_id, customer_phone, customer_email,
  //               customer_name, lead_created_at }, …],
  //     dry_run: false }
  //
  // Response: per-lead { outcome: 'auto_attached' | 'needs_review' |
  //                                 'no_match' | 'auto_attach_preview' |
  //                                 'error' } plus a roll-up summary.
  // ══════════════════════════════════════
  router.post('/orchestration/bulk-reconcile',
    orchAuthDispatcher, layeredRequireOrchestrationEnabled,
    async (req, res) => {
      if (!req.user || req.user.userId == null) {
        return res.status(401).json({ error: 'invalid_orchestration_token' })
      }
      const body = req.body || {}
      const leads = Array.isArray(body.leads) ? body.leads : null
      if (!leads) {
        return res.status(400).json({ ok: false, error: 'invalid_arguments', detail: 'leads array required' })
      }
      try {
        const out = await lbLeadLinkBulk.reconcileBatch(supabase, {
          userId: req.user.userId,
          leads,
          dryRun: body.dry_run === true,
          logger,
        })
        if (!out.ok) {
          return res.status(out.status || 400).json(out)
        }
        logger.log(`[lb-bulk-reconcile] tenant=${req.user.userId} dry_run=${out.dry_run} total=${out.summary.total} auto_attached=${out.summary.auto_attached} preview=${out.summary.auto_attach_preview} needs_review=${out.summary.needs_review} no_match=${out.summary.no_match} error=${out.summary.error}`)
        return res.json(out)
      } catch (e) {
        logger.error(`[lb-bulk-reconcile] tenant=${req.user.userId} error: ${e && e.message}`)
        return res.status(500).json({ ok: false, error: 'internal_error' })
      }
    })

  // ══════════════════════════════════════
  // POST /orchestration/provision-retry — Tenant-initiated retry for the
  // direct-provision chain.
  //
  // Use case: /connect's legacy lead-sync committed but the orchestration
  // provisioning step (verify-credentials or LB /provision) failed
  // (e.g. transient LB outage). UI shows a Retry banner; clicking it
  // re-collects email/password and hits this endpoint.
  //
  // Auth: tenant Bearer JWT (NOT the orchestration bearer — there's no
  // credential yet to authenticate with).
  //
  // Preconditions: tenant must already have leadbridge_connected=true
  // (i.e. legacy connect succeeded). If not, return 409 — they should
  // hit /connect, not retry.
  //
  // Behavior: exactly the same call as /connect's orchestration step,
  // factored out for retry. Password is forwarded once to LB, never
  // logged.
  // ══════════════════════════════════════
  router.post('/orchestration/provision-retry', authenticateToken, async (req, res) => {
    try {
      const userId = req.user.userId
      const { email, password } = req.body || {}
      if (!email || !password) return res.status(400).json({ error: 'email_and_password_required' })

      const { data: setting } = await supabase
        .from('communication_settings')
        .select('leadbridge_connected,lb_orchestration_enabled_at')
        .eq('user_id', userId)
        .maybeSingle()
      if (!setting || !setting.leadbridge_connected) {
        return res.status(409).json({ error: 'not_connected', message: 'Run /connect first.' })
      }
      if (setting.lb_orchestration_enabled_at) {
        return res.status(409).json({ error: 'already_provisioned' })
      }

      const { data: sfUser } = await supabase
        .from('users').select('first_name,last_name,email,business_name').eq('id', userId).maybeSingle()
      const sfTenantName = sfUser
        ? (sfUser.business_name || [sfUser.first_name, sfUser.last_name].filter(Boolean).join(' ') || sfUser.email)
        : null
      const sfTenantEmail = sfUser ? sfUser.email : null

      const dp = await lbOrchDirectProvision.performDirectProvision(supabase, {
        tenantId:    userId,
        lbEmail:     email,
        lbPassword:  password,
        tenantName:  sfTenantName,
        tenantEmail: sfTenantEmail,
        createdBy:   'provision_retry',
        logger,
      })

      if (dp.ok) {
        return res.json({
          ok: true,
          orchestration: {
            status:           'connected',
            credential_id:    dp.credential.credentialId,
            token_prefix:     dp.credential.tokenPrefix,
            kid:              dp.credential.kid,
            issued_at:        dp.credential.issuedAt,
            expires_at:       dp.credential.expiresAt,
            lb_account_id:    dp.lbAccountId,
            lb_account_name:  dp.lbAccountName,
            subscription_id:  dp.subscriptionId,
            event_id:         dp.event_id,
            event_enqueued:   dp.event_enqueued,
          },
        })
      }
      return res.status(422).json({
        ok: false,
        orchestration: {
          status:            'failed',
          reason:            dp.reason,
          step:              dp.step,
          http_status:       dp.status || null,
          error_description: dp.errorDescription || null,
        },
      })
    } catch (e) {
      logger.error(`[LB] /orchestration/provision-retry threw: ${e && e.message}`)
      return res.status(500).json({ error: 'unexpected_error' })
    }
  })

  // ══════════════════════════════════════
  // R1B — LB-facing pull-style credential refresh.
  //
  // POST /api/integrations/leadbridge/orchestration/credentials/refresh
  // Authorization: Bearer sfo_v1.<current orchestration token>
  // body: {} (optional `reason`)
  //
  // Authenticates via the orchestration bearer (same dispatcher as the
  // other orchestration routes; user JWT path NOT permitted — refresh
  // is exclusively LB-initiated). Layered enablement also enforced so
  // a disconnected tenant can't refresh.
  //
  // Behavior:
  //   - bearer is active AND needs_refresh_at IS NOT NULL → rotate
  //     atomically, return new plaintext token ONCE
  //   - bearer is active AND needs_refresh_at IS NULL → 409 no_pending_rotation
  //   - bearer is rotating → 409 already_rotated_this_cycle
  //   - bearer is revoked → 401 credential_revoked (handled by auth middleware)
  //   - connection cleared (leadbridge_connected=false) → 410 connection_revoked
  //   - signing key missing → 503
  //   - DB error → 503
  // ══════════════════════════════════════
  router.post('/orchestration/credentials/refresh',
    orchAuthDispatcher,
    layeredRequireOrchestrationEnabled,
    async (req, res) => {
      // Auth middleware already verified the bearer. req.user.cred_id
      // is the credential id LB is presenting. We restrict refresh to
      // the orchestration-token auth path only — a user JWT would have
      // populated req.user.userId but not cred_id (or with a different
      // source tag); the explicit source check below makes that path 401.
      if (!req.user || req.user.source !== 'lb_orchestration_token') {
        return res.status(401).json({
          error: 'invalid_orchestration_token',
          message: 'Refresh requires an orchestration bearer token (sfo_v1.*).',
        })
      }
      if (req.user.cred_id == null) {
        return res.status(401).json({ error: 'invalid_orchestration_token' })
      }

      const reason = (req.body && typeof req.body.reason === 'string') ? req.body.reason : 'lb_initiated'
      const allowedReasons = ['scheduled', 'rotation_event', 'pre_expiry', 'operator_request', 'lb_initiated']
      if (!allowedReasons.includes(reason)) {
        return res.status(400).json({ error: 'invalid_reason', allowed: allowedReasons })
      }

      try {
        const out = await orchPerformRefresh(supabase, {
          userId:             req.user.userId,
          bearerCredentialId: req.user.cred_id,
          reason,
          logger,
        })
        if (!out.ok) {
          if (out.reason === 'no_pending_rotation')         return res.status(409).json({ error: 'no_pending_rotation' })
          if (out.reason === 'already_rotated_this_cycle')  return res.status(409).json({ error: 'already_rotated_this_cycle' })
          if (out.reason === 'connection_revoked')          return res.status(410).json({ error: 'connection_revoked' })
          if (out.reason === 'credential_revoked')          return res.status(401).json({ error: 'credential_revoked' })
          if (out.reason === 'unknown_credential')          return res.status(401).json({ error: 'invalid_orchestration_token' })
          if (out.reason && out.reason.startsWith('mint_failed:')) {
            if (out.reason.includes('signing_key_not_configured')) {
              return res.status(503).json({ error: 'signing_key_not_configured' })
            }
            return res.status(503).json({ error: 'service_unavailable', reason: out.reason })
          }
          if (out.reason === 'db_error' || out.reason === 'db_update_failed' || out.reason === 'db_lookup_failed') {
            return res.status(503).json({ error: 'service_unavailable' })
          }
          logger.error(`[orch-refresh] unknown reason user=${req.user.userId} bearer_cred=${req.user.cred_id} reason=${out.reason}`)
          return res.status(500).json({ error: 'internal_error', reason: out.reason })
        }

        // SUCCESS. Plaintext returned ONCE; never logged (only token_prefix).
        logger.log(`[orch-refresh] ok user=${req.user.userId} prev_cred=${out.rotation.previous_credential_id} new_prefix=${out.credential.token_prefix}`)
        return res.status(200).json({
          credential: out.credential,
          rotation:   out.rotation,
        })
      } catch (err) {
        logger.error(`[orch-refresh] threw: ${err && err.message}`)
        return res.status(500).json({ error: 'internal_error' })
      }
    })

  // ══════════════════════════════════════
  // S4 — OAuth-style provisioning (staging dark)
  //
  // GET  /authorize       — consent screen. Requires SF user JWT.
  //                          Validates client_id + redirect_uri.
  //                          On approve → 302 to redirect_uri with code.
  // POST /oauth/exchange  — server-to-server exchange. Requires
  //                          client_id + client_secret. Atomically:
  //                          consumes code, mints credential, persists
  //                          webhook, opens enablement gate.
  // POST /oauth/consent   — approve action from the consent screen
  //                          (browser form POST). Identical auth as
  //                          /authorize.
  //
  // No tenant self-service: the SF user must hold a valid SF JWT to
  // render /authorize. The browser flow eventually replaces this with
  // a session cookie + Vercel-rendered consent page, but for S4 the
  // server-rendered minimalist page is sufficient.
  // ══════════════════════════════════════

  // Minimal consent page renderer.
  function renderConsentPage({ clientId, redirectUri, state, scope, displayName, sfTenantId, sfTenantName, lbHost }) {
    const safeName  = String(displayName  || clientId).replace(/[<>'"&]/g, '_')
    const safeHost  = String(lbHost || '').replace(/[<>'"&]/g, '_')
    const safeState = String(state || '').replace(/[<>'"&]/g, '_')
    const formAction = '/api/integrations/leadbridge/oauth/consent'
    return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Authorize ${safeName}</title>
<style>body{font-family:system-ui,-apple-system,sans-serif;max-width:560px;margin:48px auto;padding:0 16px;color:#1f2937;}
h1{font-size:20px;margin:0 0 8px}h2{font-size:14px;color:#6b7280;font-weight:500;margin:0 0 24px}
.scope{background:#f3f4f6;padding:16px;border-radius:8px;margin:16px 0;font-size:14px;line-height:1.5}
button{padding:10px 16px;border-radius:6px;font-size:14px;cursor:pointer;border:1px solid transparent;margin-right:8px}
.approve{background:#1f2937;color:#fff}.cancel{background:#fff;color:#1f2937;border-color:#d1d5db}
.tenant{font-weight:600}.host{font-family:monospace;font-size:12px;color:#6b7280}</style>
</head><body>
<h1>Authorize ${safeName}</h1>
<h2>ServiceFlow tenant <span class="tenant">#${sfTenantId}</span>${sfTenantName ? ' &middot; ' + sfTenantName : ''}</h2>
<div class="scope"><strong>${safeName}</strong> will be able to:
<ul>
<li>Read your service catalog and availability</li>
<li>Request bookings on your behalf</li>
<li>Cancel bookings it has previously created</li>
<li>Receive operational lifecycle events for jobs it has booked</li>
</ul>
${safeName} <strong>cannot</strong> access your customers, payroll, financials, or jobs it has not booked.
Access expires after 90 days. You can revoke at any time from ServiceFlow Settings → Integrations.
${safeHost ? '<div>Webhook destination: <span class="host">' + safeHost + '</span></div>' : ''}
</div>
<form method="POST" action="${formAction}">
  <input type="hidden" name="client_id" value="${clientId}">
  <input type="hidden" name="redirect_uri" value="${redirectUri}">
  <input type="hidden" name="state" value="${safeState}">
  <input type="hidden" name="scope" value="${scope}">
  <input type="hidden" name="decision" value="approve">
  <button type="submit" class="approve">Approve</button>
  <button type="submit" name="decision" value="cancel" class="cancel">Cancel</button>
</form>
</body></html>`
  }

  // GET /authorize — browser consent screen.
  router.get('/authorize', authenticateToken, async (req, res) => {
    const clientId    = String(req.query.client_id || '')
    const redirectUri = String(req.query.redirect_uri || '')
    const state       = String(req.query.state || '')
    const scope       = String(req.query.scope || 'lb_orchestration')
    const responseType = String(req.query.response_type || 'code')

    if (!clientId)    return res.status(400).json({ error: 'invalid_request', error_description: 'client_id is required' })
    if (!redirectUri) return res.status(400).json({ error: 'invalid_request', error_description: 'redirect_uri is required' })
    if (responseType !== 'code') return res.status(400).json({ error: 'unsupported_response_type' })
    if (!state || state.length < 16) return res.status(400).json({ error: 'invalid_request', error_description: 'state must be at least 16 chars' })
    if (scope !== 'lb_orchestration') return res.status(400).json({ error: 'invalid_scope' })

    let client
    try {
      client = await lbOrchClients.lookupClient(supabase, clientId)
    } catch (e) {
      logger.error(`[orch-oauth] authorize lookup failed: ${e.message}`)
      return res.status(503).json({ error: 'service_unavailable' })
    }
    if (!client) return res.status(400).json({ error: 'invalid_client' })
    if (!lbOrchClients.verifyRedirectUri(client, redirectUri)) {
      return res.status(400).json({ error: 'invalid_redirect_uri' })
    }

    // Fetch tenant info for display.
    const { data: user } = await supabase.from('users').select('id,first_name,last_name,email').eq('id', req.user.userId).maybeSingle()
    const sfTenantName = user ? [user.first_name, user.last_name].filter(Boolean).join(' ') || user.email : null
    let lbHost = ''
    try { lbHost = new URL(redirectUri).host } catch (_) {}

    const html = renderConsentPage({
      clientId, redirectUri, state, scope,
      displayName: client.display_name,
      sfTenantId:   req.user.userId,
      sfTenantName,
      lbHost,
    })
    res.set('Content-Type', 'text/html; charset=utf-8').status(200).send(html)
  })

  // POST /oauth/consent — handle the form submission from /authorize.
  // Express needs urlencoded body parser; server.js mounts it globally.
  router.post('/oauth/consent', authenticateToken, async (req, res) => {
    const clientId    = String(req.body?.client_id || '')
    const redirectUri = String(req.body?.redirect_uri || '')
    const state       = String(req.body?.state || '')
    const scope       = String(req.body?.scope || 'lb_orchestration')
    const decision    = String(req.body?.decision || '')

    if (!clientId || !redirectUri) {
      return res.status(400).json({ error: 'invalid_request' })
    }
    if (decision !== 'approve') {
      const sep = redirectUri.includes('?') ? '&' : '?'
      return res.redirect(302, `${redirectUri}${sep}error=access_denied&error_description=user_declined&state=${encodeURIComponent(state)}`)
    }

    let client
    try {
      client = await lbOrchClients.lookupClient(supabase, clientId)
    } catch (e) {
      logger.error(`[orch-oauth] consent client lookup failed: ${e.message}`)
      return res.status(503).json({ error: 'service_unavailable' })
    }
    if (!client) return res.status(400).json({ error: 'invalid_client' })
    if (!lbOrchClients.verifyRedirectUri(client, redirectUri)) {
      return res.status(400).json({ error: 'invalid_redirect_uri' })
    }
    if (scope !== 'lb_orchestration') return res.status(400).json({ error: 'invalid_scope' })

    const issued = await lbOrchOauthCodes.issueCode(supabase, {
      clientId, redirectUri, userId: req.user.userId, scope, state,
    })
    if (!issued.ok) {
      logger.error(`[orch-oauth] code issue failed: ${issued.reason} ${issued.dbError || ''}`)
      return res.status(503).json({ error: 'service_unavailable' })
    }

    // Lookup tenant display name for redirect convenience.
    const { data: user } = await supabase.from('users').select('first_name,last_name,email').eq('id', req.user.userId).maybeSingle()
    const sfTenantName = user ? [user.first_name, user.last_name].filter(Boolean).join(' ') || user.email : ''
    const sfBaseUrl = process.env.SF_PUBLIC_BASE_URL || ''

    const sep = redirectUri.includes('?') ? '&' : '?'
    const params = new URLSearchParams({
      code: issued.code,
      state,
      sf_tenant_id: String(req.user.userId),
    })
    if (sfTenantName) params.set('sf_tenant_name', sfTenantName)
    if (sfBaseUrl)    params.set('sf_base_url', sfBaseUrl)
    logger.log(`[orch-oauth] consent approve user=${req.user.userId} client=${clientId} code_prefix=${issued.code.slice(0, 13)}`)
    return res.redirect(302, `${redirectUri}${sep}${params.toString()}`)
  })

  // POST /oauth/exchange — server-to-server exchange. NO SF user JWT
  // required (LB authenticates via client_id + client_secret).
  router.post('/oauth/exchange', async (req, res) => {
    const { client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri, webhook } = req.body || {}

    if (!clientId || !clientSecret || !code || !redirectUri) {
      return res.status(400).json({ error: 'invalid_request', error_description: 'client_id, client_secret, code, redirect_uri required' })
    }
    if (!webhook || typeof webhook !== 'object' || !webhook.url || !webhook.secret) {
      return res.status(400).json({ error: 'invalid_webhook', error_description: 'webhook.{url,secret} required' })
    }

    let client
    try {
      client = await lbOrchClients.lookupClient(supabase, clientId)
    } catch (e) {
      logger.error(`[orch-oauth] exchange client lookup failed: ${e.message}`)
      return res.status(503).json({ error: 'service_unavailable' })
    }
    if (!client) return res.status(401).json({ error: 'invalid_client' })
    if (!lbOrchClients.verifyClientSecret(client, clientSecret)) {
      logger.warn(`[orch-oauth] exchange bad secret client=${clientId}`)
      return res.status(401).json({ error: 'invalid_client' })
    }

    // Validate webhook BEFORE consuming the code so a malformed webhook
    // doesn't burn the user's single-use code.
    const urlCheck = lbOrchClients.verifyWebhookUrl(client, webhook.url)
    if (!urlCheck.ok) return res.status(400).json({ error: urlCheck.reason })
    const secretCheck = lbOrchClients.verifyWebhookSecret(webhook.secret)
    if (!secretCheck.ok) return res.status(400).json({ error: secretCheck.reason })

    // Consume code. Replay → 409 + preserve prior credential (refinement 2).
    const consumed = await lbOrchOauthCodes.consumeCode(supabase, { code, clientId, redirectUri })
    if (!consumed.ok) {
      if (consumed.reason === 'code_already_used') {
        logger.warn(`[orch-oauth] exchange replay client=${clientId} prior_cred=${consumed.issuedCredentialId || 'unknown'}`)
        return res.status(409).json({ error: 'code_already_used', prior_credential_id: consumed.issuedCredentialId || null })
      }
      if (consumed.reason === 'redirect_uri_mismatch') return res.status(400).json({ error: 'redirect_uri_mismatch' })
      if (consumed.reason === 'invalid_client_for_code') return res.status(400).json({ error: 'invalid_client_for_code' })
      if (consumed.reason === 'code_expired') return res.status(400).json({ error: 'code_expired' })
      if (consumed.reason === 'unknown_code') return res.status(400).json({ error: 'invalid_code' })
      return res.status(503).json({ error: 'service_unavailable', reason: consumed.reason })
    }

    // Perform handshake.
    const handshakeResult = await lbOrchHandshake.performHandshake(supabase, {
      userId:          consumed.row.user_id,
      webhookUrl:      webhook.url,
      webhookSecret:   webhook.secret,
      subscriptionId:  webhook.subscription_id || null,
      stateRef:        webhook.state_ref || null,
      createdBy:       `oauth_exchange:${clientId}`,
      logger,
    })

    if (!handshakeResult.ok) {
      logger.warn(`[orch-oauth] handshake failed user=${consumed.row.user_id} reason=${handshakeResult.reason} step=${handshakeResult.step}`)
      // Map handshake errors to HTTP.
      if (handshakeResult.reason === 'already_connected') {
        return res.status(409).json({ error: 'already_connected' })
      }
      if (handshakeResult.reason === 'communication_settings_not_found') {
        return res.status(404).json({ error: 'communication_settings_not_found' })
      }
      if (handshakeResult.reason === 'signing_key_not_configured') {
        return res.status(503).json({ error: 'signing_key_not_configured' })
      }
      return res.status(500).json({ error: 'handshake_failed', reason: handshakeResult.reason })
    }

    // Stamp credential id on the code (best-effort).
    await attachCredentialToCode(supabase, code, handshakeResult.credential.credentialId)

    // Get tenant info for the payload.
    const { data: user } = await supabase.from('users').select('id,first_name,last_name,email').eq('id', consumed.row.user_id).maybeSingle()
    const sfTenantName = user ? [user.first_name, user.last_name].filter(Boolean).join(' ') || user.email : null

    const payload = buildProvisioningPayload({
      tenant: {
        sf_tenant_id:    consumed.row.user_id,
        sf_tenant_name:  sfTenantName,
        sf_workspace_id: consumed.row.user_id,
      },
      credential: {
        token:         handshakeResult.credential.token,
        token_prefix:  handshakeResult.credential.tokenPrefix,
        kid:           handshakeResult.credential.kid,
        scope:         'lb_orchestration',
        issued_at:     handshakeResult.credential.issuedAt,
        expires_at:    handshakeResult.credential.expiresAt,
      },
      webhook: {
        url:             webhook.url,
        set_at:          handshakeResult.settings && handshakeResult.settings.lb_orchestration_webhook_set_at,
        subscription_id: webhook.subscription_id || null,
        state_ref:       webhook.state_ref || null,
      },
    })

    logger.log(`[orch-oauth] exchange ok user=${consumed.row.user_id} cred=${handshakeResult.credential.credentialId} prefix=${handshakeResult.credential.tokenPrefix} event=${handshakeResult.event_id}`)
    return res.status(200).json({
      connected: true,
      provisioning: payload,
    })
  })

  // ══════════════════════════════════════
  // POST /historical-sync — SF-driven historical lead sync
  //
  // Operator-triggered (tenant JWT).
  //
  // Two modes, switched by request body:
  //
  //   PREVIEW (dry_run:true, default if omitted)
  //     Returns matcher preview only. Never calls LB /link-leads-bulk,
  //     never writes to SF state. Same as Phase 1.
  //
  //   APPLY (dry_run:false + apply.expected_matches[])
  //     Re-validates operator-approved (lb_lead_id, sf_job_id) pairs
  //     against a fresh LB fetch + matcher, calls LB /link-leads-bulk,
  //     and attaches SF state only for LB-confirmed rows. Gated by:
  //       - SF_HISTORICAL_SYNC_APPLY_ENABLED env flag (default OFF)
  //       - JWT must carry workspace owner/admin role
  //       - active LB connection (orchestrator checks comm_settings)
  //       - per-tenant lock (migration 064 — row-based, TTL 5m)
  //
  // Mutation-impossibility for the preview path is structural: the
  // apply branch is unreachable without explicit dry_run:false AND
  // apply.expected_matches AND the feature flag.
  // ══════════════════════════════════════

  const APPLY_ENABLED_FLAG = 'SF_HISTORICAL_SYNC_APPLY_ENABLED'

  function isApplyEnabled() {
    const v = process.env[APPLY_ENABLED_FLAG]
    return v === 'true' || v === '1' || v === 'on'
  }

  function isWorkspaceOwnerOrAdmin(user) {
    const role = String((user && user.role) || '').toLowerCase()
    return role === 'account owner' || role === 'owner' || role === 'admin'
  }

  router.post('/historical-sync', authenticateToken, async (req, res) => {
    try {
      const userId = req.user.userId
      const body = req.body || {}

      // ── PREVIEW path (dry_run !== false) ──
      if (body.dry_run !== false) {
        const out = await sfHistoricalSyncOrchestrator.runHistoricalSync(supabase, {
          tenantId:      userId,
          maxLeads:      Number.isFinite(body.max_leads) ? body.max_leads : undefined,
          syncStatuses:  Array.isArray(body.sync_statuses) ? body.sync_statuses : undefined,
          status:        (typeof body.status === 'string' && body.status.length > 0) ? body.status : undefined,
          logger,
        })
        if (!out.ok) return res.status(out.status || 502).json(out)
        return res.json(out)
      }

      // ── APPLY path (dry_run === false) ──

      // Feature flag.
      if (!isApplyEnabled()) {
        logger.warn(`[sf-historical-apply] tenant=${userId} apply requested but feature flag disabled`)
        return res.status(503).json({ ok: false, error: 'apply_disabled', detail: 'Phase-2 apply is not enabled on this deployment' })
      }

      // Role check — workspace owner/admin only.
      if (!isWorkspaceOwnerOrAdmin(req.user)) {
        logger.warn(`[sf-historical-apply] tenant=${userId} apply denied: role=${req.user && req.user.role}`)
        return res.status(403).json({ ok: false, error: 'forbidden', detail: 'workspace owner or admin role required' })
      }

      // Validation — apply.expected_matches required.
      const apply = body.apply
      if (!apply || !Array.isArray(apply.expected_matches) || apply.expected_matches.length === 0) {
        return res.status(400).json({ ok: false, error: 'apply_matches_required', detail: 'apply.expected_matches[] required and non-empty when dry_run=false' })
      }

      const out = await sfHistoricalSyncOrchestrator.runHistoricalSyncApply(supabase, {
        tenantId:         userId,
        expectedMatches:  apply.expected_matches,
        requireNoDrift:   apply.require_no_drift !== false,    // default TRUE
        maxLeads:         Number.isFinite(body.max_leads) ? body.max_leads : undefined,
        syncStatuses:     Array.isArray(body.sync_statuses) ? body.sync_statuses : undefined,
        status:           (typeof body.status === 'string' && body.status.length > 0) ? body.status : undefined,
        logger,
      })

      if (!out.ok) return res.status(out.status || 502).json(out)
      return res.json(out)
    } catch (e) {
      logger.error(`[sf-historical-sync] tenant=${req.user?.userId || '-'} unexpected: ${e && e.message}`)
      return res.status(500).json({ ok: false, error: 'internal_error' })
    }
  })

  // ══════════════════════════════════════
  // POST /sync — Sync conversations from LB
  // ══════════════════════════════════════
  router.post('/sync', authenticateToken, async (req, res) => {
    try {
      const userId = req.user.userId
      const { accountId, limit } = req.body || {}
      // Reconcile / mode resolution. Defaults:
      //   reconcile=true   "Sync LeadBridge" now means bidirectional reconcile.
      //   mode             accepted values: 'dryRun' | 'apply' (default 'apply').
      //                    dryRun = run Phase 1 + Phase 2 enumeration but do NOT
      //                    enqueue outbound events.
      // Both ?mode= (query) and body.mode are honored; query wins.
      const modeRaw = String(req.query.mode || req.body?.mode || 'apply').toLowerCase()
      const dryRun = modeRaw === 'dryrun' || modeRaw === 'dry-run' || modeRaw === 'plan'
      const reconcile = req.body?.reconcile === false ? false : true
      // attribution recovery: opt-out via body.attribution=false (e.g. for
      // operators who want LB pull only). Defaults ON for the product
      // workflow.
      const attribution = req.body?.attribution === false ? false : true

      const settings = await getLbSettings(userId)
      if (!settings?.leadbridge_connected || !settings.leadbridge_integration_token) {
        return res.status(400).json({ error: 'LeadBridge not connected' })
      }

      if (syncProgress[userId]?.status === 'running') {
        return res.json({ started: false, message: 'Sync already in progress', progress: syncProgress[userId] })
      }

      // Start sync in background. Attribution + reconcile output lands in
      // syncProgress.{attribution_recovery,reconcile} once the background
      // job finishes. Clients poll GET /sync/progress.
      setImmediate(() => runLbSync(
        userId,
        settings.leadbridge_integration_token,
        accountId,
        parseInt(limit) || 0,
        { reconcile, dryRun, attribution }
      ))
      res.json({ started: true, mode: dryRun ? 'dryRun' : 'apply', reconcile, attribution })
    } catch (error) {
      res.status(500).json({ error: 'Failed to start sync' })
    }
  })

  // ══════════════════════════════════════
  // GET /sync/progress — Poll sync progress
  // ══════════════════════════════════════
  router.get('/sync/progress', authenticateToken, (req, res) => {
    const progress = syncProgress[req.user.userId] || { status: 'idle' }
    res.json(progress)
  })

  // ══════════════════════════════════════
  // POST /lead-status — Receive lead.status_changed from LB.
  //
  // Separate endpoint from /webhooks (which handles message/conversation
  // events) so HMAC-verified status events stay isolated from the
  // unverified message ingest path. Contract:
  //
  //   Headers:
  //     X-LB-Signature: hex(HMAC_SHA256(secret, `${ts}.${rawBody}`))
  //     X-LB-Timestamp: unix seconds
  //     X-LB-Event:     'lead.status_changed'
  //
  //   Body: CrmEventPayload (see geos-leadbridge crm-webhook.service.ts)
  //
  // Loop guard: writes go through `updateJobStatus({source:'leadbridge'})`
  // which `recordOutboundIfApplicable` then short-circuits with
  // `skipped_loop` so SF never echoes back to LB.
  //
  // No JWT auth — HMAC signature is the auth.
  // ══════════════════════════════════════
  router.post('/lead-status', async (req, res) => {
    const sigHeader = req.headers['x-lb-signature']
    const tsHeader = req.headers['x-lb-timestamp']
    const evtHeader = req.headers['x-lb-event']

    if (!sigHeader || !tsHeader) {
      return res.status(401).json({ error: 'missing_signature' })
    }

    const event = req.body
    if (!event || typeof event !== 'object') {
      return res.status(400).json({ error: 'invalid_body' })
    }
    if (event.event_type && evtHeader && event.event_type !== evtHeader) {
      return res.status(400).json({ error: 'header_body_event_type_mismatch' })
    }
    if (event.event_type !== 'lead.status_changed') {
      // Wrong event type — accept-and-ignore so LB doesn't retry.
      return res.status(200).json({ ok: true, ignored: 'unsupported_event_type' })
    }

    // Replay protection — reject timestamps too far from now.
    const tsNum = parseInt(tsHeader, 10)
    const nowSec = Math.floor(Date.now() / 1000)
    if (!Number.isFinite(tsNum) || Math.abs(nowSec - tsNum) > LEAD_STATUS_TS_TOLERANCE_S) {
      return res.status(401).json({ error: 'stale_timestamp' })
    }

    // Look up the SF user owning this subscription. The subscription_id
    // is an opaque string LB controls — we already stored it at register
    // time. Resolve from the optional metadata field LB stamps onto the
    // payload (see CrmWebhookSubscription handling) OR fall back to the
    // signature-verification scan: try every active subscription and
    // pick the one whose secret matches.
    //
    // We optimize for the common case (1 SF user → 1 subscription) by
    // first matching on `metadata.sigcore_workspace_id` if present,
    // then by external_business_id. If neither matches we fall back to
    // a scan-then-verify which is bounded because each user has at
    // most one lead-status subscription.
    let userRow = null
    try {
      const targetWorkspaceId = event.sigcore_workspace_id || null
      const targetBusinessId = event.external_business_id || null

      let q = supabase
        .from('communication_settings')
        .select([
          'user_id',
          'leadbridge_lead_status_subscription_id',
          'leadbridge_lead_status_encrypted_secret',
          'leadbridge_lead_status_secret_key_version',
        ].join(','))
        .not('leadbridge_lead_status_subscription_id', 'is', null)

      const { data: candidates } = await q
      if (!candidates || candidates.length === 0) {
        return res.status(404).json({ error: 'no_active_subscription' })
      }

      // Verify signature — only one candidate's secret can match. We
      // don't trust workspace/business IDs on the payload as auth
      // (those are unsigned hints).
      const rawBody = req.rawBody ? req.rawBody.toString('utf8') : JSON.stringify(req.body)

      for (const cand of candidates) {
        let secret
        try {
          secret = decryptIntegrationSecret(
            cand.leadbridge_lead_status_encrypted_secret,
            cand.leadbridge_lead_status_secret_key_version,
          )
        } catch (e) {
          logger.warn(`[LB Lead-Status] Decrypt failed for user ${cand.user_id}: ${e.message}`)
          continue
        }
        const expected = crypto.createHmac('sha256', secret).update(`${tsHeader}.${rawBody}`).digest('hex')
        // LB sends raw hex (per crm-webhook.service.ts:288). Tolerate
        // an optional `sha256=` prefix in case the contract evolves.
        const provided = String(sigHeader).replace(/^sha256=/, '')
        if (
          expected.length === provided.length &&
          crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(provided, 'hex'))
        ) {
          userRow = cand
          break
        }
      }

      if (!userRow) {
        // Suppress detail in the response — log internally for ops.
        logger.warn(`[LB Lead-Status] Signature did not match any active subscription. workspace=${targetWorkspaceId} business=${targetBusinessId} candidates=${candidates.length}`)
        return res.status(401).json({ error: 'signature_mismatch' })
      }
    } catch (e) {
      logger.error(`[LB Lead-Status] Verification error: ${e.message}`)
      return res.status(500).json({ error: 'verification_error' })
    }

    const userId = userRow.user_id

    // Idempotency — drop duplicate event_id deliveries.
    const eventId = event.event_id || null
    if (eventId) {
      const { data: prior } = await supabase
        .from('communication_webhook_events')
        .select('id').eq('provider', 'leadbridge').eq('event_id', eventId).maybeSingle()
      if (prior) {
        return res.status(200).json({ ok: true, idempotent: true })
      }
    }

    // Persist event log row first — so even if the job update fails
    // we have a forensic record of what came in.
    let webhookEventId = null
    try {
      const { data: ins } = await supabase.from('communication_webhook_events').insert({
        provider: 'leadbridge',
        event_id: eventId,
        event_type: event.event_type,
        payload: event,
        signature: typeof sigHeader === 'string' ? sigHeader.slice(0, 200) : null,
        external_account_id: event.external_account_id || event.account_id || null,
        channel: event.channel || null,
        processed: false,
        received_at: new Date().toISOString(),
      }).select('id').single()
      webhookEventId = ins?.id || null
    } catch (e) {
      // Unique violation on event_id → another delivery beat us. Idempotent OK.
      if (e?.code === '23505') return res.status(200).json({ ok: true, idempotent: true })
      logger.warn(`[LB Lead-Status] Event log insert error: ${e.message}`)
    }

    // Find the SF job linked to this LB lead. LB lead.externalRequestId
    // (delivered as thread.external_lead_id) maps to jobs.lb_external_request_id.
    const externalRequestId = event.thread?.external_lead_id || null
    const channel = event.channel || null
    if (!externalRequestId) {
      logger.log(`[LB Lead-Status] Skipping event=${eventId} — no external_lead_id`)
      if (webhookEventId) {
        await supabase.from('communication_webhook_events')
          .update({ processed: true, processed_at: new Date().toISOString(), processing_error: 'no_external_lead_id' })
          .eq('id', webhookEventId)
      }
      return res.status(200).json({ ok: true, action: 'skipped_no_external_lead_id' })
    }

    // Map LB pipeline status → SF job status. Returns null for early-funnel
    // statuses (new/contacted/quoted/booked) and lead-only terminals
    // (lost/archived) — the SF job either doesn't exist or shouldn't change.
    const lbStatus = event.lead?.status || null
    const sfStatus = mapLbToSfStatus(lbStatus)

    if (!sfStatus) {
      const reason = isKnownLbStatus(lbStatus) ? 'no_job_equivalent' : 'unknown_lb_status'
      logger.log(`[LB Lead-Status] Skipping event=${eventId} lb_status=${lbStatus} — ${reason}`)
      if (webhookEventId) {
        await supabase.from('communication_webhook_events')
          .update({ processed: true, processed_at: new Date().toISOString(), processing_error: `skipped_${reason}` })
          .eq('id', webhookEventId)
      }
      // Touch the last_event_at marker even when skipped — proves the
      // subscription is alive end-to-end.
      await supabase.from('communication_settings')
        .update({ leadbridge_lead_status_last_event_at: new Date().toISOString() })
        .eq('user_id', userId)
      return res.status(200).json({ ok: true, action: 'skipped', reason, lb_status: lbStatus })
    }

    // Locate the linked SF job. We scope by user_id even though
    // lb_external_request_id is globally unique on TT/Yelp because
    // (a) LB CrmWebhookSubscription is per-user, so the subscription
    // owner IS the SF tenant, and (b) belt-and-suspenders against
    // cross-tenant leakage if two users ever shared an external id.
    let jobQuery = supabase.from('jobs')
      .select('id, status, lb_external_request_id, lb_channel')
      .eq('user_id', userId)
      .eq('lb_external_request_id', externalRequestId)
    if (channel) jobQuery = jobQuery.eq('lb_channel', channel)
    const { data: jobs, error: jobErr } = await jobQuery.limit(2)

    if (jobErr) {
      logger.error(`[LB Lead-Status] Job lookup error: ${jobErr.message}`)
      return res.status(500).json({ error: 'job_lookup_error' })
    }
    if (!jobs || jobs.length === 0) {
      logger.log(`[LB Lead-Status] No SF job for external_lead_id=${externalRequestId} channel=${channel}`)
      if (webhookEventId) {
        await supabase.from('communication_webhook_events')
          .update({ processed: true, processed_at: new Date().toISOString(), processing_error: 'no_matching_job' })
          .eq('id', webhookEventId)
      }
      await supabase.from('communication_settings')
        .update({ leadbridge_lead_status_last_event_at: new Date().toISOString() })
        .eq('user_id', userId)
      return res.status(200).json({ ok: true, action: 'skipped_no_job' })
    }
    if (jobs.length > 1) {
      // Ambiguous — multiple jobs share this external id. Don't guess.
      logger.warn(`[LB Lead-Status] Ambiguous: ${jobs.length} jobs for external_lead_id=${externalRequestId} user=${userId}`)
      if (webhookEventId) {
        await supabase.from('communication_webhook_events')
          .update({ processed: true, processed_at: new Date().toISOString(), processing_error: 'ambiguous_job' })
          .eq('id', webhookEventId)
      }
      return res.status(200).json({ ok: true, action: 'skipped_ambiguous' })
    }

    const job = jobs[0]

    // Apply the status change through the centralized writer. source='leadbridge'
    // engages the loop guard in services/lb-outbound-delivery.js → SF will
    // NOT enqueue an outbound job.status_changed echo for this update.
    let result
    try {
      result = await updateJobStatus(supabase, {
        jobId: job.id,
        newStatus: sfStatus,
        actor: { type: 'system', id: null, display_name: 'LeadBridge' },
        source: 'leadbridge',
        userId,
      })
    } catch (e) {
      logger.error(`[LB Lead-Status] updateJobStatus failed for job ${job.id}: ${e.message}`)
      if (webhookEventId) {
        await supabase.from('communication_webhook_events')
          .update({ processed: true, processed_at: new Date().toISOString(), processing_error: e.message?.slice(0, 500) || 'update_failed' })
          .eq('id', webhookEventId)
      }
      return res.status(500).json({ error: 'job_update_failed' })
    }

    if (webhookEventId) {
      await supabase.from('communication_webhook_events')
        .update({ processed: true, processed_at: new Date().toISOString() })
        .eq('id', webhookEventId)
    }
    await supabase.from('communication_settings')
      .update({ leadbridge_lead_status_last_event_at: new Date().toISOString() })
      .eq('user_id', userId)

    logger.log(`[LB Lead-Status] event=${eventId} job=${job.id} ${result.previousStatus} → ${result.newStatus} changed=${result.changed} outbound=${result.outboundAction}`)

    return res.status(200).json({
      ok: true,
      action: result.changed ? 'updated' : 'no_change',
      job_id: job.id,
      previous_status: result.previousStatus,
      new_status: result.newStatus,
      outbound_action: result.outboundAction,
    })
  })

  // ══════════════════════════════════════
  // POST /webhooks — Receive events from LB.
  //
  // Signature verification (PR-2): when LB_INBOUND_HMAC_REQUIRED is on,
  // we verify X-LB-Signature against the per-user inbound subscription
  // secret stored at /connect time (migration 037). When OFF, we still
  // attempt verification when a signature is present and a candidate
  // exists, and log mismatches — but the request is processed anyway
  // for backwards compatibility with existing unsigned LB integrations
  // that haven't been re-registered yet.
  // ══════════════════════════════════════
  router.post('/webhooks', async (req, res) => {
    const sigHeader = req.headers['x-lb-signature']
    const tsHeader = req.headers['x-lb-timestamp']
    const enforced = isEnabled(FLAGS.LB_INBOUND_HMAC_REQUIRED)

    // ── HMAC verification ──
    let verifiedUserId = null
    let verificationReason = null

    if (sigHeader && tsHeader) {
      try {
        const { data: candidates } = await supabase
          .from('communication_settings')
          .select('user_id,leadbridge_inbound_encrypted_secret,leadbridge_inbound_secret_key_version')
          .not('leadbridge_inbound_encrypted_secret', 'is', null)

        const decryptedCandidates = []
        for (const c of (candidates || [])) {
          try {
            decryptedCandidates.push({
              user_id: c.user_id,
              secret: decryptIntegrationSecret(
                c.leadbridge_inbound_encrypted_secret,
                c.leadbridge_inbound_secret_key_version,
              ),
            })
          } catch (e) {
            logger.warn(`[LB Webhook] Decrypt failed for user ${c.user_id}: ${e.message}`)
          }
        }

        const rawBody = req.rawBody ? req.rawBody.toString('utf8') : JSON.stringify(req.body)
        const auth = authenticateWebhook({
          signatureHeader: sigHeader,
          timestampHeader: tsHeader,
          rawBody,
          candidates: decryptedCandidates,
        })
        if (auth.ok) {
          verifiedUserId = auth.candidate.user_id
        } else {
          verificationReason = auth.reason
        }
      } catch (e) {
        logger.error(`[LB Webhook] Verification error: ${e.message}`)
        verificationReason = 'verification_error'
      }
    } else if (enforced) {
      verificationReason = 'missing_signature_or_timestamp'
    }

    if (enforced && !verifiedUserId) {
      // Reject unsigned/invalid when flag is on. Don't reveal whether the
      // signature was missing vs mismatched — same 401 for both.
      logger.warn(`[LB Webhook] Rejected (enforced): ${verificationReason}`)
      return res.status(401).json({ error: 'unauthorized', reason: verificationReason })
    }

    // Accept the event and respond 200 immediately. Processing async.
    res.status(200).json({ received: true })

    try {
      const event = req.body
      if (!event?.event_type) return

      // Log webhook event
      const eventId = event.event_id || null
      if (eventId) {
        // Idempotency check
        const { data: existing } = await supabase.from('communication_webhook_events')
          .select('id').eq('provider', 'leadbridge').eq('event_id', eventId).maybeSingle()
        if (existing) return // Already processed
      }

      // Store event
      await supabase.from('communication_webhook_events').insert({
        provider: 'leadbridge',
        event_id: eventId,
        event_type: event.event_type,
        payload: event,
        signature: typeof sigHeader === 'string' ? sigHeader.slice(0, 200) : null,
        external_account_id: event.account_id,
        channel: event.channel,
        processed: false,
        received_at: new Date().toISOString(),
      })

      // Tenant attribution. PRIORITY:
      //   1. Verified userId from HMAC (signed-event-was-for-this-tenant)
      //   2. Lookup by event.account_id → communication_provider_accounts
      //
      // When verifiedUserId is set, we still cross-check that event.account_id
      // belongs to the same user, and refuse otherwise — defends against a
      // tenant signing an event with their secret but referencing another
      // tenant's account_id.
      let userId = verifiedUserId
      if (event.account_id) {
        const { data: acct } = await supabase.from('communication_provider_accounts')
          .select('user_id').eq('provider', 'leadbridge').eq('external_account_id', event.account_id)
          .eq('status', 'active').maybeSingle()
        if (verifiedUserId && acct && acct.user_id !== verifiedUserId) {
          logger.warn(`[LB Webhook] Cross-tenant attempt: signed_user=${verifiedUserId} account_user=${acct.user_id}`)
          return // do not process
        }
        if (!userId) userId = acct?.user_id
      }
      if (!userId) {
        logger.warn('[LB Webhook] No user found for account:', event.account_id)
        return
      }

      // Process based on event type
      const thread = event.thread || {}
      const participant = event.participant || {}
      const message = event.message || {}
      const channel = event.channel || 'thumbtack'

      // Stage 2 — engine vs legacy dispatch (per-tenant prerequisite chain).
      // engineFlagOn + missing prereqs → legacy + rate-limited warn (§2 of
      // docs/architecture/stage-2-leadbridge-adapter-plan.md).
      const prereq = lbEngineAdapter.checkPrerequisites(userId)
      if (prereq.engineFlagOn && !prereq.useEngine) {
        lbEngineAdapter.emitPrereqMissingWarning(logger, userId, prereq.missing)
      }

      // Upsert participant identity (legacy path only — engine path resolves
      // the identity internally via resolveIdentity inside engine.reconcile).
      let identity = null
      if (!prereq.useEngine) {
        identity = await upsertParticipantIdentity(userId, {
          phone: participant.phone,
          email: participant.email,
          displayName: participant.name,
          lbContactId: participant.external_contact_id,
          channel,
        })
      }

      // Resolve provider account (need display_name for per-location source)
      let resolvedAccountId = null
      let resolvedAccountDisplayName = null
      if (event.account_id) {
        const { data: pa } = await supabase.from('communication_provider_accounts')
          .select('id, display_name').eq('provider', 'leadbridge').eq('external_account_id', event.account_id)
          .eq('status', 'active').maybeSingle()
        resolvedAccountId = pa?.id || null
        resolvedAccountDisplayName = pa?.display_name || null
      }

      // Two-field attribution (migration 050) — load tenant's LB source
      // mappings once per webhook. Strictly user-scoped → no cross-tenant
      // leakage. Empty {} when no mappings configured → raw on both fields.
      const sourceMappingsLookup = await loadSourceMappings(supabase, userId, 'leadbridge')

      // LB linkage fields (migration 051) — extracted once and forwarded to
      // BOTH paths so the create writers (createLeadFromLB, child create) can
      // stamp jobs.lb_* downstream via lead → customer → job conversion.
      // thread.external_lead_id is the TT negotiation id / Yelp lead id in
      // webhook payloads; event.business_id / thread.external_business_id
      // disambiguates multi-account tenants.
      const lbExternalRequestId = thread.external_lead_id || null
      const lbChannel = channel || null
      const lbBusinessId = thread.external_business_id || event.business_id || null
      const lbProviderAccountId = resolvedAccountId || null

      if (prereq.useEngine) {
        // Stage 2 engine path — identity resolution + lead-create in one call.
        try {
          const { identity: engineIdentity } = await lbEngineAdapter.resolveOrCreateLeadViaEngine(userId, {
            channel,
            customerName: participant.name,
            customerPhone: participant.phone,
            customerEmail: participant.email,
            message: message.body,
            lbContactId: participant.external_contact_id,
            accountDisplayName: resolvedAccountDisplayName,
            sourceMappingsLookup,
            lbExternalRequestId,
            lbChannel,
            lbBusinessId,
            lbProviderAccountId,
          })
          identity = engineIdentity
        } catch (e) {
          logger.warn(`[LB Webhook] Engine path: ${e.message}`)
        }
      } else if (identity) {
        // Legacy path — Phase B: resolve or create SF lead (non-blocking for webhook speed)
        resolveOrCreateLead(userId, identity, {
          channel, customerName: participant.name, customerPhone: participant.phone,
          customerEmail: participant.email, message: message.body,
          externalLeadId: thread.external_lead_id,
          accountDisplayName: resolvedAccountDisplayName, // per-location source
          sourceMappingsLookup,
          lbExternalRequestId,
          lbChannel,
          lbBusinessId,
          lbProviderAccountId,
        }).catch(e => logger.warn(`[LB Webhook] Lead resolution: ${e.message}`))
      }

      const conv = await upsertConversation(userId, {
        provider: 'leadbridge',
        channel,
        externalConvId: thread.external_conversation_id,
        externalLeadId: thread.external_lead_id,
        participantPhone: participant.phone,
        participantName: participant.name,
        identityId: identity?.id,
        providerAccountId: resolvedAccountId,
        lastMessage: message.body,
        lastActivity: event.occurred_at || new Date().toISOString(),
        // Location fields from webhook payload
        externalLocationId: thread.external_location_id || event.location_id || null,
        externalBusinessId: thread.external_business_id || event.business_id || null,
        externalLocationName: thread.external_location_name || event.location_name || null,
      })

      if (!conv) return

      // Insert message if present
      if (message.external_message_id && message.body) {
        const { data: existingMsg } = await supabase.from('communication_messages')
          .select('id').eq('conversation_id', conv.id)
          .eq('external_message_id', message.external_message_id).maybeSingle()

        if (!existingMsg) {
          const direction = message.direction === 'inbound' || message.direction === 'in' ? 'in' : 'out'
          // Source-account boundary (Phase 1) — inherit provider_account_id
          // from the conversation upserted right above (resolvedAccountId).
          await supabase.from('communication_messages').insert({
            conversation_id: conv.id,
            provider_account_id: conv.provider_account_id || resolvedAccountId || null,
            external_message_id: message.external_message_id,
            direction,
            channel,
            body: message.body,
            sender_role: direction === 'in' ? 'customer' : 'agent',
            status: 'delivered',
            sent_at: message.sent_at || event.occurred_at,
            created_at: message.sent_at || event.occurred_at || new Date().toISOString(),
          })

          // Update unread count
          if (direction === 'in') {
            await supabase.from('communication_conversations')
              .update({ unread_count: (conv.unread_count || 0) + 1 }).eq('id', conv.id)
          }
        }
      }

      // Mark webhook event as processed
      if (eventId) {
        await supabase.from('communication_webhook_events')
          .update({ processed: true, processed_at: new Date().toISOString() })
          .eq('provider', 'leadbridge').eq('event_id', eventId)
      }

      logger.log(`[LB Webhook] Processed ${event.event_type} for user ${userId}`)
    } catch (error) {
      logger.error('[LB Webhook] Processing error:', error.message)
    }
  })

  // ══════════════════════════════════════
  // Background sync function
  // ══════════════════════════════════════
  async function runLbSync(userId, lbToken, accountId, maxLeads = 0, opts = {}) {
    // opts.reconcile = true  → run Phase 2/3 reconcile after Phase 1 pull
    // opts.dryRun = true     → reconcile enumerates the plan but does NOT enqueue
    // Reconcile defaults to ON because the user's spec says "Sync LeadBridge"
    // now means "reconcile both directions". Callers that want pull-only must
    // explicitly pass { reconcile: false }.
    const reconcile = opts.reconcile !== false
    const reconcileDryRun = !!opts.dryRun
    // attribution_recovery defaults ON unless explicitly disabled. Same
    // dryRun signal — when /sync runs in dry-run mode, attribution is
    // planned but not applied.
    const attributionEnabled = opts.attribution !== false
    syncProgress[userId] = { status: 'running', total: 0, synced: 0, messages: 0, errors: 0, phase: 'fetching', attribution_recovery: null, reconcile: null }
    const t0 = Date.now()

    try {
      // Get provider accounts
      const { data: accounts } = await supabase.from('communication_provider_accounts')
        .select('*').eq('user_id', userId).eq('provider', 'leadbridge').eq('status', 'active')

      const targetAccounts = accountId
        ? (accounts || []).filter(a => a.id === parseInt(accountId) || a.external_account_id === accountId)
        : (accounts || [])

      if (targetAccounts.length === 0) {
        syncProgress[userId] = { status: 'error', error: 'No active LeadBridge accounts' }
        return
      }

      let totalSynced = 0
      let totalMessages = 0

      // Two-field attribution (migration 050) — load tenant's LB source mappings
      // once per sync run. Empty {} when no mappings configured → pickLBSources
      // falls back to raw on both fields (legacy behavior preserved). Strictly
      // scoped to userId so no cross-tenant mapping leakage is possible.
      const sourceMappingsLookup = await loadSourceMappings(supabase, userId, 'leadbridge')
      const mappingCount = Object.keys(sourceMappingsLookup).length
      if (mappingCount > 0) {
        logger.log(`[LB Sync] Loaded ${mappingCount} LB source mappings for tenant ${userId}`)
      }

      // Single canonical fetch — `/v1/leads?scope=all` returns every lead across
      // all platforms (each lead carries its own `platform` field). Replaces the
      // previous per-account /v1/{platform}/leads calls because:
      //   - /v1/thumbtack/leads returns BOTH thumbtack + yelp leads (route is misleading)
      //   - /v1/yelp/leads only returns a partial subset of yelp leads (~30%)
      // Fetching once per sync run (vs once per account) also drops N-1 round trips.
      let allLeads = []
      try {
        const leadsRes = await lbRequest('GET', '/v1/leads?scope=all', lbToken)
        allLeads = leadsRes.data?.leads || []
        logger.log(`[LB Sync] Fetched ${allLeads.length} leads from /v1/leads?scope=all`)
      } catch (e) {
        const upstreamStatus = e.response?.status
        const upstreamBody = e.response?.data
        logger.error('[LB Sync] /v1/leads?scope=all failed', JSON.stringify({
          status: upstreamStatus,
          body: upstreamBody,
          user_id: userId,
          message: e.message,
        }))
        syncProgress[userId] = { status: 'error', error: `LB fetch failed: ${upstreamStatus || e.message}` }
        return
      }

      for (const acct of targetAccounts) {
        const channel = acct.channel || 'thumbtack'
        const platform = channel === 'yelp' ? 'yelp' : 'thumbtack'

        syncProgress[userId].phase = `syncing_${platform}`

        try {
          // Filter the shared canonical response to this account's businessId.
          let leads = acct.external_business_id
            ? allLeads.filter(l => l.businessId === acct.external_business_id)
            : allLeads
          // Apply per-account limit for test sync
          if (maxLeads > 0) leads = leads.slice(0, maxLeads)

          syncProgress[userId].total += leads.length
          logger.log(`[LB Sync] ${platform}: ${leads.length} leads for account ${acct.display_name}`)

          for (const lead of leads) {
            try {
              // Stage 2 — engine vs legacy dispatch (per-tenant prerequisite chain).
              const prereq = lbEngineAdapter.checkPrerequisites(userId)
              if (prereq.engineFlagOn && !prereq.useEngine) {
                lbEngineAdapter.emitPrereqMissingWarning(logger, userId, prereq.missing)
              }

              // LB linkage fields (migration 051) — `lead.externalRequestId`
              // is the TT negotiation id / Yelp lead id (NOT `lead.id`, which
              // is LB's internal UUID). The externalRequestId is what
              // jobs.lb_external_request_id is indexed by, so we forward it
              // here even though externalLeadId still gets lead.id for
              // backward compat with the conversation upsert.
              const lbExternalRequestId = lead.externalRequestId || null
              const lbChannelVal = channel || null
              const lbBusinessId = lead.businessId || acct.external_business_id || null
              const lbProviderAccountId = acct.id || null

              let identity = null
              if (prereq.useEngine) {
                // Engine path — resolver + dispatch inside the adapter.
                const { identity: engineIdentity } = await lbEngineAdapter.resolveOrCreateLeadViaEngine(userId, {
                  channel,
                  customerName: lead.customerName,
                  customerPhone: lead.customerPhone,
                  customerEmail: lead.customerEmail,
                  message: lead.message,
                  lbContactId: lead.id,
                  accountDisplayName: acct.display_name,
                  sourceMappingsLookup,
                  lbExternalRequestId,
                  lbChannel: lbChannelVal,
                  lbBusinessId,
                  lbProviderAccountId,
                })
                identity = engineIdentity
              } else {
                // Legacy path — upsertParticipantIdentity + resolveOrCreateLead
                identity = await upsertParticipantIdentity(userId, {
                  phone: lead.customerPhone,
                  email: lead.customerEmail,
                  displayName: lead.customerName,
                  lbContactId: lead.id,
                  channel,
                })

                // Phase B: resolve or create SF lead
                if (identity) {
                  await resolveOrCreateLead(userId, identity, {
                    channel, customerName: lead.customerName, customerPhone: lead.customerPhone,
                    customerEmail: lead.customerEmail, message: lead.message,
                    externalLeadId: lead.id,
                    accountDisplayName: acct.display_name, // per-location source
                    sourceMappingsLookup,
                    lbExternalRequestId,
                    lbChannel: lbChannelVal,
                    lbBusinessId,
                    lbProviderAccountId,
                  })
                }
              }

              // Upsert conversation
              // LB NormalizedLead: { id, externalRequestId, threadId, customerName, customerPhone, message, status, ... }
              const conv = await upsertConversation(userId, {
                provider: 'leadbridge',
                channel,
                externalConvId: lead.threadId || lead.externalRequestId || lead.id,
                externalLeadId: lead.id,
                participantPhone: lead.customerPhone,
                participantName: lead.customerName,
                identityId: identity?.id,
                providerAccountId: acct.id,
                lastMessage: lead.message,
                lastActivity: lead.lastMessageAt || lead.updatedAt || lead.createdAt,
                // Location fields — from LB lead + provider account
                externalLocationId: lead.locationId || null,
                externalBusinessId: lead.businessId || acct.external_business_id || null,
                externalLocationName: lead.locationName || acct.display_name || null,
              })

              if (!conv) { syncProgress[userId].errors++; continue }

              // Fetch messages — LB response: { platform, leadId, count, messages: Message[] }
              // Message: { id, externalMessageId, sender: "pro"|"customer"|"system", content, sentAt, ... }
              try {
                // Always use /v1/thumbtack/leads/:id/messages — the LB leads service
                // handles both platforms internally (checks lead.platform)
                const msgsPath = `/v1/thumbtack/leads/${lead.id}/messages`
                const msgsRes = await lbRequest('GET', msgsPath, lbToken)
                const messages = msgsRes.data?.messages || []

                for (const msg of messages) {
                  const msgId = msg.externalMessageId || msg.id
                  if (!msgId) continue

                  const { data: existing } = await supabase.from('communication_messages')
                    .select('id').eq('conversation_id', conv.id)
                    .eq('external_message_id', msgId).maybeSingle()
                  if (existing) continue

                  const direction = msg.sender === 'customer' ? 'in' : 'out'
                  // Source-account boundary (Phase 1) — every LB message
                  // inherits the iterating account's provider_account_id.
                  await supabase.from('communication_messages').insert({
                    conversation_id: conv.id,
                    provider_account_id: acct.id,
                    external_message_id: msgId,
                    direction,
                    channel,
                    body: msg.content || '',
                    sender_role: msg.sender === 'customer' ? 'customer' : msg.sender === 'system' ? 'system' : 'agent',
                    status: msg.deliveredAt ? 'delivered' : 'sent',
                    sent_at: msg.sentAt,
                    delivered_at: msg.deliveredAt || null,
                    created_at: msg.sentAt || new Date().toISOString(),
                  })
                  totalMessages++
                }
              } catch (e) {
                // Include upstream response body — previous one-arg form
                // logged only e.message ("Request failed with status code N"),
                // hiding LB's actual error string and obscuring contract
                // changes like the 2026-04-28 scope=all requirement.
                logger.warn(`[LB Sync] Messages for lead ${lead.id}: ${JSON.stringify({
                  status: e.response?.status,
                  body: e.response?.data,
                  platform,
                  user_id: userId,
                  account_id: acct.id,
                  business_id: acct.external_business_id,
                  message: e.message,
                })}`)
              }

              totalSynced++
              syncProgress[userId].synced = totalSynced
              syncProgress[userId].messages = totalMessages
            } catch (e) {
              syncProgress[userId].errors++
              logger.warn(`[LB Sync] Lead ${lead.id}: ${e.message}`)
            }
          }

          // Update sync cursor
          await supabase.from('communication_provider_accounts').update({
            last_synced_at: new Date().toISOString(),
            sync_error: null,
          }).eq('id', acct.id)

        } catch (e) {
          // Include upstream response body and request context — previous
          // one-arg form logged only e.message ("Request failed with status
          // code N"), which is what masked the 2026-04-28 LB API contract
          // change for nearly a month. Token/secret are never in axios error
          // shape so this is safe to JSON-stringify.
          const upstreamStatus = e.response?.status
          const upstreamBody = e.response?.data
          logger.error(`[LB Sync] Account ${acct.display_name}: ${JSON.stringify({
            status: upstreamStatus,
            body: upstreamBody,
            platform,
            user_id: userId,
            account_id: acct.id,
            business_id: acct.external_business_id,
            message: e.message,
          })}`)
          // Persist a compact human-readable error to the row so operators
          // see the actual upstream reason in the UI, not just "400".
          const persistedError = upstreamBody?.message || upstreamBody?.error || e.message
          await supabase.from('communication_provider_accounts').update({
            sync_error: upstreamStatus ? `[${upstreamStatus}] ${persistedError}` : persistedError,
          }).eq('id', acct.id)
          syncProgress[userId].errors++
        }
      }

      // ── Phase 2: Attribution recovery ──────────────────────────────
      // Stage-1 standard HIGH + Stage-3 recurring HIGH safe attribution
      // backfills, productized. Mirror of scripts/backfill-jobs-lb-linkage.js
      // logic — same library helpers under the hood. Runs after Phase 1
      // (which may have created/enriched leads) so the new leads are
      // available for the converted_customer_id walk. Runs BEFORE Phase 3
      // (lifecycle reconcile) so newly-stamped jobs are eligible for
      // status pushes in the same /sync call.
      //
      // Dry-run + apply share the same code path; only the `apply` flag
      // gates the mutation step. Idempotent — write-once guards at SQL
      // layer make repeated /sync a no-op.
      let attributionResult = null
      if (attributionEnabled) {
        try {
          syncProgress[userId] = { ...syncProgress[userId], phase: reconcileDryRun ? 'attribution_dry_run' : 'attribution' }
          logger.log(`[LB Attribution] phase=start lb_leads=${allLeads.length} user=${userId} dryRun=${reconcileDryRun}`)
          attributionResult = await runAttributionRecovery(supabase, {
            userId,
            apply: !reconcileDryRun,
            mode: 'both',
            lbLeads: allLeads,
            logger,
          })
        } catch (attrErr) {
          logger.error(`[LB Attribution] failed user=${userId}: ${attrErr.message}`)
          attributionResult = { summary: { error: attrErr.message }, standard: {}, recurring: {} }
        }
      }
      syncProgress[userId] = { ...syncProgress[userId], attribution_recovery: attributionResult }

      // ── Phase 3: Reconcile SF lifecycle → LB ───────────────────────
      // After Phase 1 (LB → SF pull) finishes, find LB-linked SF jobs
      // and push safe SF lifecycle statuses back to LB via the existing
      // outbound queue. Uses the `allLeads` already fetched in Phase 1
      // (no extra LB API calls). Skips ambiguous / unsupported / regressing
      // transitions. Idempotent — deterministic event_id per (job, canonical)
      // collides on UNIQUE so repeated reconcile is a no-op.
      let reconcileResult = null
      if (reconcile) {
        try {
          syncProgress[userId] = { ...syncProgress[userId], phase: reconcileDryRun ? 'reconcile_dry_run' : 'reconcile' }
          logger.log(`[LB Reconcile] phase=pull lb_leads=${allLeads.length} user=${userId} dryRun=${reconcileDryRun}`)
          reconcileResult = await reconcileTenantWithLb(supabase, userId, allLeads, {
            dryRun: reconcileDryRun,
            logger,
          })
        } catch (rcErr) {
          logger.error(`[LB Reconcile] failed user=${userId}: ${rcErr.message}`)
          reconcileResult = { plan: [], summary: { failures: 1, error: rcErr.message } }
        }
      }

      syncProgress[userId] = {
        status: 'complete', total: syncProgress[userId].total,
        synced: totalSynced, messages: totalMessages,
        errors: syncProgress[userId].errors, phase: 'done',
        attribution_recovery: attributionResult,
        reconcile: reconcileResult,
      }
      const attrSummary = attributionResult ? attributionResult.summary : null
      const attrTag = attrSummary
        ? ` attribution=${JSON.stringify({ std_high: attrSummary.standard_high_proposals, rec_high: attrSummary.recurring_high_proposals, applied: attrSummary.applied || null })}`
        : ''
      logger.log(`[LB Sync] DONE in ${Date.now() - t0}ms: ${totalSynced} conversations, ${totalMessages} messages${attrTag}${reconcileResult ? `, reconcile=${JSON.stringify(reconcileResult.summary)}` : ''}`)
    } catch (error) {
      logger.error('[LB Sync] Error:', error.message)
      syncProgress[userId] = { status: 'error', error: error.message }
    }
  }

  // ══════════════════════════════════════
  // Admin / observability endpoints — §10 of the plan.
  //
  // Mounted under the same /api/integrations/leadbridge namespace as
  // the lifecycle routes. There is no separate "outbound admin" page
  // — both directions share one integration surface.
  //
  // Auth is the existing JWT. A role gate would belong in the
  // underlying auth middleware; we don't add a second one here so
  // the caller's existing access control applies uniformly.
  // ══════════════════════════════════════

  // GET /outbound/events — list outbox rows (filterable)
  router.get('/outbound/events', authenticateToken, async (req, res) => {
    try {
      const {
        user_id,
        sf_job_id,
        event_id,
        state,
        defer_reason,
        since,
        limit,
      } = req.query

      const cap = Math.min(parseInt(limit, 10) || 50, 200)
      let q = supabase
        .from('leadbridge_outbound_events')
        .select('id, event_id, user_id, sf_job_id, event_type, state, result, defer_reason, attempts, next_attempt_at, last_error, last_attempt_at, created_at, terminal_at')
        .order('created_at', { ascending: false })
        .limit(cap)

      if (user_id) q = q.eq('user_id', user_id)
      if (sf_job_id) q = q.eq('sf_job_id', String(sf_job_id))
      if (event_id) q = q.eq('event_id', event_id)
      if (state) q = q.eq('state', state)
      if (defer_reason) q = q.eq('defer_reason', defer_reason)
      if (since) q = q.gte('created_at', since)

      const { data, error } = await q
      if (error) return res.status(500).json({ error: error.message })
      res.json({ events: data || [], limit: cap })
    } catch (error) {
      logger.error('[LB Outbound Admin] List error:', error.message)
      res.status(500).json({ error: 'Failed to list outbound events' })
    }
  })

  // POST /outbound/events/:id/replay — force a row back into the queue
  //
  // Accepts:
  //   - state='dlq'
  //   - state='skipped_unmapped_status'
  //   - state='pending' with defer_reason='no_outbound_subscription'
  //   - state='sent' AND result='dry_run'
  //
  // PRESERVES the original event_id and payload_json — required for
  // LB idempotency. Never rebuilds from current job state.
  router.post('/outbound/events/:id/replay', authenticateToken, async (req, res) => {
    try {
      const { id } = req.params
      const { data: row, error: fetchErr } = await supabase
        .from('leadbridge_outbound_events')
        .select('id, state, result, defer_reason')
        .eq('id', id).maybeSingle()

      if (fetchErr) return res.status(500).json({ error: fetchErr.message })
      if (!row) return res.status(404).json({ error: 'Event not found' })

      const replayable =
        row.state === 'dlq' ||
        row.state === 'skipped_unmapped_status' ||
        (row.state === 'pending' && row.defer_reason === 'no_outbound_subscription') ||
        (row.state === 'sent' && row.result === 'dry_run')

      if (!replayable) {
        return res.status(409).json({
          error: `Not replayable from state='${row.state}' result='${row.result}' defer_reason='${row.defer_reason}'`,
        })
      }

      const { error: upErr } = await supabase
        .from('leadbridge_outbound_events')
        .update({
          state: 'pending',
          attempts: 0,
          next_attempt_at: new Date().toISOString(),
          claimed_by: null,
          claimed_until: null,
          last_error: null,
          defer_reason: null,
          terminal_at: null,
          // event_id + payload_json explicitly NOT touched.
        })
        .eq('id', id)

      if (upErr) return res.status(500).json({ error: upErr.message })
      res.json({ success: true, id })
    } catch (error) {
      logger.error('[LB Outbound Admin] Replay error:', error.message)
      res.status(500).json({ error: 'Failed to replay event' })
    }
  })

  return router
}
