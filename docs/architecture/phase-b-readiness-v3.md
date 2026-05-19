# Phase B — Readiness Assessment v3

**Date:** 2026-05-19
**Status:** **Phase B PAUSED post-incident. Re-arm blocked by PC16 + PC17.** Production is `ZB_OUTBOUND_GLOBAL_FREEZE=true`.
**Supersedes:** [phase-b-readiness-v2.md](./phase-b-readiness-v2.md) (2026-05-17). v2's headline "All Phase B blockers closed" was correct *as a decision to attempt* but insufficient as a contract test. Today's first live POST surfaced a payload-shape regression v2's gates could not catch.

---

## 1. Headline change vs v2

> **v2 closed all blockers known on 2026-05-17. v3 acknowledges that a class of blocker — producer contract-shape correctness — was not gateable from pre-live evidence alone. v3 adds two pre-unfreeze gates (PC16, PC17) and recasts the rollout as: re-arm only after both close.**

The Phase B implementation is shipped. The pilot tenant is configured. The drainer runs frozen. The producer queues commands and skips correctly. What v3 adds is not new architecture — it is new *gates*.

---

## 2. Incident summary (the reason for v3)

| Field | Value |
|---|---|
| Date | 2026-05-19 |
| Live mode activated | `ZB_OUTBOUND_DRY_RUN=false` at 16:17:07 UTC (deploy `12b903ca`) |
| First live SF job | 142206 (pilot tenant `user_id=2`, customer 23468, team_member 2623, territory Tampa) |
| Producer outcome | Queued successfully — `eb778119-cb11-486c-a958-2673198ace29` |
| Drainer outcome | POST issued; ZB rejected with `400 INVALID_TIME_SLOT — timeslot.start is required` |
| Root cause | Producer emitted `timeslot.start_time`; ZB requires `timeslot.start` |
| Side effects | None — failed row terminal in `state='failed'`, no retry, no DLQ alarm, no ledger, no second POST |
| Rollback | `ZB_OUTBOUND_GLOBAL_FREEZE=true` upserted at 16:24:47 UTC; redeploy SUCCESS at 16:27:11 UTC; boot line confirmed `frozen=true` |
| Time-to-rollback | ~7 minutes from anomaly detection to frozen-state verified |

Reference: [producer-field-contract-audit.md](./producer-field-contract-audit.md) §0 trigger, and the diagnosis report retained in this conversation's incident record.

---

## 3. New gates (PC16, PC17)

Both are pre-unfreeze. Both are documentation-and-implementation gates: the design amendment is final; the code does not move until both close.

### PC16 — Producer P0/P1 hard gate (Amendment A)

**Requirement:** Producer MUST refuse enqueue (state=`skipped_precondition`, `defer_reason` in `{ledger_drift, zb_sync_dirty}`) when either of these unresolved conditions exists for the target entity.

**Concrete query semantics** (informing the eventual implementation; this doc does not modify code):

| Condition | Defer reason | Query (conceptual) |
|---|---|---|
| Unresolved ledger drift on this job | `ledger_drift` | `SELECT 1 FROM ledger_drift_detected WHERE user_id=? AND job_id=? AND resolved_at IS NULL LIMIT 1` |
| Unresolved ZB sync dirty on this job | `zb_sync_dirty` | `SELECT 1 FROM zb_sync_dirty WHERE user_id=? AND sf_job_id=? AND resolved_at IS NULL LIMIT 1` |
| Unresolved ZB sync dirty on this customer (when `command_type IN ('customer.upsert')`) | `zb_sync_dirty` | `SELECT 1 FROM zb_sync_dirty WHERE user_id=? AND zenbooker_id=? AND resolved_at IS NULL LIMIT 1` |

**Schema confirmation (2026-05-19 via Supabase Management API):**
- `ledger_drift_detected` exists. Columns include `id`, `user_id` (bigint), `job_id` (bigint, nullable), `resolved_at` (timestamptz, nullable). Resolution model: `resolved_at IS NULL` means unresolved.
- `zb_sync_dirty` exists. Columns include `id`, `user_id` (bigint), `sf_job_id` (bigint, nullable), `zenbooker_id` (text, nullable), `resolved_at` (timestamptz, nullable). Same resolution model.

Both tables are already P0/P1-system writeable; producer is a new *reader*. No schema change required.

