# Cross-Source Identity Reconciliation

**Status:** Phase 0 (dark code) shipped 2026-05-21. All resolver flags OFF.
**Owner:** Identity v5 working group.
**Related:** [identity-reconciliation-runbook.md](../operations/identity-reconciliation-runbook.md), [lead-cardinality-and-parent-lead-id.md](./lead-cardinality-and-parent-lead-id.md), Phase A–F commit history (`4839429`, `b747fa3`, `ee12b06`, `0a2f8a8`).

---

## 1. Goal

One real person becomes **one linked identity graph** across:

- LeadBridge lead (acquisition source)
- Zenbooker customer (operational truth)
- ServiceFlow lead/customer (CRM orchestration)
- OpenPhone / Sigcore participant (communication identity)

And the CRM business link is projected onto:

```sql
leads.converted_customer_id = customers.id
```

---

## 2. Identity graph authority (LAYERED MODEL — read first)

`communication_participant_identities` is **NOT the CRM.** It is **NOT** the leads table. It is **NOT** the customers table. The earlier architectural drift happened because these concepts were blended together. Re-state the layering explicitly:

| Layer | Owner | What it holds | Authority for |
|---|---|---|---|
| Cross-source canonical graph | `identity-resolver` + `communication_participant_identities` | Who, across the layers below, is the same real person | **Identity-graph authority** — who is who |
| Communication identity | Sigcore / OpenPhone | Participant of *this conversation*. Participant IDs, phone, comm display name | Communication truth |
| Acquisition truth | LeadBridge | Where did this lead come from. What we paid (`lead_cost`). Campaign attribution | Acquisition / ROI truth |
| Operational customer truth | Zenbooker | Who actually pays. Bookings, jobs, addresses, payments | Booking / job operational truth |
| CRM projection layer | ServiceFlow leads / customers | Operational projections of the identity graph for UI, pipeline, conversion funnel | None — projection only |

**Rules:**
1. **The identity graph is the source of truth for identity, NOT ServiceFlow.** SF leads / customers are projections; they exist to give the operator a UI surface for pipelines, conversions, and bookings. They are not where "who is who" is decided.
2. Each non-identity layer remains the canonical source for its own fields. The identity graph never overwrites layer-owned data. The resolver enforces fill-null semantics for the small identity-coordination surface it does touch (`display_name`, `email`, etc.).
3. CRM business links (`leads.converted_customer_id`) are **projections** of the identity graph, not parallel facts.
4. Operational projections are plural: one person can have many leads (acquisition events), one customer, many conversations. Identity stays singular.

### 2a. Identity stability invariant (correction #2, 2026-05-21)

> **One person → one identity graph node → many operational projections possible.**

The identity row's `id` is stable across:
- ZB sync (customer create / update)
- LB sync (multiple acquisitions, repeat campaigns, reactivations)
- OP / Sigcore sync (conversations across years)
- Manual SF actions (operator overrides, conflict resolution)

What this rules out:
- Creating a new identity row when LB produces a child lead (children share the identity)
- Creating a new identity row when ZB syncs the same customer twice (resolver matches via `zenbooker_customer_id`)
- Creating a new identity row when OP starts a new conversation with the same participant
- Creating a new identity row during retroactive repair

Identity-row creation only happens in `resolveIdentity` Step 5 (no candidate found) or operator-initiated merge actions in the Identity Conflicts UI.

### 2b. Communication-history invariant

> **Conversations belong to the identity, not to any lead.**

Communication history (messages, calls, conversation rows, OP participant identities) is attached to `communication_participant_identities.id` directly. It is NOT attached to a specific lead. This means:
- A canonical lead and its children share the same communication history.
- Closing or deleting a lead does not affect conversation history.
- Reactivation through OP does not require new conversation context — it's already there on the identity.

### 2c. ServiceFlow projections are operational, not authoritative

