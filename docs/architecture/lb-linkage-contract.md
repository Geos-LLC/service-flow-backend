# LeadBridge ↔ ServiceFlow linkage contract

This document defines how LB identity persists through the SF lifecycle and what the system guarantees about it. It is the binding spec for any code that creates a `jobs` row, mutates a `jobs.status`, or syncs a LeadBridge lead.

## The canonical linkage

For any record that originated from LeadBridge, SF must preserve these six fields:

| field | source | written to |
|---|---|---|
| `lb_external_request_id` | LB `lead.externalRequestId` (TT negotiation id / Yelp lead id) | `leads.lb_external_request_id`, `jobs.lb_external_request_id` |
| `lb_channel` | `'thumbtack'` or `'yelp'` | `leads.lb_channel`, `jobs.lb_channel` |
| `lb_business_id` | LB `lead.businessId` | `leads.lb_business_id` |
| `lb_provider_account_id` | SF `communication_provider_accounts.id` (numeric) | `leads.lb_provider_account_id` |
| `source` | canonical mapped per `lead_source_mappings` | `leads.source`, copied to `customers.source` at lead→customer conversion |
| `source_raw` | raw `"${accountDisplayName} (${channel})"` | `leads.source_raw` |

The first four travel through the lifecycle. The last two are for attribution audit only and live on `leads` and (partially) `customers`.

## The system invariant

> **If an SF job is created for a customer whose identity graph contains exactly one LB-linked converted lead, then the job MUST have `lb_external_request_id` and `lb_channel` populated before any outbound status logic runs.**
>
> If the linkage chain is ambiguous, the resolver MUST NOT guess. It returns `result='review_required'` with a specific reason, the job is created without linkage, and the operator-facing log + metrics surface the reason.

The invariant binds every job-creation path. Any future code that inserts into `jobs` must call `resolveLbLinkage` first.

## Resolution strategies

In `lib/lb-linkage-resolver.js`, tried in order, first match wins:

1. **`explicit`** — caller passed `lb_external_request_id` directly. Used by the LB→SF inbound path that already knows the linkage.
2. **`lead_match`** — `leads WHERE converted_customer_id = customerId AND lb_external_request_id IS NOT NULL`, returning exactly one distinct external id.
3. **`identity_lead_match`** — `communication_participant_identities WHERE sf_customer_id = customerId` resolves to an `sf_lead_id` whose lead carries linkage, AND there's no conflicting `lead_match`.

## Reason codes

The resolver returns one of these reason codes; each maps to exactly one `result`:

| reason | result | meaning |
|---|---|---|
| `explicit` | `linked` | Caller supplied the linkage. |
| `lead_match` | `linked` | One LB-linked lead found via converted_customer_id. |
| `identity_lead_match` | `linked` | One LB-linked lead found via identity graph (lead_match was empty). |
| `multiple_lb_leads` | `review_required` | > 1 distinct external_request_id across leads for the customer. |
| `ambiguity_identity_disagrees` | `review_required` | One lead_match but identity points elsewhere. |
| `duplicate_customer` | `review_required` | > 1 identity rows for the customer with different sf_lead_ids. |
| `household_phone_risk` | `review_required` | Reserved — not yet wired. |
| `no_customer` | `not_linked` | Job has no `customer_id`. |
| `no_lb_lead` | `not_linked` | Identity exists but no LB lead reachable. |
| `customer_without_identity` | `not_linked` | No identity row for the customer. |
| `error` | `not_linked` | DB lookup threw — defensive fallback. |

Code that creates a job stamps linkage only when `result='linked'`. For `review_required` and `not_linked`, the job is created without linkage and the structured log + metrics record why.

## Hard rules

- **No phone-only matching.** Linkage is found via `converted_customer_id` OR the identity graph, never by joining phones across customers.
- **No silent overwrites.** `enrichLeadFromLB`'s fill-nulls-only rule blocks any second LB external id from clobbering the first. Mismatch is logged via `[LB Lead] lb_linkage_mismatch`.
- **Tenant scope on every query.** No path from one tenant's customer to another tenant's lead.
- **No global lifecycle authority flips.** This contract does not enable `SF_STATUS_WINS` on the LB side; it only ensures the linkage exists so any future outbound emit reaches the right LB lead.

## Job-creation surface (must call resolveLbLinkage)

| site | file | resolver call |
|---|---|---|
| SF UI job create | [server.js](../../server.js) — `POST /api/jobs` | `resolveLbLinkage({userId, customerId, explicit: req.body})` |
| SF UI job duplicate | [server.js](../../server.js) — `POST /api/jobs/:id/duplicate` | `linkageFromParentJob(existingJob)` — inherit verbatim |
| ZB bulk sync | [zenbooker-sync.js](../../zenbooker-sync.js) — `runJobsSync` | `resolveLbLinkage({userId, customerId})` |
| ZB webhook | [zenbooker-sync.js](../../zenbooker-sync.js) — `handleJobEvent` | `resolveLbLinkage({userId, customerId})` |

