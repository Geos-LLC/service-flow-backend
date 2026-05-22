# Identity Graph Refactor Plan

**Status:** Direction-setting document. Supersedes the "fix duplicates" mental model in operator-facing language; complements (does **not** replace) [cross-source-identity-reconciliation.md](./cross-source-identity-reconciliation.md) and [lead-cardinality-and-parent-lead-id.md](./lead-cardinality-and-parent-lead-id.md).
**Owner:** Identity v5 working group.
**Created:** 2026-05-22.
**Driving correction:** Operator direction 2026-05-22 — the implementation has been drifting back to a CRM-row-centric model with manual duplicate cleanup as the steady-state operation. The real architecture is an **identity graph that owns identity** and **CRM tables that are projections of it**. This document re-states that direction and lays out the migration to get there.

---

## 1. Where we are now

The Phase 0 / 0.5 work shipped the right primitives:

- `lib/identity-resolver.js` is the sole writer of `communication_participant_identities`.
- `lib/identity-linker.js` is the sole writer of `leads.converted_customer_id` (the CRM projection).
- `leads.parent_lead_id` + `lead_origin_type` exist; child-lead and reactivation paths are implemented in `leadbridge-service.js` behind `LEAD_CARDINALITY_CHILD_LEADS`.
- Six feature flags gate the rollout; nothing is on in production by default.

But three drifts have re-appeared:

1. **CRM rows are still materialized before identity resolution** in several paths (LB sync loop, OP webhook attach path, ZB customer upsert when the resolver flag is off). Identity gets attached *after* the row exists, which means matching-on-row continues to be the de-facto pattern when the resolver is off, and even when on, several materializations precede the resolver call.
2. **Reconciliation logic is fragmented.** Matching, classification, projection-decision, ambiguity logging, and CRM-side phone lookups live across `lib/identity-resolver.js`, `lib/identity-linker.js`, `lib/openphone-crm-match.js`, `lib/openphone-ingestion.js`, `lib/lb-ingestion.js`, `leadbridge-service.js`, `zenbooker-sync.js`, `server.js` (OP webhook + conditional create), and the operator `repair-lead-links` script. Each path implements its own slightly different pre-checks.
3. **The Identity Conflicts UI is still framed as "duplicate cleanup."** The intended use is exception handling for ambiguity / projection conflicts — not a daily-operations duplicate queue.

This document defines the target shape and the migration order to get there without giving up the conservative confidence posture (`wrong non-merge > wrong merge`) we've worked hard to defend.

---

## 2. Target mental model

```
                                 ┌──────────────────────────────────┐
                                 │      REAL-WORLD PERSON           │
                                 └─────────────────┬────────────────┘
                                                   │
                                ┌──────────────────▼──────────────────┐
                                │      CANONICAL IDENTITY NODE        │
                                │   communication_participant_         │
                                │             identities               │
                                │                                      │
                                │   Owned by: identity-resolver        │
                                │   Identity-stable across:            │
                                │     - LB ingest (acquisitions)       │
                                │     - ZB sync (customer create/upd)  │
                                │     - OP / Sigcore (conversations)   │
                                │     - Operator merge actions         │
                                └─────────────────┬────────────────────┘
                                                  │
            ┌─────────────────┬───────────────────┼────────────────────┬─────────────────────┐
            ▼                 ▼                   ▼                    ▼                     ▼
  ┌──────────────────┐ ┌─────────────────┐ ┌──────────────┐ ┌────────────────┐ ┌─────────────────────┐
  │  ACQUISITION     │ │  COMMUNICATION  │ │  BOOKING /   │ │  CRM           │ │ ATTRIBUTION /       │
  │  PROJECTIONS     │ │  PROJECTIONS    │ │  OPERATIONAL │ │  PROJECTIONS   │ │ LINEAGE EVENTS      │
  │                  │ │                 │ │  PROJECTIONS │ │                │ │                     │
  │  LB Lead rows    │ │  Sigcore        │ │  ZB customer │ │  SF leads      │ │  Reactivations,     │
  │  (canonical +    │ │  participant    │ │  ZB jobs     │ │  SF customers  │ │  child-acquisitions │
  │   child + reac-  │ │  identities,    │ │              │ │                │ │  marketing source   │
  │   tivation)      │ │  OP contact     │ │              │ │                │ │  campaign metadata  │
  │                  │ │  snapshots      │ │              │ │                │ │                     │
  └──────────────────┘ └─────────────────┘ └──────────────┘ └────────────────┘ └─────────────────────┘
        (LeadBridge)         (Sigcore)        (Zenbooker)     (ServiceFlow)          (cross-source)
```

