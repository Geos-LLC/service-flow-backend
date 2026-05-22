# Fallback Retirement Gates

**Status:** Numeric thresholds for retiring transitional code paths
**Owner:** identity-v5
**Last updated:** 2026-05-22
**Companion docs:**
- [transitional-infrastructure-registry.md](transitional-infrastructure-registry.md) — what's being retired
- [identity-rollout-governance.md](../operations/identity-rollout-governance.md) — who decides + when
- [identity-enforcement-roadmap.md](identity-enforcement-roadmap.md) — code-level enforcement progression
- [reconciliation-health-dashboard.md](../operations/reconciliation-health-dashboard.md) — where the metrics live

---

## 1. Purpose

The transitional infrastructure registry lists every bypass + its
"removal prerequisite" — usually a metric threshold + a soak window. This
document defines those thresholds precisely so that retirement is a data
decision, not an opinion.

> **Default posture:** If a metric is borderline, do NOT retire. Wrong
> non-merge >> wrong merge. Same logic applies here: keeping a transitional
> path one quarter longer costs little; removing it too early can lose
> auto-link rate for tenants who depended on it.

---

## 2. Gate format

Every gate has six fields:

| Field | Meaning |
|-------|---------|
| **Metric** | The exact Loki / Postgres query that produces the number. |
| **Threshold** | The number the metric must reach. |
| **Direction** | Whether the metric must be ABOVE or BELOW the threshold. |
| **Soak window** | The unbroken duration the metric must hold (resets on any violation). |
| **Tenant coverage** | What fraction of active tenants must individually pass the gate (not just the global aggregate). |
| **Observability proof** | The dashboard panel + Loki query that an operator can show in the retirement PR. |
| **Rollback posture** | What we do if the metric degrades after retirement. |

---

## 3. Gate §1 — Scoring fallback bridge retirement

Registry entry: §1.1 (`attemptScoringFallback`).

| Gate | Value |
|------|-------|
| **Metric** | Graph self-sufficiency ratio = `count(events where engine reached projection via graph alone) / count(all eligible events)` |
| **Threshold** | ≥ 0.95 |
| **Direction** | Above |
| **Soak window** | 14 unbroken days |
| **Tenant coverage** | ≥ 80% of active production tenants pass individually |
| **Observability proof** | Grafana panel: "Identity Graph Self-Sufficiency Ratio" (rolling 24h, per-tenant + global). Loki query: `sum(rate({service_name="service-flow-backend"} \|~ "identity_graph_projection_success" [5m])) / (sum(rate({service_name="service-flow-backend"} \|~ "identity_graph_projection_success" [5m])) + sum(rate({service_name="service-flow-backend"} \|~ "fallback_projection_bridge_" [5m])))` |
| **Rollback posture** | If, after retirement, the auto-link rate (a related but distinct metric) drops by ≥ 5%, restore the fallback code (revert the deletion PR). Operator can keep it dormant via `IDENTITY_SCORING_FALLBACK_ENABLED=false` while debugging. |

### Supplementary gates (all must also pass)

