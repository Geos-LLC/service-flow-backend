# Phase B — Readiness Assessment v1

**Date:** 2026-05-17
**Status:** All ZB-side technical blockers resolved. Phase B is technically-ready but operationally-gated.
**Companion to:** [zb-outbound-command-confirmation.md](./zb-outbound-command-confirmation.md), [zb-api-verification.md](./zb-api-verification.md).

This document is the transition point: from "can we safely build SF→ZB outbound sync?" (answered: yes, by Phase A scaffolding + the Q1/Q2/Q3 resolution sequence) to "how do we operationally roll it out?"

---

## 1. Executive summary

| Question | Answer |
|---|---|
| Can Phase B start coding tomorrow? | Technically yes — every ZB-side hard stop is resolved. The producer hooks and drainer unfreeze are the implementation surface for Phase B. |
| Should it? | Not until 5 operational gates close (PC11-PC15). These are not code work — they're a pilot-tenant identification, an operator runbook, a quota confirmation, and a staging rehearsal. |
| Smallest safe first traffic? | `job.create` command type, dry-run mode (drainer signs + builds the payload but does NOT POST), one pilot tenant, soak for 7 days. Design §10 Phase B. |
| Risk that the design needs another iteration before Phase B? | Low. The 5 design rounds (v0.1 → v0.5) have answered every question the empirical work surfaced. No outstanding architectural questions. |

---

## 2. Updated blocker matrix (final state at 2026-05-17)

| ID | Item | Status | Notes |
|---|---|---|---|
| **PC1** | Q1 Idempotency-Key | **Soft stop** — assumed unsupported | Design §3.6.1 pre-flight check is primary retry-safety mechanism. Idempotency-Key header sent unconditionally as defense-in-depth. |
| **PC2a — `assign`** | Q2-A for `job.assign_providers` | ✅ RESOLVED 2026-05-16 (discovery) | Single event, no fan-out. EXACT correlation. |
| **PC2a — other commands** | Q2-A for reschedule/cancel/create/customer | ✅ RESOLVED 2026-05-17 (sampling) | 12 real prod samples, 5 event types, zero fan-out. EXACT correlation for all 5 Phase 1 command types. |
| **PC2b** | Q2-B event-level id | ✅ RESOLVED 2026-05-17 | Field is `body.webhook_id`. Present on 12/12 samples. SF inbound dedup should switch to this. |
| **PC2c** | Q3 assign endpoint | ✅ RESOLVED 2026-05-16 | `POST /v1/jobs/{id}/assign` with diff body `{assign, unassign, notify}`. |
| **PC3** | Freeze switch design | ✅ Done (design §17) | Implemented in drainer. |
| **PC4** | Supersession semantics | ✅ Done (design §6.8) | Schema columns + invariants in place. |
| **PC5** | Ambiguity correlation rules | ✅ Done (design §3.5.1–§3.5.3) | EXACT correlation now expected as the norm, not the exception. |
| **PC6** | Observability spec | ✅ Done (design §16) | Metrics defined; emission wires up in Phase B. |
| **PC7** | `webhook_delivery_log` live | ✅ Complete on main (P1.6) | Inbound rows being written. |
| **PC8** | `zb_sync_dirty` live | ✅ Complete on main (P1.2) | 0 open dirty rows currently. |
| **PC9** | P0.1 ledger DELETE guard live | ✅ Complete on main (P0.1) | `lib/ledger-immutability.js` enforces. |
| **PC10** | Constitution §10 contract tests | ⚠ Partial — soft stop | 6 of 11 named files present. 5 named-but-missing files (identity/source-account/status writer-funnel, webhook-pattern, tenant-scope) tracked as constitution-hygiene debt; do NOT gate Phase B. |
| **PC11** | Pilot tenant identified | ❌ Pending | **Phase B gate.** Needs: tenant ID, written opt-in, ZB account credentials access. |
| **PC12** | Operator runbook drafted | ❌ Pending | **Phase B gate.** Needs: DLQ triage steps, conflict resolution playbook, freeze procedure, migration re-arm steps. |
| **PC13** | Constitution §11 exceptions register empty | ✅ **VERIFIED 2026-05-17** — register is `_(none)_`; zero active exceptions touching Phase B surfaces (§3.1, §2.4, §6.10). |
| **PC14** | Pilot tenant ZB quota confirmed | ❌ Pending — needs ZB support reply (Q9) OR conservative estimate by operator |
| **PC15** | Staging freeze rehearsal | ✅ **PASS 2026-05-17** — see [zb-outbound-freeze-rehearsal-2026-05-17.md](../operations/zb-outbound-freeze-rehearsal-2026-05-17.md). 5-step rehearsal verified drainer-frozen short-circuit, synthetic command not claimed during 9 tick cycles, no outbound HTTP, no errors, queue restored to empty. |
| **PC-Phase-A** | Scaffolding implemented | ✅ Complete 2026-05-16 | Tables, RPCs, libs, drainer, router, 6 tests, 156/156 pass. |
| **PC-Q2B-Instrument** | Sampling deployed + retired | ✅ Complete 2026-05-17 | Captured 13 real prod samples. `platform_settings.zb_body_observe` row deleted post-resolution. |
| **PC-account-fix** | `account_id` → `account` field-name hygiene | ✅ Complete 2026-05-17 | Deployed in commit `a1076eb`. Next real webhook will populate `delivery_log.context.zb_account_id` (was previously always null). |

