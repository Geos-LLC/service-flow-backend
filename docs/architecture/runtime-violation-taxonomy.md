# Runtime Violation Taxonomy

**Status:** Stage 3 foundation — vocabulary only. No runtime enforcement.
**Owner:** identity-v5
**Last updated:** 2026-05-22
**Companion docs:**
- [identity-governance-principles.md](identity-governance-principles.md) — top-level governance
- [runtime-allowlist-design.md](runtime-allowlist-design.md) — Stage 3 enforcement design
- [retirement-stage-registry.md](retirement-stage-registry.md) — stage progression
- [../operations/runtime-enforcement-metrics.md](../operations/runtime-enforcement-metrics.md) — metric contract
- [transitional-infrastructure-registry.md](transitional-infrastructure-registry.md) — current bypass inventory

---

## 1. Why this document exists

The scanner currently classifies findings as either `error` (direct write
detected) or `warning` (metadata missing). That binary is good enough for
the lint layer but too coarse for runtime behavior: a "cross-tenant
identity write" and "missing metadata tag" are both warnings today, yet
they have completely different operational severity, blast radius, and
future runtime treatment.

This document defines a **closed seven-class taxonomy (RV-1 … RV-7)** for
runtime violations. Every bypass site declares its class via the
`@violation-class:` metadata tag. The runtime gate
(`lib/identity-write-gate.js`) echoes the class in its log line. Future
dashboards, alerts, and Stage 3 block decisions use this vocabulary.

> **Rule:** The taxonomy is closed. New classes require a PR against
> this document. Don't invent local class names.

---

## 2. The seven classes

| Class | Name | One-line meaning |
|-------|------|------------------|
| RV-1 | Missing metadata | A bypass exists but lacks one or more required tags. Governance failure, not write failure. |
| RV-2 | Direct graph write | Code writes to an identity-owned column without going through the projection linker. The classic bypass. |
| RV-3 | Cross-tenant identity write | An identity row for tenant A is mutated by code acting on behalf of tenant B. The leakage failure. |
| RV-4 | Unauthorized bypass | A `recordTransitionalBypass` call site is not in the transitional-infrastructure registry. Off-the-books bypass. |
| RV-5 | Replay inconsistency | A replay run produced a different outcome than the original event for the same idempotency key. |
| RV-6 | Projection divergence | The CRM-side projection (`leads.converted_customer_id`, etc.) disagrees with the identity row's authoritative state. |
| RV-7 | Runtime fallback escalation | A path falls back to the scoring bridge in a tenant that should already have the graph self-sufficient. |

The rest of this document expands each class.

---

## 3. RV-1 — Missing metadata

| Field | Value |
|-------|-------|
| **What it means** | A `recordTransitionalBypass(...)` call site exists, but the adjacent comment block is missing one or more of `@transitional / @owner / @retirement-stage / @observability` / (optionally) `@violation-class`. |
| **Detection today** | Static — `scripts/check-identity-graph-bypass.js` flags it as `severity: warning, kind: metadata`. |
| **Detection runtime (today)** | None. The gate evaluates `metadata_complete=false` at runtime and emits it in the log line, but this is observation-only. |
| **Severity** | Low. Governance/audit issue, not data-integrity issue. |
| **Blast radius** | Zero today (no data effect). Future: untracked bypasses block stage advancement. |
| **Runtime behavior today** | Warn-only log line. |
| **Future runtime behavior (Stage 3)** | Warn-only. Stage 3 will NOT block on missing metadata — it gates on RV-2/RV-3 instead. |
| **Alert posture** | None today. Quarterly governance review consults the scanner output. |
| **Rollback posture** | N/A (no runtime action to roll back). |

---

## 4. RV-2 — Direct graph write

| Field | Value |
|-------|-------|
| **What it means** | Code writes to an identity-owned column (`leads.converted_customer_id`, `customers.canonical_identity_id`, `communication_participant_identities.sf_*`) without going through `lib/identity-linker.js`. The single largest class of bypass we're trying to retire. |
| **Detection today** | Static — scanner with `PATTERNS` set. Direct writes inside `TRANSITIONAL_BYPASS_FILES` are expected (and must be instrumented). Direct writes elsewhere are `severity: error, kind: direct_write` and gate `--strict`. |
| **Detection runtime (today)** | The gate emits `kind=transitional_bypass source=<file:function>` via `recordTransitionalBypass`. |
| **Severity** | Medium. Data is written — divergence from the linker's audit/idempotency/cascade semantics is the risk. |
| **Blast radius** | Per-write. Each call writes one row. No multi-tenant amplification (RV-2 is the same-tenant case; cross-tenant is RV-3). |
| **Runtime behavior today** | Write proceeds. Gate emits log line. Linker is bypassed. |
| **Future runtime behavior (Stage 3)** | Gate consults per-tenant allow-list. If the tenant is on the list (legitimately allowed via operator action or scheduled migration), write proceeds. Otherwise the gate refuses; the calling code must check `evaluation.allowed` and either fall back to the linker or surface an error. |
| **Alert posture** | Per-source-prefix dashboard panel. Spike >5x baseline pages identity-v5. |
| **Rollback posture** | The audit table (`identity_link_audit`) carries `resolved_by` and previous values. A bad RV-2 write is undone by a UI unlink action that records the reversal. |

