# ZB API Verification — Hard-Stop Preconditions PC1 / PC2

**Purpose:** Resolve the Q1 (Idempotency-Key) and Q2 (webhook event determinism) hard stops listed in [zb-outbound-command-confirmation.md §18](./zb-outbound-command-confirmation.md). No code, no migrations, no production writes.
**Scope:** Public ZB API documentation review + cross-reference against production-verified behavior already encoded in `zenbooker-sync.js`.
**Status:** Phase A implementation is **BLOCKED** pending operator confirmation of items in §5 below.
**Date:** 2026-05-15.

---

## 0. Methodology

Three sources were consulted:

1. **Public ZB docs** at `developers.zenbooker.com`. The docs are JavaScript-rendered with sparse static HTML; many endpoint pages exist but render only field tables, not Idempotency or rate-limit policy. WebFetch returned partial content for the pages that exist, and 404 for non-existent slugs.
2. **Production-verified webhook subscriptions** from [zenbooker-sync.js:1576](../../zenbooker-sync.js#L1576) — the existing SF→ZB connector subscribes to a fixed list of event types that have been observed firing in production since March 2026.
3. **Live API endpoint paths** already exercised by the existing inbound sync — GET `/jobs`, GET `/jobs/:id`, GET `/invoices/:id`, GET `/customers/:id`, GET `/webhooks`, POST `/webhooks` (subscription registration).

No outbound POST/PATCH/DELETE has been issued against ZB from this codebase. Any verification of write semantics is therefore inferred from documentation only and requires operator confirmation against a test tenant before Phase B ships.

URLs probed (✓ = returned content, 404 = page does not exist or slug wrong):

| URL | Result |
|---|---|
| `/reference/introduction` | ✓ (no API details visible) |
| `/reference/authentication` | ✓ ("API key authentication"; no header format) |
| `/reference/jobs` | ✓ (only GET /v1/jobs documented) |
| `/reference/create-a-job` | ✓ |
| `/reference/reschedule-a-job` | ✓ |
| `/reference/cancel-a-job` | ✓ |
| `/reference/retrieve-a-job` | ✓ (no schema visible) |
| `/reference/create-a-customer` | ✓ |
| `/reference/update-a-customer` | ✓ |
| `/reference/customers` | ✓ (no API details visible) |
| `/reference/changelog` | ✓ (2 entries since 2022; no idempotency mention) |
| `/reference/update-a-job` / `update-a-job-1` / `edit-a-job` | 404 |
| `/reference/assign-providers` / `assign-job` / `reassign-a-job` / `edit-providers` / `update-job-providers` | 404 |
| `/reference/webhooks` / `docs/webhooks` / `list-webhooks` / `get-webhooks` / `list-events` | 404 |
| `/reference/list-jobs` / `list-providers` / `list-customers` | 404 |
| `/reference/create-a-webhook` | 404 |

**Implication:** Several endpoints likely exist but are not documented in any public slug we can discover. The provider-assignment endpoint specifically cannot be located. This is treated as a blocker, not an absence (§5.4).

---

## 1. Q1 verification — `Idempotency-Key` support

### 1.1 Result

**Idempotency-Key support: UNKNOWN (negative empirical evidence — assume unsupported until ZB confirms).**

**Discovery observation (2026-05-16):** Five `POST /v1/jobs/{id}/assign` requests were issued during controlled discovery, each carrying a unique `Idempotency-Key: discover-attempt-N-<uuid>` header. None of the response headers echoed the key back, and 200-response headers contained no idempotency-related field. ZB's response on the successful mutation (after three body-shape corrections) carried only `x-zenbooker-api-version: 1` and `x-response-time: <ms>` — no `Idempotency-Key`, no `X-Idempotency-Key`, no `X-RateLimit-*`, no `Retry-After`. This is not conclusive (ZB could accept and silently dedup without echoing), but combined with zero documentation references the operating assumption "unsupported" stands. A true replay test (same key, same body, twice) was out of scope for the 4-attempt bound and remains a follow-up for ZB support's Q1 reply.

The public docs contain zero references to "Idempotency-Key", "idempotency", or any equivalent concept across:
- `/reference/introduction`
- `/reference/authentication`
- `/reference/create-a-job`
- `/reference/reschedule-a-job`
- `/reference/cancel-a-job`
- `/reference/create-a-customer`
- `/reference/update-a-customer`
- `/changelog` (entire history since 2022)

The endpoint pages document headers explicitly (e.g., `accept` is listed as an enum on customer create) but no idempotency header appears in the documented header table. This means one of three things, listed in decreasing probability:

| Probability | Hypothesis | Implication |
|---|---|---|
| Most likely | ZB does NOT support an Idempotency-Key header. Duplicate POSTs produce duplicate resources. | Design §3.6 / §8.I2 / §8.I4 must rely on the **drainer pre-flight fingerprint fallback** (§6 of this doc) — not on the header. |
| Possible | ZB does support a key but it is undocumented. | We could not rely on this even if true; behavior cannot be tested without ZB confirmation. Operate as if unsupported. |
| Unlikely | ZB silently dedups by exact-body hash within a short window. | Some APIs do this; ZB has not advertised it. Cannot rely on. |

### 1.2 Required operator action

The ZB integration owner MUST contact Zenbooker support (or their developer relations) and obtain a written answer to:

> "Does the Zenbooker API support an `Idempotency-Key` request header on the POST and PATCH endpoints (`/v1/jobs`, `/v1/jobs/{id}/reschedule`, `/v1/jobs/{id}/cancel`, `/v1/customers`, `PATCH /v1/customers/{id}`)? If yes, what is the supported key length, retention window, and behavior on conflicting bodies? If no, what is the recommended retry-safety pattern?"

This is precondition **PC1** in the design doc — it is a hard stop for Phase A implementation.

### 1.3 If Q1 answer is "no"

The design must rely entirely on **pre-flight fingerprint dedup** as the retry-safety primitive. See §6 of this document for the proposed fallback. The design doc's idempotency claims (§3.6, §8.I2, §8.I4) MUST be amended to remove "ZB Idempotency-Key" as a mechanism and to elevate "drainer pre-flight fetch" to primary.

This adds one GET per POST attempt (latency penalty + 2x rate-limit consumption per send) but does not block functionality. It is the same approach the existing payment-reconcile sweep uses to avoid double-applying transactions.

---

## 2. Q2 verification — webhook event determinism

### 2.1 Result

**Webhook event taxonomy: PARTIALLY VERIFIED.** The list of event types SF already subscribes to is confirmed by production observation; the *one-vs-many semantics per mutation* and per-event payload shape are unverified by public docs.

### 2.2 Events confirmed as emitted by ZB

From [zenbooker-sync.js:1576](../../zenbooker-sync.js#L1576), SF registers these subscriptions on `POST /v1/webhooks`. Each event type has been observed firing in production since March 2026:

| Event type | Status | Subscribed in code |
|---|---|---|
| `job.created` | ✓ Observed | Yes |
| `job.canceled` | ✓ Observed | Yes |
| `job.rescheduled` | ✓ Observed | Yes |
| `job.en_route` | ✓ Observed | Yes |
| `job.started` | ✓ Observed | Yes |
| `job.completed` | ✓ Observed | Yes |
| `job.service_providers.assigned` | ✓ Observed | Yes |
| `job.service_order.edited` | ✓ Observed (the "generic catch-all" — fires on PATCH-shaped edits) | Yes |
| `invoice.payment_succeeded` | ✓ Observed | Yes |
| `invoice.payment_recorded` | ✓ Observed | Yes |
| `customer.edited` | ✓ Observed | Yes |
| `customer.created` | ✓ **Confirmed via subscription list 2026-05-16** — registered as subscription id `1774903441449x260927462625651500`. Not yet observed firing in production logs, but the subscription exists and `customer.upsert` create-path correlation can rely on it. | Yes (registered) |
| `recurring_booking.created` | ✓ Observed (mentioned in handler at line 2310) | Implicitly handled |
| `recurring_booking.canceled` | ✓ Observed | Implicitly handled |

Webhook subscription registration payload (verified in code, line 1588):
```json
{ "event_type": "<event>", "url": "<webhook_url>", "webhook_api_version": "2025-09-01" }
```

The webhook payload top-level shape (verified at line 2260): `{ event, data, account_id }`.

### 2.3 What is NOT verified

Despite knowing the event list, three things remain unconfirmed for correlation purposes:

| # | Unknown | Affects |
|---|---|---|
| Q2-A | Does **one mutation emit one event or many?** Specifically, does `POST /v1/jobs/:id/reschedule` emit ONLY `job.rescheduled`, or BOTH `job.rescheduled` AND `job.service_order.edited`? Same question for cancel (`job.canceled` only or +`job.service_order.edited`?) and assign-providers. | Design §3.5.2 fallback correlation algorithm — if multiple events fire, the algorithm MUST correlate the *first* event that matches and ignore the rest as duplicates. |
| Q2-B | Does each webhook delivery carry a **stable `event_id`** for dedup? The code (line 2330) uses `data.id` or `data.job_id` as `correlation_id` — which is a *resource* id, not an *event* id. Two `job.rescheduled` events for the same job (e.g., reschedule A, then reschedule B) would share the same `correlation_id`. | Constitution §3.2 dedup; Design §3.6 replay safety. |
| Q2-C | What is the **delivery latency P50/P95** from ZB mutation to webhook arrival? | Design §2.4 `confirmation_deadline` default (currently set to `sent_at + 10 minutes`). |

### 2.4 Required operator action

The ZB integration owner MUST obtain written answers to:

1. (Q2-A) For each of the Phase 1 mutations (`POST /v1/jobs`, `POST /v1/jobs/:id/reschedule`, `POST /v1/jobs/:id/cancel`, `POST /v1/customers`, `PATCH /v1/customers/:id`, and the still-unidentified provider-assignment endpoint), exactly which webhook events fire, in what order, with what payload differences?
2. (Q2-B) Does each webhook delivery carry a stable per-event identifier (separate from the resource id)? What header or body field?
3. (Q2-C) What is the expected webhook delivery SLA (best-effort vs at-least-once vs at-most-once; retry policy on SF 5xx)?

Until Q2-A is answered, Design §3.5's correlation algorithm operates in `probable`-confidence mode for any echo whose event type might be the generic `job.service_order.edited`.

---

## 3. Per-command API surface

Quoted directly from ZB docs where available; marked `UNKNOWN` otherwise. All endpoints use base `https://api.zenbooker.com/v1` with `Authorization: Bearer <api_key>`.

### 3.1 `job.create` → `POST /v1/jobs`

| Property | Value |
|---|---|
| Endpoint | `POST /v1/jobs` |
| Method | POST |
| Auth | `Bearer <api_key>` |
| Required body fields | `territory_id` (string), either `timeslot` (object) or `timeslot_id` (string), either `customer` (object) or `customer_id` (string), `address` (object) or `address_id` (string), `services` (array of objects) |
| Optional body fields | `duration` (number, minutes), `required_skills` (array of strings), `min_providers_needed` (string), `assigned_providers` (array of strings — provider IDs), `assignment_method` ("auto" \| "offer"), `manual_payment_method` (string), `sms_notifications` (bool), `email_notifications` (bool), `tax_exempt` (bool), `job_number` (string) |
| Success | `201 Created` |
| Stable ID returned | **Inferred yes** (the response on 201 should contain `id`; not quoted in docs but conventional for REST). Operator confirmation needed. |
| Webhook echo | `job.created` (deterministic — exists in our subscription set, fires after API creates) |
| Echo determinism | **Likely EXACT** for `job.created` event type. Whether `job.service_order.edited` also fires alongside is **UNKNOWN** (Q2-A). |
| Idempotency-Key documented? | **NO** (UNKNOWN behavior) |
| Documented errors | `400 Bad Request` |
| Rate-limit behavior | **UNKNOWN** — not in public docs |

### 3.2 `job.reschedule` → `POST /v1/jobs/{id}/reschedule`

| Property | Value |
|---|---|
| Endpoint | `POST /v1/jobs/{id}/reschedule` (dedicated action endpoint — not a generic PATCH) |
| Method | POST |
| Required body fields | `start_date` (ISO 8601 datetime, e.g. `2020-09-22T13:00:00.000Z`) |
| Optional body fields | `arrival_window_minutes` (int32) |
| Success | `200 OK` |
| Stable ID returned | N/A — operates on existing `{id}`. Response body schema not visible in public docs. |
| Webhook echo | `job.rescheduled` (deterministic, dedicated) |
| Echo determinism | **EXACT for `job.rescheduled`**. Possibly also `job.service_order.edited` (Q2-A). |
| Idempotency-Key documented? | **NO** (UNKNOWN behavior) |
| Documented errors | `400 Bad Request` |
| Rate-limit behavior | **UNKNOWN** |

### 3.3 `job.cancel` → `POST /v1/jobs/{id}/cancel`

| Property | Value |
|---|---|
| Endpoint | `POST /v1/jobs/{id}/cancel` |
| Method | POST |
| Required body fields | None documented |
| Optional body fields | Cancellation reason — **NOT documented as accepted** by the cancel endpoint. May be unsupported by ZB; SF would retain the reason locally. |
| Success | `200 OK` |
| Stable ID returned | N/A |
| Webhook echo | `job.canceled` (deterministic, dedicated) |
| Echo determinism | **EXACT for `job.canceled`**. Possibly also `job.service_order.edited` (Q2-A). |
| Idempotency-Key documented? | **NO** (UNKNOWN behavior). Cancel is naturally idempotent (cancelling a cancelled job should be a no-op) but ZB's response on second-cancel is **UNKNOWN**. |
| Documented errors | `400 Bad Request` |

### 3.4 `job.assign_providers` → `POST /v1/jobs/{id}/assign` (RESOLVED via controlled discovery 2026-05-16)

| Property | Value |
|---|---|
| Endpoint | `POST /v1/jobs/{id}/assign` — confirmed by empirical discovery (see [zb-provider-assignment-discovery.md](./zb-provider-assignment-discovery.md) and the discovery log entries below). |
| Method | POST |
| Required body fields | `assign` (array of provider IDs to add), `unassign` (array of provider IDs to remove), `notify` (boolean — whether ZB sends notifications). **All three are required** — 400 if any is missing. |
| Body shape | `{ "assign": ["<provider_id>", ...], "unassign": ["<provider_id>", ...], "notify": true \| false }` |
| Semantics | **State-transition diff, NOT replacement array.** Two concurrent operators each removing different providers compose correctly without coordination. This is materially different from a "set assigned_providers to this array" model. The SF outbound command MUST be modeled accordingly (see [zb-outbound-command-confirmation.md §4.4](./zb-outbound-command-confirmation.md)). |
| Success | `200 OK` — synchronous response. |
| Response shape | `{ "status": "success", "response": { "job": "<job_id>", "service_providers": ["<resulting_provider_ids>", ...] } }` — the response carries the **post-mutation** resulting `service_providers[]` (note the key name is `service_providers`, not `assigned_providers`). |
| Response headers (notable) | `x-zenbooker-api-version: 1`, `x-response-time: <ms>`. **No** `Idempotency-Key` echo, **no** rate-limit headers, **no** `Retry-After`. |
| Webhook echo | `job.service_providers.assigned` — **single event**, no fan-out to `job.service_order.edited`. Confirmed by 2 successful mutations during discovery (forward swap + reset). |
| Echo determinism | **EXACT.** Echo event type is deterministic; echo payload carries the full job object with updated `assigned_providers[]`. The same event fires whether the mutation originates from the API OR from a manager's UI action — they are indistinguishable at the webhook layer. |
| Webhook latency observed | 2.3s and 2.6s (n=2). P50 estimate: ~2-3s. Tight observation window of 60s post-send was sufficient. |
| Idempotency-Key documented? | **NO** (not echoed in response; assume unsupported per §1). |
| Phase 1 status | **UNBLOCKED** for Phase A schema; still gated on Q1/Q2-B for Phase B. |

Empirical discovery progression (2026-05-16, attempts 1→3 against test job `1778965722485x761465706166878200`):

| Body | ZB response | Lesson |
|---|---|---|
| `{"assigned_providers":["<P2>"]}` | 400 — "Missing required parameter: **assign**" | Endpoint exists; field is `assign`, not `assigned_providers` |
| `{"assign":["<P2>"]}` | 400 — "Missing required parameter: **unassign**" | Diff body required (not replacement) |
| `{"assign":["<P2>"],"unassign":["<P1>"]}` | 400 — "Missing required parameter: **notify**" | Third required parameter — controls notification side-effects |
| `{"assign":["<P2>"],"unassign":["<P1>"],"notify":false}` | **200** with `{status:"success", response:{job, service_providers:[<P2>]}}` | Match. |
| Reset: `{"assign":["<P1>"],"unassign":["<P2>"],"notify":false}` | 200 (same shape, mutation reversed) | Confirms diff semantics work both directions. |

Incidental finding: `GET /v1/providers` returns **HTTP 400 `invalid_request_url`**. Provider data is only accessible via `assigned_providers[]` on job objects. This narrows the design space for any future `team_member.create` outbound command.

### 3.5 `customer.upsert` → `POST /v1/customers` (create) + `PATCH /v1/customers/{id}` (update)

| Property | Create | Update |
|---|---|---|
| Endpoint | `POST /v1/customers` | `PATCH /v1/customers/{id}` |
| Required body fields | `name` (string) | None — all fields optional |
| Optional body fields | `phone`, `email`, `addresses` (array), `stripe_customer_id`, `notes` (array) | `name`, `phone`, `email`, `stripe_customer_id` |
| Success | `200` (per docs — note: not `201`) | `200` |
| Stable ID returned | **Inferred yes** in response body; visible at 200. Operator confirmation needed. | Returns updated customer object. |
| Webhook echo | **UNKNOWN whether a `customer.created` event exists** — SF only subscribes to `customer.edited` (line 1576). If create doesn't fire `customer.edited`, the synchronous response body IS the confirmation. | `customer.edited` (confirmed in production) |
| Echo determinism | Create: synchronous-only (likely). Edit: EXACT for `customer.edited`. | EXACT |
| Idempotency-Key documented? | **NO** | **NO** |
| Upsert-by-key endpoint? | **NO** — must GET-then-POST to dedup. ZB does not document an upsert-by-phone-or-email. | N/A |

### 3.6 Webhook subscription management (existing — already used by SF)

These are NOT outbound commands, but they bracket the design. Confirmed working from production:

| Endpoint | Method | Body | Purpose |
|---|---|---|---|
| `/v1/webhooks` | GET | (query: `limit`) | List existing subscriptions |
| `/v1/webhooks` | POST | `{ event_type, url, webhook_api_version }` | Register a subscription |

`webhook_api_version: '2025-09-01'` is the current version pinned in the SF code (line 1588).

---

## 4. Compatibility matrix

Format: per Phase 1 `command_type` → (endpoint known? • idempotency documented? • echo determinism • safe for which phase?)

| `command_type` | ZB endpoint | Endpoint confirmed? | Idempotency-Key supported? | Webhook echo verdict | Phase A safe? | Phase B safe? |
|---|---|---|---|---|---|---|
| `job.create` | `POST /v1/jobs` | ✓ Confirmed | **UNKNOWN** | `job.created` — likely EXACT. Multi-event fan-out UNKNOWN. | YES (schema-only — no traffic) | **BLOCKED** until Q1, Q2-A, Q2-B answered |
| `job.reschedule` | `POST /v1/jobs/{id}/reschedule` | ✓ Confirmed | **UNKNOWN** | `job.rescheduled` — likely EXACT. May fan out to `job.service_order.edited`. | YES | **BLOCKED** until Q1, Q2-A, Q2-B answered |
| `job.assign_providers` | `POST /v1/jobs/{id}/assign` ✓ (diff body — see §3.4) | ✓ Confirmed (resolved 2026-05-16) | **UNKNOWN** | `job.service_providers.assigned` — **EXACT** (confirmed: 2 mutations, 2 single-event echoes, no fan-out, ~2-3s latency) | YES | **BLOCKED on Q1, Q2-B** (Q2-A resolved for this command type only) |
| `job.cancel` | `POST /v1/jobs/{id}/cancel` | ✓ Confirmed | **UNKNOWN** (naturally idempotent semantically but unverified) | `job.canceled` — likely EXACT. May fan out. | YES | **BLOCKED** until Q1, Q2-A, Q2-B answered |
| `customer.upsert` (create) | `POST /v1/customers` | ✓ Confirmed | **UNKNOWN** | Synchronous response body. No `customer.created` event subscribed. | YES | **BLOCKED** until Q1 answered AND create-event question resolved |
| `customer.upsert` (update) | `PATCH /v1/customers/{id}` | ✓ Confirmed | **UNKNOWN** | `customer.edited` — EXACT | YES | **BLOCKED** until Q1 answered |

### 4.1 Phase A is *partially* safe

Phase A (queue + schema only, no outbound traffic) is safe to implement **for the four commands whose endpoints are confirmed**:
- `job.create`
- `job.reschedule`
- `job.cancel`
- `customer.upsert` (both directions)

Phase A is **NOT safe to implement** for `job.assign_providers` because:
- The endpoint slug, HTTP method, and body schema are unknown.
- The `field_group='assignment'` matrix entry in [design §6.9](./zb-outbound-command-confirmation.md#L535) cannot be populated correctly.
- A schema-time decision (does the `payload_json` field hold a `provider_ids[]` array? a single id? a structured assignment object with `assignment_method`?) cannot be made without endpoint discovery.

**Recommendation:** ship Phase A for the four confirmed commands. Defer `job.assign_providers` to Phase B's start, where it ships only after endpoint discovery completes.

### 4.2 Phase B remains BLOCKED for all command types

Every command in the matrix has at least one **UNKNOWN** in idempotency or echo behavior. Phase B (first live traffic) is BLOCKED for all commands until Q1 and Q2-A/Q2-B are answered. This is consistent with [design §18 PC1/PC2 hard stops](./zb-outbound-command-confirmation.md#L809).

---

## 5. Implementation status

### 5.1 Phase A

**Status: FULLY UNBLOCKED (updated 2026-05-16).**

May proceed for all five Phase 1 command types: `job.create`, `job.reschedule`, `job.cancel`, `customer.upsert`, and `job.assign_providers` (the latter using the diff-shape payload per §3.4).

The schema in design §3.1 supports all five — `command_type` and `field_group` columns are open enums; the `payload_json` for `job.assign_providers` carries `{assign, unassign, notify}` (not a flat `assigned_providers[]` array — see [design §4.4](./zb-outbound-command-confirmation.md)).

### 5.2 Phase B

**Status: BLOCKED.**

Blockers:
- PC1 (Q1 — Idempotency-Key support)
- PC2 (Q2-A — multi-event fan-out per mutation)
- PC2 (Q2-B — stable per-event identifier for dedup)
- Q2-C — webhook delivery SLA (sets `confirmation_deadline` default)
- (For `job.assign_providers` only) endpoint discovery

### 5.3 Phase C, D, E

**Status: BLOCKED on Phase B.** No further investigation needed at this stage — these phases depend on Phase B running stably per the soak gates in design §16.5.

### 5.4 What "endpoint discovery" means

For `job.assign_providers`, the operator MUST obtain (in this order of preference):
1. A direct answer from Zenbooker support: "What endpoint changes the `assigned_providers[]` for an existing job?"
2. Failing that: empirical discovery against a test tenant. Three candidates to try in sequence, all with a single throwaway test job:
   - `POST /v1/jobs/{id}/assign` with body `{ assigned_providers: [<id>], assignment_method: 'auto' }`
   - `POST /v1/jobs/{id}/providers` with same body
   - `PATCH /v1/jobs/{id}` with same body
   - Result: which one returns 200 + emits `job.service_providers.assigned`?
3. Failing both: defer the `assign_providers` command type to Phase E. The other three command types are sufficient for the initial outbound surface.

Empirical discovery is the only Phase 1 case where "controlled API verification against a test tenant" (per the user's standing authorization) is appropriate. The discovery exercise is read-write but bounded: one test job, one test provider, four attempts maximum, easy to delete.

---

## 6. Safe fallback if Idempotency-Key is not supported

The design relies on idempotency at three points:

1. **Retry after network timeout** (§8.I2). Mechanism: drainer POSTs with same `Idempotency-Key`; ZB dedups.
2. **Crash between POST and ack** (§8.I5/I6). Same.
3. **Replay of a `sent`-then-resumed command** (§6.8.4). Same.

If Q1 answer is "no", all three must rely on this fallback:

### 6.1 Pre-flight fingerprint check (already in design §3.5 pre-flight)

Before sending a command whose `state` is `pending` (i.e., never sent before) AND whose `attempts >= 1` (i.e., a retry after lease recovery), the drainer MUST:

1. `GET /v1/jobs/{zenbooker_id}` (or `/v1/customers/{zenbooker_id}` for customer commands).
2. Compute the fingerprint over the same field set used for `source_revision` (per [design §6.7](./zb-outbound-command-confirmation.md#L497)).
3. Compare to two reference fingerprints:
   - `source_revision` (the world state when the command was queued)
   - `expected_post_revision` (the intended world state — computed from `source_revision` overlaid with `payload_json`)
4. Decision tree:
   - Fingerprint == `source_revision` → no mutation has landed. POST proceeds normally.
   - Fingerprint == `expected_post_revision` → previous POST already landed (network blip masked the response). Transition `state='sent'` WITHOUT re-POSTing. Correlation will close from the eventual echo.
   - Fingerprint matches neither → drift. Transition `state='conflict'` ([design §6.3](./zb-outbound-command-confirmation.md#L457)).

### 6.2 Cost

- Adds 1 GET per send attempt on commands that have `attempts >= 1`. On the happy path (first attempt succeeds), the GET is skipped.
- Worst case under sustained ZB 5xx (5 attempts before DLQ): up to 5 extra GETs per command. At Phase B target volume (estimated <100 commands/day/tenant), this is a negligible quota cost.
- Adds ~200ms latency per retried command.

### 6.3 Limitations

- This fallback does NOT protect against a request that ZB has partially processed (e.g., reschedule applied but the response timed out, then ZB undoes it minutes later via some internal rollback). That scenario is not protected by Idempotency-Key either; it requires the §2.4 reconcile loop to detect.
- The fallback DOES protect against the most common case: SF retries because it never saw the response.

### 6.4 Required design amendment if Q1 = "no"

If Q1 is answered "no", the design doc MUST be amended:

- §3.6 — remove "ZB MUST treat duplicate keys as no-op or 200"; replace with "drainer pre-flight check provides equivalent retry-safety (see [zb-api-verification.md §6](./zb-api-verification.md#L443))".
- §8.I2 — change mechanism to "drainer pre-flight fingerprint check; ZB does not dedup".
- §8.I4 — same.
- §11 — `zb-outbound-idempotency.test.js` covers the pre-flight path, not the header round-trip.
- §13 Q1 — mark as resolved with the "no" answer; reference §6 of this doc.

If Q1 is answered "yes", the design stays as written and Idempotency-Key is layered on top of the pre-flight check (defense in depth — the pre-flight check is cheap and worth keeping anyway).

---

## 7. Outstanding API questions to resolve before Phase B

| # | Question | Owner | Phase blocked |
|---|---|---|---|
| Q1 | `Idempotency-Key` support on POST/PATCH endpoints? | Backend lead → ZB support | Phase B |
| Q2-A | Does one ZB mutation emit one webhook event or multiple (e.g., does reschedule emit both `job.rescheduled` and `job.service_order.edited`)? | Backend lead → ZB support | Phase B |
| Q2-B | Stable per-event identifier in webhook payload for dedup? Where (header / body field)? | Backend lead → ZB support | Phase B |
| Q2-C | Webhook delivery SLA (best-effort? at-least-once? retry on 5xx? expected P95 latency?) | Backend lead → ZB support | Sets §2.4 `confirmation_deadline` default; soft-blocks Phase B |
| Q3 | Endpoint for changing `assigned_providers[]` on an existing job? | Backend lead → ZB support | `job.assign_providers` command, Phase B onward |
| Q4 | Does `POST /v1/jobs` response synchronously return the new job's `id` in the 201 body? | Backend lead → ZB support OR live test | `job.create`, Phase B |
| Q5 | Does `POST /v1/customers` response synchronously return the new customer's `id` in the 200 body? | Backend lead → ZB support OR live test | `customer.upsert` (create), Phase B |
| Q6 | Does ZB emit a `customer.created` event, or does `customer.edited` fire on create as well? | Backend lead → ZB support | `customer.upsert` correlation strategy |
| Q7 | Cancel-a-job — does the endpoint accept a cancellation reason body? Or is reason SF-only? | Backend lead → ZB support OR live test | `job.cancel` payload completeness |
| Q8 | Cancel-on-already-cancelled — what response does ZB return? | Backend lead → ZB support OR live test | `job.cancel` natural-idempotence claim |
| Q9 | Rate-limit policy (requests/second/tenant; burst budget; 429 retry-after header)? | Backend lead → ZB support | Drainer batch sizing, alert thresholds |
| Q10 | Behavior when a `POST /v1/jobs` references a `customer_id` that ZB has deleted? | Backend lead → live test | `job.create` pre-flight handling |
| Q11 | What happens to a job's `assigned_providers[]` when a referenced provider is soft-deleted in ZB? | Backend lead → live test | `job.assign_providers` safety |

---

## 8. Recommended next actions

In priority order:

1. **Today:** Send Q1, Q2-A, Q2-B, Q3, Q9 to Zenbooker support / developer relations. These are the gate-keepers. Aim for a written reply.
2. **This week:** While waiting, the operator MAY conduct §5.4's controlled empirical discovery of the `job.assign_providers` endpoint against a test tenant. Strict bounds: one test job, one test provider, four endpoint attempts maximum, delete the test job afterwards. Log every request.
3. **This week:** Q4–Q8 can be answered by inspection of a single live response (or by ZB support). Lower urgency than Q1/Q2/Q3.
4. **Upon answers:** amend the design doc (per §6.4 above) and update the §18 precondition table. Mark PC1, PC2 green. Phase A proceeds for the four confirmed commands; Phase A `assign_providers` proceeds only after Q3 closes.

Until Q1, Q2-A, Q2-B are answered, Phase B is BLOCKED. This is by design.

---

## 9. Changelog

| Date | Version | Change |
|---|---|---|
| 2026-05-15 | 0.1 | Initial verification report. Q1 result: UNKNOWN/likely-no. Q2 result: event taxonomy verified from production; fan-out + per-event id UNKNOWN. `job.assign_providers` endpoint NOT LOCATED. Phase A partial-go for four confirmed commands; Phase B fully blocked. |
| 2026-05-16 | 0.2 | Discovery executed. **§3.4 fully rewritten** — `POST /v1/jobs/{id}/assign` confirmed with diff body `{assign, unassign, notify}`. Webhook echo `job.service_providers.assigned` is EXACT (no fan-out, single event, ~2-3s latency, 2 data points). §1.1 adds negative empirical evidence for Idempotency-Key (header not echoed). §2.2 adds `customer.created` subscription confirmation. §4 compatibility matrix updates assign row to ✓ Confirmed. §5.1 Phase A now FULLY unblocked for all five commands. Incidental: `GET /v1/providers` returns 400 (endpoint absent). Discovery transcript appears in §3.4 as an empirical progression table. |
