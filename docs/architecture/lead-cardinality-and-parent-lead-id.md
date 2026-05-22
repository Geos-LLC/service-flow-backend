# Lead Cardinality and `parent_lead_id` Design

**Status:** Phase 0.5 — **SHIPPED (2026-05-21)**, gated by `LEAD_CARDINALITY_CHILD_LEADS` flag (default OFF). Per-tenant rollout via `LEAD_CARDINALITY_CHILD_LEADS_TENANTS=2,7`. Migration 049 applied. Frontend changes for canonical/child display pending in a follow-up PR.
**Owner:** Identity v5 working group.
**Companion to:** [cross-source-identity-reconciliation.md](./cross-source-identity-reconciliation.md).
**Source:** Investigation B (2026-05-21), confirmed as a hard rollout blocker by the operator.

---

## 1. The problem

The current schema enforces **1 identity ↔ at most 1 lead, at most 1 customer**:

```sql
-- migrations/006_leadbridge_communication_layer.sql:67-69
sf_lead_id     INTEGER REFERENCES leads(id)     ON DELETE SET NULL,
sf_customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
```

Phase B's design (`b747fa3`) enforces this in code:

```js
// leadbridge-service.js:393-396
// HARD INVARIANT: identity already tied to a lead → enrich, NEVER create.
if (identity.sf_lead_id) {
  await enrichLeadFromLB(userId, identity.sf_lead_id, input)
  return { type: 'lead', id: identity.sf_lead_id, created: false, action: 'enriched' }
}
```

This is **incompatible with real acquisition systems.** A real person submits:

- Multiple campaigns (Thumbtack Jan, Yelp Mar, Google Sep)
- Multiple lead purchases on different platforms
- Multiple reactivations (cleaned-once-12-months-ago re-quotes)
- Seasonal re-entry (annual deep clean → re-quotes next year)
- Multiple conversations over time that re-cross into lead territory

Under current Phase B behavior with `IDENTITY_RESOLVER_LEADBRIDGE=true`:

| Scenario | Current behavior | Lost data |
|---|---|---|
| Same person, Thumbtack Jan + Yelp Mar | L1 created Jan. March enriches L1 (fill-null only); no L2. | Yelp `lead_cost`, March funnel start, source attribution per campaign |
| Same person, Thumbtack Jan + Thumbtack Sep (different campaign run) | Same. | September campaign attribution |
| Customer reactivation (12 months later as a lead) | Identity already has `sf_customer_id` → caller returns `identity_already_customer` → no lead created | Entire reactivation acquisition record |

This violates **Invariant I6** ("one acquisition event always produces one preserved acquisition record") and breaks LeadBridge ROI / campaign analytics.

---

## 2. Approved direction (Option 4)

Per operator approval (2026-05-21):

- **Identity remains attached to canonical/original lead.** `sf_lead_id` continues to point to the original (first) lead. Identity graph stays stable.
- **Subsequent LB acquisitions become sibling leads.** New rows in `leads` table; each with its own `source`, `lead_cost`, `created_at`, funnel history, attribution.
- **Add `leads.parent_lead_id`** to express the sibling relationship.
- **Child leads do NOT create new identity rows.** One person = one identity, multiple acquisition events.

```
leads
─────
  id = 100,  parent_lead_id = NULL, source = "Thumbtack Jan",   lead_cost = 200, created_at = 2026-01-15
  id = 245,  parent_lead_id = 100,  source = "Yelp Mar",        lead_cost = 150, created_at = 2026-03-22
  id = 580,  parent_lead_id = 100,  source = "Google Sep",      lead_cost = 75,  created_at = 2026-09-10

communication_participant_identities
─────
  id = 5,    sf_lead_id = 100,  sf_customer_id = 23421   (only canonical)
```

---

## 3. Lifecycle semantics (canonical wording)

### 3a. Definitions

