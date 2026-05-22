# Materialization Audit — CRM Row Creation Before Identity Resolution

**Status:** Audit (Deliverable C of the 2026-05-22 refactor direction).
**Owner:** Identity v5 working group.
**Date:** 2026-05-22.
**Companion:** [identity-graph-refactor-plan.md](./identity-graph-refactor-plan.md), [identity-reconciliation-engine-design.md](./identity-reconciliation-engine-design.md).

---

## 1. Purpose

Enumerate every code path that creates a `leads`, `customers`, `communication_conversations`, or `communication_participant_*` row, and classify whether it does so **before** or **after** identity resolution. The architectural direction is identity-first: identity is resolved (or determined ambiguous) before any CRM materialization for known-identity events. This audit names the call sites that violate that direction today and assigns a target ordering and risk class to each.

Risk classes:

- **HIGH** — CRM materialization happens before resolver call; mis-orders cause acquisition-loss or duplicate-row symptoms. Must be re-ordered before Stage 5 rollout.
- **MEDIUM** — Materialization happens before resolver in *some* branches but the affected entity (e.g., conversation) is identity-agnostic at insert time. Should be reordered for consistency; not strictly required.
- **LOW** — Materialization is correctly identity-first today; listed for completeness.
- **TRANSITIONAL** — Path exists to handle historic / pre-resolver data. Not part of steady-state; archival target.

The audit is exhaustive within the SF backend repo: every `from('leads').insert(...)`, `from('customers').insert(...)`, `from('communication_conversations').insert(...)`, and `from('communication_participant_identities').insert(...)` call site is enumerated.

---

## 2. Methodology

`grep -n "from('leads').insert\|from('customers').insert\|from('communication_conversations').insert\|from('communication_participant_identities').insert"` across the backend produces the table below. Test files and migrations excluded. Each call site is mapped to its enclosing function + the inbound event flow that reaches it.

---

## 3. LeadBridge flows

### 3.1 LB webhook (`POST /api/integrations/leadbridge/webhooks`)

**File:** [leadbridge-service.js](../../leadbridge-service.js).

**Current order:**

```
1. Webhook event received
2. HMAC verification → verifiedUserId
3. Tenant attribution (lookup by event.account_id)
4. upsertParticipantIdentity(userId, { phone, email, displayName, lbContactId, channel })
     ├─ FLAG ON: resolveIdentity(supabase, { source: 'leadbridge', ... })
     └─ FLAG OFF: legacy phone+lbContactId upsert directly into
                  communication_participant_identities  ← BYPASSES RESOLVER
5. Resolve provider_account_id + accountDisplayName
6. resolveOrCreateLead(userId, identity, { channel, customerName, ... })
     ├─ identity.sf_lead_id set:
     │    ├─ CHILD_LEADS ON  → createChildLeadFromLB → INSERT leads (parent_lead_id=canonical)
     │    └─ CHILD_LEADS OFF → enrichLeadFromLB (no insert; fill-null UPDATE)
     ├─ identity.sf_customer_id set:
     │    ├─ CHILD_LEADS ON  → createLeadFromLB (lead_origin_type='reactivation')
     │    │                    → setIdentityLead → projectIdentityToCRM
     │    └─ CHILD_LEADS OFF → return identity_already_customer (no insert)
     ├─ Phone match → customer:  setIdentityCustomer (no insert)
     ├─ Phone match → lead:      setIdentityLead + enrichLeadFromLB (no insert)
     └─ No CRM match:            createLeadFromLB → INSERT leads
                                  → setIdentityLead → projectIdentityToCRM
7. upsertConversation → INSERT communication_conversations (identity FK populated)
8. Message INSERT communication_messages (if message present)
```

**Findings:**

