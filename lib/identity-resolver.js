'use strict';

const { normalize, normalizePhone } = require('./name-normalize');
const { getSource, affectsIdentityPriority } = require('./source-registry');

const MAX_RETRIES = 3;

const SOURCE_TO_EXTERNAL_COLUMNS = {
  leadbridge: ['leadbridge_contact_id'],
  openphone: ['openphone_contact_id', 'sigcore_participant_id', 'sigcore_participant_key'],
  zenbooker: ['zenbooker_customer_id'],
  manual_sf: [],
};

const PRIORITY_TAG_BY_SOURCE = {
  leadbridge: 'leadbridge',
  openphone: 'openphone',
  zenbooker: 'sync',
  manual_sf: 'manual',
};

function levenshtein(a, b) {
  if (a === b) return 0;
  const la = a.length;
  const lb = b.length;
  if (!la) return lb;
  if (!lb) return la;
  let prev = new Array(lb + 1);
  for (let j = 0; j <= lb; j++) prev[j] = j;
  for (let i = 1; i <= la; i++) {
    const curr = [i];
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= lb; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = curr;
  }
  return prev[lb];
}

function isTokenSubset(a, b) {
  if (!a || !b) return false;
  const sa = new Set(a.split(' ').filter(Boolean));
  const sb = new Set(b.split(' ').filter(Boolean));
  if (sa.size === 0 || sb.size === 0) return false;
  const [small, big] = sa.size <= sb.size ? [sa, sb] : [sb, sa];
  for (const t of small) if (!big.has(t)) return false;
  return true;
}

function classifyNameMatch(incomingNorm, incomingTokens, candidateNorm, candidateTokens) {
  if (!incomingNorm && !candidateNorm) return 'neither_named';
  if (!incomingNorm || !candidateNorm) return 'one_missing';
  if (incomingNorm === candidateNorm) return 'strong_exact';
  if (incomingTokens === candidateTokens) return 'strong_tokenset';
  const d = levenshtein(incomingNorm, candidateNorm);
  if (d <= 2) return 'strong_leven';
  if (isTokenSubset(incomingTokens, candidateTokens)) return 'weak_subset';
  if (d <= 3) return 'weak_leven';
  return 'conflict';
}

async function findByExternalId(supabase, userId, source, externalId) {
  const cols = SOURCE_TO_EXTERNAL_COLUMNS[source] || [];
  if (!cols.length || !externalId) return null;
  for (const col of cols) {
    const { data } = await supabase.from('communication_participant_identities')
      .select('*').eq('user_id', userId).eq(col, externalId).maybeSingle();
    if (data) return data;
  }
  return null;
}

async function findCandidatesByPhone(supabase, userId, normalizedPhone) {
  if (!normalizedPhone) return [];
  const { data } = await supabase.from('communication_participant_identities')
    .select('*').eq('user_id', userId).eq('normalized_phone', normalizedPhone).limit(20);
  return data || [];
}

async function findCandidatesByEmail(supabase, userId, email) {
  if (!email) return [];
  const { data } = await supabase.from('communication_participant_identities')
    .select('*').eq('user_id', userId).ilike('email', email).limit(20);
  return data || [];
}

async function findByLinkedCrm(supabase, userId, sfLeadId, sfCustomerId) {
  if (sfCustomerId) {
    const { data } = await supabase.from('communication_participant_identities')
      .select('*').eq('user_id', userId).eq('sf_customer_id', sfCustomerId).maybeSingle();
    if (data) return data;
  }
  if (sfLeadId) {
    const { data } = await supabase.from('communication_participant_identities')
      .select('*').eq('user_id', userId).eq('sf_lead_id', sfLeadId).maybeSingle();
    if (data) return data;
  }
  return null;
}

function deriveStatus(identity) {
  const hasC = !!identity.sf_customer_id;
  const hasL = !!identity.sf_lead_id;
  if (hasC && hasL) return 'resolved_both';
  if (hasC) return 'resolved_customer';
  if (hasL) return 'resolved_lead';
  return 'unresolved_floating';
}

