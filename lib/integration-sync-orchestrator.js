'use strict';

// Unified integration sync orchestrator.
//
// One entry point — runIntegrationSync(supabase, userId, source, { logger, extras }) —
// runs the full pipeline for that source and returns a summary. Replaces the
// previous pattern where operators clicked separate "Backfill / Reclassify /
// Reconcile / Convert / Fill sources" buttons.
//
// Pipeline steps (all adapters implement the ones that apply to them):
//   1. pull              — fetch external records via the adapter's pull()
//   2. normalize         — phone/name normalization (identity resolver + names)
//   3. resolveIdentity   — run each record through shared identity resolver
//   4. applySourceRules  — per-source lead/customer creation rules
//   5. linkExistingCRM   — phone/email match against customers/leads
//   6. fillMissingAttribution — back-fill customer.source / lead.source from
//                          OP company tags where safe
//   7. logIssues         — push ambiguities to communication_identity_ambiguities
//   8. summarize         — return counts + issues queue size
//
// Source-specific logic stays in its own module (zenbooker-sync, leadbridge-service,
// OpenPhone paths in server.js). The orchestrator composes them and always runs
// the post-sync source-fill.

const { deriveSourceForRow } = require('./customer-source-fill');
const { normalizePhone } = require('./name-normalize');

const SOURCES = Object.freeze(['openphone', 'leadbridge', 'zenbooker']);

/**
 * Load lead_source_mappings as { rawLowercased: canonical } once per run.
 */
async function loadSourceMappings(supabase, userId, provider = 'openphone') {
  const { data } = await supabase.from('lead_source_mappings')
    .select('raw_value, source_name')
    .eq('user_id', userId).eq('provider', provider);
  const out = {};
  for (const r of (data || [])) {
    if (r.raw_value && r.source_name) out[r.raw_value.toLowerCase()] = r.source_name;
  }
  return out;
}

/**
 * Run the source-fill step: UPDATE customers.source / leads.source where
 * source IS NULL and an OP conversation has a company tag that maps to a
 * canonical source. Fill-nulls-only. Used by every adapter's post-sync step.
 *
 * Returns { customers_filled, leads_filled }.
 */
async function fillMissingAttribution(supabase, userId, { logger } = {}) {
  const sourceMappings = await loadSourceMappings(supabase, userId, 'openphone');
  if (Object.keys(sourceMappings).length === 0) {
    if (logger) logger.log('[SyncOrchestrator] no OP source mappings configured — skip fill');
    return { customers_filled: 0, leads_filled: 0 };
  }

  const result = { customers_filled: 0, leads_filled: 0 };

  // Helper — fill null-source rows for a given table.
  async function fillTable(table) {
    const PAGE = 500;
    let lastId = 0;
    let filled = 0;
    while (true) {
      const { data: rows } = await supabase.from(table)
        .select('id, source, phone')
        .eq('user_id', userId)
        .or('source.is.null,source.eq.')
        .gt('id', lastId)
        .order('id', { ascending: true })
        .limit(PAGE);
      if (!rows || rows.length === 0) break;

      // Collect phones to batch-fetch conversations.
      const phones = rows.map(r => normalizePhone(r.phone)).filter(Boolean);
      if (phones.length === 0) {
        lastId = rows[rows.length - 1].id;
        if (rows.length < PAGE) break;
        continue;
      }
      // OR-filter by ILIKE '%last10%' — chunked to keep URL length reasonable.
      const convsByPhone = {}; // p10 → [{ company, last_event_at }, ...]
      for (let i = 0; i < phones.length; i += 50) {
        const chunk = phones.slice(i, i + 50);
        const orExpr = chunk.map(p => `participant_phone.ilike.%${p}%`).join(',');
        const { data: convs } = await supabase.from('communication_conversations')
          .select('participant_phone, company, last_event_at')
          .eq('user_id', userId).not('company', 'is', null)
          .or(orExpr);
        for (const c of (convs || [])) {
          const p10 = normalizePhone(c.participant_phone);
          if (!p10) continue;
          if (!convsByPhone[p10]) convsByPhone[p10] = [];
          convsByPhone[p10].push(c);
        }
      }

      // Derive + write per row.
      for (const row of rows) {
        const p10 = normalizePhone(row.phone);
        if (!p10) continue;
        const candidates = convsByPhone[p10] || [];
        const derived = deriveSourceForRow(row, sourceMappings, candidates);
        if (!derived) continue;
        await supabase.from(table)
          .update({ source: derived, updated_at: new Date().toISOString() })
          .eq('id', row.id).or('source.is.null,source.eq.'); // defensive double-check
        filled++;
      }

      lastId = rows[rows.length - 1].id;
      if (rows.length < PAGE) break;
    }
    return filled;
  }

  result.customers_filled = await fillTable('customers');
  result.leads_filled = await fillTable('leads');

  if (logger) logger.log(`[SyncOrchestrator] fillMissingAttribution: customers=${result.customers_filled} leads=${result.leads_filled}`);
  return result;
}

