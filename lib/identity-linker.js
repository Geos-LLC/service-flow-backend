'use strict';

/**
 * Identity Linker — automatic Lead ↔ Customer reconciliation.
 *
 * Per operator request (2026-05-21):
 *   "ZB → SF and LB → SF are creating separate records for the same person
 *    because the identity reconciliation layer is not linking them."
 *
 * When ZB sync creates a customer:
 *   1. Normalize phone to last-10 digits
 *   2. Search open/unconverted leads in same workspace
 *   3. Score each candidate by phone (required), source channel (bonus),
 *      name similarity (bonus)
 *   4. HIGH confidence → auto-link (set leads.converted_customer_id +
 *      converted_at), emit [IdentityLink] audit log, never delete the lead
 *   5. MEDIUM confidence → leave the conflict open; the existing
 *      Identity Conflicts UI can offer the operator a 1-click link via
 *      POST /api/identity-conflicts/:id/link-lead
 *   6. LOW confidence → no-op
 *
 * Cross-tenant linking is structurally impossible: the leads query is
 * already scoped to the same `user_id`.
 *
 * NEVER throws — failures are absorbed and surfaced via the return value
 * + warn log. Sync paths can safely call this in their happy path
 * without try/catch.
 */

const HIGH_CONFIDENCE_THRESHOLD = 75;
const MEDIUM_CONFIDENCE_THRESHOLD = 50;

// ── Phone normalization (mirrors lib/sms-recipient-integrity.js) ──

function normalizePhone(p) {
  if (p == null) return null;
  const digits = String(p).replace(/\D/g, '');
  if (digits.length === 0) return null;
  return digits.length >= 10 ? digits.slice(-10) : digits;
}

// ── Source channel classification ─────────────────────────────────

/**
 * Classify a source string into a canonical channel. Used for
 * source-compatibility scoring between a customer's `source` field
 * and a lead's `source` field.
 *
 * "Thumbtack Tampa", "leadbridge_thumbtack", "Spotless Homes Tampa (thumbtack)"
 *   → all classify to 'thumbtack' → match.
 *
 * Unknown / blank → 'other' (treated as neutral, no boost).
 */
function classifyChannel(source) {
  const s = String(source || '').toLowerCase();
  if (s.includes('thumbtack')) return 'thumbtack';
  if (s.includes('yelp')) return 'yelp';
  if (s.includes('openphone')) return 'openphone';
  if (s.includes('leadbridge')) return 'leadbridge';
  if (s.includes('google')) return 'google';
  if (s.includes('facebook')) return 'facebook';
  if (s.includes('instagram')) return 'instagram';
  if (s.includes('referral')) return 'referral';
  if (s.includes('website') || s.includes('site request')) return 'website';
  if (s.includes('cold call')) return 'cold_call';
  return 'other';
}

// ── Name similarity ───────────────────────────────────────────────

/**
 * Token-overlap (Jaccard) name similarity. Returns 0..1.
 * Lower-cased, punctuation stripped, single-character tokens dropped.
 *
 * "Kira Osipova" vs "kira osipova"        → 1.0
 * "Kira Osipova" vs "Kira O"              → 0.5 (1/2)
 * "John Smith"   vs "John Doe"            → 0.33 (1/3)
 * "Test Customer" vs "test customer for georgiy" → 0.5 (2/4)
 */
function nameSimilarity(a, b) {
  const tokenize = (s) =>
    String(s || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length >= 2);
  const aTokens = new Set(tokenize(a));
  const bTokens = new Set(tokenize(b));
  if (aTokens.size === 0 && bTokens.size === 0) return 0;
  if (aTokens.size === 0 || bTokens.size === 0) return 0;
  let intersect = 0;
  for (const t of aTokens) if (bTokens.has(t)) intersect++;
  const union = aTokens.size + bTokens.size - intersect;
  return union === 0 ? 0 : intersect / union;
}

// ── Scoring ────────────────────────────────────────────────────────

