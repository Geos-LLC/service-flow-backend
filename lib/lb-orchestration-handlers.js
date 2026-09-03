'use strict';

// LB orchestration handlers — Phase 2B.
//
// Endpoints, all gated by isOrchestrationEnabledForTenant:
//
//   GET  /orchestration/availability   (slot computation w/ conflict filter)
//   GET  /orchestration/busy           (raw busy windows — read-only calendar sync)
//   GET  /orchestration/locations      (tenant's territories — for LB's Calendars UI)
//   POST /orchestration/booking-request
//   POST /orchestration/booking-cancel
//   POST /orchestration/handoff
//
// Common patterns across handlers:
//
//   1. Feature-flag gate (via requireOrchestrationEnabled middleware
//      at route registration time).
//   2. Idempotency: every POST takes an optional `idempotency_key`. If
//      a prior attempt with the same (tenant, endpoint, key) exists in
//      `lb_orchestration_attempts`, we return its stored response.
//   3. Audit: every attempt — success, replay, conflict, invalid —
//      persists to lb_orchestration_attempts with the response_status,
//      result classification, and (if applicable) the created sf_job_id.
//   4. Tenant scope: every DB query enforces user_id = req.user.userId.
//   5. No direct status mutation: booking-cancel calls into the
//      existing job-status-service so all status writes go through the
//      single audited path.
//
// Hard constraints:
//   - never writes jobs.status from raw SQL
//   - never bypasses outbound-event UNIQUE constraint
//   - never accepts a slot_token issued for a different tenant
//   - LB cannot mutate operational internals (cleaner, ledger, payment)

const { verifySlotToken, hashIdempotencyKey } = require('./lb-orchestration-token');
const { findAvailableSlots } = require('./lb-orchestration-availability');
const {
  recordOrchestrationOutbound,
} = require('./lb-orchestration-events');
// Authoritative emission path — owned by the operational write service.
// Booking-request inserts the job, then delegates service_scheduled
// emission to this helper. This way the event only fires when canonical
// SF state exists; if anything before the helper throws, no event leaks
// to LB. Re-required lazily inside the factory so the module's other
// helpers stay test-friendly without the full service dependency.
let _maybeEmitOrchestrationInsertEvent = null;
function getMaybeEmitOrchestrationInsertEvent() {
  if (!_maybeEmitOrchestrationInsertEvent) {
    _maybeEmitOrchestrationInsertEvent = require('../services/job-status-service').maybeEmitOrchestrationInsertEvent;
  }
  return _maybeEmitOrchestrationInsertEvent;
}

// ──────────────────────────────────────────────────────────────────
// Idempotency helpers
// ──────────────────────────────────────────────────────────────────
async function findIdempotentReply(supabase, userId, endpoint, idempotency_key) {
  if (!idempotency_key) return null;
  const { data, error } = await supabase
    .from('lb_orchestration_attempts')
    .select('id, response_status, response_payload, sf_job_id, result')
    .eq('user_id', userId)
    .eq('endpoint', endpoint)
    .eq('idempotency_key', idempotency_key)
    .maybeSingle();
  if (error || !data) return null;
  return data;
}

async function recordAttempt(supabase, args) {
  // Best-effort audit log. Never fail the request because of audit
  // persistence — that creates a security ostrich.
  try {
    await supabase.from('lb_orchestration_attempts').insert({
      user_id: args.userId,
      endpoint: args.endpoint,
      idempotency_key: args.idempotency_key || null,
      orchestration_session_id: args.orchestration_session_id || null,
      request_payload: args.request_payload || null,
      response_status: args.response_status,
      response_payload: args.response_payload || null,
      sf_job_id: args.sf_job_id || null,
      result: args.result,
    });
  } catch (e) {
    (args.logger || console).warn?.(`[LB Orch] audit insert failed: ${e?.message}`);
  }
}

// ──────────────────────────────────────────────────────────────────
// GET /orchestration/availability
// ──────────────────────────────────────────────────────────────────
function makeAvailabilityHandler({ supabase, logger }) {
  return async function availabilityHandler(req, res) {
    const userId = req.user.userId;
    const service_id = req.query.service_id ? Number(req.query.service_id) : null;
    const requested_at = String(req.query.requested_at || '');
    const window_minutes = Number(req.query.window_minutes || 240);
    const duration_minutes = Number(req.query.duration_minutes || 180);

    if (!requested_at) {
      const payload = { error: 'requested_at is required (ISO timestamp)' };
      await recordAttempt(supabase, {
        userId, endpoint: 'availability', request_payload: req.query,
        response_status: 400, response_payload: payload, result: 'invalid', logger,
      });
      return res.status(400).json(payload);
    }
    try {
      const result = await findAvailableSlots(supabase, {
        userId,
        service_id,
        requested_at_iso: requested_at,
        window_minutes,
        duration_minutes,
        logger,
      });
      const responsePayload = { tenant_id: userId, ...result };
      await recordAttempt(supabase, {
        userId, endpoint: 'availability',
        request_payload: req.query,
        response_status: 200,
        response_payload: { candidate_count: result.candidate_slots.length, search_window: result.search_window },
        result: 'success',
        logger,
      });
      return res.json(responsePayload);
    } catch (e) {
      logger.error?.(`[LB Orch] availability failed user=${userId}: ${e.message}`);
      const payload = { error: 'availability_lookup_failed', message: e.message };
      await recordAttempt(supabase, {
        userId, endpoint: 'availability', request_payload: req.query,
        response_status: 500, response_payload: payload, result: 'error', logger,
      });
      return res.status(500).json(payload);
    }
  };
}

// ──────────────────────────────────────────────────────────────────
// GET /orchestration/locations
// ──────────────────────────────────────────────────────────────────
// Read-only list of the tenant's SF territories. LB uses this to
// populate the "SF location" dropdown in its Calendars settings UI so
// operators can assign each LB account (Yelp / Thumbtack business) to
// a specific SF location. The resulting sfLocationId is sent verbatim
// on subsequent /orchestration/busy calls.
function makeLocationsHandler({ supabase, logger }) {
  return async function locationsHandler(req, res) {
    const userId = req.user.userId;
    try {
      const { data, error } = await supabase
        .from('territories')
        .select('id, name')
        .eq('user_id', userId)
        .order('name', { ascending: true });
      if (error) throw new Error(error.message);
      const locations = (data || []).map(t => ({
        id: t.id,
        name: t.name,
      }));
      await recordAttempt(supabase, {
        userId, endpoint: 'locations', request_payload: null,
        response_status: 200,
        response_payload: { count: locations.length },
        result: 'success', logger,
      });
      return res.json({ tenant_id: userId, locations });
    } catch (e) {
      logger.error?.(`[LB Orch] locations failed user=${userId}: ${e.message}`);
      const payload = { error: 'locations_lookup_failed', message: e.message };
      await recordAttempt(supabase, {
        userId, endpoint: 'locations', request_payload: null,
        response_status: 500, response_payload: payload, result: 'error', logger,
      });
      return res.status(500).json(payload);
    }
  };
}

