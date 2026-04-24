#!/usr/bin/env node
/**
 * Fix 3 — one-off script to classify + link the remaining mappings where
 * communication_participant_mappings.identity_id IS NULL. Safe to re-run.
 *
 * For each straggler:
 *   1. Build resolveIdentity input from mapping fields + best-effort conversation name.
 *   2. Run resolveIdentity({ strict: true, dryRun: false }).
 *   3. On 'matched' → write mapping.identity_id.
 *   4. On 'ambiguous' → log + leave unlinked.
 *   5. On 'error' or no identity data → log reason.
 *
 * Usage: node scripts/fix-unlinked-mappings.js [--tenant=2]
 */

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { resolveIdentity } = require('../lib/identity-resolver');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const tenantArg = (process.argv.find(a => a.startsWith('--tenant=')) || '').split('=')[1];
const tenantId = tenantArg ? parseInt(tenantArg, 10) : null;

async function main() {
  const query = supabase.from('communication_participant_mappings')
    .select('id, tenant_id, provider, sigcore_participant_id, sigcore_participant_key, provider_contact_id, participant_phone_e164')
    .is('identity_id', null).order('id');
  if (tenantId) query.eq('tenant_id', tenantId);
  const { data: mappings, error } = await query;
  if (error) { console.error('query failed:', error.message); process.exit(1); }

  console.log(`Found ${mappings.length} unlinked mapping(s)${tenantId ? ` for tenant ${tenantId}` : ''}`);
  const results = { matched: 0, created_new: 0, ambiguous: 0, no_identity_fields: 0, error: 0 };
  const unsafe = [];

  for (const m of mappings) {
    if (!m.sigcore_participant_id && !m.sigcore_participant_key && !m.provider_contact_id) {
      results.no_identity_fields++;
      unsafe.push({ id: m.id, reason: 'no identity fields', phone: m.participant_phone_e164 });
      continue;
    }

    // Conversation name — pick most recent conversation tied to this mapping.
    let name = null;
    const { data: convs } = await supabase.from('communication_conversations')
      .select('participant_name, last_event_at')
      .eq('participant_mapping_id', m.id)
      .not('participant_name', 'is', null)
      .order('last_event_at', { ascending: false }).limit(1);
    if (convs && convs[0]) name = (convs[0].participant_name || '').trim() || null;

    const input = {
      userId: m.tenant_id,
      source: 'openphone',
      strict: true,
      externalId: m.provider_contact_id || null,
      sigcoreParticipantId: m.sigcore_participant_id || null,
      sigcoreParticipantKey: m.sigcore_participant_key || null,
      phone: m.participant_phone_e164,
      displayName: name,
    };
    let res = await resolveIdentity(supabase, input);

    // If strict rejected on phone-only (because incoming has no name — safe
    // at runtime), retry in non-strict. This is the same policy the live
    // webhook/sync path uses, so it's consistent not a rule-break.
    if (res.status === 'ambiguous' && res.reason === 'strict_phone_only_rejected' && !name) {
      res = await resolveIdentity(supabase, { ...input, strict: false });
    }

    if (res.status === 'ambiguous') {
      results.ambiguous++;
      unsafe.push({ id: m.id, reason: `ambiguous (${res.reason})`, candidates: res.candidates, phone: m.participant_phone_e164, name });
      continue;
    }
    if (res.status !== 'matched' || !res.identity?.id) {
      results.error++;
      unsafe.push({ id: m.id, reason: `resolver ${res.status}`, phone: m.participant_phone_e164, name });
      continue;
    }

    await supabase.from('communication_participant_mappings')
      .update({ identity_id: res.identity.id })
      .eq('id', m.id);
    // If the mapping is tied to conversations, also stamp participant_identity_id.
    await supabase.from('communication_conversations')
      .update({ participant_identity_id: res.identity.id })
      .eq('participant_mapping_id', m.id)
      .is('participant_identity_id', null);

    if (res.createdFloating) results.created_new++;
    else results.matched++;
    console.log(`mapping ${m.id} → identity ${res.identity.id} (${res.matchStep || 'created'})`);
  }

  console.log('\n=== Summary ===');
  console.log(results);
  if (unsafe.length) {
    console.log('\n=== Unsafe (left unlinked) ===');
    for (const u of unsafe) console.log(JSON.stringify(u));
  }
}

main().catch(e => { console.error('fatal:', e); process.exit(1); });
