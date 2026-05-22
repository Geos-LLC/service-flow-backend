#!/usr/bin/env node
/**
 * Phase 1 — dry-run retroactive repair report.
 *
 * Runs the exact logic of POST /api/identity-conflicts/repair-lead-links
 * { dryRun: true, limit: 500 } scoped to user_id=2, BUT executes SQL via the
 * Supabase Management API (prod project ezyhbvskbwmwgwyduqpt) because the
 * local .env points at a non-prod project.
 *
 * Classification uses the production modules (classifyNameMatch from
 * lib/identity-resolver.js, normalize/normalizePhone from lib/name-normalize.js)
 * — no logic reimplementation.
 *
 * NO WRITES. NO APPLY. NO FLAG CHANGES.
 */

const { classifyNameMatch } = require('../lib/identity-resolver');
const { normalize, normalizePhone } = require('../lib/name-normalize');
const { shouldDowngradeForActiveWindow, filterByExclusion } = require('../lib/retroactive-repair-guards');

const PROJECT_REF = 'ezyhbvskbwmwgwyduqpt';
const TOKEN = process.env.SUPABASE_MANAGEMENT_TOKEN;
if (!TOKEN) {
  console.error('ERROR: set SUPABASE_MANAGEMENT_TOKEN env var before running this script.');
  console.error('  Retrieve from: aws secretsmanager get-secret-value --secret-id geos-dashboard-tokens --region us-east-1');
  process.exit(1);
}
const USER_ID = 2;
const LIMIT = 500;
// Active-window safeguard (operator correction 2026-05-21): if both lead and
// customer were updated within this many hours, downgrade HIGH → review_required.
// Override via env: ACTIVE_WINDOW_HOURS=48 node scripts/phase1-dryrun-repair.js
const ACTIVE_WINDOW_HOURS = process.env.ACTIVE_WINDOW_HOURS != null
  ? Math.max(0, Number(process.env.ACTIVE_WINDOW_HOURS))
  : 24;
// Operator exclude list — pass via env: EXCLUDE_CONFLICT_IDS="2,7,12"
const EXCLUDE_CONFLICT_IDS = (process.env.EXCLUDE_CONFLICT_IDS || '')
  .split(',').map(s => s.trim()).filter(Boolean);

async function sql(query) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`SQL failed (${res.status}): ${txt.slice(0, 500)}`);
  }
  return await res.json();
}

