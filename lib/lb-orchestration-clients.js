'use strict';

// S4 — lb_oauth_clients lookup + redirect_uri / webhook validation.
//
// Pure helpers (no DB writes; only reads from supabase). Used by:
//   - GET /authorize  (validates client_id + redirect_uri)
//   - POST /oauth/exchange (validates client_id + client_secret + redirect_uri + webhook)
//   - POST /connect (validates webhook against the manual canary client allowlist)
//
// Hard rules:
//   - Exact redirect_uri match. No wildcards. No prefix matching. Trailing
//     slash significant.
//   - Webhook URL: scheme=https, valid hostname, host suffix-matches one
//     of the client's redirect_host_suffixes. No live DNS resolution
//     (per refinement 3).
//   - Webhook secret: base64url-decoded length ≥ 32 bytes.
//   - Client secret: compared via SHA-256 + timingSafeEqual.

const crypto = require('crypto');

const CLIENTS_TABLE = 'lb_oauth_clients';

/**
 * Look up a client row by id. Returns the row or null. Filters out
 * disabled clients (disabled_at NOT NULL).
 */
async function lookupClient(supabase, clientId) {
  if (!supabase || typeof supabase.from !== 'function') {
    throw new Error('lookupClient: supabase required');
  }
  if (typeof clientId !== 'string' || !clientId) return null;

  const { data, error } = await supabase
    .from(CLIENTS_TABLE)
    .select('client_id,client_secret_hash,display_name,redirect_uris,redirect_host_suffixes,scopes_allowed,disabled_at')
    .eq('client_id', clientId)
    .maybeSingle();

  if (error) {
    throw new Error(`lookupClient: db error ${error.message}`);
  }
  if (!data) return null;
  if (data.disabled_at) return null;
  return data;
}

/**
 * Constant-time comparison of presented client_secret vs stored hash.
 * Stored hash is `sha256(plaintext_secret)` hex-encoded.
 */
function verifyClientSecret(clientRow, presentedSecret) {
  if (!clientRow || typeof clientRow.client_secret_hash !== 'string') return false;
  if (typeof presentedSecret !== 'string' || !presentedSecret) return false;
  const presentedHash = crypto.createHash('sha256').update(presentedSecret, 'utf8').digest('hex');
  const a = Buffer.from(presentedHash, 'hex');
  const b = Buffer.from(clientRow.client_secret_hash, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Exact-match redirect_uri check. Returns true iff `presentedUri`
 * appears verbatim in `clientRow.redirect_uris`.
 */
function verifyRedirectUri(clientRow, presentedUri) {
  if (!clientRow || !Array.isArray(clientRow.redirect_uris)) return false;
  if (typeof presentedUri !== 'string' || !presentedUri) return false;
  return clientRow.redirect_uris.includes(presentedUri);
}

/**
 * Validate that `webhookUrl` is suitable to register against this client.
 * No live DNS resolution (refinement 3). Returns { ok, reason }.
 */
function verifyWebhookUrl(clientRow, webhookUrl) {
  if (!clientRow) return { ok: false, reason: 'unknown_client' };
  if (typeof webhookUrl !== 'string' || !webhookUrl) {
    return { ok: false, reason: 'webhook_url_missing' };
  }
  let parsed;
  try {
    parsed = new URL(webhookUrl);
  } catch (_) {
    return { ok: false, reason: 'webhook_url_unparseable' };
  }
  if (parsed.protocol !== 'https:') {
    return { ok: false, reason: 'webhook_url_not_https' };
  }
  if (!parsed.hostname || parsed.hostname.length === 0) {
    return { ok: false, reason: 'webhook_url_no_host' };
  }
  if (parsed.pathname && parsed.pathname.length > 512) {
    return { ok: false, reason: 'webhook_url_path_too_long' };
  }
  const suffixes = Array.isArray(clientRow.redirect_host_suffixes) ? clientRow.redirect_host_suffixes : [];
  if (suffixes.length === 0) {
    // No suffix restriction configured. Allowed (paranoia: clients should always have one).
    return { ok: true };
  }
  const host = parsed.hostname.toLowerCase();
  for (const suffix of suffixes) {
    if (typeof suffix !== 'string' || !suffix) continue;
    const s = suffix.toLowerCase();
    if (host === s || host.endsWith(s)) return { ok: true };
  }
  return { ok: false, reason: 'webhook_host_not_allowed', host };
}

/**
 * Validate the webhook shared secret presented by LB.
 * Required: base64url (or base64) decodes to ≥ 32 bytes.
 */
function verifyWebhookSecret(presentedSecret) {
  if (typeof presentedSecret !== 'string' || !presentedSecret) {
    return { ok: false, reason: 'webhook_secret_missing' };
  }
  let decoded;
  try {
    // Accept both base64 and base64url.
    const normalized = presentedSecret.replace(/-/g, '+').replace(/_/g, '/');
    decoded = Buffer.from(normalized, 'base64');
  } catch (_) {
    return { ok: false, reason: 'webhook_secret_unparseable' };
  }
  if (decoded.length < 32) {
    return { ok: false, reason: 'webhook_secret_too_short', bytes: decoded.length };
  }
  if (decoded.length > 64) {
    return { ok: false, reason: 'webhook_secret_too_long', bytes: decoded.length };
  }
  return { ok: true };
}

module.exports = {
  CLIENTS_TABLE,
  lookupClient,
  verifyClientSecret,
  verifyRedirectUri,
  verifyWebhookUrl,
  verifyWebhookSecret,
};
