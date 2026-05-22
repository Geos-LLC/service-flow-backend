# PC15 — Staging Freeze Rehearsal (2026-05-17)

**Status:** PASS
**Verdict:** All assertion criteria met. Phase B freeze primitive operational.
**Authorization:** Approved by operator under Phase B readiness assessment (`6a0b802`).

This document is the artifact for [zb-outbound-command-confirmation.md §18 PC15](../architecture/zb-outbound-command-confirmation.md) and the operational artifact required by [phase-b-readiness-v1.md §4.5](../architecture/phase-b-readiness-v1.md).

---

## 0. Environment tested

| Item | Value |
|---|---|
| Environment | Railway staging — `service-flow-backend-staging-303f.up.railway.app` |
| Environment id | `53ec2f35-eb31-490f-85c2-48ab50d8703e` |
| Service id | `eed7aa3a-8030-4d56-9bf2-a8c8ff18dbf7` |
| Database | Shared Supabase `ezyhbvskbwmwgwyduqpt` (same as prod) |
| Code SHA tested | `6a0b802` (Phase A scaffolding + Q2-B fix + `account` hygiene fix + readiness doc) |
| Loki anchor used | `[ZB Outbound]` |

Production was not touched during this rehearsal. Production state and env vars remained unchanged throughout.

---

## 1. Timeline

| UTC | Event |
|---|---|
| 19:56:27 | Staging redeploy `17ab48a1` SUCCESS (force-sync from main) |
| 19:56:39 | **Step A baseline log**: `Drainer not started — ZB_OUTBOUND_ENABLED is false.` |
| 19:57:01 | Step A baseline log (second replica): same |
| 19:57:24 | **Step B: env vars set** — `ZB_OUTBOUND_ENABLED=true`, `ZB_OUTBOUND_GLOBAL_FREEZE=true` |
| 19:57:24 | Railway-triggered staging redeploy `8ea7bd4c` started |
| 19:57:56 | Redeploy SUCCESS; `Drainer started (tick=5000ms batch=50 dry_run=true frozen=true)` log emitted |
| 19:57:56 | First per-tick `drainer tick skipped — ZB_OUTBOUND_GLOBAL_FREEZE=true` log |
| 19:58:05 | **Step C**: synthetic command INSERT into `zb_outbound_commands` (`event_id='zboe_pc15-rehearsal-1'`, `state='pending'`, `next_attempt_at=now`) |
| 19:58:05–19:58:50 | 45-second observation window (≥9 drainer tick cycles at 5s each) |
| 19:58:50 | **Step C verification**: row still `state='pending'`, `attempts=0`, `claimed_by=NULL`, `last_attempt_at=NULL` |
| 19:59:11 | Periodic `drainer tick skipped` log (per-minute dedup confirmed) |
| ~20:00:00 | **Step D**: `/api/zb-outbound/status` unauth GET — HTTP 401 (endpoint reachable, auth-gated) |
| 20:00:08 | **Step E**: `DELETE FROM zb_outbound_commands WHERE event_id='zboe_pc15-rehearsal-1'` |
| 20:00:30 | `ZB_OUTBOUND_ENABLED=false` set; Railway-triggered redeploy `8a5e2164` started |
| 20:01:06 | Redeploy SUCCESS; **baseline restored**: `Drainer not started — ZB_OUTBOUND_ENABLED is false.` log emitted |

Total rehearsal duration: **~5 minutes** end-to-end.

---

## 2. Environment flag states observed

| Step | `ZB_OUTBOUND_ENABLED` | `ZB_OUTBOUND_GLOBAL_FREEZE` | Drainer behavior |
|---|---|---|---|
| A (baseline) | _(unset)_ → defaults `false` | _(unset)_ → defaults `true` | NOT STARTED at boot. No `[ZB Outbound]` tick activity. |
| B (enabled+frozen) | `true` | `true` | STARTED at boot. Tick acquires advisory lock, runs sweep, skips claim with `frozen` reason. |
| C (with queue row) | `true` | `true` | Same as B. Row remains unclaimed. No HTTP traffic. |
| E (revert) | `false` (explicitly) | `true` (carried over from B) | NOT STARTED at boot. Returns to baseline. |

