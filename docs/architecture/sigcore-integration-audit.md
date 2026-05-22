# Sigcore Integration Audit — Identity-Graph Gaps

**Status:** Audit (Deliverable D of the 2026-05-22 refactor direction).
**Owner:** Identity v5 working group.
**Date:** 2026-05-22.
**Companion:** [identity-graph-refactor-plan.md](./identity-graph-refactor-plan.md), [identity-reconciliation-engine-design.md](./identity-reconciliation-engine-design.md), [materialization-audit.md](./materialization-audit.md).

---

## 1. Purpose

Document where Sigcore touches the SF identity graph today, what is correctly wired, and where Sigcore's identity signals are *not* feeding the graph despite the data being available. The architectural direction is that Sigcore participant identity is a first-class projection of the canonical identity — peer to LeadBridge acquisition records and Zenbooker customer records — not a downstream side-effect of OpenPhone webhook handling.

This audit operates from the SF side. Sigcore-side changes are out of scope here; this document names them where they would unblock SF work, but treats Sigcore's internal schema as opaque.

---

## 2. Sigcore as a platform — recap

Per [Sigcore.md](../../../Obsidian/Projects/Sigcore.md) and the platform model memory:

- **Tenant** = top-level Sigcore customer (one per app: SF tenant, LB tenant, Callio tenant).
- **Product workspace** = workspace reference in the cross-app business identity registry. Used for grouping/discovery only — not runtime routing.
- **Business identity** = cross-tenant grouping (e.g., "Spotless Homes Florida LLC" with SF + LB + Callio workspaces). Admin/discovery, not routing.
- **Provider adapter** layer = `/integrations/{provider}/*` endpoints. OpenPhone, Twilio, future providers.
- **Runtime routing**: inbound event → Sigcore → `tenant_phone_numbers` resolves tenant → fan-out to tenant-scoped webhook subscribers → app resolves account/location internally.

From SF's perspective Sigcore is *both*:

1. A transport: messages, calls, contacts flow through Sigcore.
2. An identity provider: Sigcore has its own participant identity (`participantId`, `participantKey`, `providerContactId`, contact-name lookups via OpenPhone's contact API).

The audit focuses on (2) — identity signals.

---

## 3. Sigcore signals SF receives today

The Sigcore-to-SF identity surface as observed in [server.js](../../server.js):

| Signal | Source | Sigcore endpoint / field | SF column |
|---|---|---|---|
| Participant ID | Sigcore participant table | `payload.providerParticipantId` / `payload.participant.id` / nested provider blocks | `communication_participant_mappings.sigcore_participant_id`, `communication_participant_identities.sigcore_participant_id` |
| Participant key | Sigcore (transitional pre-id) | `payload.participantKey` | `communication_participant_mappings.sigcore_participant_key`, `communication_participant_identities.sigcore_participant_key` |
| Provider contact ID | OpenPhone via Sigcore | `payload.providerContactId` | `communication_participant_identities.openphone_contact_id` |
| Contact name | OpenPhone contact API via Sigcore | `payload.contactName`, `payload.conversationName`, bulk `/contact-names` endpoint | `communication_conversations.participant_name`; consumed by name resolution priority list |
| Participant phone (E.164) | Sigcore-normalized | `payload.participantPhoneE164` | Used to populate `communication_participant_identities.normalized_phone` |
| Company tag | OpenPhone provider field via Sigcore | `payload.provider.company` / `payload.company` | `communication_conversations.company`; drives OP source derivation |
| Conversation ID | Sigcore | `payload.conversationId` | `communication_conversations.sigcore_conversation_id` |
| Message / call payloads | Sigcore transport | per webhook | `communication_messages`, `communication_calls` |

### Sigcore endpoints SF calls

From [server.js](../../server.js) `sigcoreRequest(...)` usage:

- `POST /api/integrations/openphone/contacts/sync` — bulk contact import (kicked off during full sync).
- `GET /api/integrations/openphone/contacts/sync/status` — polled until completion.
- `POST /integrations/openphone/contact-names` — bulk phone → name lookup for unnamed conversations.
- `GET /integrations/openphone/conversations[/all]` — conversation list sync.
- `GET /conversations/:id/messages` and `/conversations/:id/calls` — per-conversation transport pull.
- Tenant provisioning, webhook subscription, asset linking (covered in `Sigcore.md`).

---

## 4. What's correctly wired

These paths feed Sigcore identity into the graph at the right times:

### 4.1 `linkMappingToIdentity` (server.js:8382)

When `IDENTITY_RESOLVER_OPENPHONE` is on, the OP webhook + sync paths call `resolveParticipantMapping` → `linkMappingToIdentity`. The resolver receives:

```js
{
  source: 'openphone',
  externalId: sigParticipant.providerContactId,
  sigcoreParticipantId: sigParticipant.participantId,
  sigcoreParticipantKey: sigParticipant.participantKey,
  phone: sigParticipant.participantPhoneE164,
  displayName: sigParticipant.displayName,
}
```

The resolver's external-ID lookup (`SOURCE_TO_EXTERNAL_COLUMNS.openphone = ['openphone_contact_id', 'sigcore_participant_id', 'sigcore_participant_key']`) cleanly matches against any of those three. If the identity already exists from a prior source (LB / ZB), the Sigcore identifiers attach without creating a new identity row — exactly the cross-source convergence we want.

This is the canonical "OpenPhone participant becomes a peer projection of the identity graph" path. It works.

### 4.2 Conversation `participant_identity_id` FK

When the mapping has `identity_id` populated (post-resolver), the conversation INSERT carries `participant_identity_id` (server.js:40671). Subsequent UI lookups can walk conversation → identity → CRM in O(1).

### 4.3 Identity Conflicts / ambiguity surface

When Sigcore participant signals collide (two `sigcore_participant_id`s point at conflicting CRM rows), the resolver logs to `communication_identity_ambiguities`. The operator's existing surface already covers this case.

### 4.4 Contact-name resolution priority list

The 5-step priority list (Sigcore `contactName`/`conversationName` → live endpoint contact lookup → SF CRM customers/leads → auto-detect from message content → background bulk lookup) is documented in the project memory and matches actual code behavior. Sigcore is correctly the *first* signal consulted.

---

## 5. Where Sigcore identity is NOT feeding the graph

Five gaps. Each is the same shape: Sigcore knows something about identity, and that knowledge is either dropped, applied non-uniformly, or only used for display rather than graph convergence.

### Gap 1 — Mapping legacy classifier writes CRM links without identity-graph involvement

**File:** [server.js](../../server.js) `resolveParticipantMapping` (8287) + `lookupCRMByPhone` (8254) + `classifyMapping` (mapping_status logic).

**Today (FLAG OFF):** `classifyMapping` produces `crm_customer_id` / `crm_lead_id` directly from `lookupCRMByPhone` (phone-only). Writes them on the mapping row with `mapping_status` ∈ {mapped, ambiguous, unmapped, ...}. No identity row updated. No resolver involvement. The mapping row IS the identity link for this tenant.

**Today (FLAG ON):** After mapping insert, `linkMappingToIdentity` runs the resolver and sets `mapping.identity_id` *in addition to* the legacy fields. The legacy classifier still writes `mapping_status` and `crm_*` columns.

**Problem:**
- Two parallel "identity" surfaces exist (`mapping.crm_customer_id` vs `identity.sf_customer_id`). They can disagree.
- For tenants not on `IDENTITY_RESOLVER_OPENPHONE`, the mapping IS the only identity link, and it has no name-confidence gates.
- New code reads `mapping.crm_*` for back-compat; it never gets to use the identity graph.

**Fix:** Stage 4 of the refactor plan. Sigcore mapping rows continue to exist (Sigcore's own ID space), but their `crm_*` columns are deprecated — `mapping.identity_id` becomes the only identity surface, and the identity row carries the projection. The legacy classifier branch is removed once all tenants are on the resolver flag.

### Gap 2 — Conversations created with no synchronous identity attempt

**File:** [server.js](../../server.js) OP webhook handler (40540+).

**Today:** When a message arrives and a conversation doesn't yet exist, the conversation is INSERTed with `participant_identity_id` populated *only if* `resolveParticipantMapping` synchronously found a mapping. The synchronous portion is just a DB lookup against the mappings table — if no mapping exists yet (first-touch for this participant), the conversation is created with `participant_pending=true` and identity is resolved later via `linkMappingToIdentity`.

**Problem:** First-touch OP conversations exist briefly with no identity link. The lead-creation path (`maybeCreateLeadFromOpenPhone`) is fire-and-forget so even when it runs synchronously after, the conversation INSERT happens first. Any UI lookup or downstream code that runs in the gap sees an orphan conversation.

**Fix:** Materialization audit §5.1 action item — synchronously await mapping + identity + projection before conversation INSERT.

### Gap 3 — Sigcore contact-name updates don't update identity display name

**File:** [server.js](../../server.js) bulk `/contact-names` lookup (40977), background contact sync (12081).

**Today:** Sigcore's contact-name endpoints populate `communication_conversations.participant_name` and the in-memory `contactNameMap`. They never write to `communication_participant_identities.display_name` even when the identity row exists for that phone.

**Problem:** The identity row is the source of truth for "who is this person" across CRM projections. When Sigcore (= OpenPhone contact directory) learns a name, that name should reach the identity row, subject to source-precedence rules (LB / SF / ZB names win; OP-derived names fill nulls only).

**Fix:** After bulk contact-name lookup, the engine emits a `source: 'sigcore'`, `event.type: 'participant_resolved'` reconcile call with `displayName` set. The engine returns an `enrich_only` decision (per [identity-reconciliation-engine-design.md](./identity-reconciliation-engine-design.md) §7.4) and the resolver's `buildEnrichPatch` fills `identity.display_name` if currently null. Source precedence is honored automatically because the patch is fill-null.

### Gap 4 — Sigcore participant convergence with manual SF entries

**Scenario:** Operator manually creates a customer (`POST /api/customers`) with phone `+1813...`. A few minutes later an OP SMS arrives from the same phone. The Sigcore participant arrives at `resolveParticipantMapping` → `linkMappingToIdentity`. The resolver finds no `openphone_contact_id` / `sigcore_participant_*` match → falls through to phone candidates. If an identity exists for that phone (from a prior LB/ZB sync), it adopts. If not, it creates a new floating identity.

**Problem:** The manually-created customer never had an identity row created (per Materialization Audit §6.2). So the resolver creates a floating identity for the Sigcore participant, and that identity has `sf_customer_id = NULL` even though the customer exists. The phone match in step 2 of the resolver doesn't help because there's no identity row yet for the manual customer.

The conversation now has an identity link, but the identity is disconnected from the manually-created customer until either:
- An operator manually links them via the Identity Conflicts UI.
- A retroactive repair pass (`repair-lead-links`) catches the pair via phone match.

**Fix:** Materialization Audit action item 3 — manual entry must go through the engine, which creates the identity row at the moment of operator entry. Once that's shipped, the Sigcore participant arriving later finds the identity by phone and adopts.

### Gap 5 — Sigcore-side participant identity drift

**Scenario:** Sigcore performs its own contact convergence inside OpenPhone (`openphone_contact_snapshot`, `contact_identity` tables in Sigcore). When Sigcore decides two of its participants are the same OpenPhone contact, it merges them on its side. SF has no awareness of this — SF's `sigcore_participant_id` for the loser of the merge remains pointing at the now-merged row.

**Problem:** Sigcore-side merges are invisible to SF. Two SF identity rows may be tagged with different `sigcore_participant_id`s that Sigcore has unified.

**Symptoms (observed in practice):**
- The same phone receives messages that show up as two different conversations in SF (because SF still has two distinct participant mappings).
- Operator merge actions in SF can't fix this because the two identity rows look correct from SF's perspective.

**Fix:** This requires a Sigcore-side change — Sigcore should emit a `participant_merged` webhook event when it merges two participants. SF subscribes, and the engine emits a reconcile with `source: 'sigcore'`, `event.type: 'participant_merged'`, `oldParticipantId: ...`, `newParticipantId: ...`. The engine's response is to update the loser identity's `sigcore_participant_id` to NULL (or transfer it) and let the next event re-converge through the resolver. Out of scope for the SF-side refactor; named here so it's on the inter-team backlog.

---

## 6. Sigcore-direct events SF should listen for

Beyond the OpenPhone-conversation webhook (already in place), the following Sigcore-side events would tighten cross-source convergence. Each is a Sigcore-side ask; SF would consume them via the engine's `source: 'sigcore'` input path.

| Sigcore event | SF reaction (via engine `reconcile`) | Priority |
|---|---|---|
| `participant.contact_resolved` (Sigcore filled in a contact name / extra metadata for a known participant) | `enrich_only` — fill identity display_name if null | M |
| `participant.merged` (Sigcore unified two participants) | Identity-side reconciliation (Gap 5) | M (Sigcore must emit first) |
| `participant.assigned_to_workspace` (cross-app workspace linkage updated) | No CRM impact; reference for cross-app identity work | L |
| `endpoint.tagged` (a phone number was tagged with a business identity) | Update `endpoint_routes` if changed; not an identity-graph signal | L |
| `contact.deleted` (rare — operator deletes an OpenPhone contact) | Flag identity for operator review (don't auto-act) | L |

None of these exist as named events today. The first two would meaningfully reduce ambiguity-queue size; the rest are nice-to-have.

---

## 7. SF-side responsibilities — short list

Independent of Sigcore-side changes, the SF backend can close gaps 1–4 with the work already scoped in [identity-graph-refactor-plan.md](./identity-graph-refactor-plan.md):

| Gap | Closed by | Stage |
|---|---|---|
| 1 — legacy classifier | Remove the FLAG OFF branch from `resolveParticipantMapping` after per-tenant `IDENTITY_RESOLVER_OPENPHONE` rollout | Stage 4 + cleanup |
| 2 — conversation-before-identity | Synchronously await identity + projection before conversation INSERT | Stage 4 |
| 3 — name updates not reaching identity | Route bulk contact-name lookup results through the engine as `source: 'sigcore'`, `enrich_only` decisions | Stage 5 |
| 4 — manual entry skips identity | Route `POST /api/leads` and `POST /api/customers` through the engine | Stage 4.5 (covered by Materialization Audit action 3) |
| 5 — Sigcore-side merges | Requires Sigcore `participant.merged` event; SF consumer is a Stage 6+ task | Stage 6+ |

---

## 8. What is *not* a gap

To prevent scope creep:

- **Sigcore owning message bodies / timestamps.** Constitution §1.3 — correct as-is.
- **Sigcore tenant routing.** The `endpoint_routes` 5-step pipeline is independent of identity reconciliation and works correctly.
- **Sigcore business-identity registry.** Cross-tenant grouping for admin/discovery; explicitly NOT used for runtime routing or identity convergence (per platform model).
- **WhatsApp / Twilio.** Other Sigcore-fronted providers. WhatsApp identity follows the same pattern but is currently a thin wrapper around the OP code path; once OP is on the engine, WhatsApp inherits.
- **Sigcore-side `contact_identity` table** as a direct SF read source. SF should consume Sigcore identity through normalized webhook events, not by reaching into Sigcore's tables. Tighter coupling would put us back where we were before the platform split.

---

## 9. Test coverage gaps

Areas where the current test surface doesn't catch the gaps named here:

| Gap | Existing tests | Missing |
|---|---|---|
| 1 | `participant-mapping.test.js`, `identity-source-classifier.test.js` | Test that asserts: when FLAG ON, mapping.crm_* is no longer used for any new code paths (lint or runtime). |
| 2 | `op-conversation-update.test.js`, `conversation-identity.test.js` | Test that webhook-time conversation INSERT carries `participant_identity_id` when identity is resolvable, OR sets `participant_pending=true`. No null-FK conversations for resolvable participants. |
| 3 | `identity-resolver.test.js` | Test that Sigcore-direct `participant_resolved` events fill `identity.display_name` only when null and only when source precedence allows. |
| 4 | `lb-child-lead.test.js`, `zenbooker-identity-resolver.test.js` | Test that `POST /api/customers` followed by an OP message from the same phone results in a single identity row linking both. |
| 5 | n/a | Out of scope until Sigcore emits the event. |

---

## 10. Operator-facing implication

The architectural correction in [identity-graph-refactor-plan.md](./identity-graph-refactor-plan.md) §3.8 — that operator review is *exception handling, not duplicate cleanup* — depends on Gaps 1, 2, and 4 being closed. As long as those gaps exist, "real" duplicates keep appearing (because manual entries, FLAG-OFF tenants, and pre-resolver conversations all skip the graph), and the operator's experience reverts to duplicate-merge.

The Sigcore-integration work is therefore not optional polish — it's how the operator-facing direction becomes true.

---

## 11. Pointers

- Companion docs: [identity-graph-refactor-plan.md](./identity-graph-refactor-plan.md), [identity-reconciliation-engine-design.md](./identity-reconciliation-engine-design.md), [materialization-audit.md](./materialization-audit.md), [cross-source-identity-reconciliation.md](./cross-source-identity-reconciliation.md), [synchronization-constitution.md](./synchronization-constitution.md).
- Code reviewed: [server.js](../../server.js) (`resolveParticipantMapping`, `linkMappingToIdentity`, `maybeCreateLeadFromOpenPhone`, `handleOpenPhoneConditionalLeadCreation`, OP webhook handler, OP sync loop), [lib/identity-resolver.js](../../lib/identity-resolver.js), [lib/source-registry.js](../../lib/source-registry.js).
- Platform model: [Sigcore.md](../../../Obsidian/Projects/Sigcore.md) and memory entry `project_cross_app_identity.md`.
