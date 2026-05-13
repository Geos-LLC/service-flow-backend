# Synchronization Constitution

**Status:** Authoritative — ratified for all future sync code in the SF ecosystem.
**Scope:** Zenbooker, ServiceFlow, LeadBridge, Sigcore, OpenPhone, WhatsApp transport, Stripe (future), Email systems.
**Replaces:** Implicit ownership conventions previously distributed across `Service Flow.md`, `Sigcore.md`, `LeadBridge.md`.

This document is the governing contract for synchronization. It does not prescribe implementation, it prescribes the rules implementation must obey. Every PR that touches a sync path is reviewed against this document. Violations require either a fix or an explicit, time-boxed exception recorded in §11.

Language: **MUST**, **MUST NOT**, **SHOULD**, **MAY** follow RFC 2119.

---

## §0. Governing principles

The ecosystem operates under four principles, in priority order. When two principles conflict, the higher-numbered one yields.

**P0. Financial history is immutable.** Once a ledger entry is attached to a payout batch, no system MAY mutate or delete it. Corrections happen via compensating entries.

**P1. Each entity has exactly one canonical owner.** Every other system holds a projection of that entity. Projections never mutate the canonical record except through the owner's published interface.

**P2. Sync paths fail loudly.** A sync handler MUST NOT swallow failures. Operators MUST be able to detect drift from logs or audit tables without reading code.

**P3. Cross-tenant data MUST NOT cross tenant boundaries.** Every query that touches multi-tenant tables MUST include the tenant scope guard. No exceptions — the WhatsApp status global-scan precedent (`server.js:39995`) is a defect, not a pattern.

---

## §1. Canonical ownership contract

For every entity, exactly one system is the **canonical owner**. Other systems hold **projections** — read-only copies refreshed via the owner's events or API. **Allowed writers** are the only code paths that may persist a change. **Forbidden writers** are explicitly named where the temptation has surfaced before. **Reconciliation authority** names the single system that resolves a divergence.

### 1.1 Booking lifecycle entities

| Entity / field | Canonical owner | Projection systems | Allowed writers | Forbidden writers | Reconciliation authority |
|---|---|---|---|---|---|
| `jobs.status` | Zenbooker (for ZB-sourced jobs); ServiceFlow (for manual jobs) | LB (status mirror) | ZB webhook handler · ZB reconcile · SF `/api/jobs/:id/status` · SF `/api/jobs/:id/cancel` · LB inbound `/lead-status` (with `source='leadbridge'`) | Any other path | ZB for ZB-sourced; SF for manual |
| `jobs.service_price`, `total`, `discount`, `additional_fees`, `tip_amount`, `duration`, `start_time`, `end_time`, `payment_status`, `invoice_status`, `payment_method`, `total_paid_amount`, `scheduled_date` | Zenbooker | SF | ZB webhook handler · ZB reconcile · ZB transaction sync | Manual edit endpoints · LB · Sigcore | Zenbooker |
| `jobs.hours_worked`, `incentive_amount`, `cleaner_salary_override`, `cancellation_*` (fee/notes/reason/cancelled_at/by) | ServiceFlow | none | SF `PATCH /api/jobs/:id/payroll` · SF cancel API | ZB sync · LB | ServiceFlow |
| `job_team_assignments` (set of cleaners per job) | Zenbooker (`assigned_providers[]`) | SF | ZB webhook + reconcile (atomic replace) | Manual UI MAY edit only on manual jobs | Zenbooker for ZB-sourced; SF for manual |
| `job_team_assignments.incentive_amount` (per-member) | ServiceFlow | none | SF `PATCH /api/jobs/:id/payroll` with `teamMemberId` | ZB sync | ServiceFlow |

### 1.2 Customer / contact entities

| Entity / field | Canonical owner | Projection systems | Allowed writers | Forbidden writers | Reconciliation authority |
|---|---|---|---|---|---|
| `customers` row identity | ServiceFlow | LB (lead↔customer link) | SF CRUD · ZB `customer.edited` (fill-blanks adoption only) | LB write paths MUST NOT create or mutate `customers` rows | ServiceFlow |
| `customers.phone`, `email`, `address`, `city`, `state`, `zip` | ServiceFlow | ZB | ZB **fill-blanks adoption** (only when SF field is NULL/empty) · SF UI | ZB overwrite of non-empty SF fields | ServiceFlow |
| `customers.zenbooker_id` | Zenbooker | SF | ZB sync (one-way stamp) | any other | Zenbooker |
| LB `Lead` (acquisition record) | LeadBridge | SF (lead projection) | LB internal | SF MUST NOT mutate LB's `Lead.*` directly; SF expresses preference via outbound subscription | LeadBridge |

### 1.3 Communication entities

