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

function encrypt(plaintext) {
  if (plaintext == null || plaintext === '') {
    return { ciphertext: null, iv: null, authTag: null }
  }
  const iv = crypto.randomBytes(IV_LEN)
  const cipher = crypto.createCipheriv(ALGO, getKey(), iv)
  const ciphertext = Buffer.concat([
    cipher.update(String(plaintext), 'utf8'),
    cipher.final(),
  ])
  const authTag = cipher.getAuthTag()
  return { ciphertext, iv, authTag }
}

function decrypt(ciphertext, iv, authTag) {
  if (!ciphertext || !iv || !authTag) return null
  const cbuf = Buffer.isBuffer(ciphertext) ? ciphertext : Buffer.from(ciphertext)
  const ivbuf = Buffer.isBuffer(iv) ? iv : Buffer.from(iv)
  const tagbuf = Buffer.isBuffer(authTag) ? authTag : Buffer.from(authTag)
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
