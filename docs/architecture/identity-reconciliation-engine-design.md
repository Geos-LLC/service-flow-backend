# Unified Reconciliation Engine — Design

**Status:** Design (Deliverable B of the 2026-05-22 refactor direction). Not yet implemented.
**Owner:** Identity v5 working group.
**Target file:** `lib/identity-reconciliation-engine.js`.
**Companion:** [identity-graph-refactor-plan.md](./identity-graph-refactor-plan.md), [cross-source-identity-reconciliation.md](./cross-source-identity-reconciliation.md).

---

## 1. Purpose

Consolidate cross-source reconciliation control flow behind a single API. The matcher (`lib/identity-resolver.js`) and the projection writers (`lib/identity-linker.js`) **do not change**. What changes is that every inbound event from every source goes through one `reconcile()` call, which returns a *plan* the source adapter then executes.

The engine is the single named place where:

1. Source-specific input is normalized to a uniform `IdentityInput`.
2. The resolver is called.
3. Confidence is classified.
4. Projection decisions are made (canonical vs child vs reactivation vs attach vs noop vs ambiguous).
5. Invariants are checked before the adapter is told to materialize anything.

It is **not** a matcher, **not** a CRM writer, and **not** a tenant-policy reader. Tenant policy is passed in by the caller (the adapter). The engine is pure composition.

---

## 2. Boundaries

### In scope

- The decision: given an inbound event, what should happen to the identity graph + CRM projection?
- Calling `resolveIdentity()`.
- Classifying the resolver's result into a projection plan.
- Surfacing ambiguity to the queue (which the resolver already does — engine just enforces "stop here on ambiguous").
- Enforcing structural invariants before materialization (no grandchildren, no cross-tenant, no overwrite of strong-source fields).

### Out of scope

- Writing to `communication_participant_identities` (still resolver-only).
- Writing to `leads` / `customers` (still source adapters via projection executors).
- Writing to `leads.converted_customer_id` (still `lib/identity-linker.js`).
- Source-specific business logic (LB stage automation, ZB lifecycle mapping, OP contact-name resolution).
- Tenant feature-flag *interpretation*. The engine receives policy decisions as inputs.

### Why the boundary matters

The resolver is the only writer to the identity graph by design (constitution §1.3). The linker is the only writer to the projection. If the engine started writing either, we'd lose the chokepoint invariants that let us prove "every identity write is auditable" and "no projection bypasses the freeze switch."

---

## 3. Public API

Two functions. Everything else is internal.

### 3.1 `reconcile(input) → ReconciliationResult`

```
async function reconcile(supabase, logger, input: IdentityInput, policy: TenantPolicy)
  → Promise<ReconciliationResult>
```

Single entry point. Pure composition over existing helpers.

### 3.2 `executePlan(supabase, logger, plan, executors) → ExecutionResult`

```
async function executePlan(supabase, logger, plan: ProjectionPlan, executors: Executors)
  → Promise<ExecutionResult>
```

Optional convenience layer. Maps a plan to source-specific writers. Adapters MAY call this instead of switching on `plan.decision` themselves, but they don't have to — they can dispatch manually for source-specific reasons (e.g., LB needs to do conversation upsert + message insert around the lead create; ZB needs to write job/payment data after the customer write).

---

## 4. Input shape

```ts
type IdentityInput = {
  // Required
  userId: number;                  // Tenant scope
  source: 'leadbridge' | 'openphone' | 'zenbooker' | 'manual_sf' | 'sigcore';

  // Identity signals — at least one of phone/email/externalId is required
  phone?: string | null;           // any format; engine normalizes
  email?: string | null;
  displayName?: string | null;

  // Source-specific external IDs
  externalId?: string | null;      // Primary external ID for this source (resolver maps to column)
  sigcoreParticipantId?: string | null;
  sigcoreParticipantKey?: string | null;

  // CRM linkage hints — used only when the resolver can fall back to CRM-anchor
  sfLeadId?: number | null;
  sfCustomerId?: number | null;

  // Source-event metadata — drives projection decision but not matching
  event: {
    type: 'lead_received' | 'message_received' | 'call_received' | 'customer_created' |
          'customer_updated' | 'participant_resolved' | 'operator_action';
    channel?: 'thumbtack' | 'yelp' | 'sms' | 'voice' | 'mms' | null;
    accountDisplayName?: string | null;   // LB-specific: drives source naming
    canonicalSource?: string | null;      // OP-specific: company → source mapping result
    company?: string | null;              // OP-specific: raw company tag
    lastEventAt?: string | null;          // ISO timestamp
    message?: string | null;              // Optional message body (first ≤500 chars)
    payload?: object;                     // Raw payload for ambiguity logging
  };

  // Mode flags
  strict?: boolean;                // Resolver strict mode (backfill paths)
  dryRun?: boolean;                // Plan only — no resolver writes either
};
```