| Entity / field | Canonical owner | Projection systems | Allowed writers | Forbidden writers | Reconciliation authority |
|---|---|---|---|---|---|
| `communication_conversations` row | ServiceFlow (CRM linkage) — but the *content* is projected from Sigcore | none | Sigcore webhook handler (insert/upsert) · SF send path (outbound msg insert) · resolver (CRM link only) | Direct UI mutation outside the resolver | ServiceFlow |
| `communication_messages`, `communication_calls` content | Sigcore (transport canon) | SF (mirror) | Sigcore webhook delivery | SF MUST NOT mutate message body, timestamps, or attachments after insert | Sigcore — SF must accept corrections via future correction events |
| `communication_conversations.provider_account_id` | ServiceFlow (stamped from Sigcore-resolved source) | none | Sigcore inbound (initial stamp) · Phase 3B backfill | Any path that doesn't carry the source-account context | ServiceFlow |
| `communication_participant_identities` (SF-side identity table) | ServiceFlow — and **`resolveIdentity` is the sole writer** | none | `lib/identity-resolver.js` `resolveIdentity()` | LB ingestion · ZB sync · backfill scripts — all MUST route through resolver | ServiceFlow |
| `communication_participant_mappings` (Sigcore participant → SF CRM bridge) | ServiceFlow | none | Sigcore inbound `linkOpenPhoneParticipant` · auto-classifier · manual link UI | Auto-classifier MUST NOT overwrite a manual mapping | ServiceFlow |
| Sigcore `communication_participants`, `openphone_contact_snapshot`, `contact_identity` | Sigcore | SF reads through API | Sigcore internal | SF MUST NOT write back to Sigcore participant tables | Sigcore |
| `communication_provider_accounts` (SF-side source-account registry) | ServiceFlow | none | `lib/source-account.js` `ensureOpenPhoneProviderAccount` / `ensureWhatsappProviderAccount` / LB connect | Direct INSERT/UPDATE outside the helpers | ServiceFlow |

### 1.4 Phone / routing entities

| Entity / field | Canonical owner | Projection systems | Allowed writers | Forbidden writers | Reconciliation authority |
|---|---|---|---|---|---|
| Sigcore `tenant_phone_numbers` | Sigcore | LB stamps `sigcore_allocation_id` (PPA id), SF reads via Sigcore API | Sigcore admin endpoints + Twilio provisioning | LB MUST NOT write to Sigcore TPN rows; only stamp the local mirror | Sigcore |
| Sigcore `profile_phone_assignments` (PPAs) | Sigcore | LB mirror via `sigcore_allocation_id` | Sigcore admin/assignment service | LB MUST NOT create PPAs directly | Sigcore |
| LB `TenantPhoneNumber` rows | LeadBridge | Sigcore unaware | LB internal | Sigcore MUST NOT write into LB DB | LeadBridge |
| SF `endpoint_routes` | ServiceFlow | none | SF OpenPhone connect/disconnect | Any path that doesn't resolve through the deterministic pipeline | ServiceFlow |

### 1.5 Financial entities

| Entity / field | Canonical owner | Projection systems | Allowed writers | Forbidden writers | Reconciliation authority |
|---|---|---|---|---|---|
| `cleaner_ledger` rows of type `earning`, `tip`, `incentive`, `cash_collected` | ServiceFlow | none | `createLedgerEntriesForCompletedJob` is the **sole** completion-derived writer · `rebuildJobLedger` MAY only rebuild **unbatched** entries · status-change cleanup deletes only unbatched | Any other path | ServiceFlow |
| `cleaner_ledger` rows of type `reimbursement`, `expense_deduction` | ServiceFlow | none | `job-expense-service.syncReimbursementLedger` (sole writer) | All other paths | ServiceFlow |
| `cleaner_ledger` rows of type `adjustment` | ServiceFlow | none | Admin manual write endpoint | All other paths | ServiceFlow |
| `cleaner_ledger` rows of type `payout` | ServiceFlow | none | `markBatchPaid` (sole writer) | All other paths | ServiceFlow |
| `cleaner_ledger.payout_batch_id` (linkage to settled batch) | ServiceFlow | none | Batch creation / batch cancellation only | Anywhere else | ServiceFlow |
| `cleaner_payout_batch` rows | ServiceFlow | none | Batch create/cancel/delete endpoints + adjust-and-rebuild | Anywhere else | ServiceFlow |
| `transactions` rows | Zenbooker (for ZB-sourced) / SF (manual) | none | ZB transaction sync (adopts manual rows by `job_id` when `zenbooker_id IS NULL`) · SF manual entry · Stripe webhook (future) | LB · Sigcore | Zenbooker for ZB-sourced; SF for manual; Stripe for Stripe-sourced (future §1.7) |
| Invoice state | Zenbooker | SF | ZB only | n/a | Zenbooker |

### 1.6 Notification entities

| Entity / field | Canonical owner | Projection systems | Allowed writers | Forbidden writers | Reconciliation authority |
|---|---|---|---|---|---|
| `notification_email_logs` (sent/failed/rate_limited) | ServiceFlow | none | `notification-email.service.js` only | Inline `sgMail.send()` calls MUST be migrated; new inline `sgMail.send()` calls are FORBIDDEN | ServiceFlow |
| `payroll_edits` audit | ServiceFlow | none | All payroll-modifying endpoints | Silent skip on insert failure is FORBIDDEN | ServiceFlow |
| `notification_log` (SMS/internal — to be created, see §3.6) | ServiceFlow | none | Future single writer | Anywhere else | ServiceFlow |

### 1.7 Future ownership: Stripe

When Stripe is added as a payment processor:

| Entity / field | Canonical owner | Projection systems | Allowed writers | Forbidden writers |
|---|---|---|---|---|
| Stripe `Charge`, `PaymentIntent`, `Refund` | Stripe | SF (mirror via `transactions` row) · ZB (if surfaced) | Stripe webhook handler in SF (single writer) | Manual `transactions` insert MUST NOT set `stripe_payment_intent_id` |
| Refund state on `jobs.payment_status` | Stripe webhook → SF | none | Stripe webhook only | Manual edit forbidden once `stripe_payment_intent_id IS NOT NULL` |
| Stripe customer/payment method records | Stripe | none | Stripe API via SF service layer | Direct DB write to a cached `stripe_customer_id` outside the service layer is forbidden |

