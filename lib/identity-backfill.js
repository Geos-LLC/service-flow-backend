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

const { normalize, normalizePhone } = require('./name-normalize');
const { resolveIdentity } = require('./identity-resolver');

const PAGE = 500;

function makeCounts(phaseName) {
  return {
    phase: phaseName,
    total: 0,
    scanned: 0,
    merged_by_external_id: 0,
    merged_by_phone_name: 0,
    created_new: 0,
    skipped_ambiguous: 0,
    skipped_no_identity_fields: 0,
    errors: 0,
  };
}

// Count rows matching a Phase 0 / 1 / 2 filter without fetching them — for
// the progress total. Uses supabase head: true so no rows are transferred.
async function countIdentitiesToNormalize(supabase, userId) {
  const { count } = await supabase.from('communication_participant_identities')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId);
  return count || 0;
}

async function countCRMToNormalize(supabase, userId, table) {
  const { count } = await supabase.from(table)
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId);
  return count || 0;
}

async function countUnlinkedMappings(supabase, userId) {
  const { count } = await supabase.from('communication_participant_mappings')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', userId).is('identity_id', null);
  return count || 0;
}

async function countZenbookerCustomers(supabase, userId) {
  const { count } = await supabase.from('customers')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId).not('zenbooker_id', 'is', null);
  return count || 0;
}

// ── Phase 0 ─────────────────────────────────────────────────────────────
// Compute normalized_name + name_token_set on identities / leads / customers.

// Phase 0 — normalization is deterministic + non-destructive (fills nulls on
// computed columns). It ALWAYS writes, regardless of apply flag. Phase 1/2's
// phone+name matching depends on candidates having normalized_name populated;
// gating Phase 0 behind apply would make dry-run results wildly wrong.
// The `apply` parameter is kept on the signature for future use but is not
// consulted here.
// Canonicalize normalized_phone to last-10-digit form. LB's legacy code
// wrote +1XXXXXXXXXX; the resolver queries by last-10. Running through
// normalizePhone() unifies the format (idempotent: last-10 stays last-10).
function canonicalPhone(raw) {
  return normalizePhone(raw); // returns last-10 digits or null
}

async function fillNormalizedNamesIdentities(supabase, userId, { progress } = {}) {
  const counts = {
    phase: 'normalize_identities',
    total: await countIdentitiesToNormalize(supabase, userId),
    scanned: 0, updated: 0, skipped_no_name: 0, phone_renormalized: 0,
  };
  if (progress) progress.normalize_identities = { ...counts };
  // Id-based pagination — handles both the "normalized_name IS NULL" path
  // (filter shrinks as we write) and the "phone needs renormalization" path
  // (we may update identity rows whose normalized_name was already set).
  let lastId = 0;
  while (true) {
    const { data } = await supabase.from('communication_participant_identities')
      .select('id, display_name, normalized_name, name_token_set, normalized_phone')
      .eq('user_id', userId)
      .gt('id', lastId)
      .order('id', { ascending: true })
      .limit(PAGE);
    if (!data || data.length === 0) break;
    for (const row of data) {
      counts.scanned++;
      const patch = {};
      if (!row.normalized_name) {
        const { normalized_name, name_token_set } = normalize(row.display_name);
        if (!normalized_name) {
          counts.skipped_no_name++;
        } else {
          patch.normalized_name = normalized_name;
          patch.name_token_set = name_token_set;
        }
      }
      // Canonicalize phone format — in-place where possible.
      if (row.normalized_phone) {
        const canon = canonicalPhone(row.normalized_phone);
        if (canon && canon !== row.normalized_phone) {
          patch.normalized_phone = canon;
          counts.phone_renormalized++;
        }
      }
      if (Object.keys(patch).length > 0) {
        await supabase.from('communication_participant_identities')
          .update(patch).eq('id', row.id);
        if (patch.normalized_name) counts.updated++;
      }
    }
    if (progress) progress.normalize_identities = { ...counts };
    lastId = data[data.length - 1].id;
    if (data.length < PAGE) break;
  }
  return counts;
}

