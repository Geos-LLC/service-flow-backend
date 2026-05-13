#!/usr/bin/env node
/**
 * P0.2 — Zenbooker webhook auth flag-on readiness probe.
 *
 * Reads [ZB-auth-observe] log lines from Loki and reports flag-on readiness:
 *
 *   - How many ZB webhooks arrived in the window
 *   - What fraction carried any auth header (attempted)
 *   - What fraction would have passed (mode != none)
 *   - What fraction would have been rejected (attempted but invalid)
 *   - Whether the OFF→ON transition is safe (≥99% would pass)
 *
 * Usage:
 *   node scripts/zb-auth-readiness.js [--hours=24]
 *
 * Run periodically (cron-friendly) before flipping ZB_WEBHOOK_AUTH_REQUIRED=true
 * on staging or prod. If the "would_pass" ratio is < 99%, do NOT flip.
 */

'use strict';

const args = process.argv.slice(2);
const hoursArg = args.find(a => a.startsWith('--hours='));
const HOURS = hoursArg ? parseInt(hoursArg.split('=')[1], 10) : 24;

const AWS_SECRET_ID = 'geos-dashboard-tokens';
const LOKI_DS = 7;
const LOKI_HOST = 'info3d7b.grafana.net';

const { execSync } = require('child_process');

function getGrafanaToken() {
  const raw = execSync(
    `aws secretsmanager get-secret-value --secret-id ${AWS_SECRET_ID} --region us-east-1 --query SecretString --output text`,
    { encoding: 'utf8' }
  );
  return JSON.parse(raw).GRAFANA_SA_TOKEN;
}

async function queryLoki(token, query, start) {
  const url = new URL(`https://${LOKI_HOST}/api/datasources/proxy/${LOKI_DS}/loki/api/v1/query_range`);
  url.searchParams.set('query', query);
  url.searchParams.set('start', start);
  url.searchParams.set('limit', '5000');
  url.searchParams.set('direction', 'backward');
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Loki ${res.status}: ${await res.text()}`);
  return res.json();
}

(async () => {
  const token = getGrafanaToken();
  // Wake the instance.
  await fetch(`https://${LOKI_HOST}/api/org`, { headers: { Authorization: `Bearer ${token}` } });

  const start = ((Date.now() - HOURS * 60 * 60 * 1000) * 1e6).toString();
  const j = await queryLoki(token, '{service_name="service-flow-backend"} |~ "ZB-auth-observe"', start);
  const streams = j.data?.result || [];

  const counts = { total: 0, attempted: 0, would_pass: 0, would_reject: 0, by_mode: {}, by_reason: {}, flags: {} };
  for (const s of streams) {
    for (const [_, line] of s.values) {
      counts.total++;
      const flag = (line.match(/flag=(\w+)/) || [])[1] || 'unknown';
      const mode = (line.match(/mode=(\w+)/) || [])[1] || 'none';
      const attempted = /attempted=true/.test(line);
      const reason = (line.match(/reason=(\S+)/) || [])[1] || null;
      counts.flags[flag] = (counts.flags[flag] || 0) + 1;
      counts.by_mode[mode] = (counts.by_mode[mode] || 0) + 1;
      if (attempted) counts.attempted++;
      if (mode !== 'none') counts.would_pass++;
      else if (attempted && reason) {
        counts.would_reject++;
        counts.by_reason[reason] = (counts.by_reason[reason] || 0) + 1;
      }
    }
  }

  console.log(`═══ ZB auth flag-on readiness — last ${HOURS}h ═══`);
  console.log(`  total ZB webhooks observed: ${counts.total}`);
  console.log(`  flag state distribution   : ${JSON.stringify(counts.flags)}`);
  console.log(`  carrying any auth header  : ${counts.attempted}`);
  console.log(`  mode breakdown            : ${JSON.stringify(counts.by_mode)}`);
  console.log(`  would PASS under flag-on  : ${counts.would_pass}`);
  console.log(`  would REJECT under flag-on: ${counts.would_reject}`);
  if (Object.keys(counts.by_reason).length > 0) {
    console.log(`  reject reasons            : ${JSON.stringify(counts.by_reason)}`);
  }
  console.log();
  const pct = counts.total === 0 ? 0 : (100 * counts.would_pass / counts.total);
  console.log(`Readiness verdict:`);
  if (counts.total === 0) {
    console.log(`  ⚠ No ZB webhooks in window. Verdict NOT POSSIBLE — either no traffic`);
    console.log(`    here or [ZB-auth-observe] log line hasn't deployed yet. Verify both.`);
  } else if (pct >= 99) {
    console.log(`  ✓ ${pct.toFixed(1)}% would pass. Safe to flip ZB_WEBHOOK_AUTH_REQUIRED=true.`);
  } else if (pct > 0) {
    console.log(`  ✗ ${pct.toFixed(1)}% would pass. ${counts.total - counts.would_pass} deliveries would be rejected.`);
    console.log(`    Do NOT flip. Investigate which ZB-side webhook subscriptions are missing the secret/sig.`);
  } else {
    console.log(`  ✗ 0% would pass — ZB-side signing is NOT configured yet. Flipping the flag now`);
    console.log(`    would 401 every ZB webhook. Configure X-ZB-Signature (HMAC) or X-ZB-Secret`);
    console.log(`    in ZB webhook config, then re-run this probe.`);
  }
})().catch(e => { console.error(e.message); process.exit(1); });
