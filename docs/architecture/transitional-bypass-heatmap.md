# Transitional Bypass Heatmap

**Status:** Snapshot. Re-generated when the bypass set changes.
**Owner:** identity-v5
**Last updated:** 2026-05-22
**Companion docs:**
- [retirement-stage-registry.md](retirement-stage-registry.md) — stage vocabulary
- [runtime-violation-taxonomy.md](runtime-violation-taxonomy.md) — RV-N classes
- [replay-confidence-audit.md](replay-confidence-audit.md) — replay safety
- [../operations/runtime-gate-validation.md](../operations/runtime-gate-validation.md) — simulation
- [identity-governance-principles.md](identity-governance-principles.md) — top-level
- [integration-compliance-audit.md](integration-compliance-audit.md) — bypass inventory

---

## 1. Why this document exists

The bypass inventory in `integration-compliance-audit.md` lists each
transitional bypass and its justification. This document is the
**heatmap** — a single-page table that cross-references every site
against every relevant axis (stage, violation class, replay class,
Stage 3 disposition, retirement path) so the team can see at a glance:

- which sites are highest-risk
- which are next to retire
- which require the most operator vigilance during Stage 3 transition

> **Scope:** Snapshot of the seven currently-instrumented sites.
> Re-generate this document when a site is added, retired, or
> re-classified.

---

## 2. The heatmap

| # | Site | File | Stage | Class | Replay | Stage 3 | Owner | Retire-when |
|---|------|------|-------|-------|--------|---------|-------|-------------|
| 1 | `maybeCreateLeadFromOpenPhone:crm_phone_anchor_customer` | `server.js` | stage-4 | RV-2 | partial | simulated_block | identity-v5 | OP adapter on for all tenants AND identity-CRM linking routes through engine + `setIdentityCustomer` |
| 2 | `maybeCreateLeadFromOpenPhone:crm_phone_anchor_lead` | `server.js` | stage-4 | RV-2 | partial | simulated_block | identity-v5 | OP adapter on for all tenants AND lead-anchor branch routes through `setIdentityLead` |
| 3 | `maybeCreateLeadFromOpenPhone` | `server.js` | stage-4 | RV-2 | partial | simulated_block | identity-v5 | OP adapter creates leads through engine AND writes identity rows via `setIdentityLead`/`projectIdentityToCRM` only |
| 4 | `convert_lead_to_customer_endpoint` | `server.js` | stage-2 | RV-2 | unsafe | simulated_block | identity-v5 | Endpoint delegates to `applyLeadCustomerLink({mode:'operator_override'})` |
| 5 | `merge_duplicate_customers` | `server.js` | stage-3 | RV-2 | unsafe | **simulated_allow** | identity-v5 | `applyLeadCustomerLink` gains `operator_repoint` mode |
| 6 | `backfillZenbookerCustomers` | `lib/identity-backfill.js` | stage-3 | RV-2 | safe | simulated_block | identity-v5 | ZB historic data fully reconciled AND apply-mode gated behind one-shot admin endpoint |
| 7 | `runIdentityBackfill` (apply-mode) | `lib/identity-backfill.js` | stage-3 | RV-2 | safe | simulated_block | identity-v5 | All tenants completed historic backfill AND apply-mode removed from auto-runs |

**Column glossary:**

- **Stage** — retirement stage (1=observe / 2=ci-static / 3=runtime-block / 4=adapter-only / 5=remove)
- **Class** — runtime violation taxonomy (RV-N)
- **Replay** — `safe` / `partial` / `unsafe` / `tbd`
- **Stage 3** — what the dark simulation predicts when Stage 3 activates
- **Retire-when** — exact condition under which the site is removed

---

## 3. Risk read

### 3.1 Cells most worth watching

- **Site 5 — `merge_duplicate_customers` (simulated_allow, unsafe).**
  The single permanent allow-list entry. Operator-initiated merge with
  side effects (deletes source customer). Allowed under Stage 3 by
  design; replay framework refuses by design. Tight coordination
  required between gate and replay framework so neither layer relaxes
  on the other's behalf.
- **Site 4 — `convert_lead_to_customer_endpoint` (simulated_block, unsafe).**
  Operator-initiated endpoint that would refuse under Stage 3. Refusal
  is correct *if* the endpoint has been migrated to delegate to
  `applyLeadCustomerLink({mode:'operator_override'})` first. If we
  flip Stage 3 before that migration, the convert endpoint breaks for
  every tenant. **This is the highest-priority retirement.**
