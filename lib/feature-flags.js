'use strict';

// Identity unification feature flags — all default OFF while Phase A is landing.
// Flip per-flag via env or per-user overrides in future phases.
//
// Reading order: env override → default (false).
// Env values accepted as truthy: 1, true, TRUE, yes, on.

function envBool(name) {
  const v = process.env[name];
  if (v === undefined || v === null) return null;
  return /^(1|true|yes|on)$/i.test(String(v).trim());
}

const FLAGS = {
  // Phase A: resolver available for call but nothing wired to it yet.
  IDENTITY_RESOLVER_AVAILABLE: 'IDENTITY_RESOLVER_AVAILABLE',
  // Phase B/C/D per-source rewiring gates.
  IDENTITY_RESOLVER_LEADBRIDGE: 'IDENTITY_RESOLVER_LEADBRIDGE',
  IDENTITY_RESOLVER_OPENPHONE:  'IDENTITY_RESOLVER_OPENPHONE',
  IDENTITY_RESOLVER_ZENBOOKER:  'IDENTITY_RESOLVER_ZENBOOKER',
  // Phase C: conditional lead creation from OpenPhone (incl. LB-recovery path).
  OPENPHONE_CONDITIONAL_LEAD_CREATION: 'OPENPHONE_CONDITIONAL_LEAD_CREATION',
  // Phase E: backfill job gate.
  IDENTITY_BACKFILL_ENABLED: 'IDENTITY_BACKFILL_ENABLED',
  // Phase F: replace 5-bucket classifier UI with identity-centric reporting.
  IDENTITY_REPORTING_UI: 'IDENTITY_REPORTING_UI',
  // Source-account boundary (docs/security/source-account-boundary-plan.md).
  // Phase 1 ships only the schema + write-side stamping. Read-side filtering
  // (hide rows whose provider_account.status != 'active') stays behind this
  // flag until backfill + read-path changes land in a later phase.
  SOURCE_ACCOUNT_BOUNDARY_ENFORCED: 'SOURCE_ACCOUNT_BOUNDARY_ENFORCED',
  // PR-2 webhook authentication. Both default OFF so the verification code
  // can land + be tested before flipping enforcement on.
  // SIGCORE_WEBHOOK_HMAC_REQUIRED: when ON, /api/communications/webhooks/sigcore
  //   rejects unsigned or signature-mismatch requests with 401.
  // LB_INBOUND_HMAC_REQUIRED: same, for /api/integrations/leadbridge/webhooks.
  // Note: LB requires an inbound subscription (see migration 037) registered
  //   per user before the flag can be safely flipped on, otherwise live LB
  //   events get rejected.
  SIGCORE_WEBHOOK_HMAC_REQUIRED: 'SIGCORE_WEBHOOK_HMAC_REQUIRED',
  LB_INBOUND_HMAC_REQUIRED: 'LB_INBOUND_HMAC_REQUIRED',
  // P0.2 (Synchronization Constitution §6.1): ZB webhook auth gate. When ON,
  // /api/zenbooker/webhook requires either a valid X-ZB-Signature HMAC (if
  // ZENBOOKER_WEBHOOK_SECRET is set) or a matching X-ZB-Secret shared bearer.
  // Defaults OFF to land the verification code first; flip ON once the secret
  // is provisioned in Railway prod and Zenbooker's webhook config is updated.
  ZB_WEBHOOK_AUTH_REQUIRED: 'ZB_WEBHOOK_AUTH_REQUIRED',
  // PR-3 admin endpoint gates. All default OFF so destructive admin
  // surfaces are unreachable in prod unless an operator explicitly flips
  // the env var. Read-only admin views (GET /admin/global-settings,
  // GET /admin/sendgrid, GET /admin/users) stay open behind the
  // standard authenticateAdmin JWT — these gates apply only to mutation
  // and side-effect routes.
  //
  // ENABLE_ADMIN_RUN_MIGRATION       — POST /api/admin/run-migration
  // ENABLE_ADMIN_GLOBAL_SETTINGS     — PUT  /api/admin/global-settings
  //                                    POST /api/admin/test-sigcore
  // ENABLE_ADMIN_SENDGRID_MUTATION   — PUT  /api/admin/sendgrid
  //                                    POST /api/admin/test-sendgrid
  // ENABLE_ADMIN_ORCH_CREDENTIALS    — POST /api/internal/lb-orchestration/credentials/{mint,rotate,revoke}
  //                                    GET  /api/internal/lb-orchestration/credentials/status
  //                                    S3A: internal/admin-only credential lifecycle.
  //                                    Disabled by default; flip per-env when minting is needed for verification.
  ENABLE_ADMIN_RUN_MIGRATION: 'ENABLE_ADMIN_RUN_MIGRATION',
  ENABLE_ADMIN_GLOBAL_SETTINGS: 'ENABLE_ADMIN_GLOBAL_SETTINGS',
  ENABLE_ADMIN_SENDGRID_MUTATION: 'ENABLE_ADMIN_SENDGRID_MUTATION',
  ENABLE_ADMIN_ORCH_CREDENTIALS: 'ENABLE_ADMIN_ORCH_CREDENTIALS',
  // Phase 0 (identity reconciliation v5): operational freeze switch for the
  // projection layer. Resolver still runs; identity graph still updates;
  // projection from identity → leads.converted_customer_id stops.
  // Use as containment lever if projections misbehave during rollout.
  IDENTITY_PROJECTION_FREEZE: 'IDENTITY_PROJECTION_FREEZE',
  // Phase 0 hybrid migration bridge — TRANSITIONAL infrastructure.
  //
  // Capability flag (must be true AND tenant must be in the opt-in list):
  //   IDENTITY_SCORING_FALLBACK_ENABLED=true
  // Tenant opt-in list (rollout is per-tenant, deliberate):
  //   IDENTITY_SCORING_FALLBACK_TENANTS=2,7
  //
  // Default state: capability flag OFF (unset) → fallback never runs
  // regardless of tenant list. Both conditions required.
  //
  // Operationally: the fallback is migration infrastructure to bridge
  // legacy auto-link behaviour while the identity graph hydrates. It
  // does NOT default to ON globally — that would let transitional code
  // silently become permanent architecture. Operators must:
  //   1. Set IDENTITY_SCORING_FALLBACK_ENABLED=true (capability)
  //   2. Add specific tenant IDs to IDENTITY_SCORING_FALLBACK_TENANTS
  //      as they're rolled out, one at a time.
  //
  // Retirement: when graph-completeness metrics show fallback success
  // rate near zero for a tenant for 14+ days, remove that tenant from
  // the opt-in list. When the list is empty for 30+ days, remove the
  // capability flag and the fallback code path entirely.
  IDENTITY_SCORING_FALLBACK_ENABLED: 'IDENTITY_SCORING_FALLBACK_ENABLED',
  // Phase 0.5: when ON, repeat LB acquisitions on an identity that already
  // has sf_lead_id create child leads (parent_lead_id = identity.sf_lead_id)
  // instead of enriching the canonical lead. Also enables the reactivation
  // path: new canonical lead created when identity has sf_customer_id but
  // no sf_lead_id. Preserves acquisition attribution per event.
  // Requires migration 049. Per-tenant rollout via
  // LEAD_CARDINALITY_CHILD_LEADS_TENANTS=2,7.
  LEAD_CARDINALITY_CHILD_LEADS: 'LEAD_CARDINALITY_CHILD_LEADS',
  // Identity reconciliation engine — Stage 1 (dark code) gates.
  RECONCILIATION_ENGINE_AVAILABLE: 'RECONCILIATION_ENGINE_AVAILABLE',
  RECONCILIATION_ENGINE_LEADBRIDGE: 'RECONCILIATION_ENGINE_LEADBRIDGE',
  RECONCILIATION_ENGINE_ZENBOOKER: 'RECONCILIATION_ENGINE_ZENBOOKER',
  RECONCILIATION_ENGINE_OPENPHONE: 'RECONCILIATION_ENGINE_OPENPHONE',
  RECONCILIATION_ENGINE_MANUAL_SF: 'RECONCILIATION_ENGINE_MANUAL_SF',
  RECONCILIATION_ENGINE_SIGCORE: 'RECONCILIATION_ENGINE_SIGCORE',
};