Rules:

- **Identity is singular per real person.** Every system above projects against it.
- **Projections are plural.** One identity → N acquisition records, N conversations, possibly multiple operational customers (B2B), one or more reactivations across time.
- **Each non-identity layer remains the canonical owner for its own fields.** ZB owns booking facts. LB owns acquisition / `lead_cost`. Sigcore owns message bodies. ServiceFlow owns the CRM-business link (`leads.converted_customer_id`) — but as a *projection* of the graph, not as parallel matching truth.
- **Operator review surfaces ambiguity, not duplicates.** The work the operator does is "this case looks structurally off, decide what's true" — not "merge these two customers because they look the same."

This is the contract `cross-source-identity-reconciliation.md` §2 already codifies. The deliverables that follow exist to bring the runtime behavior into alignment with that contract.

---

## 3. Direction corrections (against the current implementation)

The operator's 2026-05-22 direction translates into ten concrete corrections. Each is anchored to current code so the gap is auditable.

### 3.1 Stop treating lead ↔ customer as "duplicates"

A converted lead and a customer are different *lifecycle projections* of one identity, not duplicates to merge. The Identity Conflicts UI today encourages a duplicate-merge framing.

**Action:** rename the operator surface from "Identity Conflicts" / "duplicate review" to **"Ambiguity & Projection Review"**, with three explicit panes:

1. **Resolver ambiguity** — `communication_identity_ambiguities` rows with `status='open'`. Two or more candidates collided; operator picks.
2. **Projection conflicts** — `[IdentityLink]` `outcome=lead_already_linked_to_other` or `collision` events; operator decides whether to override.
3. **Cross-source attribution conflicts** — same canonical identity has child-acquisition records whose `source` disagrees with the customer's currently-stored `source` field (LB vs ZB vs OP-derived).

Each pane is an *exception* list. The duplicate-merge panel is removed.

### 3.2 Introduce explicit canonical identity ownership

Today, "who is the canonical lead?" is encoded indirectly: `identity.sf_lead_id` points to the canonical, `leads.parent_lead_id` points to it from children. There is no `canonical_lead_id` column on `leads` itself, even though the runbook references it.

**Bounded action — approved 2026-05-22:**

- `leads.canonical_lead_id` — **APPROVED.** Generated column: `COALESCE(parent_lead_id, id)`. Already designed (memory `project_identity_v5_rollave_v5_rollout.md`). Ship the migration so reporting queries don't need to know the parent/canonical convention. Safe because it is *generated* from columns the identity-linker / LB child-create path already own — no new writer surface, no drift risk.
- `communication_conversations.participant_identity_id` — **APPROVED.** Already exists today. Promote in the runbook as the conversation's only authoritative identity link.

**Held — pending separate design:**

- `customers.canonical_identity_id` — **HELD.** Operator correction: do *not* add a reverse pointer from a CRM row to the identity graph until a separate design answers (1) who writes it, (2) how it is backfilled, (3) how drift is detected, (4) what happens when operator override changes the identity link, (5) what happens when identity rows merge/split, (6) what invariant test catches mismatch with `identity.sf_customer_id`. Until that design lands, the canonical edge from customer → identity is the *implicit* one in `communication_participant_identities.sf_customer_id`. Code that needs to walk from a customer row to its identity reads the identities table by `sf_customer_id`. The denormalized convenience pointer is *not* worth a second source of truth without explicit ownership.

The same caution applies to **any future reverse identity pointer** on a CRM table — see §3.2a below.

### 3.2a Invariant — *No duplicate graph truth*

