# Identity Governance Principles

**Status:** Top-level governance contract for the identity-graph refactor
**Owner:** identity-v5
**Last updated:** 2026-05-22
**Companion docs:**
- [retirement-stage-registry.md](retirement-stage-registry.md) — closed set of stage tags
- [transitional-infrastructure-registry.md](transitional-infrastructure-registry.md) — every transitional bypass enumerated
- [identity-enforcement-roadmap.md](identity-enforcement-roadmap.md) — code-level enforcement progression
- [identity-rollout-governance.md](../operations/identity-rollout-governance.md) — tenant-level rollout discipline
- [future-integration-strategy.md](future-integration-strategy.md) — what new integrations must comply with
- [identity-reconciliation-runbook.md](../operations/identity-reconciliation-runbook.md) — incident response

---

## 1. Why this document exists

The identity refactor introduces five separate documents that together
describe a working governance system. New engineers, integration owners,
and ops reviewers need one place to read **what the principles ARE** —
without having to derive them from the scanner code, the runbook's
incident classes, and the rollout doc's promotion ritual.

This document is that place. Every other doc is downstream of these
principles.

> **Non-goal:** This is not a code spec. It does not enable any tenant,
> does not change runtime behavior, does not flip any flag. It writes
> down the rules we already follow so they survive engineer turnover.

---

## 2. The five principles

1. **The identity graph is the authoritative source of truth.** CRM
   rows (`leads`, `customers`) are projections. The graph drives them;
   they do not drive the graph.
2. **Matching is strict.** Identities merge on `external_id`, OR on
   `phone + strong normalized name`. NEVER on phone alone. Wrong
   non-merge >> wrong merge.
3. **Writers are authorized, not ambient.** Only the projection-layer
   linker writes identity row state. Every other write path is a
   bypass, must self-identify, and must have a retirement plan.
4. **Transitional code self-identifies.** A bypass without
   `@transitional / @owner / @retirement-stage / @observability` is
   not allowed. The scanner enforces it warn-only today, stricter
   tomorrow.
5. **Per-tenant rollout, never global flips.** New integration logic
   ships dark, behind a `_TENANTS` flag, and graduates per tenant
   through a documented stage progression.

The rest of this document expands each principle.

---

## 3. Canonical ownership

Each kind of entity has exactly one owner. Cross-owner mutations are
done through the linker, not by reaching directly into the other
owner's tables.

| Entity | Owner | What the owner is allowed to do | What other systems may do |
|--------|-------|---------------------------------|--------------------------|
| `communication_participant_identities` | Identity resolver (`lib/identity-resolver.js`) + projection linker (`lib/identity-linker.js`) | Create rows. Set `sf_lead_id` / `sf_customer_id` via `setIdentityLead` / `setIdentityCustomer`. Update `last_hydrated_by` for provenance. | Read-only outside the linker. Direct writes require a `recordTransitionalBypass` instrumentation. |
| `leads` (CRM projection) | Projection linker (`applyLeadCustomerLink`, `projectIdentityToCRM`) | Set `converted_customer_id`, `parent_lead_id`, `lead_origin_type`. Create new lead rows for new identities (when integration adapter requests it). | Source integration adapters (LB, OP, ZB, SF) may insert lead rows directly during ingestion, but never set the identity-projection fields. |
| `customers` (CRM projection) | Projection linker | Currently: write `sf_customer_id` on identity, but DO NOT add reverse pointer `customers.canonical_identity_id` (held by §3.2a invariant). | Operator merge endpoint (`merge_duplicate_customers`) repoints `leads.converted_customer_id` — instrumented as transitional. |
| `communication_provider_accounts` | Connect/disconnect flows in `server.js` (`ensureOpenPhoneProviderAccount`, etc.) | Create on Connect. Mark `status=disconnected` on disconnect. | Webhook + sync code stamps `provider_account_id` on conversations/messages. Never deletes accounts. |
| `transactions`, `cleaner_ledger`, `jobs` | Job + financial subsystems (untouched by identity refactor) | Their own ownership rules; see ledger docs. | Identity refactor does not touch these except to surface `customer_id` linkage on jobs. |

### 3.1 Ownership transfer

Ownership of a kind of entity changes only via RFC + identity-v5 owner
approval. Documented examples:

- The reconciliation engine (`lib/identity-reconciliation-engine.js`)
  was added as a NEW owner candidate but explicitly does NOT write
  today — it only decides. See `identity-reconciliation-engine-design.md`.
- The LB engine adapter (`lib/lb-engine-adapter.js`) was added but
  gated behind `RECONCILIATION_ENGINE_LEADBRIDGE_TENANTS` (empty in
  production). When that list populates, ownership of LB-driven
  identity writes transfers to the adapter — but only for those tenants.

