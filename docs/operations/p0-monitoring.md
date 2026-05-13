# P0 Monitoring — Synchronization Constitution Surfaces

Treat `ledger_drift_detected` as a **financial integrity signal**, not just an audit table. Sustained non-zero growth means an upstream invariant is broken. The other surfaces below are early-warning indicators that complement it.

## Six required surfaces

| # | Surface | Backing query | Source | Severity threshold |
|---|---|---|---|---|
| 1 | Unresolved drift count | `SELECT COUNT(*) FROM ledger_drift_detected WHERE resolved_at IS NULL` | Supabase | Any row → review; growth >5/day → page |
| 2 | Webhook auth failures (rejects) | Loki: `\|~ "webhook_auth_failed"` | Loki | >0 with flag ON outside known operator action |
| 3 | Unsigned webhook attempts | Loki: `\|~ "ZB-auth-observe.*mode=none"` | Loki | Use the `zb-auth-readiness.js` verdict; pre-flip dashboard |
| 4 | Skipped settled rebuilds | Loki: `\|~ "preserved \\d+ settled rows"` | Loki | Track trend; non-zero is informational not error |
| 5 | Rebuild drift by job | `SELECT job_id, COUNT(*) FROM ledger_drift_detected GROUP BY job_id ORDER BY 2 DESC` | Supabase | Any single job >3 → likely incorrect upstream invoice |
| 6 | Duplicate webhook dedup hits | Loki: `\|~ "race condition avoided"` | Loki | Sustained high count = upstream sender is retrying excessively |

## Loki queries (paste into Grafana Explore)

```logql
# 1. Drift detection signal (from rebuild-time logs)
{service_name="service-flow-backend"} |~ "ledger-drift"

# 2. Webhook auth failures
{service_name="service-flow-backend"} |~ "webhook_auth_failed" | json | line_format "{{.timestamp}} reason={{.reason}}"

# 3. ZB observe-log breakdown (use with zb-auth-readiness.js for the verdict)
sum by (mode) (count_over_time({service_name="service-flow-backend"} |~ "ZB-auth-observe" | regexp "mode=(?P<mode>[^ ]+)" [5m]))

# 4. Skipped settled rebuilds (preserved rows on cancel/reset)
{service_name="service-flow-backend"} |~ "preserved [0-9]+ settled rows"

# 5. Per-job drift (Supabase, render in a Grafana panel that supports SQL,
#    or schedule scripts/ledger-snapshot-census.js as a cron to write count
#    metrics to Loki)
# SELECT job_id, COUNT(*) AS drift_count, MAX(detected_at) AS last_seen
#   FROM ledger_drift_detected WHERE resolved_at IS NULL
#   GROUP BY job_id ORDER BY 2 DESC LIMIT 50

# 6. Idempotency dedup hits (race-check fired)
{service_name="service-flow-backend"} |~ "race condition avoided|already exist for job .* skipping"
```

## Alert rules (operator-friendly thresholds)

Apply in Grafana → Alerting. All thresholds are conservative — tune per traffic.

| Alert | Expression | Threshold | Notify |
|---|---|---|---|
| **drift_growing_fast** | rate of new `ledger_drift_detected` rows | >5 in any 1h window | page on-call |
| **drift_unresolved_old** | unresolved drift row >7 days old | any | email |
| **zb_auth_unexpected_reject** | `webhook_auth_failed` count when flag should be ON | >0 in 5m | page |
| **zb_unsigned_after_flip** | `ZB-auth-observe mode=none` count after flag flip date | >0 in 1h | page |
| **rebuild_storm** | "preserved N settled rows" count | >20 in 1h | informational |
| **dedup_storm** | "race condition avoided" count | >50 in 1h | investigate (sender retry loop) |

## Grafana dashboard JSON (importable)

Save as `p0-sync-integrity.json`, import via Grafana → Dashboards → Import. Adjust `datasource` UIDs to match your Loki source.

