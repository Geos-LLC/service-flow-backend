# Reconciliation Health Dashboard — Contract

**Status:** Operational specification. Defines the metrics and panels that must exist before tenant-2 rollout, and the alert thresholds + retirement gates that govern the migration.
**Owner:** Identity v5 working group.
**Companion:** `identity-reconciliation-runbook.md`, `cross-source-identity-reconciliation.md`, `integration-compliance-audit.md`.

This document is a **contract** — Grafana dashboards and Loki alerts must implement these queries with these thresholds before rollout proceeds. Without these panels in place, the operator has no visibility into graph health and the migration is operating blind.

---

## 1. Required panel groups

Four groups, each with explicit Loki queries, expected thresholds, alert thresholds, and retirement gates.

### Group A — Graph Health

The identity graph is the source of truth. These panels prove the graph is producing CRM linkage successfully and at a healthy rate.

| Panel | LogQL | Expected | Alert threshold | Retirement gate (for fallback) |
|---|---|---|---|---|
| Graph projection success / hour | `sum(count_over_time({service_name="service-flow-backend"} \|= "metric=identity_graph_projection_success" [1h]))` | Non-zero with active traffic | Drops to 0 for 1h+ during business hours | Should be the dominant signal (≥ 95% of total auto-links) |
| Graph projection success / tenant / 24h | `sum by (tenant) (count_over_time({…} \|= "metric=identity_graph_projection_success" [24h]))` | One row per active tenant, non-zero | Any tenant at 0 for 24h+ with known LB/ZB traffic | Each tenant ≥ 5/day for 14d before fallback retirement |
| Fallback dependency ratio / tenant | `sum by (tenant) (count_over_time({…} \|= "metric=fallback_projection_bridge_success" [24h])) / sum by (tenant) (count_over_time({…} \|= "metric=identity_graph_projection_success" [24h]) + count_over_time({…} \|= "metric=fallback_projection_bridge_success" [24h]))` | < 0.1 (graph carries ≥90% of links) | > 0.3 for 7d (graph is failing to project for known matches) | Retirement gate: ratio < 0.05 for 14d per tenant |
| Ambiguity rate / tenant | `sum by (tenant) (count_over_time({…} \|= "metric=fallback_projection_bridge_ambiguous" [1h]))` | < 1/hr (sporadic, expected on real ambiguities) | > 5/hr for 1h+ — investigate | Should approach zero as graph hydrates |
| No-match rate (excluding opt-in-disabled) / tenant | `sum by (tenant) (count_over_time({…} \|= "metric=fallback_projection_bridge_no_match" \|!= "fallback_disabled" [1h]))` | Sporadic — most customer inserts have no matching unconverted lead | Sustained spike for tenant on opt-in list = silent regression | Stable low rate before retirement |
| Cross-tenant refusal count | `sum(count_over_time({service_name="service-flow-backend"} \|= "[IdentityLinkInvariantViolation]" [1h]))` | **0** (always) | **Any non-zero value pages on-call immediately** | n/a — invariant always holds |

### Group B — Projection Health

These panels surface invariant refusals, race conditions, and orphan rows. They prove the graph→CRM materialisation layer is enforcing its column whitelist and tenant scope.

| Panel | LogQL / SQL | Expected | Alert threshold |
|---|---|---|---|
| Projection skipped — missing lead side / tenant | `sum by (tenant) (count_over_time({…} \|= "metric=graph_projection_skipped_missing_lead" [1h]))` | Expected non-zero (ZB sync writes customer without lead) | Sustained growth > baseline (graph not hydrating from LB) |
| Projection skipped — missing customer side / tenant | `sum by (tenant) (count_over_time({…} \|= "metric=graph_projection_skipped_missing_customer" [1h]))` | Expected non-zero (LB ingest writes lead without customer) | Sustained growth > baseline (graph not hydrating from ZB) |
| Projection skipped — resolver ambiguous / tenant | `sum by (tenant) (count_over_time({…} \|= "metric=graph_projection_skipped_ambiguous" [1h]))` | < 5/hr (matches identity-runbook §12 red line) | > 5/hr — operator review queue likely growing |
| Projection skipped — frozen (global) | `sum(count_over_time({…} \|= "metric=graph_projection_skipped_frozen" [1h]))` | 0 unless intentional freeze | Any non-zero when freeze was supposed to be OFF — investigate |
| Projection skipped — refused | `sum by (tenant) (count_over_time({…} \|= "metric=graph_projection_skipped_refused" [1h]))` | < 1/day/tenant (rare invariant refusals) | > 1/day — race conditions or invariant violations |
| Projection idempotent rate | `sum (count_over_time({…} \|= "[IdentityLink]" \|= "outcome=idempotent" [5m]))` | Steady at ~10-30% of write attempts | Sudden spike — replay loop or duplicate webhook delivery |
| Orphan CRM entities | SQL: `SELECT COUNT(*) FROM customers c WHERE NOT EXISTS (SELECT 1 FROM communication_participant_identities WHERE sf_customer_id = c.id)` | Per-tenant baseline (historic) | Sudden growth — new customers not feeding the graph |
| Duplicate active identities (same phone, both with sf_customer_id) | SQL: `SELECT user_id, normalized_phone, COUNT(*) FROM communication_participant_identities WHERE sf_customer_id IS NOT NULL GROUP BY 1,2 HAVING COUNT(*) > 1` | **0** | Any > 0 — resolver missed a merge; operator triage |