**Hard stops remaining:** PC11, PC12, PC14, PC15 (operational only).
**Soft stops remaining:** PC1 (informational; design intact either way), PC10 (constitution hygiene debt; doesn't gate Phase B).

---

## 3. What's truly ready (technical surface)

### 3.1 Schema and primitives
- `zb_outbound_commands` table with full v0.5 column set (16 columns including supersession, correlation_confidence, origin).
- `team_member_provider_mappings` table with 52 active mappings backfilled.
- 4 RPCs: `zb_outbound_try_tick_lock`, `zb_outbound_release_tick_lock`, `zb_outbound_sweep_stale_leases`, `zb_outbound_claim_due`. All callable; advisory-lock key `0x5A42_4F42` distinct from LB's.
- 5 indexes including `idx_zb_outbound_field_group_open` for supersession lookups.

### 3.2 Application code
- `lib/zb-outbound-delivery.js` — pure helpers (uuidv7, canonical hash, fingerprint, payload validation, command-row builder) with §4.4 diff-invariant enforcement.
- `workers/zb-outbound-drainer.js` — drainer with two-tier safety (ZB_OUTBOUND_ENABLED + ZB_OUTBOUND_GLOBAL_FREEZE). Phase A processRow is a deferring stub.
- `zb-outbound.js` — 7 operator endpoints (`/status`, `/`, `/dlq`, `/conflicts`, `/ambiguous`, `/unmapped-providers`, `/by-job/:id`) all tenant-scoped.
- `lib/zb-body-observe.js` — Q2-B instrumentation (retired; can be deleted in cleanup).

### 3.3 Tests
- 6 new test suites, 63 tests, 100% pass.
- Covers: drainer scaffolding, dedup, intent_hash determinism, tenant isolation source-scan, constitution-immutability scan, writer-funnel scan, Q2-B body-observe.

### 3.4 Production deployment state
- Migrations 044/045 applied on shared Supabase DB.
- Prod deployment `ee790242` includes Phase A + Q2-B fix + account hygiene fix.
- `ZB_OUTBOUND_ENABLED` env var unset → drainer not started.
- 0 commands in queue, 0 errors.

### 3.5 Empirical evidence (collected during the design rounds)
- ZB `POST /v1/jobs/{id}/assign` endpoint, body shape, response shape confirmed via 2026-05-16 discovery.
- ZB top-level webhook body shape confirmed via 2026-05-17 sampling: `{account, data, event, retry_count, type, webhook_id}`.
- `webhook_id` confirmed as stable per-event id (Q2-B = supported).
- No event fan-out for any of the 5 Phase 1 command types (Q2-A = single-event, all 5).
- Webhook latency ~2-3s P50 (small sample but consistent).
- Idempotency-Key not echoed by ZB (Q1 = assumed unsupported; design fallback in place).

---

## 4. What's not ready (operational surface)

### 4.1 PC11 — Pilot tenant identified

**Why it matters:** Phase B fires real outbound traffic to ZB. The pilot tenant absorbs first-week risk: if a producer-side bug creates 100 bad commands, that's 100 bad ZB operations on the pilot's account. Choose a tenant where:
- The tenant has explicitly opted in to first-week Phase B.
- Loss of one job's worth of ZB state would be recoverable manually.
- The tenant's manager is reachable in-hours for issue triage.

**Action:** Backend lead / customer success identifies and confirms one tenant. Recommendation: re-use the same tenant that already participated in the 2026-05-16 discovery + 2026-05-17 sampling. They've already opted in operationally for prior bounded work.

**Output artifact:** A short record in `docs/operations/phase-b-pilot-tenant.md` with the tenant id, opt-in confirmation date, and the operator-of-record's contact.

### 4.2 PC12 — Operator runbook

**Why it matters:** Phase B introduces new operator workflows that don't exist today: DLQ triage, conflict resolution, freeze-and-unfreeze, migration re-arming. Without a runbook, the operator has to read the design doc cold — that's the wrong moment for first-time learning.

**Sections required:**
1. **Daily smoke check** — what queries to run, what counts should look like.
2. **Freeze procedure** — when to flip `ZB_OUTBOUND_GLOBAL_FREEZE`, what to communicate.
3. **DLQ triage** — for each `failure_class`, the response path (retry / cancel / escalate / fix-payload).
4. **Conflict resolution** — three triggers (§6.3) and their UI walkthrough.
5. **Ambiguous-pending review** — even though we now expect EXACT correlation, the path exists; document operator decision tree.
6. **Migration re-arm** — when a migration-origin command fails, the manual re-arm SQL.
7. **Sample issues to look for in week 1** — wrong-tenant dispatch, supersession-chain-depth spikes, latency creeping past 60s.

**Action:** Operations writes this. Probably 1-2 days of work. The design doc has all the source material; this is a re-presentation for operator-fast-reference.

**Output artifact:** `docs/operations/zb-outbound-runbook.md`.

### 4.3 PC13 — Constitution §11 exceptions register

**Why it matters:** If any active exception touches the surfaces Phase B writes to (§3.1 ledger immutability, §2.4 status writer funnel, §6.10 cross-tenant), the exception must be either resolved or formally extended.

**Action:** Quick audit. Likely empty already (P0/P1 sealed most surfaces). 30-minute task: grep `synchronization-constitution.md §11` table, list any rows, verify each is in scope.

**Output artifact:** A line in §11 of the constitution: "Verified empty for Phase B scope on 2026-05-17 by <reviewer>" — or, if non-empty, an amendment.

### 4.4 PC14 — Pilot tenant ZB quota

**Why it matters:** Phase B's first command type (`job.create`) is the heaviest — each command produces 1 POST to ZB plus reads the GET for pre-flight on retry. Phase B dry-run reduces this to GET-only, but live mode is 1-2 ZB calls per command. The pilot tenant's existing ZB usage + Phase B's expected outbound volume MUST stay under ZB's per-tenant rate limit.

**Open question:** ZB's per-tenant rate limit is still unknown (Q9 in support package). Even ballpark headroom is unknown.

**Action:** Either obtain rate-limit answer from ZB support (Q9) OR conservatively estimate: pilot tenant's current ZB API usage (visible from existing payment-reconcile traffic) + projected Phase B volume (estimated by the tenant's job-creation frequency × 2). If aggregate is < 50% of any plausible rate limit (e.g., 60 req/min), proceed; otherwise wait for ZB support.