function isEnabled(flag) {
  if (!Object.values(FLAGS).includes(flag)) throw new Error(`Unknown flag: ${flag}`);
  const env = envBool(flag);
  if (env !== null) return env;
  return false;
}

// Standard per-tenant opt-in helper. Reads `<FLAG>_TENANTS` env var as
// comma-separated integer user IDs; if userId is in the list the flag is
// ON for that tenant regardless of the global flag. Global flag also
// respected (global ON applies to everyone). Used for staged Phase 0.5
// (LEAD_CARDINALITY_CHILD_LEADS) rollout — and later Stage 1/2 engine
// flags inherit the same pattern.
//
//   LEAD_CARDINALITY_CHILD_LEADS_TENANTS=2,7
//   isEnabledForTenant(FLAGS.LEAD_CARDINALITY_CHILD_LEADS, 2) → true
//   isEnabledForTenant(FLAGS.LEAD_CARDINALITY_CHILD_LEADS, 9) → false (unless global ON)
function isEnabledForTenant(flag, userId) {
  if (!Object.values(FLAGS).includes(flag)) throw new Error(`Unknown flag: ${flag}`);
  if (isEnabled(flag)) return true;
  if (userId == null) return false;
  const raw = process.env[`${flag}_TENANTS`];
  if (!raw) return false;
  const ids = String(raw).split(',').map(s => s.trim()).filter(Boolean).map(s => parseInt(s, 10));
  return ids.includes(Number(userId));
}