// ──────────────────────────────────────────────────────────────────
// GET /orchestration/busy
// ──────────────────────────────────────────────────────────────────
// Read-only "when is the tenant's calendar busy" endpoint. LB uses
// this as one input to the AI's AVAILABILITY REFERENCE block — the
// working-hours envelope stays on LB's side; SF only reports raw
// job windows the AI must not offer over.
//
// Cancelled jobs don't block; matches the same enum invariant as
// findAvailableSlots (see lb-orchestration-availability.js).
//
// Location scoping: LB sends `external_business_id` (= SavedAccount.businessId
// — Yelp/Thumbtack business id) and optionally `external_location_id`. The
// caller-supplied `resolveLocationForOrchestrationScope` resolves that pair
// to a sf_location_id via existing `provider_accounts` +
// `communication_account_location_mappings`. When resolved, the query is
// scoped to `jobs.territory_id = sf_location_id`. When
// `external_business_id` is provided but unresolvable, we fail-closed
// (empty busy) rather than leak busy from sibling locations.
const {
  computeCapacityBusyWindows,
  enumerateDates,
  jobIntervalOnDate,
} = require('./lb-orchestration-capacity');

function makeBusyHandler({ supabase, logger, resolveLocationForOrchestrationScope }) {
  return async function busyHandler(req, res) {
    const userId = req.user.userId;
    const fromIso = String(req.query.from || '');
    const toIso   = String(req.query.to || '');
    // mode=jobs (default) — historical behavior, one busy window per
    // scheduled job. AI booking-request path relies on this signal.
    // mode=capacity — location-level aggregation: emit an AM/PM busy
    // window only when every cleaner assigned to the scoped territory is
    // either off (per team_members.availability) or fully booked in that
    // half-day. Powers the operator-facing LB calendar.
    const mode = String(req.query.mode || 'jobs').toLowerCase();
    const externalBusinessId = req.query.external_business_id
      ? String(req.query.external_business_id) : null;
    const externalLocationId = req.query.external_location_id
      ? String(req.query.external_location_id) : null;
    // sf_location_id (direct) takes precedence over the external_business_id
    // resolver path. LB uses this when the operator has assigned an SF
    // location to an LB account in the Calendars settings UI — the mapping
    // then lives on LB's side and SF doesn't re-resolve.
    const explicitLocationId = req.query.sf_location_id
      ? Number(req.query.sf_location_id) : null;
    if (!fromIso || !toIso) {
      const payload = { error: 'from and to are required (ISO timestamps)' };
      await recordAttempt(supabase, {
        userId, endpoint: 'busy', request_payload: req.query,
        response_status: 400, response_payload: payload, result: 'invalid', logger,
      });
      return res.status(400).json(payload);
    }
    const fromMs = new Date(fromIso).getTime();
    const toMs = new Date(toIso).getTime();
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) {
      const payload = { error: 'invalid range' };
      await recordAttempt(supabase, {
        userId, endpoint: 'busy', request_payload: req.query,
        response_status: 400, response_payload: payload, result: 'invalid', logger,
      });
      return res.status(400).json(payload);
    }
    // Cap the range at 60 days so an operator scrolling months can't
    // pull the whole jobs table.
    const MAX_RANGE_MS = 60 * 24 * 60 * 60 * 1000;
    if (toMs - fromMs > MAX_RANGE_MS) {
      const payload = { error: 'range too large (max 60 days)' };
      await recordAttempt(supabase, {
        userId, endpoint: 'busy', request_payload: req.query,
        response_status: 400, response_payload: payload, result: 'invalid', logger,
      });
      return res.status(400).json(payload);
    }
    // Location scope resolution.
    //
    // Precedence:
    //   1. explicit sf_location_id (LB-owned assignment) — use verbatim
    //   2. external_business_id → provider_accounts → resolveConversationLocation
    //   3. neither → tenant-wide (backwards-compat, single-location tenants)
    //
    // Fail-closed on unresolved scope: returning tenant-wide busy when
    // per-account scoping was requested would surface sibling-location
    // jobs to the AI (Karen D. / K&D class).
    let scopedLocationId = null;
    let scopeResolution = 'not_requested';
    if (Number.isFinite(explicitLocationId) && explicitLocationId > 0) {
      scopedLocationId = explicitLocationId;
      scopeResolution = 'explicit';
    } else if (externalBusinessId) {
      if (typeof resolveLocationForOrchestrationScope !== 'function') {
        logger.warn?.(`[LB Orch] busy: scope requested but resolver unavailable user=${userId}`);
      } else {
        try {
          const scope = await resolveLocationForOrchestrationScope({
            userId,
            externalBusinessId,
            externalLocationId,
          });
          scopedLocationId = scope?.locationId ?? null;
          scopeResolution = scope?.resolution ?? 'unresolved';
        } catch (e) {
          logger.warn?.(`[LB Orch] busy: scope resolver threw user=${userId}: ${e.message}`);
          scopeResolution = 'resolver_error';
        }
        if (!scopedLocationId) {
          // Fail-closed: caller asked for a specific business, we can't
          // resolve it → return empty rather than leak sibling busy.
          const payload = {
            tenant_id: userId,
            range: { from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString() },
            busy_windows: [],
            scope: { resolution: scopeResolution, location_id: null },
          };
          await recordAttempt(supabase, {
            userId, endpoint: 'busy', request_payload: req.query,
            response_status: 200,
            response_payload: { busy_count: 0, scope_resolution: scopeResolution },
            result: 'scope_unresolved', logger,
          });
          return res.json(payload);
        }
      }
    }
    try {
      let query = supabase
        .from('jobs')
        .select('id, scheduled_date, duration, team_member_id, job_team_assignments(team_member_id)')
        .eq('user_id', userId)
        .gte('scheduled_date', new Date(fromMs - 4 * 60 * 60 * 1000).toISOString())
        .lte('scheduled_date', new Date(toMs).toISOString())
        .neq('status', 'cancelled');
      if (scopedLocationId) query = query.eq('territory_id', scopedLocationId);
      const { data, error } = await query;
      if (error) throw new Error(error.message);
      let busy_windows;
      if (mode === 'capacity') {
        // Enumerate cleaners assigned to this territory. team_members.territories
        // is a jsonb array of SF territory IDs — we filter in JS because Supabase's
        // client doesn't have a clean JSON-array-contains for integer values.
        // Tenant scoped by user_id; territory required (fail-closed above
        // ensures scopedLocationId is set for LB calls).
        let cleaners = [];
        if (scopedLocationId) {
          const { data: teamRows, error: teamErr } = await supabase
            .from('team_members')
            .select('id, territories, availability, status, role')
            .eq('user_id', userId);
          if (teamErr) throw new Error(teamErr.message);
          const PROTECTED_ROLES = new Set(['account owner', 'owner', 'admin']);
          cleaners = (teamRows || []).filter(t => {
            if (String(t.status || '').toLowerCase() === 'inactive') return false;
            if (PROTECTED_ROLES.has(String(t.role || '').toLowerCase())) return false;
            let tArr = t.territories;
            if (typeof tArr === 'string') { try { tArr = JSON.parse(tArr); } catch { tArr = []; } }
            if (!Array.isArray(tArr)) return false;
            return tArr.map(Number).filter(Number.isFinite).includes(scopedLocationId);
          });
        }
        // Build the date → cleanerId → intervals map from the jobs pulled above.
        const dates = enumerateDates(fromMs, toMs);
        const jobsByDateByCleaner = new Map();
        for (const j of (data || [])) {
          const scheduled = j.scheduled_date;
          if (!scheduled) continue;
          const dateStr = String(scheduled).slice(0, 10);
          const s = new Date(j.scheduled_date).getTime();
          // NEVER use j.end_time — it stores the actual CLOCK-OUT
          // timestamp (when the cleaner marked the job completed), not
          // the scheduled end. Audit against real Spotless data on
          // 2026-08-20: 22/22 non-cancelled jobs in the week had
          // end_time >1h after scheduled end (avg 7h phantom duration).
          // Using end_time here produced multi-hour "busy" phantoms and
          // caused LB's operator calendar + AI booking path to under-
          // report free capacity by 4–7h/cleaner/week. Scheduled window
          // = scheduled_date + duration, full stop.
          const e = s + ((Number(j.duration) || 180) * 60 * 1000);
          if (!Number.isFinite(s) || !Number.isFinite(e)) continue;
          const interval = jobIntervalOnDate(
            new Date(s).toISOString(), new Date(e).toISOString(), dateStr,
          );
          if (!interval) continue;
          const cleanerIds = new Set();
          if (Array.isArray(j.job_team_assignments)) {
            for (const a of j.job_team_assignments) {
              if (a?.team_member_id != null) cleanerIds.add(Number(a.team_member_id));
            }
          }
          if (j.team_member_id != null) cleanerIds.add(Number(j.team_member_id));
          if (cleanerIds.size === 0) continue;
          if (!jobsByDateByCleaner.has(dateStr)) jobsByDateByCleaner.set(dateStr, new Map());
          const dayMap = jobsByDateByCleaner.get(dateStr);
          for (const cid of cleanerIds) {
            if (!dayMap.has(cid)) dayMap.set(cid, []);
            dayMap.get(cid).push(interval);
          }
        }
        busy_windows = computeCapacityBusyWindows({
          cleaners,
          jobsByDateByCleaner,
          dates,
        });
      } else {
        busy_windows = (data || [])
          .map(j => {
            const s = new Date(j.scheduled_date).getTime();
            // See the capacity-branch comment above — end_time is a
            // completion timestamp, not a scheduled end. Always
            // derive the busy window from scheduled_date + duration.
            const e = s + ((Number(j.duration) || 180) * 60 * 1000);
            if (!Number.isFinite(s) || !Number.isFinite(e)) return null;
            return { start: new Date(s).toISOString(), end: new Date(e).toISOString() };
          })
          .filter(Boolean)
          .filter(w => new Date(w.end).getTime() > fromMs && new Date(w.start).getTime() < toMs);
      }
      const payload = {
        tenant_id: userId,
        range: { from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString() },
        busy_windows,
        scope: { resolution: scopeResolution, location_id: scopedLocationId },
        mode,
      };
      await recordAttempt(supabase, {
        userId, endpoint: 'busy',
        request_payload: req.query,
        response_status: 200,
        response_payload: {
          busy_count: busy_windows.length,
          scope_resolution: scopeResolution,
          scoped_location_id: scopedLocationId,
          mode,
        },
        result: 'success',
        logger,
      });
      return res.json(payload);
    } catch (e) {
      logger.error?.(`[LB Orch] busy failed user=${userId}: ${e.message}`);
      const payload = { error: 'busy_lookup_failed', message: e.message };
      await recordAttempt(supabase, {
        userId, endpoint: 'busy', request_payload: req.query,
        response_status: 500, response_payload: payload, result: 'error', logger,
      });
      return res.status(500).json(payload);
    }
  };
}