- **Sites 1–3 — OP paths (simulated_block, partial).**
  Three of seven sites are OP. When OP adapter retirement completes,
  these three retire together. Largest volume — these will dominate
  the simulation block rate.

### 3.2 Cells of least concern

- **Sites 6–7 — backfill (simulated_block, safe).** Backfill runs
  off the request path, in admin/CLI context. Simulated_block at
  Stage 3 simply means `runIdentityBackfill({apply:true})` would
  refuse — operators just need a one-shot admin endpoint with a
  whitelist override. Low coordination cost.

---

## 4. Distribution

### 4.1 By stage

| Stage | Count | Sites |
|-------|-------|-------|
| stage-1-observe | 0 | (none currently) |
| stage-2-ci-static | 1 | 4 |
| stage-3-runtime-block | 3 | 5, 6, 7 |
| stage-4-adapter-only | 3 | 1, 2, 3 |
| stage-5-remove | 0 | (none currently) |

### 4.2 By replay class

| Class | Count | Risk profile |
|-------|-------|--------------|
| safe | 2 | low |
| partial | 3 | medium — requires dry-run review |
| unsafe | 2 | high — replay framework must refuse |
| tbd | 0 | — |

### 4.3 By Stage 3 disposition

| Disposition | Count |
|-------------|-------|
| simulated_block | 6 |
| simulated_allow | 1 |

Pre-Stage-3 expectation: 6 of 7 sites would refuse, 1 would allow.
This sets the baseline for the Loki dashboards described in
`runtime-gate-validation.md` §5.

---

## 5. Retirement readiness ranking

Ordered most-ready (top) to least-ready (bottom):

1. **Sites 6 + 7 — backfill (safe, behind admin endpoint).** Lowest
   risk. Most teams already gate backfill behind admin auth; the work
   is documentation + one-shot endpoint plumbing.
2. **Site 4 — convert_lead_to_customer (operator endpoint).** Single
   endpoint change to delegate to `applyLeadCustomerLink`. Self-
   contained PR; testable in isolation. Should be next after backfill.
3. **Sites 1–3 — OP paths.** Block multiple tenants; depends on OP
   adapter completion. Wait for adapter milestone, then retire as a
   batch.
4. **Site 5 — merge_duplicate_customers.** Last. Requires
   `applyLeadCustomerLink` to gain `operator_repoint` mode. Lowest
   priority because the allow-list is the safety hatch.

---

## 6. Refresh procedure

This document drifts when the code changes. Refresh by:

1. Run `node scripts/check-identity-graph-bypass.js --json`.
2. For each finding under `findings: []` (should be zero — if not,
   fix metadata first), confirm it matches the heatmap row.
3. For each `identityWriteGate.evaluateIdentityWrite(...)` call in
   `server.js` and `lib/identity-backfill.js`, confirm the heatmap
   has a row.
4. Update column values from the comment block tags above each call.
5. Bump "Last updated" date.

The doc is intentionally small; the refresh is ~10 minutes.

---

## 7. Cross-references

| Question | Read |
|----------|------|
| What does each stage tag MEAN? | `retirement-stage-registry.md` |
| What does each RV-N class mean? | `runtime-violation-taxonomy.md` |
| Why classify replay as safe/partial/unsafe? | `replay-confidence-audit.md` |
| What WILL Stage 3 do? | `runtime-allowlist-design.md` |
| What does the simulation predict? | `../operations/runtime-gate-validation.md` |
| Where is each bypass documented in detail? | `integration-compliance-audit.md` |

---

## 8. Open questions

- **Heatmap automation.** This doc is hand-maintained. A script that
  parses the metadata blocks and emits the table would prevent drift.
  Low priority — the doc is small enough that hand-maintenance is
  acceptable for now.
- **Per-tenant heatmap.** Today the heatmap is global. At Stage 3, a
  per-tenant variant (which sites are blocked / which tenants soak)
  would be useful. TBD when Stage 3 lands.
- **Historic snapshots.** Should we keep diffs of the heatmap so we
  can answer "what bypasses existed on 2026-Q1"? Probably not —
  `git log` answers this without extra ceremony.