Reconciliation authority for Stripe-sourced state is Stripe (via `/v1/charges/:id` re-fetch).

---

## §2. Single-writer architecture

The audit identified the following remaining multi-writer violations. Each MUST be remediated before the writer set is closed.

### 2.1 Identity writers (currently 4 — target 1)

**Current writers:**
- `lib/identity-resolver.js:163, 208` — canonical `resolveIdentity` (KEEP)
- `leadbridge-service.js:382, 411, 420` — LB `resolveOrCreateLead` writes `sf_lead_id`/`sf_customer_id` directly (REMOVE)
- `zenbooker-sync.js:207` — ZB `linkIdentityToCustomer` writes identity directly (REMOVE)
- `lib/identity-backfill.js:312` — Phase-2 backfill writes identity directly (REMOVE)

**Why it exists:** Phase-by-phase identity-resolver rollout left these as bypass paths to avoid blocking earlier phases.

**Target canonical writer:** `resolveIdentity` only.

**Migration plan:** Each bypass path passes its lookup keys (phone, email, source/external IDs) to `resolveIdentity` and accepts the resolver's verdict. If the resolver needs new modes to express "I have already confirmed this match by `lb_external_request_id`", add a `confirmedExternalKey` parameter rather than bypassing.

### 2.2 Ledger writers (currently safe in shape, unsafe in delete semantics)

**Current writers — all KEEP (correctly scoped):**
- `createLedgerEntriesForCompletedJob` — completion-derived
- `rebuildJobLedger` — rebuild path (correct intent, unsafe delete — see §3.1)
- `ensureManagerEntriesForPeriod` — manager daily entries
- `syncReimbursementLedger` (job-expense-service) — reimbursements
- `markBatchPaid` / batch-cancel — payout rows
- Admin `adjustment` endpoint

**Violation type:** Not extra writers, but **rebuild paths that delete batched entries**. See §3.1.

**Target:** Every DELETE on `cleaner_ledger` MUST have `payout_batch_id IS NULL` in its WHERE clause, except `markBatchPaid` cancellation. Enforced by §10 contract test.

### 2.3 Conversation `provider_account_id` (single writer with backfill exception)

**Current writers:**
- Sigcore inbound handler (initial stamp on insert) — KEEP
- `lib/source-account-apply.js` Phase 3B backfill — KEEP, but only with `WHERE provider_account_id IS NULL`

**Forbidden:** Any UPDATE that overwrites a non-NULL `provider_account_id`. Reconnection MUST NOT silently re-attribute existing rows to the new account.

### 2.4 Status mutation (currently distributed, must funnel through one helper)

**Target canonical writer:** `services/job-status-service.js updateJobStatus({source, ...})`.

**Current callers that MUST funnel through it:**
- SF `/api/jobs/:id/status` ✅ (already funnels)
- SF `/api/jobs/:id/cancel` ✅
- ZB webhook handler ✅
- ZB reconcile ✅
- LB `/lead-status` inbound ✅ (with `source='leadbridge'`)

**Forbidden:** Direct `supabase.from('jobs').update({ status: ... })` from anywhere else. New code that needs to change status MUST call `updateJobStatus`.

### 2.5 Source mapping / source attribution

**Target canonical writer:** `lib/source-account.js` helpers + Phase 3B backfill script.

**Forbidden:** Hand-written INSERT/UPDATE of `communication_provider_accounts` outside the helpers. Hand-written backfill scripts MUST use the published helpers, not raw SQL.

### 2.6 Customer merge / adoption

**Target canonical writer:** A single `mergeOrAdoptCustomer` service to be created (not yet present). Current implementation is split across:
- `zenbooker-sync.js:212-270` (ZB customer.edited adoption)
- `leadbridge-service.js` (LB lead→customer linking)
- OpenPhone `linkOpenPhoneParticipant` (Sigcore-sourced phone match)

**Migration plan:** Extract a `services/customer-adoption.js` with one entry point `findOrAdoptCustomer({ tenantId, phone, email, externalIds, source })`. All three current callers route through it. Phone match policy (last-10 + ambiguity behavior) becomes a single, testable function.

### 2.7 Payment state mutation

**Target canonical writers:**
- `jobs.payment_status` — ZB webhook + reconcile only (and future Stripe webhook)
- `transactions` row — ZB transaction sync, manual SF entry, future Stripe webhook
- `cleaner_ledger.cash_collected` — `createLedgerEntriesForCompletedJob` only

**Forbidden:** Any path that updates `jobs.payment_status` without also writing the matching `transactions` row in the same transaction. The current partial-commit window (`zenbooker-sync.js:1085-1099`) is a defect.

---

## §3. Immutable financial architecture

### 3.1 Immutable boundary: settled ledger entries

A `cleaner_ledger` row with `payout_batch_id IS NOT NULL` is **immutable**:

- It MUST NOT be UPDATEd.
- It MUST NOT be DELETEd except by an explicit batch-cancel operation that simultaneously sets all dependent batch state.
- Its `amount`, `effective_date`, `metadata`, and `team_member_id` MUST NOT change.

**Corrections to settled entries happen via compensating entries**, never in-place mutation. See §3.6.

### 3.2 Replay-safe boundary

A path is **replay-safe** if delivering the same event twice produces the same final state. The following paths MUST be replay-safe:

- All webhook handlers (ZB, LB, Sigcore) — dedup on `event_id` / `zenbooker_id` / `sigcore_message_id`.
- `createLedgerEntriesForCompletedJob` — idempotent on `(job_id, team_member_id, type, effective_date)`.
- `syncReimbursementLedger` — idempotent on `metadata->>'source_id'` (partial unique index).
- LB outbound drainer — idempotent on `event_id` UNIQUE.
- Sigcore inbound message insert — idempotent on `sigcore_message_id` UNIQUE.

A message without `sigcore_message_id` MUST be rejected, not inserted without dedup.

### 3.3 Rebuild-safe boundary

A path is **rebuild-safe** if its output for a given input is reproducible from inputs that are also stable. Rebuilds MUST:

- Read **historical** rates and entity state, not current. Therefore:
  - `cleaner_ledger.metadata` MUST snapshot `hourly_rate`, `commission_pct`, `member_count`, `revenue_at_create`, `hours_at_create` at first creation.
  - Rebuilds read these snapshots and recompute only the math, not the inputs.
- Skip entries with `payout_batch_id IS NOT NULL` (§3.1).
- If a rebuild would have produced a different amount on a batched entry, the system MUST emit a `ledger_drift_detected` audit row and NOT mutate.

### 3.4 Payout-batched boundary

A `cleaner_payout_batch`:

- `total_amount` is set at creation and MUST NOT be updated except by an explicit `recompute-and-reconcile` admin action that also writes a compensating adjustment.
- MUST store an `entry_count` and a verification checksum (sum of linked entry IDs hashed) to detect orphan-by-rebuild.
- Cancelling a paid batch MUST emit a compensating `adjustment` entry equal to the original payout magnitude; it MUST NOT delete the `payout` ledger row.
- Cancelling a pending batch MAY detach entries (`payout_batch_id → NULL`) — those entries become re-settleable.

### 3.5 Historical-rate snapshot rules

Every `cleaner_ledger` row of type `earning`, `tip`, `incentive`, `cash_collected` MUST include in `metadata`:

```jsonc
{
  "hourly_rate_snapshot": "...",       // rate in effect on job's scheduled_date
  "commission_pct_snapshot": "...",
  "member_count_snapshot": ...,        // for multi-cleaner jobs
  "revenue_at_create": "...",
  "hours_at_create": "...",
  "effective_rate_date": "YYYY-MM-DD"  // the date used to look up the rate
}
```

Rebuilds use these snapshots, not current `team_members.hourly_rate`. The "stale-rate rebuild" defect (audit D3) is closed by this rule.

### 3.6 Correction-entry rules

Corrections to financial state — including bugs found in past calculations — MUST be applied as **new compensating entries**:

| Correction need | Method |
|---|---|
| Underpayment in a settled batch | New `adjustment` entry (positive), unbatched, surfaces as prior-period balance |
| Overpayment in a settled batch | New `adjustment` entry (negative), unbatched |
| Wrong cleaner attribution in a settled batch | Compensating `adjustment` to original cleaner + matching `earning`-shaped `adjustment` to correct cleaner. **NEVER** UPDATE the original row's `team_member_id`. |
| Cash collected after batch was settled | New `cash_collected` entry for the new collection date, unbatched |
| Cancelled job that was already in a paid batch | Compensating `adjustment` (not delete); job row gets `cancellation_*` fields |
| Stripe refund of a payment that's been settled | New compensating `transactions` row + compensating `adjustment` ledger entry |

**Never**: in-place UPDATE of a batched row. **Never**: DELETE of a batched row outside an explicit batch-cancel.

---

## §4. Canonical event flow design

Events are classified into three layers. Code MUST NOT blur them.

### 4.1 Source events

Originate from a canonical owner about a fact it owns. They are authoritative.

| Source | Event types | Transport |
|---|---|---|
| Zenbooker | `job.created/canceled/rescheduled/en_route/started/completed/service_providers.assigned/service_order.edited`, `invoice.payment_succeeded/recorded`, `customer.edited` | HMAC-signed webhook (§6) |
| LeadBridge | `lead.created`, `lead.status_changed`, `message.received`, `message.sent` | HMAC-signed webhook |
| Sigcore | `openphone.message.{inbound,outbound}`, `openphone.call.completed`, `whatsapp.message.{inbound,delivered}`, `whatsapp.status.change` | HMAC-signed webhook |
| Stripe (future) | `payment_intent.succeeded`, `charge.refunded`, `charge.dispute.*` | Stripe-signed webhook |

Source events carry an `event_id` (UNIQUE) and an `event_ts` (monotonic per stream).

### 4.2 Projection events

Internal events SF emits to keep its own derived state coherent (e.g., "ledger needs rebuild for job X"). These are NOT delivered to external systems.

| Projection trigger | Effect |
|---|---|
| `job.status changed to completed` | `createLedgerEntriesForCompletedJob(jobId)` |
| `job.status changed from completed` | Delete unbatched completion-derived ledger entries; preserve reimbursement/adjustment/payout/expense_deduction |
| `team_assignments changed` | Rebuild unbatched ledger entries; on assignment shrink, DELETE orphan unbatched entries for removed members |
| `availability changed` | `ensureManagerEntriesForPeriod` for affected weeks (unbatched only) |
| `provider account disconnected` | Hide via `SOURCE_ACCOUNT_BOUNDARY_ENFORCED`; do NOT delete |

