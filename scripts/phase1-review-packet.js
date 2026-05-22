#!/usr/bin/env node
/**
 * Phase 1 — visual review packet builder.
 *
 * For each lead↔customer pair from the dry-run, gathers everything an
 * operator would cross-check in the UI:
 *   - lead + customer detail
 *   - lead pipeline stage
 *   - open lead_tasks
 *   - customer job count, last job, next scheduled job
 *   - recent conversations on the normalized phone (last 7 days)
 *   - any other lead / customer / team_member / user sharing the same
 *     normalized phone outside this conflict (household / shared-line
 *     indicators)
 *
 * Emits two artifacts in scripts/output/:
 *   - phase1-review-packet.json — full structured data
 *   - phase1-review-packet.md   — operator-readable markdown
 *
 * NO WRITES. NO APPLY.
 */

const fs = require('fs');
const path = require('path');
const { classifyNameMatch } = require('../lib/identity-resolver');
const { normalize, normalizePhone } = require('../lib/name-normalize');
const { shouldDowngradeForActiveWindow } = require('../lib/retroactive-repair-guards');

const PROJECT_REF = 'ezyhbvskbwmwgwyduqpt';
const TOKEN = process.env.SUPABASE_MANAGEMENT_TOKEN;
if (!TOKEN) {
  console.error('ERROR: set SUPABASE_MANAGEMENT_TOKEN env var before running this script.');
  console.error('  Retrieve from: aws secretsmanager get-secret-value --secret-id geos-dashboard-tokens --region us-east-1');
  process.exit(1);
}
const USER_ID = 2;
const ACTIVE_WINDOW_HOURS = 24;
const RECENT_DAYS = 7;

async function sql(query) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`SQL failed (${res.status}): ${txt.slice(0, 500)}`);
  }
  return await res.json();
}