- **Canonical lead** — the original lead row for this person/identity. `parent_lead_id IS NULL`. Pointed to by `identity.sf_lead_id`.
- **Child lead** — a subsequent acquisition record for the same identity. `parent_lead_id` points to the canonical lead.
- **Attribution grouping** — for funnel/source analytics, group by `COALESCE(parent_lead_id, id)` to view per-person funnel, or by `id` alone to view per-acquisition funnel.
- **Pipeline behavior** — only the canonical lead participates in pipeline stage logic (Won/Lost/etc.). Child leads carry acquisition data but never appear in pipeline stages. The CRM UI shows children as "additional acquisitions" under the canonical lead's detail view.
- **Conversion** — only the canonical lead's `converted_customer_id` is the CRM truth. Children inherit conversion status via `parent_lead_id`. Reporting can sum all children's `lead_cost` against the eventual customer's revenue for true CAC calculation.

### 3b. The four canonical lifecycle cases (with new semantics)

#### Case A — Existing customer submits new Thumbtack request

1. ZB customer C exists. Identity `I → sf_customer_id = C`. No prior lead (`sf_lead_id` NULL).
2. LB webhook arrives, same phone+name.
3. Resolver adopts identity `I` (CRM-anchor preference).
4. LB ingest checks `I.sf_lead_id` — NULL. Checks `I.sf_customer_id` — set.
5. **New behavior (this design):** create a fresh lead with `parent_lead_id = NULL` (no prior lead exists), source = "Thumbtack Tampa", and immediately set `converted_customer_id = C` + `converted_at = now()` via the projection layer (because identity has both sides now).
6. `setIdentityLead(I, newLead.id)` updates the identity. Projection fires → already-converted lead is fine; idempotent path triggers because `converted_customer_id == sf_customer_id`. Audit row written.
7. Result: lead is in the system as an *acquisition-only* record. Source attribution preserved. Reactivation visible in funnel analytics.

#### Case B — Existing lead submits new Yelp request months later

1. LB lead L1 = Jan Thumbtack. Identity `I → sf_lead_id = L1`.
2. March Yelp webhook arrives.
3. Resolver adopts `I` (phone + strong name).
4. **New behavior:** instead of `enrichLeadFromLB(L1, …)`, create L2 with `parent_lead_id = L1`, source = "Yelp Tampa", `lead_cost` from LB payload.
5. Identity row unchanged (`sf_lead_id` still points to L1).
6. Result: per-campaign attribution preserved.

#### Case C — Same phone but different household member

Unchanged from existing behavior. Resolver returns ambiguous → no setter call → no lead modification → ambiguity queued. Operator resolves.

#### Case D — Existing customer contacts through OpenPhone only

Unchanged. No lead creation (OP suppresses shadow leads when identity has sf_customer_id).

---

## 4. Reporting aggregation

After Phase 0.5 lands, the funnel queries (currently in `server.js:21563+`) need a small change:

```sql
-- Per-acquisition view (one row per lead)
SELECT id, source, lead_cost, converted_customer_id IS NOT NULL AS converted
  FROM leads WHERE user_id = $tenant;

-- Per-person view (one row per real person)
SELECT
  COALESCE(parent_lead_id, id) AS canonical_lead_id,
  COUNT(*)                     AS acquisition_count,
  SUM(lead_cost)               AS total_acquisition_cost,
  BOOL_OR(converted_customer_id IS NOT NULL) AS converted
FROM leads WHERE user_id = $tenant
GROUP BY canonical_lead_id;
```

Existing conversion rate calculations remain accurate because `converted_customer_id` lives on the canonical lead only.

---

## 5. Migration plan (proposed; not yet executed)

```sql
-- migrations/049_lead_parent_lead_id.sql

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS parent_lead_id INTEGER
    REFERENCES leads(id) ON DELETE SET NULL;

-- Same-tenant guard (defensive; FK alone can't enforce this).
-- CHECK constraint impossible because subquery; rely on app code + test.

CREATE INDEX IF NOT EXISTS idx_leads_parent
  ON leads(parent_lead_id) WHERE parent_lead_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_leads_user_parent
  ON leads(user_id, COALESCE(parent_lead_id, id));
```

**Migration safety note:** Historical leads remain valid with `parent_lead_id = NULL`. No retroactive regrouping. If an operator wants to retroactively connect two existing leads (e.g., they realize an old Yelp lead was actually the same person as a Thumbtack lead), that is a **manual operator action** — there is no automatic backfill that walks history and decides retroactive parent links. This avoids:

- Misattribution from over-eager phone-similarity matching on historic data
- Funnel analytics shifting unexpectedly when this migration lands
- Trust loss when operators see their dashboards "rewrite themselves"

---

## 6. Code changes (Phase 0.5)

Files affected:

| File | Change |
|---|---|
| `migrations/049_lead_parent_lead_id.sql` + `_down.sql` | Add `parent_lead_id` column + indices. |
| `leadbridge-service.js` `resolveOrCreateLead` | Replace `enrichLeadFromLB(identity.sf_lead_id, ...)` branch with create-child-lead branch when `identity.sf_lead_id` is set. Identity row NOT touched. New child lead gets `parent_lead_id = identity.sf_lead_id`. |
| `leadbridge-service.js` `createLeadFromLB` | New optional param `parentLeadId`. Inserted on lead row. |
| `lib/lb-ingestion.js` | New `assertCreateChildLeadInvariant` — child must share workspace with parent. |
| `server.js` (funnel queries) | Add per-person grouping option via `COALESCE(parent_lead_id, id)`. Existing per-lead reports unchanged. |
| Tests | Cases B & C from §3 above; cross-tenant parent guard; idempotency under replay. |
| Frontend leads UI | Show children as nested rows under canonical lead OR show acquisition count + total cost on canonical's detail panel. |

---

## 6a. Identity stability invariant (correction #2, 2026-05-21)

Child-lead creation **MUST NOT** create new identity rows. Tested in `tests/lb-child-lead.test.js`:

```
test('IDENTITY STABILITY: child creation never touches identity row')
```

The child-create path does not touch `communication_participant_identities`. Identity's `sf_lead_id` continues to point at the canonical lead even after N children are added. This means:

- The full communication history (conversations, calls, OP participant link) stays attached to the same identity row.
- The resolver returns the same identity for every future LB / ZB / OP event from this person.
- Operator merge/combine actions in Identity Conflicts UI operate on one identity row, not N.

## 6b. Confidence-downgrade protection (correction #9)

The child-create path emits a structured `[LeadCardinalityConflict]` log and **refuses** rather than auto-collapsing in these cases:

| Condition | Reason |
|---|---|
| `parent_lead.parent_lead_id IS NOT NULL` (would be a grandchild) | Identity-graph corruption signal — refuse, surface to operator |
| `parent_lead.user_id != intended_user_id` (cross-tenant) | Defense-in-depth (query also filters) |
| Parent lookup returns null | Parent missing — possibly deleted or stale identity pointer |

The principle: **wrong non-merge is safer than wrong merge.** If something looks structurally off, freeze the new child and emit the conflict. The legacy enrich path is invoked as fallback so the LB webhook still acks 200 to LB; the lead-cardinality work is silently deferred for that one event.

## 7. Open questions (operator review)

1. **Pipeline stage for children:** confirmed no — children stay out of pipeline (no `stage_id` write). UI should grey them out / hide them from pipeline board.
2. **OpenPhone-created leads with this design:** OP currently creates a lead when identity has none. If identity has `sf_lead_id` already, OP suppresses. Should OP also create children for re-engaged customers? **Recommendation: no.** OP is communication, not acquisition. LB is the only acquisition source.
3. **ZB-driven customer creation with no prior lead:** Case A above. Confirmed approach: create acquisition-only lead row, immediately convert via projection.
4. **Backwards compatibility:** existing reports / Vercel frontend filters / exports all use the leads table directly. Confirm with frontend team that adding `parent_lead_id` doesn't break any consumer.

---

## 8. Gating constraint

**No tenant resolver flag flip (Phase 3) until this Phase 0.5 design is reviewed, agreed, and migrated.** Without `parent_lead_id`, flipping `IDENTITY_RESOLVER_LEADBRIDGE_TENANTS=<id>` will silently destroy acquisition attribution on the first repeat-lead submission from that tenant.

---

## 9. Pointers

- Investigation B findings: see corrected plan v3 (chat log 2026-05-21) and `project_identity_unification_v4.md` memory entry.
- Phase B design that introduced the constraint: commit `b747fa3` `feat(identity): Phase B — rewire LeadBridge through identity-resolver`.
- Per-acquisition vs per-person funnel design: §4 above.
