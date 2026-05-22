# Tenant-2 Soak Readiness

**Status:** Pre-soak checklist. Tenant-2 is the canonical first-soak tenant.
**Owner:** identity-v5
**Last updated:** 2026-05-22

> **What the soak gates:** Stage 3 *activation* — flipping a tenant to
> `enforced_strict` posture so the gate actually refuses writes. The
> soak is NOT a prerequisite for merging the dark simulation layer.
> Simulation infrastructure (this branch's contents) is runtime-neutral
> and may merge + deploy independently. The soak window begins
> **after** merge + deploy.
**Companion docs:**
- [identity-rollout-governance.md](identity-rollout-governance.md) — tenant tier policy
- [runtime-gate-validation.md](runtime-gate-validation.md) — simulation semantics
- [../architecture/replay-confidence-audit.md](../architecture/replay-confidence-audit.md) — replay classification
- [../architecture/transitional-bypass-heatmap.md](../architecture/transitional-bypass-heatmap.md) — current site map
- [reconciliation-health-dashboard.md](reconciliation-health-dashboard.md) — operational baselines
- [stage-3-merge-readiness-audit.md](stage-3-merge-readiness-audit.md) — merge gate

---

## 1. Why tenant-2?

Tenant-2 is the canonical "Silver-tier" tenant that has historically
been the first to receive identity-v5 rollouts. It has:

- A clean identity-graph state (Phase A–G migrations completed without
  RV-N findings).
- The full set of integrations (LB, ZB, OP) so every transitional
  bypass actually fires in production traffic on this tenant.
- Operator coverage during business hours from the identity-v5 team
  itself.

These three properties combine into "useful soak surface" — the
simulation will exercise on real traffic, and any anomaly can be
investigated by the team without escalation.

> **Scope:** Soak prep checklist. The soak itself is not yet running.
> This doc says what must be true before we declare tenant-2 ready
> for the simulation soak window. The soak is **post-merge,
> post-deploy** — it cannot begin until the dark simulation layer is
> in production emitting `[IdentityWriteGateSimulation]` lines.
>
> **What soak success unlocks:** the Stage 3 *implementation* PR
> (allow-list, posture column, `IDENTITY_WRITE_GATE_ENFORCED` flag).
> Without a clean soak, no Stage 3 activation may proceed. With a
> clean soak, the team can author the activation PR — which carries
> its own readiness audit and its own go/no-go decision.

---

## 2. Pre-soak invariants

All of these must be true before the soak begins. Mark each item
explicitly when you verify.

### 2.1 Code state

- [ ] All 7 instrumented bypass sites carry `simulateBlock: true` on
  their `evaluateIdentityWrite()` call.
- [ ] All 7 sites carry the `@stage-3-disposition` tag in their
  metadata comment block.
- [ ] All 7 sites carry the `@replay-class` tag in their metadata
  comment block.
- [ ] `node scripts/check-identity-graph-bypass.js` reports OK
  (zero warnings).
- [ ] `npx jest tests/identity-write-gate.test.js` passes.
- [ ] `npx jest tests/check-identity-graph-bypass.test.js` passes.
- [ ] No new bypass sites added since 2026-05-22 (this doc's last
  refresh); if any, refresh the heatmap and replay audit first.

### 2.2 Observability state

- [ ] LogHub is wired to `service_name=service-flow-backend` and
  Loki is querying successfully.
- [ ] The query `{service_name="service-flow-backend"} |~ "IdentityWriteGate"`
  returns data for tenant-2.
- [ ] The query `{service_name="service-flow-backend"} |~ "IdentityWriteGateSimulation"`
  returns data for tenant-2.
- [ ] Grafana stack is alive (`info3d7b.grafana.net/api/org` returns
  200 within 30s of cold wake).

### 2.3 Reconciliation state

- [ ] Tenant-2 has zero RV-3 (cross-tenant identity write) findings
  in the last 30 days.
- [ ] Tenant-2 has zero RV-5 (replay inconsistency) findings in the
  last 30 days. (Trivially true today — replay endpoint doesn't
  exist.)
- [ ] Tenant-2 has zero ambiguity rows older than 14 days unresolved.
- [ ] Identity-row counts match expected ranges (see
  `reconciliation-health-dashboard.md` baselines).

### 2.4 Operator state

- [ ] Identity-v5 team confirms business-hours operator coverage for
  the soak window.
- [ ] `#identity-ops` Slack channel is monitored.
- [ ] Operators have read `runtime-gate-validation.md` §5 (the
  queries) and §6 (the success criteria).

---

## 3. The soak window

**Duration:** 14 consecutive calendar days (not business days).
**Trigger:** all pre-soak invariants checked off, recorded in this
file with date + initials, AND the Phase 3 PR is merged + deployed
to production for ≥1h (so simulation lines are actually flowing).
**End condition:** Day 14 review passes (see §5).

The soak is *passive* — no posture flips, no behavior changes,
nothing tenant-visible. The simulation runs automatically once the
Phase 3 PR is live; the soak is the period during which the team
agrees to *watch* it without making further changes.

**Important:** the soak gates the Stage 3 *activation* PR, not this
PR. The simulation layer is allowed to merge and deploy with no
soak. The soak's only purpose is to build confidence before
authoring the activation PR.

---

## 4. Daily soak checklist

Once per business day during the soak, an identity-v5 operator runs:

```bash
TOKEN=$(aws secretsmanager get-secret-value --secret-id geos-dashboard-tokens \
  --region us-east-1 --query 'SecretString' --output text | \
  node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).GRAFANA_SA_TOKEN))")

# Wake Grafana if asleep.
curl -s "https://info3d7b.grafana.net/api/org" -H "Authorization: Bearer $TOKEN" > /dev/null

# 1. Total simulated refusals for tenant-2 in the last 24h.
curl -s -G "https://info3d7b.grafana.net/api/datasources/proxy/7/loki/api/v1/query_range" \
  -H "Authorization: Bearer $TOKEN" \
  --data-urlencode 'query=sum(rate({service_name="service-flow-backend"} |~ "IdentityWriteGateSimulation" |~ "tenant=2" | json | simulated_block="true" [24h]))' \
  --data-urlencode 'limit=100'

# 2. By-source breakdown.
curl -s -G "https://info3d7b.grafana.net/api/datasources/proxy/7/loki/api/v1/query_range" \
  -H "Authorization: Bearer $TOKEN" \
  --data-urlencode 'query=sum by (source) (rate({service_name="service-flow-backend"} |~ "IdentityWriteGateSimulation" |~ "tenant=2" | json | simulated_block="true" [24h]))' \
  --data-urlencode 'limit=100'

# 3. Confirm permanent allow-list has the expected single entry.
curl -s -G "https://info3d7b.grafana.net/api/datasources/proxy/7/loki/api/v1/query_range" \
  -H "Authorization: Bearer $TOKEN" \
  --data-urlencode 'query=sum by (source) (rate({service_name="service-flow-backend"} |~ "IdentityWriteGateSimulation" |~ "tenant=2" | json | simulated_block="false" [24h]))' \
  --data-urlencode 'limit=100'
```

Record the daily numbers in `tenant-2-soak-log.md` (created at soak
start; not part of this PR). Look for:

- **Anomalies:** spike or drop ≥50% day-over-day on query 1.
- **Unexpected sources:** any source in query 3 that is not
  `server.js:merge_duplicate_customers`.
- **Vocabulary drift:** any simulation log line with
  `simulated_reason=unknown_*` (means the gate saw garbage input).

---

## 5. End-of-soak review

On day 14, identity-v5 team meets and walks the success criteria
from `runtime-gate-validation.md` §6:

1. **Coverage** — query 5.5 zero for 14d.
2. **Predicted-block stability** — no day-over-day ≥50% deviation.
3. **Predicted-allow integrity** — exactly one source on the allow
   list (`server.js:merge_duplicate_customers`).
4. **Replay safety** — no `unsafe`-classed site produced predicted
   refusals (they shouldn't — those sites are gated by operator
   actions; refusals would mean the OP paths cross-pollinated).
5. **Scanner clean** — `check-identity-graph-bypass.js` reports OK
   throughout.

If all five pass: tenant-2 has completed a clean soak. The team is
now cleared to author the Stage 3 *activation* PR (allow-list, posture
column, `IDENTITY_WRITE_GATE_ENFORCED` flag, per-tenant promotion).
Tenant-2 becomes the first candidate for `enforced_monitored` posture
under that follow-up PR.

If any fails: do NOT proceed to authoring the activation PR.
Investigate the failing axis, file a fix, and restart the 14-day
clock. The dark simulation layer itself remains deployed — only the
soak verdict resets.

---

## 6. What soak readiness DOES NOT mean

Passing this checklist proves the simulation layer is functioning
on tenant-2's traffic. It does NOT prove:

- Stage 3 design is correct (that's `runtime-allowlist-design.md`'s
  job).
- Replay framework is safe (that's `replay-confidence-audit.md` +
  `identity-replay-recovery-framework.md`).
- Stage 3 enforcement won't break tenant-2's traffic (that requires
  one more soak of `enforced_monitored` posture before strict).

Soak readiness is one step. The next step is the Stage 3
**implementation PR** (still future, still gated by
`runtime-allowlist-design.md` §10 migration plan).

---

## 7. Reverting if soak goes wrong

The soak has no runtime impact, so revert is trivial:

- The simulation can be disabled per-site by removing `simulateBlock: true`
  from the gate call. The scanner will fire `simulation_missing`,
  which is informational.
- No env var change, no posture change, no service restart.

There is no scenario where tenant-2 needs to be "rolled back" — the
gate doesn't change behavior. The only thing soak interruption costs
is time.

---

## 8. Open questions

- **Which other tenant should soak in parallel?** Soaking only tenant-2
  could hide tenant-specific shape issues. Candidate: tenant-7 (also
  Silver, full integration set, fewer OP events). TBD.
- **Soak length.** 14 days is the canonical period. If we observe high
  variance early, do we extend to 21d? Probably yes — but only once
  it actually happens. TBD.
- **Automated daily report.** The manual checklist in §4 is fine for
  one tenant; if we soak ≥3 tenants the daily check should be
  automated. TBD.