// ──────────────────────────────────────────────────────────────────
// GET /orchestration/team-free-windows
// ──────────────────────────────────────────────────────────────────
// Per-cleaner remaining free time for a date range. Feeds LB's booking-
// availability grid so half-day slots are dropped when no cleaner has any
// real free minute (vs. capacity mode which only reports at territory
// AM/PM granularity, and vs. /busy?mode=jobs which is raw jobs without
// per-cleaner shift context).
//
// Scope resolution mirrors /orchestration/busy (explicit sf_location_id →
// external_business_id resolver → tenant-wide). Fail-closed on unresolved
// external scope for the same reason: leaking sibling-location free time
// to the AI is the same class of bug as leaking sibling busy.
//
// SCOPE SEMANTIC (post-2026-08-20):
//   Scope filters WHICH CLEANERS are returned (territory membership) but
//   does NOT filter which jobs subtract from those cleaners' shifts. A
//   cleaner has one physical calendar — a job in territory B at 2 PM
//   makes them unavailable at 2 PM regardless of which territory the
//   caller asked about. The prior semantics (scope filters jobs too)
//   over-reported free time for cross-territory cleaners and let LB's AI
//   double-book them. The Shelby (Spotless Homes JAX, 2026-08-19) Wed-
//   morning offer traced to this: Tatiana Kovtun (assigned to JAX only,
//   so no cross-territory issue for her) was fine, but the class of bug
//   remains for Larisa / Kateryna / Alina / Tetiana / Lesia who all work
//   in ≥2 territories.
//
// Team filtering (applied here — do not push to LB):
//   - user_id = tenant
//   - is_service_provider = true      (managers/owners excluded)
//   - is_active = true, status = 'active'
//   - if scope is resolved: territories jsonb contains scopedLocationId
const {
  computeTeamFreeWindows,
} = require('./lb-orchestration-free-windows');

const PROTECTED_ROLES = new Set(['account owner', 'owner', 'admin', 'manager']);

