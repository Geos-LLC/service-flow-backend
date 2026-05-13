'use strict';

/**
 * PR-4 startup config audit.
 *
 * Runs once at server boot and produces a loud, structured summary of any
 * security-relevant env-var state that would silently weaken the running
 * process. The intent is not to block startup — the health endpoint still
 * needs to come up so deploys finish — but to make misconfiguration
 * impossible to miss in Loki and Railway boot logs.
 *
 * Three severity levels:
 *   CRITICAL → token-forgery / auth-bypass class. Production *must* fail
 *              loud, and in production we additionally throw so the
 *              process exits.
 *   HIGH     → a security feature is silently disabled (admin login,
 *              webhook verification, encryption-at-rest, Stripe events).
 *   MEDIUM   → defence-in-depth flag explicitly OFF on a managed env.
 *
 * The audit is pure-data: tests can drive it with a synthetic env and
 * a captured logger to assert behaviour. server.js wires it to the
 * real `process.env` + `logger` and calls `runStartupConfigAudit()`
 * after middleware mount but before listen().
 */

// JWT_SECRET fallback string in server.js (must match exactly).
const JWT_SECRET_FALLBACK = 'your-super-secret-jwt-key-change-in-production';

// Per-service JWT fallback used in older modules (email-service.js etc.).
const PER_SERVICE_JWT_FALLBACK = 'your-secret-key';

// Encryption-key fallback used in services/lb-encryption.js.
const ENCRYPTION_KEY_FALLBACK = 'dev-only-encryption-fallback-not-for-prod';

function inspectConfig(env = process.env) {
  const findings = [];

  const isProd = String(env.NODE_ENV || '').toLowerCase() === 'production'
    || String(env.RAILWAY_ENVIRONMENT_NAME || '').toLowerCase() === 'prod'
    || String(env.RAILWAY_ENVIRONMENT_NAME || '').toLowerCase() === 'production';

  // ── CRITICAL ──────────────────────────────────────────────────
  if (!env.JWT_SECRET || env.JWT_SECRET === JWT_SECRET_FALLBACK) {
    findings.push({
      severity: 'CRITICAL',
      key: 'JWT_SECRET',
      reason: env.JWT_SECRET
        ? 'JWT_SECRET equals the hardcoded fallback string — tokens can be forged by anyone with repo access'
        : 'JWT_SECRET is unset — server.js fallback is the well-known hardcoded string',
      fix: 'Set JWT_SECRET to a strong random value (≥64 chars). Restart the process.',
    });
  }

  // ── CRITICAL: webhook secret aliasing ─────────────────────────
  // PR-S1.7: Stripe issues a DISTINCT signing secret per webhook endpoint.
  // The Platform Billing endpoint and the Connect endpoint each have their
  // own. If the operator pastes the same value into both env vars, one of
  // the two routes is silently rejecting every legitimate event (signature
  // mismatch against the other endpoint's secret). This is functionally
  // worse than unset, because there's no 503 — every event becomes a 400
  // and the dashboard reports failed deliveries with no obvious cause.
  if (env.STRIPE_WEBHOOK_SECRET
      && env.STRIPE_CONNECT_WEBHOOK_SECRET
      && env.STRIPE_WEBHOOK_SECRET === env.STRIPE_CONNECT_WEBHOOK_SECRET) {
    findings.push({
      severity: 'CRITICAL',
      key: 'STRIPE_WEBHOOK_SECRET==STRIPE_CONNECT_WEBHOOK_SECRET',
      reason: 'STRIPE_WEBHOOK_SECRET and STRIPE_CONNECT_WEBHOOK_SECRET are identical. Stripe issues unique signing secrets per webhook endpoint; equal values mean webhook-domain separation is functionally broken and at least one route is silently rejecting legitimate events.',
      fix: 'Set each var to its own endpoint\'s signing secret from Stripe Dashboard → Developers → Webhooks. Platform endpoint signs customer.subscription.* and invoice.* events; Connect endpoint signs account.updated and account.application.* events.',
    });
  }

  // ── HIGH ──────────────────────────────────────────────────────
  // PR-S1.7: Platform Billing domain (subscription/invoice events on the
  // Service Flow account itself).
  if (!env.STRIPE_WEBHOOK_SECRET) {
    findings.push({
      severity: 'HIGH',
      key: 'STRIPE_WEBHOOK_SECRET',
      reason: 'STRIPE_WEBHOOK_SECRET is unset — Platform Billing events (customer.subscription.*, invoice.payment_*) cannot be verified and are being rejected with 503.',
      fix: 'Copy the Platform endpoint signing secret from Stripe Dashboard → Developers → Webhooks → [Platform endpoint] → Signing secret, and set it on Railway as STRIPE_WEBHOOK_SECRET.',
    });
  }

  // PR-S1.7: Connect domain (account.updated etc. for tenant-connected
  // Stripe Express accounts).
  if (!env.STRIPE_CONNECT_WEBHOOK_SECRET) {
    findings.push({
      severity: 'HIGH',
      key: 'STRIPE_CONNECT_WEBHOOK_SECRET',
      reason: 'STRIPE_CONNECT_WEBHOOK_SECRET is unset — Connect account events (account.updated, account.application.{authorized,deauthorized}) cannot be verified and are being rejected with 503.',
      fix: 'Copy the Connect endpoint signing secret from Stripe Dashboard → Developers → Webhooks → [Connect endpoint] → Signing secret, and set it on Railway as STRIPE_CONNECT_WEBHOOK_SECRET.',
    });
  }

  if (!env.ADMIN_EMAIL || !env.ADMIN_PASSWORD) {
    findings.push({
      severity: 'HIGH',
      key: 'ADMIN_EMAIL/ADMIN_PASSWORD',
      reason: 'Admin login endpoint is unreachable (returns 503 admin_auth_unconfigured) until both ADMIN_EMAIL and ADMIN_PASSWORD are set.',
      fix: 'Set both env vars. The PR-3 admin auth code has no fallback path.',
    });
  }

  if (!env.SF_INTEGRATION_ENC_KEY) {
    findings.push({
      severity: 'HIGH',
      key: 'SF_INTEGRATION_ENC_KEY',
      reason: 'SF_INTEGRATION_ENC_KEY is unset — services/lb-encryption.js falls back to the hardcoded dev string; any integration secret encrypted with this server cannot be decrypted by a properly-configured one (and vice-versa).',
      fix: 'Set SF_INTEGRATION_ENC_KEY to a 32-byte base64 value, identical across all envs that share the same Supabase database.',
    });
  }

  // ── MEDIUM ────────────────────────────────────────────────────
  if (isTruthyDisabled(env.SIGCORE_WEBHOOK_HMAC_REQUIRED)) {
    findings.push({
      severity: 'MEDIUM',
      key: 'SIGCORE_WEBHOOK_HMAC_REQUIRED',
      reason: 'Sigcore inbound webhook signature verification is disabled. Any unsigned POST to /api/communications/webhooks/sigcore is accepted as authentic.',
      fix: 'Set SIGCORE_WEBHOOK_HMAC_REQUIRED=true (PR-2 enforcement flag).',
    });
  }

  if (isTruthyDisabled(env.LB_INBOUND_HMAC_REQUIRED)) {
    findings.push({
      severity: 'MEDIUM',
      key: 'LB_INBOUND_HMAC_REQUIRED',
      reason: 'LeadBridge inbound webhook signature verification is disabled.',
      fix: 'Set LB_INBOUND_HMAC_REQUIRED=true (PR-2 enforcement flag).',
    });
  }

  if (isTruthyDisabled(env.SOURCE_ACCOUNT_BOUNDARY_ENFORCED)) {
    findings.push({
      severity: 'MEDIUM',
      key: 'SOURCE_ACCOUNT_BOUNDARY_ENFORCED',
      reason: 'Source-account read-side boundary is disabled. Disconnected provider account data may leak through CRM views.',
      fix: 'Set SOURCE_ACCOUNT_BOUNDARY_ENFORCED=true after Phase 4 verification.',
    });
  }

  return { findings, isProd };
}

