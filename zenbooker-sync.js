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

module.exports = (supabase, logger) => {
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
      base_price: parseFloat(zb.price) || 0,
      duration: zb.duration || 0,
      zenbooker_id: zb.id,
      status: 'active',
    }
  }

  function mapTeamMember(zb, userId) {
    const nameParts = (zb.name || '').split(' ')
    return {
      user_id: userId,
      first_name: nameParts[0] || '',
      last_name: nameParts.slice(1).join(' ') || '',
      email: zb.email || '',
      phone: zb.phone || '',
      zenbooker_id: zb.id,
      status: 'active',
      role: 'service_provider',
    }
  }

  function mapCustomer(zb, userId) {
    const nameParts = (zb.name || '').split(' ')
    const addr = zb.addresses?.[0] || {}
    return {
      user_id: userId,
      first_name: nameParts[0] || '',
      last_name: nameParts.slice(1).join(' ') || '',
      email: zb.email || '',
      phone: zb.phone || '',
      address: addr.line1 || '',
      city: addr.city || '',
      state: addr.state || '',
      zip_code: addr.postal_code || '',
      zenbooker_id: zb.id,
    }
  }

  const STATUS_MAP = {
    'scheduled': 'scheduled',
    'en-route': 'in_progress',
    'started': 'in_progress',
    'complete': 'completed',
  }

  function mapJob(zb, userId, lookups) {
    const { customerMap, serviceMap, teamMap, territoryMap } = lookups
    const status = zb.canceled ? 'cancelled' : (STATUS_MAP[(zb.status || '').toLowerCase()] || 'scheduled')
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

    return {
      user_id: userId,
      customer_id: customerId,
      service_id: serviceId,
      service_name: zb.service_name || '',
      team_member_id: teamMemberId,
      territory_id: territoryId,
      status,
      scheduled_date: zb.start_date || null,
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
      total_paid_amount: parseFloat(inv.amount_paid) || 0,
      invoice_status: inv.status === 'paid' ? 'paid' : (inv.status === 'unpaid' ? 'invoiced' : 'draft'),
      payment_status: inv.status === 'paid' ? 'paid' : 'pending',
      is_recurring: zb.recurring === true,
      zenbooker_id: zb.id,
    }
  }

  // ══════════════════════════════════════
  // Sync Engine
  // ══════════════════════════════════════
  // Find existing record by zenbooker_id first, then by natural key (name, email, etc.)
  async function findOrLink(table, userId, zbId, naturalMatch) {
    // 1. Already linked by zenbooker_id
    const { data: linked } = await supabase.from(table).select('id').eq('user_id', userId).eq('zenbooker_id', zbId).maybeSingle()
    if (linked) return { id: linked.id, wasLinked: true }

    // 2. Try natural key match (existing record without zenbooker_id)
    if (naturalMatch) {
      let q = supabase.from(table).select('id').eq('user_id', userId).is('zenbooker_id', null)
      Object.entries(naturalMatch).forEach(([k, v]) => {
        if (v) q = q.ilike(k, v)
      })
      const { data: matched } = await q.limit(1).maybeSingle()
      if (matched) {
        // Link existing record
        await supabase.from(table).update({ zenbooker_id: zbId }).eq('id', matched.id)
        return { id: matched.id, wasLinked: false, newlyLinked: true }
      }
    }

    return null // Not found — needs insert
  }

  async function syncTerritories(userId, apiKey) {
    const zbTerritories = await zbFetchAll(apiKey, '/territories')
    let created = 0, updated = 0, linked = 0
    for (const zb of zbTerritories) {
      const mapped = mapTerritory(zb, userId)
      const found = await findOrLink('territories', userId, zb.id, { name: zb.name })
      if (found) {
        await supabase.from('territories').update(mapped).eq('id', found.id)
        if (found.newlyLinked) linked++; else updated++
      } else {
        await supabase.from('territories').insert(mapped)
        created++
      }
    }
    return { total: zbTerritories.length, created, updated, linked }
  }

  async function syncServices(userId, apiKey) {
    const zbServices = await zbFetchAll(apiKey, '/services')
    let created = 0, updated = 0, linked = 0
    for (const zb of zbServices) {
      const mapped = mapService(zb, userId)
      const found = await findOrLink('services', userId, zb.id, { name: zb.name })
      if (found) {
        // Don't overwrite base_price if already set
        const { base_price, ...safeUpdate } = mapped
        await supabase.from('services').update(safeUpdate).eq('id', found.id)
        if (found.newlyLinked) linked++; else updated++
      } else {
        await supabase.from('services').insert(mapped)
        created++
      }
    }
    return { total: zbServices.length, created, updated, linked }
  }

  async function syncTeamMembers(userId, apiKey) {
    const zbTeam = await zbFetchAll(apiKey, '/team_members')
    let created = 0, updated = 0, linked = 0
    for (const zb of zbTeam) {
      const mapped = mapTeamMember(zb, userId)
      // Match by email first, then by name
      const naturalMatch = zb.email ? { email: zb.email } : { first_name: mapped.first_name }
      const found = await findOrLink('team_members', userId, zb.id, naturalMatch)
      if (found) {
        // Don't overwrite hourly_rate, commission_percentage, role, status
        const { role, status, ...safeUpdate } = mapped
        await supabase.from('team_members').update(safeUpdate).eq('id', found.id)
        if (found.newlyLinked) linked++; else updated++
      } else {
        await supabase.from('team_members').insert(mapped)
        created++
      }
    }
    return { total: zbTeam.length, created, updated, linked }
  }

  async function syncCustomers(userId, apiKey) {
    const zbCustomers = await zbFetchAll(apiKey, '/customers')
    let created = 0, updated = 0, linked = 0
    for (const zb of zbCustomers) {
      const mapped = mapCustomer(zb, userId)
      // Match by email first, then by phone
      const naturalMatch = zb.email ? { email: zb.email } : (zb.phone ? { phone: zb.phone } : null)
      const found = await findOrLink('customers', userId, zb.id, naturalMatch)
      if (found) {
        await supabase.from('customers').update(mapped).eq('id', found.id)
        if (found.newlyLinked) linked++; else updated++
      } else {
        await supabase.from('customers').insert(mapped)
        created++
      }
    }
    return { total: zbCustomers.length, created, updated, linked }
  }

  async function syncJobs(userId, apiKey, params = {}) {
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

    const zbJobs = await zbFetchAll(apiKey, '/jobs', params)
    let created = 0, updated = 0, linked = 0
    for (const zb of zbJobs) {
      const mapped = mapJob(zb, userId, lookups)

      // 1. Already linked by zenbooker_id
      const { data: byZbId } = await supabase.from('jobs').select('id').eq('user_id', userId).eq('zenbooker_id', zb.id).maybeSingle()
      if (byZbId) {
        await supabase.from('jobs').update(mapped).eq('id', byZbId.id)
        updated++
        continue
      }

      // 2. Try matching existing unlinked job by date + customer + service
      if (mapped.scheduled_date && mapped.customer_id) {
        const dateStr = String(mapped.scheduled_date).split('T')[0].split(' ')[0]
        const { data: matchedJob } = await supabase.from('jobs')
          .select('id')
          .eq('user_id', userId)
          .is('zenbooker_id', null)
          .eq('customer_id', mapped.customer_id)
          .gte('scheduled_date', dateStr)
          .lt('scheduled_date', dateStr + ' 23:59:59')
          .limit(1)
          .maybeSingle()
        if (matchedJob) {
          await supabase.from('jobs').update({ ...mapped, zenbooker_id: zb.id }).eq('id', matchedJob.id)
          linked++
          continue
        }
      }

      // 3. Create new
      await supabase.from('jobs').insert(mapped)
      created++
    }
    return { total: zbJobs.length, created, updated, linked }
  }

  async function runFullSync(userId, apiKey) {
    const results = {}
    syncProgress[userId] = { status: 'running', phase: 'territories', progress: 0 }

    try {
      syncProgress[userId] = { status: 'running', phase: 'territories', progress: 10 }
      logger.log('[Zenbooker] Syncing territories...')
      results.territories = await syncTerritories(userId, apiKey)
      logger.log(`[Zenbooker] Territories done: ${JSON.stringify(results.territories)}`)

      syncProgress[userId] = { status: 'running', phase: 'services', progress: 25 }
      logger.log('[Zenbooker] Syncing services...')
      results.services = await syncServices(userId, apiKey)
      logger.log(`[Zenbooker] Services done: ${JSON.stringify(results.services)}`)

      syncProgress[userId] = { status: 'running', phase: 'team_members', progress: 40 }
      logger.log('[Zenbooker] Syncing team members...')
      results.teamMembers = await syncTeamMembers(userId, apiKey)
      logger.log(`[Zenbooker] Team members done: ${JSON.stringify(results.teamMembers)}`)

      syncProgress[userId] = { status: 'running', phase: 'customers', progress: 55 }
      logger.log('[Zenbooker] Syncing customers...')
      results.customers = await syncCustomers(userId, apiKey)
      logger.log(`[Zenbooker] Customers done: ${JSON.stringify(results.customers)}`)

      syncProgress[userId] = { status: 'running', phase: 'jobs', progress: 70 }
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

  // POST /sync — manual full sync
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

      // Run in background
      runFullSync(userId, user.zenbooker_api_key).catch(err => {
        logger.error(`[Zenbooker] Manual sync failed: ${err.message}`)
      })

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
          } else if (event.startsWith('invoice_payment.')) {
            await handlePaymentEvent(event, data, user.id)
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
