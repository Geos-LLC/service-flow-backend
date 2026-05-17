# ZB Outbound — Operator Runbook (PC12)

**Status:** Draft v1 for Phase B.
**Audience:** SF backend operator on call during Phase B.
**Source documents:** [zb-outbound-command-confirmation.md](../architecture/zb-outbound-command-confirmation.md) (v0.5), [zb-api-verification.md](../architecture/zb-api-verification.md) (v0.3), [phase-b-readiness-v1.md](../architecture/phase-b-readiness-v1.md).

This runbook is operator-fast-reference. It does not explain WHY; it explains WHAT to do when a specific signal fires. For the architecture, read the design doc.

---

## 0. State of the world (per Phase A → Phase B transition)

- Phase A scaffolding lives in production. Drainer is NOT started (`ZB_OUTBOUND_ENABLED` unset). Zero commands in the queue.
- Phase B turns on `ZB_OUTBOUND_ENABLED=true` for one pilot tenant, behind a producer-side feature flag. Drainer starts but `ZB_OUTBOUND_GLOBAL_FREEZE=false` enables real outbound traffic.
- All queries in this runbook are tenant-scoped where the tenant id matters. Replace `<USER_ID>` with the operator-of-record's `users.id`.

---

## 1. Daily smoke check

Run once per business day during Phase B soak (week 1).

```sql
-- Queue depth + state distribution
SELECT state, count(*) AS n
  FROM zb_outbound_commands
 WHERE requested_at > now() - interval '24 hours'
 GROUP BY state
 ORDER BY state;

-- Per-tenant DLQ size
SELECT user_id, count(*) AS dlq_size
  FROM zb_outbound_commands
 WHERE state IN ('failed', 'conflict', 'invalidated_by_upstream_terminal_state')
 GROUP BY user_id
 ORDER BY dlq_size DESC;

-- Recent confirmation latency (ms from sent_at to confirmed_at)
SELECT command_type,
       count(*) AS n,
       round(avg(extract(epoch from (confirmed_at - sent_at))) * 1000) AS avg_ms,
       round(percentile_cont(0.5) within group (order by extract(epoch from (confirmed_at - sent_at)) * 1000)) AS p50_ms,
       round(percentile_cont(0.95) within group (order by extract(epoch from (confirmed_at - sent_at)) * 1000)) AS p95_ms
  FROM zb_outbound_commands
 WHERE state = 'confirmed'
   AND sent_at IS NOT NULL
   AND confirmed_at IS NOT NULL
   AND confirmed_at > now() - interval '24 hours'
 GROUP BY command_type;

-- Drift signals
SELECT (SELECT count(*) FROM ledger_drift_detected WHERE detected_at > now() - interval '24 hours') AS drift_24h,
       (SELECT count(*) FROM zb_sync_dirty WHERE resolved_at IS NULL) AS dirty_open;
```

**Healthy state baseline (week 1):**
- `pending` + `sending` together: ≤ 50 rows for any single tenant
- `failed` + `conflict`: ≤ 5 rows per tenant per day
- P95 confirmation latency: < 5 minutes for any `command_type`
- `drift_24h` and `dirty_open`: both 0 in steady state

If any baseline is broken, follow §3 (DLQ triage) or §4 (conflicts), depending on the signal.

---

## 2. Freeze procedure

### 2.1 When to freeze

- ZB API is returning sustained 5xx (>10% of POSTs over 5 min) → freeze
- Producer-side bug suspected (e.g., spike in `failed` rows with same `last_error` pattern) → freeze
- Pilot tenant requests pause → freeze
- Suspicious volume spike → freeze pending investigation
- Planned maintenance (SF or ZB side) → freeze before window

### 2.2 How to freeze

