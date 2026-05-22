# Phase B — Deploy Plan + Dry-Run Verification Matrix

**Date:** 2026-05-17
**Status:** Implementation complete (commit `85e87c4`); **not yet activated.**
**Audience:** Operator-of-record (sayapingeorge@gmail.com) executing Phase B activation.

This document is the activation runbook for Phase B. It defines:
1. The exact deploy steps required to start Phase B traffic
2. The dry-run verification matrix that gates the transition from dry-run (days 1-3) to live (days 4-7)
3. The rollback path at every step

Implementation lives in commit `85e87c4` on main. Production is currently running this code with all flags off; no behavior change has occurred.

---

## 1. Pre-activation gate (must all be true)

Before executing §2, every item below MUST be confirmed:

- [ ] All PC11-PC15 gates RESOLVED ([phase-b-readiness-v2.md](../architecture/phase-b-readiness-v2.md))
- [ ] Latest prod deploy is on commit `85e87c4` or later (Phase B code present)
- [ ] Production env vars currently read:
  - `ZB_OUTBOUND_ENABLED` = unset OR `false` (drainer NOT started)
  - `ZB_OUTBOUND_DRY_RUN` = unset OR `true` (defaults to dry-run)
  - `ZB_OUTBOUND_GLOBAL_FREEZE` = unset OR `true` (defense in depth)
- [ ] `platform_settings.zb_outbound_job_create_enabled` row does NOT exist (producer off for all tenants)
- [ ] Pilot tenant (`user_id=2`) is healthy in production (test customer + test job available; ZB connection still active)
- [ ] Operator has Railway access + Supabase Management API token at hand
- [ ] Loki dashboards open in a separate browser tab for live monitoring
- [ ] Operator has 1 hour blocked on calendar for Day 1 activation + first watch

If any item is false: stop, resolve, return.

---

## 2. Deploy plan

### 2.1 Day 1 (T-0) — Dry-run activation

**Goal:** Phase B producer + drainer running in production, but ZERO outbound ZB HTTP traffic. Pilot tenant's job-creation flow produces commands; drainer builds payload + signs but does NOT POST.

#### Step 1 — Set drainer env vars on prod Railway

```bash
RAILWAY_TOKEN=$(aws secretsmanager get-secret-value --secret-id geos-dashboard-tokens --region us-east-1 \
  --query 'SecretString' --output text \
  | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).RAILWAY_TOKEN))")

PROD_ENV='31371339-0521-4d17-8ce8-28f5dc7c8423'
SVC='eed7aa3a-8030-4d56-9bf2-a8c8ff18dbf7'
PROJ='672437e4-9791-43c4-aa01-5181f3bd1904'

# Variables to set (4 in total)
for kv in \
  "ZB_OUTBOUND_ENABLED:true" \
  "ZB_OUTBOUND_DRY_RUN:true" \
  "ZB_OUTBOUND_GLOBAL_FREEZE:false" \
  "ZB_OUTBOUND_BATCH_SIZE:5"
do
  k="${kv%%:*}"; v="${kv##*:}"
  curl -s "https://backboard.railway.com/graphql/v2" \
    -H "Authorization: Bearer $RAILWAY_TOKEN" -H "Content-Type: application/json" \
    -d "{\"query\":\"mutation { variableUpsert(input: { projectId: \\\"$PROJ\\\", environmentId: \\\"$PROD_ENV\\\", serviceId: \\\"$SVC\\\", name: \\\"$k\\\", value: \\\"$v\\\" }) }\"}"
done
```

Railway auto-deploys (~30s). Confirm new deploy SUCCESS via the Railway dashboard or:

```bash
curl -s "https://backboard.railway.com/graphql/v2" \
  -H "Authorization: Bearer $RAILWAY_TOKEN" -H "Content-Type: application/json" \
  -d "{\"query\":\"query { deployments(first: 1, input: { serviceId: \\\"$SVC\\\" }) { edges { node { id status environment { name } createdAt } } } }\"}"
```

#### Step 2 — Verify drainer started (dry-run mode)

```
Loki: {service_name="service-flow-backend"} |= "[ZB Outbound] Drainer started"
```

Expect:
```
[ZB Outbound] Drainer started (tick=5000ms batch=5 dry_run=true frozen=false)
```

If the line shows `frozen=true`, the freeze override didn't take — re-issue Step 1 for `ZB_OUTBOUND_GLOBAL_FREEZE`. If absent entirely, the deploy hasn't completed.

#### Step 3 — Enable producer for pilot tenant only

```sql
INSERT INTO platform_settings (key, value)
VALUES (
  'zb_outbound_job_create_enabled',
  jsonb_build_object('user_ids', jsonb_build_array(2))::text
)
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
```