### Group C — Transitional Risk

These panels track how dependent each tenant still is on the scoring fallback bridge. The numbers drive the retirement decision.

| Panel | LogQL / SQL | Expected | Alert threshold | Retirement gate |
|---|---|---|---|---|
| Fallback usage trend (7d MA) / tenant | `avg_over_time((sum by (tenant) (count_over_time({…} \|= "metric=fallback_projection_bridge_success" [1d])))[7d:1d])` | Monotonically declining once opt-in tenants reach steady-state | Sustained increase over 7d — graph regressing | < 5/day per tenant for 14d → tenant eligible for fallback opt-out |
| Tenants still dependent on fallback | SQL: `SELECT user_id FROM (SELECT user_id, COUNT(*) FILTER (WHERE last_hydrated_by = 'fallback_projection_bridge' AND updated_at > now() - interval '14 days') AS recent_fallback FROM communication_participant_identities GROUP BY user_id) t WHERE recent_fallback > 0` | Decreasing over time | List doesn't shrink for 30d — adapters not migrating | Final retirement of `attemptScoringFallback`: list empty for 30d |
| Unresolved ambiguity growth / tenant | `sum by (tenant) (count_over_time({…} \|= "communication_identity_ambiguities" \|= "insert" [1d]))` | < 5/day (matches runbook §12) | > 5/day for 7d — household-phone / business-line patterns; operator triage | Stable baseline before fallback retirement |
| `last_hydrated_by` distribution / tenant | SQL: `SELECT user_id, last_hydrated_by, COUNT(*) FROM communication_participant_identities GROUP BY 1,2 ORDER BY 1` | `graph_projection` >> `fallback_projection_bridge` once mature | Inverse ratio (more fallback than graph) for any tenant — graph hydration insufficient | `graph_projection` share ≥ 95% for retirement |

### Group D — Integration Drift

These panels detect when integrations bypass the identity graph or invent their own matching. The architectural-hardening emitter (`[IdentityGraphViolation]`) feeds this group.

| Panel | LogQL | Expected | Alert threshold |
|---|---|---|---|
| Direct converted_customer_id writes (all kinds) | `sum(count_over_time({service_name="service-flow-backend"} \|= "[IdentityGraphViolation]" \|= "kind=direct_converted_customer_id_write" [1h]))` | **0** (no live unauthorised writers) | Any non-zero — new code bypassed the linker; immediate code review |
| Direct parent_lead_id writes | `sum(count_over_time({service_name="service-flow-backend"} \|= "[IdentityGraphViolation]" \|= "kind=direct_parent_lead_id_write" [1h]))` | **0** | Any non-zero — same as above |
| Direct sf_lead_id / sf_customer_id writes | `sum(count_over_time({service_name="service-flow-backend"} \|= "[IdentityGraphViolation]" \|= "kind=direct_sf_lead_id_write" \| \|= "kind=direct_sf_customer_id_write" [1h]))` | **0** outside authorised writers | Any non-zero — investigate immediately |
| Transitional bypass count / source | `sum by (source) (count_over_time({…} \|= "[IdentityGraphViolation]" \|= "kind=transitional_bypass" [1h]))` | Known sources only: `server.js:maybeCreateLeadFromOpenPhone`, `server.js:merge_duplicate_customers`, `lib/identity-backfill.js:runIdentityBackfill` | New `source=` value — new bypass introduced; audit before merge |
| Integration bypass count / source | `sum by (source) (count_over_time({…} \|= "[IdentityGraphViolation]" \|= "kind=integration_bypass" [1h]))` | 0 (no adapter is bypassing the engine in steady state) | Non-zero — an adapter is firing without the engine |
| Operator override outside linker | `sum(count_over_time({…} \|= "[IdentityGraphViolation]" \|= "kind=operator_override_outside_linker" [1h]))` | 0 (operator UI must go through `applyLeadCustomerLink`) | Any non-zero — new operator endpoint bypassed canonical path |
| Adapter fallback count (Stage 2+ adapters) | `sum by (tenant) (count_over_time({…} \|= "[LB engine]" \|= "path=legacy" [1h]))` | 0 after Stage 2 fully rolled out (prereq chain satisfied for every tenant) | > 0 — prereq misconfiguration |