// Strict opt-in helper for IDENTITY_SCORING_FALLBACK.
//
// Returns true ONLY when BOTH:
//   1. Capability flag is explicitly set to a truthy value:
//      IDENTITY_SCORING_FALLBACK_ENABLED in {1,true,yes,on}
//   2. Tenant ID is in the explicit opt-in list:
//      IDENTITY_SCORING_FALLBACK_TENANTS=<csv-of-user-ids>
//
// Default: fallback OFF. Setting only the capability flag is NOT enough.
// Setting only the tenants list is NOT enough. This is by design — the
// fallback is transitional infrastructure and must be enabled per tenant,
// deliberately.
//
// Note: this differs from isEnabledForTenant, which uses the standard
// "global flag OR tenant in list" semantics. The fallback is stricter
// because its rollout requires explicit operator action per tenant.
function isFallbackEnabledForTenant(userId) {
  if (userId == null) return false;
  // 1. Capability flag must be explicitly true.
  const cap = envBool('IDENTITY_SCORING_FALLBACK_ENABLED');
  if (cap !== true) return false;
  // 2. Tenant must be in the opt-in list.
  const raw = process.env['IDENTITY_SCORING_FALLBACK_TENANTS'];
  if (!raw) return false;
  const ids = String(raw).split(',').map(s => s.trim()).filter(Boolean).map(s => parseInt(s, 10));
  return ids.includes(Number(userId));
}

function snapshot() {
  const out = {};
  for (const name of Object.values(FLAGS)) out[name] = isEnabled(name);
  return out;
}

// Integer env values (age windows, rate limits, etc). Returns null when unset
// or unparseable so callers can treat absence as "no limit".
function envInt(name) {
  const v = process.env[name];
  if (v === undefined || v === null || v === '') return null;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

// Convenience: OPENPHONE_CONDITIONAL_LEAD_CREATION_MAX_AGE_DAYS as integer,
// null = disabled (no age gate).
function getOpenPhoneLeadMaxAgeDays() {
  return envInt('OPENPHONE_CONDITIONAL_LEAD_CREATION_MAX_AGE_DAYS');
}

module.exports = { FLAGS, isEnabled, isEnabledForTenant, isFallbackEnabledForTenant, snapshot, envInt, getOpenPhoneLeadMaxAgeDays };
