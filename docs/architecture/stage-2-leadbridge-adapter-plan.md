# Stage 2 — LeadBridge Adapter Conversion (Plan)

**Status:** Plan — implementation gated on operator acceptance (2026-05-22 directive).
**Owner:** Identity v5 working group.
**Scope:** LeadBridge webhook + sync route through `lib/identity-reconciliation-engine.js` behind `RECONCILIATION_ENGINE_LEADBRIDGE_TENANTS`. **No ZB / OP / manual-SF / Sigcore conversion in this stage.**
**Parent doc:** [identity-graph-refactor-plan.md](./identity-graph-refactor-plan.md) §5 Stage 2.
**Constraint envelope:** [identity-graph-refactor-plan.md §3.2a](./identity-graph-refactor-plan.md) (No Duplicate Graph Truth) + [identity-reconciliation-engine-design.md §8](./identity-reconciliation-engine-design.md) (R1–R13).

---

## 1. Goal

When `RECONCILIATION_ENGINE_LEADBRIDGE_TENANTS` includes a tenant, LB webhook + sync events for that tenant flow through `engine.reconcile()` → existing LB executors. When the flag is absent (default state for every tenant on day 1), behavior is byte-identical to today's legacy path.

The engine consolidates *control flow*. Writers (`createLeadFromLB`, `createChildLeadFromLB`, `enrichLeadFromLB`, `setIdentityLead`, `setIdentityCustomer`) stay in `leadbridge-service.js`. Matcher stays in `lib/identity-resolver.js`. Projection stays in `lib/identity-linker.js`. Nothing about resolver confidence, projection semantics, child-lead invariants, or LB source attribution changes.

---

## 2. Required prerequisites (per-tenant, immutable order)

Stage 2 enablement for tenant `T` requires both of the following flags to already include `T`:

```
1.  LEAD_CARDINALITY_CHILD_LEADS_TENANTS   ⊇ {T}   (Phase 0.5 — child + reactivation paths)
2.  IDENTITY_RESOLVER_LEADBRIDGE_TENANTS   ⊇ {T}   (Phase B — resolver-first LB)
3.  RECONCILIATION_ENGINE_LEADBRIDGE_TENANTS ⊇ {T} (THIS STAGE)
```

If step 3 is set without steps 1 and 2 for `T`, the adapter detects the missing prerequisite and **falls back to the legacy path and emits a rate-limited warning** for that tenant. (Belt-and-suspenders: the runbook also gates flag flips.) This is the same safety pattern the existing `LEAD_CARDINALITY_CHILD_LEADS` → `IDENTITY_RESOLVER_LEADBRIDGE` chain already uses.

**Required warn log on prerequisite-miss:**

```
[LB engine] path=legacy reason=missing_prerequisite tenant=<id> missing=<comma-separated prerequisites>
```

The `missing` token uses stable, short identifiers (alphabetised so log shape is deterministic for tests and Loki queries):

- `child_leads` — `LEAD_CARDINALITY_CHILD_LEADS_TENANTS` does not include the tenant.
- `resolver` — `IDENTITY_RESOLVER_LEADBRIDGE_TENANTS` does not include the tenant.

Three observable cases (each must be covered by tests + included in rollout verification §7.2):

| Case | `missing=` value |
|---|---|
| Missing child-leads prerequisite only | `child_leads` |
| Missing resolver prerequisite only | `resolver` |
| Both missing | `child_leads,resolver` |

**Rate-limiting:** the warn is emitted at most **once per `(tenant, missing-set)` per process lifetime**. Process restart (re-deploy) resets the suppression set — that is the intended cadence so operators get re-notified after each release. No persistent state.

Rationale for non-silent fallback: silent fallback hides operator-induced misconfiguration. A warn is the right signal: it does not page (warn, not error) but it surfaces in Loki and is grep-able by the runbook.

Rationale for routing-through-engine prohibition: routing through the engine when the resolver flag is OFF would mean the engine calls `resolveIdentity()` but the legacy phone-only identity-upsert branch is also in play — two writers to the identity table at once. Forbidden by §3.2a.

---

## 3. Exact files changed

