# Phase B — Readiness Assessment v2

**Date:** 2026-05-17
**Status:** **All Phase B blockers closed. Remaining items are rollout controls only.**
**Supersedes:** [phase-b-readiness-v1.md](./phase-b-readiness-v1.md) (v1 remains as the historical record of the gate sequence).

This document is the formal statement that Phase B has passed every gate the design + operational planning surfaced. No further pre-implementation work is required. The next decision is a rollout decision, not a readiness decision.

---

## 1. Headline

> **All Phase B blockers are closed.** PC1 through PC15 have either reached RESOLVED status or are formally classified as soft-stops (informational, not gating). The remaining work to land Phase B traffic is rollout controls — env-var flips, producer feature flags, dry-run-then-live sequencing, and soak gates — not blocker closure.

---

## 2. Final blocker matrix

| ID | Item | Status | Evidence / Reference |
|---|---|---|---|
| PC1 | Q1 Idempotency-Key | **Soft stop** (informational; design intact under assumed-unsupported) | [zb-api-verification.md §1.1](./zb-api-verification.md), discovery commit `a1076eb`'s predecessor (2026-05-16) showed ZB does not echo the header |
| PC2a — `assign` | Q2-A for `job.assign_providers` | ✅ **RESOLVED** 2026-05-16 | Discovery: 2 mutations, single event, no fan-out |
| PC2a — other commands | Q2-A for reschedule/cancel/create/customer | ✅ **RESOLVED** 2026-05-17 | 12 real prod samples; 5 event types; 0 fan-out across all command types |
| PC2b | Q2-B event-level id (`body.webhook_id`) | ✅ **RESOLVED** 2026-05-17 | 12/12 samples carried `webhook_id` at top level |
| PC2c | Q3 assign endpoint | ✅ **RESOLVED** 2026-05-16 | `POST /v1/jobs/{id}/assign` with diff body `{assign, unassign, notify}` |
| PC3 | Freeze switch design | ✅ Done | [Design §17](./zb-outbound-command-confirmation.md) |
| PC4 | Supersession semantics | ✅ Done | [Design §6.8](./zb-outbound-command-confirmation.md) |
| PC5 | Ambiguity correlation rules | ✅ Done | [Design §3.5.1–§3.5.3](./zb-outbound-command-confirmation.md) |
| PC6 | Observability spec | ✅ Done | [Design §16](./zb-outbound-command-confirmation.md) |
| PC7 | `webhook_delivery_log` live | ✅ Complete on main | P1.6, commit `c6b136b` |
| PC8 | `zb_sync_dirty` live | ✅ Complete on main | P1.2, commit `55442b7` |
| PC9 | P0.1 ledger DELETE guard live | ✅ Complete on main | P0.1, commit `0157b03` |
| PC10 | Constitution §10 contract tests | **Soft stop** (constitution-hygiene debt; not Phase B-gating) | 6 of 11 named files present; 5 missing tracked separately |
| **PC11** | **Pilot tenant identified** | ✅ **RESOLVED** 2026-05-17 | [phase-b-pilot-tenant.md §1](../operations/phase-b-pilot-tenant.md) — `user_id=2` (sayapingeorge@gmail.com) |
| **PC12** | **Operator runbook drafted** | ✅ **RESOLVED** 2026-05-17 | [zb-outbound-runbook.md](../operations/zb-outbound-runbook.md) — 11 sections covering daily smoke, freeze, DLQ, conflicts, ambiguous review, migration re-arm, watchlist, escalation |
| **PC13** | **§11 exceptions register empty for Phase B surfaces** | ✅ **VERIFIED** 2026-05-17 | Constitution §11 register reads `_(none)_` |
| **PC14** | **Pilot tenant ZB quota** | ✅ **RESOLVED** 2026-05-17 — Option B (conservative cap) | `ZB_OUTBOUND_BATCH_SIZE=5` (60/min ceiling); [phase-b-pilot-tenant.md §2](../operations/phase-b-pilot-tenant.md) |
| **PC15** | **Staging freeze rehearsal** | ✅ **PASS** 2026-05-17 | [zb-outbound-freeze-rehearsal-2026-05-17.md](../operations/zb-outbound-freeze-rehearsal-2026-05-17.md) — 5 steps, 6 assertions, 0 outbound HTTP, 0 errors |
| PC-Phase-A | Scaffolding implemented + tested | ✅ Complete | Commits `e521545` + `291211c` + migrations 044/045 |
| PC-Q2B-Instrument | Sampling deployed, captured, retired | ✅ Complete | `lib/zb-body-observe.js` + 13 real samples captured + row deleted post-resolution |
| PC-account-fix | `account_id` → `account` hygiene | ✅ Complete in prod | Commit `a1076eb`, deploy `ee790242` |

