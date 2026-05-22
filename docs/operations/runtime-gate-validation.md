# Runtime Gate Validation (Stage 3 Dry-Run Simulation)

**Status:** Active. Simulation is wired and dark. No tenant impact.
**Owner:** identity-v5
**Last updated:** 2026-05-22

> **Terminology pin.** Throughout this doc:
> - **"Simulation merge"** = merging the dark, passive `simulateBlock`
>   layer (this PR). Always returns `allowed: true`. No tenant impact.
>   Allowed to proceed without a soak.
> - **"Stage 3 flip"** = activating actual runtime blocking — flipping
>   a tenant's posture to `enforced_strict` so the gate refuses writes.
>   Requires the Stage 3 *activation* PR (allow-list, posture column,
>   `IDENTITY_WRITE_GATE_ENFORCED` flag) AND a clean 14-day soak.
>
> Merging the simulation is NOT the flip.
**Companion docs:**
- [../architecture/runtime-allowlist-design.md](../architecture/runtime-allowlist-design.md) — what Stage 3 will actually do
- [../architecture/runtime-violation-taxonomy.md](../architecture/runtime-violation-taxonomy.md) — RV-N vocabulary
- [../architecture/replay-confidence-audit.md](../architecture/replay-confidence-audit.md) — replay classification
- [../architecture/transitional-bypass-heatmap.md](../architecture/transitional-bypass-heatmap.md) — current site map
- [runtime-enforcement-metrics.md](runtime-enforcement-metrics.md) — metric contract
- [stage-3-merge-readiness-audit.md](stage-3-merge-readiness-audit.md) — merge-time checklist

---

## 1. Why this document exists

Stage 3 (runtime block) is a tenant-visible change: writes that the gate
refuses will be returned to the caller as `allowed=false`. Before that
flip happens we need confidence — measured in Loki, not vibes — that the
gate would refuse the right writes and only the right writes.

The **simulation layer** of `lib/identity-write-gate.js` provides that
confidence. It computes the hypothetical Stage 3 decision for each
instrumented site and emits a second log line (`[IdentityWriteGateSimulation]`)
without ever influencing the actual return value. Operators can read the
simulation in Loki, judge whether the predicted refusals match the
expected set, and then promote tenants to enforced postures only when
the dry-run matches reality.

> **Scope:** This doc explains the simulation layer's semantics, the
> queries operators should use, and the success criteria that gate the
> Stage 3 flip. The simulation is live today; the Stage 3 flip is not.

---

## 2. How the simulation layer works

When a call site sets `simulateBlock: true` on its gate invocation:

```js
identityWriteGate.evaluateIdentityWrite({
  tenantId: userId,
  source: 'server.js:convert_lead_to_customer_endpoint',
  target: 'leads.converted_customer_id',
  operation: 'update',
  bypassStage: 'stage-2-ci-static',
  owner: 'identity-v5',
  violationClass: 'RV-2',
  simulateBlock: true,           // ← Phase 3 dry-run signal
  logger,
});
```

The gate:

1. Runs the regular evaluation (`allowed: true`, structured `[IdentityWriteGate]`
   log line) — unchanged.
2. **Additionally** computes the hypothetical Stage 3 decision via the
   pure helper `simulateBlockDecision({ source, bypassStage })`.
3. Emits a second, separately-tagged log line:

   ```
   [IdentityWriteGateSimulation] tenant=2 source=server.js:convert_lead_to_customer_endpoint
     target=leads.converted_customer_id operation=update stage=stage-2-ci-static
     owner=identity-v5 simulated_block=true
     simulated_reason=simulated_block_at_stage-2-ci-static violation_class=RV-2
   ```
4. Returns `evaluation` with `simulated_block`, `simulated_reason`,
   `simulated_stage`, `simulated_owner` populated.

**Never changes `allowed`.** That field is always `true`. The simulation
is observation-only.

---

## 3. The decision function

`simulateBlockDecision` consults a hypothetical permanent allow-list and
the canonical `BLOCK_CANDIDATE_STAGES` set:

| Input | Result | Reason |
|-------|--------|--------|
| `source` ∈ `SIMULATED_PERMANENT_ALLOWLIST` | `would_block: false` | `simulated_permanent_allowlist` |
| `bypassStage` ∉ `BLOCK_CANDIDATE_STAGES` (stage-1, stage-5, unknown) | `would_block: false` | `simulated_not_block_candidate_at_<stage>` |
| Otherwise (stage-2, stage-3, stage-4) | `would_block: true` | `simulated_block_at_<stage>` |

The hypothetical permanent allow-list mirrors
`runtime-allowlist-design.md` §2.2 "permanent" entries. As of 2026-05-22
it contains exactly one site:

```
server.js:merge_duplicate_customers
```

This list expands only via PR. Adding an entry requires a design note in
`runtime-allowlist-design.md` justifying why the site cannot ever be
refused.

---

## 4. Today's predicted dispositions

The seven instrumented sites with `simulateBlock: true`:

| Site | Stage | Predicted | Reason |
|------|-------|-----------|--------|
| `server.js:maybeCreateLeadFromOpenPhone:crm_phone_anchor_customer` | stage-4-adapter-only | `simulated_block` | block_at_stage-4 |
| `server.js:maybeCreateLeadFromOpenPhone:crm_phone_anchor_lead` | stage-4-adapter-only | `simulated_block` | block_at_stage-4 |
| `server.js:maybeCreateLeadFromOpenPhone` | stage-4-adapter-only | `simulated_block` | block_at_stage-4 |
| `server.js:convert_lead_to_customer_endpoint` | stage-2-ci-static | `simulated_block` | block_at_stage-2 |
| `server.js:merge_duplicate_customers` | stage-3-runtime-block | `simulated_allow` | permanent_allowlist |
| `lib/identity-backfill.js:backfillZenbookerCustomers` | stage-3-runtime-block | `simulated_block` | block_at_stage-3 |
| `lib/identity-backfill.js:runIdentityBackfill` | stage-3-runtime-block | `simulated_block` | block_at_stage-3 |

Six predicted blocks + one predicted allow. The single allow is the
operator merge endpoint — refusing it would break customer merge.

---

## 5. Loki queries

### 5.1 Total simulated refusal rate (per 5m)

```
sum(rate({service_name="service-flow-backend"} |~ "IdentityWriteGateSimulation" | json | simulated_block="true" [5m]))
```

This is the headline number. It tells us how many writes per minute
would be refused at Stage 3 if we flipped the switch right now. Until
tenants are promoted to enforced postures, this is the **expected**
volume of refusals on a strict-only deployment.

### 5.2 Predicted refusals by source

```
sum by (source) (rate({...} |~ "IdentityWriteGateSimulation" | json | simulated_block="true" [5m]))
```

Used to identify which sites are responsible for the bulk of predicted
refusals. Sites with steady non-zero volume are candidates for
retirement (migrate to authorised writer) before Stage 3.

### 5.3 Predicted refusals by tenant

```
sum by (tenant) (rate({...} |~ "IdentityWriteGateSimulation" | json | simulated_block="true" [5m]))
```

Per-tenant ranking of predicted refusals. The first tenant to promote
to `enforced_strict` should be one with low predicted volume *and* low
absolute counts on `unsafe` replay sites (see
`replay-confidence-audit.md`).

### 5.4 Allow-list audit

```
sum by (source) (rate({...} |~ "IdentityWriteGateSimulation" | json | simulated_block="false" [5m]))
```

Confirms the predicted-allow set matches the permanent allow-list. Any
unexpected `simulated_block=false` source is a vocabulary bug — the
site is tagged with a stage outside `BLOCK_CANDIDATE_STAGES`, or named
in the simulated allow-list when it shouldn't be.

### 5.5 Coverage check

```
sum by (source) (rate({...} |~ "IdentityWriteGate " [5m]))
  -
sum by (source) (rate({...} |~ "IdentityWriteGateSimulation" [5m]))
```

This difference should be ZERO. Any positive delta means a site is
calling the gate WITHOUT `simulateBlock: true`. The scanner's
`simulation_missing` warning catches the same gap at static-analysis
time; this query catches it at runtime in case a new site landed
without simulation enabled.

