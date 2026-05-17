# ZB Provider-Assignment Endpoint Discovery — Runbook

**Purpose:** Empirically locate the Zenbooker API endpoint that mutates `assigned_providers[]` on an existing job. The public docs do not document this endpoint.
**Scope:** This is the ONLY authorized outbound write to ZB before Phase B implementation. It is bounded to one test job in one test tenant with at most four endpoint attempts.
**Governed by:** [zb-outbound-command-confirmation.md §18](./zb-outbound-command-confirmation.md), [zb-api-verification.md §5.4](./zb-api-verification.md).
**Owner:** Backend lead (NOT a contractor, NOT an automation).
**Status:** Ready to execute when the operator has the prerequisites.

---

## 0. Why this runbook exists

ServiceFlow has located ZB endpoints for: `POST /v1/jobs`, `POST /v1/jobs/{id}/reschedule`, `POST /v1/jobs/{id}/cancel`, `POST /v1/customers`, `PATCH /v1/customers/{id}`. The endpoint for mutating `assigned_providers[]` on an existing job is **not documented** at any public slug we could find (`/reference/assign-providers`, `/reference/assign-a-job`, `/reference/reassign-a-job`, `/reference/update-job-providers`, `/reference/edit-providers` all return 404).

Two options exist:
1. Ask Zenbooker support (Q4 in [zb-support-questions.md](./zb-support-questions.md)).
2. Discover empirically against a test tenant with four bounded attempts.

This runbook is option 2. It can run **in parallel** with option 1. Whichever resolves first wins.

If both resolve, the support answer takes precedence — empirical discovery may stumble onto an internal/deprecated endpoint that we shouldn't depend on.

---

## 1. Preconditions

Every item below MUST be true before the runbook starts. If any item is false, stop and resolve it first.

- [ ] A dedicated **test tenant** exists in Zenbooker. It MUST NOT be a production tenant. The tenant ID is recorded below.
  - Test tenant ID: `___________________`
  - Operator-confirmed not production: ☐ yes
- [ ] A valid **API key** for the test tenant is held by the operator. Stored outside source control; loaded into the operator's shell environment as `ZB_TEST_API_KEY`.
- [ ] A **test job** exists in the test tenant, created **via the Zenbooker UI** (not via API — we want a clean baseline). The job MUST:
  - Be in `scheduled` or `confirmed` status (not started, not completed, not cancelled, not invoiced).
  - Have exactly **one** assigned provider — call this `P1`.
  - Have a scheduled start date at least 48 hours in the future (avoids accidentally triggering reminder workflows).
  - Test job ID: `___________________`
  - Provider P1 ID: `___________________`
- [ ] A **second provider** exists in the test tenant for the swap target — call this `P2`.
  - Provider P2 ID: `___________________`
  - P1 ≠ P2 confirmed: ☐ yes
- [ ] A **webhook tail** is open to observe inbound deliveries. Either:
  - Grafana / LogHub query filtered to `service_name=service-flow-backend` and `event_id=<test_job_id>`, OR
  - A local-only webhook receiver registered against the test tenant (a temporary URL via `ngrok` or equivalent) that prints every delivery to stdout.