### 3.2 The "No duplicate graph truth" invariant

> The identity row is the only place that says "these entities are the
> same person." We do not maintain a parallel reverse pointer on the
> CRM side.

Concretely: we do NOT add `customers.canonical_identity_id` until the
identity graph is provably authoritative AND we have a separate RFC
covering write-direction semantics. This is held in the registry as
§2.3 of `transitional-infrastructure-registry.md`.

---

## 4. Merge discipline

The identity resolver enforces strict matching. This is the single rule
that, if relaxed, would cause the most data damage. It does not relax.

### 4.1 Allowed merge paths

A new event (source webhook, sync row, operator action) becomes part of
an existing identity row when ONE of these is true:

- **Exact external ID match.** The event's `external_id` (e.g.,
  `leadbridge_contact_id`, `zenbooker_customer_id`, `sigcore_participant_id`)
  matches an existing identity row's column.
- **Strong-name + phone match.** The event's normalized phone matches
  an existing identity's `normalized_phone` AND the event's normalized
  name is a strong match against `normalized_name` (length ≥ 2 tokens
  AND no token below 2 characters; conservative similarity threshold).

### 4.2 Forbidden merge paths

Identity rows are NEVER merged on:

- Phone alone. A shared household phone is the canonical counter-example.
- Name alone. Common names are not unique.
- Email alone. Mailbox aliasing and shared family inboxes make this
  unreliable for merge-grade matching (it's fine for hydration / fill-in,
  not for entity identity).
- Address alone. See "phone alone."

### 4.3 What happens at ambiguity

If multiple identity rows could plausibly match, the resolver writes
an `communication_identity_ambiguities` row and refuses to merge.
The operator resolves it via the Identity Conflicts UI (
`POST /api/identities/ambiguities/:id/resolve`) — and only via that
UI, which records `resolved_by` + audit row in `identity_link_audit`.

> **Rule:** No automated path resolves ambiguity. Ever. Adding one
> requires an RFC against this principle.

### 4.4 Why "wrong non-merge >> wrong merge"

A wrong non-merge produces two identity rows for one real person. The
operator merges them later via the UI; no data is lost; the worst
outcome is a small auto-link miss in the meantime.

A wrong merge produces one identity row for two different people. SMS
to person A reaches person B. Customer records cross-contaminate. The
recovery path is manual, error-prone, and visible to customers. This
is the failure mode the merge discipline exists to prevent.

---

## 5. Transitional architecture rules

A transitional bypass is any code path that writes to identity-owned
columns without going through the projection linker.

### 5.1 Why bypasses exist

Three legitimate reasons:

1. **Historical backfill.** Strict-mode runs that operate on data
   captured before the linker existed; the projection cascade would
   no-op (no fresh source event).
2. **Operator-initiated overrides.** Merge / convert endpoints whose
   semantics intentionally violate the linker's "refuse to overwrite"
   safety.
3. **Pre-adapter integration paths.** Code written before the
   integration's adapter exists (today: OpenPhone). Documented to be
   migrated when the adapter ships.

### 5.2 Why bypasses are TEMPORARY

Each bypass has a retirement stage (see
`retirement-stage-registry.md`) and a removal prerequisite (see
`transitional-infrastructure-registry.md`). The expectation is that
each one disappears within 6–18 months of being introduced.

### 5.3 The four required tags

Every `recordTransitionalBypass(...)` call site MUST be preceded
within `METADATA_LOOKBACK` lines (25) by a structured comment block
containing:

```js
/**
 * @transitional — one-line description of what is being bypassed
 * @owner:            identity-v5
 * @retirement-stage: <one of the stages in retirement-stage-registry.md §2>
 * @observability:    <exact Loki query that proves it's monitored>
 * Retires when: <one-sentence removal prerequisite>
 */
```

The scanner (`scripts/check-identity-graph-bypass.js`) emits a warning
for any call site missing these tags. The warning is non-blocking under
`--strict` (today) but will gate CI when the enforcement roadmap
advances to stage-2 for that surface.

### 5.4 Ownership contract

`@owner:` is mandatory. The only acceptable value today is `identity-v5`
because all transitional bypasses are owned by the same architectural
initiative.

Ownership transfer: when an integration team takes over a surface
(e.g., the LB platform team takes ownership of the LB legacy path
during retirement), the owner field changes in a single PR alongside
the registry entry update. No silent reassignment.

### 5.5 Bypasses are not free

Each bypass is a known architectural debt. Adding one is fine when
unavoidable — the system is built to accommodate them — but every
bypass added expands the surface that has to be re-audited at every
stage transition. New integrations should hit zero bypasses (see
`new-integration-requirements.md`).