> Note: the leading space in `"IdentityWriteGate "` is intentional —
> it disambiguates the regular gate line from the `[IdentityWriteGateSimulation]`
> line which also starts with `IdentityWriteGate`.

---

## 6. Success criteria for Stage 3 flip

The Stage 3 flip = promoting a tenant to `enforced_strict` posture.
This is a *separate* PR from the simulation merge: it adds the
allow-list, the posture column, the `IDENTITY_WRITE_GATE_ENFORCED`
flag, and the per-tenant promotion ritual.

Before authoring that activation PR, all of these must be observed
in Loki for ≥14 consecutive days on the simulation:

1. **Coverage.** Query 5.5 returns zero for all sources for 14d.
2. **Predicted-block stability.** Query 5.1 has a stable baseline; no
   day-over-day deviation > 50% (excluding incidents).
3. **Predicted-allow integrity.** Query 5.4 returns exactly one source
   (`server.js:merge_duplicate_customers`). Any other entry is a
   misclassification.
4. **Replay safety.** No site classified `replay-class: unsafe`
   produces predicted refusals during a tenant's window of soak.
   (Unsafe sites should be retired or routed through operator endpoints
   before Stage 3.)
5. **Scanner clean.** `node scripts/check-identity-graph-bypass.js` reports
   zero warnings (covers the structural correctness side).

Failure to meet any criterion blocks the Stage 3 *flip* (activation
PR + posture promotion), not the simulation merge. The simulation
remains live regardless of the soak verdict — only the activation PR
is gated. See [tenant-2-soak-readiness.md](tenant-2-soak-readiness.md)
for the soak procedure and
[stage-3-merge-readiness-audit.md](stage-3-merge-readiness-audit.md)
for the (separate) simulation merge checklist.

---

## 7. What the simulation does NOT do

- **Does NOT block any write.** `allowed` is always `true`.
- **Does NOT change request latency materially.** The simulation adds
  one extra log line per gated call; no DB query, no remote call.
- **Does NOT predict the future perfectly.** The hypothetical permanent
  allow-list is curated; if Stage 3 design changes (e.g., we add an
  `operator_repoint` mode that retires `merge_duplicate_customers` as
  a bypass), the simulation must be updated to match.
- **Does NOT replace replay safety analysis.** Even a "would-block"
  prediction does not tell you whether replaying that site is safe —
  see `replay-confidence-audit.md` for that axis.

---

## 8. Verifying the simulation locally

```bash
# Verify the gate's simulation tests all pass.
npx jest tests/identity-write-gate.test.js

# Verify the scanner sees no warnings (every site has simulateBlock + tags).
node scripts/check-identity-graph-bypass.js
```

Both should be silent (or print OK). If either complains, the
simulation layer is inconsistent with the static-analysis layer — fix
before merging.

---

## 9. Rolling back the simulation

The simulation is enabled per-site via the `simulateBlock: true` flag.
If a specific site needs the simulation disabled (e.g., it generates
excessive log volume during an incident), remove `simulateBlock: true`
from the gate call. The scanner will fire `simulation_missing` warning
on that site, which is a flag for the next merge — not a runtime
blocker.

No env var, no posture flip. The simulation has no "kill switch" beyond
removing the flag from the seven call sites.

---

## 10. Open questions

- **Log volume.** Today the seven sites combined emit < 50K
  `[IdentityWriteGateSimulation]` lines/day. If we add tenants or
  sources, that number grows linearly. At ~500K/day we should consider
  sampling (drop `simulated_block=false` lines, keep `=true` lines).
- **Simulation drift.** If Stage 3 design evolves between now and the
  flip, the simulation can drift from what Stage 3 will actually do.
  Mitigation: any change to `SIMULATED_PERMANENT_ALLOWLIST` requires a
  paired update to `runtime-allowlist-design.md` §2.2 and a test in
  `tests/identity-write-gate.test.js`.
- **Per-tenant simulation.** Today the simulation is global — same
  decision for every tenant. Stage 3 will be per-tenant (the posture
  field). If we need per-tenant dry-run, we'll need a second flag
  (`simulateTenantPosture`) — TBD.