Projection effects MUST be idempotent. Re-running them MUST converge to the same state.

### 4.3 Reconciliation events

Run on a schedule or on operator demand to detect divergence. They MUST be read-only by default; mutations require operator confirmation OR a documented compensating-entry pattern (§3.6).

| Reconcile path | Authority | Allowed actions |
|---|---|---|
| ZB hourly reconcile cron | Zenbooker | UPDATE ZB-owned fields on SF rows; INSERT-only on transactions; rebuild unbatched ledger only |
| LB outbound drainer | n/a | Retries SF→LB delivery; never touches CRM state |
| LB integration `/reconnect` | LeadBridge | Re-registers webhook subscriptions; does NOT mutate leads/customers |
| Sigcore `/integrations/sync` | Sigcore | Pulls conversations/messages; SF mirror replays via idempotent dedup |
| Payroll-page stale-entry rebuild | ServiceFlow | Rebuilds unbatched ledger only; on batched divergence MUST emit `ledger_drift_detected` and skip |
| Source-account Phase 3B backfill | ServiceFlow | UPDATE `provider_account_id` only WHERE NULL |
| Identity backfill | ServiceFlow | INSERT identities via `resolveIdentity` only |
| Stripe periodic refund sweep (future) | Stripe | Read-only; emits compensating entries |

### 4.4 Replay, dedup, retry, stale, conflict

**Replay rules:**
- Every inbound webhook MUST be dedupable. The dedupe key is documented per event type.
- A replayed source event with the same `event_id` MUST produce identical final state (no-op on second delivery).

**Dedup rules:**
- ZB events: `zenbooker_id` per entity for upserts; `event_id` on the event row.
- LB events: `event_id` UNIQUE in `communication_webhook_events`.
- Sigcore events: `sigcore_message_id` / `sigcore_call_id` UNIQUE; messages without a Sigcore ID MUST be rejected with 4xx.
- Stripe events: Stripe `event.id` UNIQUE.
- Internal projection effects: keyed on the entity ID + projection name.

**Retry rules:**
- Inbound webhook returns 200 only after persisted dedupe; failures return 5xx so the sender retries.
- Outbound delivery (SF→LB, SF→Sigcore-bound APIs) MUST use the outbound queue + drainer pattern. Inline `axios.post` from a request handler is FORBIDDEN.
- Outbound drainer retry curve: 0/10s/60s/10m/1h for network/5xx, terminal at 4xx-with-no-retry (401/404/422). Dead-letter at 5 attempts → DLQ row with `last_error`.
- Operator must be able to surface DLQ rows from a single query.

**Stale-event handling:**
- Source events SHOULD carry `event_ts`. If a handler sees `event_ts` older than the entity's `last_synced_at`, it MUST log + skip.
- Where the source omits `event_ts`, the handler relies on dedup (cannot distinguish stale from replay) — this is an acceptable degradation for ZB today.

**Conflict resolution:**
- When the canonical owner sends a value that differs from a manual SF edit:
  - For fields owned by the source: source wins (e.g., ZB updates `service_price`).
  - For fields owned by SF: source MUST NOT touch them (e.g., ZB never writes `hours_worked`).
  - For fields with a documented preserve rule: preserve rule wins (e.g., `tip_amount` preserved when SF value > 0).
- Two-source conflict (e.g., ZB customer edit + LB customer enrichment) is resolved by the customer's owning system: SF. SF MAY apply fill-blanks adoption from any source; only SF UI MAY overwrite a non-empty SF field.

---

## §5. Drift model

Drift is classified by recoverability. Every sync path's failure modes MUST map to one of these classes.

### 5.1 Acceptable drift (no action)

Temporary, self-healing differences that resolve on the next scheduled event:
- Conversation `last_message_at` lagging by <1 minute behind Sigcore.
- LB lead status mirror lagging by a single webhook hop.
- Manager daily entries for "today" being absent until first payroll-page query.

### 5.2 Temporary drift (alert if persistent)

Resolves on next reconcile if the reconcile path runs. Acceptable for one cycle; alert if it persists across two cycles:
- ZB job's `payment_method` stuck as `'other'` when reconcile would resolve to `'cash'`.
- LB `Lead.customerPhone` not yet normalized.
- OpenPhone contact `displayName` outdated relative to provider.

### 5.3 Critical drift (page operator)

State divergence that affects user-visible business correctness:
- `cleaner_payout_batch.total_amount` ≠ sum of linked unbatched entries.
- A job with `status='completed'` and no `cleaner_ledger` rows.
- A job marked `payment_status='paid'` with no `transactions` row.
- A conversation visible in the UI whose `provider_account_id` resolves to a disconnected account (boundary flag bypass).
- Email send attempted with no log row in `notification_email_logs`.

### 5.4 Repairable drift (compensating entry required)

Drift that can be corrected only by §3.6 compensating entries:
- Settled ledger entry computed with wrong rate.
- Cleaner attribution wrong on a settled batch.
- Stripe refund applied after batch settled.

### 5.5 Unrecoverable drift (post-mortem required)

Drift that cannot be reconstructed because the source of truth is gone:
- Sigcore-side message deleted before SF mirrored it (would require Sigcore retention).
- LB lead deleted upstream without `lead.deleted` event (today the system has no handler — see §3 followup).
- A pre-Phase-1 conversation whose source account can no longer be inferred.

### 5.6 Per-domain drift class map