This invariant governs every future column addition that smells like "make the graph easier to traverse from the other side." It is binding on this refactor and every subsequent identity-related PR.

> **The canonical edge is stored once, in `communication_participant_identities`.**
>
> An identity row's `sf_lead_id` and `sf_customer_id` are the *only* authoritative graph edges from identity → CRM. Reverse pointers (CRM → identity) are permitted **only** when at least one of the following is true:
>
> 1. The column is a **generated column** derived from already-owned columns (e.g., `leads.canonical_lead_id = COALESCE(parent_lead_id, id)`).
> 2. The column is **derived** at read time inside an application-level helper, not materialized in the row.
> 3. The column is **maintained exclusively** by `lib/identity-linker.js` (the same module that owns `sf_lead_id` / `sf_customer_id` writes) **and** the design carries explicit answers to all six of:
>    - Who writes it (must be a single named code path).
>    - How historical rows are backfilled (idempotent, paginated, dry-run capable).
>    - How drift from the canonical edge is detected (continuous check / periodic audit / both).
>    - How operator override of the identity link cascades (does the reverse pointer change with it?).
>    - How identity-row merge/split cascades (which side wins; rollback recipe).
>    - What invariant test catches mismatch on every PR (added to the existing `identity-linker.test.js` suite).
>
> Manually maintained reverse pointers are forbidden. "We'll just remember to update it" is not a writer plan; it is the bug.

**Why this matters:** once two sources of truth exist for the same edge, divergence is a matter of when, not if. Every retroactive-repair tool we currently maintain (per §3.9) exists because past code created such divergences. New columns must not create new repair tools.

**Where it shows up immediately:**

- `customers.canonical_identity_id` is held under this rule (§3.2).
- `lib/identity-linker.js` remains the sole writer of `leads.converted_customer_id`; no new code path is allowed to write that column directly.
- `communication_participant_mappings.crm_customer_id` / `crm_lead_id` are *legacy* reverse pointers from the pre-resolver era. Their existence is grandfathered; new code must not read them when an `identity_id` is present on the mapping. Sunset is tracked in [materialization-audit.md](./materialization-audit.md) §8.3.
- Engine output (`ProjectionPlan`) is *not* a row; it is a value object the caller acts on. It is not a duplicate graph truth.

### 3.3 Codify identity projection rules

Today, projection rules are scattered (LB ingest decides "create lead vs enrich vs child-lead vs reactivation"; ZB decides "create customer"; OP decides "create lead vs link existing"). Move the *decision* into a named function — `decideProjection(identity, sourceEvent)` — that returns one of:

- `canonical_customer_create` — ZB or operator creates the operational customer.
- `canonical_lead_create` — LB first acquisition for this identity.
- `child_acquisition` — repeat LB event for an existing canonical.
- `reactivation_lead` — new acquisition for an identity that already has a customer.
- `attach_existing_lead` / `attach_existing_customer` — CRM row exists; identity should adopt it (operator-only after rollout completes).
- `noop_communication_only` — OP event that should not create CRM rows.
- `ambiguous` — resolver returned ambiguous; do nothing.

The decision function is **pure** (input: identity row + normalized source event + tenant policy; output: a decision enum). The materialization functions (`createLeadFromLB`, `createChildLeadFromLB`, `upsertCustomerFromZB`, `maybeCreateLeadFromOpenPhone`) take a decision and execute it.

This refactor doesn't move logic, it *names* it. The matcher stays in `identity-resolver.js`; the projection decision becomes a named primitive instead of being inlined per caller.

### 3.4 Cross-source reconciliation must happen *before* row creation

Today's order (per-flow, see [materialization-audit.md](./materialization-audit.md)):

| Flow | Current order |
|---|---|
| LB webhook | identity → resolve-or-create lead → conversation → message |
| LB sync (per lead) | identity → resolve-or-create lead → conversation → messages |
| ZB customer sync | resolveIdentity → upsertCustomerFromZB (which does its own phone/email adoption) → linkIdentityToCustomer |
| OP webhook (conversation create) | route/tenant → conversation insert (with `participant_identity_id` if mapping had one) → `handleOpenPhoneConditionalLeadCreation` fired async |
| OP message webhook | conversation lookup → message insert → mapping resolve (sometimes) → identity resolve (sometimes) |

