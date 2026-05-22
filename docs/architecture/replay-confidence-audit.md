# Replay Confidence Audit

**Status:** Per-site classification, paired with `@replay-class` tags in code.
**Owner:** identity-v5
**Last updated:** 2026-05-22
**Companion docs:**
- [../operations/identity-replay-recovery-framework.md](../operations/identity-replay-recovery-framework.md) — replay capability surface
- [runtime-allowlist-design.md](runtime-allowlist-design.md) — Stage 3 enforcement design
- [../operations/runtime-gate-validation.md](../operations/runtime-gate-validation.md) — simulation semantics
- [runtime-violation-taxonomy.md](runtime-violation-taxonomy.md) — RV-5 (replay inconsistency)
- [transitional-bypass-heatmap.md](transitional-bypass-heatmap.md) — current site map

---

## 1. Why this document exists

The replay framework defines capabilities ("replay a tenant window",
"replay one event") and idempotency invariants. It does NOT classify
each transitional bypass site by replay safety. This document does:
it enumerates every instrumented site and rates how confident we are
that replay produces a correct outcome.

Each site carries a `@replay-class:` tag in its metadata comment. This
doc is the source of truth for those classifications.

> **Scope:** Confidence assessment + classification policy. No new code,
> no behavior change.

---

## 2. The four classes

| Class | Meaning | Replay framework treatment |
|-------|---------|----------------------------|
| `safe` | Idempotent end-to-end. Same inputs → same outputs every time. | Replay freely. No operator review required for the site itself. |
| `partial` | Idempotent in steady-state, but the underlying graph or scoring set can shift between original and replay, producing a *different but valid* outcome. | Replay with `dryRun: true` first. Operator must confirm diff before applying. |
| `unsafe` | Replay can produce a materially different outcome (operator intent, irreversible side effects, link overwrites). | Replay framework MUST refuse. Operator endpoints are out of scope for replay. |
| `tbd` | Not yet classified. | Treat as `unsafe` until classified. |

These classes are intentionally coarse. Adding more granularity would
require operators to learn finer distinctions; the current set has
sharp enough boundaries that any site can be confidently placed.

---

## 3. Confidence framework

For each site we ask three questions. The answers map deterministically
to a class:

1. **Q1: Is the write a pure function of the source event?** If yes
   (i.e., same `source` + `externalId` always produces the same write),
   the site is at least `partial`.
2. **Q2: Can the graph state change between original and replay change
   the outcome?** If yes (e.g., new identity rows, new scoring matches),
   the site is `partial`, not `safe`.
3. **Q3: Does the site capture operator intent that is not stored in
   the replay event log?** If yes (operator UI clicks, free-text
   reasons, mode-switches), the site is `unsafe`.

```
Q1=N         → unsafe or tbd (depending on whether we know enough)
Q1=Y, Q2=N   → safe
Q1=Y, Q2=Y   → partial
Q3=Y         → unsafe (overrides Q1/Q2)
```

---

## 4. Per-site classification

The seven currently-instrumented bypass sites:

### 4.1 `server.js:maybeCreateLeadFromOpenPhone:crm_phone_anchor_customer`

- **Stage:** stage-4-adapter-only
- **Class:** `partial`
- **Q1 (pure):** Yes — input is the OP message + identity row.
- **Q2 (graph-dependent):** Yes — the `findCrmMatchByPhone` lookup
  consults the CRM tables. If a different customer matched the same
  phone between original and replay, the identity gets re-anchored.
- **Q3 (operator intent):** No.
- **Replay framework treatment:** allowed under `dryRun: true` with
  operator confirmation of the diff. See replay-recovery-framework §6.1.

### 4.2 `server.js:maybeCreateLeadFromOpenPhone:crm_phone_anchor_lead`

- **Stage:** stage-4-adapter-only
- **Class:** `partial`
- Same rationale as 4.1, but the lookup hits the leads table. A
  new lead could be created between original and replay, causing
  re-anchoring.

### 4.3 `server.js:maybeCreateLeadFromOpenPhone`

- **Stage:** stage-4-adapter-only
- **Class:** `partial`
- **Q1 (pure):** Yes.
- **Q2 (graph-dependent):** Yes — but in a different way. This site
  CREATES a new lead row. Replay creates ANOTHER lead row (with a
  different `id`), so the original lead is orphaned. The identity is
  re-linked to the new lead.
- **Q3 (operator intent):** No.
- **Mitigation:** replay framework should consult `identity_link_audit`
  for prior `resolved_by='automatic'` rows on the same identity. If
  present, skip with `outcome='idempotent'`.
- **Risk profile:** moderate — produces an orphan lead unless the
  framework idempotency check fires.

### 4.4 `server.js:convert_lead_to_customer_endpoint`

- **Stage:** stage-2-ci-static
- **Class:** `unsafe`
- **Q3 (operator intent):** YES. This is an operator-initiated
  endpoint — the operator clicks "Convert" in the UI. Their click is
  not in the event log; replaying it would re-fire the conversion
  without consent.
- **Replay framework treatment:** REFUSE. Replay framework MUST skip
  this site by source name. See replay-recovery-framework §6.3.