| Domain | Acceptable | Temporary | Critical | Repairable | Unrecoverable |
|---|---|---|---|---|---|
| Status | <60s lag | Reconcile-resolvable | `completed` job with no ledger | Status corrected via cancel + manual restore | Deleted upstream entity |
| Financials | n/a | Method resolve from `'other'` to `'cash'` | Batch ≠ sum, ledger drift | Wrong-rate settled entries | Lost transaction with no source |
| Identities | <hop lag | Resolver re-resolves on next event | Identity created by non-resolver path | Misattributed customer | Phone reassigned across people, no trace |
| Communication | Last-msg lag | Contact name lag | Message visible on disconnected account | Re-attribution after reconnect | Sigcore-side deleted message |
| Payroll | n/a | Manager daily gap until payroll query | Stale rate rebuild on batched entry | Wrong rate on settled entry | Historical rates not snapshotted (until §3.5 rolled out) |
| Attribution | n/a | NULL `provider_account_id` on legacy row | Disconnected account visible | Re-attribute via backfill | Pre-Phase-1 unattributable conversations |
| Sync subscriptions | <hop lag | Token close to expiry | Subscription registration silently failed | Re-register | Token expired with no operator notice (until proactive refresh) |
| Provider accounts | n/a | Reconnect pending | Account deleted; conversations orphaned via NULL FK | Re-link via UI | LB JWT expired with no refresh path |

---

## §6. Failure-state architecture

The REQUIRED system behavior for each failure class. Implementations that don't match this section are out of compliance.

### 6.1 Webhook failure

- **Inbound (we receive):** signature verification fails → 401 with reason code, no row written. Dedup miss → 200 (replay). Processing error after dedup → 5xx so sender retries. The async-200-then-process pattern (today: `leadbridge-service.js:1545`) is FORBIDDEN for paths that mutate canonical state.
- **Outbound (we send):** delivered via outbound queue + drainer (§4.4). Inline `axios.post` from a request handler is FORBIDDEN.

### 6.2 Partial commit

- Multi-step writes that mutate two or more canonical entities MUST execute inside a single DB transaction. The current ZB partial-commit window (job→paid before transaction insert) is a defect.
- Where a transaction is impractical (cross-table with different connection pools), the write MUST be ordered so a crash leaves the system in a state that the next reconcile recovers to correctness — and the path MUST emit a `partial_commit_recoverable` audit row.

### 6.3 Stale queues

- Outbound queue rows in `sending` state past their lease MUST be swept back to `pending` on the next drainer tick.
- DLQ rows MUST be surfaced via an operator-visible endpoint. Silent DLQ growth is FORBIDDEN.

### 6.4 Expired auth

- Every external auth credential (LB integration JWT, ZB API key, Sigcore tenant key, Stripe key, OpenPhone token) MUST have a documented expiry policy and a documented refresh path.
- Where refresh is automatic (Yelp/Thumbtack OAuth, Stripe rolling keys): the refresher MUST log every refresh and surface failures.
- Where refresh is manual (LB JWT): the system MUST warn the operator at ≥7 days before expiry. Today the LB JWT has no proactive notice — this is a defect, not a feature.

### 6.5 Disconnected providers

- Disconnect MUST mark the provider account `status != 'active'`, NOT delete it.
- All read/send/detail paths MUST gate on `SOURCE_ACCOUNT_BOUNDARY_ENFORCED` when the flag is ON (today: list-only).
- Reconnect MUST create a new `communication_provider_accounts` row if the disconnect was hard; it MUST NOT re-attribute existing conversations to the new row without operator confirmation.

### 6.6 Missing upstream entities

- When an event references an entity the local system doesn't have (e.g., LB sends `lead.status_changed` for a lead SF has no record of), the handler MUST log a `missing_upstream_reference` row and 200 the webhook (avoid retry storms). Operator visibility comes from the audit row, not the HTTP status.
- "Missing source clears" (`lead.deleted`, `customer.deleted`, `job.deleted`) MUST be handled in every direction. Today they are not — this is a tracked defect.

### 6.7 Duplicate deliveries

- Source events: dedup by event ID (§4.4). Second delivery is a no-op.
- Projection effects: idempotent by entity ID + projection name.
- Webhook subscriptions: a registration call MUST be safe to repeat (LB subscription endpoints are idempotent — verify; Sigcore subscription paths likewise).

### 6.8 Replayed events

- Tools that intentionally replay events (admin "resync this job") MUST go through the same dedup path. They MUST NOT bypass `event_id` checks.

### 6.9 Delayed reconcile

- A reconcile cron that misses a cycle MUST converge once it runs. It MUST NOT depend on running every N minutes for correctness.
- The current ZB reconcile 500-job-per-hour cap (`zenbooker-sync.js:1177`) violates this — under backlog, tail jobs never converge until backlog clears. Fix: paginate to exhaustion or per-user-scope.

### 6.10 Cross-tenant collisions

- Every query against a multi-tenant table MUST include the tenant scope guard. No exceptions.
- The WhatsApp status webhook global scan (`server.js:39995`) is a defect.
- HMAC-verified userId MUST cross-check against routing-derived userId; mismatch → drop event with audit.

---

## §7. Boundary architecture

### 7.1 Ownership boundaries (hard rules)

**Sigcore owns transport.** All provider integration (OpenPhone, Twilio, WhatsApp Web) MUST go through Sigcore. SF MUST NOT call OpenPhone, Twilio, or WhatsApp APIs directly. Today this is honoured — preserve it.