This is **mostly** in the right order for LB and ZB. The problem cases are:

- **OP message arrival without prior mapping** inserts the conversation row with `participant_identity_id=NULL` and `participant_pending=true` (see `server.js:40601-40678`). The identity is only resolved when a participant-resolution event arrives later. Until then, the conversation exists with no identity link — and any UI lookup that asks "which CRM row is this conversation for?" runs through `lookupCRMByPhone()` instead of going through the identity graph.
- **LB ingest legacy path** (`upsertParticipantIdentity` when `IDENTITY_RESOLVER_LEADBRIDGE` is OFF) skips the resolver entirely and does a phone-alone upsert into `communication_participant_identities`. This is the drift the resolver was built to fix.
- **ZB customer adoption** (`upsertCustomerFromZB` steps 2 and 3) does phone-alone and email-alone adoption *outside* the resolver — even when `IDENTITY_RESOLVER_ZENBOOKER` is on, these adoption branches run first, then the resolver result is linked at the end.

**Action:** the unified reconciliation engine (Deliverable B) becomes the single entry point. Every inbound event normalizes through it; CRM materialization is gated on the engine's decision. See [materialization-audit.md](./materialization-audit.md) for the per-call-site target ordering.

### 3.5 Consolidate reconciliation logic into a single engine

Today's surfaces:

- `lib/identity-resolver.js` — `resolveIdentity()` (matching, ambiguity logging).
- `lib/identity-linker.js` — `setIdentityCustomer`, `setIdentityLead`, `projectIdentityToCRM`, `applyLeadCustomerLink` (writes).
- `lib/openphone-crm-match.js` — phone-only CRM lookup, used by OP path.
- `lib/openphone-ingestion.js` — OP-side "should we create a lead" decision.
- `lib/lb-ingestion.js` — LB-side invariants (`assertCreateLeadInvariant`, `assertCreateChildLeadInvariant`) + enrich patch.
- `leadbridge-service.js` `resolveOrCreateLead` — LB-specific orchestration.
- `zenbooker-sync.js` `upsertCustomerFromZB` — ZB-specific orchestration with its own phone/email adoption.
- `server.js` `maybeCreateLeadFromOpenPhone` / `handleOpenPhoneConditionalLeadCreation` — OP-specific orchestration.
- `scripts/phase1-dryrun-repair.js`, `lib/retroactive-repair-guards.js`, `/api/identity-conflicts/repair-lead-links` — retroactive repair (transitional tooling).

**Action:** introduce `lib/identity-reconciliation-engine.js` as the *only* public API the call sites use. It composes the existing pure helpers — it does not duplicate matching logic. See Deliverable B for the design.

Each source-specific file's responsibility shrinks to:

- Adapter: normalize the inbound payload into the engine's `IdentityInput` shape.
- Engine: `reconcile(IdentityInput) → ReconciliationResult`.
- Adapter: materialize the projection by calling source-specific writers (still in their own files) per the engine's decision.

The engine replaces the *control flow*, not the *writers*. Writers stay where they are.

### 3.6 Sigcore must become first-class identity input

Today, Sigcore's participant identities (`sigcore_participant_id`, `sigcore_participant_key`, `provider_contact_id`) feed into `resolveIdentity` for OP only — and only when `IDENTITY_RESOLVER_OPENPHONE` is on. The Sigcore-side `contact_identity` table and Sigcore-driven contact-name resolution are not connected to the SF identity graph at all.

**Action:** treat Sigcore participant identity as a *peer projection* to LB / ZB / OP-direct, not as something downstream of OP. See [sigcore-integration-audit.md](./sigcore-integration-audit.md) for the gaps and the integration plan.

### 3.7 Preserve acquisition lineage

The Phase 0.5 work shipped `parent_lead_id` + `lead_origin_type`. Carry it forward without ever:

- collapsing repeat acquisitions into one row,
- letting projection writes touch `source` / `lead_cost` / `utm_*` / `created_at` (the column whitelist in `lib/identity-linker.js` already enforces this; new code MUST NOT broaden it),
- deleting a lead during merge.

