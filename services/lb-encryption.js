/**
 * LeadBridge outbound secret encryption (AES-256-GCM)
 *
 * The HMAC secret LB returns at /subscribe time is sensitive — it
 * lets anyone signing with it impersonate SF. It must never sit in
 * plaintext at rest or appear in any log.
 *
 * Key: SF_INTEGRATION_ENC_KEY env var (32 bytes, base64 or hex).
 * Falls back to a derived key from JWT_SECRET in dev only — with a
 * clear warning — so tests and local dev don't need extra setup.
 *
 * Rotation: bump SF_INTEGRATION_ENC_KEY_VERSION and re-run the
 * connect flow for affected users. The version is stored on the
 * row so decrypt knows which master key was used.
 */

const crypto = require('crypto')

const ALGO = 'aes-256-gcm'
const IV_LEN = 12          // GCM recommended
const TAG_LEN = 16
const CURRENT_VERSION = parseInt(process.env.SF_INTEGRATION_ENC_KEY_VERSION || '1', 10)

function currentEncKeyVersion() {
  return CURRENT_VERSION
}

function resolveMasterKey(version = CURRENT_VERSION) {
  // In the single-version common case, SF_INTEGRATION_ENC_KEY is the key.
  // Future rotation: read SF_INTEGRATION_ENC_KEY_V<n> for older versions.
  const raw = version === CURRENT_VERSION
    ? process.env.SF_INTEGRATION_ENC_KEY
    : process.env[`SF_INTEGRATION_ENC_KEY_V${version}`]

  if (raw) {
    // Accept base64 or hex or raw utf8 (if exactly 32 bytes)
    let buf
    try {
      buf = Buffer.from(raw, 'base64')
      if (buf.length === 32) return buf
    } catch { /* ignore */ }
    try {
      buf = Buffer.from(raw, 'hex')
      if (buf.length === 32) return buf
    } catch { /* ignore */ }
    buf = Buffer.from(raw, 'utf8')
    if (buf.length === 32) return buf
    // Otherwise derive via SHA-256 — deterministic stretch to 32 bytes.
    return crypto.createHash('sha256').update(buf).digest()
  }

  // Dev fallback — never used in prod unless someone forgot to set the env.
  // Log once per process so it's visible but not spammy.
  if (!resolveMasterKey._warned) {
    console.warn('[lb-encryption] SF_INTEGRATION_ENC_KEY not set — deriving key from JWT_SECRET. Set a dedicated 32-byte key before production use.')
    resolveMasterKey._warned = true
  }
  const seed = process.env.JWT_SECRET || 'dev-only-encryption-fallback-not-for-prod'
  return crypto.createHash('sha256').update(`lb-outbound:${seed}`).digest()
}

function encryptIntegrationSecret(plaintext, version = CURRENT_VERSION) {
  if (typeof plaintext !== 'string' || plaintext.length === 0) {
    throw new Error('encryptIntegrationSecret: plaintext required')
  }
  const key = resolveMasterKey(version)
  const iv = crypto.randomBytes(IV_LEN)
  const cipher = crypto.createCipheriv(ALGO, key, iv)
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  // v1:<iv_b64>:<tag_b64>:<ciphertext_b64>
  return `v${version}:${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`
}

function decryptIntegrationSecret(stored, storedVersion) {
  if (typeof stored !== 'string' || stored.length === 0) {
    throw new Error('decryptIntegrationSecret: stored value required')
  }
  const parts = stored.split(':')
  if (parts.length !== 4 || !parts[0].startsWith('v')) {
    throw new Error('decryptIntegrationSecret: malformed payload')
  }
  const version = storedVersion || parseInt(parts[0].slice(1), 10) || CURRENT_VERSION
  const iv = Buffer.from(parts[1], 'base64')
  const tag = Buffer.from(parts[2], 'base64')
  const ct = Buffer.from(parts[3], 'base64')
  if (iv.length !== IV_LEN || tag.length !== TAG_LEN) {
    throw new Error('decryptIntegrationSecret: bad iv/tag length')
  }
  const key = resolveMasterKey(version)
  const decipher = crypto.createDecipheriv(ALGO, key, iv)
  decipher.setAuthTag(tag)
  const dec = Buffer.concat([decipher.update(ct), decipher.final()])
  return dec.toString('utf8')
}

module.exports = {
  encryptIntegrationSecret,
  decryptIntegrationSecret,
  currentEncKeyVersion,
}