```json
{
  "title": "P0 — Sync Integrity",
  "tags": ["sync", "constitution", "p0"],
  "schemaVersion": 38,
  "refresh": "1m",
  "time": { "from": "now-24h", "to": "now" },
  "panels": [
    {
      "type": "stat",
      "title": "ZB webhook auth — flag-on readiness (% would_pass)",
      "gridPos": { "x": 0, "y": 0, "w": 6, "h": 4 },
      "targets": [
        {
          "expr": "100 * sum(count_over_time({service_name=\"service-flow-backend\"} |~ \"ZB-auth-observe\" |~ \"mode=hmac|mode=shared_secret\" [1h])) / sum(count_over_time({service_name=\"service-flow-backend\"} |~ \"ZB-auth-observe\" [1h]))",
          "refId": "A"
        }
      ],
      "fieldConfig": { "defaults": { "unit": "percent", "thresholds": { "mode": "absolute", "steps": [ { "color": "red", "value": 0 }, { "color": "yellow", "value": 50 }, { "color": "green", "value": 99 } ] } } }
    },
    {
      "type": "stat",
      "title": "Auth rejects (last 24h)",
      "gridPos": { "x": 6, "y": 0, "w": 6, "h": 4 },
      "targets": [
        { "expr": "sum(count_over_time({service_name=\"service-flow-backend\"} |~ \"webhook_auth_failed\" [24h]))", "refId": "A" }
      ],
      "fieldConfig": { "defaults": { "thresholds": { "mode": "absolute", "steps": [ { "color": "green", "value": 0 }, { "color": "red", "value": 1 } ] } } }
    },
    {
      "type": "timeseries",
      "title": "ZB-auth-observe by mode (last 24h)",
      "gridPos": { "x": 0, "y": 4, "w": 24, "h": 6 },
      "targets": [
        { "expr": "sum by (mode) (count_over_time({service_name=\"service-flow-backend\"} |~ \"ZB-auth-observe\" | regexp \"mode=(?P<mode>[^ ]+)\" [5m]))", "refId": "A" }
      ]
    },
    {
      "type": "logs",
      "title": "Drift audit events",
      "gridPos": { "x": 0, "y": 10, "w": 24, "h": 8 },
      "targets": [
        { "expr": "{service_name=\"service-flow-backend\"} |~ \"ledger-drift|Constitution\"", "refId": "A" }
      ]
    },
    {
      "type": "timeseries",
      "title": "Preserved settled rows on cancel/reset (last 24h)",
      "gridPos": { "x": 0, "y": 18, "w": 12, "h": 6 },
      "targets": [
        { "expr": "sum(count_over_time({service_name=\"service-flow-backend\"} |~ \"preserved [0-9]+ settled rows\" [5m]))", "refId": "A" }
      ]
    },
    {
      "type": "timeseries",
      "title": "Race-check dedup hits (last 24h)",
      "gridPos": { "x": 12, "y": 18, "w": 12, "h": 6 },
      "targets": [
        { "expr": "sum(count_over_time({service_name=\"service-flow-backend\"} |~ \"race condition avoided\" [5m]))", "refId": "A" }
      ]
    }
  ]
}
```

## Daily census cron

Schedule `scripts/ledger-snapshot-census.js --json` to run hourly and pipe its output into Loki (or any time-series store). The script already emits both human + JSON formats:

```bash
SUPABASE_MGMT_TOKEN=sbp_xxx node scripts/ledger-snapshot-census.js --json
```

The `summary.drift_unresolved` / `drift_last_24h` / `drift_last_7d` fields become Loki labels you can graph. Alert when `drift_last_24h > 5`.

## What a healthy state looks like

- Drift unresolved: **0**, or stable count not growing
- Auth rejects: **0** when flag matches operator intent
- ZB-auth-observe mode breakdown: **100% none** before flip, **100% hmac/shared_secret** after
- Preserved-settled-rows: occasional, only when operators cancel paid jobs
- Race-check hits: low, only during webhook retry storms
- Dedup violations (`zenbooker_id` duplicates, ledger `(job, member, type, date)` duplicates): **0 always**

## What an unhealthy state looks like

- Drift growing >5/day: **upstream invariant broken**. Common causes:
  1. ZB invoice edits arriving after settlement → expected, surface for operator decision (compensating adjustment per §3.6)
  2. Rate table being retroactively edited → bug; investigate `team_member_pay_rates` history
  3. Multi-cleaner shrink leaving orphan settled rows → cleaner removed mid-period
- Auth-reject spike after a stable flag-on state: **upstream sender stopped signing** (key rotation? config drift?)
- Preserved-settled-rows spike with no operator action: **someone running rebuild scripts against paid history** — review who and why
- Dedup violations growing: **two webhook sources hitting the same dedup key** (e.g., a duplicate ZB account configured)

## Tie-back to constitution

| Constitution section | Monitoring signal |
|---|---|
| §3.1 immutable boundary | `preserved [N] settled rows` log lines; should never see UPDATE on `cleaner_ledger WHERE payout_batch_id IS NOT NULL` in DB audit logs |
| §3.4 batched boundary | `ledger_drift_detected` rows; absolute count = how many settled rows have known divergence |
| §3.5 rate snapshots | `scripts/ledger-snapshot-census.js` "canonical" share growth over time |
| §3.6 compensating entries | `ledger_drift_detected` resolved_at column — operator records the adjustment ID here when resolving |
| §6.1 webhook auth | Auth-reject count + readiness verdict from `zb-auth-readiness.js` |
| §6.10 cross-tenant | Look for routing-derived userId vs HMAC userId mismatch warnings |