**Output artifact:** A row in `phase-b-pilot-tenant.md` recording the estimate vs. the ZB limit, and the operator-of-record's sign-off.

### 4.5 PC15 — Staging freeze rehearsal

**Why it matters:** The freeze switch is a critical control plane primitive. If the freeze procedure has a bug we haven't caught (race, missing migration, wrong env var), we find out during a real incident — at the worst possible moment.

**Rehearsal script:**
1. On staging, deliberately enqueue a bad command (e.g., via SQL INSERT directly into `zb_outbound_commands` with malformed `payload_json`).
2. Set `ZB_OUTBOUND_GLOBAL_FREEZE=true` via Railway env (will need a staging value of this if not already set).
3. Observe drainer logs: confirm `[ZB Outbound] drainer tick skipped — ZB_OUTBOUND_GLOBAL_FREEZE=true` appears.
4. Query `/api/zb-outbound/status` — confirm flags reflect freeze active.
5. DELETE the bad command from the queue manually (operator action).
6. Set `ZB_OUTBOUND_GLOBAL_FREEZE=false`.
7. Observe drainer resumes; confirm no residual side effects.

**Action:** Backend lead runs this on staging. ~30 minutes. Documents result in PC15.

**Output artifact:** A short log committed to `docs/operations/zb-outbound-freeze-rehearsal-<date>.md`.