| Step | Risk | Notes |
|---|---|---|
| 4 (FLAG OFF) | **HIGH** | Legacy upsert writes into `communication_participant_identities` directly. This is the drift the resolver was built to fix. Mitigated when `IDENTITY_RESOLVER_LEADBRIDGE_TENANTS` is set for the tenant; remains the default for all unenrolled tenants. |
| 4 (FLAG ON) | LOW | Resolver-first. Correct order. |
| 6 (`createLeadFromLB`) | LOW | Identity is in hand before INSERT. Setter cascades projection. |
| 6 (`createChildLeadFromLB`) | LOW | `assertCreateChildLeadInvariant` precedes INSERT. |
| 7 (conversation) | LOW | Identity FK (`participant_identity_id`) populated from step 4. |

**Target order:** Same as current for FLAG ON. **Remove the FLAG OFF branch entirely** once every tenant has `IDENTITY_RESOLVER_LEADBRIDGE_TENANTS` set. Track tenants remaining on the legacy path in the runbook.

### 3.2 LB sync loop (`POST /api/integrations/leadbridge/sync`)

**File:** [leadbridge-service.js](../../leadbridge-service.js) `runLbSync`.

**Current order:** Same as 3.1 per lead. The loop calls `upsertParticipantIdentity` → `resolveOrCreateLead` → `upsertConversation` → message INSERTs.

**Findings:** Same risk classes as 3.1.

**Target order:** Same.

---

## 4. Zenbooker flows

### 4.1 ZB customer sync (`upsertCustomerFromZB`)

**File:** [zenbooker-sync.js](../../zenbooker-sync.js).

**Current order:**

```
1. mapCustomer(zb, userId)  → mapped customer fields
2. (FLAG ON: IDENTITY_RESOLVER_ZENBOOKER)
     resolveIdentity(supabase, { source: 'zenbooker', externalId: zb.id, ... })
     ├─ status='ambiguous' → return mode='skipped_ambiguous_identity'  (no INSERT)
     ├─ status='matched'   → identity captured for step 7
     └─ status='error'     → continue with identity=null
3. Match by zenbooker_id:
     existing → fill-null UPDATE customers; linkIdentityToCustomer (no INSERT)
4. Match by phone (last10, zenbooker_id IS NULL):
     byPhone → fill-null UPDATE + zenbooker_id stamp; linkIdentityToCustomer
                                                                ↑
                            Adoption performed independently of resolver result
5. Match by email (zenbooker_id IS NULL):
     byEmail → fill-null UPDATE + zenbooker_id stamp; linkIdentityToCustomer
                                                                ↑
                            Same — adoption logic outside the engine
6. INSERT customers (mapped); linkIdentityToCustomer
7. linkIdentityToCustomer(customerId) → setIdentityCustomer → projectIdentityToCRM
```

**Findings:**

| Step | Risk | Notes |
|---|---|---|
| 2 (FLAG OFF) | **HIGH** | Steps 3–6 run without any identity-graph involvement. The `customer` row is created or adopted purely on phone/email/zb_id matching, identity is never touched. This is the default state for tenants not enrolled in `IDENTITY_RESOLVER_ZENBOOKER_TENANTS`. |
| 4 (phone adoption, FLAG ON) | **MEDIUM** | The phone-only adoption runs *outside* the resolver's careful name-classification gates. Even when the resolver determined ambiguity or returned a different identity, this branch will adopt by phone. Tenant-side this is currently fine because step 2 has already returned-early on ambiguous — but the adoption logic itself does not know that. |
| 5 (email adoption, FLAG ON) | **MEDIUM** | Same — email-only adoption is not subject to the resolver's name confidence rules. |
| 6 (INSERT) | LOW | Identity is in hand from step 2; cascade is correct. |

**Target order:**

```
1. resolveIdentity(...)
2. If ambiguous → skip entirely (current behavior)
3. Engine decision:
     - existing identity.sf_customer_id → enrich (UPDATE)
     - identity has phone/email anchor on an existing CRM customer → attach_existing_customer
                                                                      (replaces ad-hoc adoption)
     - else canonical_customer_create → INSERT
4. setIdentityCustomer cascades projection
```

