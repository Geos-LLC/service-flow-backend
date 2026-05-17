# ZB Provider-Assignment Discovery — Execution Pack

**Purpose:** Operator-ready artifacts for executing [zb-provider-assignment-discovery.md](./zb-provider-assignment-discovery.md). The runbook defines the protocol; this pack provides the exact commands and the result-capture skeleton.
**Audience:** Backend lead executing the discovery.
**Status:** Ready to execute. **Pending operator execution.**
**Last updated:** 2026-05-15.

**Important:** This is NOT an automation-executable script. The runbook requires human judgment between attempts (read response, decide stop/continue, observe webhook tail). The pack pre-bakes the commands so the operator's role is "execute + observe + record" rather than "construct + execute + observe + record."

---

## 0. Operator self-check (do not skip)

Before running anything, complete this checklist out loud. If any item is "no," stop here.

- [ ] I am the backend lead (or have explicit lead authorization).
- [ ] I have at least 30 minutes of uninterrupted time for all four attempts + cleanup.
- [ ] I have a test tenant — NOT a production tenant — in Zenbooker. ID: `___________`
- [ ] The test tenant has a valid API key in my shell as `ZB_TEST_API_KEY`. (Never paste into chat, never commit.)
- [ ] I have created a disposable test job in the test tenant **via the Zenbooker UI** (not via API). The job is `scheduled` or `confirmed`, has start date ≥48h in the future, has exactly one assigned provider P1.
- [ ] I have a second provider P2 in the same tenant.
- [ ] LogHub / Loki / Grafana is open in another tab — I can pull webhook deliveries within 60s of each request.
- [ ] I will record every attempt in §6 of this doc verbatim, even attempts that fail before sending.

If all checks pass, fill the operator notebook below and proceed.

---

## 1. Operator notebook (fill before §2)

```
TEST_TENANT_ID:        ____________________
TEST_TENANT_NAME:      ____________________
TEST_JOB_ID:           ____________________
PROVIDER_P1_ID:        ____________________  (currently assigned)
PROVIDER_P2_ID:        ____________________  (swap target)
OPERATOR:              ____________________
RUN_STARTED_UTC:       ____________________
```

Then export to your shell:

```bash
export ZB_TEST_API_KEY="..."           # never echo this, never paste into chat
export ZB_TEST_TENANT_ID="..."         # for cross-check only; not used in URL
export ZB_TEST_JOB_ID="..."
export ZB_PROVIDER_P1="..."
export ZB_PROVIDER_P2="..."
```

---

## 2. Pre-flight (run before attempt 1, again before each subsequent attempt)

### 2.1 Confirm job state

```bash
curl -sS \
  -H "Authorization: Bearer $ZB_TEST_API_KEY" \
  -H "Accept: application/json" \
  "https://api.zenbooker.com/v1/jobs/$ZB_TEST_JOB_ID" \
  | tee /tmp/zb-discovery-prestate-attempt-N.json \
  | jq '{ id, status, canceled, start_date, assigned_providers, customer: .customer.id }'
```

Record:
- `status` (MUST be `scheduled` or `confirmed`, NOT `started`/`completed`/`canceled`)
- `canceled` (MUST be `false`)
- `assigned_providers` array — IDs only

If `status` or `canceled` deviates from expected, STOP and fix via the Zenbooker UI before proceeding.

### 2.2 Compute pre-state fingerprint

The fingerprint is a deterministic hash over the field set used in design §6.7 for `field_group='assignment'`. Use Python (or any deterministic JSON canonicalizer):

```bash
python3 - <<'PY' < /tmp/zb-discovery-prestate-attempt-N.json
import json, hashlib, sys
job = json.load(sys.stdin)
fingerprint_input = {
    "assigned_providers": sorted([p.get("id") for p in (job.get("assigned_providers") or [])]),
    "status": job.get("status"),
    "canceled": bool(job.get("canceled")),
}
canon = json.dumps(fingerprint_input, sort_keys=True, separators=(",", ":"))
h = hashlib.sha256(canon.encode()).hexdigest()[:16]
print(f"fingerprint = {h}")
print(f"input = {canon}")
PY
```

Paste the fingerprint and input into §6 for the attempt.

### 2.3 Note attempt-start timestamp

```bash
date -u +%Y-%m-%dT%H:%M:%SZ | tee /tmp/zb-discovery-t0-attempt-N.txt
```

This `t0` bookends the webhook-observation window.

---

## 3. The four candidate attempts

For each attempt:

1. Run §2 pre-flight (creates a clean per-attempt baseline).
2. Run the candidate curl below — capture `t1` immediately after.
3. Wait 60 seconds. Then run §4 to fetch webhooks. Then §5 to compute post-state.
4. Apply the decision table in §6.5 of [zb-provider-assignment-discovery.md](./zb-provider-assignment-discovery.md#L226).
5. **If MATCH or PROBABLE — STOP.** Reset job state if mutated, then go to §5 cleanup.

### 3.1 Attempt 1 — `POST /v1/jobs/{id}/assign`

```bash
T1=$(date -u +%Y-%m-%dT%H:%M:%SZ); echo "t1=$T1"
curl -sS -X POST \
  -H "Authorization: Bearer $ZB_TEST_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json" \
  -H "Idempotency-Key: discover-attempt-1-$(uuidgen)" \
  -d "{
    \"assigned_providers\": [\"$ZB_PROVIDER_P2\"],
    \"assignment_method\": \"auto\"
  }" \
  "https://api.zenbooker.com/v1/jobs/$ZB_TEST_JOB_ID/assign" \
  -D /tmp/zb-discovery-headers-attempt-1.txt \
  -w "\n--- http_status: %{http_code} ---\n" \
  | tee /tmp/zb-discovery-body-attempt-1.json
```

Capture `t1` and the response. Then jump to §4.

### 3.2 Attempt 2 — `POST /v1/jobs/{id}/providers`

```bash
T1=$(date -u +%Y-%m-%dT%H:%M:%SZ); echo "t1=$T1"
curl -sS -X POST \
  -H "Authorization: Bearer $ZB_TEST_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json" \
  -H "Idempotency-Key: discover-attempt-2-$(uuidgen)" \
  -d "{
    \"assigned_providers\": [\"$ZB_PROVIDER_P2\"],
    \"assignment_method\": \"auto\"
  }" \
  "https://api.zenbooker.com/v1/jobs/$ZB_TEST_JOB_ID/providers" \
  -D /tmp/zb-discovery-headers-attempt-2.txt \
  -w "\n--- http_status: %{http_code} ---\n" \
  | tee /tmp/zb-discovery-body-attempt-2.json
```

### 3.3 Attempt 3 — `PATCH /v1/jobs/{id}`

```bash
T1=$(date -u +%Y-%m-%dT%H:%M:%SZ); echo "t1=$T1"
curl -sS -X PATCH \
  -H "Authorization: Bearer $ZB_TEST_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json" \
  -H "Idempotency-Key: discover-attempt-3-$(uuidgen)" \
  -d "{
    \"assigned_providers\": [\"$ZB_PROVIDER_P2\"]
  }" \
  "https://api.zenbooker.com/v1/jobs/$ZB_TEST_JOB_ID" \
  -D /tmp/zb-discovery-headers-attempt-3.txt \
  -w "\n--- http_status: %{http_code} ---\n" \
  | tee /tmp/zb-discovery-body-attempt-3.json
```

### 3.4 Attempt 4 — `POST /v1/jobs/{id}/reassign`

```bash
T1=$(date -u +%Y-%m-%dT%H:%M:%SZ); echo "t1=$T1"
curl -sS -X POST \
  -H "Authorization: Bearer $ZB_TEST_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json" \
  -H "Idempotency-Key: discover-attempt-4-$(uuidgen)" \
  -d "{
    \"assigned_providers\": [\"$ZB_PROVIDER_P2\"]
  }" \
  "https://api.zenbooker.com/v1/jobs/$ZB_TEST_JOB_ID/reassign" \
  -D /tmp/zb-discovery-headers-attempt-4.txt \
  -w "\n--- http_status: %{http_code} ---\n" \
  | tee /tmp/zb-discovery-body-attempt-4.json
```

---

## 4. Webhook observation (run 60s after each attempt's `t1`)

Wait 60 seconds (some ZB webhook deliveries observed near 30s P95; 60s is the safety margin). Then query Loki for inbound webhook deliveries against the test job in that window:

```bash
TOKEN=$(aws secretsmanager get-secret-value --secret-id geos-dashboard-tokens --region us-east-1 \
  --query 'SecretString' --output text \
  | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).GRAFANA_SA_TOKEN))")

# Wake instance
curl -s "https://info3d7b.grafana.net/api/org" -H "Authorization: Bearer $TOKEN" > /dev/null

# Query — replace T0/T1 with the actual attempt timestamps in unix nanoseconds
START_NS=$(date -d "$T1 - 5 seconds" +%s%N)
END_NS=$(date -d "$T1 + 65 seconds" +%s%N)

curl -s -G "https://info3d7b.grafana.net/api/datasources/proxy/7/loki/api/v1/query_range" \
  -H "Authorization: Bearer $TOKEN" \
  --data-urlencode "query={service_name=\"service-flow-backend\"} |= \"Webhook received\" |= \"$ZB_TEST_JOB_ID\"" \
  --data-urlencode "start=$START_NS" \
  --data-urlencode "end=$END_NS" \
  --data-urlencode 'limit=100' \
  --data-urlencode 'direction=forward' \
  | tee /tmp/zb-discovery-webhooks-attempt-N.json \
  | jq '.data.result[].values[] | { ts: .[0], line: .[1] }'
```

For each line, extract:
- The `event` value (e.g., `job.service_providers.assigned`, `job.service_order.edited`).
- The webhook arrival timestamp (relative to `t1`).
- Any `event_id` or `delivery_id` fields if the existing inbound handler logs them.
- Count of distinct events.

**Cross-check:** if a webhook fires for a job ID that is NOT `$ZB_TEST_JOB_ID`, STOP — there's tenant or resource bleed. Reset state and escalate.

---

## 5. Post-state and fingerprint comparison (per attempt)

After the 60s webhook window:

```bash
curl -sS \
  -H "Authorization: Bearer $ZB_TEST_API_KEY" \
  -H "Accept: application/json" \
  "https://api.zenbooker.com/v1/jobs/$ZB_TEST_JOB_ID" \
  | tee /tmp/zb-discovery-poststate-attempt-N.json \
  | jq '{ id, status, canceled, start_date, assigned_providers: [.assigned_providers[].id] }'
```

Compute post-state fingerprint with the same Python snippet from §2.2 (input file changes to `poststate`).

Compare:
- `pre_fingerprint == post_fingerprint` → no mutation.
- `pre_fingerprint != post_fingerprint` AND `post.assigned_providers == [P2]` AND status unchanged → **assignment mutation observed** (the desired outcome).
- `pre_fingerprint != post_fingerprint` AND something else changed (status/start_date/etc.) → **unexpected side effect; STOP**.

### 5.1 Decision per attempt

Apply the §3.5 table from the runbook. The most common verdicts:

| Response | Mutation | Webhook | Verdict |
|---|---|---|---|
| `2xx` | P1 → P2 | `job.service_providers.assigned` fired | **MATCH** — stop, reset, cleanup |
| `2xx` | P1 → P2 | only `job.service_order.edited` fired | **PROBABLE** — record carefully, continue one more attempt to disambiguate |
| `2xx` | no change | — | **NOT_THIS_ENDPOINT** — continue |
| `404` / `405` | — | — | **NOT_THIS_ENDPOINT** — continue |
| `400` / `422` | — | — | **NOT_THIS_ENDPOINT** or wrong payload — continue (one corrected-payload retry allowed within the same attempt) |
| Anything else | unexpected | unexpected | **STOP** — escalate |

---

## 6. Result capture (fill verbatim)

Copy the block below for each attempt. Append all four to `service-flow-backend/docs/architecture/zb-discovery-log-20260515.md` (a new file the operator creates on a branch).

```yaml
attempt: 1
attempted_at_utc: <T0>
operator: <name>
tenant:
  id: <TEST_TENANT_ID>
  confirmed_not_production: yes
test_job:
  id: <TEST_JOB_ID>
  pre_state:
    assigned_providers: [<P1>]
    status: scheduled
    canceled: false
  pre_fingerprint: <hash>
  pre_fingerprint_input: <canonical json>
request:
  method: POST
  url: /v1/jobs/<id>/assign
  body: |
    {"assigned_providers": ["<P2>"], "assignment_method": "auto"}
  idempotency_key_sent: discover-attempt-1-<uuid>
  notable_request_headers:
    Authorization: "Bearer ***redacted***"
response:
  status: <code>
  body_first_500_chars: |
    <verbatim>
  notable_response_headers:  # esp. x-*, rate-limit-*, retry-after, idempotency
    <key>: <value>
  t1_utc: <T1>
post_state:
  assigned_providers: [<observed>]
  status: <observed>
  canceled: <observed>
  post_fingerprint: <hash>
  post_fingerprint_input: <canonical json>
mutation_observed: <true | false>
mutation_kind: <none | assigned_providers_only | unexpected_side_effect:<field>>
webhooks_observed_within_60s:
  - event: <event_type>
    data_id: <id>            # data.id or data.job_id from payload
    event_id: <if present>   # if existing inbound handler logged one
    delivery_id: <if present>
    arrived_after_seconds: <N>
    is_duplicate: <true if same event/id seen twice in window>
webhook_event_count: <integer>
webhook_payload_determinism: <deterministic | generic | mixed | unknown>
correlation:
  can_map_to_unique_mutation: <yes | no | partial>
  confidence: <exact | probable | ambiguous | n/a (no echo)>
  reasoning: <one sentence>
verdict: <MATCH | PROBABLE | NOT_THIS_ENDPOINT | STOP>
reset_action_after_attempt: <none | reset via endpoint X | reset via UI>
notes: |
  <free-text observations; anything unexpected; anything for ZB support>
```

---

## 7. Final outcome block (one per run)

```yaml
runbook_outcome:
  status: <RESOLVED | DEFERRED | STOPPED_UNEXPECTEDLY>
  canonical_endpoint:
    method: <POST | PATCH | null>
    path: <path or null>
    body_shape: |
      <verbatim minimal body that worked, or null>
    response_shape_first_500: |
      <verbatim, or null>
  webhook_echo:
    event_type: <event or null>
    fan_out_observed: <true | false | unknown>     # did *.edited also fire?
    event_id_present: <true | false | unknown>     # informs Q2-B
    deterministic: <true | false | unknown>
  correlation_confidence_for_this_command_type: <exact | probable | ambiguous | n/a>
evidence_for_open_questions:
  q1_idempotency_key:
    header_echoed_back: <true | false | not_observed>
    behavior_on_replay: <not_tested | dedup_observed | duplicate_resource_created | not_applicable>
    verdict: <still_unknown | partially_evidenced | resolved_supported | resolved_not_supported>
  q2_a_event_fan_out:
    one_event: <count of times only the dedicated event fired across attempts>
    multiple_events: <count of times multiple events fired>
    verdict: <still_unknown | partially_evidenced | resolved_single | resolved_multi>
  q2_b_event_id_field:
    per_delivery_id_observed: <true | false>
    field_name_if_present: <header / body path / null>
    verdict: <still_unknown | partially_evidenced | resolved>
phase_a_unblock_decision:
  job_assign_providers_endpoint_known: <yes | no>
  phase_a_can_proceed_for_assign_providers: <yes | no>
  notes: |
    <reasoning>
cleanup:
  job_state_reset: <yes>
  job_cancelled_via_ui: <yes>
  webhook_tail_closed: <yes>
  log_committed_to_branch: <branch name>
  all_temp_files_removed: <yes>     # /tmp/zb-discovery-*
```

---

## 8. After execution — handoff to analysis

When all four attempts are complete (or stopped early), do this:

1. Commit the filled `zb-discovery-log-20260515.md` to a branch.
2. Paste the **final outcome block** (§7) back into chat. Optionally include redacted/trimmed `attempt:` YAML blocks if they show interesting webhook behavior.
3. Confirm cleanup is done: test job cancelled in ZB UI, fingerprints back to baseline, temp files removed.

When the results land in chat, the agent will produce the deliverables the design requires:

| Deliverable | Source |
|---|---|
| Endpoint discovery result | §7 `canonical_endpoint` |
| Payload schema | §7 `canonical_endpoint.body_shape` + observed response_shape |
| Webhook echo behavior | §7 `webhook_echo` + per-attempt `webhooks_observed_within_60s` |
| Correlation confidence assessment | §7 `correlation_confidence_for_this_command_type` |
| Whether Q3 remains blocked | §7 `phase_a_unblock_decision` |
| Whether Q2-A gained evidence | §7 `evidence_for_open_questions.q2_a_event_fan_out` |
| Whether Q2-B gained evidence | §7 `evidence_for_open_questions.q2_b_event_id_field` |

The agent will then amend:
- [zb-api-verification.md §3.4](./zb-api-verification.md) — replace "UNKNOWN" with the discovered endpoint (or mark Phase E deferral).
- [zb-api-verification.md §2](./zb-api-verification.md) — fold Q2-A / Q2-B evidence into the verification matrix.
- [zb-outbound-command-confirmation.md §4.1 + §6.9](./zb-outbound-command-confirmation.md) — make the `job.assign_providers` row concrete (or mark deferred).
- The relevant rows in [zb-outbound-command-confirmation.md §18](./zb-outbound-command-confirmation.md#L809) preconditions.

If Q3 is resolved but Q2-A / Q2-B remain unknown, Phase B is still blocked on the support reply (PC2). Phase A schema for `job.assign_providers` unblocks regardless.

---

## 9. Safety reminders (read once before §3.1)

- ONE test job. ONE test tenant. FOUR attempts maximum.
- If anything looks weird, stop. Re-read §6 of the runbook for stop conditions.
- Do not paste `ZB_TEST_API_KEY` into chat, into git, into anything that isn't `/tmp/` or your shell.
- Do not skip cleanup. The test job MUST be cancelled in Zenbooker UI after the run.
- The Idempotency-Key header is sent in every request **as a probe** — if any response echoes it back, that's evidence for Q1 (whether ZB acknowledges the header at all).
- Do not extend the candidate list. If all four fail, the answer is "defer to Phase E" or "wait for ZB support."
