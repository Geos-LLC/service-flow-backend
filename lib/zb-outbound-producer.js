'use strict';

/**
 * ZB Outbound — Phase B producer for `job.create` only.
 *
 * Hooks into the SF "create job" endpoint AFTER the SF jobs row is
 * persisted. Pre-flight checks the pilot tenant opt-in + ZB linkage
 * for customer/service/territory/team-member, then INSERTs a row
 * into zb_outbound_commands.
 *
 * Gating order (cheapest first):
 *   1. ZB_OUTBOUND_ENABLED env flag (no-op if false)
 *   2. platform_settings.zb_outbound_job_create_enabled (no-op if
 *      tenant not opted-in — silent skip, no DB row)
 *   3. SF job state (scheduled_date, customer_id, service_id, etc.)
 *   4. ZB linkage (customers.zenbooker_id, services.zenbooker_id, etc.)
 *
 * If gates 1-2 fail: silent no-op.
 * If gates 3-4 fail: INSERT a skipped_precondition row with a clear
 * defer_reason so the operator can see the producer "would have
 * queued but couldn't" — this is informative for week-1 soak.
 *
 * NEVER throws. Failure to enqueue MUST NOT break job creation.
 *
 * Design refs:
 *   - zb-outbound-command-confirmation.md §4.1 (job.create row)
 *   - §4.3 (pre-flight checks)
 *   - phase-b-pilot-tenant.md (gating + quota posture)
 */

const { buildCommandRow, ENABLED } = require('./zb-outbound-delivery');
const { emitQueued, emitSkippedPrecondition } = require('./zb-outbound-metrics');

const SETTING_KEY = 'zb_outbound_job_create_enabled';
const SETTING_CACHE_TTL_MS = 60 * 1000;
let cached = { fetchedAt: 0, value: null };

function clearCache() { cached = { fetchedAt: 0, value: null }; }

function parseSettingValue(raw) {
  if (raw == null) return null;
  if (typeof raw === 'object') return raw;
  if (typeof raw !== 'string') return null;
  try { return JSON.parse(raw); } catch { return null; }
}

/**
 * Read the per-tenant opt-in list. Cached 60s.
 * Returns { user_ids: [int, ...] } or null if not configured.
 */
async function readOptInList(supabase, logger) {
  const now = Date.now();
  if (cached.value !== undefined && now - cached.fetchedAt < SETTING_CACHE_TTL_MS) {
    return cached.value;
  }
  try {
    const { data, error } = await supabase
      .from('platform_settings')
      .select('value')
      .eq('key', SETTING_KEY)
      .maybeSingle();
    if (error) {
      cached = { fetchedAt: now, value: null };
      return null;
    }
    const parsed = data && data.value != null ? parseSettingValue(data.value) : null;
    cached = { fetchedAt: now, value: parsed };
    return parsed;
  } catch (err) {
    cached = { fetchedAt: now, value: null };
    if (logger && logger.warn) logger.warn(`[ZB Outbound producer] readOptInList failed: ${err && err.message}`);
    return null;
  }
}

function isTenantOptedIn(setting, userId) {
  if (!setting || !Array.isArray(setting.user_ids)) return false;
  return setting.user_ids.includes(userId) || setting.user_ids.includes(String(userId));
}

/**
 * Look up ZB linkage IDs for a freshly-created SF job.
 * Returns {
 *   ok: true,
 *   customer_zb_id, service_zb_id, territory_zb_id, team_member_zb_ids[],
 *   sf_address: {...}
 * } OR
 *   { ok: false, defer_reason: '<reason>', detail: '<text>' }
 */
