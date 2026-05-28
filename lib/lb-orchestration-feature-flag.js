'use strict';

// LB orchestration feature flag.
//
// Three enablement layers, evaluated in order:
//
//   1. Env negative override (`-N` in LB_ORCHESTRATION_ENABLED_TENANTS)
//      Operator break-glass. If tenant N is in the env list with a
//      leading `-`, orchestration is DISABLED for that tenant even if
//      they have a live credential. Used for incident kill-switch.
//
//   2. Env positive override (`N` or `+N`, or `*`)
//      Operator override. Enables a tenant without DB state. Used for
//      dark-launch testing and pre-handshake validation.
//
//   3. Connection-state enablement (DB-driven)
//      Normal path. Enabled iff:
//        communication_settings.leadbridge_connected = true
//        AND communication_settings.lb_orchestration_enabled_at IS NOT NULL
//        AND EXISTS an active OR (rotating + within grace) credential.
//
// Backward compat:
//   - The synchronous, env-only `isOrchestrationEnabledForTenant(userId)`
//     and the synchronous `requireOrchestrationEnabled(req, res, next)`
//     middleware are KEPT and behave EXACTLY as before. They are still
//     used by:
//       lib/lb-orchestration-events.js  (sync gate on outbound emission)
//   - The new layered async path is opt-in via `makeRequireOrchestrationEnabled
//     ({ supabase })`. The 4 orchestration HTTP handlers move to this in
//     S2. The sync path stays the gate for outbound events until S4 (when
//     the outbox emitter switches to the layered check too).
//
// Empty env + zero credentials = no tenant enabled. Same as today.

const TABLE = 'lb_orchestration_credentials';

// ─────────────────────────────────────────────────────────────────
// Env parsing
// ─────────────────────────────────────────────────────────────────

/**
 * Parse the LB_ORCHESTRATION_ENABLED_TENANTS env var into positive
 * and negative sets.
 *
 *   ''           → { all: false, positives: ∅,    negatives: ∅ }
 *   '*'          → { all: true,  positives: ∅,    negatives: ∅ }
 *   '2,17'       → { all: false, positives: {2,17}, negatives: ∅ }
 *   '+2, -7'     → { all: false, positives: {2},  negatives: {7} }
 *   '-2'         → { all: false, positives: ∅,    negatives: {2} }
 */
function parseEnabledTenants() {
  const raw = (process.env.LB_ORCHESTRATION_ENABLED_TENANTS || '').trim();
  if (!raw) return { all: false, positives: new Set(), negatives: new Set() };
  if (raw === '*') return { all: true, positives: new Set(), negatives: new Set() };

  const positives = new Set();
  const negatives = new Set();
  for (const piece of raw.split(',')) {
    const trimmed = piece.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('-')) {
      const v = trimmed.slice(1).trim();
      if (v) negatives.add(String(v));
    } else if (trimmed.startsWith('+')) {
      const v = trimmed.slice(1).trim();
      if (v) positives.add(String(v));
    } else {
      positives.add(String(trimmed));
    }
  }
  return { all: false, positives, negatives };
}

/**
 * Env-only synchronous check. Negative override wins over positive
 * override and over `*`. Used by:
 *   - the legacy env-only middleware below (kept for backward compat)
 *   - lib/lb-orchestration-events.js outbound emitter (sync hot path)
 */
function isOrchestrationEnabledForTenant(userId) {
  if (userId == null) return false;
  const { all, positives, negatives } = parseEnabledTenants();
  const key = String(userId);
  if (negatives.has(key)) return false;
  if (all) return true;
  return positives.has(key);
}

/**
 * Legacy synchronous middleware. Kept identical (modulo the negative-
 * override parser) so the existing tests + callers don't break. Use
 * `makeRequireOrchestrationEnabled` for the layered async path.
 */
function requireOrchestrationEnabled(req, res, next) {
  const userId = req.user?.userId;
  if (!isOrchestrationEnabledForTenant(userId)) {
    return res.status(403).json({
      error: 'orchestration_not_enabled_for_tenant',
      message: 'This tenant is not enrolled in LeadBridge orchestration. Contact your administrator.',
    });
  }
  return next();
}

// ─────────────────────────────────────────────────────────────────
// Layered enablement (env OR connection-state)
// ─────────────────────────────────────────────────────────────────