| File | Change type | What changes |
|---|---|---|
| `lib/lb-engine-adapter.js` | **NEW** | Engine-to-LB adapter module. Exports `makeAdapter({ supabase, logger, executors })` which binds the engine + existing LB writers and returns `{ resolveOrCreateLeadViaEngine, dispatchPlan, tenantPolicyForLB, checkPrerequisites, emitPrereqMissingWarning }`. Pure plus the engine call; no DB writes outside the engine + bound executors. |
| `leadbridge-service.js` | Edit, additive | New import of `lib/lb-engine-adapter`. After the existing LB writers (`createLeadFromLB`, `createChildLeadFromLB`, `enrichLeadFromLB`) are defined inside the factory, instantiate the adapter with `makeAdapter(...)`. Wire **one guarded branch each** in the LB webhook handler (`POST /webhooks`) and `runLbSync`: when `checkPrerequisites(userId).useEngine === true`, call `resolveOrCreateLeadViaEngine` instead of the existing `upsertParticipantIdentity` + `resolveOrCreateLead` pair; otherwise emit rate-limited warn if engine flag is set but prerequisites missing, then run legacy unchanged. **Existing writer functions (`upsertParticipantIdentity`, `enrichLeadFromLB`, `createLeadFromLB`, `createChildLeadFromLB`, `resolveOrCreateLead`, `upsertConversation`, `runLbSync` body, webhook handler body) are not edited beyond the guarded branch insertion.** |
| `tests/lb-engine-adapter.test.js` | **NEW** | Adapter contract tests (§7 below) — proves byte-equivalent CRM outcomes for nine canonical scenarios across legacy vs engine paths. |
| `tests/lb-engine-rollout.test.js` | **NEW** | Dark-rollout tests — flag absent uses legacy, flag set for `user_id=2` uses engine, flag set for `user_id=2` does not affect `user_id=3`. |
| `docs/architecture/identity-graph-refactor-plan.md` | Edit (1 line) | Tick Stage 2 status from "pending" → "in flight" when the PR opens; "completed" on merge. No content change to the plan itself. |

**Wording note:** "Existing writer functions are not edited. Existing call sites receive one guarded engine branch each." That is the precise scope of edits to `leadbridge-service.js`.

**Files NOT touched:**

- `lib/identity-reconciliation-engine.js` — engine stays as shipped in Stage 1. Adapter consumes it; engine does not learn about LB.
- `lib/identity-resolver.js` — resolver unchanged. (R7 — engine never widens auto-merge.)
- `lib/identity-linker.js` — linker unchanged. (R12 — engine writes nothing outside resolver.)
- `lib/lb-ingestion.js` — pure helpers unchanged.
- `lib/feature-flags.js` — flag was added in Stage 1.
- `zenbooker-sync.js`, `server.js` (OP path), `POST /api/leads`, `POST /api/customers` — Stage 3+, not touched.
- All other backend tests — they must continue to pass without modification.

---

## 4. Adapter shape (pseudocode for review)

