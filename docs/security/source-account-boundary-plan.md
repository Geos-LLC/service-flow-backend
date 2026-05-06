# Service Flow — Source-Account Boundary Plan

**Status:** Phase 0 audit complete. No code changes yet.
**Author:** Source-account boundary security phase
**Date:** 2026-05-05

---

## 1. Current Bug

Disconnecting a provider account in Service Flow does **not** hide the data that
account imported. Conversations, messages, calls, and identities created while
the source account was active continue to appear in normal CRM views after
disconnect — and (worse) when an LB connection is re-used to reach a different
underlying business, that business's data can show up under the wrong owner.

The class of bug: **import side stamps a source identifier (sometimes), read
side never enforces it.** There is no cross-cutting "source account is active"
gate on any read path.

This is not the same as the cross-tenant leak fix from April 6 (per
`Obsidian/.../project_data_leakage_fix.md`). That fix added phone-number
filtering for the SIGCORE_WORKSPACE_KEY path. This bug sits one layer deeper:
even within a single tenant, data from a *now-disconnected source account*
should not be served.

---

## 2. Tables Affected

Inventory by stamping status, as of this audit:

| Table | Has `provider_account_id`? | Stamped on write? | Filtered on read? |
|---|---|---|---|
| `communication_provider_accounts` | n/a (this **is** the source account) | LB only | n/a |
| `communication_conversations` | yes (col added in migration 006) | LB ✅, OP ❌, WhatsApp ❌, ZB n/a | **no** |
| `communication_messages` | **no** | n/a | reached via `conversation_id` only |
| `communication_calls` | **no** | n/a | reached via `conversation_id` only |
| `communication_participant_identities` | **no** | n/a | filtered by `hidden_at`, not source-account |
| `communication_webhook_events` | yes (FK, ON DELETE SET NULL) | partial | not user-visible |
| `lead_sms_messages` | does not exist | — | — |

Notes pulled from code:

- `communication_conversations.provider_account_id` exists
  ([`migrations/006_leadbridge_communication_layer.sql:280`](service-flow-backend/migrations/006_leadbridge_communication_layer.sql#L280)).
  It is `NULL` for every OpenPhone and WhatsApp conversation today, because
  no provider_accounts row is ever created for those providers (only LB and
  the de-scoped email service insert into `communication_provider_accounts`
  — see [`leadbridge-service.js:609`](service-flow-backend/leadbridge-service.js#L609)
  and [`email-service.js:235`](service-flow-backend/email-service.js#L235)).
- LB sync stamps `provider_account_id` on conversation create/update
  ([`leadbridge-service.js:506,528`](service-flow-backend/leadbridge-service.js#L506)).
- OpenPhone webhook + sync inserts at
  [`server.js:39715`](service-flow-backend/server.js#L39715),
  [`server.js:39956`](service-flow-backend/server.js#L39956),
  [`server.js:40458`](service-flow-backend/server.js#L40458) all omit
  `provider_account_id`.
- `lead_sms_messages` is in the user-supplied task spec but is **not** a
  table in this codebase. The only message store is `communication_messages`.

---

## 3. Read-Path Findings

The conversation list and detail endpoints filter by `user_id` only, never by
provider-account status:

- [`server.js:41044-41076`](service-flow-backend/server.js#L41044) —
  `GET /api/communications/conversations` filters by user, archive, channel,
  optional `accountId`, and search. There is no join/where on
  `communication_provider_accounts.status`. The query does join
  `provider_accounts` later, but only to enrich `accountName` for display.
- [`server.js:41304-41315`](service-flow-backend/server.js#L41304) —
  `GET /api/communications/conversations/:id` only checks
  `eq('user_id', userId)`. A conversation belonging to a now-disconnected
  account remains fully readable, including its messages and calls.
- [`server.js:40674`](service-flow-backend/server.js#L40674) — the
  provider-accounts listing endpoint (used by the source-filter dropdown)
  *does* filter `eq('status', 'active')` (good), but conversations from
  inactive accounts still load when no `accountId` is selected.
- Identity panels [`server.js:11226-11244`](service-flow-backend/server.js#L11226)
  filter on `hidden_at IS NULL` and `identity_priority_source != 'sync'` —
  good for the floating-identity rollup, irrelevant for source-account
  boundary.

---

## 4. Disconnect-Path Findings

Three providers, three different shapes — none of them hide existing data:

- **LeadBridge** [`leadbridge-service.js:919-953`](service-flow-backend/leadbridge-service.js#L919)
  sets `communication_provider_accounts.status = 'disconnected'` for all
  matching rows and clears the LB token + outbound/lead-status secrets in
  `communication_settings`. **Does not** touch any conversation/message
  rows. Because no read path filters on `pa.status`, those rows stay
  visible.
- **OpenPhone** [`server.js:39574-39603`](service-flow-backend/server.js#L39574)
  sets `connection_status='disconnected'`, `openphone_connected=false`,
  empties `cached_phone_numbers`, removes the webhook subscription, and
  calls `deactivateEndpointRoutes(workspace.id, 'openphone')`. **No
  provider_accounts row exists** for OpenPhone in the first place
  (see §2), so there is nothing whose `status` would change. Existing
  OpenPhone conversations remain visible after disconnect.
- **WhatsApp** [`whatsapp-service.js:234-256`](service-flow-backend/whatsapp-service.js#L234)
  sets `whatsapp_connected=false` and clears the phone number on
  `communication_settings`. Same shape as OpenPhone — no provider_accounts
  row, no row-level hide.

---

## 5. Write-Path Findings

| Path | File:Line | Stamps `provider_account_id`? |
|---|---|---|
| LB sync — conversation upsert | [`leadbridge-service.js:506,528`](service-flow-backend/leadbridge-service.js#L506) | ✅ |
| LB connect — provider_accounts insert | [`leadbridge-service.js:609`](service-flow-backend/leadbridge-service.js#L609) | n/a (this **creates** the account) |
| OpenPhone webhook — conversation insert | [`server.js:39956`](service-flow-backend/server.js#L39956) | ❌ |
| OpenPhone sync — conversation insert | [`server.js:40458`](service-flow-backend/server.js#L40458) | ❌ |
| WhatsApp webhook — conversation insert | [`server.js:39715`](service-flow-backend/server.js#L39715) | ❌ |
| Zenbooker sync | `zenbooker-sync.js` — no comms tables touched | n/a |

So today's coverage is: **LB conversations stamped; everything else null.**

---

## 6. Schema Migration Proposal (Not Executed Yet)

Two layers — one is a true source-account FK, the other is the read-side
"is this account currently usable" rule.

### 6a. Add `provider_account_id` to messages, calls, identities

```sql
ALTER TABLE public.communication_messages
  ADD COLUMN IF NOT EXISTS provider_account_id integer
    REFERENCES public.communication_provider_accounts(id) ON DELETE SET NULL;

ALTER TABLE public.communication_calls
  ADD COLUMN IF NOT EXISTS provider_account_id integer
    REFERENCES public.communication_provider_accounts(id) ON DELETE SET NULL;

ALTER TABLE public.communication_participant_identities
  ADD COLUMN IF NOT EXISTS provider_account_id integer
    REFERENCES public.communication_provider_accounts(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_comm_msg_provider_account
  ON communication_messages(provider_account_id)
  WHERE provider_account_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_comm_call_provider_account
  ON communication_calls(provider_account_id)
  WHERE provider_account_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_cpi_provider_account
  ON communication_participant_identities(provider_account_id)
  WHERE provider_account_id IS NOT NULL;
```

Decision left open: whether identities should be **multi-source** (one
identity created from multiple provider accounts as different channels merge
on a phone). If yes, this column is "source of *creation*" only, and the
hide rule must be looser. See §11, Open Decisions.

### 6b. Provider-account row for non-LB providers

OpenPhone and WhatsApp need a `communication_provider_accounts` row at
connect time so there's something to flip to `disconnected`. Proposed
shape:

- `provider='openphone'`, `channel='openphone'`,
  `external_account_id` = OpenPhone phoneNumberId (one row per number, or
  one row per Sigcore tenant connection — see §11), populated in
  `connect-openphone` ([`server.js:39466`](service-flow-backend/server.js#L39466))
  before stamping conversations.
- `provider='whatsapp'`, `channel='whatsapp'`,
  `external_account_id` = the connected WhatsApp phone number, populated
  by [`whatsapp-service.js`](service-flow-backend/whatsapp-service.js)
  on connect.

Once those rows exist, the existing `provider_account_id` column on
`communication_conversations` becomes meaningful for those providers and
the disconnect path can flip status the same way LB does.

### 6c. Add status helpers

Optional but recommended for the read path:

```sql
ALTER TABLE public.communication_conversations
  ADD COLUMN IF NOT EXISTS hidden_at timestamptz;
-- Set when source account becomes disconnected, cleared on reconnect.
-- Lets us cheaply skip rows without joining provider_accounts on every read.

CREATE INDEX IF NOT EXISTS idx_comm_conv_visible
  ON communication_conversations(user_id, channel, last_event_at DESC)
  WHERE hidden_at IS NULL AND is_archived = false;
```

`hidden_at` already exists on `communication_participant_identities`
(used by orphan logic at
[`server.js:40448`](service-flow-backend/server.js#L40448)) — same name
keeps the convention.

---

## 7. Write-Path Changes (Plan)

| Where | What it must stamp |
|---|---|
| `connect-openphone` | Create `communication_provider_accounts` row(s) for OpenPhone phone numbers, return ids for the sync layer. |
| OpenPhone webhook + sync conversation insert | Resolve provider_account_id from the endpoint phone (or from the provisioning step) and write it on `INSERT`. |
| OpenPhone message + call insert | Stamp `provider_account_id` from the parent conversation. |
| WhatsApp connect | Create a `communication_provider_accounts` row keyed on the connected WA phone. |
| WhatsApp webhook insert | Stamp `provider_account_id` on conversation, message, call. |
| LB sync — message + call insert | Stamp `provider_account_id` (currently only the conversation is stamped). |
| Identity resolver | Stamp `provider_account_id` on first-create only. Don't downgrade existing identities — see Open Decisions. |
| Webhook events | Already stamped on `communication_webhook_events.provider_account_id` (good). |

Every import path must also continue to stamp the existing
tenant/owner key (`user_id` and, for LB, the participant identity).

---

## 8. Read-Path Changes (Plan)

The minimum surface needed:

1. `GET /api/communications/conversations`
   ([`server.js:41044`](service-flow-backend/server.js#L41044)) — add a
   join (or denormalized `hidden_at` filter) so rows belonging to a
   disconnected provider account are dropped before send. When `accountId`
   is in the query string, leave the explicit account filter alone — but
   still require it to be `status='active'` or 404 the request.
2. `GET /api/communications/conversations/:id`
   ([`server.js:41305`](service-flow-backend/server.js#L41305)) — same
   gate. Disconnected ⇒ 404 (not 403; the row is "not available," not "you
   can't see this").
3. `POST /api/communications/conversations/:id/send`
   ([`server.js:41531`](service-flow-backend/server.js#L41531)) — refuse
   to send when the underlying provider account is not active. Return 409
   with a machine-readable `reason='source_account_disconnected'`.
4. CRM detail panels (lead/customer pages) that show "recent
   communications" — same gate. The frontend already groups under
   `accountName`; needs to drop the entire group when inactive.
5. Identity reporting endpoints
   ([`server.js:11200`-onward](service-flow-backend/server.js#L11200))
   already use `hidden_at`; extend the floating/connected rollups to
   exclude identities whose only `provider_account_id` is inactive (only
   if Open Decision A lands on "single-source identities").

The principle is: **the gate runs server-side, in the SQL or in the
mapping layer, never in the React component.**

### "No `provider_account_id` at all" rows

Legacy data exists with `provider_account_id IS NULL`. Treat it as
**legacy_unknown_source** — visible in a global "All conversations" view
only, not in any account-scoped view. Do **not** lump these in with the
active-account query, even temporarily.

---

## 9. Backfill Strategy

Three passes, in order, all reversible:

1. **High-confidence direct match.** For LB conversations with a known
   `provider`, `channel`, and `external_business_id` (or known
   `external_account_id` matching a row in `communication_provider_accounts`),
   stamp `provider_account_id` on the conversation, then propagate to its
   messages and calls. LB is the easy case because the FK is partially
   already there.
2. **Provider-shape inference.** For OpenPhone conversations, after the
   §6b connect-time row exists, match conversation `endpoint_phone` against
   the cached phone numbers per provider account row, stamp where exactly
   one match exists. For WhatsApp, match on the connected WA endpoint.
3. **Mark unknown.** Anything that cannot be confidently attributed gets
   `metadata.legacy_unknown_source = true` (or a column if we prefer not
   to use jsonb here). These rows are excluded from account-scoped views;
   they remain visible in "All" until reviewed.

Rules:
- **Never guess on phone alone.** A phone has been linked to multiple
  workspaces in the past (per
  `Obsidian/.../project_cross_app_identity.md`: +18139212100 → 3
  workspaces). Phone-only attribution would re-create the cross-tenant
  bug we just fixed.
- **Never overwrite a non-null `provider_account_id`** during backfill.
- All passes paginate (the project has been bitten by Supabase's 1000-row
  default limit before — see `feedback_supabase_pagination.md`).
- Each pass writes a backfill report row counting matched/unmatched/
  ambiguous so the operator can decide whether to flip the read-side gate.

A dry-run mode is mandatory.

---

## 10. Rollback Plan

- Schema additions (§6) are additive and nullable; they can be dropped
  without data loss if needed (`ALTER TABLE ... DROP COLUMN`).
- Backfill writes only `provider_account_id` and the legacy marker;
  reverse with `UPDATE ... SET provider_account_id = NULL WHERE
  metadata->>'backfill_batch_id' = '<id>'`.
- Read-side gates ship behind a feature flag
  (`SOURCE_ACCOUNT_BOUNDARY_ENFORCED`, default OFF) so the new joins can
  be enabled per environment. Flag pattern matches the v4 identity
  rollout (`Obsidian/.../project_identity_unification_v4.md`).
- Disconnect path keeps writing `status='disconnected'` either way; the
  flag only changes whether downstream queries respect it.

No hard delete in this phase. The plan to set `hidden_at` (not
`DELETE FROM ...`) is exactly so reconnect can re-show the data.

---

## 11. Open Decisions

A. **Are identities single-source or multi-source?**
   Today an identity can carry markers from several providers on the same
   row (`leadbridge_contact_id`, `openphone_contact_id`, etc.). If we
   stamp `provider_account_id` as "creator only," the read filter on
   identities must be looser than on conversations, otherwise a customer
   who happens to have been first seen via a now-disconnected LB account
   disappears entirely. Recommendation: **stamp the creating account on
   identities for audit, but do not gate identity reads on its status.**
   Confirm with the user before coding.

B. **OpenPhone provider-account granularity.**
   One row per Sigcore tenant connection, or one per phone number? Phones
   come and go inside a single OP tenant. Per-phone is closer to the LB
   model; per-tenant matches the SF "user connects an integration once"
   shape. Lean per-phone — disconnect-one-phone is a real workflow.

C. **WhatsApp granularity.** Same question. Today there's one
   `whatsapp_phone_number` per user; stick with one row per user/phone.

D. **What about conversations linked to multiple accounts over time?**
   E.g., the same Thumbtack thread surfaced through two LB accounts in
   sequence. Strict design: dedup on `external_conversation_id` and keep
   the **latest** stamping account. Surfacing "this row was created by
   account A but is now under account B" goes in `metadata`, not a new
   column.

E. **Send-after-disconnect UX.** Should the composer be disabled, or
   should it attempt to send and surface a 409? Backend default is
   refuse + 409; frontend should disable. Confirm.

F. **`legacy_unknown_source` storage.** Column or `metadata` jsonb?
   Column is honest about intent; `metadata` is cheaper. Lean column.

---

## 12. Tests (To Be Written, Not Now)

- Active provider account data appears in conversation list + detail.
- Disconnected provider account data does not appear in conversation
  list or detail (404 on detail).
- Reconnecting clears `hidden_at` and rows reappear.
- Cross-account: rows stamped for account A do not appear when filter
  selects account B, even if endpoints overlap.
- `legacy_unknown_source=true` rows do not appear in account-scoped
  views; do appear in the "All" view if exposed.
- LB sync write path stamps the conversation + message + call
  `provider_account_id` consistently (regression for §7).
- OpenPhone connect creates a `communication_provider_accounts` row;
  webhook insert stamps it on conversation, message, call.
- Disconnecting an account does not delete any `cleaner_ledger`,
  `customers`, `leads`, `jobs`, or `transactions` rows. (Sanity guard
  — none of those tables are in scope, but a regression test pinning
  this is cheap.)
- Send-after-disconnect returns 409 with
  `reason='source_account_disconnected'`.

---

## 13. Out of Scope for This Phase

- Hard-deleting any communication data.
- Changing identity-resolver invariants
  (`Obsidian/.../project_identity_unification_v4.md` Phase A–G ship
  rules stay).
- Enabling Postgres RLS.
- Merging this with the broader cross-tenant guard work in Sigcore
  (separate phase — Sigcore TypeORM tenant_id bug is still pending).
- Backfilling legacy unknown-source rows to a real account by
  guessing.
- LB account-rotation (a single LB user reconnecting to a different
  marketplace business) — handled by `external_account_id` uniqueness;
  surfaces as a migration question on top of this plan.

---

## 14. Sequencing

1. Confirm Open Decisions A–F with user.
2. Migration §6a + §6c (additive, no behavior change).
3. Connect-time provider-account creation for OpenPhone + WhatsApp
   (§6b). Behind `SOURCE_ACCOUNT_BOUNDARY_ENFORCED` for the read side
   only — write-side stamping always-on once shipped.
4. Write-path stamping for OP/WA/LB messages + calls.
5. Backfill in dry-run, review report, apply.
6. Flip read-side gate per environment.
7. Tests at each step; pre-push hook already runs the Jest suite
   (`Obsidian/.../Service Flow.md`).
