# New Integration Requirements

**Status:** Authoritative contract for any new integration that touches identity or CRM projections.
**Owner:** Identity v5 working group.
**Companion:** `cross-source-identity-reconciliation.md`, `integration-compliance-audit.md`, `identity-enforcement-roadmap.md`.

Every new integration that creates, links, or updates customers / leads / participants in ServiceFlow MUST satisfy this contract before merging to `main`. Existing integrations must be reviewed against this contract on every material change.

This document protects the architecture from "sync spaghetti" recurrence — duplicate matching engines, parallel identity systems, and direct CRM writes that bypass the canonical writers.

---

## 1. Mandatory deliverables

Every new integration's PR MUST include:

### a. Adapter module

Path: `lib/integrations/<name>-adapter.js` (or equivalent location consistent with existing adapters).

The adapter's job is:
1. Normalise the integration's payload into the `IdentityInput` shape (see §2 below).
2. Call `engine.reconcile(supabase, logger, input, policy)` from `lib/identity-reconciliation-engine.js`.
3. Switch on the returned `plan.decision` and call the appropriate **authorised writer**:
   - `setIdentityCustomer` / `setIdentityLead` (graph hydration)
   - `createLeadFromLB` / `createChildLeadFromLB` (LB-specific cardinality — only for LB-class adapters)
   - `applyLeadCustomerLink` (operator override path)
   - The adapter's own `createX` function for source-owned tables (e.g., `customers` for ZB)
4. Honour invariants (R1–R13 in `identity-reconciliation-engine-design.md` §8).

**The adapter MUST NOT:**
- Implement its own matching logic.
- Write to `leads.converted_customer_id`, `leads.parent_lead_id`, `leads.lead_origin_type`, or `communication_participant_identities.{sf_lead_id, sf_customer_id, last_hydrated_by, status}` directly.
- Maintain its own local dedupe / merge engine.
- Manipulate `identity_link_audit` rows directly.

If any of the above MUST happen for legitimate operational reasons (e.g., customer-merge-like operator action), the integration MUST:
- Document the bypass in `integration-compliance-audit.md` §2.
- Wrap it with `recordTransitionalBypass(...)` from `lib/identity-graph-violation.js`.
- Include a migration target + retirement criterion.

### b. Identity normalisation

The adapter MUST normalise inbound identifiers into the engine's `IdentityInput` shape:

```ts
type IdentityInput = {
  userId: number;                  // tenant scope — required
  source: 'leadbridge' | 'openphone' | 'zenbooker' | 'manual_sf' | 'sigcore' | '<new-source>';

  // At least one of:
  phone?: string | null;
  email?: string | null;
  externalId?: string | null;      // source-specific external id (e.g., LB contact id)
  sigcoreParticipantId?: string | null;
  sigcoreParticipantKey?: string | null;

  displayName?: string | null;

  // Source-event metadata
  event: {
    type: 'lead_received' | 'customer_created' | 'customer_updated' | 'message_received' | '<new-type>';
    channel?: string | null;
    accountDisplayName?: string | null;
    company?: string | null;
    lastEventAt?: string | null;
    message?: string | null;
    payload?: object;
  };

  strict?: boolean;
  dryRun?: boolean;
};
```

The adapter MUST NOT invent new fields. Extensions to the shape require a design-doc update + engine PR.

### c. Reconciliation entrypoint

The adapter MUST be the SOLE path between the integration's webhook/sync and the identity graph.

Acceptable code shape (illustrative):

```js
async function onInboundEvent(supabase, logger, rawPayload) {
  const input = normalise(rawPayload);
  const policy = buildPolicyForTenant(input.userId);
  const result = await engine.reconcile(supabase, logger, input, policy);
  if (result.kind === 'ambiguous') return;  // resolver said ambiguous; stop.
  if (result.kind === 'error') return;
  await executePlan(result.plan, /* source-specific executors */);
}
```

NO direct supabase calls between `normalise()` and `engine.reconcile()`. The engine call is the ONLY place where identity matching happens.

### d. Source precedence registration

The adapter MUST register its source in `lib/source-registry.js`:

```js
SOURCES['<new-source>'] = {
  priority: <number>,                   // lower = higher precedence
  role: '<role>',
  creates_lead: 'yes' | 'no' | 'conditional',
  creates_customer: 'yes' | 'no' | 'conditional',
  owned_channels: [...],                // sources this integration is canonical for
  external_id_columns: [...],           // columns the resolver maps external IDs to
  affects_identity_priority: <boolean>,
  is_sync_adapter: <boolean>,           // true if it's a sync source (ZB-like)
};
```

