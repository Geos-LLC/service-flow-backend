'use strict';

// S3A + S3B — Internal/admin-only orchestration admin endpoints.
//
// These endpoints are NOT the OAuth/connect flow. They are an isolated,
// admin-protected surface used to validate the credential + enablement
// lifecycle independently in staging before the OAuth handshake is built.
//
// All endpoints live under /api/internal/lb-orchestration/...
//
// Each route is double-gated:
//   1. authenticateAdmin       — JWT with admin:true claim required
//   2. requireAdminFlag(ENABLE_ADMIN_ORCH_CREDENTIALS) — env kill switch,
//      defaults OFF in every environment
//
// S3A: credential lifecycle (under /credentials/...)
//   POST /credentials/mint
//   POST /credentials/rotate
//   POST /credentials/revoke
//   GET  /credentials/status?user_id=N
//
// S3B: tenant enablement state (NOT under /credentials/ — these mutate
// communication_settings, not credentials directly)
//   POST /enable          — opens the layered-enablement gate for a tenant
//   POST /disable         — closes the gate AND revokes credentials atomically
//   GET  /tenant-status   — full snapshot of credential + enablement + gate state
//
// Hard rules:
//   - No tenant self-service. Callers must hold an admin JWT.
//   - No webhook side effects (no SF → LB POSTs from these handlers).
//   - No OAuth, no public connect/disconnect, no automatic provisioning.
//   - Enable requires an existing active credential — it does NOT mint.
//   - Disable revokes credentials AND clears enablement, mirroring the
//     gate-close half of disconnect. Audit trail rows are preserved
//     (status='revoked' rows stay in lb_orchestration_credentials).
//   - Plaintext tokens are returned ONLY in mint + rotate response bodies.
//     They are never logged. They are never stored (only sha256(token)).
//
// Mounted from server.js. The router is a factory that accepts
// { supabase, logger, authenticateAdmin, requireAdminFlag, flagName }
// so it is unit-testable without booting the full Express app.

const express = require('express');
const {
  mintCredential,
  rotateCredential,
  revokeCredential,
} = require('./lb-orchestration-credentials');

const TABLE = 'lb_orchestration_credentials';

function isPositiveInteger(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0;
}

/**
 * Build the internal admin router.
 *
 * @param {object} deps
 * @param {object} deps.supabase
 * @param {object} [deps.logger]
 * @param {function} deps.authenticateAdmin   — express middleware
 * @param {function} deps.requireAdminFlag    — factory: (flagName) -> middleware
 * @param {string}  [deps.flagName='ENABLE_ADMIN_ORCH_CREDENTIALS']
 */