```js
// leadbridge-service.js — additive only. No existing function is edited.

const engine = require('./lib/identity-reconciliation-engine');
const { FLAGS, isEnabled, isEnabledForTenant } = require('./lib/feature-flags');

function tenantPolicyForLB(userId) {
  return {
    childLeadsEnabled:        isEnabledForTenant(FLAGS.LEAD_CARDINALITY_CHILD_LEADS, userId),
    reactivationLeadsEnabled: isEnabledForTenant(FLAGS.LEAD_CARDINALITY_CHILD_LEADS, userId),
    conditionalLeadCreationEnabled: false,  // OP-only, irrelevant for LB
    freeze:                   isEnabled(FLAGS.IDENTITY_PROJECTION_FREEZE),
    allowStageMove:           false,
  };
}

// Returns the SAME shape as resolveOrCreateLead() so downstream conversation/
// message code is byte-identical:
//   { type, id, created, action, parent_lead_id? }   on success
//   null                                              on ambiguous / no-op
async function resolveOrCreateLeadViaEngine(userId, input) {
  const result = await engine.reconcile(supabase, logger, {
    userId,
    source: 'leadbridge',
    externalId: input.lbContactId || null,
    phone: input.customerPhone,
    email: input.customerEmail,
    displayName: input.customerName,
    event: {
      type: 'lead_received',
      channel: input.channel,
      accountDisplayName: input.accountDisplayName,
      message: input.message,
    },
  }, tenantPolicyForLB(userId));

  if (result.kind === 'ambiguous' || result.kind === 'error') return null;
  return await dispatchLBPlan(userId, result.identity, result.plan, input);
}

async function dispatchLBPlan(userId, identity, plan, input) {
  switch (plan.decision) {
    case engine.DECISIONS.CANONICAL_LEAD_CREATE:
      return await createLeadFromLB(userId, identity, input);
    case engine.DECISIONS.CHILD_ACQUISITION:
      const child = await createChildLeadFromLB(userId, plan.parentLeadId, identity, input);
      return child
        ? { type: 'child_lead', id: child.id, parent_lead_id: plan.parentLeadId, created: true, action: 'child_acquisition' }
        : null;  // invariant refusal → fall back to legacy enrich would happen here, see §5.2
    case engine.DECISIONS.REACTIVATION_LEAD:
      return await createLeadFromLB(userId, identity, input);  // existing fn detects sf_customer_id → reactivation
    case engine.DECISIONS.ENRICH_ONLY:
      await enrichLeadFromLB(userId, identity.sf_lead_id, input);
      return { type: 'lead', id: identity.sf_lead_id, created: false, action: 'enriched' };
    case engine.DECISIONS.ATTACH_EXISTING_CUSTOMER:
      await setIdentityCustomer(supabase, logger, {
        userId, identityId: identity.id, customerId: plan.attachTarget.id,
        identitySnapshot: identity,
        policy: { resolvedBy: 'automatic', resolutionReason: 'identity_graph_projection', source: 'leadbridge', allowStageMove: false },
      });
      return { type: 'customer', id: plan.attachTarget.id, created: false, action: 'linked_customer' };
    case engine.DECISIONS.ATTACH_EXISTING_LEAD:
      await setIdentityLead(supabase, logger, {
        userId, identityId: identity.id, leadId: plan.attachTarget.id,
        identitySnapshot: identity,
        policy: { resolvedBy: 'automatic', resolutionReason: 'identity_graph_projection', source: 'leadbridge', allowStageMove: false },
      });
      await enrichLeadFromLB(userId, plan.attachTarget.id, input);
      return { type: 'lead', id: plan.attachTarget.id, created: false, action: 'linked_enriched' };
    case engine.DECISIONS.NOOP_COMMUNICATION_ONLY:
      return identity.sf_customer_id
        ? { type: 'customer', id: identity.sf_customer_id, created: false, action: 'identity_already_customer' }
        : null;
    case engine.DECISIONS.FROZEN:
      return null;  // adapter honors freeze; conversation/message still upsert downstream
    default:
      logger.warn(`[LB engine] unexpected decision ${plan.decision}`);
      return null;
  }
}

// Webhook handler — single new branch
const useEngine =
  isEnabledForTenant(FLAGS.RECONCILIATION_ENGINE_LEADBRIDGE, userId)
  && isEnabledForTenant(FLAGS.IDENTITY_RESOLVER_LEADBRIDGE, userId)     // prerequisite chain §2
  && isEnabledForTenant(FLAGS.LEAD_CARDINALITY_CHILD_LEADS, userId);    //

let identity;
if (useEngine) {
  const leadResult = await resolveOrCreateLeadViaEngine(userId, {
    channel, customerName: participant.name, customerPhone: participant.phone,
    customerEmail: participant.email, message: message.body,
    externalLeadId: thread.external_lead_id, lbContactId: participant.external_contact_id,
    accountDisplayName: resolvedAccountDisplayName,
  });
  // Engine path resolves the identity internally via the resolver.
  // For conversation/message attach, re-read the identity by lbContactId or phone.
  identity = await upsertParticipantIdentity_readOnly(userId, { phone, lbContactId, ... });
} else {
  // Legacy — unchanged
  identity = await upsertParticipantIdentity(userId, { phone, email, displayName, lbContactId, channel });
  if (identity) resolveOrCreateLead(userId, identity, { ... }).catch(...);
}

// downstream upsertConversation / message INSERT — UNCHANGED
```

**Note on the identity re-read** (last block above): the engine resolves the identity internally; for conversation/message attach we need it in hand. The cleanest implementation is to have `resolveOrCreateLeadViaEngine` also return the identity row alongside the result. Final API will be `{ identity, leadResult }` — pseudocode here simplified.

---

## 5. Plan-to-executor dispatch table

The mapping is closed (every engine `DECISIONS.*` is handled):

