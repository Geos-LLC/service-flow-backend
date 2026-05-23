/**
 * Zenbooker Integration Module (Loosely Coupled)
 *
 * Mount: app.use('/api/zenbooker', require('./zenbooker-sync')(supabase, logger))
 * Remove: delete this file + remove the line above = zero breakage
 */

const express = require('express')
const { updateJobStatus, maybeEmitInsertEvent } = require('./services/job-status-service')
const { resolveIdentity } = require('./lib/identity-resolver')
const { FLAGS, isEnabled } = require('./lib/feature-flags')
const { setIdentityCustomer, attemptScoringFallback } = require('./lib/identity-linker')
const { mapJobFinancials, stripDiagnostics } = require('./lib/zenbooker-financial')
const { safeReconcileJobLedger } = require('./lib/zenbooker-ledger-reconcile')
const { mapJobLifecycle, stripLifecycleDiagnostics } = require('./lib/zenbooker-lifecycle')
const {
  COMPLETION_DERIVED_TYPES: LEDGER_COMPLETION_DERIVED_TYPES,
  safeDeleteCompletionDerivedLedger,
} = require('./lib/ledger-immutability')
const { authenticateZenbookerWebhook } = require('./lib/zenbooker-webhook-auth')
const { observe: zbBodyObserve } = require('./lib/zb-body-observe')
const { correlateInboundEcho, isCorrelatable } = require('./lib/zb-outbound-correlation')
const { logDelivery } = require('./lib/delivery-log')
const { markDirty, resolveDirty } = require('./lib/zb-dirty-marker')
const { applyAtomicPaymentWrites } = require('./lib/zb-atomic-writes')
const { recordZbImportAmbiguity, reconcileOrphans } = require('./lib/zb-orphan-reconciliation')
const { normalizePhone: normalizePhoneCanon } = require('./lib/name-normalize')
const { upsertTeamMemberProviderMappingFromZbSync } = require('./lib/team-member-provider-mapping')

const ZB_BASE = 'https://api.zenbooker.com/v1'

// In-memory sync progress tracking (per userId)
const syncProgress = {}