function buildEnrichPatch(existing, input, source) {
  const patch = { updated_at: new Date().toISOString() };

  const externalCols = SOURCE_TO_EXTERNAL_COLUMNS[source] || [];
  if (input.externalId && externalCols.length > 0) {
    const primaryCol = externalCols[0];
    if (!existing[primaryCol]) patch[primaryCol] = input.externalId;
  }
  if (source === 'openphone') {
    if (input.sigcoreParticipantId && !existing.sigcore_participant_id) {
      patch.sigcore_participant_id = input.sigcoreParticipantId;
    }
    if (input.sigcoreParticipantKey && !existing.sigcore_participant_key) {
      patch.sigcore_participant_key = input.sigcoreParticipantKey;
    }
  }

  if (input.phone && !existing.normalized_phone) patch.normalized_phone = normalizePhone(input.phone);
  if (input.email && !existing.email) patch.email = input.email;
  if (input.displayName && !existing.display_name) patch.display_name = input.displayName;

  const { normalized_name, name_token_set } = normalize(input.displayName);
  if (normalized_name && !existing.normalized_name) patch.normalized_name = normalized_name;
  if (name_token_set && !existing.name_token_set) patch.name_token_set = name_token_set;

  const incomingTag = PRIORITY_TAG_BY_SOURCE[source] || null;
  const existingTag = existing.identity_priority_source;
  if (incomingTag && affectsIdentityPriority(source)) {
    const priorityOrder = { leadbridge: 1, openphone: 2, manual: 0, sync: 3 };
    const incomingRank = priorityOrder[incomingTag] ?? 99;
    const existingRank = existingTag ? (priorityOrder[existingTag] ?? 99) : 99;
    if (incomingRank < existingRank) patch.identity_priority_source = incomingTag;
  } else if (!existingTag) {
    patch.identity_priority_source = incomingTag;
  }

  const nextStatus = deriveStatus(existing);
  if (existing.status !== nextStatus && nextStatus !== 'unresolved_floating') {
    patch.status = nextStatus;
  } else if (!existing.status) {
    patch.status = nextStatus;
  }

  return patch;
}

async function enrichIdentity(supabase, existing, input, source, matchStep) {
  const patch = buildEnrichPatch(existing, input, source);
  if (Object.keys(patch).length <= 1 || input.dryRun) {
    return { status: 'matched', identity: existing, matchStep, createdFloating: false };
  }
  const { data } = await supabase.from('communication_participant_identities')
    .update(patch).eq('id', existing.id).select().single();
  return { status: 'matched', identity: data || { ...existing, ...patch }, matchStep, createdFloating: false };
}

async function createFloatingIdentity(supabase, input, source) {
  if (input.dryRun) {
    const { normalized_name, name_token_set } = normalize(input.displayName);
    return { conflict: false, identity: {
      id: null,
      user_id: input.userId,
      normalized_phone: normalizePhone(input.phone),
      email: input.email || null,
      display_name: input.displayName || null,
      normalized_name,
      name_token_set,
      status: 'unresolved_floating',
      identity_priority_source: PRIORITY_TAG_BY_SOURCE[source] || null,
    } };
  }
  const priorityTag = PRIORITY_TAG_BY_SOURCE[source] || null;
  const { normalized_name, name_token_set } = normalize(input.displayName);
  const normalizedPhone = normalizePhone(input.phone);

  const row = {
    user_id: input.userId,
    workspace_id: input.workspaceId || null,
    normalized_phone: normalizedPhone,
    email: input.email || null,
    display_name: input.displayName || null,
    normalized_name,
    name_token_set,
    source_channel: source,
    source_confidence: 'auto',
    status: 'unresolved_floating',
    identity_priority_source: priorityTag,
  };

  const cols = SOURCE_TO_EXTERNAL_COLUMNS[source] || [];
  if (input.externalId && cols.length > 0) row[cols[0]] = input.externalId;
  if (source === 'openphone') {
    if (input.sigcoreParticipantId) row.sigcore_participant_id = input.sigcoreParticipantId;
    if (input.sigcoreParticipantKey) row.sigcore_participant_key = input.sigcoreParticipantKey;
  }

  const { data, error } = await supabase.from('communication_participant_identities')
    .insert(row).select().single();

  if (error) {
    if (error.code === '23505' || /duplicate key/i.test(error.message || '')) {
      return { conflict: true };
    }
    throw error;
  }
  return { conflict: false, identity: data };
}

