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
const { FLAGS, isEnabled } = require('./lib/feature-flags')
const { pickLBSource, buildEnrichLeadPatch, assertCreateLeadInvariant } = require('./lib/lb-ingestion')
const { mapLbToSfStatus, isKnownLbStatus, normalizeLbStatus } = require('./services/lb-inbound-status-map')
const { updateJobStatus } = require('./services/job-status-service')

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
    const { data: existing } = await supabase.from('leads')
      .select('id, source, email').eq('id', leadId).eq('user_id', userId).maybeSingle()
    if (!existing) return
    const patch = buildEnrichLeadPatch({ existing, input })
    if (!patch) return
    await supabase.from('leads').update(patch).eq('id', leadId)
  }

  async function createLeadFromLB(userId, identity, { channel, customerName, customerPhone, customerEmail, message, accountDisplayName }) {
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
    const source = pickLBSource({ accountDisplayName, channel })

    const { data: newLead, error } = await supabase.from('leads').insert({
      user_id: userId,
      pipeline_id: pipeline.id,
      stage_id: stage.id,
      first_name: firstName,
      last_name: lastName,
      phone: normalized || null,
      email: customerEmail || null,
      source,
      notes: message ? message.substring(0, 500) : null,
    }).select().single()

    if (error) { logger.error('[LB Lead] Create error:', error.message); return null }

    await supabase.from('communication_participant_identities')
      .update({ sf_lead_id: newLead.id, status: 'resolved_lead', updated_at: new Date().toISOString() })
      .eq('id', identity.id)

    logger.log(`[LB Lead] Created lead ${newLead.id} for ${customerName} (${source})`)
    return { type: 'new_lead', id: newLead.id, created: true, action: 'created' }
  }

  async function resolveOrCreateLead(userId, identity, input) {
    if (!identity) return null
    const { customerPhone } = input

    // HARD INVARIANT: identity already tied to a lead → enrich, NEVER create.
    if (identity.sf_lead_id) {
      await enrichLeadFromLB(userId, identity.sf_lead_id, input)
      return { type: 'lead', id: identity.sf_lead_id, created: false, action: 'enriched' }
    }

    // Identity already tied to a customer → do NOT create lead.
    if (identity.sf_customer_id) {
      return { type: 'customer', id: identity.sf_customer_id, created: false, action: 'identity_already_customer' }
    }

    // Try to find existing CRM entity by phone (legacy behavior preserved).
    const last10 = normalizePhone(customerPhone)?.slice(-10)
    if (last10 && last10.length >= 7) {
      const { data: customer } = await supabase.from('customers')
        .select('id').eq('user_id', userId).ilike('phone', `%${last10}%`).limit(1).maybeSingle()
      if (customer) {
        await supabase.from('communication_participant_identities')
          .update({ sf_customer_id: customer.id, status: 'resolved_customer', updated_at: new Date().toISOString() })
          .eq('id', identity.id)
        return { type: 'customer', id: customer.id, created: false, action: 'linked_customer' }
      }

      const { data: existingLead } = await supabase.from('leads')
        .select('id').eq('user_id', userId).ilike('phone', `%${last10}%`).limit(1).maybeSingle()
      if (existingLead) {
        await supabase.from('communication_participant_identities')
          .update({ sf_lead_id: existingLead.id, status: 'resolved_lead', updated_at: new Date().toISOString() })
          .eq('id', identity.id)
        await enrichLeadFromLB(userId, existingLead.id, input)
        return { type: 'lead', id: existingLead.id, created: false, action: 'linked_enriched' }
      }
    }

    // No existing CRM entity → create lead.
    return await createLeadFromLB(userId, identity, input)
  }

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

      logger.log(`[LB] Connected for user ${userId}, ${accounts.length} accounts`)
      res.json({
        success: true,
        accounts,
        userId: lbUserId,
        direction_inbound: { active: true, accounts: accounts.length },
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
        reconnect_required: !outboundResult.registered || !leadStatusResult.registered,
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
      ].join(','))
      .eq('user_id', userId).maybeSingle()

    const outboundActive = Boolean(subRow?.leadbridge_outbound_subscription_id)
    const leadStatusActive = Boolean(subRow?.leadbridge_lead_status_subscription_id)

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
      direction_inbound: { active: true, accounts: accountCount || 0 },
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
      reconnect_required: !outboundActive || !leadStatusActive || (deferredCount || 0) > 0,
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

      // Deactivate provider accounts
      await supabase.from('communication_provider_accounts')
        .update({ status: 'disconnected', updated_at: new Date().toISOString() })
        .eq('user_id', userId).eq('provider', 'leadbridge')

      // Clear settings — BOTH directions of the integration. Any
      // outbox rows still in 'pending' for this user are left alone:
      // the drainer will keep deferring them with
      // defer_reason='no_outbound_subscription' on the long backoff
      // until the user reconnects (or the per-row DLQ cap fires).
      const patch = {
        leadbridge_connected: false,
        leadbridge_integration_token: null,
        leadbridge_user_id: null,
        updated_at: new Date().toISOString(),
      }
      for (const col of OUTBOUND_COLUMNS) patch[col] = null
      for (const col of LEAD_STATUS_COLUMNS) patch[col] = null
      await supabase.from('communication_settings').update(patch).eq('user_id', userId)

      logger.log(`[LB] Disconnected for user ${userId} (all directions cleared)`)
      res.json({
        success: true,
        direction_inbound: { active: false, accounts: 0 },
        direction_outbound: { active: false },
        direction_lead_status: { active: false },
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
      // Lead-status: rotate alongside outbound so a single reconnect
      // refreshes BOTH HMAC secrets. We don't fail the request if
      // only lead-status fails — outbound is the higher-priority leg.
      const leadStatus = await registerLeadStatusSubscription(userId, lbToken)

      if (!outbound.registered) {
        return res.status(502).json({
          error: 'Failed to register outbound subscription',
          reason: outbound.reason,
          lead_status_reason: leadStatus.registered ? null : leadStatus.reason,
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
  // POST /sync — Sync conversations from LB
  // ══════════════════════════════════════
  router.post('/sync', authenticateToken, async (req, res) => {
    try {
      const userId = req.user.userId
      const { accountId, limit } = req.body || {}
      const settings = await getLbSettings(userId)
      if (!settings?.leadbridge_connected || !settings.leadbridge_integration_token) {
        return res.status(400).json({ error: 'LeadBridge not connected' })
      }

      if (syncProgress[userId]?.status === 'running') {
        return res.json({ started: false, message: 'Sync already in progress', progress: syncProgress[userId] })
      }

      // Start sync in background
      setImmediate(() => runLbSync(userId, settings.leadbridge_integration_token, accountId, parseInt(limit) || 0))
      res.json({ started: true })
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
          .update({ processed: true, processed_at: new Date().toISOString(), error: 'no_external_lead_id' })
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
          .update({ processed: true, processed_at: new Date().toISOString(), error: `skipped_${reason}` })
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
          .update({ processed: true, processed_at: new Date().toISOString(), error: 'no_matching_job' })
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
          .update({ processed: true, processed_at: new Date().toISOString(), error: 'ambiguous_job' })
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
          .update({ processed: true, processed_at: new Date().toISOString(), error: e.message?.slice(0, 500) || 'update_failed' })
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
  // POST /webhooks — Receive events from LB
  // No auth middleware — public webhook endpoint
  // ══════════════════════════════════════
  router.post('/webhooks', async (req, res) => {
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
        signature: req.headers['x-lb-signature'] || null,
        external_account_id: event.account_id,
        channel: event.channel,
        processed: false,
        received_at: new Date().toISOString(),
      })

      // Resolve user from account_id
      let userId = null
      if (event.account_id) {
        const { data: acct } = await supabase.from('communication_provider_accounts')
          .select('user_id').eq('provider', 'leadbridge').eq('external_account_id', event.account_id)
          .eq('status', 'active').maybeSingle()
        userId = acct?.user_id
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

      // Upsert participant identity
      const identity = await upsertParticipantIdentity(userId, {
        phone: participant.phone,
        email: participant.email,
        displayName: participant.name,
        lbContactId: participant.external_contact_id,
        channel,
      })

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

      // Phase B: resolve or create SF lead (non-blocking for webhook speed)
      if (identity) {
        resolveOrCreateLead(userId, identity, {
          channel, customerName: participant.name, customerPhone: participant.phone,
          customerEmail: participant.email, message: message.body,
          externalLeadId: thread.external_lead_id,
          accountDisplayName: resolvedAccountDisplayName, // per-location source
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
          await supabase.from('communication_messages').insert({
            conversation_id: conv.id,
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
  async function runLbSync(userId, lbToken, accountId, maxLeads = 0) {
    syncProgress[userId] = { status: 'running', total: 0, synced: 0, messages: 0, errors: 0, phase: 'fetching' }
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

      for (const acct of targetAccounts) {
        const channel = acct.channel || 'thumbtack'
        const platform = channel === 'yelp' ? 'yelp' : 'thumbtack'

        syncProgress[userId].phase = `syncing_${platform}`

        try {
          // Fetch leads from LB — no limit at API level (LB doesn't filter by account)
          // Filter client-side by businessId, then apply per-account limit
          const leadsPath = `/v1/${platform}/leads`
          const leadsRes = await lbRequest('GET', leadsPath, lbToken)
          const allLeads = leadsRes.data?.leads || []
          // Filter to this account's businessId
          let leads = acct.external_business_id
            ? allLeads.filter(l => l.businessId === acct.external_business_id)
            : allLeads
          // Apply per-account limit for test sync
          if (maxLeads > 0) leads = leads.slice(0, maxLeads)

          syncProgress[userId].total += leads.length
          logger.log(`[LB Sync] ${platform}: ${leads.length} leads for account ${acct.display_name}`)

          for (const lead of leads) {
            try {
              // Upsert participant identity
              const identity = await upsertParticipantIdentity(userId, {
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
                })
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
                  await supabase.from('communication_messages').insert({
                    conversation_id: conv.id,
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
                logger.warn(`[LB Sync] Messages for lead ${lead.id}: ${e.message}`)
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
          logger.error(`[LB Sync] Account ${acct.display_name}: ${e.message}`)
          await supabase.from('communication_provider_accounts').update({
            sync_error: e.message,
          }).eq('id', acct.id)
          syncProgress[userId].errors++
        }
      }

      syncProgress[userId] = {
        status: 'complete', total: syncProgress[userId].total,
        synced: totalSynced, messages: totalMessages,
        errors: syncProgress[userId].errors, phase: 'done',
      }
      logger.log(`[LB Sync] DONE in ${Date.now() - t0}ms: ${totalSynced} conversations, ${totalMessages} messages`)
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