| Engine decision | LB executor invoked | Existing return shape preserved |
|---|---|---|
| `canonical_lead_create` | `createLeadFromLB` (which calls `setIdentityLead` → projection cascade) | `{ type: 'new_lead'\|'reactivation_lead', id, created: true, action }` |
| `child_acquisition` | `createChildLeadFromLB` (no identity-row write, no setter) | `{ type: 'child_lead', id, parent_lead_id, created: true, action: 'child_acquisition' }` |
| `reactivation_lead` | `createLeadFromLB` (detects `identity.sf_customer_id` → sets `lead_origin_type='reactivation'`) | `{ type: 'reactivation_lead', id, created: true, action: 'reactivation' }` |
| `enrich_only` | `enrichLeadFromLB(userId, identity.sf_lead_id, input)` | `{ type: 'lead', id, created: false, action: 'enriched' }` |
| `attach_existing_customer` | `setIdentityCustomer(...)` — no row insert | `{ type: 'customer', id, created: false, action: 'linked_customer' }` |
| `attach_existing_lead` | `setIdentityLead(...)` + `enrichLeadFromLB` | `{ type: 'lead', id, created: false, action: 'linked_enriched' }` |
| `noop_communication_only` | none (return identity-already-customer payload OR null) | `{ type: 'customer', ..., action: 'identity_already_customer' }` or `null` |
| `frozen` | none | `null` |
| `ambiguous` (resolver) | none — engine returns before plan | `null` (legacy returns null on ambiguous too) |
| `error` | none | `null` |

### 5.1 Equivalence proof (cell-by-cell)

For each engine decision, the executor invoked is **the same executor the legacy `resolveOrCreateLead` calls in the corresponding branch**. The control-flow tree is preserved 1:1:

```
Legacy resolveOrCreateLead                       Engine path
─────────────────────────────────                ─────────────────────────────────
if identity.sf_lead_id:                          decideForLeadbridge state='has_lead'
  child_leads ON → createChildLeadFromLB         + childLeadsEnabled=true → CHILD_ACQUISITION
                                                                          → createChildLeadFromLB ✓
  child_leads OFF → enrichLeadFromLB              + childLeadsEnabled=false → ENRICH_ONLY
                                                                            → enrichLeadFromLB ✓
elif identity.sf_customer_id:                    decideForLeadbridge state='has_customer'
  child_leads ON → createLeadFromLB              + reactivationLeadsEnabled=true → REACTIVATION_LEAD
                   (lead_origin_type=reactivation)                              → createLeadFromLB ✓
  child_leads OFF → return identity_already_customer + reactivationLeadsEnabled=false → NOOP_COMMUNICATION_ONLY
                                                                              → return same shape ✓
elif phone match → customer:                     decideForLeadbridge state='floating'
  setIdentityCustomer + return linked_customer   + crmMatch.type='customer' → ATTACH_EXISTING_CUSTOMER
                                                                            → setIdentityCustomer ✓
elif phone match → lead:                         decideForLeadbridge state='floating'
  setIdentityLead + enrichLeadFromLB              + crmMatch.type='lead' → ATTACH_EXISTING_LEAD
                                                                       → setIdentityLead + enrichLeadFromLB ✓
else:                                            decideForLeadbridge state='floating' + no crmMatch
  createLeadFromLB                                                              → CANONICAL_LEAD_CREATE
                                                                                → createLeadFromLB ✓
```

This is what the contract tests in §7 verify mechanically.

### 5.2 Child-create invariant refusal

When the engine's R5/R6 check detects a grandchild scenario (`parent.parent_lead_id IS NOT NULL`), it downgrades the decision to `NOOP_COMMUNICATION_ONLY` with reason `parent_invariant_*`. The legacy path falls back to `enrichLeadFromLB` in this case (see `leadbridge-service.js:482` "Child create failed (e.g., invariant violation) — fall through to legacy enrich.").

**Plan:** when the dispatcher receives `NOOP_COMMUNICATION_ONLY` with a `parent_invariant_*` reason, it MUST fall through to `enrichLeadFromLB(userId, identity.sf_lead_id, input)` to preserve legacy behavior. This keeps the LB webhook responsive (200 ack) and the lead-cardinality work silently deferred. Contract test #10 (§7) covers this.

---

## 6. Flag behavior

| Flag | Default | Effect when set for tenant T |
|---|---|---|
| `RECONCILIATION_ENGINE_LEADBRIDGE` | OFF (global) | Global flip not used in Stage 2 — per-tenant only. |
| `RECONCILIATION_ENGINE_LEADBRIDGE_TENANTS=2,7` | empty | LB webhook + sync for users 2 and 7 route through engine. All other users stay on legacy. |
| `IDENTITY_RESOLVER_LEADBRIDGE_TENANTS` (prereq) | per existing rollout | Required for engine path. If absent for T, adapter falls back to legacy. |
| `LEAD_CARDINALITY_CHILD_LEADS_TENANTS` (prereq) | per existing rollout | Required for engine path. If absent for T, adapter falls back to legacy. |
| `IDENTITY_PROJECTION_FREEZE` | OFF | Existing global freeze switch. Engine path emits `FROZEN` decisions when set; dispatcher returns null (matches legacy freeze behavior — projection halts, identity row continues to update). |