function makeAdminCredentialRouter(deps) {
  if (!deps || typeof deps.supabase?.from !== 'function') {
    throw new Error('makeAdminCredentialRouter: supabase required');
  }
  if (typeof deps.authenticateAdmin !== 'function') {
    throw new Error('makeAdminCredentialRouter: authenticateAdmin required');
  }
  if (typeof deps.requireAdminFlag !== 'function') {
    throw new Error('makeAdminCredentialRouter: requireAdminFlag required');
  }
  const supabase = deps.supabase;
  const logger   = deps.logger || { log() {}, warn() {}, error() {}, debug() {} };
  const flagName = deps.flagName || 'ENABLE_ADMIN_ORCH_CREDENTIALS';
  const gate     = [deps.authenticateAdmin, deps.requireAdminFlag(flagName)];

  const router = express.Router();

  // ─────────────────────────────────────────────────────────────────
  // POST /credentials/mint
  // body: { user_id, kid?, expires_in_ms?, created_by? }
  // ─────────────────────────────────────────────────────────────────
  router.post('/credentials/mint', ...gate, async (req, res) => {
    const userId      = req.body?.user_id;
    const kid         = req.body?.kid;
    const expiresInMs = req.body?.expires_in_ms;
    const createdBy   = req.body?.created_by || 'admin_mint';

    if (!isPositiveInteger(userId)) {
      return res.status(400).json({ error: 'user_id must be a positive integer' });
    }
    if (expiresInMs != null && (!Number.isInteger(Number(expiresInMs)) || Number(expiresInMs) <= 0)) {
      return res.status(400).json({ error: 'expires_in_ms must be a positive integer if provided' });
    }

    try {
      const out = await mintCredential(supabase, {
        userId:      Number(userId),
        kid:         kid || undefined,
        expiresInMs: expiresInMs != null ? Number(expiresInMs) : undefined,
        createdBy,
      });
      if (!out.ok) {
        if (out.reason === 'active_credential_already_exists') {
          try { logger.warn(`[orch-admin] mint conflict for user=${userId}`); } catch (_) {}
          return res.status(409).json({ error: 'active_credential_already_exists' });
        }
        if (out.reason === 'signing_key_not_configured') {
          try { logger.error(`[orch-admin] mint failed — SF_ORCH_SIGNING_KEY not configured for kid=${out.kid}`); } catch (_) {}
          return res.status(503).json({ error: 'signing_key_not_configured', kid: out.kid });
        }
        try { logger.error(`[orch-admin] mint db error: ${out.dbError || out.reason}`); } catch (_) {}
        return res.status(500).json({ error: out.reason });
      }

      // SUCCESS — return plaintext token ONCE. Do NOT log it.
      try { logger.log(`[orch-admin] mint ok user=${userId} cred_id=${out.credentialId} prefix=${out.tokenPrefix}`); } catch (_) {}
      return res.status(200).json({
        token:         out.token,
        credential_id: out.credentialId,
        token_prefix:  out.tokenPrefix,
        kid:           out.kid,
        scope:         'lb_orchestration',
        issued_at:     out.issuedAt,
        expires_at:    out.expiresAt,
      });
    } catch (err) {
      try { logger.error(`[orch-admin] mint threw: ${err && err.message}`); } catch (_) {}
      return res.status(500).json({ error: 'internal_error' });
    }
  });

  // ─────────────────────────────────────────────────────────────────
  // POST /credentials/rotate
  // body: { user_id, reason? }
  // ─────────────────────────────────────────────────────────────────
  router.post('/credentials/rotate', ...gate, async (req, res) => {
    const userId = req.body?.user_id;
    const reason = req.body?.reason || 'admin_rotate';

    if (!isPositiveInteger(userId)) {
      return res.status(400).json({ error: 'user_id must be a positive integer' });
    }

    try {
      const out = await rotateCredential(supabase, { userId: Number(userId), reason });
      if (!out.ok) {
        if (out.reason === 'no_active_credential') {
          return res.status(404).json({ error: 'no_active_credential' });
        }
        if (out.reason && out.reason.startsWith('mint_failed:')) {
          if (out.reason.includes('signing_key_not_configured')) {
            return res.status(503).json({ error: 'signing_key_not_configured' });
          }
        }
        try { logger.error(`[orch-admin] rotate failed user=${userId} reason=${out.reason}`); } catch (_) {}
        return res.status(500).json({ error: out.reason });
      }

      try { logger.log(`[orch-admin] rotate ok user=${userId} old=${out.previousCredentialId} new=${out.newCredentialId} prefix=${out.newTokenPrefix}`); } catch (_) {}
      return res.status(200).json({
        token:                       out.token,
        new_credential_id:           out.newCredentialId,
        new_token_prefix:            out.newTokenPrefix,
        previous_credential_id:      out.previousCredentialId,
        previous_grace_expires_at:   out.previousGraceExpiresAt,
        issued_at:                   out.issuedAt,
        expires_at:                  out.expiresAt,
      });
    } catch (err) {
      try { logger.error(`[orch-admin] rotate threw: ${err && err.message}`); } catch (_) {}
      return res.status(500).json({ error: 'internal_error' });
    }
  });

  // ─────────────────────────────────────────────────────────────────
  // POST /credentials/revoke
  // body: { user_id, reason? }
  // ─────────────────────────────────────────────────────────────────
  router.post('/credentials/revoke', ...gate, async (req, res) => {
    const userId = req.body?.user_id;
    const reason = req.body?.reason || 'admin_revoke';

    if (!isPositiveInteger(userId)) {
      return res.status(400).json({ error: 'user_id must be a positive integer' });
    }

    try {
      const out = await revokeCredential(supabase, { userId: Number(userId), reason });
      if (!out.ok) {
        try { logger.error(`[orch-admin] revoke failed user=${userId} reason=${out.reason}`); } catch (_) {}
        return res.status(500).json({ error: out.reason });
      }
      try { logger.log(`[orch-admin] revoke ok user=${userId} revoked=${out.revokedCount}`); } catch (_) {}
      return res.status(200).json({
        revoked_ids:   out.revokedIds,
        revoked_count: out.revokedCount,
        reason,
      });
    } catch (err) {
      try { logger.error(`[orch-admin] revoke threw: ${err && err.message}`); } catch (_) {}
      return res.status(500).json({ error: 'internal_error' });
    }
  });

  // ─────────────────────────────────────────────────────────────────
  // GET /credentials/status?user_id=N
  // ─────────────────────────────────────────────────────────────────
  router.get('/credentials/status', ...gate, async (req, res) => {
    const userId = req.query?.user_id;
    if (!isPositiveInteger(userId)) {
      return res.status(400).json({ error: 'user_id query param must be a positive integer' });
    }
    const tenantId = Number(userId);

    try {
      // Credentials for this tenant.
      const { data: credRows, error: credErr } = await supabase
        .from(TABLE)
        .select('id,token_prefix,kid,scope,status,issued_at,expires_at,grace_expires_at,last_used_at,revoked_at,revoked_reason')
        .eq('user_id', tenantId);

      if (credErr) {
        try { logger.error(`[orch-admin] status cred lookup failed: ${credErr.message}`); } catch (_) {}
        return res.status(503).json({ error: 'service_unavailable' });
      }

      const active   = (credRows || []).find((c) => c.status === 'active')   || null;
      const rotating = (credRows || []).find((c) => c.status === 'rotating') || null;

      // Connection state + webhook metadata.
      const { data: settingRow, error: settingErr } = await supabase
        .from('communication_settings')
        .select('leadbridge_connected,lb_orchestration_enabled_at,lb_orchestration_webhook_url,lb_orchestration_webhook_set_at,lb_orchestration_subscription_id,lb_orchestration_state_ref')
        .eq('user_id', tenantId)
        .maybeSingle();

      if (settingErr) {
        try { logger.error(`[orch-admin] status setting lookup failed: ${settingErr.message}`); } catch (_) {}
        return res.status(503).json({ error: 'service_unavailable' });
      }

      const envRaw = (process.env.LB_ORCHESTRATION_ENABLED_TENANTS || '').trim();
      const envHasPositive = envRaw === '*' || envRaw.split(',').map((s) => s.trim()).some((s) => s === String(tenantId) || s === '+' + tenantId);
      const envHasNegative = envRaw.split(',').map((s) => s.trim()).some((s) => s === '-' + tenantId);
      const envOverride = envHasNegative ? false : envHasPositive;

      const connStateEnabled = !!(settingRow
        && settingRow.leadbridge_connected === true
        && settingRow.lb_orchestration_enabled_at
        && (active || (rotating && rotating.grace_expires_at && Date.parse(rotating.grace_expires_at) > Date.now())));

      const effective = envHasNegative ? false : (envHasPositive || connStateEnabled);

      // Never include token_hash in any response.
      function trim(c) {
        if (!c) return null;
        return {
          id:               c.id,
          token_prefix:     c.token_prefix,
          kid:              c.kid,
          scope:            c.scope,
          status:           c.status,
          issued_at:        c.issued_at,
          expires_at:       c.expires_at,
          grace_expires_at: c.grace_expires_at,
          last_used_at:     c.last_used_at,
          revoked_at:       c.revoked_at,
          revoked_reason:   c.revoked_reason,
        };
      }

      return res.status(200).json({
        user_id:  tenantId,
        active:   trim(active),
        rotating: trim(rotating),
        webhook: settingRow ? {
          url:             settingRow.lb_orchestration_webhook_url || null,
          set_at:          settingRow.lb_orchestration_webhook_set_at || null,
          subscription_id: settingRow.lb_orchestration_subscription_id || null,
          state_ref:       settingRow.lb_orchestration_state_ref || null,
        } : null,
        enablement: {
          leadbridge_connected:      !!settingRow?.leadbridge_connected,
          lb_orchestration_enabled_at: settingRow?.lb_orchestration_enabled_at || null,
          connection_state_enabled:  connStateEnabled,
          env_override:              envOverride,
          env_negative_override:     envHasNegative,
          effective,
        },
      });
    } catch (err) {
      try { logger.error(`[orch-admin] status threw: ${err && err.message}`); } catch (_) {}
      return res.status(500).json({ error: 'internal_error' });
    }
  });

  // ─────────────────────────────────────────────────────────────────
  // S3B — Tenant enablement state mutation
  // ─────────────────────────────────────────────────────────────────

  // POST /enable
  // body: { user_id, set_webhook_placeholder? }
  //
  // Opens the layered-enablement gate. Sets leadbridge_connected=true
  // and lb_orchestration_enabled_at=now() on the tenant's
  // communication_settings row. Requires an existing ACTIVE credential
  // (we do NOT mint here — the operator must mint via
  // POST /credentials/mint first). The communication_settings row must
  // exist; this endpoint refuses to auto-create it.
  //
  // Does NOT register a webhook, does NOT call LB, does NOT emit any
  // outbound event. The webhook plumbing belongs to S4.
  router.post('/enable', ...gate, async (req, res) => {
    const userId = req.body?.user_id;
    if (!isPositiveInteger(userId)) {
      return res.status(400).json({ error: 'user_id must be a positive integer' });
    }
    const tenantId = Number(userId);

    try {
      // Require an existing active credential.
      const { data: activeCreds, error: credErr } = await supabase
        .from(TABLE)
        .select('id,status')
        .eq('user_id', tenantId)
        .eq('status', 'active');

      if (credErr) {
        try { logger.error(`[orch-admin] enable cred lookup failed: ${credErr.message}`); } catch (_) {}
        return res.status(503).json({ error: 'service_unavailable' });
      }
      if (!Array.isArray(activeCreds) || activeCreds.length === 0) {
        return res.status(400).json({ error: 'no_active_credential', message: 'Mint a credential via POST /credentials/mint before enabling the tenant.' });
      }

      // Communication settings row must exist.
      const { data: settingRow, error: settingErr } = await supabase
        .from('communication_settings')
        .select('user_id,leadbridge_connected,lb_orchestration_enabled_at')
        .eq('user_id', tenantId)
        .maybeSingle();

      if (settingErr) {
        try { logger.error(`[orch-admin] enable setting lookup failed: ${settingErr.message}`); } catch (_) {}
        return res.status(503).json({ error: 'service_unavailable' });
      }
      if (!settingRow) {
        return res.status(404).json({ error: 'communication_settings_not_found', message: 'No communication_settings row for this tenant. Auto-create not supported here.' });
      }

      const nowIso = new Date().toISOString();
      const { data: updated, error: updateErr } = await supabase
        .from('communication_settings')
        .update({
          leadbridge_connected:        true,
          leadbridge_connected_at:     settingRow.leadbridge_connected_at || nowIso,
          lb_orchestration_enabled_at: nowIso,
        })
        .eq('user_id', tenantId)
        .select('user_id,leadbridge_connected,lb_orchestration_enabled_at,leadbridge_connected_at')
        .maybeSingle();

      if (updateErr) {
        try { logger.error(`[orch-admin] enable update failed: ${updateErr.message}`); } catch (_) {}
        return res.status(503).json({ error: 'service_unavailable' });
      }

      try { logger.log(`[orch-admin] enable ok user=${tenantId} enabled_at=${nowIso}`); } catch (_) {}
      return res.status(200).json({
        user_id:                       tenantId,
        leadbridge_connected:          updated?.leadbridge_connected ?? true,
        lb_orchestration_enabled_at:   updated?.lb_orchestration_enabled_at ?? nowIso,
        active_credential_count:       activeCreds.length,
      });
    } catch (err) {
      try { logger.error(`[orch-admin] enable threw: ${err && err.message}`); } catch (_) {}
      return res.status(500).json({ error: 'internal_error' });
    }
  });

  // POST /disable
  // body: { user_id, reason? }
  //
  // Closes the layered-enablement gate AND revokes all live credentials
  // for the tenant atomically (from the operator's POV — two writes
  // back-to-back, but both must succeed before we return 200; if the
  // credential revoke fails after the gate has already closed, that is
  // SAFE because either side closing is enough to deny new requests).
  //
  // Mirror of enable. Sets leadbridge_connected=false and
  // lb_orchestration_enabled_at=NULL. Revokes active + rotating
  // credentials via revokeCredential (which preserves audit trail —
  // rows become status='revoked', not deleted).
  router.post('/disable', ...gate, async (req, res) => {
    const userId = req.body?.user_id;
    const reason = req.body?.reason || 'admin_disable';
    if (!isPositiveInteger(userId)) {
      return res.status(400).json({ error: 'user_id must be a positive integer' });
    }
    const tenantId = Number(userId);

    try {
      // Step 1 — revoke credentials first. If this fails, the gate is
      // still open via communication_settings; we return 5xx so the
      // operator retries. If this succeeds, the gate is already closed
      // by virtue of zero live credentials.
      const revoke = await revokeCredential(supabase, { userId: tenantId, reason });
      if (!revoke.ok) {
        try { logger.error(`[orch-admin] disable revoke failed user=${tenantId} reason=${revoke.reason}`); } catch (_) {}
        return res.status(503).json({ error: 'service_unavailable', step: 'revoke' });
      }

      // Step 2 — clear enablement state. We do NOT clear webhook fields
      // here (S3B does not touch webhook state). S4 disconnect will
      // clear those plus emit a connection.revoked event.
      const { error: updateErr } = await supabase
        .from('communication_settings')
        .update({
          leadbridge_connected:        false,
          lb_orchestration_enabled_at: null,
        })
        .eq('user_id', tenantId);

      if (updateErr) {
        try { logger.error(`[orch-admin] disable update failed user=${tenantId}: ${updateErr.message}`); } catch (_) {}
        // Credentials are still revoked — gate IS closed via the credential side.
        // Report partial success so the operator can investigate.
        return res.status(503).json({
          error:           'service_unavailable',
          step:            'update_settings',
          revoked_count:   revoke.revokedCount,
          revoked_ids:     revoke.revokedIds,
          note:            'Credentials revoked; communication_settings update failed. Gate is still closed via credential revocation.',
        });
      }

      try { logger.log(`[orch-admin] disable ok user=${tenantId} revoked=${revoke.revokedCount}`); } catch (_) {}
      return res.status(200).json({
        user_id:                       tenantId,
        revoked_count:                 revoke.revokedCount,
        revoked_ids:                   revoke.revokedIds,
        leadbridge_connected:          false,
        lb_orchestration_enabled_at:   null,
        reason,
      });
    } catch (err) {
      try { logger.error(`[orch-admin] disable threw: ${err && err.message}`); } catch (_) {}
      return res.status(500).json({ error: 'internal_error' });
    }
  });

  // GET /tenant-status?user_id=N
  //
  // Read-only snapshot of credential + enablement + gate state.
  // Distinct from /credentials/status in framing — this is the
  // tenant-lifecycle view (focused on whether the orchestration gate
  // would let traffic through right now). Returns the same data, just
  // explicitly named for the tenant lifecycle test surface.
  router.get('/tenant-status', ...gate, async (req, res) => {
    const userId = req.query?.user_id;
    if (!isPositiveInteger(userId)) {
      return res.status(400).json({ error: 'user_id query param must be a positive integer' });
    }
    const tenantId = Number(userId);

    try {
      const { data: credRows, error: credErr } = await supabase
        .from(TABLE)
        .select('id,token_prefix,kid,status,issued_at,expires_at,grace_expires_at,last_used_at,revoked_at,revoked_reason')
        .eq('user_id', tenantId);
      if (credErr) {
        try { logger.error(`[orch-admin] tenant-status cred lookup failed: ${credErr.message}`); } catch (_) {}
        return res.status(503).json({ error: 'service_unavailable' });
      }
      const active   = (credRows || []).find((c) => c.status === 'active')   || null;
      const rotating = (credRows || []).find((c) => c.status === 'rotating') || null;
      const revokedCount = (credRows || []).filter((c) => c.status === 'revoked').length;

      const { data: settingRow, error: settingErr } = await supabase
        .from('communication_settings')
        .select('leadbridge_connected,leadbridge_connected_at,lb_orchestration_enabled_at,lb_orchestration_webhook_url,lb_orchestration_webhook_set_at,lb_orchestration_subscription_id,lb_orchestration_state_ref')
        .eq('user_id', tenantId)
        .maybeSingle();
      if (settingErr) {
        try { logger.error(`[orch-admin] tenant-status setting lookup failed: ${settingErr.message}`); } catch (_) {}
        return res.status(503).json({ error: 'service_unavailable' });
      }

      const envRaw = (process.env.LB_ORCHESTRATION_ENABLED_TENANTS || '').trim();
      const envParts = envRaw.split(',').map((s) => s.trim()).filter(Boolean);
      const envHasStar = envParts.includes('*');
      const envHasPositive = envHasStar || envParts.includes(String(tenantId)) || envParts.includes('+' + tenantId);
      const envHasNegative = envParts.includes('-' + tenantId);

      const nowMs = Date.now();
      const rotatingInGrace = !!(rotating && rotating.grace_expires_at && Date.parse(rotating.grace_expires_at) > nowMs);

      const connStateEnabled = !!(settingRow
        && settingRow.leadbridge_connected === true
        && settingRow.lb_orchestration_enabled_at
        && (active || rotatingInGrace));

      const effective = envHasNegative ? false : (envHasPositive || connStateEnabled);

      function trim(c) {
        if (!c) return null;
        return {
          id: c.id, token_prefix: c.token_prefix, kid: c.kid, status: c.status,
          issued_at: c.issued_at, expires_at: c.expires_at,
          grace_expires_at: c.grace_expires_at,
          last_used_at: c.last_used_at,
          revoked_at: c.revoked_at, revoked_reason: c.revoked_reason,
        };
      }

      return res.status(200).json({
        user_id: tenantId,
        credentials: {
          active:        trim(active),
          rotating:      trim(rotating),
          rotating_in_grace: rotatingInGrace,
          revoked_count: revokedCount,
          total_count:   (credRows || []).length,
        },
        enablement: {
          leadbridge_connected:        !!settingRow?.leadbridge_connected,
          leadbridge_connected_at:     settingRow?.leadbridge_connected_at || null,
          lb_orchestration_enabled_at: settingRow?.lb_orchestration_enabled_at || null,
          connection_state_enabled:    connStateEnabled,
          env_override:                envHasNegative ? false : envHasPositive,
          env_negative_override:       envHasNegative,
          effective,
        },
        webhook: {
          configured:      !!(settingRow?.lb_orchestration_webhook_url),
          set_at:          settingRow?.lb_orchestration_webhook_set_at || null,
          subscription_id: settingRow?.lb_orchestration_subscription_id || null,
          state_ref:       settingRow?.lb_orchestration_state_ref || null,
        },
      });
    } catch (err) {
      try { logger.error(`[orch-admin] tenant-status threw: ${err && err.message}`); } catch (_) {}
      return res.status(500).json({ error: 'internal_error' });
    }
  });

  return router;
}

module.exports = {
  makeAdminCredentialRouter,
};