module.exports = (supabase, logger, createLedgerEntriesForCompletedJob, rebuildJobLedger) => {
  const router = express.Router()

  // Fallback when server.js doesn't pass rebuildJobLedger (older builds): use
  // the immutability-safe delete helper so the fallback still preserves settled
  // rows (Constitution §3.1). Insertion is delegated to createLedgerEntries which
  // already filters unbatched siblings via its updated race-check.
  const rebuildLedger = rebuildJobLedger || (async (jobId, userId, { types = LEDGER_COMPLETION_DERIVED_TYPES } = {}) => {
    await safeDeleteCompletionDerivedLedger(supabase, { jobId, types, source: 'zenbooker_fallback_rebuild' })
    if (createLedgerEntriesForCompletedJob) await createLedgerEntriesForCompletedJob(jobId, userId)
  })

  // ══════════════════════════════════════
  // Auth middleware — reuse the app's token
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
  // Zenbooker API Client
  // ══════════════════════════════════════
  async function zbFetch(apiKey, path, params = {}) {
    const url = new URL(`${ZB_BASE}${path}`)
    Object.entries(params).forEach(([k, v]) => { if (v !== undefined && v !== null) url.searchParams.set(k, v) })
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 30000)
    try {
      const res = await fetch(url.toString(), {
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        signal: controller.signal
      })
      if (!res.ok) {
        const body = await res.text().catch(() => '')
        throw new Error(`Zenbooker API ${res.status}: ${body}`)
      }
      return res.json()
    } finally {
      clearTimeout(timer)
    }
  }

  async function zbFetchAll(apiKey, path, params = {}) {
    const all = []
    let cursor = 0
    let page = 0
    while (true) {
      page++
      logger.log(`[Zenbooker] Fetching ${path} page ${page} (cursor=${cursor})`)
      let data
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          data = await zbFetch(apiKey, path, { ...params, cursor, limit: 100 })
          break
        } catch (e) {
          logger.error(`[Zenbooker] Fetch ${path} page ${page} attempt ${attempt} failed: ${e.message}`)
          if (attempt === 3) throw e
          await new Promise(r => setTimeout(r, 2000))
        }
      }
      if (data.results && data.results.length > 0) all.push(...data.results)
      logger.log(`[Zenbooker] Got ${data.results?.length || 0} results, has_more=${data.has_more}`)
      if (!data.has_more || !data.next_cursor) break
      cursor = data.next_cursor
    }
    logger.log(`[Zenbooker] Total ${path}: ${all.length} records`)
    return all
  }

  // ══════════════════════════════════════
  // Field Mappers
  // ══════════════════════════════════════
  function mapTerritory(zb, userId) {
    return {
      user_id: userId,
      name: zb.name || 'Unnamed Territory',
      zenbooker_id: zb.id,
    }
  }

  function mapService(zb, userId) {
    return {
      user_id: userId,
      name: zb.name || 'Unnamed Service',
      description: zb.description || '',
      price: parseFloat(zb.base_price) || 0,
      duration: zb.base_duration || 0,
      zenbooker_id: zb.service_id || zb.id,
      is_active: true,
    }
  }

  function mapTeamMember(zb, userId) {
    const nameParts = (zb.name || '').split(' ')
    return {
      user_id: userId,
      first_name: nameParts[0] || '',
      last_name: nameParts.slice(1).join(' ') || '',
      email: zb.email || '',
      phone: zb.phone || null,
      zenbooker_id: zb.id,
      salary_start_date: null, // Explicit null: DB default is CURRENT_DATE which breaks payroll for historical jobs
    }
  }

  function mapCustomer(zb, userId) {
    const nameParts = (zb.name || '').split(' ')
    const addr = zb.addresses?.[0] || {}
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
    }
  }

  /**
   * Upsert a customer from Zenbooker data with adoption semantics:
   *
   *   1. Match by zenbooker_id → reuse + update non-null fields
   *   2. Match by normalized phone (last 10 digits) → ADOPT the existing SF customer
   *      (set zenbooker_id, fill in missing fields, do not overwrite non-null SF fields)
   *   3. Match by email (case-insensitive) → same adoption
   *   4. Else insert new
   *
   * Prevents duplicate customers when a record is created in SF first, then later
   * synced from Zenbooker.
   *
   * Returns { id, mode: 'existing_by_zb' | 'adopted_by_phone' | 'adopted_by_email' | 'created' | 'error' }
   */
  async function upsertCustomerFromZB(userId, zb) {
    const mapped = mapCustomer(zb, userId)

    // Phase D — resolve identity FIRST through shared lib/identity-resolver
    // with sync-adapter semantics (identity_priority_source='sync').
    // Additive: does not replace the legacy 4-step adoption below; instead,
    // it produces an identity row that we link to the customer after upsert.
    // Ambiguous result → SKIP this ZB customer (conservative; ZB cannot pick).
    let identity = null
    let resolverSkipped = false
    if (isEnabled(FLAGS.IDENTITY_RESOLVER_ZENBOOKER)) {
      try {
        const fullName = [mapped.first_name, mapped.last_name].filter(Boolean).join(' ') || null
        const result = await resolveIdentity(supabase, {
          userId,
          source: 'zenbooker',
          externalId: zb.id,
          phone: mapped.phone,
          email: mapped.email,
          displayName: fullName,
          // Resolver will return ambiguous status with candidates, but the
          // resolver's own ambiguity row uses a generic reason and the
          // resolver-side source_payload is empty. We write a richer,
          // ZB-specific row below via recordZbImportAmbiguity().
          suppressAmbiguityLog: true,
        })
        if (result.status === 'ambiguous') {
          logger.warn(`[Zenbooker] Ambiguous identity for zenbooker_id=${zb.id} reason=${result.reason} candidates=${(result.candidates || []).join(',')} — queuing for operator review (not silently skipping)`)
          // Task 2 — write a structured queue row so the operator can resolve.
          // Idempotent on (user, source='zenbooker', attempted_external_id=zb.id, status='open').
          try {
            await recordZbImportAmbiguity({
              supabase,
              logger,
              userId,
              zbCustomer: zb,
              attemptedPhone: normalizePhoneCanon(mapped.phone),
              candidateIdentityIds: result.candidates || [],
              resolverReason: result.reason || null,
            })
          } catch (e) {
            logger.warn(`[Zenbooker] recordZbImportAmbiguity threw: ${e.message}`)
          }
          resolverSkipped = true
        } else if (result.status === 'matched') {
          identity = result.identity
        } else {
          logger.error(`[Zenbooker] Identity resolver error: ${result.error}`)
        }
      } catch (e) {
        logger.warn(`[Zenbooker] Identity resolver threw: ${e.message}`)
      }
    }
    if (resolverSkipped) {
      return { id: null, mode: 'skipped_ambiguous_identity' }
    }

    // Phase 0 hybrid bridge — graph projection first, scoring fallback
    // second. See docs/architecture/cross-source-identity-reconciliation.md
    // "Hybrid migration bridge" section.
    //
    // Precedence:
    //   1. Identity graph projection (authoritative)
    //        setIdentityCustomer → projectIdentityToCRM when both
    //        sf_lead_id and sf_customer_id are populated on the
    //        identity row.
    //   2. Scoring fallback (TEMPORARY migration bridge)
    //        runs ONLY if graph couldn't project. Strict safety gates;
    //        on success it also HYDRATES the identity graph so future
    //        events for the same person use the graph path directly.
    //        Default ON; per-tenant opt-out via
    //        IDENTITY_SCORING_FALLBACK_TENANTS once a tenant's graph
    //        is complete.
    //
    // Resolver-ambiguous customers (status='ambiguous') never reach this
    // function because upsertCustomerFromZB returned early above with
    // mode='skipped_ambiguous_identity'. That keeps the
    // wrong-non-merge > wrong-merge invariant intact.
    const linkIdentityToCustomer = async (customerId) => {
      if (!customerId) return

      // 1) Graph projection path — only viable when the resolver
      //    produced an identity row.
      let projected = false
      if (identity && identity.sf_customer_id !== customerId) {
        const result = await setIdentityCustomer(supabase, logger, {
          userId,
          identityId: identity.id,
          customerId,
          identitySnapshot: identity,
          policy: {
            resolvedBy: 'graph_projection',
            resolutionReason: 'identity_graph_projection',
            source: 'zenbooker',
            allowStageMove: false,
          },
        })
        projected = !!(result && result.ok && result.projection && result.projection.projected)
      } else if (identity && identity.sf_customer_id === customerId) {
        // Identity already linked to this customer — no work needed.
        // Don't run fallback either: customer is canonical.
        return
      }

      // 2) Scoring fallback — only when graph couldn't project.
      //    Hydrates the identity graph on success.
      if (!projected) {
        const fullName = [mapped.first_name, mapped.last_name].filter(Boolean).join(' ').trim() || zb.name || null
        await attemptScoringFallback(supabase, logger, {
          userId,
          customerId,
          customerPhone: mapped.phone,
          customerName: fullName,
          customerSource: mapped.source || null,
          identityId: identity ? identity.id : null,
          activeWindowHours: 24,
          source: 'zenbooker',
        })
      }
    }

    // 1. Match by zenbooker_id
    {
      const { data: existing } = await supabase.from('customers')
        .select('id, phone, email, address, city, state, zip_code, first_name, last_name')
        .eq('user_id', userId).eq('zenbooker_id', zb.id).maybeSingle()
      if (existing) {
        const updates = {}
        for (const f of ['first_name', 'last_name', 'email', 'phone', 'address', 'city', 'state', 'zip_code']) {
          if (!existing[f] && mapped[f]) updates[f] = mapped[f]
        }
        if (Object.keys(updates).length) {
          await supabase.from('customers').update(updates).eq('id', existing.id)
        }
        await linkIdentityToCustomer(existing.id)
        return { id: existing.id, mode: 'existing_by_zb' }
      }
    }

    // 2. Match by phone (last 10 digits) — adopt existing SF-only customer
    if (mapped.phone) {
      const last10 = String(mapped.phone).replace(/\D/g, '').slice(-10)
      if (last10.length >= 7) {
        const { data: byPhone } = await supabase.from('customers')
          .select('id, zenbooker_id, phone, email, address, city, state, zip_code, first_name, last_name')
          .eq('user_id', userId).is('zenbooker_id', null)
          .ilike('phone', `%${last10}%`)
          .limit(1).maybeSingle()
        if (byPhone) {
          const updates = { zenbooker_id: zb.id }
          for (const f of ['first_name', 'last_name', 'email', 'address', 'city', 'state', 'zip_code']) {
            if (!byPhone[f] && mapped[f]) updates[f] = mapped[f]
          }
          // Only rewrite phone if SF's current value is empty (preserve user-edited formatting)
          if (!byPhone.phone && mapped.phone) updates.phone = mapped.phone
          await supabase.from('customers').update(updates).eq('id', byPhone.id)
          logger.log(`[Zenbooker] Adopted existing SF customer ${byPhone.id} by phone ${last10} → zb_id ${zb.id}`)
          await linkIdentityToCustomer(byPhone.id)
          return { id: byPhone.id, mode: 'adopted_by_phone' }
        }
      }
    }

    // 3. Match by email — adopt existing SF-only customer
    if (mapped.email) {
      const { data: byEmail } = await supabase.from('customers')
        .select('id, zenbooker_id, phone, email, address, city, state, zip_code, first_name, last_name')
        .eq('user_id', userId).is('zenbooker_id', null)
        .ilike('email', mapped.email)
        .limit(1).maybeSingle()
      if (byEmail) {
        const updates = { zenbooker_id: zb.id }
        for (const f of ['first_name', 'last_name', 'phone', 'address', 'city', 'state', 'zip_code']) {
          if (!byEmail[f] && mapped[f]) updates[f] = mapped[f]
        }
        await supabase.from('customers').update(updates).eq('id', byEmail.id)
        logger.log(`[Zenbooker] Adopted existing SF customer ${byEmail.id} by email ${mapped.email} → zb_id ${zb.id}`)
        await linkIdentityToCustomer(byEmail.id)
        return { id: byEmail.id, mode: 'adopted_by_email' }
      }
    }

    // 4. Insert new
    const { data: inserted, error } = await supabase.from('customers').insert(mapped).select('id').single()
    if (error) {
      logger.error(`[Zenbooker] Customer insert error ${zb.name}: ${JSON.stringify(error)}`)
      return { id: null, mode: 'error', error }
    }
    await linkIdentityToCustomer(inserted.id)
    // Lead↔customer reconciliation is handled by the hybrid bridge in
    // linkIdentityToCustomer above (graph projection first, scoring
    // fallback second). When IDENTITY_RESOLVER_ZENBOOKER is ON and the
    // resolver's CRM-anchor preference adopted an identity that already
    // had sf_lead_id, setIdentityCustomer projects to
    // leads.converted_customer_id automatically (mode=graph_projection).
    // Otherwise attemptScoringFallback bridges the gap and also hydrates
    // the identity graph (mode=fallback_projection_bridge) so future
    // events use the graph path. Operator-triggered
    // POST /api/identity-conflicts/repair-lead-links remains available
    // for evidence-based bulk repair (dry-run by default).
    return { id: inserted.id, mode: 'created' }
  }

  // Map Zenbooker statuses to internal statuses
  // IMPORTANT: The codebase relies on 'completed' (not 'complete') in 50+ places
  // for payroll, ledger, revenue, analytics. Never change 'complete' → anything other than 'completed'.
  const STATUS_MAP = {
    'scheduled': 'scheduled',
    'rescheduled': 'rescheduled',
    'en-route': 'en-route',
    'en_route': 'en-route',
    'enroute': 'en-route',
    'started': 'started',
    'in-progress': 'started',
    'late': 'late',
    'complete': 'completed',
    'completed': 'completed',
  }

  // Convert UTC ISO date to local time string "YYYY-MM-DD HH:MM:SS" in the job's timezone
  function zbDateToLocal(isoDate, timezone) {
    if (!isoDate) return null
    try {
      const d = new Date(isoDate)
      // Use Intl to convert to timezone
      const opts = { timeZone: timezone || 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }
      const parts = new Intl.DateTimeFormat('en-CA', opts).formatToParts(d)
      const get = (type) => (parts.find(p => p.type === type) || {}).value || '00'
      return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`
    } catch {
      // Fallback: strip T and Z
      return isoDate.replace('T', ' ').replace(/\.000Z$/, '').replace('Z', '')
    }
  }

  // Normalize ZB invoice.adjustments_applied[] into our fees_breakdown shape.
  // ZB shape: { id, name, adjustment_type: 'fee'|..., value, value_type, adjustment_amount }
  // Stored shape: [{ name, type, amount, rate?, rate_type? }]
  // Type 'fee' = third-party fee (Stripe processing etc.) — excluded from cleaner commission.
  function mapAdjustments(adjustments) {
    if (!Array.isArray(adjustments) || adjustments.length === 0) return null
    return adjustments.map(a => ({
      name: a.name || null,
      type: a.adjustment_type || 'fee',
      amount: parseFloat(a.adjustment_amount) || 0,
      rate: a.value != null ? parseFloat(a.value) : null,
      rate_type: a.value_type || null,
      zb_id: a.id || null,
    }))
  }

  function mapJob(zb, userId, lookups, options = {}) {
    const { customerMap, serviceMap, teamMap, territoryMap } = lookups
    const status = zb.canceled ? 'cancelled' : (STATUS_MAP[(zb.status || '').toLowerCase()] || 'pending')
    const inv = zb.invoice || {}
    const addr = zb.service_address || {}
    const assignedProvider = zb.assigned_providers?.[0]

    // Lookup internal IDs from zenbooker IDs
    const customerId = zb.customer?.id ? customerMap[zb.customer.id] : null
    const territoryId = zb.territory?.id ? territoryMap[zb.territory.id] : null
    const teamMemberId = assignedProvider?.id ? teamMap[assignedProvider.id] : null

    // Find service by name match (Zenbooker uses service_name on jobs, not service ID)
    let serviceId = null
    if (zb.service_name) {
      const found = Object.entries(serviceMap).find(([, v]) => v.name === zb.service_name)
      if (found) serviceId = found[1].id
    }

    // Financial fields go through the centralized helper so every sync path
    // (this mapper + handlePaymentEvent + runPaymentReconcile + reconcile-job
    // endpoint) writes the same set with the same tip rule. Pass the existing
    // SF tip amount (when available) so the preserve-SF rule fires correctly.
    const financials = stripDiagnostics(mapJobFinancials(zb, {
      existingSfTipAmount: options.existingSfTipAmount,
    }))

    const mapped = {
      user_id: userId,
      customer_id: customerId,
      service_id: serviceId,
      service_name: zb.service_name || '',
      team_member_id: teamMemberId,
      territory_id: territoryId,
      status,
      scheduled_date: zbDateToLocal(zb.start_date, zb.timezone),
      service_address_street: addr.line1 || addr.formatted || '',
      service_address_city: addr.city || '',
      service_address_state: addr.state || '',
      service_address_zip: addr.postal_code || '',
      ...financials,
      invoice_status: inv.status === 'paid' ? 'paid' : (inv.status === 'unpaid' ? 'invoiced' : 'draft'),
      payment_status: inv.status === 'paid' ? 'paid' : (parseFloat(inv.amount_paid) > 0 ? 'partial' : null),
      is_recurring: zb.recurring === true,
      zenbooker_id: zb.id,
    }
    // Real timestamps from Zenbooker (started_at, completed_at)
    if (zb.started_at) mapped.start_time = zb.started_at
    if (zb.completed_at) mapped.end_time = zb.completed_at

    // Bedrooms, bathrooms, add-ons, and service fields from ZB service_fields
    // ZB uses service_fields[] with field_name + selected_options[].text
    const serviceFields = zb.service_fields || []
    if (Array.isArray(serviceFields) && serviceFields.length > 0) {
      mapped.zenbooker_intake = serviceFields
      const addons = []
      for (const field of serviceFields) {
        const name = (field.field_name || '').toLowerCase()
        const selected = (field.selected_options || [])[0]
        if (!selected) continue
        const optionText = selected.text || selected.display_label || ''
        // Extract number from text like "2 Bedrooms" or "1 Bathroom"
        const num = parseInt(optionText) || null
        if (name.includes('bedroom')) {
          mapped.bedroom_count = num
        } else if (name.includes('bathroom')) {
          mapped.bathroom_count = num
        }
        // Collect all service_modifier fields as add-ons for display
        if (field.field_type === 'service_modifier' && !name.includes('bedroom') && !name.includes('bathroom')) {
          addons.push({
            name: field.field_name,
            value: optionText,
            price: parseFloat(selected.total_price || selected.price || 0),
            quantity: parseInt(selected.quantity) || 1,
          })
        }
      }
      if (addons.length > 0) mapped.addons = addons
    }

    return mapped
  }

  // ══════════════════════════════════════
  // Sync Engine
  // ══════════════════════════════════════
  const stripPhone = (p) => (p || '').replace(/\D/g, '').slice(-10) // last 10 digits

  // Find existing record by zenbooker_id first, then by natural key (name, email, phone)
  async function findOrLink(table, userId, zbId, naturalMatch) {
    // 1. Already linked by zenbooker_id
    const { data: linked } = await supabase.from(table).select('id').eq('user_id', userId).eq('zenbooker_id', zbId).maybeSingle()
    if (linked) return { id: linked.id, wasLinked: true }

    // 2. Try natural key match (existing record without zenbooker_id)
    if (naturalMatch) {
      // Phone matching: strip to last 10 digits and search
      if (naturalMatch.phone) {
        const digits = stripPhone(naturalMatch.phone)
        if (digits.length >= 7) {
          const { data: allUnlinked } = await supabase.from(table).select('id, phone').eq('user_id', userId).is('zenbooker_id', null).not('phone', 'is', null)
          const phoneMatch = (allUnlinked || []).find(r => stripPhone(r.phone) === digits)
          if (phoneMatch) {
            await supabase.from(table).update({ zenbooker_id: zbId }).eq('id', phoneMatch.id)
            return { id: phoneMatch.id, wasLinked: false, newlyLinked: true }
          }
        }
        // If phone didn't match, don't fall through to other fields
        return null
      }

      // Non-phone matching (name, email)
      let q = supabase.from(table).select('id').eq('user_id', userId).is('zenbooker_id', null)
      Object.entries(naturalMatch).forEach(([k, v]) => {
        if (v) q = q.ilike(k, v)
      })
      const { data: matched } = await q.limit(1).maybeSingle()
      if (matched) {
        await supabase.from(table).update({ zenbooker_id: zbId }).eq('id', matched.id)
        return { id: matched.id, wasLinked: false, newlyLinked: true }
      }
    }

    return null
  }

  async function syncTerritories(userId, apiKey) {
    const zbTerritories = await zbFetchAll(apiKey, '/territories')
    let created = 0, skipped = 0, adopted = 0, errors = 0
    for (const zb of zbTerritories) {
      try {
        // 1. Already linked by zenbooker_id → skip
        const { data: existing } = await supabase.from('territories').select('id').eq('user_id', userId).eq('zenbooker_id', zb.id).maybeSingle()
        if (existing) { skipped++; continue }

        const mapped = mapTerritory(zb, userId)

        // 2. Adopt an existing same-name territory that isn't yet linked to ZB.
        //    Avoids creating duplicates when the operator manually created the
        //    territory in SF before connecting Zenbooker (e.g. two "Tampa" rows).
        const trimmedName = (mapped.name || '').trim()
        if (trimmedName) {
          const { data: nameMatches } = await supabase
            .from('territories')
            .select('id, location, business_hours, zip_codes, timezone, radius_miles, services, team_members, pricing_multiplier, status, description')
            .eq('user_id', userId)
            .is('zenbooker_id', null)
            .ilike('name', trimmedName)
          const nameMatch = (nameMatches || [])[0]
          if (nameMatch) {
            // Fill blanks from ZB; never overwrite values the operator already set
            const adoption = { zenbooker_id: zb.id }
            const fillIfEmpty = (key) => {
              if (mapped[key] === undefined || mapped[key] === null) return
              const cur = nameMatch[key]
              const isEmpty = cur === null || cur === undefined
                || (typeof cur === 'string' && cur.trim() === '')
                || (Array.isArray(cur) && cur.length === 0)
              if (isEmpty) adoption[key] = mapped[key]
            }
            ;['location', 'business_hours', 'zip_codes', 'timezone', 'radius_miles', 'services', 'team_members', 'pricing_multiplier', 'description'].forEach(fillIfEmpty)
            const { error: adoptErr } = await supabase.from('territories').update(adoption).eq('id', nameMatch.id)
            if (adoptErr) { logger.error(`[Zenbooker] Territory adopt error for ${zb.name}: ${JSON.stringify(adoptErr)}`); errors++ }
            else { adopted++; logger.log(`[Zenbooker] Adopted existing territory id=${nameMatch.id} (${zb.name}) → linked to zb ${zb.id}`) }
            continue
          }
        }

        // 3. Otherwise insert fresh
        const { error } = await supabase.from('territories').insert(mapped)
        if (error) { logger.error(`[Zenbooker] Territory insert error: ${JSON.stringify(error)}`); errors++ }
        else created++
      } catch (err) {
        logger.error(`[Zenbooker] Territory CRASH ${zb.name}: ${err.message}`); errors++
      }
    }
    return { total: zbTerritories.length, created, skipped, adopted, errors }
  }

  async function syncServices(userId, apiKey) {
    const zbServices = await zbFetchAll(apiKey, '/services')
    let created = 0, skipped = 0, errors = 0
    for (const zb of zbServices) {
      const zbId = zb.service_id || zb.id
      const { data: existing } = await supabase.from('services').select('id').eq('user_id', userId).eq('zenbooker_id', zbId).maybeSingle()
      if (existing) { skipped++; continue }
      const mapped = mapService(zb, userId)
      const { error } = await supabase.from('services').insert(mapped)
      if (error) { logger.error(`[Zenbooker] Service insert error: ${JSON.stringify(error)}`); errors++ }
      else created++
    }
    return { total: zbServices.length, created, skipped, errors }
  }

  async function syncTeamMembers(userId, apiKey) {
    const zbTeam = await zbFetchAll(apiKey, '/team_members')
    // Pre-fetch account owner email to avoid creating team members with owner's email
    const { data: ownerData } = await supabase.from('users').select('email').eq('id', userId).single()
    const ownerEmail = (ownerData?.email || '').toLowerCase().trim()
    let created = 0, skipped = 0, errors = 0, mappingsUpserted = 0
    for (const zb of zbTeam) {
      if (!zb || !zb.id) continue
      const { data: existing } = await supabase.from('team_members').select('id').eq('user_id', userId).eq('zenbooker_id', zb.id).maybeSingle()
      if (existing) {
        skipped++
        // Defensive: refresh the outbound mapping registry for already-known
        // team members. Fills any gap left by team_members rows created post
        // the migration-045 backfill (see Lesia Tampa repair, 2026-05-22).
        const mapRes = await upsertTeamMemberProviderMappingFromZbSync(supabase, logger, {
          userId,
          sfTeamMemberId: existing.id,
          zenbookerProviderId: zb.id,
          isActive: true,
        })
        if (mapRes && mapRes.mode === 'upserted') mappingsUpserted++
        continue
      }
      const mapped = mapTeamMember(zb, userId)
      // Clear email if it matches the account owner to prevent role conflicts on login
      if (ownerEmail && (mapped.email || '').toLowerCase().trim() === ownerEmail) {
        logger.log(`[Zenbooker] Clearing owner email from team member ${zb.name} to avoid role conflict`)
        mapped.email = ''
      }
      // Insert with .select() so we have the new id for the mapping mirror below.
      const { data: insertedRow, error } = await supabase.from('team_members').insert(mapped).select('id').maybeSingle()
      if (error) {
        logger.error(`[Zenbooker] Team insert error ${zb.name}: ${JSON.stringify(error)}`)
        errors++
        continue
      }
      created++
      // Mirror into outbound mapping registry so SF→ZB commands can resolve
      // this provider without joining team_members at runtime.
      if (insertedRow && insertedRow.id) {
        const mapRes = await upsertTeamMemberProviderMappingFromZbSync(supabase, logger, {
          userId,
          sfTeamMemberId: insertedRow.id,
          zenbookerProviderId: zb.id,
          isActive: true,
        })
        if (mapRes && mapRes.mode === 'upserted') mappingsUpserted++
      }
    }
    return { total: zbTeam.length, created, skipped, errors, mappingsUpserted }
  }

  async function syncCustomers(userId, apiKey) {
    const zbCustomers = await zbFetchAll(apiKey, '/customers')
    let created = 0, skipped = 0, adopted = 0, errors = 0, archived = 0
    const total = zbCustomers.length
    let processed = 0
    const seenZbIds = new Set()
    for (const zb of zbCustomers) {
      processed++
      if (processed % 20 === 0) {
        syncProgress[userId] = { ...syncProgress[userId], phase: `Customers (${processed}/${total})`, detail: `${created} new, ${adopted} adopted, ${skipped} skipped` }
      }
      if (zb?.id) seenZbIds.add(zb.id)
      const result = await upsertCustomerFromZB(userId, zb)
      if (result.mode === 'created') created++
      else if (result.mode === 'existing_by_zb') skipped++
      else if (result.mode === 'adopted_by_phone' || result.mode === 'adopted_by_email') adopted++
      else if (result.mode === 'error') errors++
    }

    // Detect deletions: SF customers with a zenbooker_id that no longer
    // appears in ZB's response. Only run if pagination completed without
    // wholesale errors (avoid mass-archiving on partial pulls).
    if (errors === 0 && total > 0) {
      try {
        // Pull all SF customers with a zenbooker_id (paginate to avoid 1000-row cap)
        const sfZbCustomers = []
        let from = 0
        const pageSize = 1000
        while (true) {
          const { data } = await supabase.from('customers')
            .select('id, zenbooker_id, status').eq('user_id', userId)
            .not('zenbooker_id', 'is', null)
            .range(from, from + pageSize - 1)
          if (!data?.length) break
          sfZbCustomers.push(...data)
          if (data.length < pageSize) break
          from += pageSize
        }
        const toArchive = sfZbCustomers.filter(c =>
          c.status !== 'archived' && !seenZbIds.has(c.zenbooker_id)
        )
        // Safety threshold — if more than 10% of ZB-linked customers would be
        // archived, abort and warn. ZB pagination glitches shouldn't nuke
        // everyone's CRM.
        const ratio = sfZbCustomers.length > 0 ? toArchive.length / sfZbCustomers.length : 0
        if (ratio > 0.1) {
          logger.warn(`[Zenbooker] Deletion-detection aborted: would archive ${toArchive.length}/${sfZbCustomers.length} (${(ratio*100).toFixed(1)}%) — sanity threshold 10% exceeded. Skipping to avoid mass-archive.`)
        } else if (toArchive.length > 0) {
          for (const c of toArchive) {
            await supabase.from('customers')
              .update({ status: 'archived', updated_at: new Date().toISOString() })
              .eq('id', c.id)
            archived++
          }
          logger.log(`[Zenbooker] Archived ${archived} customers no longer present in ZB.`)
        }
      } catch (e) {
        logger.error('[Zenbooker] Deletion-detection step failed:', e?.message || e)
      }
    }

    return { total: zbCustomers.length, created, adopted, skipped, errors, archived }
  }

  async function syncTransactions(userId, apiKey) {
    const zbTransactions = await zbFetchAll(apiKey, '/transactions')
    logger.log(`[Zenbooker] Fetched ${zbTransactions.length} transactions`)

    // Track jobs that got new cash transactions — they need ledger rebuild
    const jobsNeedingLedgerRebuild = new Set()

    // Build lookup: ZB invoice_id → SF job (via jobs.zenbooker_id matching the ZB job that owns the invoice)
    // ZB transactions have invoice_id, ZB invoices belong to jobs
    // We need to map ZB invoice_id → ZB job_id → SF job_id
    // Simplest: fetch all SF jobs with zenbooker_id, then for each ZB transaction find the job
    const { data: sfJobs } = await supabase.from('jobs').select('id, zenbooker_id, customer_id, invoice_id').eq('user_id', userId).not('zenbooker_id', 'is', null)
    const { data: sfCustomers } = await supabase.from('customers').select('id, zenbooker_id').eq('user_id', userId).not('zenbooker_id', 'is', null)
    const customerMap = {}; (sfCustomers || []).forEach(c => { customerMap[c.zenbooker_id] = c.id })

    // Build invoice → job map from ZB data: each job has invoice.id
    // We already have the ZB jobs data from the full sync, but here we just need invoice→job mapping
    // The ZB transaction has invoice_id — we need to find which SF job has that invoice
    // Since we store zenbooker_id on jobs (which is the ZB job ID, not invoice ID),
    // we need to fetch ZB jobs to get their invoice IDs
    const zbJobs = await zbFetchAll(apiKey, '/jobs')
    const zbInvoiceToJob = {}
    zbJobs.forEach(j => {
      if (j.invoice?.id) zbInvoiceToJob[j.invoice.id] = j.id
    })
    const sfJobByZbId = {}; (sfJobs || []).forEach(j => { sfJobByZbId[j.zenbooker_id] = j })

    let created = 0, updated = 0, skipped = 0, errors = 0
    for (const zbt of zbTransactions) {
      const zbJobId = zbInvoiceToJob[zbt.invoice_id]
      const sfJob = zbJobId ? sfJobByZbId[zbJobId] : null
      const sfCustomerId = zbt.customer_id ? customerMap[zbt.customer_id] : (sfJob?.customer_id || null)

      const txData = {
        user_id: userId,
        job_id: sfJob?.id || null,
        invoice_id: sfJob?.invoice_id || null,
        customer_id: sfCustomerId,
        amount: parseFloat(zbt.amount) || 0,
        payment_method: zbt.custom_payment_method_name || zbt.payment_method || 'other',
        payment_intent_id: zbt.stripe_transaction_id || `zb_${zbt.id}`,
        status: zbt.status === 'succeeded' ? 'completed' : zbt.status,
        notes: zbt.memo || null,
        zenbooker_id: zbt.id,
        created_at: zbt.payment_date || zbt.created
      }

      // Resolve the real payment method name (custom_payment_method_name has the actual name like "Zelle BofA")
      const resolvedPaymentMethod = zbt.custom_payment_method_name || zbt.payment_method

      // P1.3 — single atomic write covers all three branches (update-by-zb-id,
      // adopt-manual, new insert). The RPC's tx-upsert logic handles the
      // dedup ladder server-side; jobs UPDATE only fires if a real method
      // is resolved (matching the original "skip bare 'custom'" rule).
      const wantsJobUpdate = sfJob?.id && resolvedPaymentMethod && resolvedPaymentMethod !== 'custom'
      const jobUpdates = wantsJobUpdate
        ? { payment_method: resolvedPaymentMethod, payment_status: 'paid' }
        : null

      // Pre-check existing tx so we can decide whether this iteration counts
      // as updated/created/skipped + whether ledger rebuild is needed.
      // The RPC is still authoritative for the dedup; this pre-check is just
      // for diagnostics + ledger-rebuild trigger.
      const { data: preExisting } = sfJob?.id
        ? await supabase.from('transactions').select('id, payment_method').eq('zenbooker_id', zbt.id).maybeSingle()
        : { data: null }
      const priorMethod = preExisting?.payment_method ?? null

      const atomicResult = await applyAtomicPaymentWrites(supabase, {
        userId,
        sfJobId: sfJob?.id ?? null,
        jobUpdates,
        txDataArray: [{
          job_id: sfJob?.id || null,
          customer_id: sfCustomerId,
          amount: txData.amount,
          payment_method: txData.payment_method,
          payment_intent_id: txData.payment_intent_id,
          status: txData.status,
          notes: txData.notes,
          zenbooker_id: txData.zenbooker_id,
          created_at: txData.created_at,
        }],
        logger,
      })

      if (!atomicResult.ok) {
        if (sfJob?.id) {
          await markDirty(supabase, {
            userId, sfJobId: sfJob.id, zenbookerId: zbt.id,
            operation: 'transaction_payment_method', error: atomicResult.error, logger,
            context: { source: 'syncTransactions:atomic_rollback', resolved_method: resolvedPaymentMethod },
          })
        }
        errors++
        continue
      }
      const action = atomicResult.result?.tx_actions?.[0]?.action || 'no_tx'
      if (action === 'inserted') created++
      else if (action === 'updated_by_zb_id' || action === 'adopted') updated++
      else skipped++

      if (wantsJobUpdate) {
        await resolveDirty(supabase, { userId, sfJobId: sfJob.id, operation: 'transaction_payment_method', note: `resolved via atomic ${action}` })
        await resolveDirty(supabase, { userId, sfJobId: sfJob.id, operation: 'payment_status_update', note: `resolved via atomic ${action}` })
      }
      // Ledger-rebuild triggers — same intent as pre-P1.3 but driven from the atomic result.
      if (sfJob?.id) {
        const newMethod = txData.payment_method
        if (action === 'inserted') {
          jobsNeedingLedgerRebuild.add(sfJob.id)
        } else if ((action === 'updated_by_zb_id' || action === 'adopted') && priorMethod !== newMethod) {
          jobsNeedingLedgerRebuild.add(sfJob.id)
        }
      }
    }

    // Rebuild ledger for jobs that got new transactions
    // (cash payments need cash_collected entries to be created)
    let ledgerRebuilt = 0
    if (createLedgerEntriesForCompletedJob) {
      for (const jobId of jobsNeedingLedgerRebuild) {
        try {
          await rebuildLedger(jobId, userId, { types: ['earning', 'tip', 'incentive', 'cash_collected'] })
          ledgerRebuilt++
          await resolveDirty(supabase, { userId, sfJobId: jobId, operation: 'ledger_rebuild', note: 'resolved after tx sync' })
        } catch (e) {
          await markDirty(supabase, {
            userId, sfJobId: jobId, zenbookerId: null,
            operation: 'ledger_rebuild', error: e, logger,
            context: { source: 'syncTransactions:rebuild_loop' },
          })
        }
      }
      logger.log(`[Zenbooker] Rebuilt ledger for ${ledgerRebuilt} jobs with new transactions`)
    }

    return { total: zbTransactions.length, created, updated, skipped, errors, ledgerRebuilt }
  }

  async function syncJobs(userId, apiKey, params = {}, maxJobs = 0) {
    // Build lookup maps: zenbooker_id → internal record
    const { data: customers } = await supabase.from('customers').select('id, zenbooker_id').eq('user_id', userId).not('zenbooker_id', 'is', null)
    const { data: services } = await supabase.from('services').select('id, name, zenbooker_id').eq('user_id', userId).not('zenbooker_id', 'is', null)
    const { data: team } = await supabase.from('team_members').select('id, zenbooker_id').eq('user_id', userId).not('zenbooker_id', 'is', null)
    const { data: territories } = await supabase.from('territories').select('id, zenbooker_id').eq('user_id', userId).not('zenbooker_id', 'is', null)

    const customerMap = {}; (customers || []).forEach(c => { customerMap[c.zenbooker_id] = c.id })
    const serviceMap = {}; (services || []).forEach(s => { serviceMap[s.zenbooker_id] = { id: s.id, name: s.name } })
    const teamMap = {}; (team || []).forEach(t => { teamMap[t.zenbooker_id] = t.id })
    const territoryMap = {}; (territories || []).forEach(t => { territoryMap[t.zenbooker_id] = t.id })
    const lookups = { customerMap, serviceMap, teamMap, territoryMap }

    let zbJobs
    if (maxJobs > 0) {
      // Fetch only what we need (single page)
      const data = await zbFetch(apiKey, '/jobs', { ...params, limit: Math.min(maxJobs, 100) })
      zbJobs = (data.results || []).slice(0, maxJobs)
    } else {
      zbJobs = await zbFetchAll(apiKey, '/jobs', params)
    }
    let created = 0, skipped = 0, errors = 0
    const jobTotal = zbJobs.length
    let jobProcessed = 0
    for (const zb of zbJobs) {
      jobProcessed++
      if (jobProcessed % 20 === 0 || jobProcessed === 1) {
        const pct = Math.round(60 + (jobProcessed / jobTotal) * 35)
        syncProgress[userId] = { ...syncProgress[userId], phase: `Jobs (${jobProcessed}/${jobTotal})`, progress: pct, detail: `${created} new, ${skipped} skipped` }
      }

      // Skip if already exists
      const { data: existing } = await supabase.from('jobs').select('id').eq('user_id', userId).eq('zenbooker_id', zb.id).maybeSingle()
      if (existing) { skipped++; continue }

      const mapped = mapJob(zb, userId, lookups)
      const { data: newJob, error } = await supabase.from('jobs').insert(mapped).select('id').single()
      if (error) { logger.error(`[Zenbooker] Job insert error ${zb.id}: ${JSON.stringify(error)}`); errors++ }
      else {
        created++
        // Create job_team_assignments for ALL assigned providers (not just the first)
        const providers = zb.assigned_providers || []
        if (providers.length > 1 && newJob?.id) {
          const assignments = providers
            .map(p => ({ job_id: newJob.id, team_member_id: teamMap[p.id], is_primary: p.id === providers[0]?.id }))
            .filter(a => a.team_member_id)
          if (assignments.length > 1) {
            const { error: assignErr } = await supabase.from('job_team_assignments').insert(assignments)
            if (assignErr) logger.error(`[Zenbooker] Assignment insert error job ${zb.id}: ${JSON.stringify(assignErr)}`)
          }
        }
      }
    }
    return { total: zbJobs.length, created, skipped, errors }
  }

  async function runFullSync(userId, apiKey) {
    const results = {}
    syncProgress[userId] = { status: 'running', phase: 'starting', progress: 0 }
    logger.log(`[Zenbooker] Starting full sync for user ${userId}`)

    try {
      const updateProgress = (phase, progress, detail) => {
        syncProgress[userId] = { status: 'running', phase, progress, detail: detail || null, results }
      }

      updateProgress('Territories', 5)
      logger.log('[Zenbooker] Syncing territories...')
      results.territories = await syncTerritories(userId, apiKey)
      logger.log(`[Zenbooker] Territories done: ${JSON.stringify(results.territories)}`)

      updateProgress('Services', 15, `Territories: ${results.territories.total}`)
      logger.log('[Zenbooker] Syncing services...')
      results.services = await syncServices(userId, apiKey)
      logger.log(`[Zenbooker] Services done: ${JSON.stringify(results.services)}`)

      updateProgress('Team Members', 25, `Services: ${results.services.total}`)
      logger.log('[Zenbooker] Syncing team members...')
      results.teamMembers = await syncTeamMembers(userId, apiKey)
      logger.log(`[Zenbooker] Team members done: ${JSON.stringify(results.teamMembers)}`)

      updateProgress('Customers', 40, `Team: ${results.teamMembers.total}`)
      logger.log('[Zenbooker] Syncing customers...')
      results.customers = await syncCustomers(userId, apiKey)
      logger.log(`[Zenbooker] Customers done: ${JSON.stringify(results.customers)}`)

      updateProgress('Jobs', 60, `Customers: ${results.customers.total}`)
      logger.log('[Zenbooker] Syncing jobs...')
      results.jobs = await syncJobs(userId, apiKey)
      logger.log(`[Zenbooker] Jobs done: ${JSON.stringify(results.jobs)}`)

      // Update last sync timestamp
      await supabase.from('users').update({ zenbooker_last_sync: new Date().toISOString() }).eq('id', userId)

      syncProgress[userId] = { status: 'complete', progress: 100, results }
      setTimeout(() => { delete syncProgress[userId] }, 300000) // cleanup after 5 min

      return results
    } catch (err) {
      logger.error(`[Zenbooker] Sync failed at phase: ${syncProgress[userId]?.phase || 'unknown'}: ${err.message}`)
      syncProgress[userId] = { status: 'error', error: err.message, phase: syncProgress[userId]?.phase }
      setTimeout(() => { delete syncProgress[userId] }, 300000)
      throw err
    }
  }

  // ══════════════════════════════════════
  // Webhook Handlers
  // ══════════════════════════════════════
  async function handleJobEvent(eventType, data, userId, apiKey) {
    // ZZB may send job ID as 'id', 'job_id', or nested in 'job.id'
    const jobZbId = data?.id || data?.job_id || data?.job?.id
    if (!jobZbId) {
      logger.error(`[Zenbooker] handleJobEvent: no job ID found in ${eventType} payload: ${JSON.stringify(data).substring(0, 200)}`)
      return
    }
    data.id = jobZbId

    // For created/rescheduled/status changes — fetch full job from API for complete data
    let zbJob = data
    try {
      zbJob = await zbFetch(apiKey, `/jobs/${data.id}`)
    } catch {
      // Use webhook payload as fallback
    }

    // Build lookup maps
    const { data: customers } = await supabase.from('customers').select('id, zenbooker_id').eq('user_id', userId).not('zenbooker_id', 'is', null)
    const { data: services } = await supabase.from('services').select('id, name, zenbooker_id').eq('user_id', userId).not('zenbooker_id', 'is', null)
    const { data: team } = await supabase.from('team_members').select('id, zenbooker_id').eq('user_id', userId).not('zenbooker_id', 'is', null)
    const { data: territories } = await supabase.from('territories').select('id, zenbooker_id').eq('user_id', userId).not('zenbooker_id', 'is', null)

    const customerMap = {}; (customers || []).forEach(c => { customerMap[c.zenbooker_id] = c.id })
    const serviceMap = {}; (services || []).forEach(s => { serviceMap[s.zenbooker_id] = { id: s.id, name: s.name } })
    const teamMap = {}; (team || []).forEach(t => { teamMap[t.zenbooker_id] = t.id })
    const territoryMap = {}; (territories || []).forEach(t => { territoryMap[t.zenbooker_id] = t.id })

    // Fetch the existing SF row first so the financial mapper can apply the
    // preserve-SF tip rule (don't overwrite a non-zero manual tip with a
    // computed implicit tip when ZB itself reports tip=0).
    const { data: existing } = await supabase.from('jobs').select('id, status, tip_amount').eq('user_id', userId).eq('zenbooker_id', data.id).maybeSingle()

    const mapped = mapJob(zbJob, userId, { customerMap, serviceMap, teamMap, territoryMap }, {
      existingSfTipAmount: existing?.tip_amount,
    })

    // Sync customer if new (via upsert-with-adoption — dedups against existing SF-only customer by phone/email)
    if (zbJob.customer?.id && !customerMap[zbJob.customer.id]) {
      try {
        const zbCustomer = await zbFetch(apiKey, `/customers/${zbJob.customer.id}`)
        const result = await upsertCustomerFromZB(userId, zbCustomer)
        if (result.id) {
          mapped.customer_id = result.id
          // If we resolved the customer this time, clear any prior dirty
          // marker on the same job. The mark is keyed on the ZB job id
          // because the SF job id may not exist yet on first insert.
          await resolveDirty(supabase, {
            userId, sfJobId: existing?.id, zenbookerId: data.id,
            operation: 'customer_link', note: 'resolved on subsequent webhook',
          })
        }
      } catch (custErr) {
        await markDirty(supabase, {
          userId,
          sfJobId: existing?.id ?? null,
          zenbookerId: data.id,
          operation: 'customer_link',
          error: custErr,
          logger,
          context: { zb_customer_id: zbJob.customer.id, source: 'handleJobEvent' },
        })
      }
    }
    let jobId
    if (existing) {
      jobId = existing.id
      // Split the update: the `status` field goes through the
      // centralized service (loop-safe, emits outbox on LB-linked
      // jobs). All other fields update directly — they are not
      // status changes.
      const { status: mappedStatus, ...mappedRest } = mapped
      if (Object.keys(mappedRest).length > 0) {
        await supabase.from('jobs').update(mappedRest).eq('id', existing.id)
      }
      if (mappedStatus && mappedStatus !== existing.status) {
        try {
          await updateJobStatus(supabase, {
            jobId: existing.id,
            userId,
            newStatus: mappedStatus,
            source: 'system',
            actor: { type: 'system', id: null, display_name: 'Zenbooker sync' },
          })
        } catch (e) {
          logger.error(`[Zenbooker] updateJobStatus failed for job ${existing.id}: ${e.message}`)
        }
      }
      logger.log(`[Zenbooker] Job updated: ${data.id} (${eventType})`)

      // Delete UNBATCHED completion-derived ledger entries when job is
      // cancelled via Zenbooker webhook. Reimbursement/adjustment/payout/
      // expense_deduction survive (a cancellation reimbursement must not be
      // wiped). Settled rows are immutable (Constitution §3.1) — paid past
      // earnings are not retro-erased; operator handles via compensating
      // adjustment if needed.
      if (mapped.status === 'cancelled') {
        try {
          const { deleted, skippedBatched } = await safeDeleteCompletionDerivedLedger(supabase, {
            jobId: existing.id,
            types: LEDGER_COMPLETION_DERIVED_TYPES,
            source: 'zb_webhook_cancel',
          })
          logger.log(`[Zenbooker] Removed ${deleted} unbatched ledger entries for cancelled job ${existing.id}`)
          if (skippedBatched.length > 0) {
            logger.warn(`[Zenbooker] Cancel preserved ${skippedBatched.length} settled rows on job ${existing.id} (Constitution §3.1) — compensating adjustment may be required.`)
          }
        } catch (e) {
          logger.error(`[Zenbooker] Cancel ledger cleanup failed for job ${existing.id}: ${e.message}`)
        }
      }
    } else {
      // First-time insert — status ships with the row directly.
      // No centralized service here because the row didn't exist yet;
      // updateJobStatus would 404. maybeEmitInsertEvent handles the
      // LB-linked case below (but ZB-sourced jobs won't have lb_*
      // fields, so this is effectively a no-op for now).
      const { data: newJob } = await supabase.from('jobs').insert(mapped).select().single()
      jobId = newJob?.id
      if (newJob) {
        maybeEmitInsertEvent(supabase, newJob, {
          type: 'system',
          id: null,
          display_name: 'Zenbooker sync',
        }).catch((e) => logger.warn(`[LB Outbound] ZB insert emit skipped: ${e?.message}`))
      }
      logger.log(`[Zenbooker] Job created: ${data.id} (${eventType})`)
    }

    // ── Sync team assignments for ALL assigned providers ──
    if (jobId) {
      const providers = zbJob.assigned_providers || []
      const zbMemberIds = providers.map(p => teamMap[p.id]).filter(Boolean)
      if (zbMemberIds.length > 1) {
        const { data: existingAssignments } = await supabase.from('job_team_assignments').select('team_member_id').eq('job_id', jobId)
        const existingIds = new Set((existingAssignments || []).map(a => a.team_member_id))
        const needsUpdate = zbMemberIds.some(id => !existingIds.has(id)) || existingIds.size !== zbMemberIds.length
        if (needsUpdate) {
          await supabase.from('job_team_assignments').delete().eq('job_id', jobId)
          const assignments = zbMemberIds.map((id, idx) => ({
            job_id: jobId, team_member_id: id, is_primary: idx === 0
          }))
          const { error: assignErr } = await supabase.from('job_team_assignments').insert(assignments)
          if (assignErr) logger.error(`[Zenbooker] Assignment sync error job ${jobId}: ${JSON.stringify(assignErr)}`)
          else logger.log(`[Zenbooker] Synced ${zbMemberIds.length} team assignments for job ${jobId}`)
        }
      } else if (zbMemberIds.length <= 1) {
        // Single or no provider — clean up any stale multi-assignments
        await supabase.from('job_team_assignments').delete().eq('job_id', jobId)
      }

      // Fallback: ZB doesn't reliably send invoice_payment webhooks.
      // When a job is completed or paid, proactively fetch the invoice and
      // create missing transaction records so cash_collected entries get created.
      // NOTE: The /invoices endpoint does NOT return custom_payment_method_name on
      // nested transactions — only the /transactions endpoint does. So "custom" type
      // payments will be stored with the literal "custom" here and corrected when
      // syncTransactions runs (which fetches from /transactions with the real name).
      if ((mapped.status === 'completed' || mapped.status === 'paid') && zbJob.invoice?.id && apiKey) {
        try {
          const invoiceData = await zbFetch(apiKey, `/invoices/${zbJob.invoice.id}`)
          const zbTxs = invoiceData?.transactions || []
          for (const zbt of zbTxs) {
            if (zbt.status !== 'succeeded') continue
            // Dedup by zenbooker transaction ID (atomic helper also dedupes, but checking here lets us skip the RPC when unchanged)
            const { data: existing } = await supabase.from('transactions')
              .select('id').eq('zenbooker_id', zbt.id).maybeSingle()
            if (existing) continue
            // Invoice endpoint lacks custom_payment_method_name — use what we have,
            // but don't write bare "custom" to the job (syncTransactions will resolve it)
            const fallbackMethod = zbt.custom_payment_method_name || zbt.payment_method || 'other'
            const jobPaymentMethod = fallbackMethod !== 'custom' ? fallbackMethod : null

            // P1.3 — atomic: tx INSERT + job UPDATE in one Postgres function.
            // Replaces the pre-P1.3 two-step (insert tx, then update job) which
            // could leave a paid-job-with-no-tx state on partial failure.
            const fallbackJobUpdate = jobPaymentMethod
              ? { payment_method: jobPaymentMethod, payment_status: 'paid' }
              : { payment_status: 'paid' }
            const atomicResult = await applyAtomicPaymentWrites(supabase, {
              userId, sfJobId: jobId,
              jobUpdates: fallbackJobUpdate,
              txDataArray: [{
                job_id: jobId,
                customer_id: mapped.customer_id || null,
                amount: parseFloat(zbt.amount) || 0,
                payment_method: fallbackMethod,
                payment_intent_id: zbt.stripe_transaction_id || `zb_${zbt.id}`,
                status: 'completed',
                notes: zbt.memo || 'Synced from Zenbooker on job completion',
                zenbooker_id: zbt.id,
                created_at: zbt.payment_date || zbt.created,
              }],
              logger,
            })
            if (!atomicResult.ok) {
              await markDirty(supabase, {
                userId, sfJobId: jobId, zenbookerId: data?.id ?? null,
                operation: 'payment_status_update', error: atomicResult.error, logger,
                context: { source: 'handleJobEvent:fallback_tx_atomic_rollback', zb_tx_id: zbt.id, fallback_method: fallbackMethod },
              })
              continue
            }
            await resolveDirty(supabase, { userId, sfJobId: jobId, operation: 'payment_status_update', note: 'resolved on fallback tx atomic flow' })
            logger.log(`[Zenbooker] Fallback tx created (atomic) for job ${jobId}: ${fallbackMethod} $${zbt.amount}`)
          }
        } catch (invErr) {
          // Non-fatal — invoice fetch might fail or not exist yet
          logger.debug(`[Zenbooker] Invoice fetch for job ${jobId} failed: ${invErr.message}`)
        }
      }

      // Create/rebuild ledger entries when job is completed or paid
      // (runs AFTER fallback tx creation so cash_collected entries get included)
      if ((mapped.status === 'completed' || mapped.status === 'paid') && createLedgerEntriesForCompletedJob) {
        try {
          await rebuildLedger(jobId, userId, { types: ['earning', 'tip', 'incentive', 'cash_collected'] })
          logger.log(`[Zenbooker] Ledger entries rebuilt for job ${jobId} (${eventType})`)
          await resolveDirty(supabase, { userId, sfJobId: jobId, operation: 'ledger_rebuild', note: `resolved on handleJobEvent ${eventType}` })
        } catch (ledgerErr) {
          await markDirty(supabase, {
            userId, sfJobId: jobId, zenbookerId: data?.id ?? null,
            operation: 'ledger_rebuild', error: ledgerErr, logger,
            context: { source: 'handleJobEvent', event_type: eventType },
          })
        }
      }
    }
  }

  async function handlePaymentEvent(eventType, data, userId, apiKey) {
    if (!data?.job_id && !data?.invoice_id) return
    // Find job by zenbooker invoice/job reference
    const jobZbId = data.job_id || data.job?.id
    if (!jobZbId) return

    const { data: job } = await supabase.from('jobs').select('id, customer_id, status, tip_amount').eq('user_id', userId).eq('zenbooker_id', jobZbId).maybeSingle()
    if (!job) return

    const update = {}
    if (eventType === 'invoice_payment.succeeded' || eventType === 'invoice_payment.recorded') {
      // Webhook data can be either the invoice (with nested transactions[]) or a transaction.
      // Try top-level first, then fall back to nested transaction. Invoice payload's nested
      // transactions lack custom_payment_method_name, so we may only resolve a generic label.
      const nestedTx = Array.isArray(data.transactions) ? data.transactions[0] : null
      const amount = parseFloat(data.amount_paid || data.amount || nestedTx?.amount) || 0
      const rawMethod = data.custom_payment_method_name
        || nestedTx?.custom_payment_method_name
        || data.payment_method
        || nestedTx?.payment_method
        || null
      // Only treat a method as "resolved" if it's a real name — skip generic fallbacks like
      // 'custom' or 'other' so we don't overwrite names previously set by syncTransactions.
      const GENERIC = new Set(['custom', 'other', 'unknown', ''])
      const resolvedMethod = rawMethod && !GENERIC.has(String(rawMethod).toLowerCase()) ? rawMethod : null

      update.payment_status = 'paid'
      update.invoice_status = 'paid'
      if (resolvedMethod) update.payment_method = resolvedMethod
      // (`total_paid_amount` removed — never existed in jobs schema; was a silent no-op.)

      // Refresh financial truth from ZB. ZB's invoice fields can change after
      // payment (operator adds tip, edits subtotal, etc.) and ZB has no
      // invoice.edited webhook — so payment events are our hook to re-pull.
      // Use the webhook payload first; fall back to /jobs/:id when payload
      // doesn't carry invoice subtotal/tip.
      try {
        const hasInvoiceFields = data?.subtotal != null || data?.tip != null || data?.total != null
        let zbJobForFin = null
        if (hasInvoiceFields) {
          // Webhook is itself an invoice object — wrap so mapJobFinancials sees it
          zbJobForFin = { invoice: data }
        } else if (apiKey) {
          // Refetch the job to get the current invoice. Skipped if no api key
          // (test mode); refresh runs lazily in /reconcile-job/:jobId then.
          try {
            zbJobForFin = await zbFetch(apiKey, `/jobs/${jobZbId}`)
            await resolveDirty(supabase, { userId, sfJobId: job.id, operation: 'zb_job_fetch', note: 'resolved on refresh fetch' })
          } catch (fetchErr) {
            zbJobForFin = null
            await markDirty(supabase, {
              userId, sfJobId: job.id, zenbookerId: jobZbId,
              operation: 'zb_job_fetch', error: fetchErr, logger,
              context: { source: 'handlePaymentEvent:financial_refresh', event_type: eventType },
            })
          }
        }
        if (zbJobForFin) {
          const fin = stripDiagnostics(mapJobFinancials(zbJobForFin, { existingSfTipAmount: job.tip_amount }))
          Object.assign(update, fin)
        }
      } catch (finErr) {
        logger.warn(`[Zenbooker] Financial refresh on ${eventType} for job ${job.id} failed: ${finErr.message}`)
      }

      // P1.3 — single atomic write: jobs UPDATE + transactions UPSERT inside
      // one Postgres function. If either step fails the whole transaction
      // rolls back, so the invariant `payment_status='paid' ⟺ tx exists`
      // is preserved. Pre-P1.3 these were two separate awaits with a partial
      // commit window between them.
      const zbTxId = data.transaction_id || nestedTx?.id || (data.id && !Array.isArray(data.transactions) ? data.id : null)
      const { data: existingTx } = await supabase.from('transactions')
        .select('id').eq('job_id', job.id).eq('status', 'completed').limit(1)
      const txArray = []
      if (!existingTx || existingTx.length === 0) {
        txArray.push({
          job_id: job.id,
          customer_id: job.customer_id,
          amount,
          // Store raw method (even 'custom') on the transaction so syncTransactions can upgrade it later
          payment_method: rawMethod || 'other',
          payment_intent_id: zbTxId ? `zb_${zbTxId}` : `zb_webhook_${Date.now()}`,
          status: 'completed',
          notes: 'Payment synced from Zenbooker',
          zenbooker_id: zbTxId || null,
        })
      }

      const atomicResult = await applyAtomicPaymentWrites(supabase, {
        userId, sfJobId: job.id, jobUpdates: update, txDataArray: txArray, logger,
      })
      if (!atomicResult.ok) {
        // P1.2 contract — surface the failure as a dirty row so the operator
        // can replay. Both writes (jobs + transactions) rolled back together;
        // no partial state remains.
        await markDirty(supabase, {
          userId, sfJobId: job.id, zenbookerId: jobZbId,
          operation: 'payment_status_update', error: atomicResult.error, logger,
          context: { source: 'handlePaymentEvent:atomic_rollback', event_type: eventType, tx_count: txArray.length },
        })
      } else {
        const txAction = atomicResult.result?.tx_actions?.[0]?.action || 'no_tx'
        logger.log(`[Zenbooker] Payment ${eventType}: job ${job.id} atomic-paid ($${amount} ${resolvedMethod || `raw=${rawMethod || 'none'}`} tx_action=${txAction})`)
        await resolveDirty(supabase, { userId, sfJobId: job.id, operation: 'payment_status_update', note: 'resolved via atomic payment write' })
        await resolveDirty(supabase, { userId, sfJobId: job.id, operation: 'transaction_payment_method', note: 'resolved via atomic payment write' })
      }

      // Rebuild ledger if any cash transaction now exists for this job. The webhook may
      // arrive with rawMethod = 'custom'/null while the DB already has a cash tx (e.g. from
      // an earlier syncTransactions correction), so we check the DB rather than the payload.
      if (createLedgerEntriesForCompletedJob) {
        const { data: cashTxCheck } = await supabase.from('transactions')
          .select('id').eq('job_id', job.id).eq('status', 'completed').ilike('payment_method', 'cash').limit(1)
        if (cashTxCheck && cashTxCheck.length > 0) {
          try {
            await rebuildLedger(job.id, userId, { types: ['earning', 'tip', 'incentive', 'cash_collected'] })
            logger.log(`[Zenbooker] Ledger rebuilt with cash_collected for job ${job.id}`)
            await resolveDirty(supabase, { userId, sfJobId: job.id, operation: 'ledger_rebuild', note: 'resolved after cash-payment rebuild' })
          } catch (rebuildErr) {
            await markDirty(supabase, {
              userId, sfJobId: job.id, zenbookerId: jobZbId,
              operation: 'ledger_rebuild', error: rebuildErr, logger,
              context: { source: 'handlePaymentEvent:cash_path', event_type: eventType },
            })
          }
        }
      }
    } else if (eventType === 'invoice_payment.voided') {
      update.payment_status = 'pending'
      update.invoice_status = 'invoiced'
      update.payment_method = null
      await supabase.from('jobs').update(update).eq('id', job.id)
      logger.log(`[Zenbooker] Payment ${eventType}: job ${job.id} reverted to unpaid`)
      // Void the most recent completed transaction for this job
      const { data: latestTx } = await supabase.from('transactions')
        .select('id').eq('job_id', job.id).eq('status', 'completed')
        .order('created_at', { ascending: false }).limit(1)
      if (latestTx && latestTx.length > 0) {
        await supabase.from('transactions').update({ status: 'voided' }).eq('id', latestTx[0].id)
        logger.log(`[Zenbooker] Transaction ${latestTx[0].id} voided for job ${job.id}`)
      }
      // Rebuild ledger (cash_collected may need to be removed)
      if (createLedgerEntriesForCompletedJob) {
        try {
          await rebuildLedger(job.id, userId, { types: ['earning', 'tip', 'incentive', 'cash_collected'] })
          await resolveDirty(supabase, { userId, sfJobId: job.id, operation: 'ledger_rebuild', note: 'resolved on voided-tx rebuild' })
        } catch (rebuildErr) {
          await markDirty(supabase, {
            userId, sfJobId: job.id, zenbookerId: jobZbId,
            operation: 'ledger_rebuild', error: rebuildErr, logger,
            context: { source: 'handlePaymentEvent:voided_tx' },
          })
        }
      }
    }
  }

  // ══════════════════════════════════════
  // Auto-Reconcile Sweep
  //   Safety net for ZB's unreliable invoice.payment_* webhook delivery.
  //   Runs hourly: scans completed-but-unpaid jobs with a zenbooker_id,
  //   checks ZB for the current invoice status, and if ZB says paid it
  //   creates the transaction + flips the job to paid. Each catch is
  //   logged to payment_reconcile_catches so the UI can distinguish
  //   webhook-driven updates (default) from auto-reconcile catches.
  // ══════════════════════════════════════
  const GENERIC_METHOD = new Set(['custom', 'other', 'unknown', ''])
  const { randomUUID } = require('crypto')

  async function runPaymentReconcile(userId, apiKey, triggeredBy = 'cron') {
    const runId = randomUUID()
    await supabase.from('payment_reconcile_runs').insert({
      id: runId, user_id: userId, triggered_by: triggeredBy
    })

    let jobs_scanned = 0, payments_caught = 0, errors = 0
    const errorDetails = []

    try {
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString().slice(0, 10)
      // Candidates: completed jobs with a ZB id that aren't marked paid in SF yet
      const { data: candidates, error: qErr } = await supabase
        .from('jobs')
        .select('id, zenbooker_id, customer_id, invoice_status, payment_status, total_amount')
        .eq('user_id', userId)
        .not('zenbooker_id', 'is', null)
        .eq('status', 'completed')
        .or('invoice_status.neq.paid,invoice_status.is.null')
        .gte('scheduled_date', thirtyDaysAgo)
        .limit(500)
      if (qErr) throw new Error(`query candidates: ${JSON.stringify(qErr)}`)

      jobs_scanned = candidates.length

      for (const job of candidates) {
        try {
          // Already caught by a prior sweep? Skip — unique index enforces this but double-check.
          const { data: existingCatch } = await supabase
            .from('payment_reconcile_catches')
            .select('id').eq('job_id', job.id).limit(1)
          if (existingCatch && existingCatch.length > 0) continue

          const zbJob = await zbFetch(apiKey, `/jobs/${job.zenbooker_id}`)
          const inv = zbJob?.invoice
          if (!inv || inv.status !== 'paid') continue

          // Pull the invoice to get the transactions list, then resolve each
          // transaction's real name via /transactions/:id (the only endpoint
          // that returns custom_payment_method_name).
          const invoiceData = await zbFetch(apiKey, `/invoices/${inv.id}`)
          const zbTxs = (invoiceData.transactions || []).filter(t => t.status === 'succeeded')

          // P1.3 — collect resolved tx data first; commit ALL txs + the
          // job update in ONE atomic RPC call. Pre-P1.3 this loop did N
          // separate INSERTs followed by a separate jobs UPDATE — three+
          // partial-commit windows. Now: rollback-as-a-unit.
          let catchAmount = 0
          let catchMethod = null
          let firstZbTxId = null
          const reconcileTxArray = []
          for (const t of zbTxs) {
            catchAmount += parseFloat(t.amount) || 0
            firstZbTxId = firstZbTxId || t.id
            let full = t
            try {
              full = await zbFetch(apiKey, `/transactions/${t.id}`)
              await resolveDirty(supabase, { userId, sfJobId: job.id, zenbookerId: t.id, operation: 'zb_tx_fetch', note: 'resolved on reconcile sweep' })
            } catch (txFetchErr) {
              await markDirty(supabase, {
                userId, sfJobId: job.id, zenbookerId: t.id,
                operation: 'zb_tx_fetch', error: txFetchErr, logger,
                context: { source: 'runPaymentReconcile:tx_method_resolution' },
              })
            }
            const realName = full.custom_payment_method_name || full.payment_method
            if (realName && !GENERIC_METHOD.has(String(realName).toLowerCase())) {
              catchMethod = catchMethod || realName
            }
            reconcileTxArray.push({
              job_id: job.id,
              customer_id: job.customer_id,
              amount: parseFloat(full.amount) || 0,
              payment_method: realName || 'other',
              payment_intent_id: full.stripe_transaction_id || `zb_${full.id}`,
              status: 'completed',
              notes: 'Caught by auto-reconcile',
              zenbooker_id: full.id,
              created_at: full.payment_date || full.created,
            })
          }

          const jobUpdate = { invoice_status: 'paid', payment_status: 'paid' }
          if (catchMethod) jobUpdate.payment_method = catchMethod

          // Refresh full financial truth from the invoice (subtotal, total,
          // tip, additional_fees, taxes, discount, duration). The auto-sweep
          // is the only path that reliably catches tip-after-payment edits
          // since ZB doesn't fire an `invoice.edited` webhook. Pre-fix: only
          // additional_fees was synced, leaving service_price/tip stale.
          const { data: existingSfJob } = await supabase
            .from('jobs')
            .select('tip_amount')
            .eq('id', job.id)
            .maybeSingle()
          const fin = stripDiagnostics(mapJobFinancials(
            { ...zbJob, invoice: invoiceData },
            { existingSfTipAmount: existingSfJob?.tip_amount },
          ))
          Object.assign(jobUpdate, fin)

          // ── Atomic financial commit: jobs UPDATE + N tx upserts ──
          const reconcileAtomic = await applyAtomicPaymentWrites(supabase, {
            userId, sfJobId: job.id, jobUpdates: jobUpdate, txDataArray: reconcileTxArray, logger,
          })
          if (!reconcileAtomic.ok) {
            await markDirty(supabase, {
              userId, sfJobId: job.id, zenbookerId: job.zenbooker_id,
              operation: 'payment_status_update', error: reconcileAtomic.error, logger,
              context: { source: 'runPaymentReconcile:atomic_rollback', tx_count: reconcileTxArray.length, catch_amount: catchAmount },
            })
            errors++
            errorDetails.push(`job ${job.id}: atomic reconcile rolled back: ${reconcileAtomic.error?.message || 'unknown'}`)
            continue
          }
          await resolveDirty(supabase, { userId, sfJobId: job.id, operation: 'payment_status_update', note: 'resolved via reconcile atomic write' })

          // Audit row goes OUTSIDE the atomic block — it's a forensic
          // record, not part of the financial invariant. A failure here
          // surfaces via [ZB-dirty] only (no financial state at risk).
          const { error: catchErr } = await supabase.from('payment_reconcile_catches').insert({
            run_id: runId, user_id: userId, job_id: job.id,
            zb_invoice_id: inv.id,
            zb_transaction_id: firstZbTxId,
            amount: catchAmount,
            payment_method: catchMethod,
            notes: `Invoice paid in ZB ($${inv.amount_paid}) — no webhook received`
          })
          if (catchErr) logger.warn(`[AutoReconcile] Audit insert failed for job ${job.id}: ${catchErr.message}`)

          // Rebuild ledger so cash_collected entries get created for cash payments
          if (createLedgerEntriesForCompletedJob) {
            try {
              await rebuildLedger(job.id, userId, { types: ['earning', 'tip', 'incentive', 'cash_collected'] })
              await resolveDirty(supabase, { userId, sfJobId: job.id, operation: 'ledger_rebuild', note: 'resolved on reconcile rebuild' })
            } catch (rebuildErr) {
              await markDirty(supabase, {
                userId, sfJobId: job.id, zenbookerId: job.zenbooker_id,
                operation: 'ledger_rebuild', error: rebuildErr, logger,
                context: { source: 'runPaymentReconcile:rebuild_after_catch' },
              })
            }
          }

          payments_caught++
          logger.log(`[AutoReconcile] Caught job ${job.id}: $${catchAmount} ${catchMethod || 'other'}`)
        } catch (e) {
          errors++
          errorDetails.push(`job ${job.id}: ${e.message}`)
          logger.warn(`[AutoReconcile] Error for job ${job.id}: ${e.message}`)
        }
      }
    } catch (e) {
      errors++
      errorDetails.push(`sweep: ${e.message}`)
      logger.error(`[AutoReconcile] Sweep failed: ${e.message}`)
    }

    await supabase.from('payment_reconcile_runs').update({
      finished_at: new Date().toISOString(),
      jobs_scanned, payments_caught, errors,
      error_details: errorDetails.length ? errorDetails.join('; ').slice(0, 2000) : null
    }).eq('id', runId)

    return { runId, jobs_scanned, payments_caught, errors }
  }

  // Hourly sweep across all ZB-connected users. Disabled in tests.
  if (process.env.NODE_ENV !== 'test' && process.env.DISABLE_ZB_CRON !== 'true') {
    const HOUR_MS = 60 * 60 * 1000
    const sweepAllUsers = async () => {
      try {
        const { data: users } = await supabase
          .from('users')
          .select('id, zenbooker_api_key')
          .eq('zenbooker_status', 'connected')
          .not('zenbooker_api_key', 'is', null)
        for (const u of users || []) {
          try {
            const r = await runPaymentReconcile(u.id, u.zenbooker_api_key, 'cron')
            if (r.payments_caught > 0 || r.errors > 0) {
              logger.log(`[AutoReconcile][cron] user=${u.id} scanned=${r.jobs_scanned} caught=${r.payments_caught} errors=${r.errors}`)
            }
          } catch (e) {
            logger.error(`[AutoReconcile][cron] user=${u.id} failed: ${e.message}`)
          }
        }
      } catch (e) {
        logger.error(`[AutoReconcile][cron] setup failed: ${e.message}`)
      }
    }
    // Stagger first run 60s after boot to let app finish warmup
    setTimeout(sweepAllUsers, 60 * 1000)
    setInterval(sweepAllUsers, HOUR_MS)
    logger.log('[AutoReconcile] Hourly sweep scheduled (first run in 60s)')
  }

  // ══════════════════════════════════════
  // Routes
  // ══════════════════════════════════════

  // GET /payment-reconcile-log — list catches + recent runs for the current user
  router.get('/payment-reconcile-log', authenticateToken, async (req, res) => {
    try {
      const userId = req.user.userId
      const limit = Math.min(parseInt(req.query.limit) || 100, 500)
      const [{ data: catches }, { data: runs }] = await Promise.all([
        supabase.from('payment_reconcile_catches')
          .select('id, run_id, job_id, zb_invoice_id, zb_transaction_id, amount, payment_method, caught_at, notes')
          .eq('user_id', userId)
          .order('caught_at', { ascending: false })
          .limit(limit),
        supabase.from('payment_reconcile_runs')
          .select('id, started_at, finished_at, jobs_scanned, payments_caught, errors, triggered_by')
          .eq('user_id', userId)
          .order('started_at', { ascending: false })
          .limit(20)
      ])
      res.json({ catches: catches || [], runs: runs || [] })
    } catch (e) {
      logger.error(`[AutoReconcile] log endpoint error: ${e.message}`)
      res.status(500).json({ error: 'Failed to load reconcile log' })
    }
  })

  // GET /sync-dirty — list zb_sync_dirty rows for the current tenant.
  // P1.2 operator surface. Tenant-scoped (user_id from authenticateToken);
  // no admin endpoint here — admins can query the table directly.
  router.get('/sync-dirty', authenticateToken, async (req, res) => {
    try {
      const userId = req.user.userId
      const includeResolved = req.query.includeResolved === 'true'
      const limit = Math.min(parseInt(req.query.limit) || 100, 500)
      const operation = req.query.operation || null

      let q = supabase.from('zb_sync_dirty')
        .select('id, sf_job_id, zenbooker_id, operation, error_class, error_message, retryable, attempts, first_seen_at, last_seen_at, resolved_at, resolved_by, resolution_note, context')
        .eq('user_id', userId)
        .order('last_seen_at', { ascending: false })
        .limit(limit)
      if (!includeResolved) q = q.is('resolved_at', null)
      if (operation) q = q.eq('operation', operation)

      const { data, error } = await q
      if (error) {
        logger.error(`[ZB-dirty] list endpoint failed: ${error.message}`)
        return res.status(500).json({ error: 'Failed to load dirty rows' })
      }

      // Summary view for operators.
      const summary = (data || []).reduce((acc, r) => {
        acc.total++
        if (!r.resolved_at) acc.unresolved++
        acc.by_operation[r.operation] = (acc.by_operation[r.operation] || 0) + 1
        return acc
      }, { total: 0, unresolved: 0, by_operation: {} })

      res.json({ summary, rows: data || [] })
    } catch (e) {
      logger.error(`[ZB-dirty] list endpoint crashed: ${e.message}`)
      res.status(500).json({ error: 'Failed to load dirty rows' })
    }
  })

  // POST /payment-reconcile/run — manually trigger a sweep for the current user
  router.post('/payment-reconcile/run', authenticateToken, async (req, res) => {
    try {
      const userId = req.user.userId
      const { data: user } = await supabase.from('users')
        .select('zenbooker_api_key, zenbooker_status').eq('id', userId).single()
      if (!user?.zenbooker_api_key || user.zenbooker_status !== 'connected') {
        return res.status(400).json({ error: 'Zenbooker not connected' })
      }
      runPaymentReconcile(userId, user.zenbooker_api_key, 'manual').then(
        r => logger.log(`[AutoReconcile] Manual run complete: ${JSON.stringify(r)}`),
        e => logger.error(`[AutoReconcile] Manual run failed: ${e.message}`)
      )
      res.json({ status: 'started', message: 'Auto-reconcile sweep started in background' })
    } catch (e) {
      logger.error(`[AutoReconcile] manual run endpoint error: ${e.message}`)
      res.status(500).json({ error: 'Failed to start reconcile' })
    }
  })

  // POST /reconcile-orphans — full-set diff against ZB + provenance-aware cleanup.
  //
  // Compares every SF customer carrying a zenbooker_id against the live ZB
  // customer list. Any SF row whose zenbooker_id is no longer in ZB is an
  // orphan; orphans are classified by SF-side history (source_only/mixed/risky)
  // and cleaned up safely.
  //
  // Defaults to dry-run; apply requires explicit `mode: 'apply'`.
  // See lib/zb-orphan-reconciliation.js for classification + action policy.
  router.post('/reconcile-orphans', authenticateToken, async (req, res) => {
    try {
      const userId = req.user.userId
      const { data: user } = await supabase.from('users')
        .select('zenbooker_api_key, zenbooker_status').eq('id', userId).single()
      if (!user?.zenbooker_api_key || user.zenbooker_status !== 'connected') {
        return res.status(400).json({ error: 'Zenbooker not connected' })
      }

      const mode = (req.body && req.body.mode === 'apply') ? 'apply' : 'dryRun'

      // Fetch live ZB customer set. Same pagination as full sync.
      let zbCustomers
      try {
        zbCustomers = await zbFetchAll(user.zenbooker_api_key, '/customers')
      } catch (e) {
        logger.error(`[ZBReconcile] Failed to fetch live ZB customer list: ${e.message}`)
        return res.status(502).json({ error: 'Failed to fetch ZB customer list', detail: e.message })
      }
      const zbCustomerIds = new Set((zbCustomers || []).map(c => String(c.id)))

      const report = await reconcileOrphans({
        supabase,
        logger,
        userId,
        zbCustomerIds,
        mode,
      })

      logger.log(`[ZBReconcile] endpoint mode=${mode} tenant=${userId} sf_zb_count=${report.sf_zb_customer_count} zb_live_count=${report.zb_live_count} orphans=${report.orphans.length} source_only=${report.summary.source_only} mixed=${report.summary.mixed} risky=${report.summary.risky} applied_archive=${report.summary.applied_archive} applied_detach=${report.summary.applied_detach} applied_review=${report.summary.applied_review} errors=${report.summary.errors}`)

      res.json(report)
    } catch (e) {
      logger.error(`[ZBReconcile] endpoint error: ${e.message}`)
      res.status(500).json({ error: 'Failed to reconcile orphans', detail: e.message })
    }
  })

  // POST /connect — validate API key + store
  router.post('/connect', authenticateToken, async (req, res) => {
    try {
      const userId = req.user.userId
      const { apiKey } = req.body
      if (!apiKey) return res.status(400).json({ error: 'API key is required' })

      // Validate by fetching services (lightweight call)
      try {
        await zbFetch(apiKey, '/services', { limit: 1 })
      } catch (err) {
        return res.status(400).json({ error: 'Invalid Zenbooker API key. Could not connect.' })
      }

      await supabase.from('users').update({
        zenbooker_api_key: apiKey,
        zenbooker_status: 'connected',
      }).eq('id', userId)

      logger.log(`[Zenbooker] Connected for user ${userId}`)

      // Auto-register webhooks
      const webhookUrl = `${req.protocol}://${req.get('host')}/api/zenbooker/webhook`
      const webhookEvents = ['job.created', 'job.canceled', 'job.rescheduled', 'job.en_route', 'job.started', 'job.completed', 'job.service_providers.assigned', 'job.service_order.edited', 'invoice.payment_succeeded', 'invoice.payment_recorded', 'customer.edited']
      try {
        // Get existing webhooks
        const existingRes = await zbFetch(apiKey, '/webhooks', { limit: 50 })
        const existingEvents = new Set((existingRes.results || existingRes || []).map(w => w.event_type))
        // Register missing events
        for (const evt of webhookEvents) {
          if (existingEvents.has(evt)) continue
          try {
            await fetch(`${ZB_BASE}/webhooks`, {
              method: 'POST',
              headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ event_type: evt, url: webhookUrl, webhook_api_version: '2025-09-01' })
            })
            logger.log(`[Zenbooker] Webhook registered: ${evt}`)
          } catch (wErr) { logger.error(`[Zenbooker] Webhook register failed: ${evt}: ${wErr.message}`) }
        }
      } catch (wErr) { logger.error(`[Zenbooker] Webhook setup error: ${wErr.message}`) }

      // Start full sync in background
      runFullSync(userId, apiKey).catch(err => {
        logger.error(`[Zenbooker] Initial sync failed for user ${userId}: ${err.message}`)
      })

      res.json({ status: 'connected', message: 'Connected. Initial sync started.' })
    } catch (err) {
      logger.error(`[Zenbooker] Connect error: ${err.message}`)
      res.status(500).json({ error: 'Failed to connect' })
    }
  })

  // GET /status — connection status + stats
  router.get('/status', authenticateToken, async (req, res) => {
    try {
      const userId = req.user.userId
      const { data: user } = await supabase.from('users').select('zenbooker_status, zenbooker_last_sync').eq('id', userId).single()

      const status = user?.zenbooker_status || 'disconnected'
      const lastSync = user?.zenbooker_last_sync || null

      // Count synced records
      let stats = {}
      if (status === 'connected') {
        const [jobs, customers, services, team, territories] = await Promise.all([
          supabase.from('jobs').select('id', { count: 'exact', head: true }).eq('user_id', userId).not('zenbooker_id', 'is', null),
          supabase.from('customers').select('id', { count: 'exact', head: true }).eq('user_id', userId).not('zenbooker_id', 'is', null),
          supabase.from('services').select('id', { count: 'exact', head: true }).eq('user_id', userId).not('zenbooker_id', 'is', null),
          supabase.from('team_members').select('id', { count: 'exact', head: true }).eq('user_id', userId).not('zenbooker_id', 'is', null),
          supabase.from('territories').select('id', { count: 'exact', head: true }).eq('user_id', userId).not('zenbooker_id', 'is', null),
        ])
        stats = {
          jobs: jobs.count || 0,
          customers: customers.count || 0,
          services: services.count || 0,
          teamMembers: team.count || 0,
          territories: territories.count || 0,
        }
      }

      res.json({ status, lastSync, stats, syncProgress: syncProgress[userId] || null })
    } catch (err) {
      logger.error(`[Zenbooker] Status error: ${err.message}`)
      res.status(500).json({ error: 'Failed to get status' })
    }
  })

  // POST /sync — manual sync with options
  router.post('/sync', authenticateToken, async (req, res) => {
    // T2.1 (2026-05-09): instrumentation. Pre-fix the catch was silent —
    // the operator saw "Failed to start sync" with zero log lines reaching
    // Loki, making the failure undiagnosable. Add an entry log + phase
    // tracker so the catch can report exactly where in the route the
    // exception fired. Phase string is also returned to the caller so the
    // browser console shows it directly.
    let phase = 'entry'
    const userId = req.user?.userId ?? null
    // PR-4: removed `body=${JSON.stringify(req.body).slice(0,200)}` from
    // this log line — the Zenbooker sync POST body has historically carried
    // raw API tokens when operators re-enter the integration key, which
    // then ended up in Loki for the lifetime of the retention window.
    logger.log(`[Zenbooker] POST /sync entry — userId=${userId}`)
    try {
      if (!userId) {
        // authenticateToken should have rejected, but belt-and-suspenders:
        // surface this clearly rather than crashing on `req.user.userId`.
        logger.error(`[Zenbooker] /sync rejected — req.user.userId missing despite authenticateToken pass`)
        return res.status(401).json({ error: 'Invalid auth context', phase: 'entry' })
      }
      phase = 'load_user'
      const { data: user, error: userErr } = await supabase.from('users').select('zenbooker_api_key, zenbooker_status').eq('id', userId).single()
      if (userErr) {
        logger.error(`[Zenbooker] /sync supabase users lookup failed for userId=${userId}: ${userErr.message || JSON.stringify(userErr)}`)
        return res.status(500).json({ error: 'Failed to load user', phase, detail: userErr.message })
      }
      if (!user?.zenbooker_api_key || user.zenbooker_status !== 'connected') {
        logger.log(`[Zenbooker] /sync rejected — userId=${userId} status=${user?.zenbooker_status || 'null'} hasKey=${!!user?.zenbooker_api_key}`)
        return res.status(400).json({ error: 'Zenbooker not connected', phase: 'load_user', status: user?.zenbooker_status || null })
      }

      phase = 'check_running'
      if (syncProgress[userId]?.status === 'running') {
        return res.status(409).json({ error: 'Sync already in progress', phase, currentProgress: syncProgress[userId] })
      }

      phase = 'parse_body'
      const { entity, maxItems, since, includeCancelled } = req.body || {}
      // entity: 'jobs', 'customers', 'services', 'team', 'territories', 'link_all', 'reconcile', or null (full)
      // maxItems: number limit
      // since: ISO date string for filtering jobs by start_date_min
      // includeCancelled: boolean - include cancelled jobs (default: false)

      syncProgress[userId] = { status: 'running', phase: 'starting', progress: 0 }

      const apiKey = user.zenbooker_api_key
      const runSync = async () => {
        const results = {}
        try {
          if (!entity || entity === 'link_all') {
            // Full entity sync: create + update + link
            syncProgress[userId] = { status: 'running', phase: 'Territories', progress: 5 }
            results.territories = await syncTerritories(userId, apiKey)
            logger.log(`[Zenbooker] Territories done: ${JSON.stringify(results.territories)}`)

            syncProgress[userId] = { status: 'running', phase: 'Services', progress: 15 }
            results.services = await syncServices(userId, apiKey)
            logger.log(`[Zenbooker] Services done: ${JSON.stringify(results.services)}`)

            syncProgress[userId] = { status: 'running', phase: 'Team Members', progress: 25 }
            results.teamMembers = await syncTeamMembers(userId, apiKey)
            logger.log(`[Zenbooker] Team done: ${JSON.stringify(results.teamMembers)}`)

            syncProgress[userId] = { status: 'running', phase: 'Customers', progress: 40 }
            results.customers = await syncCustomers(userId, apiKey)
            logger.log(`[Zenbooker] Customers done: ${JSON.stringify(results.customers)}`)

            if (entity === 'link_all') {
              syncProgress[userId] = { status: 'complete', progress: 100, results }
              await supabase.from('users').update({ zenbooker_last_sync: new Date().toISOString() }).eq('id', userId)
              setTimeout(() => { delete syncProgress[userId] }, 300000)
              return results
            }
          }

          if (!entity || entity === 'jobs') {
            // Ensure entities exist before syncing jobs (needed for FK lookups)
            if (entity === 'jobs') {
              const { count: tCount } = await supabase.from('territories').select('id', { count: 'exact', head: true }).eq('user_id', userId).not('zenbooker_id', 'is', null)
              if (!tCount || tCount === 0) {
                syncProgress[userId] = { status: 'running', phase: 'Territories', progress: 5, results }
                results.territories = await syncTerritories(userId, apiKey)

                syncProgress[userId] = { status: 'running', phase: 'Services', progress: 10, results }
                results.services = await syncServices(userId, apiKey)

                syncProgress[userId] = { status: 'running', phase: 'Team Members', progress: 20, results }
                results.teamMembers = await syncTeamMembers(userId, apiKey)

                syncProgress[userId] = { status: 'running', phase: `Customers (0/${results.teamMembers?.total || 0} team done)`, progress: 30, results }
                results.customers = await syncCustomers(userId, apiKey)

                logger.log(`[Zenbooker] Auto-synced entities: T=${results.territories?.total} S=${results.services?.total} TM=${results.teamMembers?.total} C=${results.customers?.total}`)
              }
            }
            syncProgress[userId] = { status: 'running', phase: 'Jobs', progress: 60, results }
            const jobParams = { sort_order: 'descending' }
            if (!includeCancelled) jobParams.canceled = 'false'
            if (since) jobParams.start_date_min = since
            results.jobs = await syncJobs(userId, apiKey, jobParams, maxItems || 0)
            logger.log(`[Zenbooker] Jobs done: ${JSON.stringify(results.jobs)}`)
          }

          if (entity === 'customers') {
            syncProgress[userId] = { status: 'running', phase: 'Customers', progress: 30 }
            results.customers = await syncCustomers(userId, apiKey)
            logger.log(`[Zenbooker] Customers done: ${JSON.stringify(results.customers)}`)
          }

          if (entity === 'services') {
            syncProgress[userId] = { status: 'running', phase: 'Services', progress: 30 }
            results.services = await syncServices(userId, apiKey)
            logger.log(`[Zenbooker] Services done: ${JSON.stringify(results.services)}`)
          }

          if (entity === 'team') {
            syncProgress[userId] = { status: 'running', phase: 'Team Members', progress: 30 }
            results.teamMembers = await syncTeamMembers(userId, apiKey)
            logger.log(`[Zenbooker] Team done: ${JSON.stringify(results.teamMembers)}`)
          }

          if (entity === 'territories') {
            syncProgress[userId] = { status: 'running', phase: 'Territories', progress: 30 }
            results.territories = await syncTerritories(userId, apiKey)
            logger.log(`[Zenbooker] Territories done: ${JSON.stringify(results.territories)}`)
          }

          if (entity === 'reconcile') {
            // Fetch ALL jobs from Zenbooker (including cancelled) and update status/invoice/team assignments
            syncProgress[userId] = { status: 'running', phase: 'Fetching jobs...', progress: 5 }
            const zbJobs = await zbFetchAll(apiKey, '/jobs')
            // ZZB excludes cancelled jobs by default — fetch them separately
            const zbCancelledJobs = await zbFetchAll(apiKey, '/jobs', { canceled: 'true' })
            const seenIds = new Set(zbJobs.map(j => j.id))
            zbCancelledJobs.forEach(j => { if (!seenIds.has(j.id)) zbJobs.push(j) })
            logger.log(`[Zenbooker] Reconcile: ${zbJobs.length} jobs from Zenbooker (incl ${zbCancelledJobs.length} cancelled)`)

            // Build team map for assignment lookups
            const { data: team } = await supabase.from('team_members').select('id, zenbooker_id').eq('user_id', userId).not('zenbooker_id', 'is', null)
            const teamMap = {}; (team || []).forEach(t => { teamMap[t.zenbooker_id] = t.id })

            let updated = 0, skipped = 0, errors = 0, assignmentsFixed = 0
            const total = zbJobs.length
            for (let i = 0; i < zbJobs.length; i++) {
              const zb = zbJobs[i]
              if (i % 50 === 0) {
                const pct = Math.round(5 + (i / total) * 70)
                syncProgress[userId] = { status: 'running', phase: `Reconciling (${i}/${total})`, progress: pct, detail: `${updated} updated, ${assignmentsFixed} assignments fixed` }
              }

              const { data: sfJob } = await supabase.from('jobs').select('id, status, invoice_status, team_member_id').eq('user_id', userId).eq('zenbooker_id', zb.id).maybeSingle()
              if (!sfJob) { skipped++; continue }

              // ── Update status/invoice ──
              const zbStatus = zb.canceled ? 'cancelled' : (STATUS_MAP[(zb.status || '').toLowerCase()] || 'pending')
              const inv = zb.invoice || {}
              const zbInvoiceStatus = inv.status === 'paid' ? 'paid' : (inv.status === 'unpaid' ? 'invoiced' : 'draft')
              const zbPaymentStatus = inv.status === 'paid' ? 'paid' : (parseFloat(inv.amount_paid) > 0 ? 'partial' : null)

              const update = {}
              if (sfJob.status !== zbStatus) {
                update.status = zbStatus
                // Remove UNBATCHED completion-derived ledger entries when job
                // transitions to cancelled. Preserved types + settled rows match
                // the webhook-cancel rule above (Constitution §3.1).
                if (zbStatus === 'cancelled' && sfJob.status !== 'cancelled') {
                  try {
                    const { deleted, skippedBatched } = await safeDeleteCompletionDerivedLedger(supabase, {
                      jobId: sfJob.id,
                      types: LEDGER_COMPLETION_DERIVED_TYPES,
                      source: 'zb_reconcile_cancel',
                    })
                    logger.log(`[Zenbooker] Reconcile: removed ${deleted} unbatched ledger entries for cancelled job ${sfJob.id}`)
                    if (skippedBatched.length > 0) {
                      logger.warn(`[Zenbooker] Reconcile cancel preserved ${skippedBatched.length} settled rows on job ${sfJob.id} (Constitution §3.1).`)
                    }
                  } catch (e) {
                    logger.error(`[Zenbooker] Reconcile cancel ledger cleanup failed for job ${sfJob.id}: ${e.message}`)
                  }
                }
              }
              if (sfJob.invoice_status !== zbInvoiceStatus) update.invoice_status = zbInvoiceStatus
              if (zbPaymentStatus) update.payment_status = zbPaymentStatus
              // Sync payment method from ZB transactions for paid jobs
              if (inv.status === 'paid' && sfJob.invoice_status !== 'paid') {
                // Check if transaction exists, if not flag for creation after loop
                const { data: existingTx } = await supabase.from('transactions').select('id').eq('job_id', sfJob.id).eq('status', 'completed').limit(1)
                if (!existingTx || existingTx.length === 0) {
                  // Transaction will be synced by the full transaction sync — flag job for now
                  update.payment_method = update.payment_method || null
                }
              }
              // Always sync timestamps, prices, discounts
              update.scheduled_date = zbDateToLocal(zb.start_date, zb.timezone)
              update.price = parseFloat(inv.subtotal) || undefined
              update.service_price = parseFloat(inv.subtotal) || undefined
              update.total = parseFloat(inv.total) || undefined
              update.total_amount = parseFloat(inv.total) || undefined
              update.discount = parseFloat(inv.discount_amount) || 0
              update.additional_fees = parseFloat(inv.adjustment_total) || 0
              update.fees_breakdown = mapAdjustments(inv.adjustments_applied)
              // Only update tip from ZB if ZB has a value > 0 (don't overwrite SF manual tips)
              if (parseFloat(inv.tip || inv.tip_amount) > 0) update.tip_amount = parseFloat(inv.tip || inv.tip_amount)
              update.taxes = parseFloat(inv.tax_amount || inv.total_tax_amount) || 0
              // Duration and real start/end times from Zenbooker
              if (zb.estimated_duration_seconds) update.duration = Math.round(zb.estimated_duration_seconds / 60)
              if (zb.started_at) update.start_time = zb.started_at
              if (zb.completed_at) update.end_time = zb.completed_at

              // Bedrooms, bathrooms, add-ons from service_fields
              const serviceFields = zb.service_fields || []
              if (Array.isArray(serviceFields) && serviceFields.length > 0) {
                update.zenbooker_intake = serviceFields
                const addons = []
                for (const field of serviceFields) {
                  const fname = (field.field_name || '').toLowerCase()
                  const sel = (field.selected_options || [])[0]
                  if (!sel) continue
                  const optionText = sel.text || sel.display_label || ''
                  const num = parseInt(optionText) || null
                  if (fname.includes('bedroom')) update.bedroom_count = num
                  else if (fname.includes('bathroom')) update.bathroom_count = num
                  else if (field.field_type === 'service_modifier' && !fname.includes('bedroom') && !fname.includes('bathroom')) {
                    addons.push({ name: field.field_name, value: optionText, price: parseFloat(sel.total_price || sel.price || 0), quantity: parseInt(sel.quantity) || 1 })
                  }
                }
                if (addons.length > 0) update.addons = addons
              }

              const { error } = await supabase.from('jobs').update(update).eq('id', sfJob.id)
              if (error) { logger.error(`[Zenbooker] Reconcile error ${zb.id}: ${JSON.stringify(error)}`); errors++ }
              else { updated++ }

              // ── Sync team assignments ──
              const providers = zb.assigned_providers || []
              if (providers.length > 0) {
                const zbMemberIds = providers.map(p => teamMap[p.id]).filter(Boolean)
                if (zbMemberIds.length > 0) {
                  // Update primary team_member_id on job if different
                  const primaryId = teamMap[providers[0].id]
                  if (primaryId && sfJob.team_member_id !== primaryId) {
                    await supabase.from('jobs').update({ team_member_id: primaryId }).eq('id', sfJob.id)
                  }

                  // Sync job_team_assignments if multiple providers
                  if (zbMemberIds.length > 1) {
                    const { data: existingAssignments } = await supabase.from('job_team_assignments').select('team_member_id').eq('job_id', sfJob.id)
                    const existingIds = new Set((existingAssignments || []).map(a => a.team_member_id))
                    const missing = zbMemberIds.filter(id => !existingIds.has(id))
                    if (missing.length > 0 || existingIds.size !== zbMemberIds.length) {
                      // Replace all assignments with the correct set
                      await supabase.from('job_team_assignments').delete().eq('job_id', sfJob.id)
                      const assignments = zbMemberIds.map((id, idx) => ({
                        job_id: sfJob.id, team_member_id: id, is_primary: idx === 0
                      }))
                      const { error: assignErr } = await supabase.from('job_team_assignments').insert(assignments)
                      if (!assignErr) assignmentsFixed++
                      else logger.error(`[Zenbooker] Assignment fix error job ${sfJob.id}: ${JSON.stringify(assignErr)}`)
                    }
                  }
                }
              }
            }

            // ── Rebuild ledger entries for jobs that got new assignments ──
            if (assignmentsFixed > 0 && createLedgerEntriesForCompletedJob) {
              syncProgress[userId] = { status: 'running', phase: 'Rebuilding ledger for updated assignments...', progress: 80 }
              logger.log(`[Zenbooker] Reconcile: ${assignmentsFixed} jobs got assignment fixes, rebuilding ledger entries`)
              // Get all jobs that have team assignments
              const { data: assignedJobs } = await supabase
                .from('job_team_assignments')
                .select('job_id')
                .in('job_id', (await supabase.from('jobs').select('id').eq('user_id', userId)).data?.map(j => j.id) || [])
              const multiJobIds = [...new Set((assignedJobs || []).map(a => a.job_id))]
              let ledgerRebuilt = 0
              for (const jobId of multiJobIds) {
                // Rebuild, preserving any existing batch links
                try {
                  await rebuildLedger(jobId, userId, { types: ['earning', 'tip', 'incentive'] })
                  ledgerRebuilt++
                  await resolveDirty(supabase, { userId, sfJobId: jobId, operation: 'ledger_rebuild', note: 'resolved on full-sync reconcile' })
                } catch (e) {
                  await markDirty(supabase, {
                    userId, sfJobId: jobId, zenbookerId: null,
                    operation: 'ledger_rebuild', error: e, logger,
                    context: { source: 'fullSync:reconcile_multi_jobs' },
                  })
                }
                if (ledgerRebuilt % 50 === 0) {
                  syncProgress[userId] = { ...syncProgress[userId], phase: `Rebuilding ledger (${ledgerRebuilt}/${multiJobIds.length})`, progress: 80 + Math.round((ledgerRebuilt / multiJobIds.length) * 15) }
                }
              }
              results.reconcile.ledgerRebuilt = ledgerRebuilt
              logger.log(`[Zenbooker] Reconcile: rebuilt ledger for ${ledgerRebuilt} jobs`)
            }

            // ── Sync transactions (payments) ──
            syncProgress[userId] = { status: 'running', phase: 'Syncing transactions...', progress: 90 }
            const txResults = await syncTransactions(userId, apiKey)
            logger.log(`[Zenbooker] Transactions synced: ${JSON.stringify(txResults)}`)

            results.reconcile = { total, updated, skipped, errors, assignmentsFixed, transactions: txResults }
            logger.log(`[Zenbooker] Reconcile done: ${JSON.stringify(results.reconcile)}`)
          }

          await supabase.from('users').update({ zenbooker_last_sync: new Date().toISOString() }).eq('id', userId)
          syncProgress[userId] = { status: 'complete', progress: 100, results }
          setTimeout(() => { delete syncProgress[userId] }, 300000)
          return results
        } catch (err) {
          logger.error(`[Zenbooker] Sync failed: ${err.message}`)
          syncProgress[userId] = { status: 'error', error: err.message, results }
          setTimeout(() => { delete syncProgress[userId] }, 300000)
        }
      }

      phase = 'kick_off'
      runSync()
      res.json({ message: 'Sync started' })
    } catch (err) {
      // T2.1 (2026-05-09): log the FULL error context — phase, message, stack —
      // and return diagnostic info to the caller so the browser console shows
      // exactly where the route died. Pre-fix: only err.message logged + bare
      // 500 returned, making the failure invisible in both Loki and DevTools.
      const errMsg = err && err.message ? err.message : String(err)
      const errStack = err && err.stack ? err.stack.split('\n').slice(0, 8).join('\n') : null
      logger.error(`[Zenbooker] /sync trigger error at phase=${phase} userId=${userId}: ${errMsg}`)
      if (errStack) logger.error(`[Zenbooker] /sync stack: ${errStack}`)
      res.status(500).json({
        error: 'Failed to start sync',
        phase,
        detail: errMsg,
        // Stack only included for the operator's own user (admin diagnostic).
        // Not strictly secret but no need to surface globally.
        ...(req.user?.role === 'admin' || process.env.NODE_ENV !== 'production' ? { stack: errStack } : {}),
      })
    }
  })

  // GET /sync/progress — poll sync progress
  router.get('/sync/progress', authenticateToken, (req, res) => {
    res.json(syncProgress[req.user.userId] || { status: 'idle' })
  })

  // POST /reconcile-job/:jobId — admin-only single-job financial reconcile.
  //
  // Refreshes job financial fields (subtotal/total/tip/duration/fees) from
  // ZB ground truth, then runs safeReconcileJobLedger to bring earning/tip/
  // incentive/cash_collected ledger rows into agreement.
  //
  // Hard guarantees:
  //   - Never calls rebuildJobLedger (no destructive delete-and-rebuild).
  //   - Never mutates rows where payout_batch_id IS NOT NULL.
  //   - Unpaid rows may be UPDATEd in place; missing rows INSERTed
  //     idempotently on (job_id, team_member_id, type, effective_date).
  //   - Paid drift is reported, not corrected.
  //
  // Query params:
  //   ?dryRun=1  — compute the diff and return without writing
  router.post('/reconcile-job/:jobId', authenticateToken, async (req, res) => {
    try {
      const userId = req.user.userId
      const role = (req.user?.role || '').toLowerCase()
      const isAdminOrOwner = role === 'admin' || role === 'owner' || role === 'account owner' || role === 'manager'
      if (!isAdminOrOwner) {
        return res.status(403).json({ error: 'admin_only', detail: 'reconcile-job is admin-only' })
      }

      const jobId = parseInt(req.params.jobId, 10)
      if (!Number.isFinite(jobId)) {
        return res.status(400).json({ error: 'invalid_job_id' })
      }
      const dryRun = req.query.dryRun === '1' || req.query.dryRun === 'true'

      const { data: user } = await supabase.from('users')
        .select('zenbooker_api_key, zenbooker_status').eq('id', userId).single()
      if (!user?.zenbooker_api_key || user.zenbooker_status !== 'connected') {
        return res.status(400).json({ error: 'zenbooker_not_connected' })
      }

      const { data: job } = await supabase.from('jobs')
        .select('id, user_id, zenbooker_id, status, tip_amount, scheduled_date, start_time, end_time, is_recurring, invoice_status, payment_status')
        .eq('id', jobId).eq('user_id', userId).maybeSingle()
      if (!job) return res.status(404).json({ error: 'job_not_found' })
      if (!job.zenbooker_id) return res.status(400).json({ error: 'job_not_linked_to_zenbooker' })

      // ── Phase 1: refresh job financials from ZB ──
      // Dual fetch: /jobs/:id (status, timestamps, basic invoice) AND /invoices/:id
      // (adjustment_total + adjustments_applied — these are NOT returned by /jobs/:id).
      // Mirrors the same pattern used by runPaymentReconcile.
      let zbJob
      try {
        zbJob = await zbFetch(user.zenbooker_api_key, `/jobs/${job.zenbooker_id}`)
      } catch (e) {
        logger.error(`[Zenbooker] reconcile-job ${jobId}: ZB job fetch failed: ${e.message}`)
        return res.status(502).json({ error: 'zb_fetch_failed', detail: e.message })
      }

      // Merge the full invoice (with adjustment fields) onto zbJob.invoice when available.
      if (zbJob?.invoice?.id) {
        try {
          const invoiceData = await zbFetch(user.zenbooker_api_key, `/invoices/${zbJob.invoice.id}`)
          zbJob = { ...zbJob, invoice: { ...zbJob.invoice, ...invoiceData } }
        } catch (e) {
          // Non-fatal: fall through with whatever /jobs/:id gave us. mapJobFinancials
          // will omit adjustment fields when they're absent (see preserve rule).
          logger.warn(`[Zenbooker] reconcile-job ${jobId}: /invoices/${zbJob.invoice.id} fetch failed (non-fatal): ${e.message}`)
        }
      }

      const fin = stripDiagnostics(mapJobFinancials(zbJob, { existingSfTipAmount: job.tip_amount }))
      const lifecycleRaw = mapJobLifecycle(zbJob)
      const lifecycle = stripLifecycleDiagnostics(lifecycleRaw)

      // Status is handled separately via updateJobStatus (preserves audit
      // trail + outbox emission for LB-linked jobs). All other lifecycle
      // fields go into the regular UPDATE alongside financials.
      const { status: newStatus, ...lifecycleFields } = lifecycle

      const { data: jobBefore } = await supabase.from('jobs')
        .select('service_price, total, total_amount, tip_amount, additional_fees, fees_breakdown, taxes, discount, duration, status, scheduled_date, start_time, end_time, is_recurring, invoice_status, payment_status')
        .eq('id', jobId).single()

      const merged = { ...fin, ...lifecycleFields }
      const changes = {}
      for (const k of Object.keys(merged)) {
        const before = jobBefore?.[k]
        const after = merged[k]
        if (k === 'fees_breakdown') {
          if (JSON.stringify(before) !== JSON.stringify(after)) {
            changes[k] = { before, after }
          }
        } else if (k === 'is_recurring') {
          if (Boolean(before) !== Boolean(after)) changes[k] = { before, after }
        } else if (typeof after === 'string' || after == null && typeof before === 'string') {
          // Date/string fields — exact compare
          if (String(before || '') !== String(after || '')) {
            changes[k] = { before, after }
          }
        } else if (before !== after && Math.abs((parseFloat(before) || 0) - (parseFloat(after) || 0)) >= 0.01) {
          changes[k] = { before, after }
        }
      }

      let jobUpdateResult = { applied: false, changes }
      let statusUpdateResult = {
        previousStatus: jobBefore?.status || null,
        newStatus,
        changed: false,
        applied: false,
      }

      // Phase 1a: write non-status lifecycle + financial fields
      if (Object.keys(changes).length > 0 && !dryRun) {
        const { error: updErr } = await supabase.from('jobs').update(merged).eq('id', jobId)
        if (updErr) {
          logger.error(`[Zenbooker] reconcile-job ${jobId}: job update failed: ${updErr.message}`)
          return res.status(500).json({ error: 'job_update_failed', detail: updErr.message })
        }
        jobUpdateResult = { applied: true, changes }
      } else {
        jobUpdateResult = { applied: false, changes, dry_run: dryRun }
      }

      // Phase 1b: route status change through the centralized service so
      // status_history + outbox events fire correctly. Skip when ZB status
      // already matches SF (no-op) or in dry-run.
      if (newStatus && newStatus !== (jobBefore?.status || null)) {
        statusUpdateResult.changed = true
        if (!dryRun) {
          try {
            const result = await updateJobStatus(supabase, {
              jobId,
              userId,
              newStatus,
              source: 'system',
              actor: { type: 'system', id: userId, display_name: 'reconcile-job (admin)' },
            })
            statusUpdateResult.applied = true
            statusUpdateResult.outboundAction = result.outboundAction
          } catch (e) {
            logger.error(`[Zenbooker] reconcile-job ${jobId}: updateJobStatus failed: ${e.message}`)
            return res.status(500).json({ error: 'status_update_failed', detail: e.message })
          }
        } else {
          statusUpdateResult.applied = false
          statusUpdateResult.dry_run = true
        }
      }

      // ── Phase 2: safe ledger reconcile ──
      // Pass the projected financial update as jobOverrides so dry-run computes
      // intended ledger amounts against the would-be post-update job state, not
      // against pre-update stale data. (In apply mode, the UPDATE has already run,
      // so the overlay matches what's in the DB; harmless either way.)
      // We also overlay the would-be status so a job that's transitioning to
      // 'cancelled' makes the reconciler treat it as ineligible (no new earning
      // rows for cancelled jobs). Critically: even on cancel transition, this
      // never DELETES paid/unpaid rows (per safeReconcileJobLedger contract).
      const ledgerResult = await safeReconcileJobLedger(supabase, {
        jobId, userId, dryRun,
        jobOverrides: { ...fin, ...(newStatus ? { status: newStatus } : {}) },
      })

      // Cancelled-job advisory: if status will become / is 'cancelled' and the
      // job has earning/tip/incentive ledger rows, surface them — they're not
      // auto-deleted by this endpoint (insert-only contract). Operator decides.
      let cancellation_advisory = null
      if (newStatus === 'cancelled') {
        const { data: leftover } = await supabase
          .from('cleaner_ledger')
          .select('id, type, amount, payout_batch_id, effective_date')
          .eq('job_id', jobId)
          .in('type', ['earning', 'tip', 'incentive', 'cash_collected'])
        if (leftover && leftover.length > 0) {
          cancellation_advisory = {
            note: 'Job is transitioning to cancelled in ZB but has completion-derived ledger rows. They are NOT auto-deleted by this endpoint. Operator review required.',
            rows: leftover.map(r => ({ id: r.id, type: r.type, amount: parseFloat(r.amount), payout_batch_id: r.payout_batch_id, effective_date: r.effective_date })),
          }
        }
      }

      logger.log(`[Zenbooker] reconcile-job ${jobId} ${dryRun ? '(dry-run)' : ''}: jobUpdated=${jobUpdateResult.applied} statusChanged=${statusUpdateResult.changed} ledgerInserted=${ledgerResult.applied?.inserted?.length || 0} ledgerUpdated=${ledgerResult.applied?.updated?.length || 0} skippedPaid=${ledgerResult.skipped?.paid_rows_with_drift?.length || 0}`)

      res.json({
        ok: true,
        job_id: jobId,
        dry_run: dryRun,
        zb_invoice: zbJob?.invoice ? {
          subtotal: zbJob.invoice.subtotal,
          tip: zbJob.invoice.tip,
          total: zbJob.invoice.total,
          amount_paid: zbJob.invoice.amount_paid,
          status: zbJob.invoice.status,
          adjustment_total: zbJob.invoice.adjustment_total,
        } : null,
        zb_lifecycle: {
          status_raw: lifecycleRaw._zb_status_raw,
          canceled: lifecycleRaw._zb_canceled,
          rescheduled: lifecycleRaw._zb_rescheduled,
          start_date: zbJob?.start_date,
          started_at: zbJob?.started_at,
          completed_at: zbJob?.completed_at,
        },
        job_update: jobUpdateResult,
        status_update: statusUpdateResult,
        ledger_reconcile: ledgerResult,
        cancellation_advisory,
      })
    } catch (err) {
      logger.error(`[Zenbooker] reconcile-job error: ${err.message}`)
      res.status(500).json({ error: 'reconcile_failed', detail: err.message })
    }
  })

  // DELETE /disconnect — clear API key, keep data
  router.delete('/disconnect', authenticateToken, async (req, res) => {
    try {
      const userId = req.user.userId
      await supabase.from('users').update({
        zenbooker_api_key: null,
        zenbooker_status: null,
        zenbooker_last_sync: null,
      }).eq('id', userId)

      delete syncProgress[userId]
      logger.log(`[Zenbooker] Disconnected for user ${userId}`)
      res.json({ message: 'Disconnected. All synced data has been preserved.' })
    } catch (err) {
      logger.error(`[Zenbooker] Disconnect error: ${err.message}`)
      res.status(500).json({ error: 'Failed to disconnect' })
    }
  })

  // POST /webhook — receives ALL Zenbooker webhook events
  router.post('/webhook', async (req, res) => {
    try {
      // P0.2 (Constitution §6.1) — webhook authentication.
      // Flag OFF: observe-only; every delivery logs an audit line so operators
      // can read flag-on readiness from Loki BEFORE flipping the flag.
      // Flag ON: reject unsigned / unverified events with 4xx before any
      // database mutation occurs.
      const auth = authenticateZenbookerWebhook(req)
      if (!auth.ok) {
        logger.warn(`[Zenbooker] Webhook auth rejected: status=${auth.status} reason=${auth.reason} flag=${auth.flag}`)
        // P1.6 — audit auth-rejected inbound deliveries (no userId scope; this
        // is platform-edge observability before tenant resolution).
        await logDelivery(supabase, {
          userId: null,
          sourceSystem: 'zenbooker',
          destinationSystem: 'service_flow',
          channel: 'webhook',
          eventType: 'zb_inbound.auth_rejected',
          deliveryDirection: 'inbound',
          status: 'rejected',
          responseCode: auth.status,
          provider: 'zenbooker',
          errorMessage: auth.reason || 'webhook_auth_failed',
          context: { auth_reason: auth.reason, auth_flag: auth.flag },
        }, logger)
        return res.status(auth.status).json({ error: 'webhook_auth_failed', reason: auth.reason })
      }
      // Always emit an auth-observation line. The single structured prefix
      // [ZB-auth-observe] is the Loki query anchor for the flag-on readiness
      // dashboard. Fields:
      //   flag=on|off
      //   mode=hmac|shared_secret|none  (what passed, or none if no header)
      //   attempted=true|false          (did the request carry any auth header)
      //   reason=...                    (only set when attempted but invalid)
      const obs = `flag=${auth.flag} mode=${auth.mode || 'none'} attempted=${auth.attempted ? 'true' : 'false'}`
      if (auth.attempted && auth.reason && auth.reason !== 'no_auth_attempted' && !auth.mode) {
        logger.warn(`[ZB-auth-observe] ${obs} reason=${auth.reason}`)
      } else {
        logger.log(`[ZB-auth-observe] ${obs}`)
      }

      // Q2-B sampling (2026-05-17) confirmed ZB sends the field as `account`,
      // not `account_id`. The earlier `account_id` destructure was a latent
      // field-name mismatch that resolved to undefined and wrote null into
      // delivery_log.context.zb_account_id. Renamed to match the wire shape.
      const { event, data, account } = req.body
      if (!event || !data) {
        return res.status(400).json({ error: 'Missing event or data' })
      }

      // Q2-B instrumentation — top-level body KEY observation only.
      // Sample up to 50 deliveries OR 24h, whichever first. NEVER throws.
      // Auto-disable is intrinsic to the helper (see lib/zb-body-observe.js).
      // Activation: INSERT into platform_settings key='zb_body_observe'.
      const _bodyObs = await zbBodyObserve(supabase, req.body, { eventType: event, logger })

      logger.log(`[Zenbooker] Webhook received: ${event} | data keys: ${Object.keys(data || {}).join(',')} | data.id: ${data?.id || 'MISSING'} | data.job_id: ${data?.job_id || 'none'}`)

      // Find the user by checking who has this Zenbooker connection
      // (`account` from webhook payload can help if multiple users)
      const { data: users } = await supabase
        .from('users')
        .select('id, zenbooker_api_key')
        .eq('zenbooker_status', 'connected')

      if (!users || users.length === 0) {
        return res.json({ ok: true, skipped: 'No connected users' })
      }

      // Process for each connected user (typically just one)
      for (const user of users) {
        const startTs = Date.now()
        let outcome = 'sent'
        let handlerErr = null
        try {
          if (event.startsWith('job.')) {
            await handleJobEvent(event, data, user.id, user.zenbooker_api_key)
          } else if (event.startsWith('invoice_payment.') || event.startsWith('invoice.payment_')) {
            // Normalize event name: invoice.payment_recorded → invoice_payment.recorded
            const normalizedEvent = event.replace('invoice.payment_', 'invoice_payment.')
            await handlePaymentEvent(normalizedEvent, data, user.id, user.zenbooker_api_key)
          } else if (event.startsWith('invoice.') && !event.startsWith('invoice_payment.')) {
            // Invoice updated/created — re-fetch the job to update prices
            const jobZbId = data.job_id || data.job?.id
            if (jobZbId) {
              await handleJobEvent('job.updated', { id: jobZbId }, user.id, user.zenbooker_api_key)
              logger.log(`[Zenbooker] Invoice event ${event} → updated job ${jobZbId}`)
            } else {
              logger.log(`[Zenbooker] Invoice event ${event} — no job_id to update`)
            }
          } else if (event.startsWith('customer.')) {
            // Customer created/edited — sync via upsert-with-adoption
            // (dedups against existing SF-only customer by phone/email so we don't create duplicates
            //  when a customer was created in SF first, then later appears in Zenbooker)
            if (data?.id && user.zenbooker_api_key) {
              try {
                const zbCustomer = await zbFetch(user.zenbooker_api_key, `/customers/${data.id}`)
                const result = await upsertCustomerFromZB(user.id, zbCustomer)
                logger.log(`[Zenbooker] Customer ${result.mode}: ${data.id} → SF #${result.id} (${event})`)
              } catch (custErr) { logger.error(`[Zenbooker] Customer sync error: ${custErr.message}`) }
            }
          } else if (event === 'recurring_booking.created' || event === 'recurring_booking.canceled') {
            // Recurring bookings generate jobs — those come via job.created webhook
            logger.log(`[Zenbooker] Recurring event: ${event} — jobs will arrive via job.created`)
          } else {
            logger.log(`[Zenbooker] Unhandled event: ${event}`)
          }
          // Phase B outbound correlation — after the existing inbound
          // dispatch completes, check whether this echo confirms any open
          // SF→ZB command. Phase B scope: only job.created → job.create.
          // Other event types short-circuit inside isCorrelatable.
          if (isCorrelatable(event)) {
            try {
              await correlateInboundEcho(supabase, {
                userId: user.id,
                event,
                data,
                webhookId: req.body && req.body.webhook_id,
                logger,
              })
            } catch (cErr) {
              logger.warn(`[Zenbooker] correlation (non-blocking) failed: ${cErr.message}`)
            }
          }
        } catch (err) {
          logger.error(`[Zenbooker] Webhook handler error for user ${user.id}: ${err.message}`)
          outcome = 'failed'
          handlerErr = err
        }
        // P1.6 — unified inbound delivery audit. One row per (user, event)
        // pair. Idempotency on the correlation_id (ZB event id) means a
        // replayed webhook can be detected at the audit layer.
        await logDelivery(supabase, {
          userId: user.id,
          sourceSystem: 'zenbooker',
          destinationSystem: 'service_flow',
          channel: 'webhook',
          eventType: `zb_inbound.${event}`,
          correlationId: data?.id || data?.job_id || data?.job?.id || null,
          deliveryDirection: 'inbound',
          status: outcome,
          latencyMs: Date.now() - startTs,
          provider: 'zenbooker',
          error: handlerErr,
          context: {
            event,
            zb_account_id: account || null,
            auth_mode: auth.mode || 'none',
            auth_flag: auth.flag,
          },
        }, logger)
      }

      res.json({ ok: true })
    } catch (err) {
      logger.error(`[Zenbooker] Webhook error: ${err.message}`)
      res.status(500).json({ error: 'Webhook processing failed' })
    }
  })

  return router
}
