# Memory-State Correction Plan

**Status:** Draft. **NOT applied to memory.** This document captures the corrections that should be made to the agent's persistent memory store once the recovery branch chain is in place. Memory updates are deferred until then so the corrected entries can point at real git branches / migration files in their final committed locations.

**Companion:** `docs/operations/identity-rollout-recovery-audit-2026-05-22.md`.

---

## 1. Why memory drifted

Each of the incorrect entries was authored during or immediately after a coding session in which a feature was *implemented locally* — but never committed, pushed, or deployed. The writer (a prior assistant session) described the **working-tree state at the time of writing** as if it were production state.

This is the failure mode the system prompt warns about:

> Memory records can become stale over time. Use memory as context for what was true at a given point in time. Before answering the user or building assumptions based solely on information in memory records, verify that the memory is still correct and up-to-date by reading the current state of the files or resources.

The recovery audit (2026-05-22) discovered the drift only because Stage 2 rollout preparation forced a side-by-side comparison of memory claims with `git log` and Supabase schema. Without that audit gate, Stage 2 would have been flag-flipped against a prod environment that lacks every dependency Stage 2 needs.

---

## 2. Rule additions for the correction file

Three discipline rules to add to a new memory entry (`feedback_memory_is_not_deployment_truth.md`). Proposed text:

```markdown
---
name: Memory is not deployment truth
description: Memory describes what was true at the moment of writing; only git + schema + Railway are authoritative for "what's deployed."
type: feedback
---

Before treating any memory claim as production state, verify against three sources of truth:

  1. `git log origin/main` and the deployed commit SHA (Railway / Vercel / S3).
  2. The actual production schema (Supabase Management API for SF).
  3. The current production env vars (Railway API for Railway services).

**Why:** the 2026-05-22 Identity Rollout Recovery exposed memory entries that confidently described Phase 0 / Phase 0.5 / Phase B-G as "shipped" when none of them were committed. The local working tree had ~1700 net inserts of uncommitted Phase 0 + 0.5 work that memory described as production state. Stage 2 rollout was minutes away from being flag-flipped against a prod environment that lacked the entire dependency stack.

**How to apply:**
  - Phrases like "shipped", "applied", "deployed", "is in prod" require source-of-truth verification before any action that depends on them.
  - "Implemented locally" ≠ "shipped." When a memory entry says feature X exists, verify the relevant SHA / table / column / endpoint actually exists in prod.
  - When memory contradicts git or schema, **trust git and schema, update memory** (per the memory protocol's "verify against current state; update or remove stale memory rather than act on it").
  - Recovery audits should run before any flag flip, migration apply, or merge to `main`.
```

---

## 3. Per-entry corrections (not applied)

For each entry that contains a drifted claim, the corrected text is below. **Apply only after the A1–A4 branch chain has been pushed**, so the corrected entries can reference the real branch names.

### 3.1 `project_identity_v5_rollout.md` — CURRENT TEXT (first paragraph)

> Phase 0 (projection layer) + Phase 0.5 (parent_lead_id + lead_origin_type + canonical_lead_id) shipped 2026-05-21 with all flags OFF. Phase 1 dry-run is unblocked and approved to run.

### 3.1.a Proposed corrected text

> **Status correction (audit 2026-05-22):** Phase 0 (projection-layer linker — `setIdentityCustomer` / `setIdentityLead` / `projectIdentityToCRM`) and Phase 0.5 (`leads.parent_lead_id` + `lead_origin_type` + `canonical_lead_id` + `createChildLeadFromLB`) are **fully implemented but NOT shipped**. As of 2026-05-22:
>
> - Local main HEAD = `origin/main` HEAD = `c658bff3` (the *scoring*-based `attemptLeadToCustomerLink` linker — not the projection layer).
> - Phase 0 + Phase 0.5 code now lives on the prepared feature-branch chain:
>     - `feature/identity-phase-0-projection-layer` (A1) — projection-layer linker + migration 048 + minimal rewires.
>     - `feature/identity-phase-0.5-lead-cardinality` (A2) — atop A1, adds lead cardinality + migration 049.
>     - `feature/identity-reconciliation-engine-stage-1` (A3) — atop A2, dark engine.
>     - `feature/identity-reconciliation-engine-stage-2` (A4) — atop A3, LB adapter.
> - Migrations 048 (`identity_link_audit`) and 049 (`leads.parent_lead_id` / `lead_origin_type` / `canonical_lead_id`) are NOT applied to prod Supabase. Operator must apply 048 before A1 deploy and 049 before A2 deploy.
>
> Phase 1 dry-run is **blocked** until A1 deploys. The dry-run depends on the projection-layer linker that A1 introduces. The original "Phase 1 unblocked" claim assumed Phase 0 was in prod; this audit shows it is not.

### 3.1.b Operational rules — also need a status note

The five operational rules (analytics interpretation briefed first; existing automations audited; etc.) stay correct in spirit. **No content change** to those rules. Append the status note above to the file's header so readers see the corrected state before reading the (still-accurate) rules.

### 3.1.c Approved rollout sequence — needs reconfirmation

The rollout sequence diagram is now obsolete because it assumes Phase 0/0.5 are in prod. Replace with:

```
Stage 0     deploy A1 Phase 0  (linker rewrite + migration 048)
Stage 0.5   deploy A2 Phase 0.5 (cardinality + migration 049)
Stage 1     deploy A3 Stage 1   (dark engine; no behaviour change)
Stage 2     deploy A4 Stage 2   (LB adapter; default flags OFF)
Phase 1     dry-run retroactive report on user_id=2          ← unblocked after Stage 0
Phase 2     apply HIGH-confidence only for user_id=2         (operator-initiated)
Phase 2.5   frontend acquisition-history UI                  (canonical detail panel + viewBy=person toggle)
Phase 2.6   staging duplicate-acquisition smoke              (cross-system replay verified)
Phase 3     limited tenant rollout — user_id=2 only          (per-tenant resolver flags + engine flag, in order from §2 of stage-2-leadbridge-adapter-plan.md)
Phase 3.5   48h+ monitor on user_id=2                        (do not widen)
Phase 4     OpenPhone adapter rollout (Stage 4 ZB / Stage 4.5 manual / Stage 5 Sigcore continue per refactor plan)
```

### 3.2 `project_identity_unification_v4.md` — CURRENT TEXT (header)

> Cross-source identity model — shared resolveIdentity, per-source CRM rules, pluggable sync adapters. All feature flags default OFF; rollout is operator-driven.

(This descriptive header is fine.)

### 3.2.a Proposed status footer to append

> **Correction note (audit 2026-05-22):**
>
> Phase A (foundation: `lib/name-normalize.js` + `lib/source-registry.js` + `lib/identity-resolver.js` + `lib/feature-flags.js` base + migration 026) is **confirmed shipped** — its tables (`communication_participant_identities`, `communication_identity_ambiguities`) are present in prod Supabase.
>
> Phases B (LB), C (OP), D (ZB), E (backfill), F (reporting), G (sync-adapter contract) — **the descriptive sections above accurately describe the *intent and code structure*, but those phases are NOT committed to `origin/main` and NOT deployed**. The wiring lives in the local working tree as part of the Phase 0 projection-layer rewrite (now on branch `feature/identity-phase-0-projection-layer` after the 2026-05-22 recovery).
>
> The env vars `IDENTITY_RESOLVER_LEADBRIDGE`, `IDENTITY_RESOLVER_OPENPHONE`, `IDENTITY_RESOLVER_ZENBOOKER`, `OPENPHONE_CONDITIONAL_LEAD_CREATION`, and `IDENTITY_BACKFILL_ENABLED` are globally `="1"` in prod env — but the code paths they would gate are NOT in prod. The flags are orphaned: they reference no live code beyond Phase A's resolver foundation. They should be left set (so the chained PR deploys flip behaviour cleanly) but understood as inert until A1 deploys.
>
> The "753 tests / 26 suites" figure in this entry reflects the staging-build at the time of writing. The current `origin/main` test count is **83 suites / 1981 tests** (per the `c658bff3` commit message). Working-tree count is **87 suites / 2076 tests** for Phase 0+0.5 work, growing to 89/2111 after Stage 2.

### 3.3 `project_identity_unification_v4.md` — phase flag inventory

The six-flag list is descriptively correct. **No change to flag names**. The "Flip order for rollout" line should be appended with:

> **Audit 2026-05-22 amendment:** flag flips are downstream of code deploy. Until A1 (Phase 0) is deployed to `origin/main`, none of these flags has any code to gate. Resolver-tied flags like `IDENTITY_RESOLVER_LEADBRIDGE` that are globally set in prod env will only take effect once A1 ships.

### 3.4 `project_cross_app_identity.md` — Sigcore platform model

This entry describes the Sigcore platform model accurately and is not in scope for identity-rollout recovery. **No corrections proposed.**

### 3.5 New entry to ADD: `feedback_memory_is_not_deployment_truth.md`

(Body per §2 above.)

---

## 4. Application discipline

When the time comes to apply these corrections:

1. **Branch chain first.** Push A1–A4 to origin so the corrected entries can reference the real branch names. Memory pointers to non-existent branches are themselves stale.

2. **One file at a time.** Apply each correction as a separate memory edit so the audit trail is clean.

3. **Re-verify each claim before applying.** Between authoring this plan and applying it, prod state could change (operator could apply migration 048 out-of-band; flags could be flipped). Re-run the §1-§4 checks from the audit document before writing the corrected text.

4. **No silent rewrites.** If a corrected entry's wording differs from this plan's proposal in any material way, update this plan first, then the memory entry.

5. **MEMORY.md index lines stay one-liners.** The corrections update the *body* of each memory file; the index entry in `MEMORY.md` can stay as-is unless its one-line summary is also wrong (none currently are at the index-line level).

---

## 5. Long-term hygiene

To prevent recurrence:

- **Rollout checklists** should include a "memory cross-check" step that compares any memory claim consumed by the checklist against current `git log` + schema + Railway env.
- **Per-PR memory updates** should be discouraged until the PR is merged and deployed. The right time to write "feature X is shipped" is after the prod deploy is verified, not after the local commit.
- **The new `feedback_memory_is_not_deployment_truth.md` entry** functions as a permanent guard: future assistants will see it and treat memory claims with appropriate scepticism.

---

## 6. What this plan does NOT do

- Does NOT touch `MEMORY.md` or any `*.md` memory file.
- Does NOT introduce new memory entries.
- Does NOT remove existing entries.

Memory will be updated only after the operator confirms the recovery branch chain is in place and that the corrected wording (above) is accurate against the chain's final layout.
