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
  currentEncKeyVersion,
} = require('./services/lb-encryption')

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

// LB subscribe path — see geos-leadbridge/plans/2026-04-17-job-sync-sf-lb.md.
// LB_BASE already includes /api; the shipped contract is versioned under /v1.
const LB_SUBSCRIBE_PATH = '/v1/integrations/service-flow/subscribe'
const LB_SF_INBOUND_PATH = '/v1/integrations/service-flow/job-status'

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

  // Get or create participant identity
  async function upsertParticipantIdentity(userId, { phone, email, displayName, lbContactId, channel }) {
    const normalized = normalizePhone(phone)

    // Try to find existing by LB contact ID first, then by phone
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
      // Update with new info
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

    // Create new
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
  // Lead Resolution — Phase B
  //
  // Given a participant identity + LB lead data, resolve to an
  // SF lead or customer. Creates a new SF lead if no match.
  //
  // Resolution order:
  //   1. Identity already linked to customer → done
  //   2. Identity already linked to lead → done
  //   3. Match existing customer by phone → link identity
  //   4. Match existing lead by phone → link identity
  //   5. No match → create SF lead + link identity
  //
  // Returns: { type: 'customer'|'lead'|'new_lead', id, created }
  // ══════════════════════════════════════

  async function resolveOrCreateLead(userId, identity, { channel, customerName, customerPhone, customerEmail, message, externalLeadId, locationId }) {
    if (!identity) return null

    // 1. Already linked to customer?
    if (identity.sf_customer_id) {
      return { type: 'customer', id: identity.sf_customer_id, created: false }
    }

    // 2. Already linked to lead?
    if (identity.sf_lead_id) {
      return { type: 'lead', id: identity.sf_lead_id, created: false }
    }

    const normalized = normalizePhone(customerPhone)
    const last10 = normalized?.slice(-10)

    // 3. Match existing customer by phone
    if (last10 && last10.length >= 7) {
      const { data: customer } = await supabase.from('customers')
        .select('id').eq('user_id', userId).ilike('phone', `%${last10}%`).limit(1).maybeSingle()

      if (customer) {
        // Link identity to customer
        await supabase.from('communication_participant_identities')
          .update({ sf_customer_id: customer.id, updated_at: new Date().toISOString() })
          .eq('id', identity.id)
        return { type: 'customer', id: customer.id, created: false }
      }
    }

    // 4. Match existing lead by phone
    if (last10 && last10.length >= 7) {
      const { data: existingLead } = await supabase.from('leads')
        .select('id').eq('user_id', userId).ilike('phone', `%${last10}%`).limit(1).maybeSingle()

      if (existingLead) {
        // Link identity to existing lead
        await supabase.from('communication_participant_identities')
          .update({ sf_lead_id: existingLead.id, updated_at: new Date().toISOString() })
          .eq('id', identity.id)
        return { type: 'lead', id: existingLead.id, created: false }
      }
    }

    // 5. No match → create new SF lead
    // Get default pipeline + first stage
    const { data: pipeline } = await supabase.from('lead_pipelines')
      .select('id').eq('user_id', userId).eq('is_default', true).maybeSingle()
    if (!pipeline) {
      logger.warn('[LB Lead] No default pipeline for user', userId)
      return null
    }

    // Determine stage: "Contacted" if messages exist (communication started), else "New Lead"
    const { data: stages } = await supabase.from('lead_stages')
      .select('id, name, position').eq('pipeline_id', pipeline.id).order('position', { ascending: true })
    if (!stages?.length) {
      logger.warn('[LB Lead] No stages in default pipeline', pipeline.id)
      return null
    }

    // Use automation rules for initial stage, fall back to defaults
    let stage = stages[0] // default: first stage
    const eventType = message ? 'first_reply_sent' : 'lead_received'

    // Check automation rules
    const { data: rule } = await supabase.from('lead_stage_automation_rules')
      .select('target_stage_id').eq('user_id', userId).eq('event_type', eventType)
      .eq('enabled', true).in('channel', [channel, 'all']).limit(1).maybeSingle()

    if (rule) {
      const matchedStage = stages.find(s => s.id === rule.target_stage_id)
      if (matchedStage) stage = matchedStage
    } else {
      // Fallback: contacted if message exists, new lead otherwise
      const contactedStage = stages.find(s => s.name === 'Contacted' || s.position === 1)
      const newLeadStage = stages.find(s => s.name === 'New Lead' || s.position === 0)
      stage = (message && contactedStage) ? contactedStage : (newLeadStage || stages[0])
    }

    // Parse name into first/last
    const nameParts = (customerName || '').trim().split(/\s+/)
    const firstName = nameParts[0] || null
    const lastName = nameParts.slice(1).join(' ') || null

    const source = channel === 'yelp' ? 'leadbridge_yelp' : 'leadbridge_thumbtack'

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

    if (error) {
      logger.error('[LB Lead] Create error:', error.message)
      return null
    }

    // Link identity to new lead
    await supabase.from('communication_participant_identities')
      .update({ sf_lead_id: newLead.id, updated_at: new Date().toISOString() })
      .eq('id', identity.id)

    logger.log(`[LB Lead] Created lead ${newLead.id} for ${customerName} (${source})`)
    return { type: 'new_lead', id: newLead.id, created: true }
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
        reconnect_required: !outboundResult.registered,
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

  async function buildIntegrationStatus(userId) {
    const settings = await getLbSettings(userId)
    const connected = Boolean(settings?.leadbridge_connected)
    if (!connected) {
      return {
        leadbridge_connected: false,
        direction_inbound: { active: false, accounts: 0 },
        direction_outbound: { active: false },
        reconnect_required: false,
      }
    }

    const { count: accountCount } = await supabase
      .from('communication_provider_accounts')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId).eq('provider', 'leadbridge').eq('status', 'active')

    const { data: outboundRow } = await supabase
      .from('communication_settings')
      .select([
        'leadbridge_outbound_subscription_id',
        'leadbridge_outbound_registered_at',
        'leadbridge_outbound_last_event_at',
      ].join(','))
      .eq('user_id', userId).maybeSingle()

    const outboundActive = Boolean(outboundRow?.leadbridge_outbound_subscription_id)

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
        subscription_id: outboundRow?.leadbridge_outbound_subscription_id || null,
        registered_at: outboundRow?.leadbridge_outbound_registered_at || null,
        last_event_at: outboundRow?.leadbridge_outbound_last_event_at || null,
        backlog: backlogCount || 0,
      },
      reconnect_required: !outboundActive || (deferredCount || 0) > 0,
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
      await supabase.from('communication_settings').update(patch).eq('user_id', userId)

      logger.log(`[LB] Disconnected for user ${userId} (both directions cleared)`)
      res.json({
        success: true,
        direction_inbound: { active: false, accounts: 0 },
        direction_outbound: { active: false },
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
      const result = await registerOutboundSubscription(userId, settings.leadbridge_integration_token)
      if (!result.registered) {
        return res.status(502).json({ error: 'Failed to register outbound subscription', reason: result.reason })
      }
      res.json({
        success: true,
        direction_outbound: {
          active: true,
          subscription_id: result.subscriptionId,
          registered_at: result.registeredAt,
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

      // Phase B: resolve or create SF lead (non-blocking for webhook speed)
      if (identity) {
        resolveOrCreateLead(userId, identity, {
          channel, customerName: participant.name, customerPhone: participant.phone,
          customerEmail: participant.email, message: message.body,
          externalLeadId: thread.external_lead_id,
        }).catch(e => logger.warn(`[LB Webhook] Lead resolution: ${e.message}`))
      }

      // Upsert conversation
      // Resolve provider account for this event
      let resolvedAccountId = null
      if (event.account_id) {
        const { data: pa } = await supabase.from('communication_provider_accounts')
          .select('id').eq('provider', 'leadbridge').eq('external_account_id', event.account_id)
          .eq('status', 'active').maybeSingle()
        resolvedAccountId = pa?.id
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
