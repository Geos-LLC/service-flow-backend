/**
 * AES-256-GCM token encryption for connected email OAuth tokens.
 *
 * Key source: process.env.CONNECTED_EMAIL_TOKEN_KEY
 *   - Must be 32 bytes, base64-encoded (44 chars).
 *   - Generate with: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
 *
 * Storage format: ciphertext + iv + auth_tag stored as separate bytea columns.
 * Future-safe: token_key_version column supports future key rotation.
 */

const crypto = require('crypto')

const ALGO = 'aes-256-gcm'
const IV_LEN = 12    // 96-bit nonce (GCM recommended)
const TAG_LEN = 16   // 128-bit auth tag

function getKey() {
  const k = process.env.CONNECTED_EMAIL_TOKEN_KEY
  if (!k) {
    throw new Error('CONNECTED_EMAIL_TOKEN_KEY env var is required for connected email')
  }
  const buf = Buffer.from(k, 'base64')
  if (buf.length !== 32) {
    throw new Error('CONNECTED_EMAIL_TOKEN_KEY must decode to 32 bytes')
  }
  return buf
}

/**
 * Encrypt a plaintext string. Returns base64 strings — safe to store in
 * text columns via supabase-js (which JSON-serializes Buffer values in a
 * way that breaks bytea columns).
 */
function encrypt(plaintext) {
  if (plaintext == null || plaintext === '') {
    return { ciphertext: null, iv: null, authTag: null }
  }
  const iv = crypto.randomBytes(IV_LEN)
  const cipher = crypto.createCipheriv(ALGO, getKey(), iv)
  const ct = Buffer.concat([
    cipher.update(String(plaintext), 'utf8'),
    cipher.final(),
  ])
  const authTag = cipher.getAuthTag()
  return {
    ciphertext: ct.toString('base64'),
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
  }
}

/**
 * Decrypt. Accepts base64 strings (current) OR Buffers (legacy bytea reads)
 * OR the broken {type:'Buffer',data:[...]} shape for defense-in-depth.
 */
function toBuffer(v) {
  if (v == null) return null
  if (Buffer.isBuffer(v)) return v
  if (typeof v === 'string') return Buffer.from(v, 'base64')
  if (v.type === 'Buffer' && Array.isArray(v.data)) return Buffer.from(v.data)
  return null
}

function decrypt(ciphertext, iv, authTag) {
  const cbuf = toBuffer(ciphertext)
  const ivbuf = toBuffer(iv)
  const tagbuf = toBuffer(authTag)
  if (!cbuf || !ivbuf || !tagbuf) return null
  if (ivbuf.length !== IV_LEN || tagbuf.length !== TAG_LEN) {
    throw new Error('token crypto: iv/authTag length mismatch (stored format invalid)')
  }
  const decipher = crypto.createDecipheriv(ALGO, getKey(), ivbuf)
  decipher.setAuthTag(tagbuf)
  const out = Buffer.concat([decipher.update(cbuf), decipher.final()])
  return out.toString('utf8')
}

/** Check key is configured without throwing from module import. */
function isConfigured() {
  try { getKey(); return true } catch { return false }
}

module.exports = { encrypt, decrypt, isConfigured }