/**
 * Async, DB-aware check.
 *
 * Returns:
 *   { enabled: true,  via: 'env_override' | 'connection_state', detail?: object }
 *   { enabled: false, via: 'env_negative_override' | 'no_match', detail?: object }
 *   { enabled: false, via: 'error', error: string }   (transient DB failure)
 *
 * Hard rules:
 *   - Negative env override always wins.
 *   - Positive env override skips DB lookup (cheap break-glass path).
 *   - Connection-state path requires ALL of:
 *       leadbridge_connected = true
 *       lb_orchestration_enabled_at IS NOT NULL
 *       EXISTS active credential OR (rotating + grace_expires_at > now)
 *   - DB lookup errors return `via='error'`. The HTTP middleware treats
 *     this as 503 (not 403) because it's a transient failure, not a
 *     denial. This is critical so an incident can't mask itself by
 *     looking like "not enabled for tenant".
 *
 * @param {object} supabase
 * @param {number|string} userId
 * @param {object} [opts]
 * @param {number} [opts.nowMs]
 */
async function isOrchestrationEnabledForTenantLayered(supabase, userId, opts = {}) {
  if (userId == null) return { enabled: false, via: 'no_match' };

  const { all, positives, negatives } = parseEnabledTenants();
  const key = String(userId);

  if (negatives.has(key)) {
    return { enabled: false, via: 'env_negative_override' };
  }
  if (all || positives.has(key)) {
    return { enabled: true, via: 'env_override' };
  }

  if (!supabase || typeof supabase.from !== 'function') {
    return { enabled: false, via: 'no_match' };
  }

  const nowMs = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();
  const nowIso = new Date(nowMs).toISOString();

  // Step 1: connection state.
  const { data: setting, error: settingErr } = await supabase
    .from('communication_settings')
    .select('leadbridge_connected,lb_orchestration_enabled_at')
    .eq('user_id', Number(userId))
    .maybeSingle();

  if (settingErr) {
    return { enabled: false, via: 'error', error: settingErr.message };
  }
  if (!setting || setting.leadbridge_connected !== true || !setting.lb_orchestration_enabled_at) {
    return { enabled: false, via: 'no_match' };
  }

  // Step 2: live credential.
  const { data: creds, error: credsErr } = await supabase
    .from(TABLE)
    .select('id,status,grace_expires_at')
    .eq('user_id', Number(userId))
    .in('status', ['active', 'rotating']);

  if (credsErr) {
    return { enabled: false, via: 'error', error: credsErr.message };
  }
  if (!Array.isArray(creds) || creds.length === 0) {
    return { enabled: false, via: 'no_match' };
  }

  const haveLiveCred = creds.some((c) => {
    if (c.status === 'active') return true;
    if (c.status === 'rotating') {
      const graceMs = c.grace_expires_at ? Date.parse(c.grace_expires_at) : 0;
      return Number.isFinite(graceMs) && graceMs > nowMs;
    }
    return false;
  });

  if (!haveLiveCred) {
    return { enabled: false, via: 'no_match' };
  }

  return { enabled: true, via: 'connection_state' };
}

/**
 * Factory: returns an async Express middleware that performs the
 * layered enablement check. Mount AFTER auth middleware so req.user.userId
 * is set.
 *
 * On enabled → next().
 * On 'error' → 503 service_unavailable (transient).
 * Otherwise → 403 orchestration_not_enabled_for_tenant.
 *
 * @param {object} args
 * @param {object} args.supabase
 * @param {function} [args.now]
 */
function makeRequireOrchestrationEnabled(args) {
  if (!args || !args.supabase || typeof args.supabase.from !== 'function') {
    throw new Error('makeRequireOrchestrationEnabled: supabase required');
  }
  const { supabase, now } = args;
  return async function layeredRequireOrchestrationEnabled(req, res, next) {
    const userId = req.user && req.user.userId;
    const nowMs = typeof now === 'function' ? now() : undefined;
    const verdict = await isOrchestrationEnabledForTenantLayered(supabase, userId, { nowMs });
    if (verdict.enabled) return next();

    if (verdict.via === 'error') {
      return res.status(503).json({
        error: 'service_unavailable',
        message: 'Orchestration enablement lookup failed.',
      });
    }
    return res.status(403).json({
      error: 'orchestration_not_enabled_for_tenant',
      message: 'This tenant is not enrolled in LeadBridge orchestration. Contact your administrator.',
    });
  };
}

module.exports = {
  // Legacy / sync (kept for backward compat — outbound emitter still uses these)
  isOrchestrationEnabledForTenant,
  requireOrchestrationEnabled,

  // Layered / async (new in S2)
  isOrchestrationEnabledForTenantLayered,
  makeRequireOrchestrationEnabled,

  // exported for testing
  _parseEnabledTenants: parseEnabledTenants,
};