function esc(s) { return String(s).replace(/'/g, "''"); }

function ago(ts) {
  if (!ts) return null;
  const ms = Date.now() - new Date(ts).getTime();
  if (!Number.isFinite(ms)) return null;
  const hours = ms / (60 * 60 * 1000);
  if (hours < 24) return `${hours.toFixed(1)}h ago`;
  const days = hours / 24;
  if (days < 60) return `${days.toFixed(1)}d ago`;
  return `${(days / 30).toFixed(1)}mo ago`;
}

function fmtPhone(p) {
  if (!p) return '';
  const d = String(p).replace(/\D/g, '').slice(-10);
  if (d.length !== 10) return p;
  return `(${d.slice(0,3)}) ${d.slice(3,6)}-${d.slice(6)}`;
}

async function main() {
  // 1) Pull the same candidate set as the dry-run.
  const conflicts = await sql(`
    SELECT id, normalized_phone, owners::text AS owners_json, severity, status
      FROM identity_conflicts
     WHERE workspace_id = ${USER_ID}
       AND status = 'open'
     LIMIT 500
  `);
  const candidates = conflicts
    .map(c => ({ ...c, owners: JSON.parse(c.owners_json || '[]') }))
    .filter(c => {
      const o = c.owners;
      return o.some(x => x.entity_type === 'customer') && o.some(x => x.entity_type === 'lead');
    })
    .filter(c => c.owners.filter(x => x.entity_type === 'lead').length === 1
              && c.owners.filter(x => x.entity_type === 'customer').length === 1);

  if (candidates.length === 0) {
    console.error('No candidates.');
    process.exit(0);
  }

  // 2) Batch-fetch supplementary data per candidate.
  const leadIds = candidates.map(c => Number(c.owners.find(o => o.entity_type === 'lead').entity_id));
  const custIds = candidates.map(c => Number(c.owners.find(o => o.entity_type === 'customer').entity_id));
  const phones = candidates.map(c => c.normalized_phone).filter(Boolean);

  const [leadsRows, custRows, stagesRows, openTasksRows, jobsAggRows, futureJobsRows, recentConvRows, otherPhoneOwnersRows] = await Promise.all([
    sql(`SELECT id, user_id, first_name, last_name, phone, source, converted_customer_id,
                normalized_name, name_token_set, lead_cost, updated_at, created_at,
                pipeline_id, stage_id, notes
           FROM leads
          WHERE user_id = ${USER_ID} AND id IN (${leadIds.join(',')})`),
    sql(`SELECT id, user_id, first_name, last_name, phone, source,
                normalized_name, name_token_set, updated_at, created_at
           FROM customers
          WHERE user_id = ${USER_ID} AND id IN (${custIds.join(',')})`),
    sql(`SELECT id, name FROM lead_stages WHERE id IN (
            SELECT DISTINCT stage_id FROM leads WHERE user_id = ${USER_ID} AND id IN (${leadIds.join(',')}) AND stage_id IS NOT NULL
         )`),
    sql(`SELECT id, lead_id, status, due_date
           FROM lead_tasks
          WHERE user_id = ${USER_ID}
            AND lead_id IN (${leadIds.join(',')})
            AND status IS DISTINCT FROM 'completed'
            AND completed_at IS NULL`),
    // scheduled_date is text in this schema → cast to date for comparison
    sql(`SELECT customer_id,
                count(*)::int AS total_jobs,
                count(*) FILTER (WHERE scheduled_date::date <= current_date)::int AS past_jobs,
                count(*) FILTER (WHERE scheduled_date::date > current_date)::int AS future_jobs,
                max(scheduled_date::date) FILTER (WHERE scheduled_date::date <= current_date)::text AS last_past_date
           FROM jobs
          WHERE user_id = ${USER_ID} AND customer_id IN (${custIds.join(',')})
            AND scheduled_date IS NOT NULL
            AND scheduled_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}'
          GROUP BY customer_id`),
    sql(`SELECT customer_id, min(scheduled_date::date)::text AS next_date
           FROM jobs
          WHERE user_id = ${USER_ID}
            AND customer_id IN (${custIds.join(',')})
            AND scheduled_date IS NOT NULL
            AND scheduled_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}'
            AND scheduled_date::date > current_date
            AND status IS DISTINCT FROM 'cancelled'
          GROUP BY customer_id`),
    // recent conversations matching any of the phones (last N days)
    phones.length === 0 ? Promise.resolve([]) : sql(`
      SELECT participant_phone, count(*)::int AS n, max(last_event_at) AS last_event,
             max(lead_id) AS sample_lead_id, max(customer_id) AS sample_customer_id
        FROM communication_conversations
       WHERE user_id = ${USER_ID}
         AND last_event_at >= now() - interval '${RECENT_DAYS} days'
         AND (
           ${phones.map(p => `participant_phone ILIKE '%${esc(p)}%'`).join(' OR ')}
         )
       GROUP BY participant_phone`),
    // anything else sharing the phone — phone_identity_registry has one
    // row per (phone, entity), so we list all active entities on these phones.
    sql(`
      SELECT normalized_phone, entity_type, entity_id, source, confidence
        FROM phone_identity_registry
       WHERE workspace_id = ${USER_ID}
         AND status = 'active'
         AND normalized_phone IN (${phones.map(p => `'${esc(p)}'`).join(',')})
    `),
  ]);

  const leadById = {};
  for (const r of leadsRows) leadById[r.id] = r;
  const custById = {};
  for (const r of custRows) custById[r.id] = r;
  const stageById = {};
  for (const s of stagesRows) stageById[s.id] = s.name;

  const tasksByLead = {};
  for (const t of openTasksRows) {
    (tasksByLead[t.lead_id] ||= []).push(t);
  }

  const jobsByCustomer = {};
  for (const j of jobsAggRows) jobsByCustomer[j.customer_id] = j;
  const nextJobByCustomer = {};
  for (const j of futureJobsRows) nextJobByCustomer[j.customer_id] = j.next_date;

  const convByPhone10 = {};
  for (const c of recentConvRows) {
    const p10 = normalizePhone(c.participant_phone);
    if (!p10) continue;
    if (!convByPhone10[p10]) convByPhone10[p10] = { count: 0, last_event: null };
    convByPhone10[p10].count += c.n || 0;
    if (!convByPhone10[p10].last_event || c.last_event > convByPhone10[p10].last_event) {
      convByPhone10[p10].last_event = c.last_event;
    }
  }

  const phoneOwners = {};
  for (const r of otherPhoneOwnersRows) {
    (phoneOwners[r.normalized_phone] ||= []).push({
      entity_type: r.entity_type,
      entity_id: r.entity_id,
      source: r.source,
      confidence: r.confidence,
    });
  }

  // 3) Build per-candidate review entries with recommendation.
  const packet = [];
  for (const c of candidates) {
    const leadId = Number(c.owners.find(o => o.entity_type === 'lead').entity_id);
    const customerId = Number(c.owners.find(o => o.entity_type === 'customer').entity_id);
    const lead = leadById[leadId];
    const customer = custById[customerId];
    if (!lead || !customer) continue;

    // Name classification (matches dry-run logic)
    const leadName = lead.normalized_name || normalize(`${lead.first_name || ''} ${lead.last_name || ''}`).normalized_name;
    const leadTokens = lead.name_token_set || normalize(`${lead.first_name || ''} ${lead.last_name || ''}`).name_token_set;
    const custName = customer.normalized_name || normalize(`${customer.first_name || ''} ${customer.last_name || ''}`).normalized_name;
    const custTokens = customer.name_token_set || normalize(`${customer.first_name || ''} ${customer.last_name || ''}`).name_token_set;
    const nameClass = classifyNameMatch(leadName, leadTokens, custName, custTokens);
    const isStrongName = nameClass.startsWith('strong_');

    const leadPhone10 = normalizePhone(lead.phone);
    const custPhone10 = normalizePhone(customer.phone);
    const phoneMatch = leadPhone10 != null && leadPhone10 === custPhone10;

    const stageName = lead.stage_id != null ? (stageById[lead.stage_id] || `stage ${lead.stage_id}`) : null;
    const stageSuggestsActive = stageName
      ? !/^(won|lost|closed|converted|inactive|archived|disqualified)$/i.test(stageName)
      : false;

    const openTasks = tasksByLead[leadId] || [];
    const jobs = jobsByCustomer[customerId] || null;
    const nextJob = nextJobByCustomer[customerId] || null;
    const recentConv = convByPhone10[c.normalized_phone] || null;

    // Identify "other" owners sharing the phone (i.e. owners on the
    // phone_identity_registry that aren't the conflict's lead or customer).
    const phoneOwnersAll = phoneOwners[c.normalized_phone] || [];
    const otherOwners = phoneOwnersAll.filter(o => {
      const eid = String(o.entity_id);
      if (o.entity_type === 'lead' && eid === String(leadId)) return false;
      if (o.entity_type === 'customer' && eid === String(customerId)) return false;
      return true;
    });

    // Active-window check
    const guard = shouldDowngradeForActiveWindow({
      leadUpdatedAt: lead.updated_at,
      customerUpdatedAt: customer.updated_at,
      activeWindowHours: ACTIVE_WINDOW_HOURS,
    });

    // Recommendation logic — conservative.
    // safe_to_apply requires ALL of:
    //   - phone match
    //   - strong name
    //   - no other owners on the phone
    //   - no open tasks on the lead
    //   - no future jobs scheduled
    //   - no recent conversations (last 7d) (could indicate active workflow)
    //   - stage not actively-managed (e.g. proposal sent / negotiation)
    //   - no active-window downgrade
    let recommendation = 'safe_to_apply';
    const recommendationReasons = [];
    if (!phoneMatch) { recommendation = 'exclude'; recommendationReasons.push('phone_mismatch'); }
    if (!isStrongName) {
      recommendation = recommendation === 'exclude' ? 'exclude' : 'review';
      recommendationReasons.push(`name_class=${nameClass}`);
    }
    if (otherOwners.length > 0) {
      recommendation = 'review';
      recommendationReasons.push(`shared_phone_with_${otherOwners.length}_other_owner(s)`);
    }
    if (openTasks.length > 0) {
      recommendation = recommendation === 'exclude' ? 'exclude' : 'review';
      recommendationReasons.push(`${openTasks.length}_open_task(s)`);
    }
    if (nextJob) {
      recommendation = recommendation === 'exclude' ? 'exclude' : 'review';
      recommendationReasons.push('future_job_scheduled');
    }
    if (recentConv && recentConv.count > 0) {
      recommendation = recommendation === 'exclude' ? 'exclude' : 'review';
      recommendationReasons.push(`${recentConv.count}_conversation(s)_in_${RECENT_DAYS}d`);
    }
    if (stageSuggestsActive && stageName && /proposal|negotiation|qualified|contacted/i.test(stageName)) {
      recommendation = recommendation === 'exclude' ? 'exclude' : 'review';
      recommendationReasons.push(`active_pipeline_stage:${stageName}`);
    }
    if (guard.downgrade) {
      recommendation = recommendation === 'exclude' ? 'exclude' : 'review';
      recommendationReasons.push(guard.reason);
    }
    if (recommendation === 'safe_to_apply' && recommendationReasons.length === 0) {
      recommendationReasons.push('no_signals_against');
    }

    packet.push({
      conflict_id: c.id,
      lead_id: leadId,
      customer_id: customerId,
      normalized_phone: c.normalized_phone,
      phone_formatted: fmtPhone(c.normalized_phone),
      lead: {
        id: leadId,
        name: `${lead.first_name || ''} ${lead.last_name || ''}`.trim() || null,
        phone: fmtPhone(lead.phone),
        source: lead.source,
        created_at: lead.created_at,
        updated_at: lead.updated_at,
        created_ago: ago(lead.created_at),
        updated_ago: ago(lead.updated_at),
        stage_id: lead.stage_id,
        stage_name: stageName,
        notes_excerpt: lead.notes ? String(lead.notes).slice(0, 120) : null,
        lead_cost: lead.lead_cost,
      },
      customer: {
        id: customerId,
        name: `${customer.first_name || ''} ${customer.last_name || ''}`.trim() || null,
        phone: fmtPhone(customer.phone),
        source: customer.source,
        created_at: customer.created_at,
        updated_at: customer.updated_at,
        created_ago: ago(customer.created_at),
        updated_ago: ago(customer.updated_at),
      },
      match: {
        name_class: nameClass,
        is_strong_name: isStrongName,
        phone_match: phoneMatch,
        active_window_downgrade: guard.downgrade,
      },
      activity: {
        open_tasks: openTasks.map(t => ({ id: t.id, status: t.status, due_date: t.due_date })),
        open_task_count: openTasks.length,
        customer_jobs: jobs ? {
          total: jobs.total_jobs,
          past: jobs.past_jobs,
          future: jobs.future_jobs,
          last_job_date: jobs.last_past_date,
        } : { total: 0, past: 0, future: 0, last_job_date: null },
        next_scheduled_job: nextJob,
        recent_conversations_last_7d: recentConv ? {
          count: recentConv.count,
          last_event_at: recentConv.last_event,
          last_event_ago: ago(recentConv.last_event),
        } : { count: 0, last_event_at: null, last_event_ago: null },
      },
      shared_phone_owners: {
        count: otherOwners.length,
        owners: otherOwners,
      },
      recommendation,
      recommendation_reasons: recommendationReasons,
    });
  }

  // 4) Summary counts
  const summary = {
    user_id: USER_ID,
    active_window_hours: ACTIVE_WINDOW_HOURS,
    recent_conversation_window_days: RECENT_DAYS,
    total: packet.length,
    safe_to_apply: packet.filter(p => p.recommendation === 'safe_to_apply').length,
    review: packet.filter(p => p.recommendation === 'review').length,
    exclude: packet.filter(p => p.recommendation === 'exclude').length,
  };

  // 5) Write JSON + markdown
  const outDir = path.join(__dirname, 'output');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  fs.writeFileSync(path.join(outDir, 'phase1-review-packet.json'),
    JSON.stringify({ summary, packet }, null, 2));

  const md = renderMarkdown(summary, packet);
  fs.writeFileSync(path.join(outDir, 'phase1-review-packet.md'), md);

  // 6) Also stdout the summary + a compact recommendation table
  console.log('===== Phase 1 Review Packet — Summary =====');
  console.log(JSON.stringify(summary, null, 2));
  console.log('\nPer-candidate recommendation:');
  for (const p of packet) {
    console.log(`  conflict ${String(p.conflict_id).padStart(3)} | lead ${String(p.lead_id).padStart(5)} → cust ${String(p.customer_id).padStart(5)} | ${p.lead.name.padEnd(22)} | ${p.recommendation.padEnd(13)} | ${p.recommendation_reasons.join(', ')}`);
  }
  console.log(`\nFull JSON:     ${path.join(outDir, 'phase1-review-packet.json')}`);
  console.log(`Markdown:      ${path.join(outDir, 'phase1-review-packet.md')}`);
}

function renderMarkdown(summary, packet) {
  const lines = [];
  lines.push(`# Phase 1 Review Packet`);
  lines.push('');
  lines.push(`**Tenant:** user_id=${summary.user_id}`);
  lines.push(`**Active-window threshold:** ${summary.active_window_hours}h`);
  lines.push(`**Recent-conversation window:** last ${summary.recent_conversation_window_days} days`);
  lines.push('');
  lines.push(`## Summary`);
  lines.push('');
  lines.push(`| | Count |`);
  lines.push(`|---|---|`);
  lines.push(`| Total candidates | ${summary.total} |`);
  lines.push(`| Recommendation: safe_to_apply | ${summary.safe_to_apply} |`);
  lines.push(`| Recommendation: review | ${summary.review} |`);
  lines.push(`| Recommendation: exclude | ${summary.exclude} |`);
  lines.push('');
  lines.push(`## Per-candidate table`);
  lines.push('');
  lines.push(`| Conflict | Lead → Customer | Name | Phone | Lead source | Cust source | Stage | Open tasks | Past jobs | Future jobs | Recent convs (${summary.recent_conversation_window_days}d) | Shared owners | Rec. |`);
  lines.push(`|---|---|---|---|---|---|---|---|---|---|---|---|---|`);
  for (const p of packet) {
    const recIcon = p.recommendation === 'safe_to_apply' ? '✅' : p.recommendation === 'review' ? '🟡' : '🔴';
    lines.push(
      `| ${p.conflict_id} | ${p.lead_id} → ${p.customer_id} | ${p.lead.name || '—'} ` +
      `| ${p.phone_formatted} ` +
      `| ${(p.lead.source || '—').slice(0, 36)} ` +
      `| ${(p.customer.source || '—').slice(0, 24)} ` +
      `| ${p.lead.stage_name || '—'} ` +
      `| ${p.activity.open_task_count} ` +
      `| ${p.activity.customer_jobs.past} ` +
      `| ${p.activity.customer_jobs.future} ` +
      `| ${p.activity.recent_conversations_last_7d.count} ` +
      `| ${p.shared_phone_owners.count} ` +
      `| ${recIcon} ${p.recommendation} |`
    );
  }
  lines.push('');
  lines.push(`## Per-candidate detail`);
  for (const p of packet) {
    const recIcon = p.recommendation === 'safe_to_apply' ? '✅' : p.recommendation === 'review' ? '🟡' : '🔴';
    lines.push('');
    lines.push(`### ${recIcon} Conflict #${p.conflict_id} — ${p.lead.name || 'unnamed'} ${p.phone_formatted}`);
    lines.push('');
    lines.push(`**Recommendation:** \`${p.recommendation}\``);
    lines.push(`**Reasons:** ${p.recommendation_reasons.join(', ')}`);
    lines.push('');
    lines.push(`**Lead #${p.lead_id}**`);
    lines.push(`- Name: \`${p.lead.name || '—'}\``);
    lines.push(`- Phone: \`${p.lead.phone}\``);
    lines.push(`- Source: \`${p.lead.source || '—'}\``);
    lines.push(`- Stage: \`${p.lead.stage_name || '—'}\``);
    lines.push(`- Created: ${p.lead.created_at} (${p.lead.created_ago})`);
    lines.push(`- Updated: ${p.lead.updated_at} (${p.lead.updated_ago})`);
    if (p.lead.notes_excerpt) lines.push(`- Notes excerpt: \`${p.lead.notes_excerpt}…\``);
    if (p.lead.lead_cost != null) lines.push(`- Lead cost: ${p.lead.lead_cost}`);
    lines.push('');
    lines.push(`**Customer #${p.customer_id}**`);
    lines.push(`- Name: \`${p.customer.name || '—'}\``);
    lines.push(`- Phone: \`${p.customer.phone}\``);
    lines.push(`- Source: \`${p.customer.source || '—'}\``);
    lines.push(`- Created: ${p.customer.created_at} (${p.customer.created_ago})`);
    lines.push(`- Updated: ${p.customer.updated_at} (${p.customer.updated_ago})`);
    lines.push('');
    lines.push(`**Match classification**`);
    lines.push(`- Name class: \`${p.match.name_class}\` (strong=${p.match.is_strong_name})`);
    lines.push(`- Phone match: \`${p.match.phone_match}\``);
    lines.push(`- Active-window downgrade: \`${p.match.active_window_downgrade}\``);
    lines.push('');
    lines.push(`**Activity signals**`);
    lines.push(`- Open tasks: ${p.activity.open_task_count}`);
    if (p.activity.open_tasks.length > 0) {
      for (const t of p.activity.open_tasks) {
        lines.push(`  - task #${t.id} status=${t.status || '—'} due=${t.due_date || '—'}`);
      }
    }
    lines.push(`- Customer jobs: total=${p.activity.customer_jobs.total} past=${p.activity.customer_jobs.past} future=${p.activity.customer_jobs.future}`);
    lines.push(`- Last past job: ${p.activity.customer_jobs.last_job_date || '—'}`);
    lines.push(`- Next scheduled job: ${p.activity.next_scheduled_job || '—'}`);
    lines.push(`- Recent conversations (last ${summary.recent_conversation_window_days}d): ${p.activity.recent_conversations_last_7d.count}` +
      (p.activity.recent_conversations_last_7d.last_event_at
        ? ` (last ${p.activity.recent_conversations_last_7d.last_event_ago})`
        : ''));
    lines.push('');
    lines.push(`**Shared-phone owners (outside this conflict)**`);
    if (p.shared_phone_owners.count === 0) {
      lines.push(`- none`);
    } else {
      for (const o of p.shared_phone_owners.owners) {
        lines.push(`  - ${o.entity_type} id=${o.entity_id} (source=${o.source || '—'} conf=${o.confidence || '—'})`);
      }
    }
    lines.push('');
  }
  return lines.join('\n');
}

main().catch(e => { console.error('FAILED:', e.message); process.exit(2); });