async function logAmbiguity(supabase, input, source, candidates, reason, autoMerged = false) {
  if (input.dryRun) return;
  const { normalized_name } = normalize(input.displayName);
  const status = autoMerged ? 'auto_merged_weak' : 'open';
  const attemptedPhone = normalizePhone(input.phone);

  // Dedupe — if an ambiguity with the same (user, source, phone, reason, status='open')
  // is already queued, skip the insert. Without this, every re-sync of the same
  // conversation piles up another row and the queue bloats with duplicates.
  if (status === 'open') {
    try {
      let q = supabase.from('communication_identity_ambiguities')
        .select('id', { head: true, count: 'exact' })
        .eq('user_id', input.userId)
        .eq('source', source)
        .eq('reason', reason)
        .eq('status', 'open');
      q = attemptedPhone ? q.eq('attempted_phone', attemptedPhone) : q.is('attempted_phone', null);
      const { count } = await q;
      if ((count || 0) > 0) return;
    } catch (_) { /* fall through — best-effort dedupe */ }
  }

  const row = {
    user_id: input.userId,
    source,
    attempted_external_id: input.externalId || null,
    attempted_phone: attemptedPhone,
    attempted_name: input.displayName || null,
    attempted_normalized_name: normalized_name,
    candidate_identity_ids: (candidates || []).map(c => c.id),
    reason,
    status,
    source_payload: input.sourceHints ? input.sourceHints : null,
  };
  try {
    await supabase.from('communication_identity_ambiguities').insert(row);
  } catch (_) { /* non-fatal */ }
}

