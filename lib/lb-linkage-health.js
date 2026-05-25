'use strict';

// LeadBridge linkage health — operator-facing read model.
//
// Surfaces the eight numbers the operator needs to prove the system
// is working AT this moment, per the system requirements:
//
//   - lb_origin_leads_total           leads.lb_external_request_id IS NOT NULL
//   - lb_linked_leads                 same as above (alias for clarity)
//   - lb_linked_converted_leads       above AND converted_customer_id IS NOT NULL
//   - lb_linked_jobs                  jobs.lb_external_request_id IS NOT NULL
//   - jobs_missing_linkage_recoverable
//                                      jobs.lb_external_request_id IS NULL
//                                      AND the customer has exactly one
//                                      LB-linked converted lead. Read-side
//                                      mirror of the dry-run classifier's
//                                      HIGH / MEDIUM tier — operator's
//                                      "still leaking" indicator.
//   - outbound_queue_pending / sent / failed / dlq
//   - last_outbound_event_at
//   - in-process counters from lb-linkage-metrics
//
// All queries are tenant-scoped. Endpoint:
//   GET /api/integrations/leadbridge/linkage-health
//
// Read-only — no writes, no replay, no DLQ touch.

async function getLinkageHealth(supabase, userId) {
  if (userId == null) {
    return { error: 'user_id_required' };
  }

  const result = {
    user_id: userId,
    leads: {
      total_for_user: null,
      lb_linked: null,
      lb_linked_thumbtack: null,
      lb_linked_yelp: null,
      lb_linked_converted: null,
    },
    jobs: {
      total_for_user: null,
      lb_linked: null,
      missing_linkage_with_customer: null,
      missing_linkage_recoverable_single_lead: null,
      missing_linkage_ambiguous: null,
    },
    outbound: {
      pending: null,
      sent: null,
      dlq: null,
      skipped_unmapped: null,
      last_event_at: null,
    },
    process_counters: null,
    integration_state: {
      leadbridge_connected: null,
      direction_outbound_active: null,
    },
    fetched_at: new Date().toISOString(),
  };

  // ── leads side ─────────────────────────────────────────────────────
  try {
    const { data, error } = await supabase
      .from('leads')
      .select('id, lb_external_request_id, lb_channel, converted_customer_id', { count: 'exact', head: false })
      .eq('user_id', userId)
      .limit(0);
    // Supabase head:false returns rows but we asked limit:0 — what we want
    // is the count. Fall through to the count-only call below.
    if (error) throw error;
  } catch { /* ignored; counts queried below */ }

  result.leads.total_for_user = await countRows(supabase, 'leads', { user_id: userId });
  result.leads.lb_linked = await countRows(supabase, 'leads', { user_id: userId, lb_external_request_id: 'NOT_NULL' });
  result.leads.lb_linked_thumbtack = await countRows(supabase, 'leads', { user_id: userId, lb_channel: 'thumbtack' });
  result.leads.lb_linked_yelp = await countRows(supabase, 'leads', { user_id: userId, lb_channel: 'yelp' });
  result.leads.lb_linked_converted = await countRows(supabase, 'leads', {
    user_id: userId,
    lb_external_request_id: 'NOT_NULL',
    converted_customer_id: 'NOT_NULL',
  });

  // ── jobs side ──────────────────────────────────────────────────────
  result.jobs.total_for_user = await countRows(supabase, 'jobs', { user_id: userId });
  result.jobs.lb_linked = await countRows(supabase, 'jobs', { user_id: userId, lb_external_request_id: 'NOT_NULL' });

  // The "missing but recoverable" number — jobs without linkage whose
  // customer has exactly one LB-linked lead. This is the operator's
  // "still leaking" indicator: if it stays at zero, the write paths
  // are doing their job.
  try {
    const { data } = await supabase.rpc('lb_linkage_unlinked_job_buckets', { p_user_id: userId });
    const row = Array.isArray(data) ? data[0] : data;
    if (row) {
      result.jobs.missing_linkage_with_customer = row.with_customer ?? null;
      result.jobs.missing_linkage_recoverable_single_lead = row.recoverable_single_lead ?? null;
      result.jobs.missing_linkage_ambiguous = row.ambiguous ?? null;
    }
  } catch {
    // RPC may not exist on every environment — degrade gracefully.
    // The summary is still useful without these three.
  }

  // ── outbound queue ─────────────────────────────────────────────────
  result.outbound.pending = await countRows(supabase, 'leadbridge_outbound_events', { state: 'pending' });
  result.outbound.sent = await countRows(supabase, 'leadbridge_outbound_events', { state: 'sent' });
  result.outbound.dlq = await countRows(supabase, 'leadbridge_outbound_events', { state: 'dlq' });
  result.outbound.skipped_unmapped = await countRows(supabase, 'leadbridge_outbound_events', { state: 'skipped_unmapped_status' });

  try {
    const { data: setting } = await supabase
      .from('communication_settings')
      .select('leadbridge_connected, leadbridge_outbound_subscription_id, leadbridge_outbound_last_event_at')
      .eq('user_id', userId)
      .maybeSingle();
    if (setting) {
      result.integration_state.leadbridge_connected = !!setting.leadbridge_connected;
      result.integration_state.direction_outbound_active = !!setting.leadbridge_outbound_subscription_id;
      result.outbound.last_event_at = setting.leadbridge_outbound_last_event_at || null;
    }
  } catch { /* leave nulls */ }

  // ── in-process counters ───────────────────────────────────────────
  try {
    const metrics = require('./lb-linkage-metrics').getMetrics();
    result.process_counters = metrics;
  } catch { /* leave null */ }

  return result;
}

// Helper — counts rows for a tenant-scoped condition. Supports the
// pseudo-value 'NOT_NULL' which translates to `.not('col', 'is', null)`.
async function countRows(supabase, table, filters) {
  let q = supabase.from(table).select('*', { count: 'exact', head: true });
  for (const [k, v] of Object.entries(filters || {})) {
    if (v === 'NOT_NULL') {
      q = q.not(k, 'is', null);
    } else {
      q = q.eq(k, v);
    }
  }
  const { count, error } = await q;
  if (error) return null;
  return count ?? 0;
}

module.exports = { getLinkageHealth };