---

## 5. RV-3 — Cross-tenant identity write

| Field | Value |
|-------|-------|
| **What it means** | An identity row owned by tenant A is mutated by code running on behalf of tenant B. The textbook leakage scenario. |
| **Detection today** | Runtime — `[IdentityLinkInvariantViolation]` warn line. The linker's `applyLeadCustomerLink` and `setIdentityCustomer`/`setIdentityLead` cross-check `user_id` and refuse with a warn line. |
| **Detection runtime (Stage 3)** | Gate hard-blocks. The mismatch is detected before the write hits the DB. |
| **Severity** | Critical (P1). Customer data crossing tenants is the failure mode the merge discipline exists to prevent. |
| **Blast radius** | Potentially full tenant. One wrong write can attach person A's identity to tenant B's CRM. |
| **Runtime behavior today** | Linker refuses; warn line emitted. RAW SQL writes (which the gate now observes) DO NOT refuse today. |
| **Future runtime behavior (Stage 3)** | Gate refuses regardless of write path. Page-on-detect. |
| **Alert posture** | `count_over_time({...} \|~ "IdentityLinkInvariantViolation" [10m]) > 0` → always page. Class A incident per runbook §9. |
| **Rollback posture** | Per runbook §9 Class A: global freeze, snapshot of `identity_link_audit` for prior 7d, no automated cleanup. |

---

## 6. RV-4 — Unauthorized bypass