Verify:
```sql
SELECT key, value::jsonb->'user_ids' AS user_ids
  FROM platform_settings
 WHERE key = 'zb_outbound_job_create_enabled';
-- Expected: {"user_ids":[2]}
```

#### Step 4 — Smoke test: create one job in SF UI

Operator logs into SF as `user_id=2`, navigates to "Create Job," fills:
- Customer: Test Customer (already linked to ZB)
- Service: any service that has `zenbooker_id` populated (check `services` table for the pilot's tenant)
- Team member: Georgiy Sayapin (has ZB linkage) or Test team member
- Scheduled date: ≥48h in future
- Service address: any (test customer's saved address is fine)
- Submit.

#### Step 5 — Verify the producer fired

Within 10 seconds of submission:

```sql
SELECT id, event_id, command_type, state, sf_job_id, defer_reason,
       sent_at, confirmation_deadline,
       (zb_response->>'dry_run')::boolean AS is_dry_run
  FROM zb_outbound_commands
 WHERE user_id = 2
   AND command_type = 'job.create'
 ORDER BY requested_at DESC
 LIMIT 5;
```

Expected: one new row, `state='sent'`, `is_dry_run=true`. If `state='skipped_precondition'`, inspect `defer_reason` and fix the precondition (most common: customer or service has no `zenbooker_id`).

Loki anchors expected within 30s:
```
[ZB Outbound producer] queued job.create sf_job=<id> event=zboe_...
[ZB-outbound-metric] type=queued user_id=2 command_type=job.create field_group=create event_id=zboe_...
[ZB Outbound] dry_run sent event=zboe_... job=<id> attempts=1
[ZB-outbound-metric] type=sent user_id=2 command_type=job.create field_group=create event_id=zboe_... note=dry_run
```

Stop here for Day 1. The dry-run soak begins.

### 2.2 Days 2-3 — Dry-run soak

**Goal:** Build up a sample of producer + drainer behavior with zero ZB-side risk. The operator runs the daily smoke check ([runbook §1](./zb-outbound-runbook.md#1-daily-smoke-check)) once per day and watches for anomalies.

Pilot tenant continues normal job-creation activity. Every SF job creation for `user_id=2` fires the producer; each command goes to `state='sent'` with `is_dry_run=true`. Zero ZB API calls occur.

### 2.3 Day 4 — Dry-run review + flip to live

#### Step 1 — Complete the dry-run verification matrix (§3 below)

Run every check in §3. Every assertion must be ✓ before proceeding.

#### Step 2 — Flip DRY_RUN off

```bash
curl -s "https://backboard.railway.com/graphql/v2" \
  -H "Authorization: Bearer $RAILWAY_TOKEN" -H "Content-Type: application/json" \
  -d "{\"query\":\"mutation { variableUpsert(input: { projectId: \\\"$PROJ\\\", environmentId: \\\"$PROD_ENV\\\", serviceId: \\\"$SVC\\\", name: \\\"ZB_OUTBOUND_DRY_RUN\\\", value: \\\"false\\\" }) }\"}"
```

Railway redeploys (~30s).

#### Step 3 — Verify live mode

```
Loki: {service_name="service-flow-backend"} |= "[ZB Outbound] Drainer started"
```
Expect `dry_run=false` in the next "Drainer started" log line.

#### Step 4 — First live job

Operator creates ONE job in SF UI for `user_id=2`. Within ~5 seconds:

```sql
SELECT id, event_id, state, sent_at, zenbooker_id, confirmation_deadline
  FROM zb_outbound_commands
 WHERE user_id = 2 AND command_type = 'job.create'
 ORDER BY requested_at DESC LIMIT 1;
```

Expected: `state='sent'`, `zenbooker_id` is now NON-NULL (extracted from ZB's 201 response).

Within 5-30 seconds (per Q2-A observed latency), the ZB webhook fires `job.created`. Then:

```sql
-- Same row, re-queried
SELECT id, state, confirmed_at, correlation_confidence, zb_event_id
  FROM zb_outbound_commands
 WHERE user_id = 2 ORDER BY requested_at DESC LIMIT 1;
```

Expected: `state='confirmed'`, `correlation_confidence='exact'`, `zb_event_id` populated with ZB's `webhook_id`. Confirmation latency = `confirmed_at - sent_at`.

### 2.4 Days 4-7 — Live soak

Operator runs the daily smoke check + the runbook's week-1 watchlist. Watch for 429s, conflicts, ledger drift. None expected.

---

## 3. Dry-run verification matrix

These checks gate the transition from dry-run (days 1-3) to live (day 4). **Every assertion MUST be ✓ before flipping `ZB_OUTBOUND_DRY_RUN=false`.**

### 3.1 Producer assertions

| # | Assertion | How to verify | Pass criterion |
|---|---|---|---|
| P1 | At least 3 job.create commands queued in dry-run window | `SELECT count(*) FROM zb_outbound_commands WHERE user_id=2 AND command_type='job.create' AND requested_at > '<day-1-start>'` | ≥ 3 |
| P2 | All queued commands have `state='sent'` within 60s of `requested_at` | `SELECT state, count(*) FROM zb_outbound_commands WHERE user_id=2 AND command_type='job.create' GROUP BY state` | 100% in `sent` state |
| P3 | All sent commands carry `zb_response.dry_run=true` | `SELECT count(*) FILTER (WHERE (zb_response->>'dry_run')::boolean = true) AS dry, count(*) AS total FROM zb_outbound_commands WHERE user_id=2 AND command_type='job.create' AND state='sent'` | `dry = total` |
| P4 | No `zenbooker_id` stamped during dry-run (ZB never saw the request) | Same query; `zenbooker_id IS NULL` for all rows | 100% NULL |
| P5 | Zero `skipped_precondition` rows (or each is explainable) | `SELECT defer_reason, count(*) FROM zb_outbound_commands WHERE user_id=2 AND state='skipped_precondition' GROUP BY 1` | Either 0 rows OR every defer_reason is operator-understood (e.g., a job for a non-ZB customer) |
| P6 | `payload_json` contains all required ZB body fields | `SELECT payload_json FROM zb_outbound_commands WHERE user_id=2 AND command_type='job.create' AND state='sent' LIMIT 5` | Each row has: territory_id, customer_id, services[0].service_id, timeslot.start_time |
| P7 | `intent_hash` is non-empty + non-default | Same query; check `intent_hash IS NOT NULL AND length(intent_hash) > 4` | All rows have valid intent_hash |
| P8 | Producer log line `[ZB Outbound producer] queued` appears once per command | Loki: `{service_name="service-flow-backend"} \|= "ZB Outbound producer" \|= "queued"` | Count matches the queued count |

### 3.2 Drainer assertions

| # | Assertion | How to verify | Pass criterion |
|---|---|---|---|
| D1 | Drainer is running (in dry-run mode) | Loki: `{service_name="service-flow-backend"} \|= "Drainer started"` | At least 1 line with `dry_run=true frozen=false` since dry-run activation |
| D2 | Drainer claims commands within `next_attempt_at + 10s` | `SELECT event_id, requested_at, sent_at, sent_at - requested_at AS claim_latency FROM zb_outbound_commands WHERE user_id=2 AND command_type='job.create' AND state='sent' ORDER BY requested_at DESC LIMIT 10` | All claim_latencies < 10 seconds |
| D3 | Zero HTTP calls to ZB API in dry-run window | Loki: `{service_name="service-flow-backend"} \|= "api.zenbooker.com" \|= "[ZB Outbound]"` | 0 lines |
| D4 | Zero runtime errors in `[ZB Outbound]` log scope | Loki: `{service_name="service-flow-backend"} \|= "[ZB Outbound]" \|~ "(Error\|ERROR\|crash\|FATAL)"` | 0 lines |
| D5 | Sent-metric log appears for every successful drainer claim | Loki: `{service_name="service-flow-backend"} \|= "[ZB-outbound-metric] type=sent"` count = matching sent state count | Equal |
| D6 | No spurious DLQ entries | `SELECT count(*) FROM zb_outbound_commands WHERE user_id=2 AND state='failed' AND requested_at > '<day-1-start>'` | 0 |
| D7 | No conflict / invalidated / ambiguous rows | `SELECT state, count(*) FROM zb_outbound_commands WHERE user_id=2 AND state IN ('conflict','invalidated_by_upstream_terminal_state','ambiguous_pending_review') GROUP BY 1` | 0 rows |

### 3.3 Tenant isolation assertions

| # | Assertion | How to verify | Pass criterion |
|---|---|---|---|
| T1 | No commands exist for any user_id other than 2 | `SELECT user_id, count(*) FROM zb_outbound_commands GROUP BY user_id` | Only `user_id=2` shows, OR if other rows exist they predate Phase B and are explicable |
| T2 | platform_settings opt-in list contains only `[2]` | `SELECT value::jsonb->'user_ids' FROM platform_settings WHERE key='zb_outbound_job_create_enabled'` | `[2]` exactly |

### 3.4 Existing-system stability assertions

| # | Assertion | How to verify | Pass criterion |
|---|---|---|---|
| S1 | Inbound webhook handler still processing ZB events normally | Loki: `{service_name="service-flow-backend"} \|= "[Zenbooker] Webhook received"` in last 24h | Non-zero count; no error pattern alongside |
| S2 | delivery_log inbound rows continue normal | `SELECT count(*) FROM delivery_log WHERE source_system='zenbooker' AND delivery_direction='inbound' AND created_at > '<day-1-start>'` | Non-zero, normal range |
| S3 | No `ledger_drift_detected` spike | `SELECT count(*) FROM ledger_drift_detected WHERE detected_at > '<day-1-start>'` | 0 (baseline state was 0) |
| S4 | No `zb_sync_dirty` spike | `SELECT count(*) FROM zb_sync_dirty WHERE first_seen_at > '<day-1-start>' AND resolved_at IS NULL` | 0 (or only pre-existing) |
| S5 | `delivery_log.context.zb_account_id` now populated (account fix verified) | `SELECT count(*) FILTER (WHERE (context::jsonb)->>'zb_account_id' IS NOT NULL) AS populated, count(*) AS total FROM delivery_log WHERE source_system='zenbooker' AND delivery_direction='inbound' AND created_at > '<deploy-of-account-fix>'` | populated/total > 0 (account fix working) |
| S6 | LB outbound drainer unaffected | Loki: `{service_name="service-flow-backend"} \|= "[LB Outbound]"` shows normal activity | Drainer-started + send/sent counts normal |

### 3.5 Pass/fail criteria

**ALL of:** P1, P2, P3, P4, P6, P7, P8, D1, D2, D3, D4, D5, D6, D7, T1, T2, S1, S2, S3, S4, S6 must pass.

P5 and S5 are informational warnings (acceptable to ship live with caveats, e.g., one expected skipped_precondition row).

If **ANY** of the required checks fail:
- Capture the failure evidence (SQL output, Loki query results)
- Do NOT flip DRY_RUN off
- Investigate per [runbook](./zb-outbound-runbook.md) §3 (DLQ triage) or §4 (conflicts) or §7 (week-1 issues)
- Re-run the matrix after fix

---

## 4. Rollback paths

### 4.1 Rollback during dry-run (days 1-3)

**Symptom:** Anything unexpected before day 4 (excess skipped_preconditions, runtime errors, drainer crashes).

**Action:**
```bash
# Disable the producer first (cheaper — stops new commands)
DELETE FROM platform_settings WHERE key = 'zb_outbound_job_create_enabled';
# Then stop the drainer
# (set ZB_OUTBOUND_ENABLED=false on Railway prod)
```

Cleanup queued rows:
```sql
DELETE FROM zb_outbound_commands WHERE user_id = 2 AND command_type = 'job.create';
```

State returned to pre-Phase-B baseline. No production data harmed (drainer was dry-run, no ZB-side writes happened).

### 4.2 Rollback during live mode (days 4-7)

**Symptom:** Live POSTs producing real-world side effects (wrong jobs created in ZB, 422s, 429s).

**Action (in order, fast):**
1. **Immediate freeze:** `ZB_OUTBOUND_GLOBAL_FREEZE=true` on Railway prod. Drainer ticks become no-op within 30s.
2. **Disable producer:** `DELETE FROM platform_settings WHERE key='zb_outbound_job_create_enabled'`.
3. **Triage:** for each live command that fired, decide whether the ZB-side state needs correcting via the ZB UI (operator-of-record action). The full audit lives in `zb_outbound_commands` + `delivery_log`.
4. **Cleanup-or-keep:** unconfirmed `sent` commands may not have reached ZB; conflicted/failed/timed-out need manual review per [runbook §3-4](./zb-outbound-runbook.md).

Target rollback time: **< 5 minutes from incident detection to drainer fully frozen.**

---

## 5. Sign-off requirement before activation

| Item | Operator confirms |
|---|---|
| Pre-activation gate (§1) complete | ☐ |
| Day-1 deploy steps (§2.1) understood and reproducible | ☐ |
| Verification matrix (§3) reviewed; assertions understood | ☐ |
| Rollback paths (§4) reviewed | ☐ |
| Calendar block for Day 1 confirmed | ☐ |
| Operator commits to running daily smoke check days 1-7 | ☐ |

**Activation greenlight is the operator's explicit decision based on this matrix. No further architectural review is required.**

---

## 6. Changelog

| Date | Change |
|---|---|
| 2026-05-17 | Initial deploy plan for Phase B activation. Implementation at commit 85e87c4. Dry-run verification matrix has 21 required + 2 informational checks. |