The adoption branches (current §4 phone, §5 email) become `attach_existing_customer` decisions emitted by the engine. The engine applies name confidence to phone/email adoption — closing the gap that exists today.

### 4.2 ZB job sync

**File:** [zenbooker-sync.js](../../zenbooker-sync.js) `mapJob` + sync loop.

**Current order:** Jobs reference an already-resolved `customer_id` via `customerMap[zb.customer.id]`. Customers are upserted first in the loop. No identity work inside the job path.

**Findings:** LOW. Job materialization is identity-agnostic; customer resolution is upstream.

### 4.3 ZB webhook (`customer.created` / `customer.edited`)

**Current order:** Same as 4.1.

**Findings:** Same.

---

## 5. OpenPhone / Sigcore flows

### 5.1 OP webhook — message / call received

**File:** [server.js](../../server.js) (Sigcore webhook handler around line 40540+).

**Current order:**

```
1. Webhook event received from Sigcore
2. Tenant attribution via endpoint_routes (deterministic 5-step pipeline)
3. HMAC cross-check vs route-derived userId
4. Conversation lookup: by sigcore_conversation_id, then by endpoint/participant pair
5. (Conversation not found path):
     a. Contact name resolution (payload → customers/leads phones → auto-detect)
     b. extractSigcoreParticipant(payload)  → sig (participant id/key/phone/displayName)
     c. resolveParticipantMapping(userId, { ...sig, ... })
          ├─ Creates/updates communication_participant_mappings
          ├─ FLAG ON: linkMappingToIdentity → resolveIdentity → sets mapping.identity_id
          └─ FLAG OFF: classifier-driven mapping.crm_customer_id / crm_lead_id
     d. handleOpenPhoneConditionalLeadCreation (fire-and-forget):
          ├─ Fetch identity by mapping.identity_id
          ├─ maybeCreateLeadFromOpenPhone:
          │    ├─ shouldOpenPhoneCreateLead gating
          │    ├─ findCrmMatchByPhone:
          │    │    customer match → setIdentityCustomer (no INSERT)
          │    │    lead match     → setIdentityLead (no INSERT)
          │    └─ no match         → INSERT leads → setIdentityLead → projectIdentityToCRM
     e. INSERT communication_conversations  ← BEFORE 5d completes async
6. (Conversation found path): UPDATE communication_conversations (preserve identity FK)
7. Message INSERT communication_messages
```

**Findings:**

| Step | Risk | Notes |
|---|---|---|
| 5c (FLAG OFF) | **HIGH** | Legacy classifier writes `mapping.crm_customer_id` / `crm_lead_id` directly with no identity-graph involvement. Identity is only populated when `IDENTITY_RESOLVER_OPENPHONE_TENANTS` includes this user. |
| 5d vs 5e ordering | **MEDIUM** | `handleOpenPhoneConditionalLeadCreation` is called with `.catch(()=>{})` *before* the conversation is inserted, but it's not awaited. The conversation INSERT at 5e includes `participant_identity_id` only if the mapping already had `identity_id` populated (synchronous portion of 5c). Lead creation in 5d completes asynchronously — meaning the conversation may exist for milliseconds with no identity link before 5d finishes. Not a correctness bug (the conversation's `participant_identity_id` *is* set via the synchronous mapping result), but it means CRM rows can exist before lead-creation completes. |
| 5d (`maybeCreateLeadFromOpenPhone`) | LOW (FLAG ON) | The CRM-anchor phone lookup (`findCrmMatchByPhone`) precedes the INSERT; if a CRM row exists for the phone, we attach rather than insert. Correct order. |
| 7 (message INSERT) | LOW | Message attaches to conversation; identity FK already on conversation. |

**Target order:**

