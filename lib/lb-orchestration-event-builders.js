'use strict';

// S4 — Lifecycle event envelope builders.
//
// Three lifecycle events:
//   connection.connected   — emitted once, after handshake commit
//   credential.rotated     — emitted inside rotation transaction
//   connection.revoked     — emitted before clearing webhook on disconnect
//
// Envelope (matches §6.2 of the alignment doc):
//   {
//     event_id,             // deterministic, also stored in lb_orchestration_outbox.event_id
//     event_type,
//     occurred_at,          // ISO 8601 UTC
//     sf_tenant_id,
//     source:             'service_flow_orchestration',
//     integration_mode:   'orchestration',
//     source_instance:    process.env.SF_SOURCE_INSTANCE || 'sf-staging',
//     data: { ...per event }
//   }

function sourceInstance() {
  return process.env.SF_SOURCE_INSTANCE || 'sf-staging';
}

function nowIso() {
  return new Date().toISOString();
}

function envelope(eventId, eventType, tenantId, data) {
  return {
    event_id:         eventId,
    event_type:       eventType,
    occurred_at:      nowIso(),
    sf_tenant_id:     Number(tenantId),
    source:           'service_flow_orchestration',
    integration_mode: 'orchestration',
    source_instance:  sourceInstance(),
    data,
  };
}

// ─────────────────────────────────────────────────────────────────
// connection.connected
// event_id format: evt_connection_connected_<tenant>_<credential_id>
// ─────────────────────────────────────────────────────────────────
function buildConnectionConnectedEvent(args) {
  if (!args || args.tenantId == null || !args.credential) {
    throw new Error('buildConnectionConnectedEvent: tenantId, credential required');
  }
  const eventId = `evt_connection_connected_${args.tenantId}_${args.credential.credentialId}`;
  return envelope(eventId, 'connection.connected', args.tenantId, {
    connected_at:  args.connectedAt || nowIso(),
    credential: {
      cred_id:      args.credential.credentialId,
      token_prefix: args.credential.tokenPrefix,
      kid:          args.credential.kid,
      expires_at:   args.credential.expiresAt,
    },
    webhook_set_at: args.webhookSetAt || nowIso(),
  });
}

// ─────────────────────────────────────────────────────────────────
// credential.rotated
// event_id format: evt_credential_rotated_<tenant>_<new_credential_id>
// ─────────────────────────────────────────────────────────────────
function buildCredentialRotatedEvent(args) {
  if (!args || args.tenantId == null || !args.newCredential || args.previousCredentialId == null) {
    throw new Error('buildCredentialRotatedEvent: tenantId, newCredential, previousCredentialId required');
  }
  const eventId = `evt_credential_rotated_${args.tenantId}_${args.newCredential.credentialId}`;
  return envelope(eventId, 'credential.rotated', args.tenantId, {
    previous_cred_id:          args.previousCredentialId,
    previous_grace_expires_at: args.previousGraceExpiresAt,
    new_credential: {
      cred_id:      args.newCredential.credentialId,
      token_prefix: args.newCredential.tokenPrefix,
      expires_at:   args.newCredential.expiresAt,
    },
    reason: args.reason || 'scheduled',
  });
}

// ─────────────────────────────────────────────────────────────────
// connection.revoked
// event_id format: evt_connection_revoked_<tenant>_<unix_seconds>
// ─────────────────────────────────────────────────────────────────
function buildConnectionRevokedEvent(args) {
  if (!args || args.tenantId == null) {
    throw new Error('buildConnectionRevokedEvent: tenantId required');
  }
  const ts = args.revokedAtMs != null ? Number(args.revokedAtMs) : Date.now();
  const eventId = `evt_connection_revoked_${args.tenantId}_${Math.floor(ts / 1000)}`;
  return envelope(eventId, 'connection.revoked', args.tenantId, {
    revoked_at: new Date(ts).toISOString(),
    actor:      args.actor   || 'service_flow',
    reason:     args.reason  || 'disconnect',
  });
}

module.exports = {
  sourceInstance,
  buildConnectionConnectedEvent,
  buildCredentialRotatedEvent,
  buildConnectionRevokedEvent,
};
