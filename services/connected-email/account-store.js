/**
 * connected_email_accounts DB access — token encryption/decryption wrapper.
 *
 * Rule: tokens NEVER leave this module in plaintext except inside the sync
 * engine or provider adapter. Public APIs use selectAccountSafe() which strips
 * token columns defensively.
 */

const { encrypt, decrypt } = require('./token-crypto')

const TOKEN_COLUMNS = [
  'access_token_ciphertext', 'access_token_iv', 'access_token_auth_tag',
  'refresh_token_ciphertext', 'refresh_token_iv', 'refresh_token_auth_tag',
]

const SAFE_COLUMNS = [
  'id', 'user_id', 'provider', 'email_address', 'display_name', 'status',
  'token_expires_at', 'initial_sync_completed_at', 'last_sync_at', 'scopes',
  'disconnect_reason', 'created_at', 'updated_at',
  'auth_email_address', 'auth_display_name',
  'target_mailbox_email', 'target_mailbox_display_name', 'mailbox_type',
].join(', ')

function stripTokens(row) {
  if (!row) return row
  const out = { ...row }
  for (const c of TOKEN_COLUMNS) delete out[c]
  return out
}

async function listSafe(supabase, userId) {
  const { data, error } = await supabase
    .from('connected_email_accounts')
    .select(SAFE_COLUMNS)
    .eq('user_id', userId)
    .order('created_at', { ascending: true })
  if (error) throw error
  return data || []
}

async function getSafeById(supabase, userId, id) {
  const { data, error } = await supabase
    .from('connected_email_accounts')
    .select(SAFE_COLUMNS)
    .eq('user_id', userId)
    .eq('id', id)
    .maybeSingle()
  if (error) throw error
  return data || null
}

/** Internal — returns plaintext tokens for sync/send. */
async function getWithTokens(supabase, accountId) {
  const { data, error } = await supabase
    .from('connected_email_accounts')
    .select('*')
    .eq('id', accountId)
    .maybeSingle()
  if (error) throw error
  if (!data) return null
  let accessToken = null, refreshToken = null
  try {
    accessToken = decrypt(data.access_token_ciphertext, data.access_token_iv, data.access_token_auth_tag)
  } catch (e) { /* legacy/corrupt blob — fall through as null */ }
  try {
    refreshToken = decrypt(data.refresh_token_ciphertext, data.refresh_token_iv, data.refresh_token_auth_tag)
  } catch (e) { /* legacy/corrupt blob — fall through as null */ }
  return { ...stripTokens(data), accessToken, refreshToken }
}

async function upsertAccount(supabase, { userId, provider, emailAddress, displayName, tokens, scopes, authEmailAddress, authDisplayName, targetMailboxEmail, mailboxType }) {
  const accessEnc = encrypt(tokens.accessToken)
  const refreshEnc = encrypt(tokens.refreshToken)
  const row = {
    user_id: userId,
    provider,
    email_address: String(emailAddress).toLowerCase(),
    display_name: displayName || null,
    auth_email_address: authEmailAddress ? String(authEmailAddress).toLowerCase() : String(emailAddress).toLowerCase(),
    auth_display_name: authDisplayName || displayName || null,
    target_mailbox_email: targetMailboxEmail ? String(targetMailboxEmail).toLowerCase() : String(emailAddress).toLowerCase(),
    target_mailbox_display_name: null,
    mailbox_type: mailboxType || 'primary',
    status: 'connected',
    access_token_ciphertext: accessEnc.ciphertext,
    access_token_iv: accessEnc.iv,
    access_token_auth_tag: accessEnc.authTag,
    refresh_token_ciphertext: refreshEnc.ciphertext,
    refresh_token_iv: refreshEnc.iv,
    refresh_token_auth_tag: refreshEnc.authTag,
    token_expires_at: tokens.expiresAt || null,
    scopes: scopes || null,
    disconnect_reason: null,
    updated_at: new Date().toISOString(),
  }
  // Supabase-js doesn't do ON CONFLICT via .upsert() for composite unique easily,
  // so try-insert then update on conflict.
  const { data: existing } = await supabase
    .from('connected_email_accounts')
    .select('id')
    .eq('user_id', userId)
    .eq('provider', provider)
    .eq('email_address', row.email_address)
    .maybeSingle()

  if (existing?.id) {
    const { data, error } = await supabase
      .from('connected_email_accounts')
      .update(row)
      .eq('id', existing.id)
      .select(SAFE_COLUMNS)
      .single()
    if (error) throw error
    return data
  }
  const { data, error } = await supabase
    .from('connected_email_accounts')
    .insert(row)
    .select(SAFE_COLUMNS)
    .single()
  if (error) throw error
  return data
}

async function updateTokens(supabase, accountId, tokens) {
  const accessEnc = encrypt(tokens.accessToken)
  const refreshEnc = tokens.refreshToken ? encrypt(tokens.refreshToken) : null
  const patch = {
    access_token_ciphertext: accessEnc.ciphertext,
    access_token_iv: accessEnc.iv,
    access_token_auth_tag: accessEnc.authTag,
    token_expires_at: tokens.expiresAt || null,
    updated_at: new Date().toISOString(),
  }
  if (refreshEnc) {
    patch.refresh_token_ciphertext = refreshEnc.ciphertext
    patch.refresh_token_iv = refreshEnc.iv
    patch.refresh_token_auth_tag = refreshEnc.authTag
  }
  await supabase.from('connected_email_accounts').update(patch).eq('id', accountId)
}

async function markDisconnected(supabase, accountId, reason) {
  await supabase.from('connected_email_accounts')
    .update({
      status: 'disconnected',
      disconnect_reason: reason || null,
      access_token_ciphertext: null,
      access_token_iv: null,
      access_token_auth_tag: null,
      refresh_token_ciphertext: null,
      refresh_token_iv: null,
      refresh_token_auth_tag: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', accountId)
}

async function markError(supabase, accountId, errorMessage) {
  await supabase.from('connected_email_accounts')
    .update({ status: 'error', updated_at: new Date().toISOString() })
    .eq('id', accountId)
  await supabase.from('connected_email_sync_state')
    .upsert({
      account_id: accountId,
      last_error: String(errorMessage).slice(0, 2000),
      last_error_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }, { onConflict: 'account_id' })
}

module.exports = {
  listSafe,
  getSafeById,
  getWithTokens,
  upsertAccount,
  updateTokens,
  markDisconnected,
  markError,
  stripTokens,
  SAFE_COLUMNS,
}