**Action:** the engine's `child_acquisition` and `reactivation_lead` decisions are the only paths that touch the `leads` table for a known-identity repeat event. Direct `INSERT INTO leads` outside the engine is removed from new flows.

### 3.8 Identity Conflicts UI changes purpose

(See §3.1.) Operator review is *exception* handling, not normal operation.

**Acceptance criterion for the new UI:** the operator's daily workload on the panel scales with the size of the *ambiguity queue*, not with the size of the customer table.

### 3.9 Retroactive repair is transitional

`/api/identity-conflicts/repair-lead-links`, `scripts/phase1-dryrun-repair.js`, `lib/retroactive-repair-guards.js`, and `lib/identity-backfill.js` exist because we have historical data that pre-dates the resolver. They are **migration tools**, not steady-state architecture. New product features MUST NOT add behavior that depends on the existence of these tools.

**Action:** add a `// @transitional` tag to the top of each file in this set, plus a deprecation date target (post-Phase 5 rollout completion). When all tenants have rolled through Phase 5 and ambiguity queue has been at steady-state for 30 days, these tools are archived to `scripts/archive/`.

### 3.10 Hold the line on confidence

The strict-mode + ambiguity-queue + operator-review path is the design, not a limitation to remove. Do not widen auto-merge, do not weaken strict mode, do not collapse multiple acquisitions, do not auto-delete records. Restated here so it survives this document.

---

## 4. Target architecture

### 4.1 Component view

```
                       ┌──────────────────────────────────────────────────┐
                       │                INBOUND EVENTS                    │
                       │  LB webhook  ZB webhook  OP webhook  Operator UI │
                       └────────┬──────────┬─────────┬──────────┬─────────┘
                                ▼          ▼         ▼          ▼
                       ┌──────────────────────────────────────────────────┐
                       │            SOURCE ADAPTERS                       │
                       │  Convert raw payload to IdentityInput shape.     │
                       │  - leadbridge-service.js: webhook & sync         │
                       │  - zenbooker-sync.js: upsertCustomerFromZB caller│
                       │  - server.js: OP webhook + Sigcore mapping path  │
                       │  - manual-sf: operator UI endpoints              │
                       └──────────────────────────┬───────────────────────┘
                                                  ▼
                       ┌──────────────────────────────────────────────────┐
                       │   lib/identity-reconciliation-engine.js          │
                       │                                                  │
                       │   reconcile(IdentityInput) → ReconciliationResult│
                       │                                                  │
                       │   1. Normalize signals (phone, name, email)      │
                       │   2. Call resolveIdentity()                      │
                       │   3. Classify confidence + ambiguity             │
                       │   4. Decide projection (canonical / child /      │
                       │      reactivation / attach / noop / ambiguous)   │
                       │   5. Return decision + projection plan           │
                       │                                                  │
                       │   Pure composition. No writes outside resolver.  │
                       └──────────────────────────┬───────────────────────┘
                                                  ▼
                       ┌──────────────────────────────────────────────────┐
                       │             PROJECTION EXECUTORS                 │
                       │  Materialize the decided projection.             │
                       │  - createLeadFromLB / createChildLeadFromLB      │
                       │  - upsertCustomerFromZB writer                   │
                       │  - maybeCreateLeadFromOpenPhone writer           │
                       │  - setIdentityLead / setIdentityCustomer         │
                       │  - projectIdentityToCRM                          │
                       │  - applyLeadCustomerLink (operator override)     │
                       └──────────────────────────┬───────────────────────┘
                                                  ▼
                       ┌──────────────────────────────────────────────────┐
                       │              CRM PROJECTIONS                     │
                       │  leads (canonical + child), customers,           │
                       │  communication_conversations, identity_link_audit│
                       └──────────────────────────────────────────────────┘
```

### 4.2 Ownership model

Already encoded in `synchronization-constitution.md` §1.1–1.5 and `cross-source-identity-reconciliation.md` §2. No change. The graph is the source of truth for identity; each external system is canonical for its own facts.

### 4.3 Projection model