### 4.5 `server.js:merge_duplicate_customers`

- **Stage:** stage-3-runtime-block
- **Class:** `unsafe`
- **Q3 (operator intent):** YES. Operator merge action with side
  effects — the source customer is **deleted** after the merge.
- **Q1, Q2:** N/A (Q3 dominates).
- **Replay framework treatment:** REFUSE. The audit trail for merges
  is in `identity_link_audit` with `resolved_by='operator_merge'` —
  replay framework checks for this and skips.

### 4.6 `lib/identity-backfill.js:backfillZenbookerCustomers`

- **Stage:** stage-3-runtime-block
- **Class:** `safe`
- **Q1 (pure):** Yes — input is `(source='zenbooker', external_id=c.id)`.
- **Q2 (graph-dependent):** No — `resolveIdentity` is deterministic on
  `(source, externalId)`. Same input always finds the same identity row
  (or creates the same one). The `if (apply && res.identity?.id && res.identity.sf_customer_id !== c.id)` guard prevents redundant writes.
- **Q3 (operator intent):** No.
- **Replay framework treatment:** allowed.

### 4.7 `lib/identity-backfill.js:runIdentityBackfill` (apply-mode)

- **Stage:** stage-3-runtime-block
- **Class:** `safe`
- **Q1 (pure):** Yes — orchestrator over the per-source backfills.
- **Q2 (graph-dependent):** No — each phase writes only on equality
  mismatch (re-running converges to the same state).
- **Q3 (operator intent):** No (it's run from a CLI/admin endpoint
  by an operator, but the **operation itself** is the same regardless
  of who triggered it — there's no operator-specific judgment baked in).
- **Replay framework treatment:** allowed.

---

## 5. Summary

| Class | Sites | Count |
|-------|-------|-------|
| `safe` | backfillZenbookerCustomers, runIdentityBackfill | 2 |
| `partial` | maybeCreateLeadFromOpenPhone (3 variants) | 3 |
| `unsafe` | convert_lead_to_customer_endpoint, merge_duplicate_customers | 2 |
| `tbd` | (none) | 0 |

**Net:** 2 safe, 3 partial, 2 unsafe. No `tbd`. The classification
is complete for the current instrumented set.

---

## 6. Stage 3 interaction

A site's replay class and its Stage 3 disposition are **independent
axes**:

- A site can be `safe` AND `simulated_block` (the backfill sites).
- A site can be `unsafe` AND `simulated_allow` (the merge endpoint).
- A site can be `partial` AND `simulated_block` (the OP sites).

Replay class governs the replay framework. Stage 3 disposition governs
runtime enforcement. They share metadata-block real estate but answer
different questions.

---

## 7. Operator-facing rules

When operators read the replay class on a finding:

| Operator sees | What it means | What they do |
|---------------|---------------|--------------|
| `safe` | replay is idempotent | replay freely, no diff review |
| `partial` | replay can shift | run `dryRun: true`, compare, then apply |
| `unsafe` | replay is dangerous | DON'T replay. Use the operator endpoint directly. |
| `tbd` | classification missing | treat as `unsafe`. File an issue. |

This is mirrored in the runbook (§11) for the operator-facing flow.

---

## 8. Promotion / demotion of classification

A site's class is part of its code metadata. Changing it requires a PR:

- **Demotion** (e.g., `safe` → `partial`): immediate. PR + scanner pass.
  Demotion is conservative; reviewer just confirms the rationale.
- **Promotion** (e.g., `partial` → `safe`): requires a soak. The
  promoter must show 30d of clean replay runs (no RV-5 inconsistencies)
  before the class can tighten. Document the soak in the PR.

Promotions are rare. Demotions happen when we discover an edge case
that breaks an assumption (e.g., we promoted to `safe` and then found
a path where graph state could shift).

---

## 9. The `@replay-class` tag

Every instrumented bypass site MUST carry the tag:

```js
/**
 * ...
 * @replay-class: <safe | partial | unsafe | tbd>
 */
```

The scanner enforces this via the `replay_class_missing` warning. A
site without the tag is a warning, not an error — but Stage 3 merge
readiness requires zero warnings (see
`stage-3-merge-readiness-audit.md`).

---

## 10. What this document explicitly does NOT do

- Does not implement the replay framework.
- Does not test the classifications against real replays (the replay
  endpoint doesn't exist — see replay-recovery-framework.md §1).
- Does not modify runtime behavior.
- Does not address replay-budget enforcement.

When the replay framework is implemented, this doc becomes the
classification spec the framework consumes.

---

## 11. Open questions

- **Scoring-fallback class drift.** `partial` sites are partial because
  scoring can find a different match. If we make scoring deterministic
  (e.g., by tracking the scoring index version per write), the OP
  sites could promote to `safe`. TBD.
- **`partial` ratification semantics.** Does the operator review
  decide once per replay job, or once per event within the job?
  Probably per job, with the job displaying an aggregate diff. TBD.
- **Cross-site interactions.** If sites A and B are both replayed in
  one window and A's outcome affects B's lookup, are they jointly safe?
  Today's classification treats them independently. TBD.