**Blockers remaining: 0.** PC1 and PC10 are formally classified as soft-stops, do not gate Phase B.

---

## 3. What's already operational in production

Verified as of 2026-05-17:

- **Schema:** `zb_outbound_commands` (BIGINT user_id, full v0.5 column set), `team_member_provider_mappings` (52 active mappings backfilled).
- **RPCs:** 4 functions (`zb_outbound_try_tick_lock`, `zb_outbound_release_tick_lock`, `zb_outbound_sweep_stale_leases`, `zb_outbound_claim_due`) — verified callable; advisory-lock key `0x5A42_4F42`.
- **Routes:** `/api/zb-outbound/*` 7 endpoints — all reachable, auth-gated (401 on unauth).
- **Drainer:** registered as a worker; inert (`ZB_OUTBOUND_ENABLED` unset on prod).
- **Q2-B instrumentation:** code present in `lib/zb-body-observe.js`; activation row was deleted post-resolution.
- **`account` field fix:** deployed in `ee790242`; next real ZB webhook will populate `delivery_log.context.zb_account_id` correctly.

---

## 4. Rollout controls (NOT blockers — these are dials, not gates)

These are the levers the operator will use **during Phase B activation**. They exist now and are well-documented. They are not pre-conditions to start; they are the controls used during the start.

### 4.1 Environment variables (Railway prod)

| Variable | Default | Phase B day 1-3 (dry-run) | Phase B day 4-7 (live) | Notes |
|---|---|---|---|---|
| `ZB_OUTBOUND_ENABLED` | unset (= `false`) | `true` | `true` | Master kill switch. Drainer doesn't start until true. |
| `ZB_OUTBOUND_GLOBAL_FREEZE` | `true` (defensive default) | `false` | `false` | Operator-controlled pause without dropping intent. Drainer claims when false. |
| `ZB_OUTBOUND_DRY_RUN` | `true` (lib defaults) | `true` | `false` | Drainer builds + signs but does NOT POST when true. First live POST is when this flips. |
| `ZB_OUTBOUND_BATCH_SIZE` | `50` | `5` | `5` | PC14 conservative cap. 60/min ceiling. |
| `ZB_OUTBOUND_TICK_MS` | `5000` | `5000` | `5000` | Unchanged. |
| `ZB_OUTBOUND_LEASE_S` | `120` | `120` | `120` | Unchanged. |

### 4.2 Producer feature flag (per-tenant, in `platform_settings`)

Phase B introduces a producer hook in SF for `job.create` only. The producer reads `platform_settings.zb_outbound_job_create_enabled.value` (JSON list of opted-in `user_id`s). For pilot tenant only:

```sql
INSERT INTO platform_settings (key, value)
VALUES ('zb_outbound_job_create_enabled', '{"user_ids":[2]}');
```

Non-pilot tenants are unaffected because the producer no-ops when their `user_id` isn't in the list.

### 4.3 Soak gates (operator-judgement)