Source precedence is documented in `cross-source-identity-reconciliation.md` §4 — adding a source requires reviewing how it interacts with existing precedence (LB > OP > manual > sync today).

### e. Ownership model

The adapter MUST document, in its PR description AND in the integration-compliance audit:

- Which fields the integration is canonical for (e.g., ZB owns `customers.{first_name, address, ...}`).
- Which fields it must NEVER overwrite (e.g., LB never overwrites `customers.first_name` when ZB-present).
- How the resolver's fill-null semantics interact with the integration's own enrich logic.

If the integration introduces a new canonical field, the synchronization-constitution (`synchronization-constitution.md`) must be updated in the same PR.

### f. Replay behaviour

The adapter MUST be replay-safe:

- Calling `engine.reconcile` twice with the same input MUST be idempotent at the identity graph layer (resolver's external-id match handles this).
- Calling executor functions twice MUST be idempotent at the CRM-projection layer (guarded UPDATE pattern: `WHERE converted_customer_id IS NULL`).
- The `identity_link_audit` `UNIQUE(lead_id, customer_id)` constraint handles audit-row idempotency.

Replay scenarios that MUST work without producing duplicates or errors:
- Webhook delivered twice
- Sync runs after a webhook
- Migration re-runs

### g. Ambiguity handling

The adapter MUST stop on ambiguous resolver output:

```js
if (result.kind === 'ambiguous') return;
```

It MUST NOT:
- "Pick" an identity from the ambiguity candidates.
- Create a fresh identity when the resolver said ambiguous.
- Bypass the ambiguity check.

The ambiguity row in `communication_identity_ambiguities` is the operator's surface. The adapter's job is to put it there and stop.

### h. Rollback posture

The adapter MUST be safely roll-backable:

- Feature flag gates the new code path. New adapter code defaults OFF until the operator opts a tenant in.
- No schema changes that can't be `IF NOT EXISTS` / additive (provide a down migration if any).
- If the adapter introduces a new column on an existing graph table, follow the `last_hydrated_by` pattern (nullable, observational, never load-bearing).

### i. Observability

The adapter MUST emit the standard log streams:

- `[Reconciliation]` (from the engine — automatic when calling `engine.reconcile`).
- `[IdentityLink]` (from authorised writers — automatic).
- `[IdentityGraphViolation]` (only if the adapter intentionally bypasses an authorised writer — see `recordTransitionalBypass`).

Loki must be able to filter by `source=<new-source>` for every metric in `reconciliation-health-dashboard.md`.

### j. Projection behaviour

The adapter MUST NOT make projection decisions independently. The engine's `plan.decision` enum is the authority:

```
canonical_customer_create | canonical_lead_create | child_acquisition |
reactivation_lead | attach_existing_customer | attach_existing_lead |
enrich_only | noop_communication_only | frozen | ambiguous
```

The adapter EXECUTES one of these — it does not decide which one. If the integration needs a new decision shape, extend the engine's decision table in a separate PR (with operator approval), don't invent it in the adapter.

---

## 2. Explicit prohibitions

A new integration's PR will be REFUSED if it contains any of the following:

| Prohibited | Why | Alternative |
|---|---|---|
| Direct `INSERT` into `customers` outside the adapter's own customer-create path | Bypasses graph + projection | Call `engine.reconcile`, then the adapter's `createCustomerFromX` (which goes through `setIdentityCustomer`) |
| Direct `UPDATE leads SET converted_customer_id = ...` | Bypasses canonical projection writer | Call `applyLeadCustomerLink` (operator) or rely on `setIdentityCustomer` → `projectIdentityToCRM` cascade |
| Direct `UPDATE communication_participant_identities SET sf_lead_id = ...` | Bypasses setter + provenance + audit | Call `setIdentityLead` |
| Direct `UPDATE communication_participant_identities SET sf_customer_id = ...` | Same | Call `setIdentityCustomer` |
| Local scoring engine (any Jaccard / Levenshtein / fuzzy match outside `lib/identity-resolver.js` or the existing `@transitional` fallback) | Parallel matching — destination state | Use the resolver via the engine. New matching policy needs an engine-level design doc. |
| Local merge primitive (joining two identity rows / two customers) | Authority drift | Use the operator UI (`/api/identity-conflicts/:id/combine`) which goes through the linker |
| Reading `identity_link_audit` to inform live decisions | Audit table is observational | Read `last_hydrated_by` on the identity row (also observational) OR re-derive the decision via the engine |
| New "matching confidence" threshold tunables | Widening risk | Resolver thresholds are frozen until the v6 design pass |

---

## 3. Required tests

Every new integration's PR MUST include:

| Test class | Examples |
|---|---|
| Adapter unit tests | One per engine decision branch; assert the right executor is called with the right args |
| Replay tests | Same input twice → same DB state |
| Cross-tenant isolation tests | Event for tenant A does not touch tenant B's data |
| Ambiguity tests | Resolver-ambiguous result → no executor call |
| Freeze tests | `IDENTITY_PROJECTION_FREEZE=true` → no writes |
| Violation-emitter tests | Any bypass (if any) is wrapped in `recordTransitionalBypass` with `kind`, `source`, `target`, `reason` |
| Source-registry test | New source's `priority`, `creates_lead`, etc. are correct |

Minimum coverage: every authorised writer the adapter touches has at least one adapter-contract test that proves the writer is called with the expected args.

---

## 4. Documentation deliverables

Every new integration's PR MUST update:

| Doc | What to add |
|---|---|
| `docs/architecture/integration-compliance-audit.md` §1 | New row in the integration matrix |
| `docs/architecture/integration-compliance-audit.md` §2 | New entries in authorised writers (if any) OR transitional bypasses (with migration target) |
| `docs/operations/reconciliation-health-dashboard.md` | If new metric names are introduced, add to Group A or D with thresholds |
| `lib/source-registry.js` | New source entry |
| `docs/architecture/cross-source-identity-reconciliation.md` §4 | If source precedence is altered, update the precedence table |
| `synchronization-constitution.md` §1 | If the integration owns new canonical fields, add an ownership row |

---

## 5. Review checklist

Reviewer must verify before approving:

- [ ] Adapter module exists at the agreed path.
- [ ] Adapter normalises input to `IdentityInput`; does not invent fields.
- [ ] Adapter calls `engine.reconcile` exactly once per inbound event.
- [ ] Adapter's writes go through authorised writers (or are wrapped in `recordTransitionalBypass` with migration target).
- [ ] `lib/source-registry.js` updated.
- [ ] Replay tests pass.
- [ ] Cross-tenant tests pass.
- [ ] Ambiguity tests pass.
- [ ] Freeze tests pass.
- [ ] No new `kind=` value in violation emitter (would require updating `VIOLATION_KINDS` first).
- [ ] CI scanner (`scripts/check-identity-graph-bypass.js`) passes.
- [ ] Integration-compliance audit updated.
- [ ] Health dashboard contract updated if new metrics.
- [ ] Loki has at least one panel for the new `source=`.
- [ ] Rollback posture documented (per-tenant flag, down migration, etc.).

If any item fails, the PR returns to the author. No exceptions for "small" integrations — the cost of a violation now is years of sync spaghetti later.

---

## 6. Why this contract exists

The system was created over time without this contract. The result:

- 17 places where `leads` / `customers` were created directly.
- 3 different matching engines (scoring linker, ad-hoc adoption, opaque OP path).
- Identity-graph drift undiscovered for months.
- Operator memory + agent memory both claiming features were "shipped" when they weren't.

Recovery cost: 2026-05-22 Identity Rollout Recovery (see `docs/operations/identity-rollout-recovery-audit-2026-05-22.md`).

This contract codifies the corrective architecture so the recovery doesn't have to happen again. The cost of compliance is bounded (one adapter + tests + doc updates per integration). The cost of NON-compliance is unbounded (drift compounds).

---

## 7. Cross-references

- Engine API: `lib/identity-reconciliation-engine.js` / design `identity-reconciliation-engine-design.md`
- Authorised writers: `lib/identity-linker.js` / design `cross-source-identity-reconciliation.md`
- Violation emitter: `lib/identity-graph-violation.js`
- CI scanner: `scripts/check-identity-graph-bypass.js`
- Compliance audit: `docs/architecture/integration-compliance-audit.md`
- Enforcement roadmap: `docs/architecture/identity-enforcement-roadmap.md`
- Health dashboard: `docs/operations/reconciliation-health-dashboard.md`
- Source precedence: `cross-source-identity-reconciliation.md` §4
- Synchronization constitution: `synchronization-constitution.md`