**ServiceFlow owns CRM.** Customer records, jobs, payroll, ledger, business workflow live in SF. No other system writes them outside the published interfaces.

**LeadBridge owns acquisition automation.** AI projection, lead scoring, follow-up scheduling, channel orchestration live in LB. SF receives status mirrors and message projections via webhooks; SF does not implement LB's automation.

**Zenbooker owns booking lifecycle.** Job creation, scheduling, completion, invoicing, payment recording originate in ZB. SF mirrors and extends; SF does not implement scheduling.

**Stripe (future) owns payment processing.** Payment intent, charge, refund, dispute state originate in Stripe. SF mirrors via webhook into `transactions`; SF does not implement payment processing logic.

### 7.2 Explicit forbidden patterns

The following are forbidden by this constitution. PRs introducing them MUST be rejected.

1. **Direct OpenPhone logic inside SF.** No `axios` call from SF to `api.openphone.com`. Use Sigcore's `/integrations/openphone/*` API.
2. **Direct Twilio logic inside SF.** Same.
3. **Direct WhatsApp Web logic inside SF.** Same.
4. **Direct provider writes bypassing Sigcore.** A new provider (Telnyx, Vonage, etc.) MUST be added as a Sigcore module, not as a parallel SF integration.
5. **Direct lead mutation bypassing canonical flows.** SF MUST NOT write directly into LB's database. LB receives change intent via its public API only.
6. **Direct ledger rewrites after payout batching.** §3.1.
7. **Manual `INSERT INTO communication_participant_identities`** outside `resolveIdentity`. §2.1.
8. **Manual `INSERT INTO communication_provider_accounts`** outside `lib/source-account.js` helpers. §2.5.
9. **Inline `sgMail.send()` calls** outside `notification-email.service.js`. §1.6.
10. **`router.use(authenticateToken)` on `/api`-mounted modules.** Per-route auth only. (Existing rule from `feedback_per_route_auth_api_mount.md`.)
11. **Direct `supabase.from('jobs').update({ status })`** outside `updateJobStatus`. §2.4.

---

## §8. Reconcile philosophy

### 8.1 When reconcile is ALLOWED

- The canonical owner publishes both source events AND a reconcile API/cron, and the reconcile output is read-equivalent to what the events would have produced.
- The reconcile target field is owned by the reconciler's system.
- The reconcile is replay-safe (§3.2).

### 8.2 When reconcile is FORBIDDEN

- Reconcile from a non-owner. (E.g., LB MUST NOT reconcile SF customer data.)
- Reconcile that mutates batched ledger entries.
- Reconcile that would overwrite a manual SF edit on an SF-owned field.
- Reconcile that overwrites a non-NULL `provider_account_id` with a different value.

### 8.3 When reconcile MUST produce compensating entries

- The reconcile detects a divergence on a settled financial row. §3.6 applies — compensating entry, never in-place fix.
- The reconcile detects a status that was once `completed` and the ledger has been deleted. Compensating entries needed to restore payroll history if the deletion was wrong.

### 8.4 When reconcile MAY update in place

- The target field is owned by the reconciler's system AND the target row is not settled.
- The change is fill-blanks (NULL → value) or canonical-owner-overwrites-projection on owner-owned fields.

### 8.5 When reconcile MUST halt and escalate