**No new tenant-scoped flags introduced.** Stage 2 reuses the Stage 1 flag set.

---

## 7. Tests added

### 7.1 `tests/lb-engine-adapter.test.js` — adapter contract tests

One test per row of the dispatch table, asserting byte-equivalent CRM outcomes between legacy and engine paths. Uses in-memory mock Supabase (same pattern as `tests/identity-resolver.test.js`).

| # | Scenario | Setup | Assertion |
|---|---|---|---|
| 1 | New LB lead (floating, no CRM) | Empty `leads` / `customers` / `identities` | Engine path creates one identity, one lead, sets `identity.sf_lead_id`; legacy path produces equivalent state. Diff is empty. |
| 2 | Existing identity, sf_lead_id set, child flag OFF | Seed: identity + canonical lead | Engine: `enrich_only` → `enrichLeadFromLB`. Legacy: same. Lead row unchanged except `updated_at`; **no new lead row inserted**. |
| 3 | Existing identity, sf_lead_id set, child flag ON | Seed: identity + canonical lead | Engine: `child_acquisition` → `createChildLeadFromLB`. New child row with `parent_lead_id` set; identity row **NOT touched**; canonical lead **NOT touched** (other than legacy update_at on enrich path — engine path does NOT call enrich for child). |
| 4 | Existing identity, sf_customer_id set, child flag OFF | Seed: identity + customer (no lead) | Engine: `noop_communication_only` returning `identity_already_customer`. Legacy: same. No new lead inserted. |
| 5 | Existing identity, sf_customer_id set, child flag ON | Seed: identity + customer | Engine: `reactivation_lead` → `createLeadFromLB` with `lead_origin_type='reactivation'`. Projection cascade auto-links new lead to existing customer via `setIdentityLead` → `projectIdentityToCRM`. `identity_link_audit` row written. |
| 6 | Ambiguous resolver | Seed: two phone-matching identities with conflicting names | Engine: returns `kind: 'ambiguous'` BEFORE plan. Adapter returns null. **No lead inserted. No identity row mutated. Ambiguity row in `communication_identity_ambiguities`.** Same as legacy. |
| 7 | Cross-tenant blocked | Seed: identity for tenant 99, incoming event claims tenant 2 | Engine: resolver's `user_id=2` filter excludes tenant 99's identity. Engine creates a fresh identity for tenant 2. **Tenant 99 data untouched.** Adapter never writes cross-tenant. |
| 8 | Replay duplicate (webhook event_id seen before) | Seed: prior webhook event with same `event_id` | Outer webhook handler (unchanged) short-circuits on event log. Engine path **never invoked** for the duplicate. Lead count unchanged. |
| 9 | Replay duplicate (same LB external_id, second resolver call) | Run engine twice with same `externalId` | Resolver's `external_id` step (`SOURCE_TO_EXTERNAL_COLUMNS.leadbridge`) returns the same identity. Engine emits `enrich_only`. **No new lead.** No duplicate identity row. |
| 10 | Grandchild refusal | Seed: identity → lead, lead is itself a child (`parent_lead_id` set) | Engine: R5 invariant downgrades to `noop_communication_only` with reason `parent_invariant_*`. Adapter falls through to legacy `enrichLeadFromLB`. `[LeadCardinalityConflict]` log emitted (already exists in `createChildLeadFromLB`). **No grandchild lead inserted.** |
| 11 | Conversation + message creation unaffected | Run scenario 1 end-to-end including conversation upsert | Conversation row inserted with `participant_identity_id` populated. Message row inserted under conversation. Both paths produce identical conversation + message state. |
| 12 | `[Reconciliation]` log emitted on engine path | Scenario 1 with logger spy | Engine path emits one `[Reconciliation]` line with `source=leadbridge`, `decision=canonical_lead_create`, `tenant=2`. Legacy path emits no `[Reconciliation]` line. |

Each test runs the same input through both paths (legacy with flag OFF, engine with flag ON for the tenant) and asserts the resulting DB state is equal. Equality is checked on:
- `leads` rows (count, fields, parent_lead_id, source, lead_origin_type, converted_customer_id).
- `customers` rows.
- `communication_participant_identities` rows (count, sf_lead_id, sf_customer_id, external IDs).
- `communication_identity_ambiguities` rows.
- `identity_link_audit` rows.