Two-column legacy (`identity.sf_lead_id`, `identity.sf_customer_id`) remains shipped. Long-term move toward the `identity_projections` table (sketched in `cross-source-identity-reconciliation.md` §13a) stays on the roadmap; it is *not* a prerequisite for the engine consolidation. Doing the engine work first means the table migration becomes a swap of internal storage without changing call sites.

### 4.4 Source precedence

Unchanged from `cross-source-identity-reconciliation.md` §4. The engine reads precedence from `lib/source-registry.js`; no caller redefines it.

### 4.5 Reconciliation order

For every inbound event:

```
1. Source adapter: parse payload → IdentityInput
2. Engine.reconcile():
     a. Normalize phone/name/email
     b. resolveIdentity()  (writes identity row, possibly logs ambiguity)
     c. If ambiguous → return { decision: 'ambiguous' }
     d. Classify the identity's state (has_lead, has_customer, has_both, floating)
     e. Apply per-source projection rules to produce a decision
     f. Return { decision, identity, plan }
3. Source adapter: execute plan via the projection executors
4. Projection executors: write CRM rows, fire setters, projection cascades
```

The identity row state is always populated before any CRM materialization for known-identity events. New floating identity creation still happens inside step 2(b), as it does today.

---

## 5. Migration stages

This refactor is **not a rewrite**. It is a 5-stage consolidation around the engine boundary. Each stage is independently shippable and dark-gated.

### Stage 1 — Engine skeleton (1 PR)

- Create `lib/identity-reconciliation-engine.js` with the `reconcile()` API.
- Implementation initially delegates: resolver call + a thin "decision" returning what the existing per-source code would have decided.
- Add unit tests that drive every decision branch directly (no DB).
- No call site converted yet. Engine is dark code.

### Stage 2 — LB adapter conversion (1 PR)

- `leadbridge-service.js` `resolveOrCreateLead` becomes a thin adapter:
  - Build `IdentityInput`, call `engine.reconcile()`, switch on `result.decision`, call existing executors.
- The behavior is byte-identical to today; only the call-site shape changes.
- Per-tenant rollout gated by `RECONCILIATION_ENGINE_LEADBRIDGE_TENANTS`.

### Stage 3 — ZB adapter conversion (1 PR)

- `zenbooker-sync.js` `upsertCustomerFromZB` becomes a thin adapter.
- The current phone/email adoption branches move *into the engine* (the engine produces an `attach_existing_customer` decision when a CRM-anchor candidate is found and the resolver result was conservative).
- `RECONCILIATION_ENGINE_ZENBOOKER_TENANTS`.

### Stage 4 — OP adapter conversion (1 PR)

- `server.js` `maybeCreateLeadFromOpenPhone` + `handleOpenPhoneConditionalLeadCreation` become thin adapters.
- The Sigcore mapping path (`resolveParticipantMapping` → `linkMappingToIdentity`) is unified: mapping resolution happens through the engine, not a parallel path.
- `RECONCILIATION_ENGINE_OPENPHONE_TENANTS`.

### Stage 5 — Sigcore-first ingestion (1 PR)

- Sigcore inbound becomes a first-class input source to the engine (see [sigcore-integration-audit.md](./sigcore-integration-audit.md)).
- The engine accepts `source: 'sigcore'` events for participant-discovery payloads that are not yet conversation-bearing (e.g., contact-name lookups, participant tag updates).
- `RECONCILIATION_ENGINE_SIGCORE_TENANTS`.

After Stage 5, the retroactive repair scripts are tagged `@transitional` and removed from the operator dashboard's day-to-day surface.

### Per-tenant flip order within each stage

The engine's per-source flag is **independent** of the resolver flag. The flag flip order remains the one in `cross-source-identity-reconciliation.md` §13. Concretely:

```
For tenant T:
  1. LEAD_CARDINALITY_CHILD_LEADS_TENANTS += T   (already required pre-Stage 2)
  2. IDENTITY_RESOLVER_*_TENANTS += T             (per source, as before)
  3. RECONCILIATION_ENGINE_*_TENANTS += T         (new, post-stage)
```