| Field | Value |
|-------|-------|
| **What it means** | A `recordTransitionalBypass(...)` call appears at a `source=` value that doesn't exist in `transitional-infrastructure-registry.md`. Off-the-books bypass. |
| **Detection today** | Manual — quarterly review (registry §6) walks the Loki query and confirms every `source=` is registered. |
| **Detection runtime (Stage 3)** | Gate cross-references `source` against a registered set (loaded at process start). Unknown sources warn (still don't block) but are surfaced more prominently. |
| **Severity** | Medium. The bypass might be fine; it might be malicious. Either way it should not exist without registry. |
| **Blast radius** | Same as the underlying class (usually RV-2). |
| **Runtime behavior today** | Bypass proceeds. Warn emitted. |
| **Future runtime behavior (Stage 3)** | Same as RV-2 + structured alert ("unknown source — register or remove"). |
| **Alert posture** | Daily: list of `source=` values not in registry. Email to identity-v5 if non-empty. |
| **Rollback posture** | Source is removed from code OR added to registry. No data action. |

---

## 7. RV-5 — Replay inconsistency

| Field | Value |
|-------|-------|
| **What it means** | An operator-initiated replay reproduces an event, but the outcome differs from the original ledger entry (e.g., a job got linked to a different customer the second time). |
| **Detection today** | Not detected today (replay endpoint is not yet implemented; see `identity-replay-recovery-framework.md`). |
| **Detection runtime (Stage 3)** | When replay ships: every replayed event compares result to original audit row. Mismatch emits `[IdentityReplayInconsistency]` with diff. |
| **Severity** | High. Replay is meant to be idempotent; inconsistency indicates a determinism bug. |
| **Blast radius** | Scoped to the replay window (per replay-recovery framework: tenant + ≤24h). |
| **Runtime behavior today** | N/A. |
| **Future runtime behavior (Stage 3)** | Replay halts on first inconsistency. Operator reviews diff before proceeding. |
| **Alert posture** | Replay completion summary always includes mismatch count. Non-zero blocks the operator from confirming the replay. |
| **Rollback posture** | Replay generates `resolved_by='replay'` audit rows. Rolling back the replay = reverting those audit rows + undoing their effects (same path as Class B1 in runbook §9). |

---

## 8. RV-6 — Projection divergence

| Field | Value |
|-------|-------|
| **What it means** | The CRM-side projection (`leads.converted_customer_id`, `customers.canonical_identity_id` once it exists) disagrees with the authoritative identity row. Example: identity says `sf_lead_id=42, sf_customer_id=99`, but `leads.id=42` has `converted_customer_id=NULL`. |
| **Detection today** | Quarterly audit query (planned). Not continuously detected. |
| **Detection runtime (Stage 3)** | Periodic background job (`identity-projection-audit.js`) walks identity rows and verifies projection consistency. Discrepancies recorded in `identity_link_audit` with `resolved_by='projection_audit'`. |
| **Severity** | Medium. Self-healing via `projectIdentityToCRM` is possible if the identity row is authoritative. |
| **Blast radius** | Per-row. Many simultaneous divergences = either an audit lag or a real bug in projection cascade. |
| **Runtime behavior today** | N/A. |
| **Future runtime behavior (Stage 3)** | Background job + alert. Inline write path is NOT changed (projection drift is detected after the fact, not at write time). |
| **Alert posture** | Dashboard panel: divergence count by tenant. Threshold: >0.5% of identity rows over 24h → identity-v5 review. |
| **Rollback posture** | Re-run `projectIdentityToCRM` for the affected rows. Identity row is authoritative; CRM side updates. |

---

## 9. RV-7 — Runtime fallback escalation

| Field | Value |
|-------|-------|
| **What it means** | A tenant that is supposed to have a self-sufficient identity graph falls back to the scoring bridge (`attemptScoringFallback`). Indicates the graph isn't actually self-sufficient yet for that tenant. |
| **Detection today** | Loki query: `metric=fallback_projection_bridge_success` filtered to tenants in `IDENTITY_SCORING_FALLBACK_TENANTS` opt-out list. Quarterly review per fallback-retirement-gates.md §3. |
| **Detection runtime (Stage 3)** | Same. When a tenant graduates past the "fallback expected" stage (per `fallback-retirement-gates.md`), this metric should be zero. Spikes are RV-7. |
| **Severity** | Low. Wrong-non-merge dominant outcome; nothing breaks. Indicates retirement decision was premature. |
| **Blast radius** | Per-event. Each fallback call processes one event. |
| **Runtime behavior today** | Fallback proceeds (if capability flag + tenant list both on). Metric counts the call. |
| **Future runtime behavior (Stage 3)** | When fallback is fully retired (post-§3 gate), this metric should be zero. Non-zero triggers the demotion ritual in rollout-governance §6. |
| **Alert posture** | Dashboard panel: fallback rate per tenant. Threshold: per-tenant rate > 1% / 14d after retirement decision → re-open retirement RFC. |
| **Rollback posture** | Re-enable scoring fallback for the affected tenant by re-adding to `IDENTITY_SCORING_FALLBACK_TENANTS`. Reversible in <30s via env var. |

---

## 10. Summary matrix

For ops + alert configuration at a glance:

| Class | Today's behavior | Stage 3 behavior | Alert posture | Blast radius |
|-------|------------------|------------------|---------------|--------------|
| RV-1  | Warn-only | Warn-only | Quarterly review | None |
| RV-2  | Bypass proceeds | Block unless allow-listed | 5x baseline → page | Per-write |
| RV-3  | Linker refuses; raw SQL doesn't | Hard block | Always page | Per-tenant |
| RV-4  | Warn | Warn + daily list | Daily summary | Same as underlying class |
| RV-5  | N/A | Replay halts | Per-replay summary | Replay window |
| RV-6  | N/A | Background audit | Threshold-based | Per-row |
| RV-7  | Metric only | Same — informational | Quarterly review | Per-event |

---

## 11. Cross-references

| Class | Drives | Driven by |
|-------|--------|-----------|
| RV-1 | Scanner metadata warning | Governance principles §5.3 (required tags) |
| RV-2 | Scanner direct-write error + Stage 3 gate refusal | Governance principles §2 (writers authorized) |
| RV-3 | Class A incident response | Governance principles §3.2 (no duplicate graph truth) |
| RV-4 | Quarterly registry audit | Transitional-infrastructure-registry §7 |
| RV-5 | Replay halt + operator review | Replay-recovery framework §6 |
| RV-6 | Projection audit job + auto-heal | identity-graph-refactor-plan §3 |
| RV-7 | Fallback retirement gate §3 | Fallback-retirement-gates.md §3 |

---

## 12. Adding a new class

Don't do it lightly. Seven classes covers the failure modes we have today. Before adding RV-8:

1. Write a one-paragraph description of the failure mode it captures that isn't already covered by RV-1 … RV-7.
2. Justify why it cannot be folded into an existing class.
3. Get identity-v5 owner approval.
4. PR adds the row to §2 and the full table here.
5. Scanner accepts the new tag automatically (no scanner change needed — the optional-tag check is by string match).

---

## 13. Open questions / non-classes

Things that are explicitly NOT in the taxonomy today:

- **Performance regressions** in the linker or resolver — those are ops issues, not violations.
- **Schema migrations** — handled by the migration process, not the violation taxonomy.
- **Source-side bugs** (e.g., LB delivering malformed payloads) — those are Class C incidents in runbook §9, not RV-N.
- **Auth/permission failures** — handled by middleware, not the identity gate.

These will become classes if (and only if) the codebase or ops experience forces them to.