```
1–3. Unchanged
4.  Resolve mapping + identity SYNCHRONOUSLY (await):
       a. extractSigcoreParticipant
       b. resolveParticipantMapping (writes mapping + sets identity_id via resolver)
       c. Engine.reconcile() with source='openphone' + event metadata
       d. If plan.decision involves CRM materialization, execute *before* conversation insert
          so the conversation INSERT can carry the freshly created CRM linkage in the
          same transactional moment.
5.  INSERT communication_conversations with participant_identity_id populated.
6.  INSERT messages.
```

The fire-and-forget pattern in step 5d today is a performance optimization that creates a transient inconsistency window. Moving it to synchronous-await costs one extra round-trip per webhook but eliminates the window. Acceptable for our webhook latency budget (OpenPhone retries on >5s; we're sub-1s today).

### 5.2 OP sync (`POST /api/communications/sync`)

**File:** [server.js](../../server.js) `runOpSync` (large function).

**Current order:** Per conversation fetched from Sigcore: identity-resolve via `resolveParticipantMapping` → conversation upsert → messages upsert. The conditional-lead-creation runs after via `handleOpenPhoneConditionalLeadCreation`.

**Findings:** Same risk as 5.1.

**Target order:** Same as 5.1.

### 5.3 Sigcore participant-resolution event (no conversation)

**Current code path:** None. Sigcore does not surface a participant-resolution event independent of a conversation event today.

**Risk:** **N/A but a gap.** See [sigcore-integration-audit.md](./sigcore-integration-audit.md) — when Sigcore enriches a participant (e.g., a contact-name lookup completes), the only way SF learns about it is via a subsequent conversation event. There is no first-class Sigcore-direct identity input today.

---

## 6. Manual / operator flows

### 6.1 `POST /api/leads`

**File:** [server.js](../../server.js) line 9714.

**Current order:**

```
1. Validate input
2. Resolve pipeline + stage
3. INSERT leads (no identity work)
4. Return
```

**Findings:** **HIGH** in steady-state. Operator-created leads materialize a row without ever consulting the identity graph. If the operator types in a phone that already matches an existing identity (which already matches an existing customer), we get a CRM row that's disconnected from the graph until a later sync or operator-triggered repair pulls it in.

**Target order:**

```
1. Validate input
2. Engine.reconcile({ source: 'manual_sf', event: { type: 'operator_action' }, ... })
     ├─ ambiguous → return 422 with candidates (operator picks)
     ├─ attach_existing_customer / attach_existing_lead → return 409 with target
     │   (operator confirms attach or insists on new)
     ├─ canonical_lead_create → proceed to INSERT
     └─ frozen → 503
3. INSERT leads + setIdentityLead
```

Manual entry being able to bypass the engine *deliberately* (operator confirms) is fine. Manual entry being able to bypass the engine *silently* (today) is the drift to close.

### 6.2 `POST /api/customers`

**File:** [server.js](../../server.js) line 8791.

**Findings:** Same as 6.1.

**Target order:** Same shape, `source: 'manual_sf'`, `event.type: 'operator_action'`, `canonical_customer_create` decision.

### 6.3 Operator merge / link (`/api/identity-conflicts/*`, `applyLeadCustomerLink`)

**File:** [lib/identity-linker.js](../../lib/identity-linker.js) `applyLeadCustomerLink`.

**Findings:** LOW. This is the operator-override path; bypassing the engine is *correct* here (per Engine Design §16 Q4). `applyLeadCustomerLink` re-asserts tenant scope and the I2 invariant directly.

---

## 7. Backfill / repair flows (TRANSITIONAL)

### 7.1 `lib/identity-backfill.js`

Reads historic identities/leads/customers/OP mappings/ZB customers and re-runs the resolver in **strict mode** to converge them. Strict mode rejects phone-only and weak-name matches.

**Findings:** TRANSITIONAL. Materializes nothing new — only reconciles existing rows.

**Target:** Tag `@transitional`. Remove after Phase 5 + 30 day steady-state.

### 7.2 `/api/identity-conflicts/repair-lead-links`

Operator-triggered. Inspects unconverted leads + customers and proposes/applies HIGH-confidence links subject to `lib/retroactive-repair-guards.js` (active-window check).

**Findings:** TRANSITIONAL.

**Target:** Same.

### 7.3 `scripts/phase1-dryrun-repair.js`

Dry-run version of 7.2.

**Findings:** TRANSITIONAL.

**Target:** Same.

---

## 8. Communication writes (identity-agnostic)

### 8.1 `communication_conversations` INSERTs

Sites:

- [leadbridge-service.js](../../leadbridge-service.js) `upsertConversation`.
- [server.js](../../server.js) OP webhook + sync paths.

**Findings:** LOW. Conversations carry `participant_identity_id` if available at insert time; they remain useful for downstream lookup even with the FK null. The Sigcore webhook explicitly supports `participant_pending: true` to mark conversations awaiting identity resolution. The remaining concern is the §5.1 ordering point — the conversation should not be inserted *before* a synchronous identity attempt, even though it works when the result arrives async.

### 8.2 `communication_messages` / `communication_calls` INSERTs

Always downstream of conversation. Identity is on conversation.

**Findings:** LOW.

### 8.2a Note on legacy reverse pointers

The columns `communication_participant_mappings.crm_customer_id` and `communication_participant_mappings.crm_lead_id` are *pre-resolver* reverse pointers. Their continued existence is grandfathered, but per the No Duplicate Graph Truth invariant ([identity-graph-refactor-plan.md](./identity-graph-refactor-plan.md) §3.2a) **no new code path may read them when the mapping has `identity_id` populated**, and no new reverse pointers may be introduced. Sunset for these columns happens after every tenant is on `IDENTITY_RESOLVER_OPENPHONE`.

### 8.3 `communication_participant_mappings` INSERTs

**File:** [server.js](../../server.js) `resolveParticipantMapping`.

**Findings:** MEDIUM when `IDENTITY_RESOLVER_OPENPHONE` is OFF — the mapping uses the legacy classifier (`classifyMapping`) which directly writes `crm_customer_id` / `crm_lead_id` based on phone lookup, no identity-graph involvement. **LOW** when flag is on; `linkMappingToIdentity` then runs the resolver and writes `identity_id`.

**Target:** Remove the legacy classifier branch once all tenants are on `IDENTITY_RESOLVER_OPENPHONE`.

### 8.4 `communication_participant_identities` INSERTs

**Authorized writers:**

- `lib/identity-resolver.js` `createFloatingIdentity` (Step 5 of the resolver pipeline).
- [leadbridge-service.js](../../leadbridge-service.js) `upsertParticipantIdentity` legacy branch (FLAG OFF). **HIGH risk** — this is the only unauthorized writer in production code outside one-off migrations.

**Target:** Remove the legacy branch (§3.1 step 4 FLAG OFF) once all tenants are on `IDENTITY_RESOLVER_LEADBRIDGE`.

---

## 9. Summary table

| Flow | Site | Pre-resolver INSERTs today | Risk | Target order shipped via |
|---|---|---|---|---|
| LB webhook | `leadbridge-service.js:1690+` | conversation, message (identity-FK populated) | LOW (FLAG ON) / HIGH (FLAG OFF) | Stage 2 (engine adapter) + drop legacy branch |
| LB sync per-lead | `leadbridge-service.js:1820+` | same | same | Stage 2 |
| ZB customer upsert | `zenbooker-sync.js:178` | customer adoption (phone/email) bypasses resolver gates | MEDIUM | Stage 3 (adoption → engine `attach_existing_customer`) |
| ZB job sync | `zenbooker-sync.js:mapJob+` | jobs (customer_id already resolved) | LOW | none needed |
| OP webhook | `server.js:40540+` | conversation INSERTed before async lead-create completes; mapping legacy branch writes CRM ids | MEDIUM / HIGH (FLAG OFF) | Stage 4 (engine + sync await) |
| OP sync | `server.js:runOpSync` | same | same | Stage 4 |
| Manual `POST /api/leads` | `server.js:9714` | lead row, no identity work at all | HIGH | Stage 4.5 (manual adapter) |
| Manual `POST /api/customers` | `server.js:8791` | customer row, no identity work | HIGH | Stage 4.5 |
| Operator merge | `lib/identity-linker.js applyLeadCustomerLink` | n/a — works on existing rows | LOW (by design) | none |
| Backfill | `lib/identity-backfill.js` | n/a — reconciles only | TRANSITIONAL | archive after Phase 5 |
| Repair-lead-links | `/api/identity-conflicts/repair-lead-links` | n/a | TRANSITIONAL | archive after Phase 5 |

---

## 10. Action items

Prioritized by risk class:

### HIGH

1. **Sunset `upsertParticipantIdentity` legacy branch** (leadbridge-service.js step 3.1 §4 FLAG OFF). Tenants not yet enrolled in `IDENTITY_RESOLVER_LEADBRIDGE_TENANTS` are still writing identities directly. Track tenant-by-tenant rollout in the runbook; remove the branch once every tenant is on.
2. **Sunset OP legacy classifier branch** (server.js `resolveParticipantMapping` when `IDENTITY_RESOLVER_OPENPHONE` is OFF). Same shape; track rollout per tenant.
3. **Route `POST /api/leads` and `POST /api/customers` through the engine.** Operator manual entry must consult the identity graph (with operator override available on ambiguous/attach decisions).

### MEDIUM

4. **Move ZB customer adoption (phone, email) into the engine** as the `attach_existing_customer` decision. Apply the resolver's name-confidence gates to adoption too.
5. **Synchronously await OP conditional lead creation** in the webhook + sync paths so conversation INSERT happens *after* the identity ↔ lead linkage is decided. Costs one round-trip; closes a small inconsistency window.

### LOW / housekeeping

6. **Tag transitional tools** (`identity-backfill.js`, `repair-lead-links`, `phase1-dryrun-repair.js`, `retroactive-repair-guards.js`) with `@transitional` headers and archival target Phase 5+30d.
7. **Document the legacy-classifier sunset criteria** in the runbook (per-tenant flag flips needed to make sunset safe).

---

## 11. Test coverage

Each HIGH and MEDIUM action item ships with adapter contract tests that record current behavior, exercise the new identity-first ordering, and confirm:

- No new floating identities created when one already exists for the phone.
- No new leads created when an identity already has `sf_lead_id` and child-leads flag is OFF (legacy parity).
- No new customers created when phone-anchored existing customer is present.
- Ambiguous resolver result → no CRM row materialized.

These tests gate the Stage 2/3/4 PRs in [identity-graph-refactor-plan.md](./identity-graph-refactor-plan.md).

---

## 12. Pointers

- Companion docs: [identity-graph-refactor-plan.md](./identity-graph-refactor-plan.md), [identity-reconciliation-engine-design.md](./identity-reconciliation-engine-design.md), [sigcore-integration-audit.md](./sigcore-integration-audit.md).
- Code reviewed: [leadbridge-service.js](../../leadbridge-service.js), [zenbooker-sync.js](../../zenbooker-sync.js), [server.js](../../server.js), [lib/identity-resolver.js](../../lib/identity-resolver.js), [lib/identity-linker.js](../../lib/identity-linker.js), [lib/openphone-ingestion.js](../../lib/openphone-ingestion.js), [lib/openphone-crm-match.js](../../lib/openphone-crm-match.js), [lib/lb-ingestion.js](../../lib/lb-ingestion.js), [lib/identity-backfill.js](../../lib/identity-backfill.js).