---

## 6. Observability governance

Every transitional bypass MUST be observable in Loki. This is the only
way ops can answer "is this code still active in production?" at
quarterly review time.

### 6.1 Standard syntax

The `@observability:` tag must be a runnable Loki query that returns
rows when the bypass fires. The canonical form is:

```
Loki {service_name="service-flow-backend"} |~ "IdentityGraphViolation" | json | kind="transitional_bypass" source="<file>:<function>"
```

The `source=` filter is what makes each bypass individually observable.
The runtime emitter (`lib/identity-graph-violation.js`) stamps the
source on every warn line, so this query is deterministic.

### 6.2 What the syntax provides

- **Per-bypass counters.** A Grafana panel can `rate({...})` over the
  query to plot how often a bypass fires.
- **Per-tenant breakdown.** The emitter also stamps `tenant=<userId>`,
  so adding `| line_format "{{.tenant}}"` produces per-tenant rates.
- **Cross-bypass aggregation.** Dropping the `source=` filter and
  grouping by `source` produces the full bypass volume picture.

### 6.3 What it does NOT do

- **Dashboards are not part of this contract.** The query is the
  contract; dashboards consume it. Building dashboards happens
  separately (see `reconciliation-health-dashboard.md`).
- **Alerts are not part of this contract.** Same as above.

### 6.4 Drift detection

Quarterly review (per `transitional-infrastructure-registry.md` §6):
each entry's `@observability:` query is run. If it returns zero rows,
the bypass is either dead (good — promote toward stage-5) or the
emitter is broken (bad — investigate). Either way, a query that
returns zero forever is suspicious.

---

## 7. Future integration governance contract

Every new integration (Jobber, Housecall Pro, ServiceTitan, HubSpot,
WhatsApp, Telegram, Gmail, AI agents, etc.) ships under this contract:

1. **Class assignment.** See `future-integration-strategy.md` §2 for
   the four classes. The integration's RFC must declare a class.
2. **Engine as the only decision-maker.** The adapter calls
   `lib/identity-reconciliation-engine.js`. It does not implement
   matching heuristics.
3. **Linker as the only writer.** The adapter calls
   `setIdentityLead` / `setIdentityCustomer` / `projectIdentityToCRM`
   / `applyLeadCustomerLink`. It does not write to `leads` /
   `customers` / `communication_participant_identities` columns
   directly.
4. **Confidence thresholds are inherited.** The integration does not
   widen the engine's matching thresholds. If it needs different
   matching, that's a separate RFC against the engine.
5. **Per-tenant rollout.** The integration ships behind
   `RECONCILIATION_ENGINE_<INTEGRATION>_TENANTS` (default empty) and
   graduates per tenant through the S0→S4 progression in
   `identity-rollout-governance.md`.
6. **Observability is launch-blocking.** Per-integration Loki labels
   + path emit (`path=engine` / `path=legacy`) + dashboard panel.
7. **Transitional debt is registered, not freelanced.** If the
   integration must temporarily bypass the linker, every call site
   carries the four tags, registers in
   `transitional-infrastructure-registry.md`, and books a retirement
   stage from `retirement-stage-registry.md`.

A PR that misses any of these is grounds for rejection.

---

## 8. What this document does NOT do

- It does not enable any tenant.
- It does not flip any flag.
- It does not change runtime behavior.
- It does not modify how the resolver matches.
- It does not change the linker's write semantics.
- It does not change the scanner's strictness (still warn-only on
  metadata, error on direct writes).

The purpose is to write down what we already do.

---

## 9. Review cadence

- **Annually:** Re-read this document. If the principles drift from
  practice, update one or the other (preferably practice). If
  ownership has migrated, update §3.1. If a new principle is needed,
  add it and renumber.
- **After every P1 identity incident:** Section 9 of the runbook
  classifies the incident. If the incident reveals a principle
  failure here, update it.
- **After every new-integration RFC:** Update §7 if a new class or
  contract clause is needed.

---

## 10. Open questions / non-principles

These are explicitly NOT principles today, listed so future engineers
don't assume they are:

- We do NOT have a principle that says "auto-link is always preferred
  over operator review." Both are first-class outcomes.
- We do NOT have a principle that says "every identity must have a
  CRM projection." Floating identities (no `sf_lead_id`, no
  `sf_customer_id`) are a legitimate state.
- We do NOT have a principle that says "every integration must be
  bidirectional." Read-only sync is fine for many Class I
  integrations.
- We do NOT have a principle about retention/deletion. The data
  retention RFC is separate (and TBD).

These will become principles when (and if) the codebase requires them.