// Crude escaper for params (no user input here — only numeric ids + known strings).
function esc(s) { return String(s).replace(/'/g, "''"); }

async function main() {
  const conflicts = await sql(`
    SELECT id, normalized_phone, owners::text AS owners_json, severity, status
      FROM identity_conflicts
     WHERE workspace_id = ${USER_ID}
       AND status = 'open'
     LIMIT ${LIMIT}
  `);

  const parsed = (conflicts || []).map(c => ({ ...c, owners: JSON.parse(c.owners_json || '[]') }));
  const { kept: nonExcluded, excludedIds } = filterByExclusion(parsed, EXCLUDE_CONFLICT_IDS);
  const candidates = nonExcluded.filter(c => {
    const o = c.owners;
    return o.some(x => x.entity_type === 'customer') && o.some(x => x.entity_type === 'lead');
  });

  const report = {
    user_id: USER_ID,
    active_window_hours: ACTIVE_WINDOW_HOURS,
    total_open_conflicts: (conflicts || []).length,
    excluded_count: excludedIds.length,
    excluded_ids: excludedIds,
    total_lead_customer_pairs_examined: candidates.length,
    high: 0,
    review_required: 0,
    medium: 0,
    low: 0,
    skipped: 0,
    skipped_reasons: {},
    invariant_violations: {
      cross_tenant: 0,
      already_converted: 0,
      multi_customer: 0,
      multi_lead: 0,
      conflicting_identity_row: 0,
    },
    active_window_downgrades: 0,
    results: [],
  };

  function bump(obj, k) { obj[k] = (obj[k] || 0) + 1; }

  for (const c of candidates) {
    const leadOwners = c.owners.filter(x => x.entity_type === 'lead');
    const custOwners = c.owners.filter(x => x.entity_type === 'customer');

    if (leadOwners.length !== 1 || custOwners.length !== 1) {
      report.skipped++;
      if (leadOwners.length > 1) report.invariant_violations.multi_lead++;
      if (custOwners.length > 1) report.invariant_violations.multi_customer++;
      bump(report.skipped_reasons, 'multi_owner_requires_manual_review');
      report.results.push({
        conflict_id: c.id, verdict: 'skipped',
        reason: 'multi_owner_requires_manual_review',
        lead_count: leadOwners.length, customer_count: custOwners.length,
        lead_ids: leadOwners.map(o => o.entity_id),
        customer_ids: custOwners.map(o => o.entity_id),
      });
      continue;
    }

    const leadId = Number(leadOwners[0].entity_id);
    const customerId = Number(custOwners[0].entity_id);

    const [leadRows, custRows] = await Promise.all([
      sql(`SELECT id, user_id, first_name, last_name, phone, source, converted_customer_id,
                  normalized_name, name_token_set, lead_cost, updated_at
             FROM leads WHERE id = ${leadId} AND user_id = ${USER_ID} LIMIT 1`),
      sql(`SELECT id, user_id, first_name, last_name, phone, source,
                  normalized_name, name_token_set, updated_at
             FROM customers WHERE id = ${customerId} AND user_id = ${USER_ID} LIMIT 1`),
    ]);
    const lead = (leadRows || [])[0] || null;
    const customer = (custRows || [])[0] || null;

    if (!lead || !customer) {
      report.skipped++;
      bump(report.skipped_reasons, 'lead_or_customer_missing');
      report.results.push({
        conflict_id: c.id, lead_id: leadId, customer_id: customerId,
        verdict: 'skipped', reason: 'lead_or_customer_missing',
        lead_found: !!lead, customer_found: !!customer,
      });
      continue;
    }

    if (Number(lead.user_id) !== USER_ID || Number(customer.user_id) !== USER_ID) {
      report.invariant_violations.cross_tenant++;
      report.skipped++;
      report.results.push({
        conflict_id: c.id, lead_id: leadId, customer_id: customerId,
        verdict: 'skipped', reason: 'cross_tenant_violation',
      });
      continue;
    }

    if (lead.converted_customer_id != null) {
      report.invariant_violations.already_converted++;
      report.skipped++;
      bump(report.skipped_reasons, lead.converted_customer_id === customerId ? 'already_linked_same' : 'already_linked_other');
      report.results.push({
        conflict_id: c.id, lead_id: leadId, customer_id: customerId,
        verdict: 'skipped',
        reason: lead.converted_customer_id === customerId ? 'already_linked_same' : 'already_linked_other',
        current_customer_id: lead.converted_customer_id,
      });
      continue;
    }

    const leadName = lead.normalized_name || normalize(`${lead.first_name || ''} ${lead.last_name || ''}`).normalized_name;
    const leadTokens = lead.name_token_set || normalize(`${lead.first_name || ''} ${lead.last_name || ''}`).name_token_set;
    const custName = customer.normalized_name || normalize(`${customer.first_name || ''} ${customer.last_name || ''}`).normalized_name;
    const custTokens = customer.name_token_set || normalize(`${customer.first_name || ''} ${customer.last_name || ''}`).name_token_set;
    const nameClass = classifyNameMatch(leadName, leadTokens, custName, custTokens);

    const leadPhone10 = normalizePhone(lead.phone);
    const custPhone10 = normalizePhone(customer.phone);
    const phoneMatch = leadPhone10 != null && leadPhone10 === custPhone10;

    const sourceCompat = !lead.source || !customer.source
      || String(lead.source).toLowerCase().split(/\W+/).some(t => t && String(customer.source).toLowerCase().includes(t));

    const isStrongName = nameClass === 'strong_exact' || nameClass === 'strong_tokenset' || nameClass === 'strong_leven';
    let confidence;
    let reason;
    if (!phoneMatch) {
      confidence = 'low'; reason = 'phone_mismatch';
    } else if (isStrongName && sourceCompat) {
      confidence = 'high'; reason = `phone_match+${nameClass}+source_compat`;
    } else if (isStrongName) {
      confidence = 'medium'; reason = `phone_match+${nameClass}+source_incompat`;
    } else if (nameClass === 'one_missing' || nameClass === 'neither_named') {
      confidence = 'medium'; reason = `phone_match+${nameClass}`;
    } else {
      confidence = 'low'; reason = `phone_match+${nameClass}`;
    }

    // HIGH downgrade checks
    let high_downgrade_reason = null;
    if (confidence === 'high' && leadPhone10) {
      const ambigRows = await sql(`
        SELECT count(*)::int AS n FROM communication_identity_ambiguities
         WHERE user_id = ${USER_ID} AND attempted_phone = '${esc(leadPhone10)}' AND status = 'open'
      `);
      const ambigCount = ambigRows[0]?.n || 0;
      if (ambigCount > 0) {
        confidence = 'medium';
        reason += '+open_ambiguity_blocks';
        high_downgrade_reason = 'open_ambiguity';
      }
    }
    let conflictingIdentities = 0;
    if (confidence === 'high' && leadPhone10) {
      const phoneIdRows = await sql(`
        SELECT id, sf_lead_id, sf_customer_id
          FROM communication_participant_identities
         WHERE user_id = ${USER_ID} AND normalized_phone = '${esc(leadPhone10)}'
      `);
      const conflicting = (phoneIdRows || []).filter(p =>
        (p.sf_lead_id && Number(p.sf_lead_id) !== leadId) ||
        (p.sf_customer_id && Number(p.sf_customer_id) !== customerId)
      );
      conflictingIdentities = conflicting.length;
      if (conflicting.length > 0) {
        confidence = 'medium';
        reason += '+conflicting_identity_row';
        report.invariant_violations.conflicting_identity_row++;
        high_downgrade_reason = (high_downgrade_reason ? high_downgrade_reason + '+' : '') + 'conflicting_identity';
      }
    }

    // Active-window safeguard — shared helper
    let activeWindowDowngrade = false;
    if (confidence === 'high') {
      const guard = shouldDowngradeForActiveWindow({
        leadUpdatedAt: lead.updated_at,
        customerUpdatedAt: customer.updated_at,
        activeWindowHours: ACTIVE_WINDOW_HOURS,
      });
      if (guard.downgrade) {
        confidence = 'review_required';
        reason += `+${guard.reason}`;
        activeWindowDowngrade = true;
        report.active_window_downgrades++;
      }
    }

    if (confidence === 'high') report.high++;
    else if (confidence === 'review_required') report.review_required++;
    else if (confidence === 'medium') report.medium++;
    else report.low++;

    report.results.push({
      conflict_id: c.id,
      lead_id: leadId,
      customer_id: customerId,
      normalized_phone: c.normalized_phone,
      confidence,
      reason,
      name_class: nameClass,
      phone_match: phoneMatch,
      source_compat: sourceCompat,
      lead_name: `${lead.first_name || ''} ${lead.last_name || ''}`.trim(),
      customer_name: `${customer.first_name || ''} ${customer.last_name || ''}`.trim(),
      lead_source: lead.source,
      customer_source: customer.source,
      lead_cost: lead.lead_cost,
      lead_updated_at: lead.updated_at || null,
      customer_updated_at: customer.updated_at || null,
      conflicting_identity_rows: conflictingIdentities,
      high_downgrade_reason,
      active_window_downgrade: activeWindowDowngrade,
    });
  }

  console.log(JSON.stringify(report, null, 2));
}

main().catch(e => { console.error('FAILED:', e.message); process.exit(2); });