**Gate semantics:**
- Position in producer gating order (extends design §4.3): inserted **between** the existing gate 3 (ZB linkage resolution) and gate 4 (build + insert), as gate 4. Old gate 4 becomes gate 5.
- Behavior on dirty/drift: insert a `state='skipped_precondition'` row (same pattern as `unmapped_team_members`), set `defer_reason` accordingly, set `last_error` to a short human-readable note pointing the operator at the drift/dirty row id. Do NOT throw, do NOT block the SF endpoint.
- Operator UI surface: `/api/zb-outbound/status` already returns `defer_reason` aggregates; new `ledger_drift` and `zb_sync_dirty` reasons become first-class signals.

**Rationale:** Constitution §P0 (ledger immutability) and §P1 (loud-failure) state that outbound writes must not occur while drift or dirty flags are outstanding. Bypassing these is a constitution violation. v2 implicitly trusted the producer wouldn't bypass; v3 makes it explicit at the gate.

**Status:** ✅ **RESOLVED 2026-05-19.** Closure evidence:
1. Producer code: `checkLedgerDrift` + `checkZbSyncDirty` helpers + new gate 5 (before build+insert). ✅ Commit `86e81cf`.
2. Unit tests: 8 helper tests + 5 end-to-end tests in `tests/zb-outbound-producer.test.js`. Verify (a) `state='skipped_precondition'` row inserted with correct `defer_reason`, (b) no outbound POST attempted, (c) absence of drift/dirty allows enqueue, (d) drift takes precedence on both-present, (e) skipped rows carry `field_group='create'`+`origin='user'` for `/status` aggregate visibility. ✅ Commit `86e81cf`. Full suite green (1785 passed / 76 suites).
3. Design doc [zb-outbound-command-confirmation.md §4.3](./zb-outbound-command-confirmation.md) gate ordering amended to insert gates 6 (drift) + 7 (dirty) between linkage/mapping and build+insert. ✅ Commit 3 (docs sweep).

### PC17 — Producer field contract audit (Amendment B)

**Requirement:** Every field the producer emits in the `job.create` body is classified for evidence quality. Inferred sub-keys are explicitly listed. Refuted sub-keys are removed. Documented field set narrowed where possible to minimize unverified surface.

**Status:** **RESOLVED for pre-unfreeze (R1+R2+R3+R6 done; R4 parallel; R5 post-unfreeze).**

Audit is delivered: [producer-field-contract-audit.md](./producer-field-contract-audit.md) — 9 top-level fields classified, 5 sub-keys flagged as inference, 1 refuted (`timeslot.start_time`), 6 open questions (Q12–Q17 audit-local → §13 Q14–Q19 canonical), 6 remediations (R1–R6).

Remediation status:
1. **R1** — `lib/zb-outbound-producer.js:210` changed from `start_time` to `start`. ✅ Commit `131428d` (2026-05-19).
2. **R2** — `tests/zb-outbound-producer.test.js` lines 83/88/94 corrected; 2 new tests added (regression guard for `start_time` absence + SF-style alias absence). ✅ Commit `131428d`.
3. **R3** — `notes` removed from `buildZbBody`. Replaced truncation test with omission guard. ✅ Commit `131428d`.
4. **R4** — ZB support ticket filed asking per-field confirmation. **OPEN** — operator action, parallel to unfreeze.
5. **R5** — After first 2xx, capture response body as Tier-A evidence and append to audit. **PENDING** — post-unfreeze.
6. **R6** — Audit's Q12–Q17 promoted into [zb-outbound-command-confirmation.md §13](./zb-outbound-command-confirmation.md) as Q14–Q19 (canonical sequence). ✅ Commit 3 (docs sweep).

**Pre-unfreeze gate status:** ✅ R1 ✅ R2 ✅ R3 ✅ R6 — all done. R4 is parallel (does not block); R5 is post-unfreeze.

---

## 4. Updated blocker matrix