async function resolveIdentity(supabase, input) {
  if (!input || !input.userId) throw new Error('resolveIdentity: userId is required');
  if (!input.source) throw new Error('resolveIdentity: source is required');
  getSource(input.source); // throws on unknown source

  const userId = input.userId;
  const source = input.source;
  const strict = input.strict === true; // Phase E — backfill mode: reject phone-only, reject weak
  const normalizedPhone = normalizePhone(input.phone);
  const { normalized_name, name_token_set } = normalize(input.displayName);

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    // Step 1: external ID (always allowed, strict or not)
    const byExtId = await findByExternalId(supabase, userId, source, input.externalId);
    if (byExtId) return enrichIdentity(supabase, byExtId, input, source, 'external_id');

    // Step 2 + 3: phone-based matching (with name classification)
    const phoneCands = await findCandidatesByPhone(supabase, userId, normalizedPhone);

    if (phoneCands.length > 0) {
      const classified = phoneCands.map(c => ({
        c,
        match: classifyNameMatch(normalized_name, name_token_set, c.normalized_name, c.name_token_set),
      }));

      // CRM-anchor preference — if exactly one phone candidate is already
      // linked to a customer or lead AND its name is not in outright conflict,
      // adopt it. This prevents logging ambiguities for people who are already
      // known in the CRM (they shouldn't need operator review). Observed in
      // production: 28/40 (70%) of the queue were strict_weak_name_rejected
      // or phone_name_conflict_or_multi on phones that already belonged to a
      // ZB customer.
      const crmAnchored = classified.filter(x =>
        (x.c.sf_customer_id || x.c.sf_lead_id) && x.match !== 'conflict'
      );
      if (crmAnchored.length === 1) {
        return enrichIdentity(supabase, crmAnchored[0].c, input, source, 'crm_anchor');
      }

      const strong = classified.filter(x => x.match === 'strong_exact' || x.match === 'strong_tokenset' || x.match === 'strong_leven');
      if (strong.length === 1) {
        return enrichIdentity(supabase, strong[0].c, input, source, 'phone_strong');
      }
      if (strong.length >= 2) {
        await logAmbiguity(supabase, input, source, strong.map(x => x.c), 'multi_phone_name_strong');
        return { status: 'ambiguous', candidates: strong.map(x => x.c.id), reason: 'multi_phone_name_strong' };
      }

      const nameCompat = classified.filter(x => x.match === 'one_missing' || x.match === 'neither_named');
      if (strong.length === 0 && classified.length === 1 && nameCompat.length === 1) {
        // Runtime: phone-only-no-conflict is OK. Strict (backfill): reject — never merge on phone alone.
        if (strict) {
          await logAmbiguity(supabase, input, source, classified.map(x => x.c), 'strict_phone_only_rejected');
          return { status: 'ambiguous', candidates: classified.map(x => x.c.id), reason: 'strict_phone_only_rejected' };
        }
        return enrichIdentity(supabase, classified[0].c, input, source, 'phone_strong');
      }

      const weak = classified.filter(x => x.match === 'weak_subset' || x.match === 'weak_leven');
      if (strong.length === 0 && weak.length === 1 && classified.length === 1) {
        // Runtime: allow weak + soft log. Strict: reject — backfill requires strong name match.
        if (strict) {
          await logAmbiguity(supabase, input, source, classified.map(x => x.c), 'strict_weak_name_rejected');
          return { status: 'ambiguous', candidates: classified.map(x => x.c.id), reason: 'strict_weak_name_rejected' };
        }
        await logAmbiguity(supabase, input, source, [weak[0].c], 'phone_weak_name_match', true);
        return enrichIdentity(supabase, weak[0].c, input, source, 'phone_weak');
      }

      await logAmbiguity(supabase, input, source, classified.map(x => x.c), 'phone_name_conflict_or_multi');
      return { status: 'ambiguous', candidates: classified.map(x => x.c.id), reason: 'phone_name_conflict_or_multi' };
    }

    // Step 4: email fallback
    if (input.email) {
      const emailCands = await findCandidatesByEmail(supabase, userId, input.email);
      if (emailCands.length === 1) {
        const only = emailCands[0];
        const m = classifyNameMatch(normalized_name, name_token_set, only.normalized_name, only.name_token_set);
        if (m.startsWith('strong_') || m === 'one_missing' || m === 'neither_named') {
          return enrichIdentity(supabase, only, input, source, 'email');
        }
      }
      if (emailCands.length >= 2) {
        await logAmbiguity(supabase, input, source, emailCands, 'multi_email_match');
        return { status: 'ambiguous', candidates: emailCands.map(c => c.id), reason: 'multi_email_match' };
      }
    }

    // Step 4b: via already-linked CRM entity
    const byCrm = await findByLinkedCrm(supabase, userId, input.sfLeadId, input.sfCustomerId);
    if (byCrm) return enrichIdentity(supabase, byCrm, input, source, 'via_linked_crm');

    // Step 5: no match → create floating identity
    const createResult = await createFloatingIdentity(supabase, input, source);
    if (createResult.conflict) {
      if (attempt < MAX_RETRIES) continue;
      return { status: 'error', error: 'resolver_conflict_max_retries' };
    }
    return {
      status: 'matched',
      identity: createResult.identity,
      matchStep: 'created_floating',
      createdFloating: true,
    };
  }

  return { status: 'error', error: 'resolver_max_retries_exhausted' };
}

module.exports = {
  resolveIdentity,
  classifyNameMatch,
  levenshtein,
  isTokenSubset,
  SOURCE_TO_EXTERNAL_COLUMNS,
  PRIORITY_TAG_BY_SOURCE,
};
