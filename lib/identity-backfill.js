'use strict';

// Phase E — Identity backfill runner.
//
// Walks existing data in three phases and populates the unified identity model
// with the STRICT merge discipline: external_id OR (phone + strong name).
// Never merges on phone alone. Never merges on weak name match.
//
// Phases:
//   0. Normalized-name fill — compute normalized_name + name_token_set on
//      identities / leads / customers so the resolver's phone+name lookups
//      actually hit the index.
//   1. OpenPhone mappings — for each row in communication_participant_mappings,
//      call resolveIdentity(strict, source:'openphone') and write identity_id.
//   2. Zenbooker customers — for each customers row with zenbooker_id not null
//      and no linked identity, call resolveIdentity(strict, source:'zenbooker')
//      and link identity.sf_customer_id.

const { normalize } = require('./name-normalize');
const { resolveIdentity } = require('./identity-resolver');

const PAGE = 500;

function makeCounts(phaseName) {
  return {
    phase: phaseName,
    scanned: 0,
    merged_by_external_id: 0,
    merged_by_phone_name: 0,
    created_new: 0,
    skipped_ambiguous: 0,
    skipped_no_identity_fields: 0,
    errors: 0,
  };
}

// ── Phase 0 ─────────────────────────────────────────────────────────────
// Compute normalized_name + name_token_set on identities / leads / customers.

async function fillNormalizedNamesIdentities(supabase, userId, { apply, progress }) {
  const counts = { phase: 'normalize_identities', scanned: 0, updated: 0, skipped_no_name: 0 };
  let offset = 0;
  while (true) {
    const { data } = await supabase.from('communication_participant_identities')
      .select('id, display_name, normalized_name')
      .eq('user_id', userId).is('normalized_name', null)
      .range(offset, offset + PAGE - 1);
    if (!data || data.length === 0) break;
    for (const row of data) {
      counts.scanned++;
      const { normalized_name, name_token_set } = normalize(row.display_name);
      if (!normalized_name) { counts.skipped_no_name++; continue; }
      if (apply) {
        await supabase.from('communication_participant_identities')
          .update({ normalized_name, name_token_set })
          .eq('id', row.id);
      }
      counts.updated++;
    }
    if (progress) progress.normalize_identities = { ...counts };
    if (data.length < PAGE) break;
    offset += PAGE;
  }
  return counts;
}

async function fillNormalizedNamesCRM(supabase, userId, table, nameCols, { apply, progress }) {
  const counts = { phase: `normalize_${table}`, scanned: 0, updated: 0, skipped_no_name: 0 };
  let offset = 0;
  while (true) {
    const selectCols = ['id', 'normalized_name', ...nameCols].join(', ');
    const { data } = await supabase.from(table)
      .select(selectCols)
      .eq('user_id', userId).is('normalized_name', null)
      .range(offset, offset + PAGE - 1);
    if (!data || data.length === 0) break;
    for (const row of data) {
      counts.scanned++;
      const raw = nameCols.map(c => row[c]).filter(Boolean).join(' ').trim();
      const { normalized_name, name_token_set } = normalize(raw);
      if (!normalized_name) { counts.skipped_no_name++; continue; }
      if (apply) {
        await supabase.from(table)
          .update({ normalized_name, name_token_set })
          .eq('id', row.id);
      }
      counts.updated++;
    }
    if (progress) progress[`normalize_${table}`] = { ...counts };
    if (data.length < PAGE) break;
    offset += PAGE;
  }
  return counts;
}

// ── Phase 1 ─────────────────────────────────────────────────────────────
// Link communication_participant_mappings → communication_participant_identities.
// Each mapping row represents an OpenPhone/Sigcore participant.

function mappingToResolverInput(userId, mapping, convName) {
  const phone = mapping.participant_phone_e164 || null;
  const displayName = convName || null;
  return {
    userId,
    source: 'openphone',
    strict: true,
    externalId: mapping.provider_contact_id || null,
    sigcoreParticipantId: mapping.sigcore_participant_id || null,
    sigcoreParticipantKey: mapping.sigcore_participant_key || null,
    phone,
    displayName,
  };
}