/**
 * Score a single (customer, lead) candidate match.
 *
 * Returns { score (0-100), confidence ('high'|'medium'|'low'), reasons[] }
 *
 * Rules:
 *   - Phone exact normalized match            → +50 (required)
 *     If phones don't match → score 0, confidence 'low'.
 *   - Source channel compatible (same canonical channel, not 'other')
 *                                              → +25
 *   - Name token-overlap ≥ 0.8                 → +25
 *   - Name token-overlap 0.5..0.79             → +10
 *   - Name mismatch (< 0.5) on identical phone → no boost, no penalty
 *
 * Total ≥ 75 → HIGH (auto-link).
 * Total 50-74 → MEDIUM (operator review).
 * Total < 50 → LOW (no link).
 */
function scoreMatch({ customerPhone, customerName, customerSource, lead }) {
  const reasons = [];
  let score = 0;

  const custLast10 = normalizePhone(customerPhone);
  const leadLast10 = normalizePhone(lead && lead.phone);
  if (!custLast10 || !leadLast10 || custLast10 !== leadLast10) {
    return { score: 0, confidence: 'low', reasons: ['phone_mismatch'] };
  }
  score += 50;
  reasons.push('phone_match');

  const custChan = classifyChannel(customerSource);
  const leadChan = classifyChannel(lead.source);
  if (custChan !== 'other' && leadChan !== 'other' && custChan === leadChan) {
    score += 25;
    reasons.push(`channel_match:${custChan}`);
  }

  const leadFullName = [lead.first_name, lead.last_name].filter(Boolean).join(' ').trim();
  const nameSim = nameSimilarity(customerName, leadFullName);
  if (nameSim >= 0.8) {
    score += 25;
    reasons.push(`name_match:${nameSim.toFixed(2)}`);
  } else if (nameSim >= 0.5) {
    score += 10;
    reasons.push(`name_partial:${nameSim.toFixed(2)}`);
  } else if (nameSim > 0) {
    reasons.push(`name_weak:${nameSim.toFixed(2)}`);
  } else {
    reasons.push('name_unknown');
  }

  const confidence = score >= HIGH_CONFIDENCE_THRESHOLD ? 'high'
    : score >= MEDIUM_CONFIDENCE_THRESHOLD ? 'medium'
    : 'low';

  return { score, confidence, reasons };
}

// ── Candidate discovery ───────────────────────────────────────────

/**
 * Find UNCONVERTED leads in the same workspace whose phone matches
 * the customer's phone (last-10 normalized).
 *
 * NEVER returns leads with `converted_customer_id IS NOT NULL` — those
 * are already linked.
 */
async function findCandidateLeads(supabase, userId, customerPhone) {
  const last10 = normalizePhone(customerPhone);
  if (!last10 || last10.length < 7) return [];
  if (!supabase) return [];
  try {
    const { data, error } = await supabase
      .from('leads')
      .select('id, first_name, last_name, phone, email, source, converted_customer_id')
      .eq('user_id', userId)
      .is('converted_customer_id', null)
      .not('phone', 'is', null);
    if (error) return [];
    return (data || []).filter((l) => normalizePhone(l.phone) === last10);
  } catch (_) {
    return [];
  }
}

// ── Emitter ────────────────────────────────────────────────────────

function emitIdentityLinkLog(logger, fields) {
  if (!logger || !logger.log) return;
  const f = fields || {};
  try {
    const parts = [
      `lead_id=${f.lead_id != null ? f.lead_id : 'null'}`,
      `customer_id=${f.customer_id != null ? f.customer_id : 'null'}`,
      `workspace_id=${f.workspace_id != null ? f.workspace_id : 'null'}`,
      `confidence=${f.confidence || 'unknown'}`,
      `score=${f.score != null ? f.score : 'null'}`,
      `reason=${(f.reasons || []).join(',') || 'none'}`,
      `mode=${f.mode || 'auto'}`,
      `result=${f.result || 'success'}`,
    ];
    logger.log(`[IdentityLink] ${parts.join(' ')}`);
  } catch (_) { /* never throw out of logging */ }
}

