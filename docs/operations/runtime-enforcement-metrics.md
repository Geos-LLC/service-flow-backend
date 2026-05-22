# Runtime Enforcement Metrics Contract

**Status:** Design only. No dashboards or alerts implemented.
**Owner:** identity-v5
**Last updated:** 2026-05-22
**Companion docs:**
- [identity-replay-recovery-framework.md](identity-replay-recovery-framework.md) — replay metric semantics
- [../architecture/runtime-violation-taxonomy.md](../architecture/runtime-violation-taxonomy.md) — RV-N alert posture
- [../architecture/runtime-allowlist-design.md](../architecture/runtime-allowlist-design.md) — gate enforcement metrics
- [reconciliation-health-dashboard.md](reconciliation-health-dashboard.md) — existing dashboards
- [../architecture/identity-governance-principles.md](../architecture/identity-governance-principles.md) — observability principle (§6)

---

## 1. Why this document exists

The runtime gate, the future allow-list enforcer, and the future replay
system all produce signals that ops must be able to read. This document
specifies the **metric contract** — what each system emits, what shape
the Loki query takes, and what alert thresholds we expect.

> **Scope:** Contract only. The queries are runnable today against
> existing log lines (the gate already emits `[IdentityWriteGate]`).
> The dashboards and alerts are NOT yet built. This doc tells the
> dashboard builder what to assemble.

---

## 2. The four metric families

### 2.1 Runtime Gate metrics

What: instrumentation from `lib/identity-write-gate.js`.
Today: gate emits per-call log line; counter rates are derivable now.

| Metric | Loki query | Today's behavior | Future (Stage 3) |
|--------|-----------|-------------------|-------------------|
| Write gate evaluations / sec | `sum(rate({service_name="service-flow-backend"} \|~ "IdentityWriteGate" [5m]))` | Counts every gate call regardless of outcome | Same |
| Warn-only violation rate | `sum(rate({service_name="service-flow-backend"} \|~ "IdentityWriteGate" \| json \| metadata_complete="false" [5m]))` | Counts gate calls with incomplete metadata | Same |
| Future-block candidate rate | `sum(rate({service_name="service-flow-backend"} \|~ "IdentityWriteGate" \| json \| future_block_candidate="true" [5m]))` | Counts calls that WOULD be blocked under strict posture | Becomes "actual block rate" when posture flips |
| Unauthorized bypass attempts | `sum(rate({service_name="service-flow-backend"} \|~ "IdentityWriteGate" \| json \| source!~"<registered>" [5m]))` | Zero today (every source is in the 7-site registry) | Same; alert threshold > 0 |
| Allow-list hit ratio | `sum(rate({...} \| allowed="true" [5m])) / sum(rate({...} [5m]))` | 1.0 (always allowed today) | < 1.0 once strict posture activates |

### 2.2 Projection metrics

What: instrumentation from `lib/identity-linker.js` (`emitProjectionMetric`).
Today: emitted on every linker call.

| Metric | Loki query | Threshold |
|--------|-----------|-----------|
| Projection success rate | `sum(rate({...} \|~ "identity_graph_projection_success" [5m])) / (sum(rate({...} \|~ "identity_graph_projection" [5m])))` | < 0.95 over 1h → investigate |
| Projection retry rate | `sum(rate({...} \|~ "projection_retry" [5m]))` | > 5 / hour / tenant → page |
| Orphan projection count | Postgres query — `SELECT COUNT(*) FROM communication_participant_identities WHERE sf_lead_id IS NOT NULL AND sf_lead_id NOT IN (SELECT id FROM leads)` | > 0 → P2 incident |
| Projection divergence rate (RV-6) | Audit job emits `[ProjectionAudit] divergence_count=N` daily | > 0.5% of identity rows → identity-v5 review |

### 2.3 Replay metrics

What: instrumentation from the future replay endpoint.
Today: zero — endpoint does not exist.

| Metric | Loki query (future) | Threshold |
|--------|-----------|-----------|
| Replay success ratio | `count_over_time({...} \|~ "IdentityReplay" \| status="success" [24h]) / count_over_time({...} \|~ "IdentityReplay" [24h])` | < 0.99 → investigate (RV-5 candidates) |
| Replay rollback ratio | `count_over_time({...} \|~ "IdentityReplay" \| status="rolled_back" [7d]) / count_over_time({...} \|~ "IdentityReplay" [7d])` | > 0.05 over 7d → process review |
| Replay duplicate suppression count | `count_over_time({...} \|~ "IdentityReplay" \| outcome="idempotent" [24h])` | Informational — high counts mean replay is doing its idempotency job |
| Replay inconsistency rate (RV-5) | `count_over_time({...} \|~ "IdentityReplayInconsistency" [24h])` | > 0 → halt replay + operator review |

### 2.4 Runtime safety metrics

What: existing freeze + emergency override instrumentation.
Today: freeze metric exists (`graph_projection_skipped_frozen`).

| Metric | Loki query | Threshold |
|--------|-----------|-----------|
| Freeze activations / day | `count_over_time({...} \|~ "IDENTITY_PROJECTION_FREEZE_ACTIVATED" [24h])` | > 0 → expected only during incidents; review daily |
| Active freeze duration | `time() - max_over_time({...} \|~ "IDENTITY_PROJECTION_FREEZE_ACTIVATED" \| unwrap timestamp [24h])` | > 4h → escalation |
| Emergency overrides / day | `count_over_time({...} \|~ "IdentityWriteGate" \| decision="override" [24h])` | > 0 → daily review; > 5/day → process review |
| Rollback events / week | `count_over_time({...} \|~ "operator_rollback" [7d])` | > 1/week → process review |

---

## 3. Loki query shapes

The gate emits structured log lines in this shape:

```
[IdentityWriteGate] tenant=2 source=server.js:maybeCreateLeadFromOpenPhone target=communication_participant_identities.sf_lead_id operation=update stage=stage-4-adapter-only owner=identity-v5 future_block_candidate=true metadata_complete=true violation_class=RV-2
```

Each field is logfmt-style `key=value`. Loki's `\| json` parser interprets
these fields when the log is enriched (the LogHub client encodes the
message body as JSON). For raw text matching, use `\|~` (regex):

- All gate calls: `{service_name="service-flow-backend"} \|~ "IdentityWriteGate"`
- Per-tenant: `\|~ "IdentityWriteGate" \|~ "tenant=2"`
- Per-source: `\|~ "IdentityWriteGate" \|~ "source=server.js:maybeCreateLeadFromOpenPhone"`
- Per-violation-class: `\|~ "IdentityWriteGate" \|~ "violation_class=RV-2"`

Grouping in Grafana:

```
sum by (source) (
  rate({service_name="service-flow-backend"} |~ "IdentityWriteGate" | json [5m])
)
```

---

## 4. Grafana panel ideas

When the dashboards are built, these are the natural panels:

### Panel: "Gate activity by source"
- Type: time-series, stacked.
- Query: `sum by (source) (rate({...} \|~ "IdentityWriteGate" [5m]))`
- Use: see which transitional bypass fires most often per tenant.

### Panel: "Future-block candidates"
- Type: time-series.
- Query: `sum by (source) (rate({...} \|~ "IdentityWriteGate" \| future_block_candidate="true" [5m]))`
- Use: pre-Stage-3 sanity check — what would actually get blocked.

### Panel: "Per-tenant bypass volume"
- Type: heat map.
- Query: `sum by (tenant) (rate({...} \|~ "IdentityWriteGate" [1h]))`
- Use: identify tenants whose code paths still rely on bypasses.

### Panel: "Allow-list hit ratio"
- Type: stat (single number).
- Query: `sum(rate({...} \| allowed="true" [1h])) / sum(rate({...} [1h]))`
- Use: post-Stage-3, see how often the gate refuses.

### Panel: "Replay activity" (future)
- Type: time-series.
- Query: future replay log lines.
- Use: see replay volume; flag inconsistency rate.

### Panel: "Freeze posture" (single stat)
- Type: stat with thresholds.
- Query: `max_over_time({...} \|~ "freeze.*active" [5m])`
- Use: red when freeze is on.

---

## 5. Alert thresholds

Suggested alert rules (Prometheus / Grafana Alerting):

| Alert | Query | Threshold | Severity |
|-------|-------|-----------|----------|
| Unauthorized bypass source | gate query filtered to unknown `source=` | > 0 over 10m | P3 (daily email) |
| RV-3 cross-tenant violation | `IdentityLinkInvariantViolation` count | > 0 over 1m | P1 (page) |
| Replay inconsistency (RV-5) | `IdentityReplayInconsistency` count | > 0 over any window | P2 (Slack) |
| Projection divergence (RV-6) | daily audit row count | > 0.5% of identity rows | P3 (daily) |
| Freeze duration | active freeze time | > 4h | P2 (Slack) |
| Allow-list hit ratio drop | hit ratio change | > 5% delta over 1h | P3 (daily) |
| Emergency override volume | override count | > 5 in 24h | P2 (Slack) |
| Backfill apply-mode | `runIdentityBackfill apply_mode=true` count | > 0 outside maintenance window | P2 (Slack) |

Severity levels:

- **P1** — page on-call within 5 min.
- **P2** — Slack `#identity-ops` within 1 hr.
- **P3** — daily digest email.

---

## 6. Expected baselines

Steady-state numbers we expect once Stage 3 is fully deployed. Use these
to spot anomalies:

| Metric | Expected baseline (per day, prod) |
|--------|-----------------------------------|
| Total gate calls | 5,000 – 50,000 (scales with OP/LB/ZB volume) |
| `metadata_complete=true` ratio | > 99.9% (only governance failures fall below) |
| `future_block_candidate=true` ratio | 100% before Stage 3; should drop toward 0 as bypasses retire |
| Allow-list hit ratio (Stage 3) | 99–100% (refusals indicate a misconfigured tenant) |
| Projection success rate | > 99% |
| Freeze activations | 0 in nominal weeks |
| Emergency overrides | 0 in nominal weeks |
| Replay jobs | < 10 / week / tenant (jobs, not events) |

Significant deviations from these baselines are the things the alerts
above should catch. Tighten thresholds as actual baselines firm up.

---

## 7. What this document explicitly does NOT do

- Does not build any Grafana dashboard.
- Does not deploy any alert.
- Does not modify any existing instrumentation.
- Does not promise the future metrics will look exactly like these
  queries — minor schema changes may shift names.

This is the contract that future dashboard / alert work must satisfy.
The queries are runnable today against the gate's existing log output
(though most return small numbers because the gate just shipped).

---

## 8. Open questions

- **Tenant-level vs source-level aggregation.** Today the metrics
  aggregate by source. Adding `by (tenant)` grouping is straightforward
  in Loki but increases cardinality. TBD which views are first-class.
- **Long-term retention.** Loki defaults retain 7d. For quarterly
  governance reviews we need 90d+. Either: lower-resolution rollup, or
  separate metrics store. TBD.
- **Sampling.** Gate emits one log line per call. At 50K calls/day,
  storage cost is manageable. If it becomes a problem, sample at 10%
  for `allowed=true / metadata_complete=true` (the boring case) and
  always log the interesting outcomes.
- **Replay log line shape.** §3 of replay-recovery-framework names
  `[IdentityReplay]` but doesn't pin the exact field schema. Pin
  when the endpoint is implemented.