```bash
# Set env var on Railway prod environment
RAILWAY_TOKEN=$(aws secretsmanager get-secret-value --secret-id geos-dashboard-tokens --region us-east-1 \
  --query 'SecretString' --output text | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).RAILWAY_TOKEN))")

PROD_ENV='31371339-0521-4d17-8ce8-28f5dc7c8423'
SVC='eed7aa3a-8030-4d56-9bf2-a8c8ff18dbf7'
PROJ='672437e4-9791-43c4-aa01-5181f3bd1904'

curl -s "https://backboard.railway.com/graphql/v2" \
  -H "Authorization: Bearer $RAILWAY_TOKEN" -H "Content-Type: application/json" \
  -d "{\"query\":\"mutation { variableUpsert(input: { projectId: \\\"$PROJ\\\", environmentId: \\\"$PROD_ENV\\\", serviceId: \\\"$SVC\\\", name: \\\"ZB_OUTBOUND_GLOBAL_FREEZE\\\", value: \\\"true\\\" }) }\"}"
```

Railway will redeploy automatically (~30s). Confirm with:

```bash
# Loki query
{service_name="service-flow-backend"} |= "drainer tick skipped — ZB_OUTBOUND_GLOBAL_FREEZE=true"
```

You should see this line once per minute per replica.

### 2.3 What happens during freeze

- Producers continue to INSERT new commands into the queue (they pile up at `state='pending'`).
- Drainer ticks: acquires advisory lock, runs stale-lease sweep (keeps queue health intact), **skips claim** with `frozen` reason.
- Stage 2 (`state='sent'`) commands continue to flow to `confirmed` via the inbound webhook handler — freeze is outbound-only.
- Reconcile continues unchanged.

### 2.4 How to unfreeze

```bash
curl -s "https://backboard.railway.com/graphql/v2" \
  -H "Authorization: Bearer $RAILWAY_TOKEN" -H "Content-Type: application/json" \
  -d "{\"query\":\"mutation { variableUpsert(input: { projectId: \\\"$PROJ\\\", environmentId: \\\"$PROD_ENV\\\", serviceId: \\\"$SVC\\\", name: \\\"ZB_OUTBOUND_GLOBAL_FREEZE\\\", value: \\\"false\\\" }) }\"}"
```

Drainer resumes within ~10 seconds of the redeploy completing. Watch for the queue to drain.

**Communication checklist before lifting freeze:**
- [ ] Root cause of the freeze is identified and fixed
- [ ] Bad rows in the queue (if any) are cancelled or fixed
- [ ] Operator-of-record acknowledges
- [ ] Pilot tenant notified if outage was customer-visible

---

## 3. DLQ triage

When `failed` count spikes, follow this decision tree.

### 3.1 Identify the failure_class

```sql
SELECT last_error, count(*)
  FROM zb_outbound_commands
 WHERE state = 'failed'
   AND user_id = <USER_ID>
   AND terminal_at > now() - interval '24 hours'
 GROUP BY last_error
 ORDER BY count DESC;
```

### 3.2 Response by class

| `last_error` pattern | Response |
|---|---|
| `http 422: missing required parameter: <name>` | Producer-side payload bug. Freeze if multiple commands affected. Inspect `payload_json` of the failing row. Fix producer; retry the row(s) via §3.4. |
| `http 401` | Auth misconfigured. Pause; do not retry. Check `users.zenbooker_api_key` for the affected tenant. Resolve and re-arm. |
| `http 404: object with this id does not exist` | The target ZB resource was deleted upstream after the command was queued. Mark `cancelled` (§3.5); the producer's intent is now meaningless. |
| `network: ECONNRESET` / `network: ETIMEDOUT` | Transient. Already retried up to 5 attempts. Re-arm (§3.4); if it fails again, escalate ZB-side. |
| `http 429` | Rate-limited. Check pilot tenant ZB quota (PC14). Reduce drainer batch size or freeze until usage normalizes. |
| `phase_a_scaffolding` | Stale rows from Phase A scaffolding period. Check the `requested_at` timestamp; safe to DELETE manually if pre-Phase-B. |

### 3.3 Inspect a single failed row

```sql
SELECT event_id, command_type, sf_job_id, attempts, last_error, terminal_at,
       payload_json, source_revision, zb_response
  FROM zb_outbound_commands
 WHERE id = '<UUID>';
```

### 3.4 Re-arm a failed row