/**
 * Count open issues (ambiguities needing operator review).
 */
async function countOpenIssues(supabase, userId) {
  const { count } = await supabase.from('communication_identity_ambiguities')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId).eq('status', 'open');
  return count || 0;
}

/**
 * Entry point.
 *
 * For 'openphone': triggers the existing communications sync path, which
 *   internally runs resolveParticipantMapping → resolveIdentity + the
 *   per-conversation conditional lead creation. Then runs source-fill.
 * For 'leadbridge': no direct "sync-all" in today's codebase (LB ingests
 *   via webhooks + a periodic pull endpoint); this wraps a noop + source-fill.
 * For 'zenbooker': delegates to zenbooker-sync's runFullSync if injected,
 *   then source-fill.
 *
 * The individual adapter modules (injected via `deps`) do the heavy pulling;
 * this orchestrator handles post-sync back-fill + issue surfacing uniformly.
 *
 * @param {object} supabase
 * @param {number} userId
 * @param {'openphone'|'leadbridge'|'zenbooker'} source
 * @param {object} opts
 *   - logger  — { log, warn, error }
 *   - deps    — source-specific function injectors:
 *                 { runZenbookerFullSync, runOpenPhoneSync, runLeadBridgePull }
 */
async function runIntegrationSync(supabase, userId, source, opts = {}) {
  if (!SOURCES.includes(source)) throw new Error(`unknown source: ${source}`);
  const logger = opts.logger || { log: () => {}, warn: () => {}, error: () => {} };
  const deps = opts.deps || {};
  const startedAt = new Date().toISOString();

  const summary = {
    source,
    started_at: startedAt,
    records_synced: 0,
    records_linked: 0,
    records_created: 0,
    source_fill: { customers_filled: 0, leads_filled: 0 },
    open_issues: 0,
    errors: [],
  };

  try {
    // 1–5: source-specific pull + rules + CRM linking. Delegated.
    if (source === 'zenbooker' && typeof deps.runZenbookerFullSync === 'function') {
      const r = await deps.runZenbookerFullSync(userId);
      summary.records_synced = r?.customers_synced || r?.synced || 0;
      summary.records_created = r?.customers_created || 0;
      summary.records_linked = r?.customers_adopted || 0;
    } else if (source === 'openphone' && typeof deps.runOpenPhoneSync === 'function') {
      const r = await deps.runOpenPhoneSync(userId);
      summary.records_synced = r?.synced || 0;
      summary.records_created = r?.messages || 0;
    } else if (source === 'leadbridge' && typeof deps.runLeadBridgePull === 'function') {
      const r = await deps.runLeadBridgePull(userId);
      summary.records_synced = r?.leads_pulled || 0;
      summary.records_created = r?.leads_created || 0;
    }

    // 6: fill missing attribution (always runs after any successful sync).
    summary.source_fill = await fillMissingAttribution(supabase, userId, { logger });

    // 7 + 8: surface the issues queue and count what's still outstanding.
    summary.open_issues = await countOpenIssues(supabase, userId);
  } catch (e) {
    logger.error(`[SyncOrchestrator:${source}] failed`, e);
    summary.errors.push(e.message || String(e));
  }

  summary.finished_at = new Date().toISOString();
  return summary;
}

module.exports = {
  SOURCES,
  runIntegrationSync,
  fillMissingAttribution,
  loadSourceMappings,
  countOpenIssues,
};
