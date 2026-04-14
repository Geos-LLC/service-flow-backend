/**
 * Email string utilities: canonicalization, RFC 5322 header parsing.
 * Pure functions — no DB, no network.
 */

/**
 * Normalize an email address or "Display Name <addr@example.com>" form.
 * Returns lowercase trimmed address, or null if no valid address found.
 */
function normalizeEmail(raw) {
  if (!raw) return null
  let s = String(raw).trim()
  // Strip display name: "Name <addr>" → "addr"
  const m = s.match(/<([^>]+)>/)
  if (m) s = m[1]
  s = s.trim().toLowerCase()
  // Quick sanity check (not a full RFC validator — canonicalization, not validation)
  if (!/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(s)) return null
  return s
}

/**
 * Parse a header value that may contain multiple addresses ("A, B <b@x>, c@y").
 * Returns array of normalized addresses (may be empty).
 */
function normalizeEmailList(raw) {
  if (!raw) return []
  if (Array.isArray(raw)) {
    return raw.map(normalizeEmail).filter(Boolean)
  }
  // Split on commas outside angle-bracket groups.
  const out = []
  let depth = 0, cur = ''
  for (const ch of String(raw)) {
    if (ch === '<') depth++
    else if (ch === '>') depth--
    if (ch === ',' && depth === 0) {
      const n = normalizeEmail(cur); if (n) out.push(n); cur = ''
    } else cur += ch
  }
  const n = normalizeEmail(cur); if (n) out.push(n)
  return out
}

/**
 * Extract display name from "Name <addr>" — returns raw display name or null.
 */
function parseDisplayName(raw) {
  if (!raw) return null
  const s = String(raw).trim()
  const m = s.match(/^\s*"?([^"<]+?)"?\s*<[^>]+>\s*$/)
  return m ? m[1].trim() : null
}

/**
 * Build In-Reply-To / References headers for replying to a parent message.
 * Returns { inReplyTo, references } both as strings (or null when unavailable).
 */
function buildReplyHeaders({ parentMessageId, parentReferences }) {
  if (!parentMessageId) return { inReplyTo: null, references: null }
  const refs = parentReferences ? String(parentReferences).trim() : ''
  const combined = refs ? `${refs} ${parentMessageId}` : parentMessageId
  return { inReplyTo: parentMessageId, references: combined }
}

/** "Re: subject" unless already prefixed (case-insensitive). */
function makeReplySubject(subject) {
  if (!subject) return 'Re:'
  return /^re:\s/i.test(subject) ? subject : `Re: ${subject}`
}

module.exports = {
  normalizeEmail,
  normalizeEmailList,
  parseDisplayName,
  buildReplyHeaders,
  makeReplySubject,
}