function makeTeamFreeWindowsHandler({ supabase, logger, resolveLocationForOrchestrationScope }) {
  return async function teamFreeWindowsHandler(req, res) {
    const userId = req.user.userId;
    const fromIso = String(req.query.from || '');
    const toIso   = String(req.query.to   || '');
    const externalBusinessId = req.query.external_business_id
      ? String(req.query.external_business_id) : null;
    const externalLocationId = req.query.external_location_id
      ? String(req.query.external_location_id) : null;
    const explicitLocationId = req.query.sf_location_id
      ? Number(req.query.sf_location_id) : null;

    if (!fromIso || !toIso) {
      const payload = { error: 'from and to are required (ISO timestamps)' };
      await recordAttempt(supabase, {
        userId, endpoint: 'team_free_windows', request_payload: req.query,
        response_status: 400, response_payload: payload, result: 'invalid', logger,
      });
      return res.status(400).json(payload);
    }
    const fromMs = new Date(fromIso).getTime();
    const toMs   = new Date(toIso).getTime();
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) {
      const payload = { error: 'invalid range' };
      await recordAttempt(supabase, {
        userId, endpoint: 'team_free_windows', request_payload: req.query,
        response_status: 400, response_payload: payload, result: 'invalid', logger,
      });
      return res.status(400).json(payload);
    }
    const MAX_RANGE_MS = 60 * 24 * 60 * 60 * 1000;
    if (toMs - fromMs > MAX_RANGE_MS) {
      const payload = { error: 'range too large (max 60 days)' };
      await recordAttempt(supabase, {
        userId, endpoint: 'team_free_windows', request_payload: req.query,
        response_status: 400, response_payload: payload, result: 'invalid', logger,
      });
      return res.status(400).json(payload);
    }

    // Scope resolution — mirror busy handler
    let scopedLocationId = null;
    let scopeResolution = 'not_requested';
    if (Number.isFinite(explicitLocationId) && explicitLocationId > 0) {
      scopedLocationId = explicitLocationId;
      scopeResolution = 'explicit';
    } else if (externalBusinessId) {
      if (typeof resolveLocationForOrchestrationScope !== 'function') {
        logger.warn?.(`[LB Orch] team-free-windows: scope requested but resolver unavailable user=${userId}`);
      } else {
        try {
          const scope = await resolveLocationForOrchestrationScope({
            userId, externalBusinessId, externalLocationId,
          });
          scopedLocationId = scope?.locationId ?? null;
          scopeResolution = scope?.resolution ?? 'unresolved';
        } catch (e) {
          logger.warn?.(`[LB Orch] team-free-windows: scope resolver threw user=${userId}: ${e.message}`);
          scopeResolution = 'resolver_error';
        }
        if (!scopedLocationId) {
          const payload = {
            tenant_id: userId,
            range: { from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString() },
            team: [],
            scope: { resolution: scopeResolution, location_id: null },
          };
          await recordAttempt(supabase, {
            userId, endpoint: 'team_free_windows', request_payload: req.query,
            response_status: 200,
            response_payload: { team_count: 0, scope_resolution: scopeResolution },
            result: 'scope_unresolved', logger,
          });
          return res.json(payload);
        }
      }
    }

    try {
      const { data: teamRows, error: teamErr } = await supabase
        .from('team_members')
        .select('id, first_name, last_name, email, availability, is_active, status, role, is_service_provider, territories')
        .eq('user_id', userId)
        .eq('is_service_provider', true)
        .eq('is_active', true);
      if (teamErr) throw new Error(teamErr.message);

      const cleaners = (teamRows || []).filter(t => {
        if (String(t.status || 'active').toLowerCase() !== 'active') return false;
        if (PROTECTED_ROLES.has(String(t.role || '').toLowerCase())) return false;
        if (!scopedLocationId) return true;
        let tArr = t.territories;
        if (typeof tArr === 'string') { try { tArr = JSON.parse(tArr); } catch { tArr = []; } }
        if (!Array.isArray(tArr)) return false;
        return tArr.map(Number).filter(Number.isFinite).includes(scopedLocationId);
      });

      // Job pull — scheduled_date is a TEXT column that stores either
      // "YYYY-MM-DD" or "YYYY-MM-DD HH:MM:SS" (space, not T). ISO
      // datetimes with a T sort GREATER than the same date with a space
      // (0x54 > 0x20), so passing `.toISOString()` here silently drops
      // every real row. We use date-only lexicographic bounds instead —
      // any "YYYY-MM-DD ..." row lies textually between "YYYY-MM-DD" and
      // "YYYY-MM-(DD+1)" regardless of how the time part is delimited.
      const fromDayIso = new Date(fromMs).toISOString().slice(0, 10);
      const boundDate  = new Date(toMs); boundDate.setUTCHours(0, 0, 0, 0); boundDate.setUTCDate(boundDate.getUTCDate() + 1);
      const boundDayIso = boundDate.toISOString().slice(0, 10);
      // Job pull is INTENTIONALLY unscoped by territory even when
      // scopedLocationId is set. A cleaner has ONE physical calendar;
      // if they're doing a job in territory B at 2 PM, they are not
      // available at 2 PM regardless of which territory the caller is
      // asking about. Filtering jobs by scopedLocationId leaks other
      // territories' bookings as "free" and lets the AI double-book
      // the same cleaner across two territories. The cleaner list is
      // still territory-filtered above (correct scope for who the
      // caller cares about); we just subtract ALL of those cleaners'
      // jobs so the resulting free_windows reflect reality.
      //
      // Downstream (below) already discards any job whose assignee is
      // outside `cleanerIds`, so pulling tenant-wide jobs is safe and
      // adds no noise — it just makes each surviving row's job set
      // complete.
      const { data: jobs, error: jobsErr } = await supabase
        .from('jobs')
        .select('id, scheduled_date, duration, status, team_member_id, job_team_assignments(team_member_id)')
        .eq('user_id', userId)
        .gte('scheduled_date', fromDayIso)
        .lt('scheduled_date', boundDayIso)
        .neq('status', 'cancelled');
      if (jobsErr) throw new Error(jobsErr.message);

      // Build jobsByDateByCleaner. scheduled_date is TEXT — parse either
      // "YYYY-MM-DD" or "YYYY-MM-DD[ T]HH:MM[:SS]". If the time is not
      // embedded in scheduled_date, DO NOT fall back to jobs.scheduled_time
      // — that column carries a default '09:00' that is dead on many rows
      // and would poison the subtraction. Skip rows without a real time.
      const cleanerIds = new Set(cleaners.map(c => Number(c.id)));
      const jobsByDateByCleaner = new Map();
      for (const j of (jobs || [])) {
        const m = String(j.scheduled_date || '').match(/^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}):(\d{2})(?::\d{2})?)?/);
        if (!m || !m[2]) continue;
        const dateStr = m[1];
        const startMin = Number(m[2]) * 60 + Number(m[3]);
        // NEVER use j.end_time — it stores the actual CLOCK-OUT
        // timestamp (when the cleaner marked the job completed), not
        // the scheduled end. Audit against real Spotless data on
        // 2026-08-20: 22/22 non-cancelled jobs in the week had
        // end_time >1h after scheduled end (avg 7h phantom duration).
        // Larisa Wed 8/19 example — job 142544: scheduled 13:00 with
        // duration=90 (planned end 14:30) has end_time=18:47:02, and
        // using end_time produces a phantom 13:00–18:47 block that
        // merges with a sibling 15:00 job into 13:00–22:16. Result: we
        // under-reported Larisa's free time by ~2h that Wednesday and
        // by 7h across the week. Scheduled window = scheduled_date +
        // duration, full stop. Same fix applied to the busy handler
        // above and the availability handler in
        // lib/lb-orchestration-availability.js.
        const endMin = startMin + (Number(j.duration) || 180);
        if (!Number.isFinite(endMin) || endMin <= startMin) continue;

        const assignees = new Set();
        if (Array.isArray(j.job_team_assignments)) {
          for (const a of j.job_team_assignments) {
            if (a?.team_member_id != null) assignees.add(Number(a.team_member_id));
          }
        }
        if (assignees.size === 0 && j.team_member_id != null) assignees.add(Number(j.team_member_id));
        for (const cid of assignees) {
          if (!cleanerIds.has(cid)) continue; // ignore assignees outside our filtered set
          if (!jobsByDateByCleaner.has(dateStr)) jobsByDateByCleaner.set(dateStr, new Map());
          const dayMap = jobsByDateByCleaner.get(dateStr);
          if (!dayMap.has(cid)) dayMap.set(cid, []);
          dayMap.get(cid).push([startMin, endMin]);
        }
      }

      // Enumerate dates via a simple in-scope loop (UTC-safe — the busy
      // handler's enumerateDates uses local time which is fine there
      // because jobs are timestamped in local wall-clock too).
      const dates = [];
      const cur = new Date(fromMs); cur.setHours(0, 0, 0, 0);
      const endDay = new Date(toMs); endDay.setHours(0, 0, 0, 0);
      while (cur.getTime() <= endDay.getTime()) {
        const y = cur.getFullYear();
        const mo = String(cur.getMonth() + 1).padStart(2, '0');
        const d = String(cur.getDate()).padStart(2, '0');
        dates.push(`${y}-${mo}-${d}`);
        cur.setDate(cur.getDate() + 1);
      }

      const team = computeTeamFreeWindows({ cleaners, jobsByDateByCleaner, dates });

      const payload = {
        tenant_id: userId,
        range: { from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString() },
        scope: { resolution: scopeResolution, location_id: scopedLocationId },
        team,
      };
      await recordAttempt(supabase, {
        userId, endpoint: 'team_free_windows', request_payload: req.query,
        response_status: 200,
        response_payload: {
          team_count: team.length,
          days_per_member: dates.length,
          scope_resolution: scopeResolution,
          scoped_location_id: scopedLocationId,
        },
        result: 'success', logger,
      });
      return res.json(payload);
    } catch (e) {
      logger.error?.(`[LB Orch] team-free-windows failed user=${userId}: ${e.message}`);
      const payload = { error: 'team_free_windows_lookup_failed', message: e.message };
      await recordAttempt(supabase, {
        userId, endpoint: 'team_free_windows', request_payload: req.query,
        response_status: 500, response_payload: payload, result: 'error', logger,
      });
      return res.status(500).json(payload);
    }
  };
}