async function backfillMappings(supabase, userId, { apply, progress }) {
  const counts = makeCounts('backfill_mappings');
  let offset = 0;

  while (true) {
    const { data } = await supabase.from('communication_participant_mappings')
      .select('id, provider_contact_id, sigcore_participant_id, sigcore_participant_key, participant_phone_e164, identity_id')
      .eq('tenant_id', userId).is('identity_id', null)
      .range(offset, offset + PAGE - 1);
    if (!data || data.length === 0) break;

    // Pull display names for this chunk via linked conversation (most recent wins)
    const chunkIds = data.map(m => m.id);
    const nameByMapping = {};
    const { data: convs } = await supabase.from('communication_conversations')
      .select('participant_mapping_id, participant_name, last_event_at')
      .in('participant_mapping_id', chunkIds)
      .not('participant_name', 'is', null);
    for (const c of (convs || [])) {
      const n = (c.participant_name || '').trim();
      if (!n) continue;
      const cur = nameByMapping[c.participant_mapping_id];
      if (!cur || c.last_event_at > cur.date) nameByMapping[c.participant_mapping_id] = { name: n, date: c.last_event_at };
    }

    for (const m of data) {
      counts.scanned++;
      if (!m.sigcore_participant_id && !m.sigcore_participant_key && !m.provider_contact_id) {
        counts.skipped_no_identity_fields++;
        continue;
      }
      const name = nameByMapping[m.id]?.name || null;
      try {
        const input = { ...mappingToResolverInput(userId, m, name), dryRun: !apply };
        const res = await resolveIdentity(supabase, input);
        if (res.status === 'ambiguous') { counts.skipped_ambiguous++; continue; }
        if (res.status !== 'matched') { counts.errors++; continue; }
        if (res.createdFloating) counts.created_new++;
        else if (res.matchStep === 'external_id') counts.merged_by_external_id++;
        else counts.merged_by_phone_name++;
        if (apply && res.identity?.id) {
          await supabase.from('communication_participant_mappings')
            .update({ identity_id: res.identity.id })
            .eq('id', m.id);
        }
      } catch (_) {
        counts.errors++;
      }
    }

    if (progress) progress.backfill_mappings = { ...counts };
    if (data.length < PAGE) break;
    offset += PAGE;
  }

  return counts;
}

// ── Phase 2 ─────────────────────────────────────────────────────────────
// Link customers where zenbooker_id IS NOT NULL and no identity yet.

async function backfillZenbookerCustomers(supabase, userId, { apply, progress }) {
  const counts = makeCounts('backfill_zenbooker_customers');
  let offset = 0;

  while (true) {
    // Customers with ZB id but no identity pointing to them.
    const { data: custs } = await supabase.from('customers')
      .select('id, zenbooker_id, phone, email, first_name, last_name')
      .eq('user_id', userId).not('zenbooker_id', 'is', null)
      .range(offset, offset + PAGE - 1);
    if (!custs || custs.length === 0) break;

    // Filter out customers whose zenbooker_id already points to an identity.
    const custIds = custs.map(c => c.id);
    const { data: linked } = await supabase.from('communication_participant_identities')
      .select('sf_customer_id, zenbooker_customer_id')
      .eq('user_id', userId)
      .in('sf_customer_id', custIds);
    const alreadyLinkedCustomerIds = new Set((linked || []).map(l => l.sf_customer_id).filter(Boolean));

    for (const c of custs) {
      counts.scanned++;
      if (alreadyLinkedCustomerIds.has(c.id)) {
        counts.skipped_no_identity_fields++; // bucket for "already linked, no work"
        continue;
      }
      const fullName = [c.first_name, c.last_name].filter(Boolean).join(' ').trim() || null;
      const input = {
        userId,
        source: 'zenbooker',
        strict: true,
        dryRun: !apply,
        externalId: c.zenbooker_id,
        phone: c.phone || null,
        email: c.email || null,
        displayName: fullName,
      };
      try {
        const res = await resolveIdentity(supabase, input);
        if (res.status === 'ambiguous') { counts.skipped_ambiguous++; continue; }
        if (res.status !== 'matched') { counts.errors++; continue; }
        if (res.createdFloating) counts.created_new++;
        else if (res.matchStep === 'external_id') counts.merged_by_external_id++;
        else counts.merged_by_phone_name++;
        if (apply && res.identity?.id && res.identity.sf_customer_id !== c.id) {
          const newStatus = res.identity.sf_lead_id ? 'resolved_both' : 'resolved_customer';
          await supabase.from('communication_participant_identities')
            .update({ sf_customer_id: c.id, status: newStatus, updated_at: new Date().toISOString() })
            .eq('id', res.identity.id);
        }
      } catch (_) {
        counts.errors++;
      }
    }

    if (progress) progress.backfill_zenbooker_customers = { ...counts };
    if (custs.length < PAGE) break;
    offset += PAGE;
  }

  return counts;
}

// ── Orchestrator ────────────────────────────────────────────────────────

async function runIdentityBackfill(supabase, userId, { apply = false, progress = null } = {}) {
  const summary = { apply, started_at: new Date().toISOString() };

  if (progress) progress.phase = 'normalize_identities';
  summary.normalize_identities = await fillNormalizedNamesIdentities(supabase, userId, { apply, progress });

  if (progress) progress.phase = 'normalize_leads';
  summary.normalize_leads = await fillNormalizedNamesCRM(supabase, userId, 'leads', ['first_name', 'last_name'], { apply, progress });

  if (progress) progress.phase = 'normalize_customers';
  summary.normalize_customers = await fillNormalizedNamesCRM(supabase, userId, 'customers', ['first_name', 'last_name'], { apply, progress });

  if (progress) progress.phase = 'backfill_mappings';
  summary.backfill_mappings = await backfillMappings(supabase, userId, { apply, progress });

  if (progress) progress.phase = 'backfill_zenbooker_customers';
  summary.backfill_zenbooker_customers = await backfillZenbookerCustomers(supabase, userId, { apply, progress });

  summary.finished_at = new Date().toISOString();
  if (progress) progress.phase = 'done';
  return summary;
}

module.exports = {
  runIdentityBackfill,
  fillNormalizedNamesIdentities,
  fillNormalizedNamesCRM,
  backfillMappings,
  backfillZenbookerCustomers,
  mappingToResolverInput,
};