async function resolveZbLinkage(supabase, sfJob) {
  try {
    if (!sfJob.scheduled_date) {
      return { ok: false, defer_reason: 'missing_scheduled_date', detail: 'sf job has no scheduled_date' };
    }
    if (!sfJob.customer_id) {
      return { ok: false, defer_reason: 'missing_customer', detail: 'sf job has no customer_id' };
    }

    // 1. Customer must have zenbooker_id
    const { data: customer } = await supabase
      .from('customers')
      .select('id, zenbooker_id, first_name, last_name')
      .eq('id', sfJob.customer_id)
      .eq('user_id', sfJob.user_id)
      .maybeSingle();
    if (!customer) {
      return { ok: false, defer_reason: 'customer_not_found', detail: `sf customer ${sfJob.customer_id} not found for user ${sfJob.user_id}` };
    }
    if (!customer.zenbooker_id) {
      return { ok: false, defer_reason: 'customer_not_in_zb', detail: `customer ${sfJob.customer_id} has no zenbooker_id — Phase B requires existing ZB customer linkage` };
    }

    // 2. Service must have zenbooker_id
    if (!sfJob.service_id) {
      return { ok: false, defer_reason: 'missing_service', detail: 'sf job has no service_id' };
    }
    const { data: service } = await supabase
      .from('services')
      .select('id, zenbooker_id, name')
      .eq('id', sfJob.service_id)
      .eq('user_id', sfJob.user_id)
      .maybeSingle();
    if (!service) {
      return { ok: false, defer_reason: 'service_not_found', detail: `sf service ${sfJob.service_id} not found for user ${sfJob.user_id}` };
    }
    if (!service.zenbooker_id) {
      return { ok: false, defer_reason: 'service_not_in_zb', detail: `service ${sfJob.service_id} has no zenbooker_id` };
    }

    // 3. Territory must map (jobs.territory is a name; territories.zenbooker_id is the ZB id)
    if (!sfJob.territory) {
      return { ok: false, defer_reason: 'missing_territory', detail: 'sf job has no territory' };
    }
    const { data: territory } = await supabase
      .from('territories')
      .select('id, zenbooker_id, name')
      .eq('user_id', sfJob.user_id)
      .eq('name', sfJob.territory)
      .maybeSingle();
    if (!territory || !territory.zenbooker_id) {
      return { ok: false, defer_reason: 'territory_not_in_zb', detail: `territory "${sfJob.territory}" has no zenbooker_id mapping` };
    }

    // 4. Team member assignment (optional — ZB supports auto-assignment)
    let team_member_zb_ids = [];
    const sfTeamIds = [];
    if (sfJob.team_member_id) sfTeamIds.push(sfJob.team_member_id);
    if (Array.isArray(sfJob.team_member_ids)) {
      for (const id of sfJob.team_member_ids) if (id && !sfTeamIds.includes(id)) sfTeamIds.push(id);
    }
    if (sfTeamIds.length > 0) {
      const { data: members } = await supabase
        .from('team_members')
        .select('id, zenbooker_id, first_name, last_name')
        .eq('user_id', sfJob.user_id)
        .in('id', sfTeamIds);
      const unmapped = (members || []).filter((m) => !m.zenbooker_id);
      if (unmapped.length > 0) {
        return {
          ok: false,
          defer_reason: 'unmapped_team_members',
          detail: `team members without zenbooker_id: ${unmapped.map((m) => m.id).join(',')}`,
        };
      }
      team_member_zb_ids = (members || []).map((m) => m.zenbooker_id);
    }

    return {
      ok: true,
      customer_zb_id: customer.zenbooker_id,
      service_zb_id: service.zenbooker_id,
      territory_zb_id: territory.zenbooker_id,
      team_member_zb_ids,
      sf_address: {
        line1: sfJob.service_address_street || null,
        city: sfJob.service_address_city || null,
        state: sfJob.service_address_state || null,
        postal_code: sfJob.service_address_zip || null,
        // Required by ZB POST /v1/jobs per 2026-05-19 discovery — both "US"
        // and "USA" accepted; SF stores "USA". Default keeps the field
        // present for legacy rows without service_address_country.
        // See docs/architecture/job-create-contract-discovery.md §5.1.
        country: sfJob.service_address_country || 'USA',
      },
    };
  } catch (err) {
    return { ok: false, defer_reason: 'resolution_error', detail: err && err.message };
  }
}