If the engine flag is off for T, the call site still works (it falls back to the legacy inline path inside the adapter). This is the same dark-rollout pattern Phase 0 used.

---

## 6. Rollback posture

Every stage maintains the same posture as Phase 0:

- **Dark code first.** Engine is callable but unused until the flag flips.
- **Per-tenant gating.** No global flip.
- **Freeze switch.** `IDENTITY_PROJECTION_FREEZE` continues to halt all projection writes — the engine's projection step routes through `projectIdentityToCRM`, which already honors freeze.
- **Identity row remains stable.** The engine does not introduce new identity-row writes; all such writes still go through `resolveIdentity`.
- **Acquisition records preserved.** Engine's child/reactivation decisions delegate to the same executors that already preserve `parent_lead_id` / `lead_origin_type`.
- **Operator override path unchanged.** `applyLeadCustomerLink` is still the operator's pull cord.

If the engine misbehaves for a tenant: clear the engine flag for T, the adapter falls back to the legacy path, and the tenant is back to the pre-engine behavior within seconds.

If projection misbehaves for *any* tenant: set `IDENTITY_PROJECTION_FREEZE=true`. Engine and resolver continue updating the identity graph; CRM business links freeze in place. Identity ambiguity queue still grows correctly; no CRM rows are mutated.

---

## 7. What this plan does *not* do

To stay focused, this plan explicitly excludes:

- **`identity_projections` table migration.** Still on the roadmap (per §13a of `cross-source-identity-reconciliation.md`), but a separate effort. The engine is designed so swapping storage later is internal-only.
- **Resolver matching changes.** Confidence boundaries, name classification, phone-only rules — all unchanged. Engine is a control-flow consolidation, not a matching policy change.
- **Auto-merge widening.** Explicitly forbidden.
- **Auto-deletion of CRM rows.** Explicitly forbidden.
- **Removing the operator override path.** Operator can always override; engine's job is to keep that path rare.
- **Sigcore-side schema work.** Sigcore-side identity columns belong to Sigcore. Cross-system contracts live in `lib/source-registry.js` and the adapter layer; Sigcore does not learn about SF's `identity_projections` table.

---

## 8. Open questions for the operator

1. **Stage 5 timing.** Sigcore-first ingestion is the most architecturally meaningful step but the lowest-risk for operator-visible behavior. Ship before or after the per-tenant Phase 4 (OP enablement) currently in flight? Recommendation: after — gives the engine consolidation 30 days of soak before adding a new input source.
2. **`identity_projections` migration target.** Is "all tenants through Phase 5 + 30 days steady-state" the right gate, or do we lock to a calendar date? Recommendation: stay event-gated; calendar dates create pressure to skip soak.
3. **Operator UI rename.** "Ambiguity & Projection Review" is descriptive but long. Alternative: "Identity Review". Operator decides.
4. **Retroactive repair archival.** Once tagged `@transitional`, do we leave them in the repo or move to `scripts/archive/`? Recommendation: archive — having repair scripts on the main path invites their reuse for problems that should be solved upstream.

---

## 9. Pointers

- Companion docs: [cross-source-identity-reconciliation.md](./cross-source-identity-reconciliation.md), [lead-cardinality-and-parent-lead-id.md](./lead-cardinality-and-parent-lead-id.md), [synchronization-constitution.md](./synchronization-constitution.md), [identity-reconciliation-engine-design.md](./identity-reconciliation-engine-design.md), [materialization-audit.md](./materialization-audit.md), [sigcore-integration-audit.md](./sigcore-integration-audit.md).
- Runbook: [docs/operations/identity-reconciliation-runbook.md](../operations/identity-reconciliation-runbook.md).
- Code: [lib/identity-resolver.js](../../lib/identity-resolver.js), [lib/identity-linker.js](../../lib/identity-linker.js), [lib/source-registry.js](../../lib/source-registry.js), [lib/lb-ingestion.js](../../lib/lb-ingestion.js), [lib/openphone-ingestion.js](../../lib/openphone-ingestion.js), [leadbridge-service.js](../../leadbridge-service.js), [zenbooker-sync.js](../../zenbooker-sync.js).
