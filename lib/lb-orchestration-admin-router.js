'use strict';

// S3A — Internal/admin-only orchestration credential lifecycle endpoints.
//
// These endpoints are NOT the OAuth/connect flow. They are an isolated,
// admin-protected surface used to validate the credential primitives in
// staging end-to-end before the OAuth handshake is built.
//
// All endpoints live under:
//   /api/internal/lb-orchestration/credentials/...
//
// Each route is double-gated:
//   1. authenticateAdmin       — JWT with admin:true claim required
//   2. requireAdminFlag(ENABLE_ADMIN_ORCH_CREDENTIALS) — env kill switch,
//      defaults OFF in every environment
//
// Hard rules:
//   - No tenant self-service. Callers must hold an admin JWT.
//   - No automatic provisioning. Each call is operator-initiated.
//   - No webhook side effects (no SF → LB POSTs from these handlers).
//   - No connect/disconnect changes. These do not flip
//     communication_settings.leadbridge_connected or lb_orchestration_enabled_at.
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

  return router;
}

module.exports = {
  makeAdminCredentialRouter,
};