/**
 * Build the ZB POST /v1/jobs body from SF job + resolved linkage.
 * Per the controlled discovery (2026-05-16), the required body shape is:
 *   {
 *     territory_id, timeslot OR timeslot_id, customer OR customer_id,
 *     address OR address_id, services (array)
 *   }
 *
 * For Phase B `job.create` we use the *_id variants (customer_id +
 * territory_id) since the linkage exists, and embed `timeslot` and
 * `address` objects rather than ids.
 */
function buildZbBody(sfJob, linkage) {
  // SF scheduled_date is "YYYY-MM-DD HH:MM:SS" local time. ZB expects ISO 8601.
  // We pass through as-is and append 'Z' if no timezone marker is present —
  // operator-of-record should verify the timezone matches ZB tenant's tz
  // during dry-run review (days 1-3).
  const sd = String(sfJob.scheduled_date || '');
  const isoStartDate = /Z|[+-]\d{2}:\d{2}$/.test(sd) ? sd : sd.replace(' ', 'T') + 'Z';

  const body = {
    territory_id: linkage.territory_zb_id,
    customer_id: linkage.customer_zb_id,
    services: [{ service_id: linkage.service_zb_id }],
    // ZB requires `start` (NOT `start_time`) — verified by 400 on 2026-05-19.
    // See docs/architecture/producer-field-contract-audit.md §3.
    timeslot: { type: 'specific_time', start: isoStartDate },
  };

  if (linkage.sf_address && (linkage.sf_address.line1 || linkage.sf_address.city)) {
    body.address = linkage.sf_address;
  }

  if (linkage.team_member_zb_ids && linkage.team_member_zb_ids.length > 0) {
    body.assigned_providers = linkage.team_member_zb_ids;
    body.assignment_method = 'auto';
  }

  if (sfJob.duration) body.duration = Number(sfJob.duration);

  // `notes` intentionally omitted — not in ZB docs §3.1 optional-field list.
  // Pending ZB acceptance verification (audit R3); SF retains notes locally.

  // Suppress ZB's native notification system for SF-originated jobs.
  // SF owns notification behavior for jobs it creates; ZB owns notifications
  // only for jobs originated in ZB. Discovered 2026-05-20 — ZB was sending
  // its own confirmation SMS to the assigned provider's phone (with a
  // customer-greeting template), leaking notifications and conflicting with
  // SF's intended single-owner model. See zb-outbound-command-confirmation.md
  // §1.F and the incident note in zb-outbound-runbook.md §3.2.2.
  body.sms_notifications = false;
  body.email_notifications = false;

  return body;
}

/**
 * Insert a skipped_precondition row for visibility.
 * Used when the producer wanted to enqueue but pre-flight failed.
 */
