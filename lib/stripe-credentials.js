'use strict';

/**
 * PR-S1.6 — Stripe direct-key credential validation.
 *
 * The legacy validator called `stripe.accounts.retrieve()`. That works for
 * standard `sk_test_…` / `sk_live_…` keys (full account scope) but fails for
 * restricted `rk_*` keys unless the operator explicitly granted Account
 * read scope — which isn't in the standard "third-party application"
 * permission set Stripe recommends. Tenants who picked the restricted-key
 * path on Stripe Dashboard hit a `400 Invalid Stripe credentials` even
 * when their key had every permission SF actually needs.
 *
 * This validator instead probes the four scopes SF's direct-key routes
 * actually exercise (Customers, Invoices, PaymentIntents, PaymentLinks),
 * categorizes the failure modes, and returns a structured result the
 * caller can render into a precise UX error.
 *
 * Categories returned:
 *   invalid_key                — format invalid, or Stripe says 401
 *   mode_mismatch              — pk_test_ paired with sk_live_ (or vice versa)
 *   insufficient_permissions   — Stripe says 403 on one or more probes
 *   unknown_stripe_error       — anything else (network, 5xx, etc.)
 *
 * Never logs the key, prefix, suffix, or raw Stripe error.message (Stripe
 * occasionally embeds the key prefix in error text). Callers should log
 * only the structured `code` field.
 */

// The 4 scopes SF's direct-key routes exercise. Probe via list({limit:1})
// rather than create/retrieve so the validation is read-only and idempotent.
const REQUIRED_SCOPES = [
  { label: 'Customers',       probe: (s) => s.customers.list({ limit: 1 }) },
  { label: 'Invoices',        probe: (s) => s.invoices.list({ limit: 1 }) },
  { label: 'Payment Intents', probe: (s) => s.paymentIntents.list({ limit: 1 }) },
  { label: 'Payment Links',   probe: (s) => s.paymentLinks.list({ limit: 1 }) },
];

function detectStripeMode(key) {
  if (typeof key !== 'string') return null;
  const m = /^(pk|sk|rk)_(test|live)_/.exec(key);
  return m ? m[2] : null;
}

function hasPublishablePrefix(key) {
  return typeof key === 'string' && /^pk_(test|live)_/.test(key);
}

function hasSecretPrefix(key) {
  // Both sk_ and rk_ are accepted secret-shaped prefixes.
  return typeof key === 'string' && /^(sk|rk)_(test|live)_/.test(key);
}

function isAuthError(err) {
  if (!err) return false;
  if (err.type === 'StripeAuthenticationError') return true;
  if (err.statusCode === 401) return true;
  if (err.code === 'api_key_invalid' || err.code === 'api_key_expired') return true;
  return false;
}

function isPermissionError(err) {
  if (!err) return false;
  if (err.type === 'StripePermissionError') return true;
  if (err.statusCode === 403) return true;
  if (err.code === 'permission_error' || err.code === 'restricted_key_permissions') return true;
  return false;
}

/**
 * @param {string} publishableKey
 * @param {string} secretKey
 * @param {object} [opts]
 * @param {Function} [opts.stripeFactory] - test seam: (secretKey) => stripeClient
 * @returns {Promise<{ok:true,mode:'test'|'live'} | {ok:false,code:string,details:string,missing_permissions?:string[],mode_publishable?:string,mode_secret?:string}>}
 */
async function validateStripeCredentials(publishableKey, secretKey, opts = {}) {
  // 1. Format checks (deterministic, no API call).
  if (!hasPublishablePrefix(publishableKey)) {
    return {
      ok: false,
      code: 'invalid_key',
      details: 'Publishable key must start with pk_test_ or pk_live_.',
    };
  }
  if (!hasSecretPrefix(secretKey)) {
    return {
      ok: false,
      code: 'invalid_key',
      details: 'Secret key must start with sk_test_, sk_live_, rk_test_, or rk_live_.',
    };
  }

  // 2. Mode-mismatch check (also deterministic).
  const pkMode = detectStripeMode(publishableKey);
  const skMode = detectStripeMode(secretKey);
  if (pkMode !== skMode) {
    return {
      ok: false,
      code: 'mode_mismatch',
      details: `Publishable key is ${pkMode} mode but secret key is ${skMode} mode. Both must be the same mode (either test or live).`,
      mode_publishable: pkMode,
      mode_secret: skMode,
    };
  }

  // 3. Probe required scopes in parallel. Promise.allSettled so a failed
  //    probe doesn't short-circuit the rest — we want to enumerate ALL
  //    missing permissions in one error, not just the first.
  const stripeFactory = opts.stripeFactory || ((k) => require('stripe')(k));
  let stripe;
  try {
    stripe = stripeFactory(secretKey);
  } catch (e) {
    // Should never happen with a well-formed key string, but the factory
    // can throw on completely malformed input.
    return { ok: false, code: 'invalid_key', details: 'Failed to initialize Stripe client.' };
  }

  const results = await Promise.allSettled(REQUIRED_SCOPES.map((s) => s.probe(stripe)));

  // 4. Categorize. Auth errors win (no point listing missing perms if the
  //    key itself isn't valid).
  for (const r of results) {
    if (r.status === 'rejected' && isAuthError(r.reason)) {
      return {
        ok: false,
        code: 'invalid_key',
        details: 'Stripe rejected the secret key as invalid or expired.',
      };
    }
  }

  // 5. Collect missing permissions across the 4 probes.
  const missing = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === 'rejected' && isPermissionError(r.reason)) {
      missing.push(REQUIRED_SCOPES[i].label);
    }
  }
  if (missing.length) {
    return {
      ok: false,
      code: 'insufficient_permissions',
      details: `Restricted key is missing required permissions: ${missing.join(', ')}. On Stripe Dashboard → Restricted keys → [this key] → Edit, grant Write access for each listed resource.`,
      missing_permissions: missing,
    };
  }

  // 6. Other failures (network / 5xx / unexpected) — surface as unknown.
  const otherFailures = results.filter((r) => r.status === 'rejected');
  if (otherFailures.length) {
    return {
      ok: false,
      code: 'unknown_stripe_error',
      details: 'Stripe returned an unexpected error during validation. Try again, or check Stripe status.',
    };
  }

  return { ok: true, mode: pkMode };
}

module.exports = {
  validateStripeCredentials,
  detectStripeMode,
  // Exported for tests + future callers (e.g., the test-connection route can
  // use these to render precise errors without re-implementing the logic).
  _internal: { isAuthError, isPermissionError, REQUIRED_SCOPES, hasPublishablePrefix, hasSecretPrefix },
};