ServiceFlow's `leads`, `customers`, `jobs` tables exist to project the identity graph + layer-owned data into operational artifacts the operator can work with. The operator sees:
- "Lead: Kira Osipova" — this is a projection. The identity layer decided Kira-the-person; LB decided Kira-the-acquisition; SF surfaces both as a pipeline-active row.
- "Customer: Kira Osipova" — projection. ZB decided Kira-the-customer with booking facts; identity-graph decided Kira-the-customer is the same Kira as the lead; SF surfaces both as a customer-detail page.

The projection layer (`lib/identity-linker.js`) writes only the join keys (`leads.converted_customer_id`). It never invents identity claims.

---

## 3. Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Inbound sources                                                        │
│   LB webhook    ZB webhook    OP webhook    Operator UI                 │
└──┬───────────────┬──────────────┬────────────────┬──────────────────────┘
   ▼               ▼              ▼                ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  resolveIdentity()  [lib/identity-resolver.js]    UNCHANGED             │
│   Single source of MATCHING truth.                                      │
│   Writes only identity row state.                                       │
│   Never writes leads.converted_customer_id directly.                    │
└──┬──────────────────────────────────────────────────────────────────────┘
   ▼ returns matched identity to caller
┌─────────────────────────────────────────────────────────────────────────┐
│  setIdentityCustomer / setIdentityLead   [lib/identity-linker.js]       │
│   Only authorized writers of sf_customer_id / sf_lead_id.               │
│   Guarded atomic UPDATE with OR (col IS NULL OR col = $new).            │
│   On success, automatically call projectIdentityToCRM.                  │
└──┬──────────────────────────────────────────────────────────────────────┘
   ▼ identity now has both sides populated