| ID | Item | v2 status | v3 status |
|---|---|---|---|
| PC1 | Q1 Idempotency-Key | Soft stop | Soft stop (unchanged) |
| PC2a–c | Q2 webhook determinism | RESOLVED | RESOLVED (unchanged) |
| PC3–PC10 | Design / hygiene gates | All RESOLVED or soft-stop | All unchanged |
| PC11 | Pilot tenant identified | RESOLVED | RESOLVED |
| PC12 | Operator runbook | RESOLVED | RESOLVED — recommend appending an "Incident: timeslot.start" entry post-resolution for runbook §3.2 |
| PC13 | §11 exceptions empty | VERIFIED | VERIFIED |
| PC14 | Pilot quota cap | RESOLVED | RESOLVED |
| PC15 | Staging freeze rehearsal | PASS | PASS — and validated again live today (rollback verified in ~7 min) |
| **PC16** | **Producer P0/P1 hard gate (drift + dirty)** | (not in v2) | ✅ **RESOLVED 2026-05-19** — commit `86e81cf` |
| **PC17** | **Producer field contract audit** | (not in v2) | ✅ **RESOLVED for pre-unfreeze** — R1+R2+R3 in commit `131428d`, R6 in docs sweep; R4 parallel; R5 post-unfreeze |

**Blockers remaining: 0** (R4 ZB support ticket is parallel; R5 capture is post-unfreeze). Both pre-unfreeze gates closed.

---

## 5. What today proved (and what it didn't)

### 5.1 Proved
- Phase A scaffolding works end-to-end: queue, producer hook, advisory lock, FOR UPDATE SKIP LOCKED claim, drainer, retry/DLQ classification, freeze short-circuit, redeploy-driven env-var change, rollback time.
- The 7-minute total time from anomaly detection → frozen verified is consistent with the PC15 rehearsal estimate. No surprises in the operational layer.
- The `state='failed'` terminal classification for hard 4xx is correct — no auto-retry, no side effects beyond a single 400 response.
- Loki observability captures the drainer boot line, the producer's queued event, the drainer's send attempt, and the freeze-on event. The audit trail is complete enough for forensic replay.

### 5.2 Did not prove
- That any other field beyond `timeslot.start` is correct. All Tier-D evidence (documented field names) is still pending Tier-A confirmation. See [producer-field-contract-audit.md §1](./producer-field-contract-audit.md) summary.
- That `assignment_method`, `assigned_providers`, `services[].service_id`, `address.*` will not fail next time for analogous reasons.

### 5.3 Conclusion
The architecture is sound. The contract was not. v3's gates close the contract gap.

---

## 6. Re-arm sequence (revised from v2 §4.4)

This is the documented sequence. v3 is a planning artifact — none of these steps are executed by this document.

| Step | Owner | Pre-req | Verification |
|---|---|---|---|
| 1 | Backend lead | n/a | Land R1+R2+R3 in one commit on `main`. Tests pass (notably new R2 assertions). |
| 2 | Backend lead | step 1 | Land PC16 producer gate (drift + dirty check) in one commit on `main`. Tests pass (new unit tests for both defer reasons). |
| 3 | Backend lead | step 2 | Append "Incident 2026-05-19" to [zb-outbound-runbook.md §3.2](../operations/zb-outbound-runbook.md). |
| 4 | Backend lead | step 3 | Update [zb-outbound-command-confirmation.md §4.3](./zb-outbound-command-confirmation.md) gate order; promote Q12–Q17 into §13. |
| 5 | Operator | step 4 | Verify Railway prod deploy SUCCESS for the new code. Drainer boot line still shows `frozen=true`. No accidental unfreeze. |
| 6 | Operator | step 5 | **Explicit decision to re-arm.** Set `ZB_OUTBOUND_GLOBAL_FREEZE=false` via Railway API. Wait for redeploy. Verify boot line shows `dry_run=false frozen=false`. |
| 7 | Operator | step 6 | Create ONE new SF job in pilot tenant (different from 142206 — fresh `event_id` / `intent_hash`). |
| 8 | Operator | step 7 | Run the 14-item verification matrix from the prior plan. If green, proceed to soak per [phase-b-readiness-v2.md §4.3](./phase-b-readiness-v2.md) soak gates. If any anomaly: immediate freeze again. |

### 6.1 Do not retry the failed row
Command `eb778119...` stays `state='failed'`. Its `payload_json` was minted by old producer and contains `start_time`. Retrying it would hit the same 400. Even hand-patching the row would test SQL, not the producer. Leave it as the historical audit record.

### 6.2 SF job 142206 disposition
Up to the operator. Options: (a) keep it (it exists in SF without a ZB counterpart; operator may want to push it via a fresh outbound command after re-arm); (b) delete it from SF and recreate after re-arm (clean room). Either is consistent with the architecture. Recommendation: **(b)** — clean room — so the post-fix smoke is end-to-end fresh.