```ts
type TenantPolicy = {
  // Engine-relevant feature flags, evaluated by the adapter
  childLeadsEnabled: boolean;            // LEAD_CARDINALITY_CHILD_LEADS_TENANTS for this userId
  reactivationLeadsEnabled: boolean;     // same flag covers reactivation today
  conditionalLeadCreationEnabled: boolean; // OPENPHONE_CONDITIONAL_LEAD_CREATION for this userId
  freeze: boolean;                       // IDENTITY_PROJECTION_FREEZE
  allowStageMove: boolean;               // tenant setting; default false

  // Source-specific knobs
  openPhoneLeadMaxAgeDays?: number | null;
};
```

Adapters build `TenantPolicy` once per call (or per batch in sync paths) by reading the relevant feature flags + tenant settings. The engine never touches `lib/feature-flags.js` itself.

---

## 5. Output shape

### 5.1 `ReconciliationResult`

```ts
type ReconciliationResult =
  | { kind: 'ambiguous'; identityCandidates: number[]; reason: string }
  | { kind: 'matched'; identity: IdentityRow; plan: ProjectionPlan }
  | { kind: 'noop'; reason: string }
  | { kind: 'error'; error: string };
```

### 5.2 `ProjectionPlan`

The plan is the engine's promise of what should be materialized. Adapters MUST honor `decision`; everything else is informative.

```ts
type ProjectionPlan = {
  decision:
    | 'canonical_customer_create'      // ZB or operator creates the customer
    | 'canonical_lead_create'          // LB / OP first acquisition
    | 'child_acquisition'              // LB repeat acquisition; create child lead
    | 'reactivation_lead'              // identity has customer; new acquisition
    | 'attach_existing_customer'       // CRM-anchor: identity should adopt existing customer
    | 'attach_existing_lead'           // CRM-anchor: identity should adopt existing lead
    | 'enrich_only'                    // identity already linked; fill nulls
    | 'noop_communication_only'        // OP event without lead/customer effect
    | 'frozen'                         // IDENTITY_PROJECTION_FREEZE is on
    | 'ambiguous';                     // resolver returned ambiguous (carried for symmetry)

  identityId: number | null;           // null only when decision='ambiguous'/'frozen'

  // Target IDs when known (e.g., attach decisions know which CRM row)
  attachTarget?: { type: 'customer' | 'lead'; id: number } | null;
  parentLeadId?: number | null;        // for child_acquisition

  // Diagnostics
  confidence: 'auto_strong' | 'auto_weak' | 'crm_anchor' | 'created_floating' | 'operator';
  matchStep?: string;                  // resolver matchStep value
  reason: string;                      // short tag, e.g., 'identity_has_lead_and_customer'
};
```

### 5.3 `ExecutionResult`

```ts
type ExecutionResult = {
  ok: boolean;
  decision: ProjectionPlan['decision'];
  identityId: number | null;
  leadId?: number | null;
  customerId?: number | null;
  projection?: { projected: boolean; reason: string };
  notes?: string[];
};
```

---

## 6. Confidence classes

The resolver already classifies name matches (`strong_exact`, `strong_tokenset`, `strong_leven`, `weak_subset`, `weak_leven`, `one_missing`, `neither_named`, `conflict`) and reports a `matchStep` (`external_id`, `crm_anchor`, `phone_strong`, `phone_weak`, `email`, `via_linked_crm`, `created_floating`). The engine consolidates these into five operational classes:

| Class | Resolver matchStep | Engine treatment |
|---|---|---|
| `auto_strong` | `external_id`, `phone_strong`, `crm_anchor`, `email` (strong-name only) | Proceed with projection decision. |
| `auto_weak` | `phone_weak`, `email` (weak-name) | Proceed but emit `[ReconciliationConfidence]` log. Strict mode rejects. |
| `crm_anchor` | `crm_anchor` (existing CRM link adopted) | Proceed; mark plan.confidence accordingly so reporting can show "linked via existing CRM" vs "linked via identity strong match". |
| `created_floating` | `created_floating` | New identity row. Plan continues normally (will likely be `canonical_lead_create` / `canonical_customer_create`). |
| `operator` | (post-engine path for `applyLeadCustomerLink`) | Engine doesn't classify these; they bypass `reconcile()`. |

The engine never *upgrades* confidence. If resolver says weak, plan says weak.

### Ambiguity

Ambiguous resolver results never produce a plan. The engine returns `{ kind: 'ambiguous', identityCandidates, reason }`. The adapter MUST stop (no row writes, no conversation enrichment beyond what was already done before the engine call).

This is the same rule that's in `leadbridge-service.js:261-264` and `zenbooker-sync.js:199-213` today; the engine enforces it uniformly.

---

## 7. Decision rules

Given a resolved (non-ambiguous) identity, the engine computes `plan.decision` from the identity's current state + the source event. The rules are the same ones implemented inline in today's adapters, lifted into the engine.

### 7.1 LB source

```
state: identity.sf_lead_id is set, sf_customer_id is set
  → enrich_only                  (child-leads OFF)
  → child_acquisition            (child-leads ON, parent=identity.sf_lead_id)

state: identity.sf_lead_id is set, sf_customer_id is NULL
  → enrich_only                  (child-leads OFF)
  → child_acquisition            (child-leads ON, parent=identity.sf_lead_id)

state: identity.sf_lead_id is NULL, sf_customer_id is set
  → noop_communication_only      (child-leads OFF — current "identity_already_customer")
  → reactivation_lead            (child-leads ON; new canonical lead, parent=null,
                                  lead_origin_type='reactivation')

state: identity.sf_lead_id is NULL, sf_customer_id is NULL
  → attach_existing_customer     (CRM phone match found customer)
  → attach_existing_lead         (CRM phone match found lead)
  → canonical_lead_create        (no CRM match)
```

### 7.2 ZB source

```
state: identity.sf_customer_id is set
  → enrich_only (customer already exists, fill nulls inside the executor)

state: identity.sf_customer_id is NULL, identity.sf_lead_id is set
  → canonical_customer_create + setIdentityCustomer + projection cascade
    (existing lead will auto-convert via projectIdentityToCRM)

state: identity.sf_lead_id is NULL, sf_customer_id is NULL
  → canonical_customer_create
    (no prior CRM; new customer; identity links via setIdentityCustomer)
```

ZB never produces `child_acquisition` (ZB is not an acquisition source). ZB never produces `reactivation_lead` (LB does). ZB's phone/email adoption branches currently in `upsertCustomerFromZB` collapse into `attach_existing_customer` once the engine owns them.

### 7.3 OP source

```
state: identity.sf_lead_id is set OR sf_customer_id is set
  → noop_communication_only      (OP suppresses shadow leads)

state: identity is floating, conditionalLeadCreation OFF
  → noop_communication_only

state: identity is floating, conditionalLeadCreation ON, decision passes
        shouldOpenPhoneCreateLead's gates (canonical source, name not aggregator,
        age window, LB-recovery only when channel is LB-owned)
  → attach_existing_customer     (pre-create CRM phone lookup found customer)
  → attach_existing_lead         (pre-create CRM phone lookup found lead)
  → canonical_lead_create        (no CRM match; OP creates the lead)

state: identity is floating, conditionalLeadCreation ON, decision rejects
  → noop_communication_only      (with reason from shouldOpenPhoneCreateLead)
```