### 7.2 `tests/lb-engine-rollout.test.js` — dark rollout + prerequisite tests

| # | Scenario | Assertion |
|---|---|---|
| 1 | `RECONCILIATION_ENGINE_LEADBRIDGE_TENANTS` unset | Engine adapter never invoked; legacy `resolveOrCreateLead` called. No `[LB engine]` log emitted. |
| 2 | All three flags ON for user 2, event for user 2 | Engine adapter invoked. `[Reconciliation]` log emitted with `tenant=2`. `[LB engine] path=engine tenant=2 decision=<decision>` log emitted. |
| 3 | All three flags ON for user 2, event for user 3 | Legacy path invoked for user 3. No `[Reconciliation]` or `[LB engine]` log emitted. |
| 4 | Engine flag ON for user 2, resolver prereq missing | Legacy path used. Warn emitted exactly once: `[LB engine] path=legacy reason=missing_prerequisite tenant=2 missing=resolver`. Lead-create + identity-write byte-equivalent to pure legacy. |
| 5 | Engine flag ON for user 2, child-leads prereq missing | Legacy path used. Warn emitted exactly once: `[LB engine] path=legacy reason=missing_prerequisite tenant=2 missing=child_leads`. |
| 6 | Engine flag ON for user 2, both prereqs missing | Legacy path used. Warn emitted exactly once: `[LB engine] path=legacy reason=missing_prerequisite tenant=2 missing=child_leads,resolver` (alphabetised). |
| 7 | Same-tenant warn rate-limit | Same prereq-miss scenario fires 10 times for user 2. Warn log count = 1. (Per-process suppression.) |
| 8 | Different-tenant suppression | Prereq-miss for user 2 logs once; subsequent same-shape miss for user 7 logs once. Total = 2. (Suppression is per-tenant.) |
| 9 | Different-missing-set suppression | Prereq-miss for user 2 with `missing=resolver` logs once; later miss for same user with `missing=child_leads,resolver` logs once. Total = 2. (Suppression keyed by `(tenant, missingSet)`.) |
| 10 | Suppression reset via test hook | `_resetPrereqWarnCache()` empties the suppression Map; next call re-emits. (Simulates process restart.) |
| 11 | Legacy fallback preserves exact old behaviour | Run scenarios #4–#6 and assert resulting `leads`/`customers`/`identities`/`identity_link_audit` rows are bit-for-bit equal to running the same input with ALL `RECONCILIATION_ENGINE_*` flags unset. The warn log is the **only** observable difference. |
| 12 | Mixed-tenant batch (per-sync) | All three flags ON for user 2, OFF for user 3. Sync processes events for both. User 2's events go engine, user 3's go legacy. Both correct. |
| 13 | No flag caching within a request | All three flags ON for user 2, cleared mid-process. Subsequent call uses legacy. Verifies adapter re-reads env per call. |
| 14 | Engine path logs `[Reconciliation]` | Engine path (scenario #2) emits exactly one `[Reconciliation]` line per inbound event. Legacy paths (scenarios #1, #3, #4, #5, #6, #12) emit zero `[Reconciliation]` lines. |

Total new tests: ~26 across two files (12 contract + 14 rollout). No existing test is modified.

---

## 8. Observability

The Stage 1 engine already emits `[Reconciliation] event=reconcile source=<src> tenant=<id> identity_id=<id|null> decision=<decision> confidence=<class> match_step=<step|null> reason=<tag> ambiguous=<bool> frozen=<bool> duration_ms=<n>`.

In Stage 2 the LB adapter additionally emits:

- **info** `[LB engine] path=engine tenant=<id> decision=<decision> identity_id=<id>` on engine-path success (one per event).
- **warn** `[LB engine] path=legacy reason=missing_prerequisite tenant=<id> missing=<sorted-list>` on prerequisite-miss fallback. Rate-limited to once per `(tenant, missing-set)` per process lifetime (§2).
- **info** `[LB engine] path=engine tenant=<id> decision=ambiguous candidates=<csv>` when engine resolver returns ambiguous (one per event).
- **warn** `[LB engine] grandchild_refusal tenant=<id> parent=<id|unknown>` on the §5.2 invariant refusal (one per event; not rate-limited because the underlying state shouldn't recur).

The engine-flag-off case (no prerequisite-miss; the adapter is simply not asked to engage) emits **no** `[LB engine]` log. That's the standard "tenant not enrolled" state and would otherwise flood the log with noise.

Loki queries to confirm rollout:

```logql
count_over_time({service_name="service-flow-backend"} |= "[Reconciliation]" | source="leadbridge" | tenant="2" [1h])
count_over_time({service_name="service-flow-backend"} |= "[LB engine]" | path="engine" [1h])
# Prereq-miss alarm: any non-zero count is a misconfiguration that needs operator action.
count_over_time({service_name="service-flow-backend"} |= "[LB engine]" |= "missing_prerequisite" [1h])
```

If `path=engine` count is zero for a tenant we expected to be on engine, the prerequisite chain is the first thing to check.

---

## 9. Risks

| # | Risk | Likelihood | Mitigation |
|---|---|---|---|
| R1 | Engine + legacy `upsertParticipantIdentity` both call the resolver per webhook when both flags happen to be on simultaneously → duplicate resolver call | LOW | Adapter explicitly **skips `upsertParticipantIdentity`** when engine path is taken. The engine calls the resolver once. Contract test #9 covers replay. |
| R2 | Engine path's identity re-read for conversation/message attach is a second DB round-trip vs legacy's single fetch | LOW | Engine returns `result.identity` directly — no re-read needed. The pseudocode in §4 is simplified; final API will thread the identity from engine result into conversation upsert. |
| R3 | Engine refusal of grandchild scenario (§5.2) skips child-create AND skips enrich → silent acquisition loss | MEDIUM | Dispatcher MUST fall through to `enrichLeadFromLB` on `parent_invariant_*` reason. Contract test #10 enforces. |
| R4 | TenantPolicy constructed inside adapter drifts from what the legacy code reads | MEDIUM | TenantPolicy reads the **same** feature flag helpers (`isEnabledForTenant`) the legacy code uses. Contract tests #1–#5 toggle `LEAD_CARDINALITY_CHILD_LEADS_TENANTS` and assert engine path produces the same decision tree. |
| R5 | Per-tenant rollout enables engine but resolver flag absent → no identity row created → engine creates a fresh floating identity that duplicates the legacy identity for the same phone | MEDIUM | Adapter checks prerequisite chain (§2), falls back to legacy, **and emits a rate-limited warn** (`path=legacy reason=missing_prerequisite missing=resolver`) so the operator sees the misconfiguration in Loki. Rollout tests #4–#10 verify legacy fallback + warn shape + rate-limit + per-process suppression. |
| R6 | The `noop_communication_only` decision can fire for two distinct reasons (identity_already_customer vs grandchild refusal). Dispatcher dispatches on reason — if `reason` field changes, fall-through breaks | LOW | Reason values are defined in the engine and exported; adapter uses constants, not string literals. Add unit test asserting reason prefixes. |
| R7 | LB webhook handler is `async` and currently uses `resolveOrCreateLead(...).catch(...)` (fire-and-forget). Engine path may inadvertently change this to await | MEDIUM | Pseudocode keeps `.catch(...)` semantics. The engine call inside the adapter is awaited because we need the identity for the conversation insert, but the LB webhook handler MUST keep its outer error-swallowing posture to preserve the existing webhook latency budget. Contract test asserts webhook returns 200 even on engine error. |
| R8 | Existing webhook idempotency (event_id log) is the outer barrier. If a future PR adds a code path that bypasses event_id check, the engine would see the duplicate | LOW | Out of scope for Stage 2; flagged in materialization audit. |
| R9 | Engine path increases ambiguity-queue insertions because the engine + legacy upsert both feed the resolver's ambiguity logger? | NONE | Engine path replaces `upsertParticipantIdentity`. Resolver is called exactly once per event. Ambiguity insertion is deduped by `communication_identity_ambiguities` (open dedupe on user+source+phone+reason already exists in resolver). |
| R10 | Per-test mock supabase drift — adapter contract tests use a mock that doesn't perfectly model production constraints | LOW | Mock pattern reused from `identity-resolver.test.js` (battle-tested). Additionally, the existing `lb-child-lead.test.js` and `zenbooker-identity-resolver.test.js` mocks are referenced for parity. |

---

## 10. Rollback path

Stage 2 has three rollback granularities, in increasing scope:

| Trigger | Action | Recovery time |
|---|---|---|
| Specific tenant misbehaves | `RECONCILIATION_ENGINE_LEADBRIDGE_TENANTS` env var: remove that tenant's id, restart service | Seconds |
| All engine paths misbehave | Clear `RECONCILIATION_ENGINE_LEADBRIDGE_TENANTS` entirely (set to empty string) | Seconds |
| Engine + projection both misbehave | Set `IDENTITY_PROJECTION_FREEZE=true` (existing global freeze) | Seconds |
| Catastrophic | Revert the Stage 2 PR; legacy code paths are completely unchanged so revert is one merge | Minutes |

The Stage 2 PR introduces **zero schema changes** and **zero new writers**. There is nothing to roll back at the DB level. Every tenant that hasn't been added to `RECONCILIATION_ENGINE_LEADBRIDGE_TENANTS` is unaffected.

---

## 11. Acceptance criteria (gates Stage 2 → Stage 3)

Before Stage 3 (ZB adapter) starts:

1. Stage 2 PR merged with all new tests passing.
2. Full backend Jest suite passing (currently 87 suites / 2076 tests; Stage 2 adds ~30 tests, target 87 / 2106).
3. Stage 2 enabled for `user_id=2` (`Spotless Homes Florida` per the project map) for at least 48 hours.
4. Loki shows:
   - `[Reconciliation]` log count for `source=leadbridge tenant=2` is non-zero.
   - `[IdentityLink]` `outcome=success` rate ≥ legacy baseline (no regression).
   - `[LB engine] path=legacy` count for `tenant=2` is zero after the first cache warm.
   - Ambiguity queue growth ≤ 5/hr per `cross-source-identity-reconciliation.md` §12.
5. No new entries in `identity_link_audit` with `resolved_by='automatic'` that the operator can't explain.
6. Operator sign-off on the dashboard's lead-count, conversion-rate, and acquisition-rate metrics being stable.

Failure of any of (3)–(6) blocks Stage 3.

---

## 12. Out of scope for Stage 2

Explicit list to prevent scope creep:

- ZB / OP / manual-SF / Sigcore adapter conversion (Stages 3 / 4 / 4.5 / 5).
- Removing the legacy `upsertParticipantIdentity` FLAG-OFF branch (covered in materialization audit §10 action item 1, post-rollout).
- Removing `communication_participant_mappings.crm_*` legacy columns (covered in materialization audit §8.2a, post-rollout).
- Adding the `identity_projections` table (long-term, `cross-source-identity-reconciliation.md` §13a).
- Changing resolver confidence rules (R7 — explicit non-goal).
- Changing projection semantics (linker unchanged).
- Changing child-lead semantics (lb-ingestion.js unchanged).
- Changing LB source attribution (`pickLBSource` unchanged).
- Changing webhook idempotency (event_id log unchanged).
- Operator UI changes (separate stage).

---

## 13. Implementation order (within the Stage 2 PR)

When operator accepts this plan, the PR ships in this order on a single feature branch:

1. Add `resolveOrCreateLeadViaEngine` + `tenantPolicyForLB` + `dispatchLBPlan` to `leadbridge-service.js`. No call site uses them yet.
2. Add `tests/lb-engine-adapter.test.js` — runs the new helpers directly; all tests pass.
3. Add `tests/lb-engine-rollout.test.js` — runs the new helpers + flag combinations; all tests pass.
4. Wire the **one** new branch in the LB webhook handler (`POST /webhooks`) — guarded by the prerequisite chain.
5. Wire the **one** new branch in `runLbSync` — same guard.
6. Run full backend Jest suite — confirm 87 → ≥87 suites passing, 2076 → 2076+~30 tests passing.
7. Open PR. Operator reviews per §11 criteria.

Step 4 and 5 are the only edits to existing functions. Both are single `if (useEngine) { /* new path */ } else { /* legacy unchanged */ }` blocks.

---

## 14. Pointers

- Engine: [lib/identity-reconciliation-engine.js](../../lib/identity-reconciliation-engine.js) (Stage 1 shipped).
- LB adapter target: [leadbridge-service.js](../../leadbridge-service.js).
- Companion plans: [identity-graph-refactor-plan.md](./identity-graph-refactor-plan.md), [identity-reconciliation-engine-design.md](./identity-reconciliation-engine-design.md), [materialization-audit.md](./materialization-audit.md).
- Invariants: [identity-graph-refactor-plan.md §3.2a](./identity-graph-refactor-plan.md), [identity-reconciliation-engine-design.md §8 R1–R13](./identity-reconciliation-engine-design.md).
- Cardinality / child-lead semantics (unchanged): [lead-cardinality-and-parent-lead-id.md](./lead-cardinality-and-parent-lead-id.md).