---

## 5. Recommended Phase B sequence

### 5.1 Pre-flight (week 0)

Parallel tasks, none of which require Phase B code changes:

- [ ] **PC11** Pilot tenant identified (output: `phase-b-pilot-tenant.md`).
- [ ] **PC12** Operator runbook drafted (output: `zb-outbound-runbook.md`).
- [ ] **PC13** Constitution exceptions audit (output: §11 line).
- [ ] **PC14** Pilot tenant ZB quota check (output: row in pilot doc).
- [ ] **PC15** Staging freeze rehearsal (output: rehearsal log).
- [ ] **Optional but recommended:** Send ZB support questions (Q1, Q2-C details, Q5–Q9 from [zb-support-questions.md](./zb-support-questions.md)) — none gate Phase B but each answer is a free upgrade.

**Exit criterion:** All 5 operational gates green. Phase B implementation can begin.

### 5.2 Phase B implementation (week 1)

Per design §10 Phase B:

- [ ] **B1: Producer wire-up for `job.create` only.** Hook into the existing SF UI flow for "create job" (likely in `server.js` job-creation endpoint). Producer calls `buildCommandRow({ command_type: 'job.create', ... })` then INSERTs. Behind feature flag (e.g., `ZB_OUTBOUND_JOB_CREATE_ENABLED=false` defaults off; flip on per-tenant via `platform_settings`). Pilot tenant is opted-in via this flag.
- [ ] **B2: Drainer live mode** for `job.create` command type only. The processRow stub graduates to a real HTTP call (POST `/v1/jobs`). `ZB_OUTBOUND_DRY_RUN=true` short-circuits at the network boundary (builds payload + signs + logs, does NOT POST). Still keeps freeze gate.
- [ ] **B3: Correlation step in webhook handler.** When `job.created` event arrives, correlate against open commands. Use `body.webhook_id` for dedup. Transition matching command `sent → confirmed`.
- [ ] **B4: Metrics emission.** Wire up the §16 metric counters/gauges/histograms.
- [ ] **B5: Tests.** All 12 of [design §11 Phase B+ tests](./zb-outbound-command-confirmation.md) for command-type `job.create`.