---

## 7. Risk surface delta vs v2

v2 §5 enumerated R1–R8. v3 adds:

| New risk | Source | Mitigation |
|---|---|---|
| **R9** — Producer field contract drift between docs and ZB's actual server | This incident | PC17 audit + Tier-A capture on next 2xx; ZB support ticket R4 |
| **R10** — `address.*` / `services[].*` / `timeslot.type` may fail analogously to `timeslot.start` | Inference | Same — PC17 + R4 + bounded discovery for Q12–Q16 if R4 doesn't yield answers in reasonable time |
| **R11** — Drift/dirty gate not enforced; outbound proceeds during P0/P1 incidents | Constitution-architectural gap | PC16 closure |
| **R12** — `notes` field silently accepted then later breaks | Inference | R3 — remove `notes` until verified |

v2 risks R1–R8 stand unchanged. R1 ("Producer payload bug") was anticipated by v2 as a soft risk; today it manifested. Mitigation (DLQ + runbook §3.2) worked exactly as designed — bug surfaced loudly, no silent failure, fast operator action.

---

## 8. What this doc does NOT change

- Phase B scope (still `job.create` only).
- Pilot tenant (still `user_id=2`).
- Producer feature flag (still `platform_settings.zb_outbound_job_create_enabled = {"user_ids":[2]}`).
- Batch size / quota (still `ZB_OUTBOUND_BATCH_SIZE=5`).
- The constitution. P0/P1 boundaries remain immutable.

---

## 9. Phase B re-arm greenlight criteria

All of these must be true:

- [x] R1 + R2 + R3 merged to `main` — commit `131428d` (2026-05-19). Pending prod redeploy verification.
- [x] PC16 gate merged to `main` — commit `86e81cf` (2026-05-19). Pending prod redeploy verification.
- [x] [producer-field-contract-audit.md](./producer-field-contract-audit.md) delivered for operator review.
- [x] Runbook §3.2 updated with incident summary (commit 3 docs sweep).
- [x] [zb-outbound-command-confirmation.md](./zb-outbound-command-confirmation.md) §4.3 gate order + §13 Q14–Q19 updated (commit 3 docs sweep).
- [ ] **Prod redeploy SUCCESS verified for commits `131428d` + `86e81cf` + docs sweep.** (Pending push + Railway redeploy.)
- [ ] **Operator explicitly authorizes unfreeze.**

Until both final boxes checked, `ZB_OUTBOUND_GLOBAL_FREEZE=true` remains.

---

## 10. Changelog

| Date | Version | Change |
|---|---|---|
| 2026-05-17 | v1 | First Phase B readiness statement. PC11–PC15 identified as remaining operational gates. |
| 2026-05-17 | v2 | All Phase B blockers closed. PC11–PC15 RESOLVED. Phase B implementation greenlight as a single operator decision. |
| 2026-05-19 | v3 (initial) | **Post-incident.** First live POST failed (`timeslot.start_time` → 400). Rolled back via global freeze. v2's "0 blockers" headline superseded. Two new pre-unfreeze gates added: PC16 (producer P0/P1 hard gate for ledger_drift + zb_sync_dirty per Amendment A) and PC17 (producer field contract audit per Amendment B, audit document [producer-field-contract-audit.md] delivered). Re-arm sequence revised (§6); risk surface extended (§7 R9–R12); greenlight criteria checklist added (§9). Architecture unchanged; gating tightened. |
| **2026-05-19** | **v3.1** | **Both pre-unfreeze gates CLOSED.** PC16 resolved via commit `86e81cf` (producer drift/dirty hard gate + 13 tests; full suite 1785 green). PC17 R1+R2+R3 resolved via commit `131428d` (`timeslot.start_time` → `timeslot.start`, false-green tests corrected, `notes` removed, regression guards added). PC17 R6 resolved via this commit (Q14–Q19 promoted in [zb-outbound-command-confirmation.md §13](./zb-outbound-command-confirmation.md)). R4 (ZB support ticket) is operator-parallel; R5 (Tier-A capture) is post-unfreeze. Greenlight checklist §9 reflects closed boxes. Awaiting prod redeploy verification + explicit operator unfreeze authorization. |