---

## 2. Loki alert configuration

Each alert is keyed to a panel above. Wire these in Grafana → Alerting:

```yaml
- name: IdentityGraph - Cross-tenant breach (PAGE)
  expr:  sum(count_over_time({service_name="service-flow-backend"} |= "[IdentityLinkInvariantViolation]" [10m])) > 0
  for:   1m
  labels: { severity: critical, page: oncall-immediate }
  annotations:
    summary: Cross-tenant identity link attempted (R1 / I1 breach)
    runbook: docs/operations/identity-reconciliation-runbook.md §3

- name: IdentityGraph - Direct write violation (PAGE)
  expr: |
    sum(count_over_time({service_name="service-flow-backend"} |= "[IdentityGraphViolation]"
      |= "kind=direct_converted_customer_id_write"
      |~ "kind=direct_parent_lead_id_write|kind=direct_sf_lead_id_write|kind=direct_sf_customer_id_write|kind=integration_bypass" [10m])) > 0
  for:   5m
  labels: { severity: critical }
  annotations:
    summary: New unauthorised direct write to graph-owned surface
    runbook: docs/architecture/identity-enforcement-roadmap.md (Stage 1 → 2 transition)

- name: IdentityGraph - Fallback dependency rising (WARN)
  expr: |
    sum by (tenant) (count_over_time({service_name="service-flow-backend"} |= "metric=fallback_projection_bridge_success" [1d]))
    / clamp_min(sum by (tenant) (count_over_time({service_name="service-flow-backend"} |= "metric=identity_graph_projection_success" [1d])
                                + count_over_time({service_name="service-flow-backend"} |= "metric=fallback_projection_bridge_success" [1d])), 1)
    > 0.3
  for:   1h
  labels: { severity: warning }
  annotations:
    summary: Tenant fallback dependency > 30% — graph hydration insufficient

- name: IdentityGraph - Ambiguity queue growth (WARN)
  expr:  sum by (tenant) (count_over_time({service_name="service-flow-backend"} |= "communication_identity_ambiguities" |= "insert" [1d])) > 5
  for:   1h
  labels: { severity: warning }
  annotations:
    summary: Tenant ambiguity-queue growth above red line (5/day)

- name: IdentityGraph - Duplicate active identities (WARN)
  expr: (set by a Supabase scheduled query → Grafana data source)
  labels: { severity: warning }
  annotations:
    summary: Two identities for same phone both linked to customers — resolver missed a merge
```

---

## 3. Retirement gates (fallback bridge)

The scoring fallback may only be **disabled for a tenant** when:

1. Group A: `graph_projection_success / (graph_projection_success + fallback_projection_bridge_success) ≥ 0.95` for that tenant for **14 consecutive days**.
2. Group A: `fallback_projection_bridge_success` count for that tenant ≤ 5/day for the same window.
3. Group C: `last_hydrated_by='fallback_projection_bridge'` row count for that tenant has not grown in the last 14d.
4. Group D: Transitional-bypass count for `source=fallback_projection_bridge*` is zero for the tenant in the same window.

The fallback may only be **fully removed** (capability flag + code) when:

5. All tenants meet criteria 1–4 above for **30 consecutive days**.
6. `IDENTITY_SCORING_FALLBACK_TENANTS` is empty in prod env.
7. LB + ZB + OP + Sigcore adapters have all been migrated to engine path.
8. Operator-confirmed architectural sign-off (metric review meeting documented).

Each criterion must be verified using the panel queries above. The operator must record the values and the date of verification in `docs/operations/fallback-retirement-log.md` (a future file, created when the first tenant qualifies).

---

## 4. Dashboard implementation checklist

Before merging A1 to main:

- [ ] Grafana dashboard `identity-reconciliation-health` exists with the four panel groups above.
- [ ] All 4 critical alerts wired (cross-tenant breach, direct-write violation, fallback dependency, ambiguity queue).
- [ ] Loki retention is ≥ 30 days for `[IdentityLink]`, `[IdentityGraphViolation]`, `[IdentityLinkInvariantViolation]` log lines (verify with: `count_over_time({service_name="service-flow-backend"} [30d])`).
- [ ] Supabase queries (orphan CRM entities, duplicate active identities, `last_hydrated_by` distribution) wired as scheduled Grafana data-source queries or reproduced as runbook snippets.
- [ ] Operator has been walked through each panel + alert + retirement-gate query so they can verify thresholds during rollout.

---

## 5. Cross-references

- Metric catalog: `cross-source-identity-reconciliation.md` §3a Observability
- Violation emitter: `lib/identity-graph-violation.js`
- Rollout checklist: `docs/operations/stage-2-rollout-checklist.md`
- Enforcement roadmap: `docs/architecture/identity-enforcement-roadmap.md`
- New-integration requirements: `docs/architecture/new-integration-requirements.md`