Every site emits one `[LBLinkage] action=resolve_for_job ...` log line per job created.

## Outbound side

`recordOutboundIfApplicable` in `services/lb-outbound-delivery.js` checks the job's `lb_external_request_id` before enqueueing an outbound event. Skip reason `skipped_not_linked` is now:

- counted via `outbound_status_skipped_not_linked` metric
- logged via `[LBLinkage] action=outbound_skipped_not_linked job_id=... status=... reason=no_lb_linkage_on_job`

This is the operator's signal that the write-path side of the contract leaked an unlinked job into status-change territory.

## Observability

### Per-job log
```
[LBLinkage] action=resolve_for_job
  job_id=<id> customer_id=<id> lead_id=<id|null>
  result=linked|not_linked|review_required
  reason=<reason>
  external_request_id=<id|null> channel=thumbtack|yelp|null
```

### Per-status-change log (on unlinked)
```
[LBLinkage] action=outbound_skipped_not_linked
  job_id=<id> user_id=<id> status=<new> previous=<old|null>
  source=<source> reason=no_lb_linkage_on_job
```

### In-process metrics

Exposed via `lib/lb-linkage-metrics.js getMetrics()`:

```
jobs_created_with_lb_linkage
jobs_created_without_lb_linkage
jobs_created_review_required
outbound_status_skipped_not_linked
reasons: { <reason>: <count>, ... }
```

### Operator health endpoint

`GET /api/integrations/leadbridge/linkage-health` returns tenant-scoped:

```jsonc
{
  "user_id": 2,
  "leads": { "total_for_user", "lb_linked", "lb_linked_thumbtack", "lb_linked_yelp", "lb_linked_converted" },
  "jobs":  { "total_for_user", "lb_linked",
             "missing_linkage_with_customer",
             "missing_linkage_recoverable_single_lead",
             "missing_linkage_ambiguous" },
  "outbound": { "pending", "sent", "dlq", "skipped_unmapped", "last_event_at" },
  "process_counters": { ... },
  "integration_state": { "leadbridge_connected", "direction_outbound_active" }
}
```

Backed by RPC `lb_linkage_unlinked_job_buckets(BIGINT)` (migration 052).

## Bidirectional reconcile (Phase 2/3 of "Sync LeadBridge")

The `POST /api/integrations/leadbridge/sync` button is no longer a one-way pull. After Phase 1 (LB → SF lead import) finishes, the same call now reconciles SF lifecycle back to LB through the existing outbound queue.

### Phases (single click)

| phase | what runs | side effect |
|---|---|---|
| 1 — pull | `GET /v1/leads?scope=all` → upsert SF leads, preserve `lb_*`, `source`, `source_raw` | inbound writes only |
| 2 — reconcile | join `allLeads` to LB-linked SF jobs by `lb_external_request_id`, compare current SF status vs LB canonical | no writes (read-only diff) |
| 3 — push | for SAFE drift, enqueue outbound event via existing `recordOutboundIfApplicable` | outbox INSERTs (skipped in `dryRun`) |
| 4 — report | populate `syncProgress[userId].reconcile.{plan, summary}` | none |

### Endpoint contract

```
POST /api/integrations/leadbridge/sync
  body:   { accountId?, limit?, reconcile?: boolean }
  query:  ?mode=apply (default) | ?mode=dryRun | ?mode=plan
  response: 202 { started: true, mode: 'apply'|'dryRun', reconcile: true }

GET /api/integrations/leadbridge/sync/progress
  response: {
    status: 'idle'|'running'|'complete'|'error',
    phase: 'fetching'|'syncing_<platform>'|'reconcile'|'reconcile_dry_run'|'done',
    total, synced, messages, errors,
    reconcile: {
      summary: { jobs_evaluated, statuses_pushed, already_in_sync,
                 lifecycle_drift, skipped_no_lb_lead, skipped_hard_terminal,
                 skipped_regression, skipped_unsupported, skipped_previous_dlq,
                 failures },
      plan: [ { job_id, action: 'queue'|'noop'|'skipped'|'error',
                reason, sf_status, sf_canonical, lb_status, event_id? } ]
    }
  }
```

Callers pass `reconcile: false` in the body to keep the pre-PR pull-only behavior.

### Safety rules — when reconcile DOES NOT push

The classifier returns `skipped` with a specific reason:

| reason | meaning |
|---|---|
| `lb_lead_not_in_pull` | LB-linked SF job references an `externalRequestId` that wasn't in the Phase 1 pull (LB lead deleted, archived, or not in scope). Don't push — target may be wrong. |
| `sf_status_not_mappable` | SF job has a status not in LB's accepted map (e.g., `scheduled`, `draft`, custom). LB would 422; skip. |
| `lb_hard_terminal` | LB canonical is `archived` (LB-side `HARD_TERMINAL`). No source can override. |
| `pipeline_regression` | Push would move LB backwards in the pipeline (e.g., LB at `completed`, SF at `in-progress`). Refused. |
| `previous_attempt_in_dlq` | A prior reconcile already produced a DLQ row for this `(job, canonical)`. Operator must resolve before another attempt. |
| `outbound_already_queued_or_sent` | Idempotency hit — same `(job, canonical)` already in the outbox (any non-`dlq` state). Treated as `noop`. |

### Idempotency

Reconcile uses a **deterministic `event_id`**: `evt_reconcile_<sf_job_id>_<canonical>` (e.g., `evt_reconcile_142288_cancelled`). Two consequences:
1. Repeated reconcile for the same (job, status) collides on the outbox `UNIQUE(event_id)` and is treated as `duplicate` by `insertOutboxRow`. The summary counts it as `already_in_sync`.
2. If the SF status changes after the first reconcile (e.g., `pending → cancelled`), a fresh deterministic id is generated for the new canonical → reconcile pushes once per terminal-state change.

Status-change-triggered events (the `/api/jobs/:id/cancel` path, etc.) continue to use `evt_<uuidv7()>` — fresh per write. Only reconcile-sourced events use the deterministic key.

### What reconcile does NOT do

- Does **not** create or modify SF jobs. Read-only on the jobs table.
- Does **not** backfill `jobs.lb_external_request_id` on unlinked jobs (that's the explicit `scripts/backfill-jobs-lb-linkage.js`).
- Does **not** call LB's HTTP API directly — everything flows through the existing outbox/drainer.
- Does **not** clear the DLQ or replay events.
- Does **not** modify LB lead status mappings.
- Does **not** force a status push when LB has already moved to a terminal that the SF transition would overwrite.

### Structured logs (Loki)

```
[LB Reconcile] phase=pull lb_leads=<N> user=<U> dryRun=<bool>
[LB Reconcile] phase=pull_index lb_leads_indexed=<N> user=<U>
[LB Reconcile] result=queued reason=lifecycle_drift job=<id> sf=<status>(<canonical>) lb=<canonical> event_id=evt_reconcile_<id>_<canonical>
[LB Reconcile] result=noop reason=<reason> job=<id> sf=<canonical> lb=<canonical>
[LB Reconcile] result=skipped reason=<reason> job=<id> sf=<status> lb=<canonical|null>
[LB Reconcile] result=planned reason=lifecycle_drift job=<id> sf=<status>(<canonical>) lb=<canonical> dryRun=true
[LB Reconcile] phase=status_push user=<U> evaluated=<N> queued=<N> in_sync=<N> drift=<N> no_lb_lead=<N> hard_terminal=<N> regression=<N> unsupported=<N> prev_dlq=<N> failures=<N> dryRun=<bool>
```

## Rollout sequence

Per the system requirements, status outbound is NOT enabled by this contract. The sequence is:

1. ✅ Implement linkage invariant + write-path propagation (this PR).
2. ✅ Deploy dark/passive with logs only — `LEADBRIDGE_OUTBOUND_DRY_RUN` stays `true` in prod (or the env-default).
3. Smoke test: create a job for an LB-linked customer in SF UI → verify `jobs.lb_external_request_id` is populated and the `[LBLinkage]` log fires with `result=linked`.
4. Run the historical dry-run (`scripts/backfill-jobs-lb-linkage.js --user 2`).
5. Apply HIGH-confidence historical backfill (operator-gated).
6. Run one controlled outbound status dry-run.
7. Only then consider flipping the outbound flag for production status sync.

## What this contract does NOT do

- Does not enable `SF_STATUS_WINS` on LB.
- Does not replay status events.
- Does not auto-link ambiguous leads — always returns `review_required`.
- Does not merge customers, leads, or identities.
- Does not modify the SF↔LB status map.
- Does not modify the outbound DLQ.

## CI / merge gate

The writer-funnel test scans the codebase to assert every `from('jobs').insert(...)` site either (a) lives inside an allowlisted file or (b) sits within ~50 lines of a `resolveLbLinkage(` or `linkageFromParentJob(` call. New code that inserts into `jobs` without going through the resolver fails the test.
