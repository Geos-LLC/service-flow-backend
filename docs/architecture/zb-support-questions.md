# Zenbooker Support — Pre-Implementation API Behavior Questions

**Purpose:** Send to Zenbooker support / developer relations to resolve hard-stop questions before SF→ZB outbound implementation begins.
**Recipient:** Zenbooker support (`support@zenbooker.com` or the partner-engineering contact, whichever is faster).
**Owner:** Backend lead.
**Format:** The body below is intended to be copy-pasted into a support email or ticket verbatim. Internal context (this paragraph and the next) does not go in the email.

**Internal context (do NOT include in email):**

These questions resolve preconditions PC1 / PC2 (and partially PC3 for endpoint discovery) listed in [zb-outbound-command-confirmation.md §18](./zb-outbound-command-confirmation.md). Until a written answer arrives for at least Q1, Q2-A, Q2-B, and Q3, the outbound implementation remains blocked. Answers should be saved into [zb-api-verification.md](./zb-api-verification.md) as they arrive (one PR per question is fine — partial answers unlock partial scope).

---

## Email body (copy-paste below this line)

**Subject:** ServiceFlow integration — API behavior questions (idempotency, webhook semantics, endpoint discovery)

Hello Zenbooker team,

ServiceFlow is a CRM and payroll product used by Zenbooker customers (cleaning businesses). Our existing integration synchronizes Zenbooker → ServiceFlow via webhooks and has been live since March 2026. We are now scoping a small, controlled outbound flow (ServiceFlow → Zenbooker) covering only: **create job, reschedule, cancel, provider assignment, customer create/update.**

Before we build, we need confirmation on a few behaviors that we cannot infer from the public reference. Short answers per item are fine; we do not need example payloads unless the behavior is non-obvious. Where the answer is "currently unsupported," that is itself a useful answer and we will design accordingly.

---

### 1. `Idempotency-Key` header support

Does the Zenbooker API accept and honor an `Idempotency-Key` request header on these endpoints?

- `POST /v1/jobs`
- `POST /v1/jobs/{id}/reschedule`
- `POST /v1/jobs/{id}/cancel`
- (the provider-assignment endpoint — see question 4)
- `POST /v1/customers`
- `PATCH /v1/customers/{id}`

If **yes**, please confirm:
- a) Exact header name (`Idempotency-Key`? Something else?)
- b) Scope — per-endpoint, per-tenant, or per-API-key?
- c) Retention window — for how long does the API remember a key?
- d) Behavior on replay with a **different** body — `409 Conflict`? Same response as the original? Overwrite?

If **no**, we will design assuming every retry is a separate operation and implement client-side dedup. Please confirm that is the correct posture.

---

### 2. Webhook events per mutation

For each of these API calls, please confirm which webhook event types fire, in what order, and whether more than one event is emitted for a single mutation:

| API call | Which event(s) fire? |
|---|---|
| `POST /v1/jobs` | `job.created` only — or also `job.service_order.edited`? |
| `POST /v1/jobs/{id}/reschedule` | `job.rescheduled` only — or also `job.service_order.edited`? |
| `POST /v1/jobs/{id}/cancel` | `job.canceled` only — or also `job.service_order.edited`? |
| Provider-assignment endpoint (see Q4) | `job.service_providers.assigned` only — or also `job.service_order.edited`? |
| `POST /v1/customers` | `customer.created`? `customer.edited`? Neither — synchronous-response only? |
| `PATCH /v1/customers/{id}` | `customer.edited` only? |

Specifically: if both a dedicated event AND a generic `*.edited` event fire on the same mutation, please say so — we will dedup on our side.

---

### 3. Webhook delivery metadata

Does every webhook delivery include a stable identifier that we can use for deduplication, **separate from the resource id**?

We currently dedup on `data.id` / `data.job_id` (the resource id in the payload). That key collides when the same job is mutated twice (e.g., reschedule, then reschedule again — both webhooks have the same `data.id`). We would like an event-level dedup key.

Please confirm presence (and field name / location) of:
- a) A stable **event id** or **delivery id** — header or body field?
- b) A **timestamp** on every delivery — header or body field?
- c) A **replay marker** that indicates "this is a retry of a previous delivery" (vs a fresh event)?

If none of these are present today, please confirm — we will rely on resource-id + intent-hash + timestamp window as a fallback.

---

### 4. Provider-assignment endpoint

We can locate `POST /v1/jobs/{id}/reschedule` and `POST /v1/jobs/{id}/cancel` in the public reference, but we cannot find a documented endpoint for changing `assigned_providers[]` on an existing job. Could you confirm:

- a) Endpoint URL and HTTP method
- b) Request body shape (we'd expect something like `{ "assigned_providers": ["prov_xxx"], "assignment_method": "auto" }` but want to confirm)
- c) Response shape
- d) Which webhook event fires (assumed `job.service_providers.assigned` — please confirm)

This is the single biggest blocker for our outbound work — if the endpoint is undocumented because it does not exist, please tell us; we will defer this command type.

---

### 5. Webhook delivery expectations (SLA)

- a) Retry policy on a `5xx` from our side — at-least-once? at-most-once? max attempts before drop?
- b) Expected delivery latency from mutation to first webhook attempt — P50 / P95?
- c) Ordering guarantee — if a job is rescheduled then cancelled within seconds, will the two webhooks arrive in that order?
- d) Are duplicate deliveries expected during retry, or strictly during ZB-side network anomalies?

---

### 6. Rate limits

- a) Per-tenant rate limit (requests per second or per minute)?
- b) Burst allowance?
- c) Is a `Retry-After` header returned on `429`?
- d) Do rate limits apply per-endpoint or globally per-API-key?

---

### 7. Edge cases (lower priority — can be answered later)

- a) `POST /v1/jobs/{id}/cancel` on an already-cancelled job — what status code do you return?
- b) `POST /v1/jobs` with a `customer_id` that no longer exists — what status code?
- c) When a provider is soft-deleted in Zenbooker, what happens to their open `assigned_providers[]` references on existing scheduled jobs? Are they auto-removed, left in place with a marker, or do future mutations 422?

---

Thank you in advance. Happy to clarify anything or hop on a short call if that's faster. If only some questions are answerable today, partial answers unblock partial scope on our side — please don't hold the whole reply for a complete one.

Best,
[OPERATOR NAME] — ServiceFlow

---

## End of email body

## Tracking

| Question | Sent | Answered | Resolves precondition |
|---|---|---|---|
| Q1 (Idempotency-Key) | Pending | Pending | PC1 |
| Q2 (events per mutation) | Pending | Pending | PC2 (Q2-A) |
| Q3 (webhook delivery metadata) | Pending | Pending | PC2 (Q2-B) |
| Q4 (provider-assignment endpoint) | Pending | Pending | PC2 (endpoint discovery) — see also the discovery runbook |
| Q5 (delivery SLA) | Pending | Pending | PC2 (Q2-C) |
| Q6 (rate limits) | Pending | Pending | Drainer batch sizing |
| Q7 (edge cases) | Pending | Pending | Pre-flight handling |

When answers arrive, update [zb-api-verification.md](./zb-api-verification.md) §1, §2, §3.4, and §7 with the verbatim ZB response and the date. Then amend [zb-outbound-command-confirmation.md §18](./zb-outbound-command-confirmation.md) to move the affected preconditions from "Pending" to "Resolved."