| Gate | Criterion | Action if passed | Action if failed |
|---|---|---|---|
| Dry-run → live transition (day 3 → day 4) | 0 build errors, 0 correlation false-positives in dry-run period | Flip `ZB_OUTBOUND_DRY_RUN=false` | Diagnose; extend dry-run; investigate producer/correlation logic |
| Week 1 → expand-pilot decision (day 7) | DLQ < 5, P95 latency < 5 min, 0 conflicts, 0 reconcile-origin commands | Either add second tenant for `job.create`, or add second command type (`job.cancel` recommended next — smallest body, simplest semantics) | Hold pilot at one tenant + one command type; investigate week-1 anomalies |
| Phase C entry | All Phase B exit criteria green for 14 consecutive days | Open Phase C scope (other command types) | Iterate Phase B |

### 4.4 The rollout sequence (per [phase-b-readiness-v1.md §5](./phase-b-readiness-v1.md))

**Week 0 (now):** All operational gates closed. ✅ This document.

**Week 1 (Phase B implementation):**
- B1: Producer wire-up for `job.create` (in SF UI's job-creation endpoint).
- B2: Drainer live mode for `job.create` command type only (replace processRow stub with real HTTP).
- B3: Correlation step in webhook handler (use `body.webhook_id` per Q2-B resolution).
- B4: Metrics emission per [design §16](./zb-outbound-command-confirmation.md).
- B5: Phase B contract tests per [design §11](./zb-outbound-command-confirmation.md).
- Days 1-3: env vars set per §4.1 dry-run column. Pilot tenant produces commands; drainer claims, builds, signs, but doesn't POST.
- Days 4-7: flip `ZB_OUTBOUND_DRY_RUN=false`. First real ZB POSTs.

**Week 2+ (Phase C onward):** per design §10.

---

## 5. Risk surface after readiness closure

The §7 risk table in readiness v1 stands; all mitigations are now in place via the operator runbook. Specifically:

- R1 (Producer payload bug) → caught by `validatePayload` + drops to DLQ; runbook §3.2 covers.
- R2 (Rate limit) → PC14 cap (60/min ceiling) + 429 retry path + runbook §3.2 + escalation §2.7.
- R3 (Correlation false-positive) → mitigated by Q2-B resolution (EXACT correlation reachable for all command types).
- R4 (Freeze fail) → mitigated by PC15 rehearsal (verified end-to-end).
- R5 (`job.create` body rejected) → 422 from ZB feeds back to DLQ; runbook §3.2 covers.
- R6 (Manager concurrent edit) → conflict path (§6.3) handles; operator triage per runbook §4.
- R7 (DLQ row without operator on call) → runbook §9 escalation matrix.
- R8 (New ZB event type) → "Unhandled event" branch in inbound handler logs but doesn't crash.

No newly-discovered risks during the readiness sequence.

---

## 6. Phase B implementation greenlight

This document represents the operational completion of pre-Phase-B readiness. The next decision is whether to proceed with Phase B code work, and **that decision is yours to make at a time of your choosing.**

The recommended sequence remains:

1. **You authorize Phase B implementation start.** (Single explicit decision.)
2. Backend lead writes B1–B5 (~3-5 days of focused work).
3. Operator follows the rollout schedule in §4.4.

There is no remaining empirical, design, or operational question outstanding. The architecture has been falsified against ZB's real behavior at every layer that could be tested without production traffic. The runbook anticipates the failure modes the design surfaced. The cap is conservative. The pilot tenant is low-blast-radius.

---

## 7. Changelog

| Date | Version | Change |
|---|---|---|
| 2026-05-17 | v1 | First Phase B readiness statement. Identified PC11–PC15 as remaining operational gates. |
| 2026-05-17 | **v2** | **All Phase B blockers closed.** PC11 resolved (pilot tenant = user_id 2). PC13 resolved (§11 register empty). PC14 resolved (Option B conservative cap, `ZB_OUTBOUND_BATCH_SIZE=5`). PC15 resolved (rehearsal PASS with artifact). PC12 runbook v1 drafted. Remaining items are rollout controls only, not blockers. Phase B implementation greenlight is now a single operator decision. |