async function insertSkippedRow(supabase, sfJob, linkage_result, actor, logger) {
  try {
    const event_id = `zboe_skipped_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const row = {
      event_id,
      user_id: sfJob.user_id,
      command_type: 'job.create',
      sf_job_id: String(sfJob.id),
      payload_json: { _skipped: true, sf_job_id: sfJob.id },
      source_revision: {},
      intent_hash: 'skipped',
      state: 'skipped_precondition',
      attempts: 0,
      next_attempt_at: null,
      requested_at: new Date().toISOString(),
      requested_by_user_id: actor && actor.id != null ? actor.id : null,
      requested_by_actor: actor || { type: 'system' },
      field_group: 'create',
      origin: 'user',
      defer_reason: linkage_result.defer_reason,
      last_error: linkage_result.detail ? String(linkage_result.detail).slice(0, 500) : null,
      terminal_at: new Date().toISOString(),
    };
    const { error } = await supabase.from('zb_outbound_commands').insert(row);
    if (error) {
      if (logger && logger.warn) {
        logger.warn(`[ZB Outbound producer] skipped_precondition insert failed: ${error.message}`);
      }
      return null;
    }
    emitSkippedPrecondition({
      userId: sfJob.user_id, commandType: 'job.create', fieldGroup: 'create',
      eventId: event_id, note: linkage_result.defer_reason, logger,
    });
    return event_id;
  } catch (err) {
    if (logger && logger.warn) logger.warn(`[ZB Outbound producer] skipped insert threw: ${err.message}`);
    return null;
  }
}

/**
 * P0/P1 hard gate — refuse enqueue when unresolved ledger drift exists.
 *
 * Per phase-b-readiness-v3 PC16 / Amendment A, the producer MUST NOT
 * queue an outbound command for a job that has an outstanding
 * ledger_drift_detected row. Constitution §P0 (ledger immutability)
 * boundary cannot be bypassed.
 *
 * Fail-open semantics: if the check itself errors (DB hiccup, table
 * absent in unexpected env), we LOG LOUD and return found=false rather
 * than blocking all enqueues on a transient query failure. The gate
 * exists for KNOWN drift, not for unknown DB errors.
 */
async function checkLedgerDrift(supabase, user_id, sf_job_id, logger) {
  try {
    const { data, error } = await supabase
      .from('ledger_drift_detected')
      .select('id')
      .eq('user_id', user_id)
      .eq('job_id', sf_job_id)
      .is('resolved_at', null)
      .limit(1);
    if (error) {
      if (logger && logger.error) {
        logger.error(`[ZB Outbound producer] ledger_drift_detected check error: ${error.message}`);
      }
      return { found: false, row_id: null };
    }
    if (Array.isArray(data) && data.length > 0) {
      return { found: true, row_id: data[0].id };
    }
    return { found: false, row_id: null };
  } catch (err) {
    if (logger && logger.error) {
      logger.error(`[ZB Outbound producer] ledger_drift_detected check threw: ${err && err.message}`);
    }
    return { found: false, row_id: null };
  }
}

/**
 * P0/P1 hard gate — refuse enqueue when unresolved zb_sync_dirty exists.
 *
 * Same rationale as checkLedgerDrift. Constitution §P1 (loud-failure)
 * requires outbound writes to halt while sync-dirty flags are outstanding.
 *
 * Fail-open on internal errors; gate is for KNOWN dirty, not for DB errors.
 */
async function checkZbSyncDirty(supabase, user_id, sf_job_id, logger) {
  try {
    const { data, error } = await supabase
      .from('zb_sync_dirty')
      .select('id')
      .eq('user_id', user_id)
      .eq('sf_job_id', sf_job_id)
      .is('resolved_at', null)
      .limit(1);
    if (error) {
      if (logger && logger.error) {
        logger.error(`[ZB Outbound producer] zb_sync_dirty check error: ${error.message}`);
      }
      return { found: false, row_id: null };
    }
    if (Array.isArray(data) && data.length > 0) {
      return { found: true, row_id: data[0].id };
    }
    return { found: false, row_id: null };
  } catch (err) {
    if (logger && logger.error) {
      logger.error(`[ZB Outbound producer] zb_sync_dirty check threw: ${err && err.message}`);
    }
    return { found: false, row_id: null };
  }
}

/**
 * Top-level producer hook. Called from server.js after a successful
 * INSERT into the jobs table.
 *
 * NEVER throws. Returns a small status object for logging only.
 */
async function maybeEmitJobCreateCommand(supabase, sfJob, actor, options = {}) {
  const logger = options.logger || console;

  // Gate 1: kill switch
  if (!ENABLED()) return { action: 'disabled' };

  // Gate 2: tenant opt-in
  const setting = await readOptInList(supabase, logger);
  if (!isTenantOptedIn(setting, sfJob.user_id)) {
    return { action: 'skipped_not_opted_in' };
  }

  if (!sfJob || !sfJob.id || !sfJob.user_id) {
    return { action: 'skipped_invalid_job' };
  }

  // Gate 3: don't emit for jobs that originated from ZB (loop prevention)
  if (sfJob.zenbooker_id) {
    return { action: 'skipped_zb_originated' };
  }

  // Gate 4: ZB linkage resolution
  const linkage = await resolveZbLinkage(supabase, sfJob);
  if (!linkage.ok) {
    const event_id = await insertSkippedRow(supabase, sfJob, linkage, actor, logger);
    return { action: 'skipped_precondition', defer_reason: linkage.defer_reason, event_id };
  }

  // Gate 5: P0/P1 hard gate (PC16 / Amendment A).
  // Refuse enqueue when unresolved drift or dirty exists for this job.
  // Constitution §P0 + §P1 require outbound writes to halt while these
  // flags are outstanding.
  const drift = await checkLedgerDrift(supabase, sfJob.user_id, sfJob.id, logger);
  if (drift.found) {
    const event_id = await insertSkippedRow(supabase, sfJob, {
      defer_reason: 'ledger_drift',
      detail: `unresolved ledger_drift_detected row #${drift.row_id} for sf_job ${sfJob.id} — resolve before outbound`,
    }, actor, logger);
    return { action: 'skipped_precondition', defer_reason: 'ledger_drift', event_id };
  }

  const dirty = await checkZbSyncDirty(supabase, sfJob.user_id, sfJob.id, logger);
  if (dirty.found) {
    const event_id = await insertSkippedRow(supabase, sfJob, {
      defer_reason: 'zb_sync_dirty',
      detail: `unresolved zb_sync_dirty row #${dirty.row_id} for sf_job ${sfJob.id} — resolve before outbound`,
    }, actor, logger);
    return { action: 'skipped_precondition', defer_reason: 'zb_sync_dirty', event_id };
  }

  // Gate 6: build + validate payload, then insert
  try {
    const payload = buildZbBody(sfJob, linkage);
    const built = buildCommandRow({
      user_id: sfJob.user_id,
      command_type: 'job.create',
      sf_job_id: sfJob.id,
      sf_customer_id: sfJob.customer_id,
      zenbooker_id: null, // ZB assigns on POST response; set by drainer
      payload,
      source_revision: {},
      requested_by_user_id: actor && actor.id != null ? actor.id : null,
      requested_by_actor: actor || { type: 'system' },
      origin: 'user',
    });
    const { data: inserted, error } = await supabase
      .from('zb_outbound_commands')
      .insert(built.row)
      .select('id, event_id, state')
      .single();
    if (error) {
      // UNIQUE violation on event_id is impossible (uuidv7 collision <1 in 2^60).
      // Any other error is a producer-side failure — log loud, don't crash.
      if (error.code === '23505') {
        if (logger.warn) logger.warn(`[ZB Outbound producer] duplicate event_id (rare); sf_job=${sfJob.id}`);
        return { action: 'duplicate' };
      }
      if (logger.error) logger.error(`[ZB Outbound producer] insert failed for sf_job=${sfJob.id}: ${error.message}`);
      return { action: 'error', detail: error.message };
    }
    emitQueued({
      userId: sfJob.user_id, commandType: 'job.create', fieldGroup: 'create',
      eventId: inserted.event_id, logger,
    });
    if (logger.log) {
      logger.log(`[ZB Outbound producer] queued job.create sf_job=${sfJob.id} event=${inserted.event_id}`);
    }
    return { action: 'queued', event_id: inserted.event_id, row_id: inserted.id };
  } catch (err) {
    if (logger.error) logger.error(`[ZB Outbound producer] build/insert threw: ${err && err.message}`);
    return { action: 'error', detail: err && err.message };
  }
}

module.exports = {
  maybeEmitJobCreateCommand,
  // exported for tests
  resolveZbLinkage,
  buildZbBody,
  isTenantOptedIn,
  readOptInList,
  parseSettingValue,
  checkLedgerDrift,
  checkZbSyncDirty,
  clearCache,
  SETTING_KEY,
};
