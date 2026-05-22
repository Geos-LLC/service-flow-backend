# Transitional Infrastructure Registry

**Status:** Canonical registry of all transitional systems in the identity refactor
**Owner:** identity-v5
**Last updated:** 2026-05-22
**Companion docs:**
- [identity-governance-principles.md](identity-governance-principles.md) — why these bypasses are governed this way (top-level principles)
- [retirement-stage-registry.md](retirement-stage-registry.md) — closed set of stage tags every entry references
- [identity-enforcement-roadmap.md](identity-enforcement-roadmap.md) — the 4-stage roadmap (warn → CI → runtime → adapter-only)
- [fallback-retirement-gates.md](fallback-retirement-gates.md) — numeric thresholds each entry must meet to retire
- [integration-compliance-audit.md](integration-compliance-audit.md) — historical audit of bypasses (this doc supersedes §2)

---

## Purpose

Every piece of code that compromises the identity-graph-authoritative
invariant — even for legitimate transitional reasons — MUST appear in this
registry. The CI scanner enforces the structured `@transitional` comment
block at each call site; this document is the human-readable index that
operators consult when:

- A `[IdentityGraphViolation]` warn appears in production.
- Planning the retirement of a transitional code path.
- Onboarding a new engineer who asks "why is this bypass allowed?"

**If a transitional system is in the codebase but not in this registry,
that is itself a bug** — file it as a `identity-transitional-untracked`
issue.

---

## Registry format

Each entry has six fields:

| Field | What it says |
|-------|--------------|
| **System** | Human-readable name + where it lives (file path + symbol). |
| **Owner** | Team/individual responsible for retiring it. Matches `@owner:` in the code. |
| **Reason** | Why this transitional bypass is allowed today (one sentence). |
| **Scope** | What it affects (tenants, integrations, code paths). |
| **Observability** | The exact Loki query / dashboard panel that proves the bypass is being monitored. |
| **Removal prerequisite** | What needs to be true before this entry can leave the registry. |
| **Risk if removed early** | What breaks if we delete it before the prerequisite is met. |
| **Risk if kept** | What stagnates if we leave it in past its retirement date. |

---

## §1 — Transitional code paths

### 1.1 Scoring fallback bridge (`attemptScoringFallback`)

| Field | Value |
|-------|-------|
| **System** | `lib/identity-linker.js` → `attemptScoringFallback`, `scoreMatch`, `nameSimilarity`, `classifyChannel`, `findCandidateLeads` |
| **Owner** | identity-v5 |
| **Reason** | The identity graph is not yet historically complete. Removing the scoring linker globally before the graph hydrates would drop auto-link rate by an estimated 40–60% (see hybrid-bridge discussion in `cross-source-identity-reconciliation.md` §3a). |
| **Scope** | Per-tenant. Active only when BOTH `IDENTITY_SCORING_FALLBACK_ENABLED=true` AND tenant id is in `IDENTITY_SCORING_FALLBACK_TENANTS`. |
| **Observability** | Loki: `{service_name="service-flow-backend"} \|~ "fallback_projection_bridge_" \| json` — three counter metrics (`success`, `ambiguous`, `no_match`) per `lib/identity-linker.js` METRICS catalog. |
| **Removal prerequisite** | See `fallback-retirement-gates.md` §1. Headline: graph self-sufficiency ratio ≥ 0.95 for 14 unbroken days, across ≥80% of active tenants. |
| **Risk if removed early** | Auto-link rate collapses; tenants see leads + customers as separate entities even when they're obviously the same person. CSAT impact + manual ops overhead. |
| **Risk if kept** | Scoring code drifts from canonical engine behaviour; future engineers introduce flag-branching elsewhere thinking fallback is part of the contract; provenance audit becomes noisier. |

### 1.2 LB legacy path (`leadbridge-service.js` direct write helpers)