// ── Top-level: attempt link ───────────────────────────────────────

/**
 * Attempt to link a customer to an unconverted lead in the same
 * workspace. Called from ZB inbound sync (and optionally other sync
 * sources). Never throws.
 *
 * @param {Object} supabase
 * @param {Object} logger
 * @param {Object} opts
 *   userId           REQUIRED — workspace scope
 *   customerId       REQUIRED — the customer that was just created/updated
 *   customerPhone    REQUIRED — used for candidate discovery
 *   customerName     OPTIONAL — used for name-similarity scoring
 *   customerSource   OPTIONAL — used for channel-compatibility scoring
 *   dryRun           OPTIONAL — when true, returns the verdict without
 *                              writing anything (used by retroactive repair)
 *
 * @returns {Promise<{
 *   linked: boolean,
 *   reason: string,
 *   confidence?: 'high'|'medium'|'low',
 *   score?: number,
 *   reasons?: string[],
 *   lead_id?: number,
 *   candidates?: Array,  // populated when reason='ambiguous_multiple'
 * }>}
 */
async function attemptLeadToCustomerLink(supabase, logger, opts) {
  const o = opts || {};
  if (o.userId == null || o.customerId == null || !o.customerPhone) {
    return { linked: false, reason: 'invalid_input' };
  }

  try {
    // Don't link if THIS customer already has a lead pointing to it.
    const { data: existing } = await supabase
      .from('leads')
      .select('id')
      .eq('user_id', o.userId)
      .eq('converted_customer_id', o.customerId)
      .limit(1);
    if (existing && existing[0]) {
      return { linked: false, reason: 'customer_already_linked', existing_lead_id: existing[0].id };
    }

    const candidates = await findCandidateLeads(supabase, o.userId, o.customerPhone);
    if (candidates.length === 0) {
      return { linked: false, reason: 'no_candidates' };
    }

    const scored = candidates
      .map((lead) => ({
        lead,
        ...scoreMatch({
          customerPhone: o.customerPhone,
          customerName: o.customerName,
          customerSource: o.customerSource,
          lead,
        }),
      }))
      .sort((a, b) => b.score - a.score);

    const best = scored[0];
    const second = scored[1];

    // Multiple HIGH-confidence candidates → ambiguous, downgrade to manual review.
    if (best.confidence === 'high' && second && second.confidence === 'high') {
      return {
        linked: false,
        reason: 'ambiguous_multiple_high',
        confidence: 'medium',
        candidates: scored.slice(0, 5).map(({ lead, score, confidence, reasons }) => ({
          lead_id: lead.id, score, confidence, reasons,
        })),
      };
    }

    if (best.confidence === 'high') {
      if (o.dryRun) {
        return {
          linked: false,
          reason: 'dry_run_would_link',
          confidence: 'high',
          score: best.score,
          reasons: best.reasons,
          lead_id: best.lead.id,
        };
      }
      const { error } = await supabase
        .from('leads')
        .update({
          converted_customer_id: o.customerId,
          converted_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', best.lead.id)
        .eq('user_id', o.userId);
      if (error) {
        if (logger && logger.error) {
          logger.error(`[IdentityLink] update failed lead_id=${best.lead.id} customer_id=${o.customerId} error=${error.message}`);
        }
        return { linked: false, reason: 'update_failed', error: error.message };
      }
      // Archive the lead's registry row so the identity_conflicts entry
      // for this phone re-evaluates. If down to 1 active owner, the
      // pir_archive_entity RPC auto-resolves the open conflict.
      try {
        await supabase.rpc('pir_archive_entity', {
          p_workspace_id: o.userId,
          p_entity_type: 'lead',
          p_entity_id: String(best.lead.id),
        });
      } catch (_) { /* best-effort */ }

      emitIdentityLinkLog(logger, {
        lead_id: best.lead.id,
        customer_id: o.customerId,
        workspace_id: o.userId,
        confidence: 'high',
        score: best.score,
        reasons: best.reasons,
        mode: o.mode || 'auto_sync',
        result: 'success',
      });
      return {
        linked: true,
        reason: 'auto_linked',
        confidence: 'high',
        score: best.score,
        reasons: best.reasons,
        lead_id: best.lead.id,
      };
    }

    if (best.confidence === 'medium') {
      emitIdentityLinkLog(logger, {
        lead_id: best.lead.id,
        customer_id: o.customerId,
        workspace_id: o.userId,
        confidence: 'medium',
        score: best.score,
        reasons: best.reasons,
        mode: 'suggestion',
        result: 'pending_review',
      });
      return {
        linked: false,
        reason: 'medium_confidence_pending_review',
        confidence: 'medium',
        score: best.score,
        reasons: best.reasons,
        lead_id: best.lead.id,
      };
    }

    return {
      linked: false,
      reason: 'low_confidence',
      confidence: 'low',
      score: best.score,
      reasons: best.reasons,
      lead_id: best.lead.id,
    };
  } catch (err) {
    if (logger && logger.warn) {
      logger.warn(`[IdentityLink] threw — swallowed: ${err && err.message}`);
    }
    return { linked: false, reason: 'exception', error: err && err.message };
  }
}

/**
 * Apply a specific lead → customer link explicitly (operator action
 * from the Identity Conflicts UI, or retroactive repair script).
 *
 * Skips the scoring; trusts the caller's choice. Still tenant-scoped.
 * Still refuses to overwrite an already-linked lead.
 */
async function applyLeadCustomerLink(supabase, logger, { userId, leadId, customerId, reasonsHint }) {
  if (userId == null || leadId == null || customerId == null) {
    return { ok: false, error: 'invalid_input' };
  }
  try {
    // Refuse if the lead is already converted to a DIFFERENT customer.
    const { data: existing } = await supabase
      .from('leads')
      .select('id, converted_customer_id')
      .eq('user_id', userId)
      .eq('id', leadId)
      .maybeSingle();
    if (!existing) return { ok: false, error: 'lead_not_found' };
    if (existing.converted_customer_id != null && String(existing.converted_customer_id) !== String(customerId)) {
      return { ok: false, error: 'lead_already_converted', current: existing.converted_customer_id };
    }
    if (existing.converted_customer_id != null) {
      // Idempotent — already pointing to the same customer
      return { ok: true, idempotent: true, lead_id: leadId, customer_id: customerId };
    }

    const { error } = await supabase
      .from('leads')
      .update({
        converted_customer_id: customerId,
        converted_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', leadId)
      .eq('user_id', userId);
    if (error) {
      if (logger && logger.error) {
        logger.error(`[IdentityLink] manual update failed lead_id=${leadId} customer_id=${customerId} error=${error.message}`);
      }
      return { ok: false, error: error.message };
    }
    // Archive the lead's registry row so the open conflict auto-resolves.
    try {
      await supabase.rpc('pir_archive_entity', {
        p_workspace_id: userId,
        p_entity_type: 'lead',
        p_entity_id: String(leadId),
      });
    } catch (_) { /* best-effort */ }

    emitIdentityLinkLog(logger, {
      lead_id: leadId,
      customer_id: customerId,
      workspace_id: userId,
      confidence: 'manual',
      reasons: reasonsHint || ['operator_apply'],
      mode: 'manual',
      result: 'success',
    });
    return { ok: true, lead_id: leadId, customer_id: customerId };
  } catch (err) {
    return { ok: false, error: err && err.message };
  }
}

module.exports = {
  HIGH_CONFIDENCE_THRESHOLD,
  MEDIUM_CONFIDENCE_THRESHOLD,
  normalizePhone,
  classifyChannel,
  nameSimilarity,
  scoreMatch,
  findCandidateLeads,
  attemptLeadToCustomerLink,
  applyLeadCustomerLink,
  emitIdentityLinkLog,
};