// ──────────────────────────────────────────────────────────────────
// GET /orchestration/team-busy
// ──────────────────────────────────────────────────────────────────
// Per-cleaner busy intervals across ALL locations, for the cleaners
// eligible to serve a given territory.
//
// Sibling of /orchestration/busy — the difference matters:
//
//   /busy?sf_location_id=X returns a flat union of jobs whose
//   territory_id = X. Cross-location jobs of shared cleaners are
//   invisible, so LB's AI can offer St. Pete slots to a customer
//   while the assigned cleaner is booked in Tampa. That is the exact
//   bug pattern this endpoint exists to fix.
//
//   /team-busy?sf_location_id=X returns:
//     - the set of cleaners whose territories JSON contains X
//     - each cleaner's raw job intervals across every territory
//
//   LB then evaluates slot availability PER CLEANER: a slot survives
//   iff at least one eligible cleaner has no overlapping job (with
//   travel buffer). A flat union would create the opposite bug —
//   one cleaner busy in Tampa would block St. Pete even when three
//   others are free.
//
// Cleaner filter (mirrors /team-free-windows):
//   - user_id = tenant
//   - is_service_provider = true          (managers/owners excluded)
//   - is_active = true, status = 'active'
//   - role NOT IN owner/admin/manager
//   - if scope resolved: territories jsonb contains scopedLocationId
//
// Job pull is INTENTIONALLY UNSCOPED by territory — cleaner has one
// physical calendar; filtering by scopedLocationId here would re-
// introduce the very leak the endpoint exists to close.
//
// Response shape:
//   {
//     tenant_id, range: { from, to },
//     team: [
//       {
//         team_member_id, name,
//         busy_windows: [ { start, end, sf_location_id } ]
//       }
//     ],
//     scope: { resolution, location_id }
//   }
//
// Fail-closed on unresolved external_business_id — returning tenant-
// wide team_busy when per-account scoping was requested would leak
// non-eligible cleaners into LB's slot-eligibility set.
function makeTeamBusyHandler({ supabase, logger, resolveLocationForOrchestrationScope }) {
  return async function teamBusyHandler(req, res) {
    const userId = req.user.userId;
    const fromIso = String(req.query.from || '');
    const toIso   = String(req.query.to   || '');
    const externalBusinessId = req.query.external_business_id
      ? String(req.query.external_business_id) : null;
    const externalLocationId = req.query.external_location_id
      ? String(req.query.external_location_id) : null;
    const explicitLocationId = req.query.sf_location_id
      ? Number(req.query.sf_location_id) : null;

    if (!fromIso || !toIso) {
      const payload = { error: 'from and to are required (ISO timestamps)' };
      await recordAttempt(supabase, {
        userId, endpoint: 'team_busy', request_payload: req.query,
        response_status: 400, response_payload: payload, result: 'invalid', logger,
      });
      return res.status(400).json(payload);
    }
    const fromMs = new Date(fromIso).getTime();
    const toMs   = new Date(toIso).getTime();
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) {
      const payload = { error: 'invalid range' };
      await recordAttempt(supabase, {
        userId, endpoint: 'team_busy', request_payload: req.query,
        response_status: 400, response_payload: payload, result: 'invalid', logger,
      });
      return res.status(400).json(payload);
    }
    const MAX_RANGE_MS = 60 * 24 * 60 * 60 * 1000;
    if (toMs - fromMs > MAX_RANGE_MS) {
      const payload = { error: 'range too large (max 60 days)' };
      await recordAttempt(supabase, {
        userId, endpoint: 'team_busy', request_payload: req.query,
        response_status: 400, response_payload: payload, result: 'invalid', logger,
      });
      return res.status(400).json(payload);
    }

    // Scope resolution — mirror busy + team-free-windows
    let scopedLocationId = null;
    let scopeResolution = 'not_requested';
    if (Number.isFinite(explicitLocationId) && explicitLocationId > 0) {
      scopedLocationId = explicitLocationId;
      scopeResolution = 'explicit';
    } else if (externalBusinessId) {
      if (typeof resolveLocationForOrchestrationScope !== 'function') {
        logger.warn?.(`[LB Orch] team-busy: scope requested but resolver unavailable user=${userId}`);
      } else {
        try {
          const scope = await resolveLocationForOrchestrationScope({
            userId, externalBusinessId, externalLocationId,
          });
          scopedLocationId = scope?.locationId ?? null;
          scopeResolution = scope?.resolution ?? 'unresolved';
        } catch (e) {
          logger.warn?.(`[LB Orch] team-busy: scope resolver threw user=${userId}: ${e.message}`);
          scopeResolution = 'resolver_error';
        }
        if (!scopedLocationId) {
          const payload = {
            tenant_id: userId,
            range: { from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString() },
            team: [],
            scope: { resolution: scopeResolution, location_id: null },
          };
          await recordAttempt(supabase, {
            userId, endpoint: 'team_busy', request_payload: req.query,
            response_status: 200,
            response_payload: { team_count: 0, scope_resolution: scopeResolution },
            result: 'scope_unresolved', logger,
          });
          return res.json(payload);
        }
      }
    }

    try {
      // Step 1 — eligible cleaner set for the scoped location.
      const { data: teamRows, error: teamErr } = await supabase
        .from('team_members')
        .select('id, first_name, last_name, status, role, is_service_provider, territories')
        .eq('user_id', userId)
        .eq('is_service_provider', true)
        .eq('is_active', true);
      if (teamErr) throw new Error(teamErr.message);

      const cleaners = (teamRows || []).filter(t => {
        if (String(t.status || 'active').toLowerCase() !== 'active') return false;
        if (PROTECTED_ROLES.has(String(t.role || '').toLowerCase())) return false;
        if (!scopedLocationId) return true;
        let tArr = t.territories;
        if (typeof tArr === 'string') { try { tArr = JSON.parse(tArr); } catch { tArr = []; } }
        if (!Array.isArray(tArr)) return false;
        return tArr.map(Number).filter(Number.isFinite).includes(scopedLocationId);
      });
      const cleanerIds = new Set(cleaners.map(c => Number(c.id)));

      // Step 2 — pull ALL non-cancelled jobs tenant-wide (NO territory
      // filter — see /team-free-windows for the same rationale).
      const { data: jobs, error: jobsErr } = await supabase
        .from('jobs')
        .select('id, scheduled_date, duration, territory_id, team_member_id, job_team_assignments(team_member_id)')
        .eq('user_id', userId)
        .gte('scheduled_date', new Date(fromMs - 4 * 60 * 60 * 1000).toISOString())
        .lte('scheduled_date', new Date(toMs).toISOString())
        .neq('status', 'cancelled');
      if (jobsErr) throw new Error(jobsErr.message);

      const busyByCleaner = new Map();
      for (const c of cleaners) busyByCleaner.set(Number(c.id), []);

      for (const j of (jobs || [])) {
        const s = new Date(j.scheduled_date).getTime();
        // NEVER use j.end_time — clock-out timestamp, not scheduled end.
        // Same fix documented in /busy and /team-free-windows.
        const e = s + ((Number(j.duration) || 180) * 60 * 1000);
        if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) continue;
        if (e <= fromMs || s >= toMs) continue;

        const window = {
          start: new Date(s).toISOString(),
          end:   new Date(e).toISOString(),
          sf_location_id: j.territory_id != null ? Number(j.territory_id) : null,
        };

        const assignees = new Set();
        if (Array.isArray(j.job_team_assignments)) {
          for (const a of j.job_team_assignments) {
            if (a?.team_member_id != null) assignees.add(Number(a.team_member_id));
          }
        }
        // Only fall back to jobs.team_member_id when no assignments row
        // exists — matches team-free-windows semantics so parity holds.
        if (assignees.size === 0 && j.team_member_id != null) {
          assignees.add(Number(j.team_member_id));
        }
        for (const cid of assignees) {
          if (!cleanerIds.has(cid)) continue;
          busyByCleaner.get(cid).push(window);
        }
      }

      // Sort each cleaner's windows by start ascending so LB can
      // consume them without a second sort.
      const team = cleaners.map(c => {
        const windows = (busyByCleaner.get(Number(c.id)) || [])
          .slice()
          .sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());
        return {
          team_member_id: Number(c.id),
          name: [c.first_name, c.last_name].filter(Boolean).join(' ').trim() || null,
          busy_windows: windows,
        };
      });

      const payload = {
        tenant_id: userId,
        range: { from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString() },
        team,
        scope: { resolution: scopeResolution, location_id: scopedLocationId },
      };
      await recordAttempt(supabase, {
        userId, endpoint: 'team_busy', request_payload: req.query,
        response_status: 200,
        response_payload: {
          team_count: team.length,
          total_busy_windows: team.reduce((n, m) => n + m.busy_windows.length, 0),
          scope_resolution: scopeResolution,
          scoped_location_id: scopedLocationId,
        },
        result: 'success', logger,
      });
      return res.json(payload);
    } catch (e) {
      logger.error?.(`[LB Orch] team-busy failed user=${userId}: ${e.message}`);
      const payload = { error: 'team_busy_lookup_failed', message: e.message };
      await recordAttempt(supabase, {
        userId, endpoint: 'team_busy', request_payload: req.query,
        response_status: 500, response_payload: payload, result: 'error', logger,
      });
      return res.status(500).json(payload);
    }
  };
}