// "Truthy-disabled": env var is missing or explicitly falsey. We treat
// "unset" the same as "off" for these defence-in-depth flags so a missing
// env produces a warning on managed envs.
function isTruthyDisabled(value) {
  if (value === undefined || value === null || value === '') return true;
  return !/^(1|true|yes|on)$/i.test(String(value).trim());
}

/**
 * Emits the findings via the provided logger and, when running in
 * production, throws if any CRITICAL finding is present so process
 * managers (Railway) restart with the misconfiguration surfaced.
 *
 * `logger` must implement {warn, error}. We use error for CRITICAL,
 * warn for HIGH/MEDIUM, so it's filterable in Loki.
 */
function runStartupConfigAudit({ env = process.env, logger = console, throwOnCriticalInProd = true } = {}) {
  const { findings, isProd } = inspectConfig(env);

  if (findings.length === 0) {
    logger.warn?.('[Config Audit] ✅ no security misconfigurations detected at startup');
    return { findings, threw: false };
  }

  const banner = '═══════════════════════════════════════════════════════════════';
  const header = `[Config Audit] ⚠  ${findings.length} security misconfiguration${findings.length === 1 ? '' : 's'} detected at startup`;

  // Print a loud block so it's hard to miss in boot logs.
  logger.warn?.(banner);
  logger.warn?.(header);
  logger.warn?.(banner);

  for (const f of findings) {
    const tag = `[Config Audit ${f.severity}]`;
    const line = `${tag} ${f.key} — ${f.reason}`;
    const fix = `${tag} fix: ${f.fix}`;
    if (f.severity === 'CRITICAL') {
      logger.error?.(line);
      logger.error?.(fix);
    } else {
      logger.warn?.(line);
      logger.warn?.(fix);
    }
  }
  logger.warn?.(banner);

  const hasCritical = findings.some(f => f.severity === 'CRITICAL');
  if (hasCritical && isProd && throwOnCriticalInProd) {
    const err = new Error(
      `Refusing to start in production with CRITICAL config issues: ${findings
        .filter(f => f.severity === 'CRITICAL')
        .map(f => f.key)
        .join(', ')}`,
    );
    err.code = 'CONFIG_AUDIT_CRITICAL';
    throw err;
  }

  return { findings, threw: false };
}

module.exports = {
  inspectConfig,
  runStartupConfigAudit,
  JWT_SECRET_FALLBACK,
  PER_SERVICE_JWT_FALLBACK,
  ENCRYPTION_KEY_FALLBACK,
};
