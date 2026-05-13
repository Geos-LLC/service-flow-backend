#!/usr/bin/env node
/**
 * Synchronization Constitution §3.5 monitoring surface — read-only census
 * of cleaner_ledger rows by snapshot tier (canonical / legacy / none).
 *
 * Output:
 *   - Per-type × per-tier × per-settled-state counts
 *   - Per-user breakdown (top 10 by row count) so operators can target
 *     specific tenants if drift starts appearing
 *   - JSON line summary at end (for cron/dashboard ingest)
 *
 * Read-only by design: SELECT only. Safe to run on staging or production.
 *
 * Usage:
 *   node scripts/ledger-snapshot-census.js [--json] [--user-id=N]
 */

'use strict';

const SUPABASE_PROJECT_REF = process.env.SUPABASE_PROJECT_REF || 'ezyhbvskbwmwgwyduqpt';
const SUPABASE_MGMT_TOKEN = process.env.SUPABASE_MGMT_TOKEN;
if (!SUPABASE_MGMT_TOKEN) {
  console.error('SUPABASE_MGMT_TOKEN env var is required (sbp_*). See memory/reference_supabase_management_api.md.');
  process.exit(2);
}

async function runQuery(sql) {
  const url = `https://api.supabase.com/v1/projects/${SUPABASE_PROJECT_REF}/database/query`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${SUPABASE_MGMT_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query: sql }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Supabase ${res.status}: ${body}`);
  }
  return res.json();
}

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const userArg = args.find(a => a.startsWith('--user-id='));
const userFilter = userArg ? ` AND user_id = ${parseInt(userArg.split('=')[1], 10)}` : '';

const TIER_EXPR = `
  CASE
    WHEN metadata ? 'hourly_rate_snapshot'
      OR metadata ? 'commission_pct_snapshot'
      OR metadata ? 'revenue_at_create'
      OR metadata ? 'hours_at_create'
      OR metadata ? 'effective_rate_date'
    THEN 'canonical'
    WHEN metadata ? 'hourly_rate'
      OR metadata ? 'commission_pct'
      OR metadata ? 'revenue'
      OR metadata ? 'hours'
      OR metadata ? 'member_count'
    THEN 'legacy'
    ELSE 'none'
  END
`;

const SQL_BY_TYPE = `
  SELECT type,
         payout_batch_id IS NOT NULL AS settled,
         ${TIER_EXPR} AS tier,
         COUNT(*) AS n
  FROM cleaner_ledger
  WHERE type IN ('earning', 'tip', 'incentive', 'cash_collected')
        ${userFilter}
  GROUP BY 1, 2, 3
  ORDER BY 1, 2, 3
`;

const SQL_BY_USER = `
  SELECT user_id,
         ${TIER_EXPR} AS tier,
         COUNT(*) AS n
  FROM cleaner_ledger
  WHERE type IN ('earning', 'tip', 'incentive', 'cash_collected')
        ${userFilter}
  GROUP BY 1, 2
  ORDER BY user_id, tier
`;

const SQL_DRIFT = `
  SELECT COUNT(*)::int AS unresolved,
         COUNT(*) FILTER (WHERE detected_at >= now() - INTERVAL '24 hours')::int AS last_24h,
         COUNT(*) FILTER (WHERE detected_at >= now() - INTERVAL '7 days')::int AS last_7d
  FROM ledger_drift_detected
  WHERE resolved_at IS NULL
`;

(async () => {
  try {
    const [byType, byUser, drift] = await Promise.all([
      runQuery(SQL_BY_TYPE),
      runQuery(SQL_BY_USER),
      runQuery(SQL_DRIFT),
    ]);

    const summary = {
      total_rows: byType.reduce((s, r) => s + Number(r.n), 0),
      by_tier: { canonical: 0, legacy: 0, none: 0 },
      by_type: {},
      drift_unresolved: drift[0]?.unresolved || 0,
      drift_last_24h: drift[0]?.last_24h || 0,
      drift_last_7d: drift[0]?.last_7d || 0,
    };

    for (const r of byType) {
      summary.by_tier[r.tier] += Number(r.n);
      const t = r.type;
      summary.by_type[t] = summary.by_type[t] || { canonical: 0, legacy: 0, none: 0, settled: 0, unbatched: 0 };
      summary.by_type[t][r.tier] += Number(r.n);
      if (r.settled) summary.by_type[t].settled += Number(r.n);
      else summary.by_type[t].unbatched += Number(r.n);
    }

    if (asJson) {
      process.stdout.write(JSON.stringify({ summary, by_type: byType, by_user: byUser }) + '\n');
      return;
    }

    // Human format
    console.log('═══ cleaner_ledger snapshot census ═══');
    console.log(`Total completion-derived rows: ${summary.total_rows}`);
    console.log();
    console.log('By snapshot tier:');
    const pct = (n) => summary.total_rows === 0 ? '0%' : `${(100 * n / summary.total_rows).toFixed(1)}%`;
    console.log(`  canonical : ${String(summary.by_tier.canonical).padStart(6)} (${pct(summary.by_tier.canonical)})`);
    console.log(`  legacy    : ${String(summary.by_tier.legacy).padStart(6)} (${pct(summary.by_tier.legacy)})`);
    console.log(`  none      : ${String(summary.by_tier.none).padStart(6)} (${pct(summary.by_tier.none)})`);
    console.log();
    console.log('By type:');
    console.log('  type           │ canon │ legacy │  none │ settled │ unbatched');
    console.log('  ───────────────┼───────┼────────┼───────┼─────────┼──────────');
    for (const [t, c] of Object.entries(summary.by_type)) {
      console.log(`  ${t.padEnd(14)} │ ${String(c.canonical).padStart(5)} │ ${String(c.legacy).padStart(6)} │ ${String(c.none).padStart(5)} │ ${String(c.settled).padStart(7)} │ ${String(c.unbatched).padStart(9)}`);
    }
    console.log();
    console.log('ledger_drift_detected:');
    console.log(`  unresolved total : ${summary.drift_unresolved}`);
    console.log(`  last 24h         : ${summary.drift_last_24h}`);
    console.log(`  last 7d          : ${summary.drift_last_7d}`);
    console.log();
    console.log('Operator interpretation:');
    console.log('  - "canonical" rows are post-P0; rebuild drift detection is fully trusted.');
    console.log('  - "legacy" rows have rate metadata but no effective_rate_date; drift detection');
    console.log('    runs but operator should compare against team_member_pay_rates if uncertain.');
    console.log('  - "none" rows (tip/incentive/cash_collected pre-P0) cannot supply a snapshot;');
    console.log('    rebuild detects drift via direct amount comparison against current job state.');
    console.log('  - If "canonical" share stops growing after P0 deploy, snapshot writes regressed.');
    console.log('  - If drift_last_24h > 0, treat as a §3.6 compensating-entry opportunity, not a bug.');
  } catch (e) {
    console.error('census failed:', e.message);
    process.exit(1);
  }
})();