```sql
UPDATE zb_outbound_commands
   SET state = 'pending',
       attempts = 0,
       next_attempt_at = now(),
       claimed_by = NULL,
       claimed_until = NULL,
       last_error = NULL,
       defer_reason = NULL,
       terminal_at = NULL
 WHERE id = '<UUID>'
   AND state = 'failed';
```

The `event_id` is unchanged — ZB's idempotency (if supported per Q1) still applies.

### 3.5 Cancel a row (intent no longer valid)

```sql
UPDATE zb_outbound_commands
   SET state = 'cancelled',
       terminal_at = now(),
       last_error = 'manual_cancel: <reason>'
 WHERE id = '<UUID>'
   AND state IN ('failed', 'pending', 'conflict');
```

---

## 4. Conflict resolution

Conflicts mean ZB state diverged from the producer's intent between queue time and send time. The design (§6.3) defines three triggers, all surfaced as `state='conflict'`.

### 4.1 Inspect open conflicts

```sql
SELECT id, event_id, command_type, sf_job_id, conflict_metadata,
       source_revision, intent_hash, payload_json, requested_at
  FROM zb_outbound_commands
 WHERE state = 'conflict'
   AND user_id = <USER_ID>
 ORDER BY requested_at DESC;
```

### 4.2 Decision: retry-from-current vs. accept-ZB-state vs. manual

`conflict_metadata` will show: `{expected_revision, observed_revision, diff}`.

| Scenario | Action |
|---|---|
| Manager edited same field in ZB UI between queue and send. Producer's intent is still desired, just from a new base. | **Retry from current state.** DELETE this row; producer (or operator) re-issues the command with fresh `source_revision`. |
| ZB state moved in a way that makes the producer's intent moot (e.g., job cancelled). | **Accept ZB state.** Cancel the command (§3.5 with reason `superseded_by_zb_state`). |
| Diff doesn't make sense (e.g., job's customer changed, but command was scheduling) | **Manual.** Investigate. Likely a producer-side bug; freeze the relevant command_type per §2.2 then debug. |

### 4.3 Audit operator decisions

Every conflict resolution writes a `delivery_log` audit row with `eventType='zb_outbound.conflict_resolved'` and `context={resolution, operator}`. Use this to track operator workload during week 1.

---

## 5. Ambiguous-pending review

Per design §3.5, `state='ambiguous_pending_review'` should rarely fire — Q2 resolution (2026-05-17) established EXACT correlation as the norm. If it does fire:

```sql
SELECT id, event_id, command_type, sf_job_id, payload_json, intent_hash,
       conflict_metadata, sent_at, correlation_confidence
  FROM zb_outbound_commands
 WHERE state = 'ambiguous_pending_review'
   AND user_id = <USER_ID>;
```

Operator decides: confirm this command, mark as conflict, or mark as superseded. SQL is the same as §3.5/§4.2 with appropriate `state` target.

---

## 6. Migration re-arm

When a migration-origin command (`origin='migration'`) fails, design §3.7 says no automatic retry. The migration batch operator must explicitly decide whether to re-run.

```sql
-- Inspect all migration-origin failures
SELECT id, event_id, command_type, sf_job_id, attempts, last_error, terminal_at
  FROM zb_outbound_commands
 WHERE state = 'failed'
   AND origin = 'migration'
 ORDER BY terminal_at DESC;
```

Re-arm with §3.4. Audit who decided to re-arm in `delivery_log`.

---

## 7. Sample issues to watch for in Phase B week 1

These are anticipated based on the design's known risks (§7 of phase-b-readiness-v1.md). If any appear, follow the response.

