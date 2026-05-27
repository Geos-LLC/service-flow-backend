'use strict';

// LB orchestration feature flag (Phase 2B).
//
// LB_ORCHESTRATION_ENABLED_TENANTS env var is a comma-separated list
// of tenant user_ids that may use the new orchestration endpoints +
// receive the new service_* outbound events.
//
// Empty / unset = nobody is enabled (the default, safe).
// '*'           = all tenants enabled (only for fleet-wide cutover).
// '2,17,42'     = those tenants only.
//
// This flag is read once per request — env var changes take effect
// without a redeploy on the next request (Railway uses persistent
// process.env access).

function parseEnabledTenants() {
  const raw = (process.env.LB_ORCHESTRATION_ENABLED_TENANTS || '').trim();
  if (!raw) return { all: false, set: new Set() };
  if (raw === '*') return { all: true, set: new Set() };
  const set = new Set();
  for (const piece of raw.split(',')) {
    const trimmed = piece.trim();
    if (!trimmed) continue;
    set.add(String(trimmed));
  }
  return { all: false, set };
}

function isOrchestrationEnabledForTenant(userId) {
  if (userId == null) return false;
  const { all, set } = parseEnabledTenants();
  if (all) return true;
  return set.has(String(userId));
}

// Express middleware. Use AFTER `authenticateToken` so `req.user.userId`
// is set. Returns 403 + a clear reason if the tenant isn't on the list.
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

module.exports = {
  isOrchestrationEnabledForTenant,
  requireOrchestrationEnabled,
  // exported for testing
  _parseEnabledTenants: parseEnabledTenants,
};