// ──────────────────────────────────────────────────────────────────
// POST /orchestration/booking-request
// ──────────────────────────────────────────────────────────────────
function makeBookingRequestHandler({ supabase, logger, setCustomerAcquisitionIfMissing }) {
  return async function bookingRequestHandler(req, res) {
    const userId = req.user.userId;
    const body = req.body || {};
    const idempotency_key = body.idempotency_key ? String(body.idempotency_key).slice(0, 200) : null;
    const orchestration_session_id = body.lb_conversation_id || body.orchestration_session_id || null;

    // 1. Idempotent replay?
    const prior = await findIdempotentReply(supabase, userId, 'booking_request', idempotency_key);
    if (prior) {
      logger.log?.(`[LB Orch] idempotent_replay booking-request user=${userId} key=${idempotency_key}`);
      return res.status(prior.response_status || 200).json({
        ...(prior.response_payload || {}),
        idempotent_replay: true,
      });
    }

    // 2. Validate slot_token
    const slot_token = body.slot_token;
    const ver = verifySlotToken(String(slot_token || ''), {
      expected_tenant_id: userId,
    });
    if (!ver.valid) {
      const payload = { error: 'invalid_slot_token', reason: ver.reason };
      await recordAttempt(supabase, {
        userId, endpoint: 'booking_request', idempotency_key, orchestration_session_id,
        request_payload: redactCustomer(body),
        response_status: ver.reason === 'expired' ? 410 : 400,
        response_payload: payload,
        result: ver.reason === 'expired' ? 'stale_slot' : 'invalid',
        logger,
      });
      return res.status(ver.reason === 'expired' ? 410 : 400).json(payload);
    }
    const slot = ver.payload;

    // 3. Validate customer + attribution payloads
    const customer = body.customer || {};
    const attribution = body.marketplace_attribution || {};
    if (!customer.phone) {
      const payload = { error: 'customer.phone is required' };
      await recordAttempt(supabase, {
        userId, endpoint: 'booking_request', idempotency_key, orchestration_session_id,
        request_payload: redactCustomer(body),
        response_status: 422, response_payload: payload, result: 'invalid', logger,
      });
      return res.status(422).json(payload);
    }
    if (!attribution.lb_external_request_id) {
      const payload = { error: 'marketplace_attribution.lb_external_request_id is required' };
      await recordAttempt(supabase, {
        userId, endpoint: 'booking_request', idempotency_key, orchestration_session_id,
        request_payload: redactCustomer(body),
        response_status: 422, response_payload: payload, result: 'invalid', logger,
      });
      return res.status(422).json(payload);
    }

    // 4. Re-validate slot availability under current state (race protection)
    // We re-fetch overlapping jobs for the proposed slot window and refuse
    // if another booking landed since slot_token issuance.
    const slotStartIso = slot.start_iso;
    const slotEndIso = slot.end_iso;
    // job_status enum check: see lb-orchestration-availability.js for the
    // full enum list. Only 'cancelled' is a real terminal value — variants
    // like 'canceled' / 'archived' / 'no-show' aren't in the enum and will
    // break this query if listed.
    const { data: overlap, error: overlapErr } = await supabase
      .from('jobs')
      .select('id, scheduled_date, duration')
      .eq('user_id', userId)
      .gte('scheduled_date', new Date(new Date(slotStartIso).getTime() - 60 * 60 * 1000).toISOString())
      .lte('scheduled_date', slotEndIso)
      .neq('status', 'cancelled');
    if (overlapErr) {
      logger.warn?.(`[LB Orch] overlap check failed user=${userId}: ${overlapErr.message}`);
    }
    // NEVER use j.end_time — it's a clock-out timestamp, not a scheduled
    // end. Using it here would 409-conflict booking requests against
    // slots that are actually free because the prior job over-ran its
    // scheduled window. Same rationale as the free-windows handler
    // above; every consumer must agree on `scheduled_date + duration`
    // as the authoritative scheduled window.
    const overlapsExisting = (overlap || []).some(j => {
      const jobStart = new Date(j.scheduled_date).getTime();
      const jobEnd = jobStart + ((Number(j.duration) || 180) * 60 * 1000);
      const reqStart = new Date(slotStartIso).getTime();
      const reqEnd = new Date(slotEndIso).getTime();
      return reqStart < jobEnd && jobStart < reqEnd;
    });
    if (overlapsExisting) {
      const payload = { error: 'slot_taken', reason: 'slot_no_longer_available', replacement_suggestions: [] };
      await recordAttempt(supabase, {
        userId, endpoint: 'booking_request', idempotency_key, orchestration_session_id,
        request_payload: redactCustomer(body),
        response_status: 409, response_payload: payload, result: 'conflict', logger,
      });
      return res.status(409).json(payload);
    }

    // 5. Find or create customer (by phone last-10, tenant-scoped)
    const phoneLast10 = String(customer.phone).replace(/[^0-9]/g, '').slice(-10);
    let customerId = null;
    try {
      const { data: existing } = await supabase
        .from('customers').select('id').eq('user_id', userId)
        .ilike('phone', `%${phoneLast10}%`).limit(1).maybeSingle();
      if (existing) customerId = existing.id;
    } catch (_) {}
    if (!customerId) {
      const insertCust = {
        user_id: userId,
        first_name: customer.first_name || null,
        last_name: customer.last_name || null,
        phone: customer.phone,
        email: customer.email || null,
        source: attribution.lb_channel ? `LeadBridge ${attribution.lb_channel}` : 'LeadBridge',
      };
      const { data: created, error: ce } = await supabase
        .from('customers').insert(insertCust).select('id').maybeSingle();
      if (ce || !created) {
        const payload = { error: 'customer_create_failed', message: ce?.message };
        await recordAttempt(supabase, {
          userId, endpoint: 'booking_request', idempotency_key, orchestration_session_id,
          request_payload: redactCustomer(body),
          response_status: 500, response_payload: payload, result: 'error', logger,
        });
        return res.status(500).json(payload);
      }
      customerId = created.id;
    }

    // 6. Stamp acquisition (write-once via existing helper)
    try {
      await setCustomerAcquisitionIfMissing(supabase, userId, customerId, {
        lb_external_request_id: attribution.lb_external_request_id,
        lb_channel: attribution.lb_channel || null,
        lb_business_id: attribution.lb_business_id || null,
        acquired_at: new Date().toISOString(),
      });
    } catch (e) {
      logger.warn?.(`[LB Orch] acquisition stamp failed cust=${customerId}: ${e?.message}`);
    }

    // 7. Create job (status='confirmed', lb_external_request_id stamped)
    // Service address + territory are optional but required for ZB propagation
    // (see step 9). LB may send `body.customer.address` (Phase 2B extension) or
    // `body.service_address`; either populates the job's service_address_*
    // columns. If absent, the row still commits — the ZB producer will emit a
    // `skipped_precondition: missing_service_address` row so operators can see
    // which LB conversations need the address captured upstream.
    const address = body.service_address || body.customer?.address || {};
    const jobInsert = {
      user_id: userId,
      customer_id: customerId,
      service_id: body.service_id || null,
      status: 'confirmed',
      scheduled_date: slot.start_iso,
      end_time: slot.end_iso,
      // territory is a name string on the jobs table (see zb-outbound-producer
      // resolveZbLinkage: SELECT territory by name). LB may send the human-
      // readable name; if not, it stays null and the producer defers.
      territory: body.territory || null,
      service_address_street: address.street || address.line1 || null,
      service_address_city:   address.city   || null,
      service_address_state:  address.state  || null,
      service_address_zip:    address.zip    || address.postal_code || null,
      service_address_country: address.country || null,
      lb_external_request_id: attribution.lb_external_request_id,
      lb_channel: attribution.lb_channel || null,
      lb_business_id: attribution.lb_business_id || null,
      orchestration_session_id,
      last_status_source: 'lb_orchestration',
      last_status_changed_at: new Date().toISOString(),
    };
    // .select() widened to return every field the ZB outbound producer reads
    // in resolveZbLinkage + buildZbBody. If any of these are missing on the
    // row we just inserted, the producer returns skipped_precondition with a
    // clear defer_reason instead of throwing.
    const { data: jobRow, error: jobErr } = await supabase
      .from('jobs').insert(jobInsert).select(`
        id, user_id, status, scheduled_date, end_time,
        customer_id, service_id, territory, team_member_id,
        service_address_street, service_address_city, service_address_state,
        service_address_zip, service_address_country,
        lb_external_request_id, lb_channel, lb_business_id, zenbooker_id
      `).maybeSingle();
    if (jobErr || !jobRow) {
      const payload = { error: 'job_create_failed', message: jobErr?.message };
      await recordAttempt(supabase, {
        userId, endpoint: 'booking_request', idempotency_key, orchestration_session_id,
        request_payload: redactCustomer(body),
        response_status: 500, response_payload: payload, result: 'error', logger,
      });
      return res.status(500).json(payload);
    }

    // 8. Emit service_scheduled — owned by the operational write path.
    // The handler does NOT emit directly; it delegates to the canonical
    // emission helper in job-status-service. The job INSERT above has
    // committed; emission can only fire when canonical state exists.
    // If the helper throws, the booking still stands — the event is
    // replayable via the orchestration_attempts audit row.
    const emit = await getMaybeEmitOrchestrationInsertEvent()(supabase, jobRow,
      { type: 'system', id: 'lb_orchestration', display_name: 'LeadBridge orchestration' },
      {
        orchestrationSessionId: orchestration_session_id,
        extraPayload: { lb_conversation_id: body.lb_conversation_id || null },
      });

    // 9. ZB outbound producer hook — fire-and-forget mirror of the main
    // /api/jobs create route (see server.js maybeEmitJobCreateCommand
    // invocation). Multi-layered gates inside the producer:
    //   1. ZB_OUTBOUND_ENABLED env flag
    //   2. per-tenant opt-in via platform_settings.zb_outbound_job_create_enabled
    //   3. ZB linkage on customer/service/territory/team_members
    //   4. missing scheduled_date / customer / service / territory / address
    //   5. ledger drift or zb_sync_dirty flags
    // The producer NEVER throws; a failure or skip does not block the LB
    // response. Skipped rows record a defer_reason in zb_outbound_commands
    // so an operator can see "would have propagated but couldn't" — the
    // most likely defer_reason in Phase 2C soak is `missing_territory` or
    // `missing_service_address`, both driven by whether LB populates
    // body.territory + body.customer.address (see Phase 2C task spec).
    try {
      const { maybeEmitJobCreateCommand } = require('./zb-outbound-producer');
      maybeEmitJobCreateCommand(
        supabase,
        jobRow,
        { type: 'system', id: 'lb_orchestration', display_name: 'LeadBridge orchestration' },
        { logger },
      ).then((r) => {
        if (r && r.action && r.action !== 'disabled' && r.action !== 'skipped_not_opted_in') {
          logger.log?.(
            `[LB Orch] zb_outbound producer for sf_job=${jobRow.id} → action=${r.action}` +
              (r.defer_reason ? ` defer=${r.defer_reason}` : '')
          );
        }
      }).catch((zbErr) => {
        logger.warn?.(`[LB Orch] zb_outbound producer hook failed: ${zbErr?.message || zbErr}`);
      });
    } catch (zbErr) {
      logger.warn?.(`[LB Orch] zb_outbound producer require failed: ${zbErr?.message || zbErr}`);
    }

    const response = {
      job_id: jobRow.id,
      status: jobRow.status,
      customer_id: customerId,
      scheduled_date: jobRow.scheduled_date,
      orchestration_session_id,
      confirmation: { event_id: emit.event_id || null, action: emit.action },
    };

    await recordAttempt(supabase, {
      userId, endpoint: 'booking_request', idempotency_key, orchestration_session_id,
      request_payload: redactCustomer(body),
      response_status: 201, response_payload: response,
      sf_job_id: jobRow.id, result: 'success', logger,
    });
    return res.status(201).json(response);
  };
}