┌─────────────────────────────────────────────────────────────────────────┐
│  projectIdentityToCRM()    PURE PROJECTION                              │
│   No matching. No scoring. No tenant settings reads.                    │
│   Policy passed by caller.                                              │
│                                                                         │
│   Writes:                                                               │
│     leads.converted_customer_id = identity.sf_customer_id               │
│     leads.converted_at           = now()                                │
│     leads.updated_at             = now()                                │
│   + identity_link_audit row (forensic)                                  │
│   + [IdentityLink] structured log → Loki                                │
│                                                                         │
│   Optional (caller policy.allowStageMove): move to "Won" stage.         │
│   Default OFF — see correction #3 in the design history.                │
└─────────────────────────────────────────────────────────────────────────┘
```

**No DB triggers.** The flow is application-level so it stays testable, replayable, and observable in Loki.

---

## 4. Source precedence (NEVER violated)

| Field | Owning layer | Rule |
|---|---|---|
| `customers.first_name`, `last_name` | ZB | LB / OP never overwrite if ZB-present. Resolver's `buildEnrichPatch` is fill-null only. |
| `customers.phone`, `email`, `address` | ZB | Same. |
| `leads.source` | LB | **Never overwrite. Ever.** Funnel/ROI sacred. |
| `leads.lead_cost`, `created_at`, `utm_*` | LB | Same. |
| `leads.converted_customer_id` (NEW projection target) | Projection | Written only when `IS NULL`. Operator override is the only path to change. |
| `identities.display_name` | ZB > SF > LB > OP | Resolver-enforced fill-null. |
| `identity_priority_source` | leadbridge > openphone > manual > sync | Resolver-enforced priority_order. |

The projection layer touches **only** `converted_customer_id`, `converted_at`, `updated_at`. The column whitelist is hardcoded in [lib/identity-linker.js](../../lib/identity-linker.js) and verified by `tests/identity-linker.test.js` ("I3/I4: source, lead_cost, created_at, pipeline_id never modified").

---

## 5. Invariants (codified, enforced, monitored)

| ID | Invariant | Enforcement | Test |
|---|---|---|---|
| **I1** | Cross-tenant link impossible | Every UPDATE filtered by `user_id`; customer's `user_id` re-verified inside projection; mismatch → `[IdentityLinkInvariantViolation]` log + refusal | `projectIdentityToCRM cross-tenant blocked` |
| **I2** | One lead never auto-converts to multiple customers | Projection's `WHERE converted_customer_id IS NULL` guard; subsequent attempts return `lead_already_linked_to_other` | `I2: refused when lead linked to different customer` |
| **I3** | Projection cannot overwrite stronger-source fields | Column whitelist `{converted_customer_id, converted_at, updated_at}` only | `I3/I4: source, lead_cost, created_at, pipeline_id never modified` |
| **I4** | Projection cannot mutate attribution fields | Same whitelist | Same test |
| **I5** | Every auto-link reversible | Every projection writes `identity_link_audit` row | `writes identity_link_audit row` |
| **I6** | **One acquisition event always produces one preserved record.** LeadBridge events cannot disappear into enrichment-only updates. | Phase 0.5: `LEAD_CARDINALITY_CHILD_LEADS` flag → `createChildLeadFromLB` writes new row with `parent_lead_id` instead of collapsing. Reactivation path writes new canonical with `lead_origin_type='reactivation'`. | `lb-child-lead.test.js`, `lead-aggregation.test.js` |
| **I7** | Linker never deletes a lead | No `DELETE FROM leads` anywhere in `lib/identity-linker.js` or `leadbridge-service.js` child-create path | Grep-time check |
| **I8** | **Identity row is stable across sources.** Child-lead creation, ZB resync, OP reconnect, retroactive repair — none create new identity rows. | Child-create code path does not touch `communication_participant_identities`; resolver-driven inserts gated to "no candidate found" path; retroactive repair never inserts identities | `IDENTITY STABILITY: child creation never touches identity row` |
| **I9** | **Communication history belongs to the identity, not to a lead.** | Conversations FK on identity row, not on lead; child-create path does not touch `communication_conversations` or participant tables | `COMMUNICATION HISTORY belongs to identity, not lead` |
| **I10** | **Confidence downgrade — wrong non-merge is safer than wrong merge.** When ambiguity appears (conflicting OP identities, multiple canonical leads, low-confidence retroactive merges), freeze projection / emit conflict / refuse to auto-collapse. | `assertCreateChildLeadInvariant` refuses grandchild; resolver returns `ambiguous` on conflicts (never picks); retroactive repair `repair-lead-links` gates HIGH on 8 conjunctive conditions; freeze switch is available globally | resolver tests, `repair-lead-links` test, this doc §6 |
| **I11** | **Retroactive repair: no auto-link during active concurrent edits.** If both `leads.updated_at` and `customers.updated_at` are within `activeWindowHours` (default 24h), downgrade HIGH → `review_required`. Operational safeguard for the cleanup window only; live ingestion uses guarded atomic UPDATEs instead. | `lib/retroactive-repair-guards.js` `shouldDowngradeForActiveWindow`; called from `/repair-lead-links` and `scripts/phase1-dryrun-repair.js` | `tests/retroactive-repair-guards.test.js` (15 cases) |

---

## 6. Identity confidence boundaries

**Design principle:** *A wrong non-merge is safer than a wrong merge.*

The resolver is intentionally conservative:

- Strong-name matching (Levenshtein ≤ 2 or token-set match) merges automatically.
- Weak matches log to `communication_identity_ambiguities` for operator review (in strict mode they reject).
- Phone-only matches **with no name on either side** are allowed (conversation-level association, splittable later).
- Phone-only matches **with conflicting names** are always rejected.
- CRM-anchor preference: when the phone candidate is already linked to a customer/lead and the names don't outright conflict, adopt that anchor.

The projection layer adds no further classification. If the resolver said "same person," projection writes the CRM link. If the resolver said "ambiguous," projection never fires (because `sf_lead_id` or `sf_customer_id` never gets set).

---

## 7. Known limitations of phone-centric identity resolution

The current resolver assumes phone ≈ identity. This breaks in:

- **Households:** spouse A + spouse B + adult child share one phone.
- **Business virtual receptionists:** many participants behind one phone.
- **Recycled numbers:** original owner cancelled; carrier reassigned.
- **Office shared lines:** N employees behind one DID.

Current mitigation:
- Strict mode + name classification reject collisions.
- Ambiguity queue surfaces them for operator review.
- `identity_conflicts` (P0.1) collision detector flags cross-role/cross-tenant cases.

Future direction (not in Phase 0):
- Per-identity confidence score on top of strict/runtime modes.
- Email anchor when phone is known-recycled.
- Name-primary matching when phone is known-shared.

Document accepted, bounded. Operator UI surfaces ambiguity rather than guessing.

---

## 8. Lead lifecycle semantics (the four canonical cases)

### Case A — Existing customer submits new Thumbtack request

1. ZB customer C already exists. `identity I → sf_customer_id = C`.
2. LB webhook arrives with same phone + name.
3. Resolver: external_id lookup misses (no LB contact id yet); phone candidates include `I` (already CRM-linked) → CRM-anchor preference adopts `I`.
4. `enrichIdentity` fills `leadbridge_contact_id` on `I`. Caller (`leadbridge-service.js`) checks `identity.sf_customer_id` is set → does NOT create a lead. Returns `identity_already_customer`.
5. Result: no new lead. Communication stays attached to the existing customer.
6. **Acquisition attribution loss:** the Thumbtack lead never appears in funnel. This is intentional under current Phase B design but conflicts with I6. See Phase 0.5 design doc — `parent_lead_id` will let us preserve the acquisition record as a child lead linked to the customer.

### Case B — Existing lead submits new Yelp request months later

1. LB lead L1 exists from January Thumbtack. `identity I → sf_lead_id = L1`.
2. March Yelp webhook arrives, same phone+name.
3. Resolver adopts `I` (phone+strong name).
4. Caller checks `identity.sf_lead_id` is set → `enrichLeadFromLB(L1, …)` runs, fill-null only.
5. Result: L1 is updated (no fields overwritten because of fill-null). **No L2 created.** Yelp lead_cost and March campaign attribution lost.
6. Same I6 violation. Resolved by Phase 0.5 `parent_lead_id`.

### Case C — Same phone but different household member

1. Lead L1 exists for "Anna Smith". ZB customer arrives for "John Smith" same phone.
2. Resolver: phone candidates include `I` (Anna's identity). Name classification → `classifyNameMatch('john smith', 'anna smith', …)` → tokens disjoint → `conflict`.
3. Resolver logs ambiguity (`phone_name_conflict_or_multi`), returns `status='ambiguous'`. `attemptedLeadToCustomerLink` is NOT called from anywhere; the new linker has no scoring engine.
4. Operator sees the ambiguity row in the queue and either:
   - Resolves via "create_new" (separate identity for John).
   - Resolves via "merge_into" (rare — only if Anna and John are confirmed same person).
5. Until operator acts, no projection happens. No spurious link.

### Case D — Existing customer contacts through OpenPhone only

1. ZB customer C exists. Identity `I → sf_customer_id = C`.
2. OP webhook arrives with same phone, no lead. `shouldOpenPhoneCreateLead` checks `identity.sf_customer_id` → returns `{ create: false, reason: 'identity_has_customer' }`.
3. Conversation attaches to identity. **No shadow lead is created.** This is the explicit rule from operator correction #11 (2026-05-21).
4. The conversation surfaces under the customer's profile via the existing comm UI.

---

## 9. Forensic audit (`identity_link_audit`)

Every projection write inserts a row:

```sql
CREATE TABLE identity_link_audit (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  lead_id INTEGER NOT NULL,
  customer_id INTEGER NOT NULL,
  identity_id INTEGER NULL,
  resolved_by VARCHAR NOT NULL,         -- automatic | operator_override | retroactive_repair | ambiguity_resolution | source_projection
  resolution_reason VARCHAR NOT NULL,    -- e.g. identity_graph_projection
  name_class VARCHAR NULL,               -- strong_exact | strong_tokenset | strong_leven | weak_* | conflict | one_missing | neither_named
  phone_match BOOLEAN NULL,
  source_compat BOOLEAN NULL,
  notes TEXT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (lead_id, customer_id)
);
```

The `UNIQUE(lead_id, customer_id)` constraint makes re-runs of the same projection idempotent at the audit layer: subsequent inserts return 23505, which `writeAuditRow` treats as `ok:true, idempotent:true`.

Rollback recipe (operator-only):

```sql
-- Revert all auto-projections from the last N hours for tenant X
UPDATE leads
   SET converted_customer_id = NULL, converted_at = NULL
 WHERE id IN (
   SELECT lead_id FROM identity_link_audit
    WHERE user_id = $tenant
      AND resolved_by = 'automatic'
      AND created_at > now() - interval '$N hours'
 )
   AND converted_customer_id IS NOT NULL;