| Field | Value |
|-------|-------|
| **System** | `leadbridge-service.js` → `createLeadFromLB`, `createChildLeadFromLB`, `enrichLeadFromLB` (the LB webhook-handler functions that pre-date the engine) |
| **Owner** | identity-v5 + leadbridge-platform |
| **Reason** | LB engine adapter (`lib/lb-engine-adapter.js`) is dark code. Legacy path is the only writer for any tenant not in `RECONCILIATION_ENGINE_LEADBRIDGE_TENANTS` (which is empty in production). |
| **Scope** | All tenants until LB adapter is enabled per-tenant. Per-tenant flag chain: `RECONCILIATION_ENGINE_LEADBRIDGE_ENABLED` + `IDENTITY_REVERSE_LINK_ENABLED` + `LEAD_CARDINALITY_CHILD_LEADS_TENANTS`. |
| **Observability** | Loki: `{service_name="service-flow-backend"} \|~ "\\[LB engine\\] path=" \| json` — every LB webhook emits either `path=legacy` or `path=engine` with reason. Missing-prerequisite warnings are rate-limited. |
| **Removal prerequisite** | All production tenants in `RECONCILIATION_ENGINE_LEADBRIDGE_TENANTS` at S3 (co-pilot) for 14d, AND legacy path responsible for < 1% of LB webhook outcomes for those tenants. |
| **Risk if removed early** | Tenants not yet on the engine lose LB integration entirely. |
| **Risk if kept** | Two parallel writers; semantics can drift; engine bug fixes don't apply to legacy path; on-call burden when a tenant is half-migrated. |

### 1.3 OpenPhone direct identity link (3 call sites in `server.js:maybeCreateLeadFromOpenPhone`)

| Field | Value |
|-------|-------|
| **System** | `server.js:maybeCreateLeadFromOpenPhone` — three branches that write `sf_lead_id` / `sf_customer_id` on identity rows directly, bypassing `setIdentityLead` / `setIdentityCustomer`. Sites: `crm_phone_anchor_customer`, `crm_phone_anchor_lead`, post-create lead anchor. |
| **Owner** | identity-v5 |
| **Reason** | No OP engine adapter exists yet. OP webhook handler does its own (correct) identity → CRM linking inline. Stage 4 OP adapter is planned. |
| **Scope** | All tenants on OP. Always-on. |
| **Observability** | Loki: `{service_name="service-flow-backend"} \|~ "IdentityGraphViolation" \| json \| kind="transitional_bypass" \| source =~ "server.js:maybeCreateLeadFromOpenPhone.*"`. |
| **Removal prerequisite** | OP engine adapter shipped (analogue of `lib/lb-engine-adapter.js`), per-tenant enable list populated, OP webhook handler routes identity-CRM linking through the engine. |
| **Risk if removed early** | OP-originated leads/customers fail to attach to identity rows; downstream pipelines see "orphan" identities. |
| **Risk if kept** | Engine never becomes the single writer for OP; testing complexity stays high; new OP features have to be implemented twice (engine vs inline). |

### 1.4 Operator merge / convert endpoints (`server.js:merge_duplicate_customers`, `convert_lead_to_customer_endpoint`)

