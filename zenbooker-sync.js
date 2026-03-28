/**
 * Zenbooker Integration Module (Loosely Coupled)
 *
 * Mount: app.use('/api/zenbooker', require('./zenbooker-sync')(supabase, logger))
 * Remove: delete this file + remove the line above = zero breakage
 */

const express = require('express')

const ZB_BASE = 'https://api.zenbooker.com/v1'

// In-memory sync progress tracking (per userId)
const syncProgress = {}

module.exports = (supabase, logger, createLedgerEntriesForCompletedJob) => {
  const router = express.Router()

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
    const res = await fetch(url.toString(), {
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      timeout: 30000
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`Zenbooker API ${res.status}: ${body}`)
    }
    return res.json()
  }

  async function zbFetchAll(apiKey, path, params = {}) {
    const all = []
    let cursor = 0
    let page = 0
    while (true) {
      page++
      logger.log(`[Zenbooker] Fetching ${path} page ${page} (cursor=${cursor})`)
      const data = await zbFetch(apiKey, path, { ...params, cursor, limit: 100 })
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

  function mapJob(zb, userId, lookups) {
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

    const mapped = {
      user_id: userId,
      customer_id: customerId,
      service_id: serviceId,
      service_name: zb.service_name || '',
      team_member_id: teamMemberId,
      territory_id: territoryId,
      status,
      scheduled_date: zbDateToLocal(zb.start_date, zb.timezone),
      duration: zb.estimated_duration_seconds ? Math.round(zb.estimated_duration_seconds / 60) : 0,
      service_address_street: addr.line1 || addr.formatted || '',
      service_address_city: addr.city || '',
      service_address_state: addr.state || '',
      service_address_zip: addr.postal_code || '',
      price: parseFloat(inv.subtotal) || 0,
      service_price: parseFloat(inv.subtotal) || 0,
      total: parseFloat(inv.total) || 0,
      total_amount: parseFloat(inv.total) || 0,
      taxes: parseFloat(inv.tax_amount || inv.total_tax_amount) || 0,
      discount: parseFloat(inv.discount_amount) || 0,
      tip_amount: parseFloat(inv.tip || inv.tip_amount) || 0,
      invoice_status: inv.status === 'paid' ? 'paid' : (inv.status === 'unpaid' ? 'invoiced' : 'draft'),
      is_recurring: zb.recurring === true,
      zenbooker_id: zb.id,
    }
    // Real timestamps from Zenbooker (started_at, completed_at)
    if (zb.started_at) mapped.start_time = zb.started_at
    if (zb.completed_at) mapped.end_time = zb.completed_at
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
    let created = 0, skipped = 0, errors = 0
    for (const zb of zbTerritories) {
      try {
        // Skip if already exists
        const { data: existing } = await supabase.from('territories').select('id').eq('user_id', userId).eq('zenbooker_id', zb.id).maybeSingle()
        if (existing) { skipped++; continue }
        const mapped = mapTerritory(zb, userId)
        const { error } = await supabase.from('territories').insert(mapped)
        if (error) { logger.error(`[Zenbooker] Territory insert error: ${JSON.stringify(error)}`); errors++ }
        else created++
      } catch (err) {
        logger.error(`[Zenbooker] Territory CRASH ${zb.name}: ${err.message}`); errors++
      }
    }
    return { total: zbTerritories.length, created, skipped, errors }
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
    let created = 0, skipped = 0, errors = 0
    for (const zb of zbTeam) {
      const { data: existing } = await supabase.from('team_members').select('id').eq('user_id', userId).eq('zenbooker_id', zb.id).maybeSingle()
      if (existing) { skipped++; continue }
      const mapped = mapTeamMember(zb, userId)
      // Clear email if it matches the account owner to prevent role conflicts on login
      if (ownerEmail && (mapped.email || '').toLowerCase().trim() === ownerEmail) {
        logger.log(`[Zenbooker] Clearing owner email from team member ${zb.name} to avoid role conflict`)
        mapped.email = ''
      }
      const { error } = await supabase.from('team_members').insert(mapped)
      if (error) { logger.error(`[Zenbooker] Team insert error ${zb.name}: ${JSON.stringify(error)}`); errors++ }
      else created++
    }
    return { total: zbTeam.length, created, skipped, errors }
  }

  async function syncCustomers(userId, apiKey) {
    const zbCustomers = await zbFetchAll(apiKey, '/customers')
    let created = 0, skipped = 0, errors = 0
    const total = zbCustomers.length
    let processed = 0
    for (const zb of zbCustomers) {
      processed++
      // Skip if already exists by zenbooker_id
      const { data: existing } = await supabase.from('customers').select('id').eq('user_id', userId).eq('zenbooker_id', zb.id).maybeSingle()
      if (existing) { skipped++; continue }
      if (processed % 20 === 0) {
        syncProgress[userId] = { ...syncProgress[userId], phase: `Customers (${processed}/${total})`, detail: `${created} new, ${skipped} skipped` }
      }
      const mapped = mapCustomer(zb, userId)
      const { error } = await supabase.from('customers').insert(mapped)
      if (error) { logger.error(`[Zenbooker] Customer insert error ${zb.name}: ${JSON.stringify(error)}`); errors++ }
      else created++
    }
    return { total: zbCustomers.length, created, skipped, errors }
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
    if (!data?.id) return

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

    const mapped = mapJob(zbJob, userId, { customerMap, serviceMap, teamMap, territoryMap })

    // Sync customer if new
    if (zbJob.customer?.id && !customerMap[zbJob.customer.id]) {
      try {
        const zbCustomer = await zbFetch(apiKey, `/customers/${zbJob.customer.id}`)
        const mappedCustomer = mapCustomer(zbCustomer, userId)
        const { data: inserted } = await supabase.from('customers').insert(mappedCustomer).select('id').single()
        if (inserted) mapped.customer_id = inserted.id
      } catch { /* customer sync failed, continue without linking */ }
    }

    const { data: existing } = await supabase.from('jobs').select('id').eq('user_id', userId).eq('zenbooker_id', data.id).maybeSingle()
    if (existing) {
      await supabase.from('jobs').update(mapped).eq('id', existing.id)
      logger.log(`[Zenbooker] Job updated: ${data.id} (${eventType})`)
    } else {
      await supabase.from('jobs').insert(mapped)
      logger.log(`[Zenbooker] Job created: ${data.id} (${eventType})`)
    }
  }

  async function handlePaymentEvent(eventType, data, userId) {
    if (!data?.job_id && !data?.invoice_id) return
    // Find job by zenbooker invoice/job reference
    const jobZbId = data.job_id || data.job?.id
    if (!jobZbId) return

    const { data: job } = await supabase.from('jobs').select('id').eq('user_id', userId).eq('zenbooker_id', jobZbId).maybeSingle()
    if (!job) return

    const update = {}
    if (eventType === 'invoice_payment.succeeded' || eventType === 'invoice_payment.recorded') {
      update.payment_status = 'paid'
      update.invoice_status = 'paid'
      if (data.amount_paid) update.total_paid_amount = parseFloat(data.amount_paid) || 0
    } else if (eventType === 'invoice_payment.voided') {
      update.payment_status = 'pending'
      update.invoice_status = 'invoiced'
    }
    if (Object.keys(update).length > 0) {
      await supabase.from('jobs').update(update).eq('id', job.id)
      logger.log(`[Zenbooker] Payment ${eventType}: job ${job.id}`)
    }
  }

  // ══════════════════════════════════════
  // Routes
  // ══════════════════════════════════════

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
    try {
      const userId = req.user.userId
      const { data: user } = await supabase.from('users').select('zenbooker_api_key, zenbooker_status').eq('id', userId).single()
      if (!user?.zenbooker_api_key || user.zenbooker_status !== 'connected') {
        return res.status(400).json({ error: 'Zenbooker not connected' })
      }

      if (syncProgress[userId]?.status === 'running') {
        return res.status(409).json({ error: 'Sync already in progress' })
      }

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
            // Fetch ALL jobs from Zenbooker and update status/invoice/team assignments for existing SF jobs
            syncProgress[userId] = { status: 'running', phase: 'Fetching jobs...', progress: 5 }
            const zbJobs = await zbFetchAll(apiKey, '/jobs')
            logger.log(`[Zenbooker] Reconcile: ${zbJobs.length} jobs from Zenbooker`)

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
              if (sfJob.status !== zbStatus) update.status = zbStatus
              if (sfJob.invoice_status !== zbInvoiceStatus) update.invoice_status = zbInvoiceStatus
              if (zbPaymentStatus) update.payment_status = zbPaymentStatus
              // Always sync timestamps, prices, discounts
              update.scheduled_date = zbDateToLocal(zb.start_date, zb.timezone)
              update.price = parseFloat(inv.subtotal) || undefined
              update.service_price = parseFloat(inv.subtotal) || undefined
              update.total = parseFloat(inv.total) || undefined
              update.total_amount = parseFloat(inv.total) || undefined
              update.discount = parseFloat(inv.discount_amount) || 0
              update.additional_fees = parseFloat(inv.additional_fees || inv.fees_amount) || 0
              update.tip_amount = parseFloat(inv.tip || inv.tip_amount) || 0
              update.taxes = parseFloat(inv.tax_amount || inv.total_tax_amount) || 0
              // Real start/end times from Zenbooker
              if (zb.started_at) update.start_time = zb.started_at
              if (zb.completed_at) update.end_time = zb.completed_at

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
                // Delete old entries for this job
                await supabase.from('cleaner_ledger').delete().eq('job_id', jobId).in('type', ['earning', 'tip', 'incentive'])
                // Recreate with correct member count
                try {
                  await createLedgerEntriesForCompletedJob(jobId, userId)
                  ledgerRebuilt++
                } catch (e) {
                  logger.error(`[Zenbooker] Ledger rebuild error job ${jobId}: ${e.message}`)
                }
                if (ledgerRebuilt % 50 === 0) {
                  syncProgress[userId] = { ...syncProgress[userId], phase: `Rebuilding ledger (${ledgerRebuilt}/${multiJobIds.length})`, progress: 80 + Math.round((ledgerRebuilt / multiJobIds.length) * 15) }
                }
              }
              results.reconcile.ledgerRebuilt = ledgerRebuilt
              logger.log(`[Zenbooker] Reconcile: rebuilt ledger for ${ledgerRebuilt} jobs`)
            }

            results.reconcile = { total, updated, skipped, errors, assignmentsFixed }
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

      runSync()
      res.json({ message: 'Sync started' })
    } catch (err) {
      logger.error(`[Zenbooker] Sync trigger error: ${err.message}`)
      res.status(500).json({ error: 'Failed to start sync' })
    }
  })

  // GET /sync/progress — poll sync progress
  router.get('/sync/progress', authenticateToken, (req, res) => {
    res.json(syncProgress[req.user.userId] || { status: 'idle' })
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
      const { event, data, account_id } = req.body
      if (!event || !data) {
        return res.status(400).json({ error: 'Missing event or data' })
      }

      logger.log(`[Zenbooker] Webhook received: ${event}`)

      // Find the user by checking who has this Zenbooker connection
      // (account_id from webhook payload can help if multiple users)
      const { data: users } = await supabase
        .from('users')
        .select('id, zenbooker_api_key')
        .eq('zenbooker_status', 'connected')

      if (!users || users.length === 0) {
        return res.json({ ok: true, skipped: 'No connected users' })
      }

      // Process for each connected user (typically just one)
      for (const user of users) {
        try {
          if (event.startsWith('job.')) {
            await handleJobEvent(event, data, user.id, user.zenbooker_api_key)
          } else if (event.startsWith('invoice_payment.') || event.startsWith('invoice.payment_')) {
            // Normalize event name: invoice.payment_recorded → invoice_payment.recorded
            const normalizedEvent = event.replace('invoice.payment_', 'invoice_payment.')
            await handlePaymentEvent(normalizedEvent, data, user.id)
          } else if (event === 'recurring_booking.created' || event === 'recurring_booking.canceled') {
            // Recurring bookings generate jobs — those come via job.created webhook
            logger.log(`[Zenbooker] Recurring event: ${event} — jobs will arrive via job.created`)
          } else {
            logger.log(`[Zenbooker] Unhandled event: ${event}`)
          }
        } catch (err) {
          logger.error(`[Zenbooker] Webhook handler error for user ${user.id}: ${err.message}`)
        }
      }

      res.json({ ok: true })
    } catch (err) {
      logger.error(`[Zenbooker] Webhook error: ${err.message}`)
      res.status(500).json({ error: 'Webhook processing failed' })
    }
  })

  return router
}