async function fillNormalizedNamesCRM(supabase, userId, table, nameCols, { progress } = {}) {
  const counts = {
    phase: `normalize_${table}`,
    total: await countCRMToNormalize(supabase, userId, table),
    scanned: 0, updated: 0, skipped_no_name: 0,
  };
  if (progress) progress[`normalize_${table}`] = { ...counts };
  while (true) {
    const selectCols = ['id', 'normalized_name', ...nameCols].join(', ');
    const { data } = await supabase.from(table)
      .select(selectCols)
      .eq('user_id', userId).is('normalized_name', null)
      .limit(PAGE);
    if (!data || data.length === 0) break;
    let wroteAny = false;
    for (const row of data) {
      counts.scanned++;
      const raw = nameCols.map(c => row[c]).filter(Boolean).join(' ').trim();
      const { normalized_name, name_token_set } = normalize(raw);
      if (!normalized_name) { counts.skipped_no_name++; continue; }
      await supabase.from(table)
        .update({ normalized_name, name_token_set })
        .eq('id', row.id);
      counts.updated++;
      wroteAny = true;
    }
    if (progress) progress[`normalize_${table}`] = { ...counts };
    if (!wroteAny) break;
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
  counts.total = await countUnlinkedMappings(supabase, userId);
  if (progress) progress.backfill_mappings = { ...counts };
  // ID-based pagination: works for both dry-run (no mutations) and apply
  // (identity_id gets written, so filter shrinks — but id > lastId still
  // advances correctly).
  let lastId = 0;

  while (true) {
    const { data } = await supabase.from('communication_participant_mappings')
      .select('id, provider_contact_id, sigcore_participant_id, sigcore_participant_key, participant_phone_e164, identity_id')
      .eq('tenant_id', userId).is('identity_id', null)
      .gt('id', lastId)
      .order('id', { ascending: true })
      .limit(PAGE);
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
      // Live progress — emit every 25 rows so the UI bar moves smoothly
      // rather than jumping by 500 each page.
      if (progress && counts.scanned % 25 === 0) progress.backfill_mappings = { ...counts };
    }

    if (progress) progress.backfill_mappings = { ...counts };
    lastId = data[data.length - 1].id;
    if (data.length < PAGE) break;
  }

  return counts;
}

// ── Phase 2 ─────────────────────────────────────────────────────────────
// Link customers where zenbooker_id IS NOT NULL and no identity yet.

async function backfillZenbookerCustomers(supabase, userId, { apply, progress }) {
  const counts = makeCounts('backfill_zenbooker_customers');
  counts.total = await countZenbookerCustomers(supabase, userId);
  if (progress) progress.backfill_zenbooker_customers = { ...counts };
  let lastId = 0;

  while (true) {
    // Customers with ZB id, paginated by id ascending. In apply mode we may
    // set identity.sf_customer_id but that doesn't change the customers
    // query, so either pagination style works — standardizing on id-based
    // for consistency with backfillMappings.
    const { data: custs } = await supabase.from('customers')
      .select('id, zenbooker_id, phone, email, first_name, last_name')
      .eq('user_id', userId).not('zenbooker_id', 'is', null)
      .gt('id', lastId)
      .order('id', { ascending: true })
      .limit(PAGE);
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
      if (progress && counts.scanned % 25 === 0) progress.backfill_zenbooker_customers = { ...counts };
    }

    if (progress) progress.backfill_zenbooker_customers = { ...counts };
    lastId = custs[custs.length - 1].id;
    if (custs.length < PAGE) break;
  }

  return counts;
}

// ── Orchestrator ────────────────────────────────────────────────────────

async function runIdentityBackfill(supabase, userId, { apply = false, progress = null } = {}) {
  const summary = { apply, started_at: new Date().toISOString() };

  // Phase 0 — normalization always writes (safe, deterministic, non-destructive).
  if (progress) progress.phase = 'normalize_identities';
  summary.normalize_identities = await fillNormalizedNamesIdentities(supabase, userId, { progress });

  if (progress) progress.phase = 'normalize_leads';
  summary.normalize_leads = await fillNormalizedNamesCRM(supabase, userId, 'leads', ['first_name', 'last_name'], { progress });

  if (progress) progress.phase = 'normalize_customers';
  summary.normalize_customers = await fillNormalizedNamesCRM(supabase, userId, 'customers', ['first_name', 'last_name'], { progress });

  // Phase 1/2 — identity creation + CRM linking are gated by `apply`.
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