- Encounters a row that would require mutating a batched entry.
- Encounters a cross-tenant attribution candidate (same phone resolves to two tenants).
- Encounters a missing canonical owner (e.g., a `transactions` row with `zenbooker_id` set but ZB returns 404 — escalate, don't delete).
- Encounters data that doesn't fit any §5 drift class — escalate so the class map can be updated.

Escalation means: write an audit row, alert via the operational channel (`notification_log`/Grafana/Loki), STOP processing the current row, continue with the next.

---

## §9. Priority implementation sequence

The audit produced 24 drift surfaces (D1–D24). Mapped to this constitution, the implementation order is:

### P0 — Constitution prerequisites (cannot ship anything else first)

These close the immutability boundary and remove the attack surface that lets every other rule be violated.

| # | Item | Constitution ref | Audit ref |
|---|---|---|---|
| P0.1 | Add `payout_batch_id IS NULL` guard to every `cleaner_ledger` DELETE in rebuild paths | §3.1, §2.2 | D1, D2 |
| P0.2 | Sign ZB webhook (shared secret + IP allowlist as interim if ZB doesn't support HMAC) | §6.1 | D4 |
| P0.3 | Snapshot historical rates into `cleaner_ledger.metadata` at create time; rebuild reads snapshots | §3.5 | D3 |

**Dependency graph:** P0.3 is required before any rebuild path is touched in P0.1 (otherwise a P0.1-fixed rebuild still uses current rates). P0.2 is independent and can ship in parallel.

### P1 — Loud failures + boundary completion

| # | Item | Constitution ref | Audit ref | Depends on |
|---|---|---|---|---|
| P1.1 | Apply `SOURCE_ACCOUNT_BOUNDARY_ENFORCED` check on detail + send + WA-send endpoints | §1.3, §6.5 | D5 | — |
| P1.2 | Replace silent catches in ZB sync with structured error + `zb_sync_dirty` row marker | §0 P2, §6.6 | D8, D9 | — |
| P1.3 | Wrap ZB job→paid + transaction insert in a single DB transaction | §6.2 | D9 | — |
| P1.4 | Tenant-scope the WhatsApp status webhook | §6.10 | D11 | — |
| P1.5 | Migrate 8 inline `sgMail.send()` calls to `notification-email.service.js` | §1.6, §7.2 #9 | D14 | — |
| P1.6 | Create `webhook_delivery_log` audit table; SF→LB, LB→SF, Sigcore→SF, all email sends write to it | §0 P2, §6.7 | D7, D17, D14 | — |
| P1.7 | LB→SF `/webhooks` returns 5xx on processing failure (drop the async-200 pattern for canonical mutations) | §6.1 | D7 | P1.6 |

**Dependency graph:** P1.6 unblocks P1.7's failure mode (writes the audit row before 5xx return). P1.1–P1.5 are independent.

### P2 — Single-writer funneling + queue health

| # | Item | Constitution ref | Audit ref | Depends on |
|---|---|---|---|---|
| P2.1 | Funnel 3 identity bypass paths through `resolveIdentity` | §2.1 | D12 | — |
| P2.2 | Proactive LB JWT refresh + ≥7-day expiry banner | §6.4 | D6 | — |
| P2.3 | Webhook subscription registration failures return non-200 with reason | §6.1 | D13 | — |
| P2.4 | Multi-cleaner ledger reconcile extends with DELETE of orphan unbatched entries | §4.2 projection rules | D10 | P0.1 |
| P2.5 | `cleaner_payout_batch` adds `entry_count` + checksum; drift detected → `ledger_drift_detected` audit | §3.4 | D21 | P0.1 |
| P2.6 | Extract `services/customer-adoption.js` as single merge/adopt entry point | §2.6 | D16 (partial) | — |

### P3 — Reconcile completeness + hygiene

| # | Item | Constitution ref | Audit ref | Depends on |
|---|---|---|---|---|
| P3.1 | ZB reconcile cron paginates to exhaustion OR scopes per-user | §6.9 | D17 | — |
| P3.2 | `synced_at` watermark on `cached_phone_numbers`, `openphone_contact_snapshot`, `customer` enrichment caches | §0 P2 | D18 | — |
| P3.3 | Handle `lead.deleted`, `customer.deleted`, `job.deleted` events from LB + ZB | §6.6 | D19 | P2.6 |
| P3.4 | Paginate `/api/ledger/balance/:teamMemberId` | §0 P2 | D22 | — |
| P3.5 | `payroll_edits` insert failures surface loudly | §0 P2 | D20 | P1.6 |
| P3.6 | Handle Sigcore message-correction events (when published by Sigcore) | §1.3 | D23 | (Sigcore-side work) |
| P3.7 | Phase-C dual-read collision (mapping vs legacy) — emit warning when they disagree | §1.3 | D24 | — |

### Cross-cutting (every P0–P3 item)

- New paths added during this work MUST include a test asserting the relevant constitution rule. Where a contract test doesn't yet exist (§10), it ships with the item.
- Each item that touches a sync path MUST update the relevant entry in §1 (ownership table) if behavior changes.

### Dependency graph (short form)

```
P0.3 ──→ P0.1 ──→ P2.4
                ╰─→ P2.5
P0.2 (independent)

P1.6 ──→ P1.7
       ╰─→ P3.5
P1.1, P1.2, P1.3, P1.4, P1.5 (independent of each other)

P2.1, P2.2, P2.3 (independent)
P2.6 ──→ P3.3
```

---

## §10. Contract tests (the constitution as code)

Every rule that can be expressed as a test MUST have one. These tests live in `tests/` and run on every push. New rules MUST land with their tests.

Required test suites (some exist, marked ✓):

- ✓ `cancellation.test.js` — pins completion-derived vs preserved ledger-type lists
- ✓ `payout-system.test.js` — batch creation, balance, recovery
- ✓ `webhook-handlers-invariants.test.js` — source-text scan for forbidden patterns
- ✓ `conversation-identity.test.js` — deterministic grouping
- **NEW REQUIRED:**
  - `ledger-immutability.test.js` — asserts every DELETE on `cleaner_ledger` outside `markBatchPaid` includes `payout_batch_id IS NULL` (source-text scan)
  - `identity-writer-funnel.test.js` — source-text scan asserts no `communication_participant_identities` INSERT/UPDATE outside `lib/identity-resolver.js`
  - `source-account-writer-funnel.test.js` — same for `communication_provider_accounts`
  - `status-writer-funnel.test.js` — source-text scan asserts no `from('jobs').update({status})` outside `services/job-status-service.js`
  - `webhook-pattern.test.js` — asserts inbound webhook handlers return 5xx on processing failure for canonical mutations
  - `tenant-scope.test.js` — flags any `.from('<multi-tenant table>')` without `.eq('user_id'|...)` in source scan
  - `sgmail-no-inline.test.js` — bans new `sgMail.send(` outside `notification-email.service.js`

---

## §11. Exceptions register

Exceptions to this constitution MUST be listed here, with owner, reason, and expiry. Empty exception list is the goal state.

| Date | Section | Exception | Owner | Reason | Expiry |
|---|---|---|---|---|---|
| _(none)_ | | | | | |

---

## §12. Amendment process

Amendments to this constitution require:

1. A documented reason (an audit finding, a new integration requirement, a discovered drift class).
2. An update to the relevant §1–§9 section.
3. A new or updated §10 contract test (or a justification in §11 if untestable).
4. An entry in the changelog below.

### Changelog

| Date | Section(s) | Change |
|---|---|---|
| 2026-05-13 | All | Initial ratification |