### 7.4 Sigcore source

New; not implemented today. Sigcore-direct events (participant tag updates, contact-name lookups) feed identity normalization only:

```
state: any
  → enrich_only           (fill display_name / contact_id / participant key on identity)
```

Sigcore-direct events never produce CRM rows. The OP webhook path continues to be the conversation-bearing trigger.

### 7.5 manual_sf source

Operator UI; engine bypassed. Operators use `applyLeadCustomerLink` directly (constitution §1.3 names it as the only manual writer).

### 7.6 Freeze

If `policy.freeze === true`, every plan with a writing decision becomes `frozen`. `enrich_only` continues to run (identity row updates are not frozen — only CRM-business-link projection is). Adapters MUST honor `frozen` by not calling any projection executors.

---

## 8. Invariants

Codified in the engine; failure to satisfy = refuse the plan (set `decision='noop_communication_only'` with reason, or return `kind:'error'` for structural corruption).

| ID | Invariant | Where checked |
|---|---|---|
| **R1** | Resolver call precedes every decision. | `reconcile()` entry. Adapters that bypass the engine bypass this — covered by call-site audit. |
| **R2** | Ambiguous resolver result → no projection plan returned. | After resolver call. |
| **R3** | Identity row in same tenant as `userId`. | After resolver call; resolver already filters but we re-assert. |
| **R4** | `attach_existing_*` only when CRM row passes tenant scope guard. | Inside the CRM-anchor lookup helper (today's `findCrmMatchByPhone` already does this; engine wraps it). |
| **R5** | `child_acquisition` only when parent is canonical (`parent_lead_id IS NULL`). | Carried from `assertCreateChildLeadInvariant` in `lib/lb-ingestion.js`. Engine re-checks before plan return; adapter re-checks before insert. |
| **R6** | `child_acquisition` parent in same tenant. | Same as R5. |
| **R7** | Confidence downgrade never auto-collapses. Weak match never upgrades to strong. | Engine never re-classifies resolver output. |
| **R8** | Identity row is stable across sources. Engine never produces a plan that creates a new identity row when a known identity exists. | Resolver already enforces; engine asserts `plan.identityId === resolver.identity.id`. |
| **R9** | Acquisition lineage preserved. Engine never produces a `child_acquisition` or `reactivation_lead` decision that *replaces* an existing canonical — only *adds* a sibling/reactivation. | By decision-table construction; tested. |
| **R10** | Cross-tenant blocked. CRM-anchor lookups and child-lead parent fetches scope by `userId`. | Engine wraps; adapter executors also re-check (defense in depth, matches today). |
| **R11** | Freeze switch halts projection only. Identity graph mutations continue. | Engine emits `frozen` for projection decisions; resolver still runs. |
| **R12** | The engine writes nothing outside the resolver call. All other writes happen in source adapter executors. | Code review boundary; lint rule TBD. |
| **R13** | **No duplicate graph truth.** The engine never adds a new reverse pointer from a CRM row to an identity row. It never persists its `ProjectionPlan` to the DB. The plan is a value object consumed by adapters; if a plan field needs to survive a process restart, the adapter writes it via the existing owner module (e.g., the linker), not via the engine. | Code review boundary; covered by [identity-graph-refactor-plan.md](./identity-graph-refactor-plan.md) §3.2a. |

---

## 9. Internal composition

```
reconcile(supabase, logger, input, policy):
  1. assertInputShape(input)                         // throws on missing required fields
  2. if policy.freeze AND decision-would-be-writing  // pre-check fast path
       (still proceeds to resolver call so identity row gets updated;
        only the plan.decision is forced to 'frozen' at step 6)
  3. resolveIdentity(supabase, input)                // PURE — see lib/identity-resolver.js
  4. if resolver.status === 'ambiguous'
       → return { kind: 'ambiguous', identityCandidates: resolver.candidates,
                  reason: resolver.reason }
     if resolver.status === 'error'
       → return { kind: 'error', error: resolver.error }
  5. identity = resolver.identity
     assertSameTenant(identity, input.userId)        // R3
  6. plan = decideProjection(identity, input, policy)
       // The decision table from §7. Pure function.
       // May call:
       //   - findCrmMatchByPhone (R4) for attach decisions
       //   - parentLeadCheck (R5, R6) for child_acquisition
       // Honors policy.freeze (R11)
  7. assertInvariants(plan, identity, input)         // R5-R10
  8. return { kind: 'matched', identity, plan }
```

`decideProjection` is itself decomposed into per-source classifiers (`decideForLeadbridge`, `decideForZenbooker`, `decideForOpenphone`, `decideForSigcore`). Each is pure and unit-testable. The dispatcher is one switch.

---

## 10. Execution layer

Adapters MAY switch on `plan.decision` themselves, or call `executePlan(plan, executors)` for a uniform dispatch.

```
executePlan(supabase, logger, plan, executors):
  switch plan.decision:
    case 'canonical_lead_create':
      lead = await executors.createCanonicalLead(plan, ...)
      await setIdentityLead(...)              // projection cascade
    case 'child_acquisition':
      child = await executors.createChildLead(plan, ...)
      // does NOT call setIdentityLead — child preserves canonical
    case 'reactivation_lead':
      lead = await executors.createReactivationLead(plan, ...)
      await setIdentityLead(...)              // projection cascade onto existing customer
    case 'canonical_customer_create':
      customer = await executors.createCanonicalCustomer(plan, ...)
      await setIdentityCustomer(...)
    case 'attach_existing_customer':
      await setIdentityCustomer(plan.attachTarget.id)
    case 'attach_existing_lead':
      await setIdentityLead(plan.attachTarget.id)
    case 'enrich_only':
      await executors.enrich(plan, ...)
    case 'noop_communication_only':
    case 'frozen':
    case 'ambiguous':
      return
```

The executors interface is per-source; the engine doesn't define them globally. Each adapter (`leadbridge-service.js`, `zenbooker-sync.js`, OP path in `server.js`) supplies its own `Executors` object. This keeps source-specific concerns (LB stage automation, ZB job sync chaining, OP conversation upsert) where they belong.

---

## 11. Observability

The engine emits a single structured log per call:

```
[Reconciliation] event=reconcile source=<src> tenant=<id> identity_id=<id|null>
                 decision=<decision> confidence=<class> match_step=<step|null>
                 reason=<tag> ambiguous=<bool> frozen=<bool> duration_ms=<n>
```

Counters derived in Loki:
- `count_over_time({service_name="service-flow-backend"} |= "[Reconciliation]" | source="leadbridge" | decision="child_acquisition" [1h])`
- Ambiguity rate per source.
- Decision distribution per tenant.

The existing `[IdentityLink]` log from `lib/identity-linker.js` is unchanged; the engine layer adds `[Reconciliation]` as a higher-level event. The two together let us answer:

- "How often did the engine *want* to project vs. how often did the projection *succeed*?"
- "Per tenant, what fraction of LB events become child acquisitions?"
- "Has ambiguity rate dropped after operator review surface improvements?"

---

## 12. Testing

Three test surfaces:

1. **Pure decision tests** (`tests/identity-reconciliation-engine.test.js`). Drive every cell of the §7 decision tables. No DB. Inputs: identity-state mocks + IdentityInput + TenantPolicy. Outputs: ProjectionPlan equality.
2. **Resolver-integration tests** (extends existing `tests/identity-resolver.test.js` style). Use the in-memory Supabase mock to confirm the engine calls the resolver exactly once per `reconcile()` and forwards strict/dryRun correctly.
3. **Adapter contract tests** per source. For each existing adapter (LB / ZB / OP), assert that wrapping it with the engine produces byte-identical CRM-side outcomes as the current code for a recorded set of test events. This is the migration confidence test — Stage 2/3/4 in [identity-graph-refactor-plan.md](./identity-graph-refactor-plan.md) gate on these.

Total target: ~80 new tests added, no existing tests rewritten.

---

## 13. Performance

The engine adds zero net DB round-trips:

- The resolver call is unchanged.
- The CRM-anchor phone lookup (`findCrmMatchByPhone`) is done at most once per call — same as today. The engine moves it from per-adapter to a single call inside `decideProjection`.
- Parent-lead fetch for `child_acquisition` is done once — same as today.
- The projection executors do the same writes they do today.

The only added cost is one synchronous decision-table evaluation per call (~microseconds) and one structured log emit.

---

## 14. Migration / dark-rollout posture

Implementation Stage 1 (per [identity-graph-refactor-plan.md](./identity-graph-refactor-plan.md) §5):

- The engine ships dark. No call site is converted.
- Tests prove the decision table.
- `RECONCILIATION_ENGINE_AVAILABLE` flag exists but is unused.

Stage 2/3/4: per-source per-tenant flip. The adapter check is:

```js
if (isEnabledForTenant(FLAGS.RECONCILIATION_ENGINE_LEADBRIDGE, userId)) {
  const result = await engine.reconcile(supabase, logger, input, policy);
  // dispatch via executePlan(...) or manual switch
} else {
  // legacy inline path — exactly today's resolveOrCreateLead body
}
```

Flag clear → legacy path. No code change required to roll back per-tenant.

---

## 15. What this design intentionally does NOT do

- It does **not** introduce a new matcher. Resolver stays as-is.
- It does **not** change projection semantics. `lib/identity-linker.js` is the writer.
- It does **not** read tenant settings. Adapters pass policy in.
- It does **not** add new identity-graph state. Same row shape.
- It does **not** widen auto-merge or weaken strict mode. The engine carries the resolver's verdict.
- It does **not** know about `identity_projections` table (future). When that table arrives, only `lib/identity-linker.js` learns about it; engine signature is unchanged.

---

## 16. Open questions

1. **Executor interface — typed or duck-typed?** TS isn't in the backend; JSDoc-typed object with required keys is the practical answer. Confirm before Stage 2 PR.
2. **`enrich_only` for ZB.** Today the `upsertCustomerFromZB` enrich logic is interleaved with adoption logic. Engine separates them — enrich becomes its own decision. Acceptable as long as adapter executors still atomic-update the customer row in one statement.
3. **Sigcore-direct enrichment** (§7.4). Triggering conditions = participant tag updates from Sigcore that arrive *outside* an OpenPhone webhook. Today these don't exist as a separate path — they're folded into the conversation webhook. If we want a Sigcore-direct entrypoint, [sigcore-integration-audit.md](./sigcore-integration-audit.md) describes the gap.
4. **Should `applyLeadCustomerLink` route through the engine?** Today it's the operator-override path with its own audit row (`resolved_by='operator_override'`). Recommendation: no — operator overrides are deliberate exceptions, and routing them through the engine would let the engine "veto" an operator decision. The operator is allowed to violate the engine's heuristics; they own the conflict.

---

## 17. Pointers

- Engine target: `lib/identity-reconciliation-engine.js` (to be created in Stage 1).
- Resolver (unchanged): [lib/identity-resolver.js](../../lib/identity-resolver.js).
- Linker (unchanged): [lib/identity-linker.js](../../lib/identity-linker.js).
- Source registry (read-only input): [lib/source-registry.js](../../lib/source-registry.js).
- Name/phone normalization: [lib/name-normalize.js](../../lib/name-normalize.js).
- Existing source orchestrators that become adapters: [leadbridge-service.js](../../leadbridge-service.js) `resolveOrCreateLead`, [zenbooker-sync.js](../../zenbooker-sync.js) `upsertCustomerFromZB`, [server.js](../../server.js) `maybeCreateLeadFromOpenPhone` + `handleOpenPhoneConditionalLeadCreation`.
- Pure helpers consumed by the engine: [lib/lb-ingestion.js](../../lib/lb-ingestion.js), [lib/openphone-ingestion.js](../../lib/openphone-ingestion.js), [lib/openphone-crm-match.js](../../lib/openphone-crm-match.js).
- Companion docs: [identity-graph-refactor-plan.md](./identity-graph-refactor-plan.md), [materialization-audit.md](./materialization-audit.md), [sigcore-integration-audit.md](./sigcore-integration-audit.md).
