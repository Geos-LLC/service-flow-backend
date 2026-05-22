# Phase B — Pilot Tenant Identification

**Status:** PC11 RESOLVED + PC14 RESOLVED (Option B — conservative cap).
**Authorization date:** 2026-05-17.
**Companion to:** [phase-b-readiness-v1.md](../architecture/phase-b-readiness-v1.md), [zb-outbound-runbook.md](./zb-outbound-runbook.md).

This artifact closes the two remaining Phase B blockers: pilot tenant identification (PC11) and ZB API quota posture (PC14). It does NOT authorize Phase B implementation to begin — that is a separate decision per the readiness doc's recommended sequence.

---

## 1. Pilot tenant (PC11)

| Field | Value |
|---|---|
| **SF user_id** | `2` |
| **Account email** | `sayapingeorge@gmail.com` |
| **ZB connection status** | `connected` (verified 2026-05-17) |
| **ZB API key location** | `service-flow-backend/.env` (`ZB_API_KEY=zbk_Q6Xvtr…`) — already accessible to operations |
| **Opt-in confirmation date** | 2026-05-17 |
| **Operator-of-record** | `sayapingeorge@gmail.com` (acting as both tenant owner AND Phase B operator-of-record) |
| **Rollback owner** | Same as operator-of-record (single point of escalation — fast on-call chain) |

### 1.1 Test artifacts available in this tenant

These resources exist in the pilot tenant from prior discovery + sampling work and are pre-labelled as test/synthetic:

| Resource | ID | Purpose |
|---|---|---|
| Customer | `1762727062342x429033698777366500` ("Test Customer") | Test customer with fake-but-controllable contact info (operator-owned phone + email). Safe target for `customer.upsert` testing. |
| Job | `1778965722485x761465706166878200` (Job #352291 — "Deep Cleaning for Test Customer") | Currently `scheduled`. Used for assign discovery (2026-05-16) and customer-edit / reschedule / providers-assigned samples (2026-05-17). Safe target for `job.reschedule`, `job.assign_providers`, `job.cancel`. |
| Provider P1 | `1764956793274x252293186620751870` ("Georgiy Sayapin") | First test team member. Currently assigned to Job #352291. |
| Provider P2 | `1778965346174x342729486067564540` ("Test team member") | Second test team member. Available as swap target. |

### 1.2 Rationale

1. **Already exercised in 2026-05-16 controlled discovery.** The provider-assignment endpoint (`POST /v1/jobs/{id}/assign`) was discovered against this tenant with 4 bounded attempts; cleanup was clean.
2. **Already exercised in 2026-05-17 Q2-B sampling.** 12 real ZB webhooks were captured from manager-initiated UI actions on this tenant's Test Customer + Job #352291. No regression, no data corruption.
3. **Existing labelled-test setup.** Test Customer's contact info (`prorabserv@gmail.com`, `georgiysayapin@gmail.com`, fake-but-operator-owned phones) means any accidental ZB-side customer notification reaches the operator, not a real customer. Lowest blast radius.
4. **Existing API access path.** API key + Loki access + Railway management already in operator hands. No new credential provisioning needed.
5. **Operator-of-record already established.** Same person made all prior bounded decisions; on-call chain is one person, no coordination overhead.
6. **No additional opt-in workflow needed.** The same tenant has been operating under bounded authorizations for ~36 hours (since 2026-05-16) without incident.

### 1.3 Rollback procedure

If Phase B activity in this pilot tenant causes any issue:

1. **Immediate stop:** set `ZB_OUTBOUND_GLOBAL_FREEZE=true` on prod via Railway (operator runbook §2.2). Drainer ticks become no-op within 30 seconds of redeploy.
2. **Operator-of-record investigates.** If the issue is producer-side, freeze stays until producer is fixed. If ZB-side, freeze stays until ZB issue resolves.
3. **DLQ triage** per runbook §3 — every failed/conflict row inspected, cancelled or re-armed individually.
4. **State reset (only if necessary):** for the pilot tenant only, DELETE from `zb_outbound_commands WHERE user_id=2 AND state IN ('pending','sending','failed','conflict')`. Manual state recovery on the affected job(s) via the ZB UI by the operator-of-record.

Rollback time target: **< 5 minutes from incident detection to drainer fully frozen.**

---

## 2. Quota posture (PC14, Option B)

### 2.1 Decision

**Conservative cap chosen** without waiting for ZB support reply to Q9. Rationale: getting Phase B started is higher value than the precise rate limit, and the drainer's existing 429 retry path provides a safety net.

### 2.2 Cap value

| Variable | Value | Effect |
|---|---|---|
| `ZB_OUTBOUND_BATCH_SIZE` | `5` (overrides default 50) | Drainer claims at most 5 rows per tick |
| `ZB_OUTBOUND_TICK_MS` | `5000` (unchanged from default) | One tick every 5 seconds |
| **Theoretical max rate** | **60 commands/minute** | 5 × (60s / 5s) = 60 |
| **Practical max rate** | **~12 commands/minute** | Real claims < batch size when queue is small |

### 2.3 Rationale for the specific cap

- **Observed inbound traffic for this tenant:** ~13 ZB webhook deliveries during a ~3-hour active period on 2026-05-17 (manager-driven UI activity). Extrapolation: 50-100 webhooks/day at peak activity.
- **Phase B `job.create` outbound:** would roughly double per-job ZB API touch (1 POST per new job + possibly 1 retry GET). Marginal Phase B outbound is proportional to current inbound, not dominant.
- **Conservative ceiling:** 60 commands/minute is well below any plausible per-tenant rate limit (most SaaS APIs cap at 60-600 req/min/tenant). Even if ZB caps at 60/min, we hit the cap with margin to spare.
- **Defense-in-depth:** drainer's existing 429 retry schedule (0/10s/60s/10m/1h, 5 attempts then DLQ per design §3.3) absorbs any rate-limit hits without operator action on the first occurrence.

### 2.4 Expected max command rate during Phase B week 1

| Period | Producer-side activity | Estimated commands/day |
|---|---|---|
| Dry-run period (days 1-3) | Producer emits commands; drainer builds + signs but doesn't POST | 0 actual ZB POSTs |
| Live mode (days 4-7) | `job.create` enabled on pilot tenant only | ≤ 10 commands/day for this tenant's typical activity |

The 60/minute cap leaves >6x headroom over the highest plausible bursts.

### 2.5 429 handling

If ZB returns `429 Too Many Requests`:

1. The drainer's `retryOrDlq` path applies the network/5xx/429 backoff schedule: `0s, 10s, 60s, 10m, 1h` retry attempts. (See `workers/zb-outbound-drainer.js` retry logic — same shape as LB outbound.)
2. After 5 attempts of 429, the command transitions to `state='failed'` with `last_error='http 429: …'`.
3. The DLQ entry surfaces in `/api/zb-outbound/dlq` and in the runbook §3 table.

A single 429 on a single command is **not actionable** by the operator (drainer auto-retries). A pattern of 429s across multiple commands is **actionable** — see §2.7 escalation.

### 2.6 Week-1 monitoring requirement

During Phase B week 1 (days 1-7), the operator MUST run these queries daily (also in [runbook §1](./zb-outbound-runbook.md#1-daily-smoke-check)):

```sql
-- 429 detection: did any command see a 429 response?
SELECT count(*) AS rate_limited_24h,
       count(DISTINCT user_id) AS tenants_affected
  FROM zb_outbound_commands
 WHERE last_error LIKE 'http 429%'
   AND last_attempt_at > now() - interval '24 hours';

-- Effective rate: how fast is the drainer actually working?
SELECT date_trunc('hour', sent_at) AS hour,
       count(*) AS commands_sent
  FROM zb_outbound_commands
 WHERE sent_at > now() - interval '24 hours'
 GROUP BY 1
 ORDER BY 1 DESC;

-- Burst check: did we ever exceed 60 in one minute?
SELECT date_trunc('minute', sent_at) AS minute,
       count(*) AS sent_in_minute
  FROM zb_outbound_commands
 WHERE sent_at > now() - interval '24 hours'
 GROUP BY 1
 HAVING count(*) > 50
 ORDER BY 1 DESC;
```

**Expected steady state for week 1:** 0 rate_limited rows. Per-hour command rate well under 60.

### 2.7 Escalation path if 429 appears

| Trigger | Response |
|---|---|
| Single 429 on one command, auto-retry succeeds | **No action.** Note in daily smoke check log. |
| 5+ 429s on different commands in 1 hour | **Soft escalation.** Reduce `ZB_OUTBOUND_BATCH_SIZE` to `2`. Continue monitoring. |
| Rate-limited commands hitting DLQ (`failed` state with `last_error LIKE 'http 429%'`) | **Hard escalation.** Set `ZB_OUTBOUND_GLOBAL_FREEZE=true`. Contact ZB support with: tenant id, time of incident, observed rate. Ask Q9 + report the 429 spike. Resume after ZB confirms quota headroom. |
| Sustained 429s across all command types | **Critical escalation.** Freeze. Page on-call. Investigate whether ZB changed quota policy. |

---

## 3. State checks (these gates must hold before Phase B activation)

Pre-flight before flipping `ZB_OUTBOUND_ENABLED=true` on prod:

- [ ] Phase A scaffolding deployed in prod (✅ verified 2026-05-17 — deploy `ee790242`)
- [ ] `zb_outbound_commands` table present + queryable (✅ verified)
- [ ] All 4 RPCs present (✅ verified)
- [ ] `team_member_provider_mappings` populated (✅ 52 active mappings)
- [ ] `ZB_OUTBOUND_GLOBAL_FREEZE` defaults true (defense-in-depth) — operator sets to `false` explicitly when ready for live mode
- [ ] `ZB_OUTBOUND_BATCH_SIZE=5` set on prod (this doc's PC14 decision)
- [ ] `ZB_OUTBOUND_DRY_RUN=true` set for the first 3 days (per readiness §5.2 dry-run period)
- [ ] Pilot tenant opt-in confirmed (✅ this doc)
- [ ] Operator runbook reviewed by operator-of-record (📄 [zb-outbound-runbook.md](./zb-outbound-runbook.md))
- [ ] Daily smoke check schedule in place

---

## 4. Changelog

| Date | Change |
|---|---|
| 2026-05-17 | Initial document. PC11 closed (pilot tenant = user_id 2). PC14 closed via Option B (conservative cap `ZB_OUTBOUND_BATCH_SIZE=5`, monitoring + escalation defined). |