// ──────────────────────────────────────────────────────────────────
// POST /orchestration/booking-cancel
// ──────────────────────────────────────────────────────────────────
function makeBookingCancelHandler({ supabase, logger, updateJobStatus }) {
  return async function bookingCancelHandler(req, res) {
    const userId = req.user.userId;
    const body = req.body || {};
    const idempotency_key = body.idempotency_key ? String(body.idempotency_key).slice(0, 200) : null;
    const orchestration_session_id = body.lb_conversation_id || body.orchestration_session_id || null;
    const jobId = body.job_id ? Number(body.job_id) : null;

    if (!jobId) {
      const payload = { error: 'job_id is required' };
      await recordAttempt(supabase, {
        userId, endpoint: 'booking_cancel', idempotency_key, orchestration_session_id,
        request_payload: body, response_status: 400, response_payload: payload, result: 'invalid', logger,
      });
      return res.status(400).json(payload);
    }

    const prior = await findIdempotentReply(supabase, userId, 'booking_cancel', idempotency_key);
    if (prior) {
      return res.status(prior.response_status || 200).json({
        ...(prior.response_payload || {}),
        idempotent_replay: true,
      });
    }

    // Load job, validate it exists and is cancellable.
    const { data: job, error: jerr } = await supabase
      .from('jobs')
      .select('id, user_id, status, scheduled_date, lb_external_request_id, lb_channel, lb_business_id')
      .eq('id', jobId).eq('user_id', userId).maybeSingle();
    if (jerr || !job) {
      const payload = { error: 'job_not_found' };
      await recordAttempt(supabase, {
        userId, endpoint: 'booking_cancel', idempotency_key, orchestration_session_id,
        request_payload: body, response_status: 404, response_payload: payload, result: 'invalid', logger,
      });
      return res.status(404).json(payload);
    }
    const CANCELLABLE = new Set(['pending', 'confirmed', 'scheduled', 'rescheduled']);
    if (!CANCELLABLE.has(String(job.status || '').toLowerCase())) {
      const payload = { error: 'job_not_cancellable', current_status: job.status };
      await recordAttempt(supabase, {
        userId, endpoint: 'booking_cancel', idempotency_key, orchestration_session_id,
        request_payload: body, response_status: 409, response_payload: payload,
        sf_job_id: jobId, result: 'conflict', logger,
      });
      return res.status(409).json(payload);
    }

    // Update status via the centralized job-status-service. This handles
    // the loop guard + history row insert + the LEGACY outbound emission.
    // The orchestration emitter below is the NEW path — both fire during
    // Phase 2C canary; UNIQUE absorbs duplicate event_ids.
    try {
      await updateJobStatus({
        jobId,
        userId,
        newStatus: 'cancelled',
        source: 'lb_orchestration',
        actor: {
          type: 'system',
          id: 'lb_orchestration',
          display_name: body.actor_display_name || 'LeadBridge orchestration',
        },
        reason: body.reason || 'customer_requested',
      });
    } catch (e) {
      const payload = { error: 'cancel_failed', message: e.message };
      await recordAttempt(supabase, {
        userId, endpoint: 'booking_cancel', idempotency_key, orchestration_session_id,
        request_payload: body, response_status: 500, response_payload: payload,
        sf_job_id: jobId, result: 'error', logger,
      });
      return res.status(500).json(payload);
    }

    // Explicit orchestration event emission. (Status-change hook also
    // tries to emit; UNIQUE constraint absorbs the duplicate.)
    const emit = await recordOrchestrationOutbound(supabase, {
      eventType: 'service_cancelled',
      job: { ...job, status: 'cancelled' },
      actor: { type: 'system', id: 'lb_orchestration', display_name: 'LeadBridge orchestration' },
      source: 'lb_orchestration',
      orchestrationSessionId: orchestration_session_id,
      extraPayload: { reason: body.reason || 'customer_requested' },
      logger,
    });

    const response = {
      job_id: jobId,
      status: 'cancelled',
      orchestration_session_id,
      confirmation: { event_id: emit.event_id || null, action: emit.action },
    };
    await recordAttempt(supabase, {
      userId, endpoint: 'booking_cancel', idempotency_key, orchestration_session_id,
      request_payload: body, response_status: 200, response_payload: response,
      sf_job_id: jobId, result: 'success', logger,
    });
    return res.status(200).json(response);
  };
}