- [ ] The operator is a **backend lead** (per §18 PC11 authorization).
- [ ] All four attempts will be performed in a **single sitting** (do not split across days — the test job's state must remain controlled).

If any precondition is unmet, the runbook does not start.

---

## 2. Candidate endpoints (priority order)

We will try at most four endpoints. They are listed in priority order based on the action-endpoint pattern observed for reschedule and cancel.

| Attempt | Method | Path | Body |
|---|---|---|---|
| 1 | `POST` | `/v1/jobs/{id}/assign` | `{ "assigned_providers": ["P2"], "assignment_method": "auto" }` |
| 2 | `POST` | `/v1/jobs/{id}/providers` | `{ "assigned_providers": ["P2"], "assignment_method": "auto" }` |
| 3 | `PATCH` | `/v1/jobs/{id}` | `{ "assigned_providers": ["P2"] }` |
| 4 | `POST` | `/v1/jobs/{id}/reassign` | `{ "assigned_providers": ["P2"] }` |

Reasoning:
- Attempt 1 matches the documented action-endpoint pattern (`/reschedule`, `/cancel`).
- Attempt 2 matches the REST sub-resource pattern.
- Attempt 3 matches the generic-PATCH pattern (though `/reference/update-a-job` was 404, suggesting this likely doesn't exist).
- Attempt 4 is the "reassign" variant — some APIs distinguish "first assignment" from "reassignment."

Do NOT extend the list. If all four fail, stop and use Q4 of the support package.

---

## 3. Per-attempt protocol

For each attempt N (1 → 4), execute these steps in order. Do not skip or reorder.

### 3.1 Pre-flight (every attempt)

1. Verify the test tenant ID and test job ID in the operator's terminal context are correct. Two-place confirmation:
   - `echo "$ZB_TEST_TENANT_ID"` matches the precondition value.
   - `echo "$ZB_TEST_JOB_ID"` matches the precondition value.
2. Fetch current job state:
   ```
   GET https://api.zenbooker.com/v1/jobs/$ZB_TEST_JOB_ID
   Authorization: Bearer $ZB_TEST_API_KEY
   ```
3. Record from the response:
   - `assigned_providers` array — call this `pre_state.assigned_providers`
   - `status` — should be `scheduled` or `confirmed`
   - `canceled` — MUST be `false`
4. If `pre_state.assigned_providers != [P1]`, reset before continuing:
   - If P2 is currently assigned (from a previous successful attempt), revert by using whichever endpoint succeeded; record that we already have the answer and stop.
   - If neither P1 nor P2 are assigned, manually fix in Zenbooker UI and re-run §3.1.
5. Note the wall-clock timestamp — call this `t0`.

### 3.2 Send the candidate request

6. Send exactly the request specified for attempt N in §2. Use `curl -v` (or equivalent) so request headers and response headers are all captured.
7. Record verbatim:
   - HTTP method + URL
   - Full request body (JSON)
   - All response headers (especially anything with "idempotency", "rate-limit", "x-")
   - Response HTTP status
   - Response body — first 500 characters (full body if shorter)
   - Wall-clock timestamp of response — call this `t1`

### 3.3 Observe webhook arrivals

8. Wait at least 60 seconds from `t1` (some webhook deliveries have observed P95 latency near 30 seconds; 60s is a safety margin).
9. From the webhook tail opened in preconditions, record every event whose `data.id` OR `data.job_id` equals the test job's ID, between `t0` and `t1 + 60s`. For each:
   - Event type (e.g., `job.service_providers.assigned`)
   - `data.id` / `data.job_id`
   - Any `event_id` / `delivery_id` field if present (informs Q2-B)
   - Arrival timestamp relative to `t1`

### 3.4 Verify post-state

10. Fetch the job state again:
    ```
    GET https://api.zenbooker.com/v1/jobs/$ZB_TEST_JOB_ID
    Authorization: Bearer $ZB_TEST_API_KEY
    ```
11. Record `post_state.assigned_providers` and `post_state.status`.

### 3.5 Decide

Apply this decision table:

| Response status | Post-state mutation | Webhook | Verdict |
|---|---|---|---|
| `2xx` | `assigned_providers` now contains P2 (NOT P1) | `job.service_providers.assigned` fired | **MATCH — canonical endpoint.** Stop. Record findings. Reset job (§4). |
| `2xx` | `assigned_providers` shows P2 | `job.service_providers.assigned` did NOT fire; only `job.service_order.edited` fired | **Probable match — endpoint works but echo semantics are unexpected.** Record. Do NOT declare final yet. Continue to the next attempt; the unexpected event behavior must be cross-checked. |
| `2xx` | `assigned_providers` unchanged | (any) | **Not this endpoint.** Endpoint accepted the request but did not mutate. Continue. |
| `404` | (any) | (any) | **Not this endpoint.** Continue. |
| `405` (method not allowed) | (any) | (any) | **Not this endpoint.** Continue. (Some routing layers return 405 instead of 404 for wrong-method on existing paths.) |
| `400` / `422` | (any) | (any) | **Not this endpoint** OR **wrong payload shape.** If response body suggests a missing/extra field, retry once with corrected body within the same attempt budget. Otherwise continue. |
| `401` / `403` | (any) | (any) | **STOP.** Auth misconfigured. Do not continue. Investigate. |
| `429` | (any) | (any) | **STOP** the attempt; wait 5 minutes; resume on next attempt slot (this consumes one of the four). |
| `5xx` | (any) | (any) | **Retry the request once** within the same attempt budget. If second response is also `5xx`, mark as inconclusive and continue. |
| Job mutated unexpectedly (status changed, time changed, anything other than `assigned_providers`) | (any) | (any) | **STOP** the entire runbook. Reset job state via UI. Report to backend lead before continuing. |

### 3.6 Inter-attempt reset

If the attempt mutated `assigned_providers` (probable-match case in §3.5), **before** the next attempt the operator MUST reset `assigned_providers` back to `[P1]`. Use the now-known-working endpoint (this is the one exception to "no production-shaped writes"). Record the reset as part of the log.

If the attempt didn't mutate, no reset is needed.

---

## 4. Cleanup (mandatory, regardless of outcome)

After the last attempt — whether on success at attempt 1 or on exhaustion at attempt 4 — perform:

1. **Verify final job state:**
   ```
   GET https://api.zenbooker.com/v1/jobs/$ZB_TEST_JOB_ID
   ```
   Confirm `assigned_providers == [P1]` (or whatever the agreed reset state is). If not, reset in Zenbooker UI.
2. **Cancel the test job** via the Zenbooker UI (not via API). Confirm cancellation in the dashboard.
3. **Close the webhook tail** / shut down any temporary receiver.
4. **Save the structured log** (see §5 format) to `service-flow-backend/docs/architecture/zb-discovery-log-<YYYYMMDD>.md`. Commit to a branch; do NOT commit to main without backend lead review.
5. **Record the outcome** in [zb-api-verification.md §3.4](./zb-api-verification.md) (replace "UNKNOWN" with the discovered endpoint OR with "not located — defer command to Phase E").

---

## 5. Recording format

For each attempt, append a YAML block to the log file:

```yaml
attempt: <1-4>
attempted_at_utc: <ISO 8601>
operator: <name>
tenant:
  id: <id>
  confirmed_not_production: yes
test_job:
  id: <id>
  pre_state:
    assigned_providers: [<P1>]
    status: scheduled
    canceled: false
request:
  method: <POST | PATCH>
  url: /v1/jobs/<id>/<action>
  body: |
    {
      "assigned_providers": ["<P2>"],
      "assignment_method": "auto"
    }
  notable_request_headers: { Authorization: "Bearer ***redacted***" }
response:
  status: <code>
  notable_headers: {}  # esp. x-* / rate-limit / idempotency
  body_first_500: |
    "..."
post_state:
  assigned_providers: [<observed>]
  status: <observed>
webhooks_observed:
  - event: <event_type>
    data_id: <id>
    delivery_id: <if present>
    arrived_after_seconds: <N>
verdict: <MATCH | PROBABLE | NOT_THIS_ENDPOINT | STOP>
notes: |
  <free-text observations — anything unexpected, anything to clarify with ZB support>
reset_action: <none | reset via endpoint X | reset via UI>
```

Then a final block:

```yaml
runbook_outcome:
  status: <RESOLVED | DEFERRED | STOPPED_UNEXPECTEDLY>
  canonical_endpoint: <method + path, or null>
  echo_event: <event_type, or null>
  notes_to_zb_support: |
    <any follow-up questions for the support email — even if the runbook resolved>
cleanup:
  job_state_reset: yes
  job_cancelled: yes
  webhook_tail_closed: yes
  log_committed: <branch name>
```

---

## 6. Stop conditions (do NOT continue past these)

The runbook stops immediately if any of these triggers fires:

- The job's state mutates in an unexpected way (status changes beyond `scheduled` ↔ `confirmed`, time changes, customer changes, anything outside `assigned_providers`).
- A `401` or `403` response — auth is misconfigured; resolve before continuing.
- A webhook fires for a resource that is NOT the test job — indicates a cross-tenant or cross-resource side effect; investigate before continuing.
- More than 5 minutes of `429`s — ZB is rate-limiting; reschedule the runbook for off-peak.
- The operator loses confidence about which tenant they're hitting.

In all stop cases: reset state via UI, document the stop reason, escalate to backend lead.

---

## 7. Outcomes and next steps

### 7.1 If a canonical endpoint is found

- Update [zb-api-verification.md §3.4](./zb-api-verification.md) with the verified endpoint, method, body, response shape, and webhook echo verdict.
- Update [zb-outbound-command-confirmation.md §4.1 + §6.9](./zb-outbound-command-confirmation.md) — replace the "UNKNOWN" / "TBD" placeholders for `job.assign_providers`.
- Unblock Phase A schema work for `job.assign_providers` (`field_group='assignment'`).
- Phase B remains blocked on Q1, Q2-A, Q2-B until ZB support replies.

### 7.2 If no canonical endpoint is found (all 4 attempts fail)

- Update [zb-api-verification.md §3.4](./zb-api-verification.md): "endpoint not located via empirical discovery; awaiting ZB support reply on Q4."
- The `job.assign_providers` command type is deferred to Phase E (per [design §5.4](./zb-api-verification.md#L296)).
- Phase A proceeds for the four confirmed command types (`job.create`, `job.reschedule`, `job.cancel`, `customer.upsert`).

### 7.3 If runbook stopped unexpectedly

- Backend lead reviews the partial log.
- Decide whether to retry the runbook after fixing the cause, or to wait for ZB support reply.
- Do NOT silently re-run — the test job has been partially mutated and may not be in a clean baseline.

---

## 8. Authorization scope

This runbook is the only authorized outbound write to Zenbooker before Phase B implementation. It does not authorize:
- Any additional API exploration (other endpoints, other tenants, other resource types).
- Loosening any of the bounds (more attempts, more tenants, more jobs).
- Skipping cleanup.
- Skipping logging.

If any of those becomes necessary, the authorization has to be re-granted explicitly.