| Signal | Likely cause | Response |
|---|---|---|
| Sudden spike in `pending` count for one tenant | Drainer stopped, OR producer firing faster than drainer drains | Check `[ZB Outbound] Drainer started` lifecycle log; verify advisory lock isn't stuck. |
| Spike in `failed` with same `last_error` | Producer bug | Freeze (§2.2). Inspect a failing row's `payload_json`. Fix producer; re-arm rows. |
| Webhook arrival latency P95 > 60s | ZB-side webhook delivery degraded | Check ZB status page if visible. Soft-fail: confirmation_deadline (10 min default) will eventually fail open into `confirm_timeout`, then reconcile catches up. |
| `correlation_confidence='probable'` count > 0 | ZB started emitting different/extra event types | Investigate the sample bodies via [ZB-body-observe] (re-enable if needed). May need to update §3.5 correlation table. |
| Supersession chain depth > 5 for same job in <60s | UI emitting duplicate intents OR runaway automation | Check `origin` distribution. If `automation`, pause the rule. |
| Zero confirmations in 1+ hour | Webhook handler crashing, OR ZB stopped delivering | Check `[Zenbooker] Webhook received` lines in Loki. If silent, ZB-side issue. If active, SF correlation step bug — inspect handler logs. |
| `reconcile`-origin command appears | §2.5 invariant breached | **Critical**. Page on-call. Reconcile is convergence-only and MUST NOT generate commands. |

---

## 8. Useful one-liners

```bash
# Get current freeze state (Railway env var)
curl -s "https://backboard.railway.com/graphql/v2" \
  -H "Authorization: Bearer $RAILWAY_TOKEN" -H "Content-Type: application/json" \
  -d "{\"query\":\"query { variables(projectId: \\\"$PROJ\\\", environmentId: \\\"$PROD_ENV\\\", serviceId: \\\"$SVC\\\") }\"}" \
  | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const v=JSON.parse(d).data.variables;console.log('ENABLED:',v.ZB_OUTBOUND_ENABLED||'(unset)');console.log('FREEZE:',v.ZB_OUTBOUND_GLOBAL_FREEZE||'(unset)');console.log('DRY_RUN:',v.ZB_OUTBOUND_DRY_RUN||'(unset)');});"

# Last 10 [ZB Outbound] log lines
curl -s -G "https://info3d7b.grafana.net/api/datasources/proxy/7/loki/api/v1/query_range" \
  -H "Authorization: Bearer $GRAFANA_SA_TOKEN" \
  --data-urlencode 'query={service_name="service-flow-backend"} |= "[ZB Outbound]"' \
  --data-urlencode "start=$(( ($(date -u +%s) - 600) * 1000000000 ))" \
  --data-urlencode "end=$(( $(date -u +%s) * 1000000000 ))" \
  --data-urlencode 'limit=10' --data-urlencode 'direction=backward'

# Drainer health (count of ticks per minute over last hour — should be ~12 per minute per replica)
{service_name="service-flow-backend"} |= "[ZB Outbound]"
| count_over_time([1m])
```

---

## 9. Escalation

| Severity | Trigger | Who to page |
|---|---|---|
| **Critical** | `reconcile`-origin command appears OR settled-batch mutation attempted OR ledger_drift_detected spike | On-call backend lead + constitution authority |
| **High** | Freeze in place > 4 hours unplanned OR DLQ size > 50 for any tenant | Backend lead |
| **Medium** | Sustained P95 latency > 15 min OR conflict rate > 5% | Operations daily |
| **Low** | Single failed row, normal latency, no pattern | Add to triage queue, no immediate action |

---

## 10. Glossary (quick reference)

- **Command:** A row in `zb_outbound_commands` representing one SF→ZB intent.
- **Drainer:** The worker at `workers/zb-outbound-drainer.js` that claims and processes pending commands.
- **Freeze:** Operator-controlled pause where the drainer stops claiming but the queue keeps accepting. Outbound-only — inbound unchanged.
- **Field group:** Partition of commands by which ZB resource fields they mutate. See [design §6.9](../architecture/zb-outbound-command-confirmation.md).
- **Supersession:** Newer command in the same field-group replaces an older one. See [design §6.8](../architecture/zb-outbound-command-confirmation.md).
- **Origin:** Which subsystem produced the command. See [design §3.7](../architecture/zb-outbound-command-confirmation.md).
- **`webhook_id`:** ZB's per-event identifier (resolved via Q2-B sampling on 2026-05-17). Used for inbound dedup.

---

## 11. Changelog

| Date | Version | Change |
|---|---|---|
| 2026-05-17 | v1 draft | Initial draft for Phase B. Sections 0–10 cover daily smoke, freeze, DLQ triage, conflicts, ambiguous review, migration re-arm, week-1 watchlist, one-liners, escalation, glossary. |