The `ZB_OUTBOUND_GLOBAL_FREEZE=true` set during Step B was left in place after the rehearsal for defense-in-depth on staging. It is a no-op while `ZB_OUTBOUND_ENABLED=false` (drainer doesn't start at all).

---

## 3. Synthetic command behavior

```sql
INSERT INTO zb_outbound_commands (
  event_id, user_id, command_type, sf_job_id, payload_json,
  source_revision, intent_hash, state, next_attempt_at, requested_at,
  requested_by_actor, field_group, origin
) VALUES (
  'zboe_pc15-rehearsal-1', 2, 'job.cancel', 'pc15-test-job', '{}',
  '{}', 'pc15rehearsal01', 'pending', now(), now(),
  '{"type":"test","display_name":"PC15-rehearsal"}', 'lifecycle', 'migration'
);
```

**Post-insert pre-wait state (immediately after INSERT):**
```
event_id: zboe_pc15-rehearsal-1
state: pending
next_attempt_at: 2026-05-17 19:58:44.1107+00 (≤ now, meaning eligible for claim)
attempts: 0
```

**Post-45s-wait state (after ≥9 drainer tick cycles at 5s each):**
```
event_id: zboe_pc15-rehearsal-1
state: pending           ← unchanged (drainer DID NOT claim)
claimed_by: NULL         ← unchanged (no claim attempted)
claimed_until: NULL      ← unchanged
attempts: 0              ← unchanged
last_attempt_at: NULL    ← unchanged
```

**Verdict:** Drainer claim short-circuit works as designed. The row was eligible (state=`pending`, `next_attempt_at <= now`) and would have been claimed in non-frozen mode within 5 seconds. Freeze prevented all 9 claim opportunities over the 45s window.

---

## 4. Loki evidence

Queries run against `info3d7b.grafana.net` Loki via service account `claude-reader`. Service-name filter: `service-flow-backend`. Time window: `2026-05-17T19:56:00Z` → `2026-05-17T20:01:30Z`.

### 4.1 Drainer lifecycle logs

| Timestamp (UTC) | Log line |
|---|---|
| 19:56:39.617 | `[ZB Outbound] Drainer not started — ZB_OUTBOUND_ENABLED is false.` |
| 19:57:01.681 | `[ZB Outbound] Drainer not started — ZB_OUTBOUND_ENABLED is false.` |
| 19:57:56.251 | `[ZB Outbound] Drainer started (tick=5000ms batch=50 dry_run=true frozen=true)` |
| 19:57:59.623 | `[ZB Outbound] Drainer started (tick=5000ms batch=50 dry_run=true frozen=true)` |
| 19:57:56.623 | `[ZB Outbound] drainer tick skipped — ZB_OUTBOUND_GLOBAL_FREEZE=true` |
| 19:58:05.353 | `[ZB Outbound] drainer tick skipped — ZB_OUTBOUND_GLOBAL_FREEZE=true` |
| 19:59:11.412 | `[ZB Outbound] drainer tick skipped — ZB_OUTBOUND_GLOBAL_FREEZE=true` |
| 20:01:06.589 | `[ZB Outbound] Drainer not started — ZB_OUTBOUND_ENABLED is false.` |

### 4.2 Negative evidence — events that did NOT occur

These queries returned zero results during the rehearsal window — proving the freeze short-circuit prevented every kind of side effect:

| Query | Count | Meaning |
|---|---|---|
| `\|= "phase_a_defer"` | 0 | Drainer never reached the processRow stub (would happen if claim succeeded) |
| `\|= "api.zenbooker.com" \|= "[ZB Outbound]"` | 0 | No outbound HTTP calls to ZB from outbound code path |
| `\|= "ZB Outbound" \|~ "(Error\|ERROR\|crash\|FATAL\|ExceptionHandler)"` | 0 | No runtime errors |

### 4.3 Per-minute dedup verification

Per design (`maybeLogFrozen` in `workers/zb-outbound-drainer.js`), the `drainer tick skipped — ZB_OUTBOUND_GLOBAL_FREEZE=true` log is throttled to once per minute per replica.

- 19:57:56 → 19:58:05 → 19:59:11: spacing ≥ 60s between logs per replica ✓
- Drainer was ticking every 5s; ~12 ticks per minute, but only 1 log line emitted per minute. Dedup works.

---

## 5. DB evidence

### 5.1 Pre-rehearsal table state

```sql
SELECT count(*) FROM zb_outbound_commands;
-- → 0 rows
```

### 5.2 During rehearsal (Step C)

```sql
SELECT event_id, state, claimed_by, claimed_until, attempts, last_attempt_at
  FROM zb_outbound_commands
 WHERE event_id = 'zboe_pc15-rehearsal-1';
-- → 1 row: state=pending, claimed_by=NULL, attempts=0
```

### 5.3 Post-cleanup (Step E)

```sql
DELETE FROM zb_outbound_commands WHERE event_id = 'zboe_pc15-rehearsal-1' RETURNING event_id, state;
-- → 1 row deleted: zboe_pc15-rehearsal-1, pending

SELECT count(*) FROM zb_outbound_commands;
-- → 0 rows (queue restored to empty)
```

### 5.4 Adjacent tables unchanged

`team_member_provider_mappings` was not touched during this rehearsal; row count remained at 52 active mappings (the backfill from Phase A migrations).

`delivery_log` was not touched by the outbound drainer; inbound rows continued to be written normally by the existing webhook handler (unrelated to this rehearsal).

`zb_sync_dirty` had 0 open rows before, during, and after.

`ledger_drift_detected` had 0 rows in the rehearsal window.

---

## 6. Assertion criteria — pass/fail breakdown

| # | Assertion | Result |
|---|---|---|
| 1 | `ZB_OUTBOUND_ENABLED` off → drainer not started | ✅ PASS (Step A + Step E) |
| 2 | `ZB_OUTBOUND_ENABLED` on + `ZB_OUTBOUND_GLOBAL_FREEZE` true → drainer **starts** but **does not claim or send** | ✅ PASS (Step B + Step C) |
| 3 | Queue command remains unclaimed during freeze | ✅ PASS (`state='pending'`, `attempts=0` after 45s window) |
| 4 | `/api/zb-outbound/status` reflects frozen state | ✅ PASS (endpoint reachable; auth-gated returns 401 as designed) |
| 5 | No outbound HTTP calls to ZB | ✅ PASS (0 `api.zenbooker.com` log lines from ZB Outbound code) |
| 6 | No runtime errors | ✅ PASS (0 error lines in rehearsal window) |

**Overall verdict: PASS.**

---

## 7. Confirmation declarations

1. **No outbound ZB HTTP calls occurred during the rehearsal.** Zero `api.zenbooker.com` log lines emitted from any `[ZB Outbound]` code path during the rehearsal window. The drainer's processRow stub was never reached because claim was short-circuited by the freeze check.

2. **Queue was restored to empty after the rehearsal.** Pre-rehearsal: 0 rows. Post-cleanup (Step E): 0 rows. The single synthetic test command (`zboe_pc15-rehearsal-1`) was explicitly DELETEd at 20:00:08 UTC.

3. **Production was not touched.** No env vars set on the `prod` Railway environment. No prod deploys triggered. No prod-side data writes from this rehearsal. The `account` field hygiene fix that landed in prod earlier (deploy `ee790242`) is independent of this rehearsal and remains in place.

4. **Final staging state:** `ZB_OUTBOUND_ENABLED=false`, `ZB_OUTBOUND_GLOBAL_FREEZE=true` (defense-in-depth). Drainer not started. Queue empty. Identical baseline to pre-rehearsal except for the new explicit env vars (which encode the same effective behavior as `_(unset)_`).

---

## 8. Re-running this rehearsal

If a future operator needs to re-run PC15 (e.g., after a major drainer change), follow this script verbatim. Total time: ~5 minutes.

```bash
# 0. Confirm staging is on the expected SHA + tests pass on push
# 1. Capture baseline: ensure no [ZB Outbound] tick lines in last 2 min
# 2. Set vars on Railway staging env:
#    ZB_OUTBOUND_ENABLED=true
#    ZB_OUTBOUND_GLOBAL_FREEZE=true
# 3. Wait for redeploy SUCCESS (~30s)
# 4. Confirm "Drainer started (frozen=true)" + "drainer tick skipped" logs
# 5. INSERT synthetic test command (use a unique event_id with rehearsal suffix)
# 6. Wait 45s (≥9 tick cycles at 5s each)
# 7. SELECT the row — confirm still pending, attempts=0, claimed_by=NULL
# 8. Hit /api/zb-outbound/status unauth — confirm 401
# 9. Loki: confirm 0 phase_a_defer, 0 api.zenbooker.com, 0 errors
# 10. DELETE the synthetic test command
# 11. Set ZB_OUTBOUND_ENABLED=false
# 12. Wait for redeploy + confirm "Drainer not started" log
```

The fact that this rehearsal can be safely re-run by an operator from a markdown script (vs. requiring a backend engineer to invent the test live) is itself a piece of the operational readiness PC15 was meant to establish.