INSERT INTO identity_link_audit (user_id, lead_id, customer_id, resolved_by, resolution_reason, notes)
SELECT $tenant, lead_id, customer_id, 'operator_rollback', 'rollback_phase_0', 'reverted at ' || now()
  FROM identity_link_audit
 WHERE user_id = $tenant AND resolved_by = 'automatic'
   AND created_at > now() - interval '$N hours';
```

Manual-conversion entries (`resolved_by='operator_override'`) are **never touched** by rollback.

---

## 10. Feature flags

| Flag | Default | Effect |
|---|---|---|
| `IDENTITY_RESOLVER_AVAILABLE` | OFF | Foundation; no behavior. |
| `IDENTITY_RESOLVER_LEADBRIDGE` | OFF | When ON, LB ingest routes through resolver → setters → projection. |
| `IDENTITY_RESOLVER_OPENPHONE` | OFF | When ON, OP routes through resolver. |
| `IDENTITY_RESOLVER_ZENBOOKER` | OFF | When ON, ZB customer upserts route through resolver. |
| `OPENPHONE_CONDITIONAL_LEAD_CREATION` | OFF | When ON, OP creates leads only when identity has no existing lead/customer. |
| `IDENTITY_BACKFILL_ENABLED` | OFF | Gates `POST /api/identities/backfill`. |
| `IDENTITY_REPORTING_UI` | OFF | Gates the Phase F dashboard UI. |
| **`IDENTITY_PROJECTION_FREEZE`** | OFF | Phase 0. When ON, halts all projection writes (resolver + setters still update identity graph). Operational containment switch. |
| **`LEAD_CARDINALITY_CHILD_LEADS`** | OFF | **Phase 0.5.** When ON, repeat LB acquisitions on an identity that already has `sf_lead_id` create child leads (`parent_lead_id` set) instead of enriching the canonical. Also enables the reactivation path (existing customer + new LB → new canonical lead). Must be ON for a tenant BEFORE `IDENTITY_RESOLVER_LEADBRIDGE` for the same tenant. |

Per-tenant override: `<FLAG>_TENANTS=2,7` env var (comma-separated user IDs) — uses `isEnabledForTenant(flag, userId)` from `lib/feature-flags.js`. Per-tenant ON overrides global OFF. Per-tenant OFF + global ON still means ON for that tenant.

---

## 11. Replay / recovery

Event-driven systems must handle replay safely. Behavior under each failure mode:

| Event | Outcome | Notes |
|---|---|---|
| Webhook delivered twice (same payload) | Resolver finds existing identity via external-id → `enrichIdentity` no-op-ish → setter idempotent (guarded by OR-NULL UPDATE) → projection idempotent (NULL guard on `converted_customer_id`) | Audit table unique constraint prevents duplicate audit row. |
| Setter UPDATE succeeds, projection fails | Identity row is in correct state. `converted_customer_id` may still be NULL. Next event that triggers the setter (or a manual repair) will retry projection. | Audit row NOT written. Loki shows `event=set_customer outcome=success` + `event=project outcome=update_failed`. |
| Projection UPDATE succeeds, audit insert fails | Lead is linked. Audit row missing → forensic gap. Loki warn line emitted. | Operator can `INSERT INTO identity_link_audit` manually using the Loki `[IdentityLink]` line as source. |
| Projection UPDATE succeeds, Loki emit fails | Lead linked + audit row written. Loki gap only — visible in Grafana as missing counter. | Acceptable; audit table is the source of truth for forensics. |
| DB outage mid-projection | Setter's UPDATE rolls back; projection never fires. On recovery the system replays naturally because the identity row still lacks `sf_*` for the affected source. | No partial state — guarded UPDATE pattern is atomic. |
| Queue replay after outage | Same as "delivered twice." Idempotent throughout. | |
| Concurrent LB + ZB webhooks for same person | Both calls hit the same identity. First setter wins (guarded UPDATE), second is a no-op. Projection happens once. | Verified by guarded UPDATE pattern; no test for this race yet (Phase 0.5 add). |

---

## 12. Operational red lines (thresholds before tenant enablement)

Before flipping `IDENTITY_RESOLVER_*_TENANTS=<id>` for any tenant, the following must hold:

| Metric | Acceptable | Source |
|---|---|---|
| Ambiguity queue growth | < 5 new rows / hour during steady-state | Loki: `count_over_time({service_name="service-flow-backend"} \|= "communication_identity_ambiguities" \|= "insert" [1h])` |
| Projection success rate | > 95% of `set_customer` / `set_lead` events lead to `project=success` or `idempotent` | Loki: ratio of `outcome=success` vs other |
| Cross-tenant blocked count | 0 | Loki: `outcome=cross_tenant_blocked` |
| Projection refused (`lead_already_linked_to_other`) | < 1 / day per tenant | Loki: `outcome=lead_already_linked_to_other` |
| Collision (setter) | < 5 / hour | Loki: `outcome=collision` |

A breach pages the operator. Freeze switch (`IDENTITY_PROJECTION_FREEZE=true`) is the first-line containment.

---

## 13. Rollout order (this is the only approved sequence)

```
Phase 0    — dark code + audit table + metrics + freeze switch       ✓ DONE
Phase 0.5  — lead cardinality (parent_lead_id, lead_origin_type,     ✓ DONE — flags OFF
              canonical_lead_id generated column, LB child path,
              reactivation path, analytics personSummary)