**Soak phase (within week 1):**
- Day 1-3: `ZB_OUTBOUND_ENABLED=true, ZB_OUTBOUND_DRY_RUN=true, ZB_OUTBOUND_GLOBAL_FREEZE=false`. Pilot tenant's job-create flow produces commands; drainer claims, builds, signs, but doesn't POST. Watch for: command-build errors, correlation false-positives.
- Day 4-7: `ZB_OUTBOUND_DRY_RUN=false`. First real ZB POSTs. Watch for: 4xx body errors, latency spikes, fan-out (shouldn't happen but verify), DLQ growth.

**Exit criterion (week 1 → next phase):**
- Confirmation latency P95 < 5 minutes.
- DLQ size < 5 commands across all attempts.
- Zero conflicts.
- Zero `reconcile`-origin commands (constitution §2.5 invariant).
- Zero unexpected event fan-out.

### 5.3 Phase C onward (week 2+)

Per design §10. Each additional command type gets its own B1–B5 cycle.

---

## 6. Decision points

These are the inflection points where operator judgment is needed during Phase B:

1. **Dry-run-off go/no-go (Day 4).** After 3 days of dry-run, the operator decides whether to enable live mode. Criteria: 0 build errors, 0 correlation false-positives in the dry-run period.
2. **Pilot tenant scaling decision (Day 7).** After 1 week of live `job.create`, decide whether to add a second pilot tenant OR add a second command type for the same tenant.
3. **Phase C entry (Day 14).** All Phase B exit criteria green; reschedule/cancel/assign/customer.upsert command types unlock per the design.
4. **Constitution-hygiene PC10 (parallel track).** The 5 missing contract-test files are tracked separately; they don't block Phase B but should land before Phase E.

---

## 7. Risk surface (Phase B specifically)

| # | Risk | Likelihood | Severity | Mitigation |
|---|---|---|---|---|
| R1 | Producer wire-up bug emits malformed `payload_json` | Medium | Low (caught by drainer's pre-send validation) | Drainer logs + drops bad rows to DLQ; `validatePayload` enforces shape. |
| R2 | Pilot tenant exceeds ZB rate limit | Medium (because rate limit unknown) | Medium | PC14 conservative estimate; if hit, drainer's 429 handling kicks in (per §3.3 retry schedule). |
| R3 | Webhook correlation fails to match (false-AMBIGUOUS) | Low | Medium | Q2-A/Q2-B resolution gives EXACT correlation as the default; ambiguous-pending review path is in place for edge cases. |
| R4 | Operator can't unfreeze (env var not persisted across deploy) | Low | High | PC15 rehearsal verifies; fallback is `platform_settings` row instead of env var. |
| R5 | `job.create` body validation rejects a real customer-created job | Medium | Low | Validation is loose by design (only required fields enforced). 422 from ZB feedback loop catches edge cases. |
| R6 | Manager edits a job in ZB UI while SF outbound has the same command pending | Medium during hybrid period | Medium | Conflict path (§6.3) handles this; operator-visible. Conflict-rate is a key week-1 metric. |
| R7 | First DLQ row appears with no operator on call | Low | Medium | PC12 runbook + alert thresholds (design §16.4) cover this. |
| R8 | New ZB event type fires we don't subscribe to | Low | Low | Inbound handler's "Unhandled event" branch logs; no crash. |

---

## 8. Open questions deferred from Phase B

These do NOT gate Phase B but should resolve before Phase C/D/E expands the surface:

| # | Question | Phase that needs it |
|---|---|---|
| Q1 | ZB Idempotency-Key header — supported? | Phase D (would simplify retry semantics) |
| Q2-C | ZB webhook retry policy details (max attempts, backoff) | Phase B+ informational; affects `retry_count` interpretation |
| Q4 | `POST /v1/jobs` response synchronously returns the new id? | Phase B blocking-but-discoverable on first live POST |
| Q5 | `POST /v1/customers` synchronous response? | Phase B for `customer.upsert` command type (Phase C) |
| Q6 | Does ZB emit `customer.created` event? (subscription exists; firing not yet observed) | Phase B/C for create-customer correlation |
| Q7 | `POST /v1/jobs/{id}/cancel` accepts a reason body? | Phase C |
| Q9 | ZB rate limits | Phase B (PC14) |
| Q10 | `POST /v1/jobs` with deleted customer_id | Phase B edge case |
| Q11 | Provider soft-delete behavior | Phase B-C for assign-providers safety |

The support package in [zb-support-questions.md](./zb-support-questions.md) consolidates all these.

---

## 9. Recommended next coordinated action

Smallest action that closes the most blockers:

**Run the staging freeze rehearsal (PC15).** It exercises the freeze primitive, validates the operator runbook draft (PC12), confirms no exceptions block the surfaces (PC13), and is the cheapest signal that the Phase A scaffolding is operationally healthy. ~30 minutes.

Then: identify the pilot tenant (PC11) — likely the same tenant we've been working with throughout. Sign-off, quota check (PC14), and Phase B implementation can begin.

---

## 10. Conclusion

The design phase is complete. Five rounds (v0.1 → v0.5) systematically resolved every empirical question the architecture surfaced: Q1 (idempotency), Q2-A (fan-out), Q2-B (event id), Q3 (assign endpoint). Each round produced a falsifiable claim, tested it against ZB's real behavior, and either confirmed the design or amended it.

The remaining work is operational. There is no ambiguity about WHAT to build — only WHEN to start, with WHICH tenant, under WHICH runbook. Those are 5 decisions, all of which can close in a week of coordinated operations work without touching code.

Phase A scaffolding is healthy in production. Phase B is the next deliberate step.