| Field | Value |
|-------|-------|
| **System** | `server.js:merge_duplicate_customers` (writes `leads.converted_customer_id` directly to repoint a merged customer's leads). `server.js:convert_lead_to_customer_endpoint` (writes `leads.converted_customer_id` to mark a lead as converted). |
| **Owner** | identity-v5 + operator-tools |
| **Reason** | `applyLeadCustomerLink` refuses to overwrite an already-linked lead by design (safety). Operator-initiated merge legitimately needs to repoint; convert legitimately needs to set the link for the first time. Both currently route around the linker. |
| **Scope** | All tenants. Operator-initiated only (auth-gated UI endpoints). |
| **Observability** | Loki: `{service_name="service-flow-backend"} \|~ "IdentityGraphViolation" \| json \| kind="transitional_bypass" \| source =~ "server.js:(merge_duplicate_customers\|convert_lead_to_customer_endpoint)"`. |
| **Removal prerequisite** | `applyLeadCustomerLink` extended with an `operator_repoint` mode that permits overwriting an existing `converted_customer_id` under audit + reason code. Then both endpoints delegate to the linker. |
| **Risk if removed early** | Operator UIs break (merge fails silently or convert leaves leads unlinked). |
| **Risk if kept** | Two write paths to the same column; audit trail is split between linker and direct-write sites. |

### 1.5 Historic backfill apply-mode (`lib/identity-backfill.js`)

| Field | Value |
|-------|-------|
| **System** | `lib/identity-backfill.js` → `runIdentityBackfill` (apply-mode emits one bypass per run) + `backfillZenbookerCustomers` (per-row bypass for direct `sf_customer_id` writes) |
| **Owner** | identity-v5 |
| **Reason** | Backfill writes `sf_customer_id` / `sf_lead_id` on identity rows directly from historic data. Routing through `setIdentityCustomer` / `setIdentityLead` would no-op because there's no fresh source event to drive the projection cascade. |
| **Scope** | All tenants with un-reconciled historic data. Operator-initiated only (apply mode is gated behind `--apply` flag). |
| **Observability** | Loki: `{service_name="service-flow-backend"} \|~ "IdentityGraphViolation" \| json \| kind="transitional_bypass" \| source =~ "lib/identity-backfill.js:.*"`. |
| **Removal prerequisite** | All tenants have completed historic backfill (one-shot) AND `apply` mode is removed from any auto-run (kept only as a one-shot admin endpoint). |
| **Risk if removed early** | Tenants who later need a fresh historic-data reconcile (e.g. ZB account rotation) lose their tool. |
| **Risk if kept** | New engineers think backfill is a continuous process; "I'll just run backfill" becomes a casual fix instead of a deliberate one-shot. |

---

## §2 — Transitional data columns

### 2.1 `communication_participant_identities.last_hydrated_by`

| Field | Value |
|-------|-------|
| **System** | Column on `communication_participant_identities` (migration 048). Closed enum: `graph_projection \| fallback_projection_bridge \| operator_override \| retroactive_repair \| ambiguity_resolution \| source_projection`. |
| **Owner** | identity-v5 |
| **Reason** | Observability — answers "why was this identity last touched?" without a JOIN to the audit table. |
| **Scope** | All identity rows. |
| **Observability** | Postgres queries on `last_hydrated_by` for distribution audits. Never branched on in code. |
| **Removal prerequisite** | This column is permanent. Listed here only because it carries provenance about transitional code paths (e.g. `fallback_projection_bridge`). When fallback is retired, that enum value becomes inert but the column stays. |
| **Risk if removed early** | Lose forensic ability to ask "how often was each writer the last to touch this identity?" — useful for fallback-retirement reasoning. |
| **Risk if kept** | None — observational only, never branched on. Pure data. |

### 2.2 `leads.parent_lead_id` + `leads.lead_origin_type` + `leads.canonical_lead_id`

| Field | Value |
|-------|-------|
| **System** | Three columns on `leads` (migration 049). Supports lead-cardinality model (parent-vs-child leads). |
| **Owner** | identity-v5 |
| **Reason** | The lead-cardinality refactor (`docs/architecture/lead-cardinality-and-parent-lead-id.md`) introduced these to separate the "what came in from the source" lead from operator-merged child leads. Today they're written only by the engine. |
| **Scope** | All tenants once `LEAD_CARDINALITY_CHILD_LEADS_TENANTS` enables a tenant. Empty list in production. |
| **Observability** | Postgres: `SELECT lead_origin_type, COUNT(*) FROM leads GROUP BY 1` per tenant. Engine writes are observable in audit logs. |
| **Removal prerequisite** | These columns are permanent if the cardinality model ships. If the model is abandoned (it shouldn't be), they would be removed via a destructive migration. |
| **Risk if removed early** | Lead cardinality model breaks; "child leads" become invisible. |
| **Risk if kept** | None — they're the correct model. |

### 2.3 `customers.canonical_identity_id` (deferred — NOT yet in schema)

| Field | Value |
|-------|-------|
| **System** | Proposed reverse-pointer column on `customers`. **Held until separate design.** See `identity-graph-refactor-plan.md` §3.2a "No duplicate graph truth" invariant. |
| **Owner** | identity-v5 |
| **Reason** | Not yet added. Would let `customers` answer "what identity am I projected from?" without a JOIN through the identity rows. Risk: violates "No duplicate graph truth" if not carefully designed. |
| **Scope** | N/A (not in schema). |
| **Observability** | N/A. |
| **Removal prerequisite** | N/A (not added). Listed here for completeness so future engineers don't reinvent it without reading the invariant. |
| **Risk if removed early** | N/A. |
| **Risk if kept** | N/A. |

---

## §3 — Transitional feature flags

### 3.1 `IDENTITY_SCORING_FALLBACK_ENABLED` + `IDENTITY_SCORING_FALLBACK_TENANTS`

| Field | Value |
|-------|-------|
| **System** | `lib/feature-flags.js` → `isFallbackEnabledForTenant(userId)`. Requires BOTH env vars (capability + tenant list). |
| **Owner** | identity-v5 |
| **Reason** | Gates the scoring fallback bridge (Registry §1.1). Strict opt-in by design — wrong non-merge >> wrong merge. |
| **Scope** | Per-tenant. |
| **Observability** | Loki: any `fallback_projection_bridge_*` metric implies the flag was active for that event's tenant. |
| **Removal prerequisite** | Same as §1.1 (graph self-sufficiency thresholds met). |
| **Risk if removed early** | Same as §1.1. |
| **Risk if kept** | Same as §1.1, plus: flag continues to require operator hygiene (don't forget to add new prod tenants to the list during onboarding). |

### 3.2 `RECONCILIATION_ENGINE_LEADBRIDGE_TENANTS` (and the rest of the engine flag family)

| Field | Value |
|-------|-------|
| **System** | `lib/feature-flags.js` → `isEnabledForTenant('RECONCILIATION_ENGINE_LEADBRIDGE', userId)` (and `_ZENBOOKER`, `_OPENPHONE`, `_SIGCORE`, `_MANUAL_SF`). |
| **Owner** | identity-v5 |
| **Reason** | Per-integration, per-tenant gate that promotes a tenant through the rollout stages (S0 → S1 → S2 → S3). |
| **Scope** | Per-tenant, per-integration. Empty in production. |
| **Observability** | Loki: every adapter emits `path=engine` or `path=legacy` with the flag-evaluation reason. |
| **Removal prerequisite** | All tenants at S4 (authoritative) for that integration. When all tenants are at S4, the flag becomes a no-op and the legacy code path can be deleted in the same PR that removes the flag. |
| **Risk if removed early** | Tenants not at S4 lose the integration entirely (engine isn't yet S4-ready for them). |
| **Risk if kept** | Forever-flag risk: integration owner forgets to retire the flag after all tenants graduate. Quarterly review (governance doc §9) catches this. |

### 3.3 `LEAD_CARDINALITY_CHILD_LEADS_TENANTS`

| Field | Value |
|-------|-------|
| **System** | `lib/feature-flags.js` → `isEnabledForTenant('LEAD_CARDINALITY_CHILD_LEADS', userId)`. Gates engine writes to `parent_lead_id` + `lead_origin_type`. |
| **Owner** | identity-v5 |
| **Reason** | Lead cardinality model rollout (`lead-cardinality-and-parent-lead-id.md`) is per-tenant. |
| **Scope** | Per-tenant. Empty in production. |
| **Observability** | Postgres: `SELECT COUNT(*) FROM leads WHERE parent_lead_id IS NOT NULL`. Engine logs include `cardinality=child_lead` when the flag is active. |
| **Removal prerequisite** | All tenants on the model AND no rollback events in the prior 30d. |
| **Risk if removed early** | Tenants who haven't migrated their reporting tooling see a sudden change in "lead count" semantics. |
| **Risk if kept** | Same as §3.2 — forever-flag risk; quarterly review catches it. |

### 3.4 `IDENTITY_PROJECTION_FREEZE` + `IDENTITY_REVERSE_LINK_ENABLED`

| Field | Value |
|-------|-------|
| **System** | `lib/feature-flags.js`. Freeze: emergency kill-switch that disables all projection writes (graph still hydrates; CRM stops being updated from it). Reverse link: gates writes to `customers.canonical_identity_id` (currently held — see Registry §2.3). |
| **Owner** | identity-v5 |
| **Reason** | Freeze: incident-response tool. Reverse link: protects the "no duplicate graph truth" invariant. |
| **Scope** | Freeze: per-tenant. Reverse link: per-tenant, currently always-false (column doesn't exist yet). |
| **Observability** | Freeze: Loki `\|~ "graph_projection_skipped_frozen"`. Reverse link: would emit `reverse_link_projection_*` metrics when active. |
| **Removal prerequisite** | Freeze: never. It's a permanent kill-switch. Reverse link: blocked on the §2.3 design RFC. |
| **Risk if removed early** | Freeze: no emergency kill-switch in P1 incident. Reverse link: column never gets added (acceptable). |
| **Risk if kept** | None. |

---

## §4 — Transitional documentation cross-references

These docs describe behavior that may change after retirement events:

| Doc | What it describes | Affected when |
|-----|-------------------|---------------|
| `cross-source-identity-reconciliation.md` §3a | Hybrid bridge transitional design | Fallback retires |
| `integration-compliance-audit.md` §2 | Per-integration bypass inventory (historic) | This registry supersedes it; doc stays as history |
| `identity-enforcement-roadmap.md` | 4-stage warn → block roadmap | Each stage advance |
| `lead-cardinality-and-parent-lead-id.md` | Lead cardinality model | Model graduates to default-on |
| `memory-state-correction-plan.md` | Memory drift snapshot from 2026-05-22 | Resolves when corrections applied — purely historic doc afterward |

---

## §5 — Adding a new entry

When a new transitional bypass is introduced:

1. Add the `@transitional` / `@owner:` / `@retirement-stage:` /
   `@observability:` comment block at the call site (CI scanner will
   complain if you don't).
2. Add a row to this registry under the right section (§1 code paths, §2
   data columns, §3 feature flags).
3. Open a PR. The PR body must include:
   - Why this bypass is needed (one paragraph).
   - The removal prerequisite (concrete + measurable).
   - The dashboard panel that proves observability.
4. PR approval requires identity-v5 owner sign-off.

**If you can't articulate the removal prerequisite, you don't get the
bypass.** That's the rule. "We'll figure it out later" is how
transitional code becomes permanent.

---

## §6 — Quarterly review checklist

Every quarter, walk this list:

- [ ] Does each entry's `@observability:` Loki query still return data?
      (If no data: either the bypass is dead — remove it — or observability
      broke.)
- [ ] Are the removal prerequisites still the right ones, given what we've
      learned since the entry was written?
- [ ] Has any entry passed its prerequisite without anyone noticing?
      (Promote to "retired" — see §7.)
- [ ] Are there any `[IdentityGraphViolation]` warns in Loki for sources
      NOT in this registry? (That's an untracked bypass — open a bug.)

---

## §7 — Retired entries

When an entry's removal prerequisite is met AND the code is removed:

1. Move the entry to a "Retired" section at the bottom of this doc with
   a `Retired: YYYY-MM-DD` line.
2. Keep the entry — do not delete it. Future engineers will ask "did we
   ever have a scoring fallback?" and the answer should be discoverable.

**(No retired entries yet — this section is reserved.)**