| Gate | Threshold |
|------|-----------|
| Fallback usage rate per tenant | < 1% of eligible events, sustained 14d |
| Fallback ambiguous-outcome rate | < 5% of fallback invocations (high ambiguous rate = graph isn't ready) |
| Fallback no-match-outcome rate | < 30% of fallback invocations (high no-match = data isn't matchable anyway) |
| Tenant maturity tier | All tenants on fallback are at Silver or Gold |

### Why these numbers

- **0.95 graph self-sufficiency:** Means the graph already handles 19 of
  every 20 eligible events without falling back. The remaining 5% are
  recovered by adapter ingestion + retroactive repair (one-shot). Below
  0.95, fallback is doing real work and shouldn't be removed.
- **80% tenant coverage:** Global aggregate can be skewed by one huge
  tenant. Per-tenant coverage prevents retiring the fallback for tenants
  who still need it.
- **14 unbroken days:** A weekly seasonality cycle plus enough buffer to
  catch a one-off bad day. Resets on any breach so we don't aggregate
  good + bad weeks into a "fine" average.

---

## 4. Gate §2 — LB legacy path retirement

Registry entry: §1.2 (`leadbridge-service.js` direct write helpers).

| Gate | Value |
|------|-------|
| **Metric** | Engine coverage rate for LB = `count(LB webhooks where path=engine) / count(all LB webhooks)` |
| **Threshold** | ≥ 0.99 |
| **Direction** | Above |
| **Soak window** | 14 unbroken days |
| **Tenant coverage** | 100% of LB-active production tenants pass individually |
| **Observability proof** | Loki: `sum by (path) (rate({service_name="service-flow-backend"} \|~ "\\[LB engine\\] path=" \| json [1h]))` — `path=engine` vs `path=legacy` per tenant. |
| **Rollback posture** | Restore the legacy path code via revert PR. Keep it dormant by removing tenants from `RECONCILIATION_ENGINE_LEADBRIDGE_TENANTS`. |

### Supplementary gates

| Gate | Threshold |
|------|-----------|
| All LB-active tenants at S3 (co-pilot) or S4 | 100% |
| Engine path causing zero new P1/P2 incidents over the soak window | strict |
| Legacy path "missing prerequisite" rate-limited warnings | < 1 per tenant per day |

### Why these numbers

- **99% (not 95%):** Legacy LB code is more dangerous than fallback —
  it owns lead writing for un-migrated tenants. We retire only when
  legacy is effectively dead, not just "mostly quiet."
- **100% tenant coverage:** No partial migrations. If any tenant still
  uses the legacy path meaningfully, it stays.

---

## 5. Gate §3 — OpenPhone direct identity link retirement

Registry entry: §1.3 (three call sites in `maybeCreateLeadFromOpenPhone`).

| Gate | Value |
|------|-------|
| **Metric** | OP engine coverage rate = `count(OP webhooks where engine.write_path='setIdentityLead'/'setIdentityCustomer') / count(all OP webhooks routed to identity-CRM linking)` |
| **Threshold** | ≥ 0.99 |
| **Direction** | Above |
| **Soak window** | 14 unbroken days |
| **Tenant coverage** | 100% of OP-active tenants |
| **Observability proof** | Loki: bypass-emission rate per source must drop to ≤ 1 per tenant per day. Query: `sum by (source) (rate({service_name="service-flow-backend"} \|~ "IdentityGraphViolation" \| json \| source =~ "server.js:maybeCreateLeadFromOpenPhone.*" [1h]))` should be near zero. |
| **Rollback posture** | Revert the OP adapter deletion. Keep direct link code dormant via `RECONCILIATION_ENGINE_OPENPHONE_TENANTS=""`. |

### Prerequisite gates (must pass BEFORE the metric gate is even relevant)

| Gate | Required |
|------|----------|
| OP engine adapter exists (`lib/op-engine-adapter.js` or equivalent) | yes |
| Adapter has tests covering all 3 bypass sites' decision paths | ≥ 90% coverage |
| OP webhook handler refactored to call the adapter | yes |

---

## 6. Gate §4 — Operator merge / convert endpoints retirement

Registry entry: §1.4.

| Gate | Value |
|------|-------|
| **Metric** | `applyLeadCustomerLink({mode:'operator_repoint'})` available + used by both endpoints |
| **Threshold** | New mode shipped + both endpoints refactored to use it |
| **Direction** | Binary (exists / doesn't exist) |
| **Soak window** | 30 days operating under the new mode without operator-reported regressions |
| **Tenant coverage** | All tenants (operator endpoints are global) |
| **Observability proof** | Loki: bypass-emission count from these two source labels drops to zero after refactor. |
| **Rollback posture** | Revert the refactor PR. Direct writes resume. |

### Why this is a binary gate (not a metric gate)

Operator endpoints are infrequent enough that metric-based gating would
take years to accumulate signal. The cleaner gate is "does the safe API
exist + is it being used."

---

## 7. Gate §5 — Historic backfill apply-mode retirement

Registry entry: §1.5.

| Gate | Value |
|------|-------|
| **Metric** | Number of tenants needing apply-mode backfill in the prior 90 days |
| **Threshold** | 0 |
| **Direction** | Below |
| **Soak window** | 90 days |
| **Tenant coverage** | N/A (operator-initiated, infrequent) |
| **Observability proof** | Postgres: `SELECT COUNT(DISTINCT user_id) FROM identity_link_audit WHERE last_hydrated_by IN ('source_projection', 'graph_projection') AND created_at > now() - interval '90 days'`. Should approach steady-state. |
| **Rollback posture** | Backfill code stays in repo as a one-shot admin endpoint (not deleted, just not auto-runnable). |

### Why a 90-day window

Backfill is a one-shot per tenant. The 90-day window catches seasonality
(quarter-close onboarding waves) without being so long that retirement
becomes asymptotic.

---

## 8. Composite gate: full transitional system retirement

When ALL of §3–§7 pass simultaneously, the transitional infrastructure
layer as a whole can graduate from Stage 1 (warn-only) to Stage 4
(adapter-only) per the enforcement roadmap.

| Composite gate | Required |
|----------------|----------|
| §3 scoring fallback gate passed | yes |
| §4 LB legacy gate passed | yes |
| §5 OP direct link gate passed | yes |
| §6 operator endpoint gate passed | yes |
| §7 backfill gate passed | yes |
| Zero `[IdentityGraphViolation] kind=transitional_bypass` events in Loki for 30d | yes |
| Zero `[IdentityGraphViolation] kind=direct_*` events in Loki for 30d | yes |
| Scanner runs clean (`--strict` exits 0) | continuously |

When this composite gate passes, the scanner's `--strict` flag becomes
the default (CI-enforced), and the `recordTransitionalBypass` emitter +
all `@transitional` annotations can be removed in a single sweep PR.

---

## 9. Operator workflow for retiring a transitional path

1. **Confirm gate(s) passed.** Read the relevant section above. Pull the
   Loki query. Paste the result into the retirement PR body.
2. **Open the retirement PR.** Title: `[Identity Retirement] §N <system-name>`.
   Body:
   - Which gate this PR satisfies
   - Soak-window evidence (link to Grafana panel covering the window)
   - Tenant-coverage breakdown
   - Rollback plan (the exact revert command)
3. **Code changes** in the PR:
   - Delete the transitional code path
   - Delete the `@transitional` metadata block
   - Move the registry entry to the "Retired" section with a date
   - Update related docs (mark this gate as `Status: Retired`)
4. **Approval:** identity-v5 owner + one other reviewer.
5. **Deploy:** Standard staging → production.
6. **Post-deploy soak:** 7 days monitoring. If any metric regression →
   immediate rollback (no debate).

---

## 10. Audit trail for retirement events

Every retirement creates:

- A PR in git history with the metric evidence
- A "Retired:" entry in `transitional-infrastructure-registry.md`
- A `[IdentityRollout] retired` log line in production (single-shot, on
  the next deploy after the PR merges)
- A Slack post in `#identity-ops` with the retired-system name + the PR link

This is the only place where "we removed a transitional path" is
recorded. Don't skip the audit trail — future engineers will want to know
when each retirement happened and what the data looked like at the time.

---

## 11. What happens to a gate that DOESN'T pass

If a gate fails its soak window twice (i.e., resets twice without ever
clearing the threshold), that's evidence the retirement plan is wrong.
Possible reasons:

- **The threshold is too aggressive.** Re-read §3's "Why these numbers"
  reasoning; consider whether 0.95 should be 0.92 etc.
- **The metric is the wrong measure.** Self-sufficiency ratio might not
  capture the actual signal of "is graph ready."
- **The transitional system is doing more work than expected.** Maybe it
  needs to stay forever.

In all cases: open a follow-up RFC. Don't quietly lower the threshold.

---

## 12. This document's own retirement

When all entries in `transitional-infrastructure-registry.md` are
retired, this document becomes purely historical. Move it to
`docs/architecture/historical/` (do not delete — the gate definitions
are valuable as precedent for future "how do we retire X" decisions).
