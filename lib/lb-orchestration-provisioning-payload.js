'use strict';

// S4 — Final v1 provisioning payload (§3 of alignment doc + refinement 4).
//
// Returned by both:
//   - POST /api/integrations/leadbridge/oauth/exchange   (success)
//   - POST /api/integrations/leadbridge/connect          (canary success)
//
// Contains everything LB needs to wire its `SfConnection` runtime: SF
// base URL, endpoint paths, credential plaintext (returned ONCE),
// event types, signature metadata, webhook confirmation.

function envOr(name, fallback) {
  const v = process.env[name];
  return (typeof v === 'string' && v.length > 0) ? v : fallback;
}

/**
 * Build the v1 provisioning payload.
 *
 * @param {object} args
 * @param {object} args.tenant           — { sf_tenant_id, sf_tenant_name, sf_workspace_id }
 * @param {object} args.credential       — { token, credential_id, token_prefix, kid, scope, issued_at, expires_at }
 * @param {object} args.webhook          — { url, set_at, subscription_id?, state_ref? }
 * @param {string} [args.sfBaseUrl]
 * @param {string} [args.sourceInstance] — e.g. 'sf-staging' or 'sf-prod'. Refinement 4.
 * @param {string} [args.apiRegion]      — e.g. 'us-east-1'. Refinement 4 (optional).
 */
function buildProvisioningPayload(args) {
  if (!args || !args.tenant || !args.credential || !args.webhook) {
    throw new Error('buildProvisioningPayload: tenant, credential, webhook required');
  }
  const sfBaseUrl = args.sfBaseUrl
    || envOr('SF_PUBLIC_BASE_URL', null)
    || 'https://service-flow-backend-staging-303f.up.railway.app';
  const sourceInstance = args.sourceInstance || envOr('SF_SOURCE_INSTANCE', 'sf-staging');
  const apiRegion = args.apiRegion || envOr('SF_API_REGION', null);

  return {
    version: '1',
    tenant: {
      sf_tenant_id:     Number(args.tenant.sf_tenant_id),
      sf_tenant_name:   args.tenant.sf_tenant_name || null,
      sf_workspace_id:  Number(args.tenant.sf_workspace_id || args.tenant.sf_tenant_id),
      sf_base_url:      sfBaseUrl,
      source_instance:  sourceInstance,
      api_region:       apiRegion,
    },
    endpoints: {
      availability:        '/api/integrations/leadbridge/orchestration/availability',
      booking_request:     '/api/integrations/leadbridge/orchestration/booking-request',
      booking_cancel:      '/api/integrations/leadbridge/orchestration/booking-cancel',
      handoff:             '/api/integrations/leadbridge/orchestration/handoff',
      disconnect:          '/api/integrations/leadbridge/disconnect',
    },
    credential: {
      token:         args.credential.token,
      token_prefix:  args.credential.token_prefix,
      kid:           args.credential.kid,
      scope:         args.credential.scope || 'lb_orchestration',
      issued_at:     args.credential.issued_at,
      expires_at:    args.credential.expires_at,
    },
    event_types: [
      'service_scheduled',
      'service_rescheduled',
      'service_cancelled',
      'service_completed',
      'connection.connected',
      'credential.rotated',
      'connection.revoked',
    ],
    signature_metadata: {
      algorithm:             'hmac-sha256-hex',
      // Canonical signing string is `${X-SF-Timestamp}.${raw_body}`.
      // Binding the timestamp INTO the signature defeats replay with
      // a refreshed timestamp header. Matches LB's existing /job-status
      // HMAC pattern (Option 1 in the S4 contract).
      signed_string_format:  '${X-SF-Timestamp}.${raw_body}',
      body_canonical_form:   'timestamp_dot_raw_utf8_request_body',
      // X-SF-Timestamp is the integer number of seconds since the Unix
      // epoch, serialized as a base-10 ASCII string (e.g. "1780011918").
      // The verifier MUST parse with parseInt/Number — NOT Date.parse —
      // and MUST sign over the exact header string value (not a
      // re-formatted version).
      timestamp_format:      'unix_seconds',
      timestamp_example:     '1780011918',
      headers: {
        signature:  'X-SF-Signature',
        timestamp:  'X-SF-Timestamp',
        event_id:   'X-SF-Event-Id',
        event_type: 'X-SF-Event-Type',
        tenant_id:  'X-SF-Tenant-Id',
        kid:        'X-SF-Kid',
      },
      max_clock_skew_seconds: 300,
    },
    webhook: {
      url:             args.webhook.url,
      set_at:          args.webhook.set_at,
      secret_set:      true,                          // never echo the secret
      subscription_id: args.webhook.subscription_id || null,
      state_ref:       args.webhook.state_ref || null,
    },
  };
}

module.exports = {
  buildProvisioningPayload,
};