// ──────────────────────────────────────────────────────────────────
// POST /orchestration/handoff
// ──────────────────────────────────────────────────────────────────
// Minimal Phase 2B implementation: records the handoff request as an
// audit entry. Future: integrate with the task / notification system.
function makeHandoffHandler({ supabase, logger }) {
  return async function handoffHandler(req, res) {
    const userId = req.user.userId;
    const body = req.body || {};
    const idempotency_key = body.idempotency_key ? String(body.idempotency_key).slice(0, 200) : null;
    const orchestration_session_id = body.lb_conversation_id || body.orchestration_session_id || null;
    if (!body.reason) {
      const payload = { error: 'reason is required' };
      await recordAttempt(supabase, {
        userId, endpoint: 'handoff', idempotency_key, orchestration_session_id,
        request_payload: redactCustomer(body), response_status: 400,
        response_payload: payload, result: 'invalid', logger,
      });
      return res.status(400).json(payload);
    }
    const prior = await findIdempotentReply(supabase, userId, 'handoff', idempotency_key);
    if (prior) {
      return res.status(prior.response_status || 200).json({
        ...(prior.response_payload || {}),
        idempotent_replay: true,
      });
    }
    const response = {
      accepted: true,
      orchestration_session_id,
      message: 'Handoff request recorded. Operator will follow up.',
    };
    await recordAttempt(supabase, {
      userId, endpoint: 'handoff', idempotency_key, orchestration_session_id,
      request_payload: redactCustomer(body), response_status: 202,
      response_payload: response, result: 'success', logger,
    });
    return res.status(202).json(response);
  };
}

// Redact PII before audit-logging — we keep enough for debugging but
// strip identifiers operators don't need.
function redactCustomer(body) {
  if (!body || typeof body !== 'object') return body;
  const out = { ...body };
  if (out.customer) {
    out.customer = {
      ...out.customer,
      phone: out.customer.phone ? '***' + String(out.customer.phone).slice(-4) : null,
      email: out.customer.email ? out.customer.email.replace(/(.{2}).*(@.*)/, '$1***$2') : null,
    };
  }
  return out;
}

module.exports = {
  makeAvailabilityHandler,
  makeBusyHandler,
  makeLocationsHandler,
  makeTeamFreeWindowsHandler,
  makeTeamBusyHandler,
  makeBookingRequestHandler,
  makeBookingCancelHandler,
  makeHandoffHandler,
  // exported for tests
  _findIdempotentReply: findIdempotentReply,
  _recordAttempt: recordAttempt,
};