Phase 1    — retroactive dry-run report on user_id=2                  ◯ ready (no dep on 0.5)
Phase 2    — operator-reviewed apply for user_id=2 (HIGH only)        ◯ ready
Phase 3    — IDENTITY_RESOLVER_ZB/LB + LEAD_CARDINALITY_CHILD_LEADS   ◯ Audit Task 10 + Phase 0.5
              enabled for user_id=2 only (per-tenant env vars)            checklist must be reviewed
Phase 4    — OpenPhone enablement for user_id=2                       ◯
Phase 5    — gradual per-tenant rollout                               ◯
```

**Flag flip order within Phase 3 (per tenant T):**
1. `LEAD_CARDINALITY_CHILD_LEADS_TENANTS += T` first
2. `IDENTITY_RESOLVER_LEADBRIDGE_TENANTS += T` after step 1 is verified
3. `IDENTITY_RESOLVER_ZENBOOKER_TENANTS += T` last

Doing step 2 before step 1 causes the first repeat-LB event for T to enrich the canonical instead of creating a child → acquisition record lost. The runbook gates this explicitly.

Constraints, immutable:
- No global flag flip.
- No automatic tenant expansion.
- No automatic backfill apply.
- No phase skipped.

---

## 13a. Future roadmap — `identity_projections` table

The current implementation uses two columns on the identity row to express projections into the CRM layer:

```
communication_participant_identities
  sf_lead_id      INTEGER NULL → leads(id)
  sf_customer_id  INTEGER NULL → customers(id)
```

**This is transitional architecture.** It is *not* the intended final graph model. The cardinality is intentionally limited:
- One identity ↔ one canonical lead via `sf_lead_id`. Repeat acquisitions go to children, not new identity rows.
- One identity ↔ one customer via `sf_customer_id`. Multi-account customers (B2B with multiple billing entities) are unaddressed.
- No projection-type metadata. We cannot express "this identity has a SF lead, a ZB customer, AND a Sigcore communication entity" as parallel projections of different roles.
- No confidence score on the projection.

The intended long-term shape is a separate `identity_projections` table:

```sql
CREATE TABLE identity_projections (
  id              BIGSERIAL PRIMARY KEY,
  identity_id     INTEGER NOT NULL REFERENCES communication_participant_identities(id),
  projection_type VARCHAR NOT NULL,    -- 'sf_lead' | 'sf_customer' | 'zb_customer' | 'sigcore_participant' | 'lb_contact' | future types
  projection_id   TEXT    NOT NULL,    -- foreign key into the target table (text to handle non-integer keys like sigcore_participant_id)
  projection_role VARCHAR NULL,        -- 'canonical' | 'child' | 'archived' | 'merged_into'
  source_system   VARCHAR NOT NULL,    -- the system that originated this projection
  confidence      VARCHAR NOT NULL,    -- 'auto_high' | 'auto_medium' | 'operator_verified' | 'inferred'
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  superseded_at   TIMESTAMPTZ NULL,
  UNIQUE (identity_id, projection_type, projection_id)
);
```

Benefits:
- Many projections per identity per type — addresses the multi-customer and multi-canonical-lead cases.
- Confidence + role metadata travels with the projection — enables policy at projection-read time, not just write time.
- Supersession is explicit — `superseded_at` retains history without deleting; rollback is a `UPDATE superseded_at = NULL` rather than re-inserting.
- New projection types (future LeadBridge campaign objects, future Sigcore conversation chains, future ZB recurring booking schedules) plug in without schema changes.

**Why not now?**
- Two-column model is good enough to ship the Phase 0–5 rollout that closes the immediate attribution-loss bug.
- Migrating to `identity_projections` is a separate effort that needs its own design + repair pass on historical data.
- The two-column model can co-exist with the future table during migration: `sf_lead_id` becomes a denormalized convenience pointer to the canonical-role row in `identity_projections`.

**Write down "this is transitional" in code:** every site that reads or writes `sf_lead_id` / `sf_customer_id` should carry a comment referencing this section so future contributors don't hardcode "one lead per identity" assumptions deeper into the codebase.

Pre-existing files that touch these columns directly (Phase 0.5 state):
- `lib/identity-resolver.js` — `enrichIdentity`, `createFloatingIdentity`, `findByLinkedCrm`
- `lib/identity-linker.js` — `setIdentityCustomer`, `setIdentityLead`, `projectIdentityToCRM`
- `lib/identity-backfill.js` — Phase 2 backfill writer
- `migrations/006_leadbridge_communication_layer.sql` — column definitions
- `migrations/047_identity_combine_rpcs.sql` — RPC functions for combine

Migrating to `identity_projections` would require adapter functions in `lib/identity-resolver.js` and `lib/identity-linker.js` that translate the legacy column reads/writes into table operations. Sketched but deferred.

---

## 14. Pointers

- Code: [lib/identity-linker.js](../../lib/identity-linker.js), [lib/identity-resolver.js](../../lib/identity-resolver.js), [lib/feature-flags.js](../../lib/feature-flags.js)
- Migrations: `migrations/048_identity_link_audit.sql` (and `_down.sql`)
- Tests: `tests/identity-linker.test.js`, `tests/identity-resolver.test.js`
- Runbook: [docs/operations/identity-reconciliation-runbook.md](../operations/identity-reconciliation-runbook.md)
- Cardinality design: [docs/architecture/lead-cardinality-and-parent-lead-id.md](./lead-cardinality-and-parent-lead-id.md)
- Audit Task 10 conclusions: see commit history of `4839429`, `b747fa3`, `ee12b06`, `0a2f8a8`, `cddac0d`, `a26b0ce` — no safety regression; rollout paused due to operator focus shift to P0 incidents.
